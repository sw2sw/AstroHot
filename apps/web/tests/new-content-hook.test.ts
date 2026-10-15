// REAL React-effect acceptance for the new-content check loop (ROUND3 C4/WEB-01/WEB-04, ROUND4 D5).
//
// HONEST SCOPE: this runs the real hook with real effects, real timers and real abort/consume
// interleaving against a DOM implementation (linkedom) — NOT a browser. It covers the sequencing the
// main review asked for (a late answer from a superseded filter, a callback that ignores its signal,
// consume() during an in-flight check, overlapping checks, the failure backoff binding every entry
// path, and the periodic chain surviving a consume). It does NOT cover paint, keyboard, viewport, a
// real `visibilitychange` from the browser, or a real network stack.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let container: Element;
declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }

// The hook's own long timers are captured instead of being awaited: a test cannot wait two minutes,
// and firing the captured callback is exactly the "the periodic timer already fired" state that
// ROUND4 D5 is about. React's scheduler may reuse setTimeout for very short delays, so only the
// hook's cadence is inspected.
const realSetTimeout = globalThis.setTimeout;
const scheduled: Array<{ fn: () => void; delay: number; id: ReturnType<typeof setTimeout> }> = [];
function captureTimers() {
  scheduled.length = 0;
  (globalThis as Record<string, unknown>).setTimeout = ((fn: () => void, delay?: number) => {
    // Only intercept the hook cadence; React's short scheduling timers must stay real.
    if (delay !== 120_000) return realSetTimeout(fn, delay);
    const id = realSetTimeout(() => {}, 2_147_483_647);
    id.unref(); // a captured fake must never keep the test worker alive
    scheduled.push({ fn, delay, id });
    return id;
  }) as unknown as typeof setTimeout;
}
function releaseTimers() {
  (globalThis as Record<string, unknown>).setTimeout = realSetTimeout;
  for (const timer of scheduled) clearTimeout(timer.id);
  scheduled.length = 0;
}
/** The hook's own cadence occurrences captured since the last captureTimers(). */
const cadence = () => scheduled.filter((s) => s.delay === 120_000);

before(async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "MutationObserver"]) {
    if ((globalThis as Record<string, unknown>)[key] === undefined) (globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  container = document.getElementById("root")!;
});

/** A promise plus its resolver: holds one check open while the test changes something. */
function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

interface Harness { notice: () => import("../app/features/feed/new-content.ts").NewContentNotice; calls: () => number; setKey: (key: string) => Promise<void>; unmount: () => void }

/**
 * Mounts the real hook and keeps the latest returned notice + call count for assertions. The active
 * filter travels as an ORDINARY PROP (`filter`), never as React's reserved `key`: a `key` change
 * would re-mount the component and prove nothing about the same hook instance reacting to a new
 * filter (ROUND4, verification-evidence correction).
 */
async function mountHook(check: (signal: AbortSignal) => Promise<boolean>, resetKey = "A"): Promise<Harness> {
  const { useNewContentNotice } = await import("../app/features/feed/new-content.ts");
  const root = createRoot(container);
  let latest: import("../app/features/feed/new-content.ts").NewContentNotice | null = null;
  let calls = 0;
  const counted = (signal: AbortSignal) => { calls += 1; return check(signal); };
  const Probe = ({ filter }: { filter: string }) => {
    latest = useNewContentNotice(counted, filter);
    return null;
  };
  await React.act(async () => { root.render(React.createElement(Probe, { filter: resetKey })); });
  return {
    notice: () => latest!,
    calls: () => calls,
    setKey: async (key) => { await React.act(async () => { root.render(React.createElement(Probe, { filter: key })); }); },
    unmount: () => root.unmount(),
  };
}

test("a check that ignores its abort signal cannot resurrect the prompt after consume()", async () => {
  const held = gate<boolean>();
  // Deliberately non-cooperating: it never looks at the signal, which is the case the hook's own
  // generation guard has to survive.
  const h = await mountHook(() => held.promise);
  try {
    await React.act(async () => { h.notice().checkNow(); });
    assert.equal(h.calls(), 1);
    // The reader clicks "更新" while the check is still in flight.
    await React.act(async () => { h.notice().consume(); });
    assert.equal(h.notice().hasNew, false);
    // The abandoned answer lands now. It describes a list from before the click, so it decides
    // nothing — a late `true` must not put the banner back.
    await React.act(async () => { held.open(true); await held.promise; });
    assert.equal(h.notice().hasNew, false);
  } finally { h.unmount(); }
});

