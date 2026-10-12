// Shared bounded, metadata-only transport for the two official arXiv endpoints.
export class ArxivHttpError extends Error {
  readonly status: number;
  /**
   * The origin's own failure document, already cut to the request's byte budget. This is a DECODE of
   * `bodyBytes` — useful for a message, never a claim of byte-exactness: a truncated multi-byte tail
   * or an invalid-UTF-8 document decodes to replacement characters. Anything that hashes or keeps the
   * document must use `bodyBytes`.
   */
  readonly bodyText: string;
  /**
   * The retained response BYTES themselves (a prefix of the origin's failure document, bounded by the
   * same budget). Empty when the response had no body. This is what the offline copy is written and
   * hashed from, so the kept file really is the received prefix.
   */
  readonly bodyBytes: Uint8Array;
  /** True when the body existed but the byte budget cut it; a truncated copy is never "complete". */
  readonly bodyTruncated: boolean;
  constructor(status: number, body: { text: string; truncated: boolean; bytes?: Uint8Array | null } = { text: "", truncated: false },
      label = 'arXiv') {
    super(`${label} returned HTTP ${status}`);
    this.status = status;
    this.bodyText = body.text;
    this.bodyBytes = body.bytes ?? new TextEncoder().encode(body.text);
    this.bodyTruncated = body.truncated;
  }
}

/**
 * Finds an `ArxivHttpError` — optionally of one specific status — inside an error that may have been
 * wrapped. A run can fail on more than one front at once, so a cleanup failure (the durable request
 * watermark, say) is reported ALONGSIDE the request error in an `AggregateError` rather than replacing
 * it. Callers that branch on the status — the shared HTTP429 hold is the one that matters — must
 * therefore look through the wrapper instead of testing `instanceof` on the outermost error, or a
 * perfectly ordinary 429 would be classified as "some database problem" and no hold would be written.
 */
export function findArxivHttpError(error: unknown, status?: number): ArxivHttpError | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): ArxivHttpError | undefined => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return undefined;
    seen.add(value);
    if (value instanceof ArxivHttpError && (status === undefined || value.status === status)) return value;
    const nested = (value as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = walk(item);
        if (found) return found;
      }
    }
    const found = walk((value as { cause?: unknown }).cause);
    return found;
  };
  return walk(error);
}

/** True when the error, however deeply wrapped, is an arXiv HTTP429. */
export function isArxivRateLimited(error: unknown): boolean {
  return findArxivHttpError(error, 429) !== undefined;
}

/**
 * Drops a trailing INCOMPLETE UTF-8 sequence from a byte prefix. The bytes themselves are never
 * altered (they are what gets kept and hashed); this only keeps a decoded TEXT copy from turning a
 * cut in the middle of a code point into a replacement character that was never in the response.
 */
export function withoutPartialTail(bytes: Uint8Array): Uint8Array {
  let back = 0;
  // Walk back over at most three continuation bytes to find the lead byte of the last sequence.
  while (back < 3 && bytes.length - 1 - back >= 0 && (bytes[bytes.length - 1 - back]! & 0xc0) === 0x80) back++;
  const index = bytes.length - 1 - back;
  if (index < 0) return new Uint8Array(0);
  const lead = bytes[index]!;
  const need = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
  return back + 1 >= need ? bytes : bytes.subarray(0, index);
}

/**
 * The readable form of a retained response-byte prefix. It is a DECODE, never a claim of
 * byte-exactness: invalid upstream UTF-8 still decodes to replacement characters. Anything that
 * stores or hashes the document uses the bytes.
 */
export function decodeBodyPrefix(bytes: Uint8Array, truncated: boolean): string {
  if (bytes.length === 0) return "";
  try { return new TextDecoder("utf-8", { fatal: false }).decode(truncated ? withoutPartialTail(bytes) : bytes); }
  catch { return ""; }
}

/**
 * A shared bounded failure-body collector. Both official endpoints read a non-2xx response's own
 * document through this: the SAME byte budget as a success, once, from the response in hand (never a
 * second request), with the raw bytes kept for storage/hashing and the status always preserved.
 */
