// One serialized request channel for both official arXiv endpoints. arXiv rate-limits by client, so
// RSS and metadata requests must never overlap and consecutive requests must stay at least
// minIntervalMs apart — measured from the end of the previous request, which is the spacing the
// collection job already used between metadata pages and now also applies to RSS → first metadata.
// Response status/headers are captured here so failures can be stored as durable evidence.
//
// Each run carries the cancellation of the lease it belongs to. It is checked once more at the
// dispatch boundary and merged into the transport's own signal, so a run whose channel was taken over
// neither opens a new connection nor leaves an old one running — the spacing waits below are exactly
// where an owner can be lost without noticing. Cancellation is not enough on its own, though: it only
// says the run was TOLD it lost the channel. The optional guard asks the durable state itself, at the
// same boundary, so a takeover the heartbeat has not seen yet still cannot dispatch.
//
// A run can also fail on two fronts at once: the request, and the durable request watermark written
// after it. The watermark failure never replaces the request error — both are kept — because callers
// branch on the request's status to establish the shared 429 hold.

export interface ArxivResponseMeta {
  status: number;
  headers: Record<string, string>;
  durationMs: number;
}

// Enough to explain a failure offline. Credentials, cookies and authorization headers are never
// allow-listed, so they cannot reach the exception table or a log line.
const RECORDED_HEADERS = [
  "content-type",
  "content-length",
  "date",
  "server",
  "retry-after",
  "last-modified",
  "via",
  "x-cache",
];

const MAX_RECORDED_HEADER_LENGTH = 200;

export function recordedHeaders(headers: Headers): Record<string, string> {
  const recorded: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value !== "") recorded[name] = value.slice(0, MAX_RECORDED_HEADER_LENGTH);
  }
  return recorded;
}

// Retry-After is either delta-seconds or an HTTP-date. Anything else — absent, non-numeric,
// negative, or already in the past — returns undefined so the caller keeps its own durable floor.
export function retryAfterSeconds(value: string | null | undefined, now: Date): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  const seconds = Math.ceil((at - now.getTime()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

export interface ArxivChannel {
  // Runs one request after every previously queued request has settled and the spacing has elapsed.
  // The signal is the run's own cancellation: a request is refused once it has aborted, and one that
  // is already in flight is cancelled through it.
  run<T>(signal: AbortSignal, task: (fetchImpl: typeof fetch) => Promise<T>): Promise<T>;
  // Metadata of the most recent transport response, including a rate-limited one.
  lastResponse(): ArxivResponseMeta | undefined;
}

/**
 * A spacing gate that outlives this process. The in-process queue below only knows about the
 * requests this instance made, so a fresh process — or the recovery entry starting right after a
 * collection run — would otherwise start with no memory of the previous official request. When one is
 * given, the channel waits for the durable gap once, before its first request, and reports the moment
 * of every request back to it; the requests inside the run are already spaced by the queue.
 */
export interface ArxivChannelThrottle {
  before(): Promise<void>;
  after(at: Date): Promise<void>;
}

export function createArxivChannel(options: {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  minIntervalMs?: number;
  throttle?: ArxivChannelThrottle;
  // Re-validates whatever entitles this run to use the connection — the collection lease, in practice —
  // and is awaited at the dispatch boundary, after every wait and with nothing left between it and the
  // network call. A run's own cancellation signal covers "we were TOLD we lost the channel"; this
  // covers "we must show we still hold it before opening a connection", which is the only thing that
  // closes the window between a takeover happening and the heartbeat noticing it.
  guard?: (signal: AbortSignal) => Promise<void>;
} = {}): ArxivChannel {
  const transport = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const minIntervalMs = options.minIntervalMs ?? 3000;
  const throttle = options.throttle;
  const guard = options.guard;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0) {
    throw new Error("minIntervalMs must be a nonnegative integer");
  }

  let tail: Promise<unknown> = Promise.resolve();
  let lastFinishedMs: number | null = null;
  let throttled = false;
  let last: ArxivResponseMeta | undefined;

  return {
    lastResponse: () => last,
    run<T>(signal: AbortSignal, task: (fetchImpl: typeof fetch) => Promise<T>): Promise<T> {
      const queued = tail.then(async () => {
        // A run that lost the channel while it was waiting must not reach the network. Both waits below
        // can be long — the durable gap is a database round trip and the request can sit behind a slow
        // answer — and the lease can be gone by the time either of them is over.
        signal.throwIfAborted();
        if (lastFinishedMs !== null) {
          const wait = minIntervalMs - (now().getTime() - lastFinishedMs);
          if (wait > 0) await sleep(wait);
        }
        // The durable gap is measured from the previous request of ANY process, so it is consulted
        // once per run, before its first request; the requests inside the run are already spaced by
        // the in-process wait above.
        if (throttle && !throttled) {
          throttled = true;
          await throttle.before();
        }
        // The dispatch boundary. Everything above was waiting, so the signal is checked once more —
        // and then the guard shows that the connection is still ours — with nothing left between this
        // and the request itself. A signal that was never aborted proves nothing about the row it
        // belongs to: the heartbeat only reacts to a renewal it has already seen fail, so a run that
        // was taken over while it waited would otherwise dispatch on a channel it no longer holds.
        signal.throwIfAborted();
        if (guard) await guard(signal);
        signal.throwIfAborted();
        const recording: typeof fetch = async (input, init) => {
          const startedMs = now().getTime();
          // The run's cancellation is merged with whatever the caller's transport set up for itself —
          // its own timeout, say — so either one cancels the request the moment it fires.
          const merged = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
          const response = await transport(input, { ...init, signal: merged });
          last = {
            status: response.status,
            headers: recordedHeaders(response.headers),
            durationMs: Math.max(0, now().getTime() - startedMs),
          };
          return response;
        };
        let requestError: unknown;
        let requestFailed = false;
        try {
          return await task(recording);
        } catch (error) {
          requestFailed = true;
          requestError = error;
          throw error;
        } finally {
          lastFinishedMs = now().getTime();
          // Recorded even when the request failed: a rate-limited or timed-out attempt still counts
          // as an official request and must space the next one.
          if (throttle) {
            try {
              await throttle.after(new Date(lastFinishedMs));
            } catch (watermarkError) {
              // Two independent failures must stay two facts. Letting this throw on its own — which is
              // what a bare `await` inside a `finally` does — replaces the request error with the
              // watermark error, and every caller that branches on the request's status would then miss
              // a 429: the shared hold would silently never be established while the log said "database
              // error". Both are reported, and `findArxivHttpError` can still see through the wrapper.
              throw requestFailed
                ? new AggregateError(
                    [requestError, watermarkError],
                    "the arXiv request failed and its durable request watermark could not be recorded",
                  )
                : watermarkError;
            }
          }
        }
      });
      // The next request must wait for this one even when it fails.
      tail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
  };
}