test("consume() REVOKES the in-flight check's authority, and a page-style callback writes nothing", async () => {
  const held = gate<string>();
  // The real pages' shape: parse, honour the signal, only then touch the shared baseline.
  let baseline: string | null = "original";
  const writes: string[] = [];
  const h = await mountHook(async (signal) => {
    const body = await held.promise;
    if (signal.aborted) return false; // the guard the pages have after every await
    baseline = body;
    writes.push(body);
    return true;
  });
  try {
    await React.act(async () => { h.notice().checkNow(); });
    assert.equal(h.calls(), 1);
    await React.act(async () => { h.notice().consume(); });
    // The reader's click aborts the in-flight signal, so the page callback's own guard trips.
    await React.act(async () => { held.open("stale-body"); await held.promise; });
    assert.equal(baseline, "original"); // the shared baseline of the replaced list was not touched
    assert.deepEqual(writes, []);
    assert.equal(h.notice().hasNew, false);
  } finally { h.unmount(); }
});

test("the periodic chain survives a consume during an in-flight check", async () => {
  const held = gate<boolean>();
  captureTimers();
  const h = await mountHook((signal) => {
    // The periodic entry path: the timer fires, the check runs, the reader clicks while it is open.
    assert.equal(signal.aborted, false);
    return held.promise;
  });
  try {
    assert.equal(cadence().length, 1); // the mount armed the first cycle
    // Fire the captured cycle: this is "the periodic timer already fired and the check is in flight".
    await React.act(async () => { cadence()[0]!.fn(); });
    assert.equal(h.calls(), 1);
    await React.act(async () => { h.notice().consume(); });
    await React.act(async () => { held.open(true); await held.promise; });
    // A visible, mounted tab must not be left with no chain at all: exactly ONE normal cycle follows.
    assert.equal(cadence().length, 2, "the cadence must be re-armed after a revoked periodic check");
    assert.equal(h.notice().hasNew, false);
    // And that re-armed cycle really is a live check that can still prompt.
    await React.act(async () => { cadence()[1]!.fn(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(h.calls(), 2);
    assert.equal(h.notice().hasNew, true);
  } finally { h.unmount(); releaseTimers(); }
});

test("a success that lands after the filter changed decides nothing", async () => {
  const held = gate<boolean>();
  const h = await mountHook(() => held.promise);
  try {
    await React.act(async () => { h.notice().checkNow(); });
    assert.equal(h.calls(), 1);
    // The reader switches filter: the answer in flight is about the old one. The component is NOT
    // re-mounted — only the ordinary prop changes.
    await h.setKey("B");
    assert.equal(h.notice().hasNew, false);
    await React.act(async () => { held.open(true); await held.promise; });
    assert.equal(h.notice().hasNew, false);
    // The old filter's answer decided nothing and the hook was NOT re-mounted (the instance kept its
    // identity through an ordinary prop change).
    assert.equal(h.calls(), 1);
  } finally { h.unmount(); }
});

test("a real success prompts, and consume() is what clears it", async () => {
  const h = await mountHook(async () => true);
  try {
    await React.act(async () => { h.notice().checkNow(); await Promise.resolve(); });
    assert.equal(h.notice().hasNew, true);
    await React.act(async () => { h.notice().consume(); });
    assert.equal(h.notice().hasNew, false);
  } finally { h.unmount(); }
});

test("a check in flight is never doubled by another manual check", async () => {
  const held = gate<boolean>();
  const h = await mountHook(() => held.promise);
  try {
    await React.act(async () => { h.notice().checkNow(); });
    await React.act(async () => { h.notice().checkNow(); h.notice().checkNow(); });
    assert.equal(h.calls(), 1); // the in-flight request is the only one
    await React.act(async () => { held.open(false); await held.promise; });
  } finally { h.unmount(); }
});

test("the failure backoff binds the manual entry too, not only the timer", async () => {
  const h = await mountHook(async () => { throw new Error("backend down"); });
  try {
    await React.act(async () => { h.notice().checkNow(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(h.calls(), 1);
    // The failure put the next-allowed moment in the future: an immediate retry must WAIT.
    await React.act(async () => { h.notice().checkNow(); await Promise.resolve(); });
    assert.equal(h.calls(), 1);
  } finally { h.unmount(); }
});

after(() => {
  // Nothing is left running: the hook's timers belong to components that were unmounted.
  releaseTimers();
  assert.ok(true);
});