export function boundedFailureBody(maxBytes: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  return {
    /**
     * Reads the response body into the budget. `onReader` is called with the live reader (and again
     * with `undefined` when it is done) so the caller's timeout can always cancel the read in flight.
     */
    async read(response: Response, onReader?: (r: ReadableStreamDefaultReader<Uint8Array> | undefined) => void): Promise<void> {
      const reader = response.body?.getReader() ?? undefined;
      onReader?.(reader);
      try {
        for (;;) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) break;
          const remaining = maxBytes - size;
          if (chunk.value.byteLength > remaining) {
            // Only bytes inside the budget are kept: the evidence is the response's own prefix, cut
            // where the budget ends — never zero-padded, never larger than maxBytes.
            if (remaining > 0) { chunks.push(chunk.value.slice(0, remaining)); size += remaining; }
            truncated = true;
            void reader?.cancel().catch(() => {});
            break;
          }
          chunks.push(chunk.value);
          size += chunk.value.byteLength;
        }
      } catch {
        // A body that cannot be read is INCOMPLETE evidence, not absence of evidence.
        truncated = true;
      } finally {
        onReader?.(undefined);
      }
    },
    /** Marks the copy incomplete (a timeout cut it short). */
    markIncomplete(): void { truncated = true; },
    bytes(): Uint8Array {
      if (size === 0) return new Uint8Array(0);
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return body;
    },
    isTruncated(): boolean { return truncated; },
    body(): { text: string; truncated: boolean; bytes: Uint8Array } {
      const bytes = this.bytes();
      return { text: decodeBodyPrefix(bytes, truncated), truncated, bytes };
    },
  };
}
export async function fetchArxivXml(url: string, options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.port ||
      !((target.hostname === 'rss.arxiv.org' && target.pathname === '/rss/astro-ph') ||
        (target.hostname === 'export.arxiv.org' && target.pathname === '/api/query'))) throw new Error('Unsupported official arXiv endpoint');
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  for (const [name, value] of Object.entries({ timeoutMs, maxBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Status identity, captured the moment the failure headers arrive. Once a non-2xx status is KNOWN
  // it can never be lost, whatever reading its body does afterwards: a 429 whose failure document
  // hangs or dies is still a 429, and the shared hold must be established from the status alone.
  let failureStatus: number | undefined;
  // The retained prefix of the failure body, assembled only from REAL bytes (never padded), so the
  // timeout path and the error path hand back the same honest evidence. The BYTES are the evidence
  // (they are what gets kept and hashed); the decoded text is only a readable copy of them.
  const failure = boundedFailureBody(maxBytes);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      // The status wins the race against its own body: a timeout while a failure document crawls
      // rejects with the HTTP status (evidence: whatever prefix arrived, marked incomplete), never
      // with a plain timeout that would let a 429 slip past the hold branch.
      if (failureStatus !== undefined) { failure.markIncomplete(); reject(new ArxivHttpError(failureStatus, failure.body())); }
      else reject(new Error(`arXiv request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await (options.fetch ?? fetch)(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      failureStatus = response.status;
      // The origin's own failure document is best-effort evidence, read under the SAME byte budget
      // as a success and never by re-requesting. The reader is the OUTER one — no shadowing — so the
      // timeout and the cleanup below can always cancel it. Every outcome of this read (done, over
      // budget, read failure) still ends in the status-carrying error: the body only travels with it.
      await failure.read(response, (live) => { reader = live; });
      throw new ArxivHttpError(response.status, failure.body());
    }
    if (!response.body) throw new Error('arXiv response body is empty');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error(`arXiv response exceeds maxBytes limit ${maxBytes}`);
      chunks.push(chunk.value);
    }
    if (size === 0) throw new Error('arXiv response body is empty');
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  })();
  // Timeout can win while a non-cooperative injected transport is still running.
  void request.catch(() => {});
  try { return await Promise.race([request, timeout]); }
  finally {
    if (timer) clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
  }
}
