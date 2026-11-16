// AI4S click-to-update integration (R3): the column reuses the site's new-content hook and the arxiv
// controlled-update pattern. These mount the REAL Ai4sNewContent with real effects against linkedom and
// a mocked fetch — not a browser. They cover the wiring the review asked for: a new scope identity
// prompts, a FAILED update keeps the list the reader was reading (and offers retry), a SUCCESS commits
// the fresh head and consumes the prompt, and switching filter mid-update aborts the apply so a late
// response commits nothing. Paint/keyboard/viewport are out of scope (see the browser verification).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import type { Ai4sFeedResponse } from "@aihot/contracts/site";

let vite: ViteDevServer;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let MemoryRouter: typeof import("react-router").MemoryRouter;
let Ai4sNewContent: typeof import("../app/routes/ai4s.tsx").Ai4sNewContent;
let container: Element;
let win: ReturnType<typeof parseHTML>["window"];
declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }

const realSetTimeout = globalThis.setTimeout;
const scheduled: Array<{ fn: () => void; delay: number; id: ReturnType<typeof setTimeout> }> = [];
function captureTimers() {
  scheduled.length = 0;
  (globalThis as Record<string, unknown>).setTimeout = ((fn: () => void, delay?: number) => {
    if (delay !== 120_000) return realSetTimeout(fn, delay);
    const id = realSetTimeout(() => {}, 2_147_483_647);
    id.unref();
    scheduled.push({ fn, delay, id });
    return id;
  }) as unknown as typeof setTimeout;
}
function releaseTimers() {
  (globalThis as Record<string, unknown>).setTimeout = realSetTimeout;
  for (const t of scheduled) clearTimeout(t.id);
  scheduled.length = 0;
}
const cadence = () => scheduled.filter((s) => s.delay === 120_000);

const realFetch = globalThis.fetch;
let responder: (url: string, init?: RequestInit) => Promise<Response>;
function okFeed(groups: string[], items: Ai4sFeedResponse["items"] = []): Response {
  const body: Ai4sFeedResponse = {
    tab: "all", domain: null, items, page: 1, pageCount: 1, total: groups.length, updatedAt: null,
    contentTag: `tag-${groups.join("-")}`,
    groups: groups.map((id) => ({ key: id, rep: id, members: 1, memberIds: [id] })),
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
function gate<T>() {
  let open!: (v: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

before(async () => {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>');
  win = parsed.window;
  for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "MouseEvent", "MutationObserver"]) {
    if ((globalThis as Record<string, unknown>)[key] === undefined) (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ MemoryRouter } = await import("react-router"));
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  ({ Ai4sNewContent } = await vite.ssrLoadModule("/app/routes/ai4s.tsx"));
  container = parsed.document.getElementById("root")!;
  (globalThis as Record<string, unknown>).fetch = ((url: string, init?: RequestInit) => responder(String(url), init)) as typeof fetch;
});
after(async () => {
  (globalThis as Record<string, unknown>).fetch = realFetch;
  releaseTimers();
  await vite?.close();
});

const baselineView = (): Ai4sFeedResponse => ({
  tab: "all", domain: null, items: [], page: 1, pageCount: 1, total: 1, updatedAt: null,
  contentTag: "tag-a1", groups: [{ key: "a1", rep: "a1", members: 1, memberIds: ["a1"] }],
});

async function mount(resetKey: string, onCommit: (p: Ai4sFeedResponse) => void) {
  const root = createRoot(container);
  const Probe = ({ rk }: { rk: string }) =>
    React.createElement(MemoryRouter, null,
      React.createElement(Ai4sNewContent, { view: baselineView(), tab: "all", domain: null, resetKey: rk, onCommit }));
  await React.act(async () => { root.render(React.createElement(Probe, { rk: resetKey })); });
  return {
    setKey: async (rk: string) => { await React.act(async () => { root.render(React.createElement(Probe, { rk })); }); },
    button: () => container.querySelector("button"),
    unmount: () => root.unmount(),
  };
}
const click = async (btn: Element) => {
  await React.act(async () => {
    btn.dispatchEvent(new (win as any).Event("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};
/** Fire the mounted cadence timer so the head check runs now (the test cannot wait two minutes). */
const runCheck = async () => { await React.act(async () => { cadence()[0]!.fn(); await Promise.resolve(); await Promise.resolve(); }); };

test("a new scope identity prompts; a FAILED update keeps the list and offers retry", async () => {
  captureTimers();
  const committed: Ai4sFeedResponse[] = [];
  responder = async () => okFeed(["a1", "a2"]); // a2 is an arrival the baseline lacks
  const h = await mount("all|all", (p) => committed.push(p));
  try {
    await runCheck();
    const btn = h.button();
    assert.ok(btn, "the new-content prompt appears");
    assert.match(btn!.textContent ?? "", /有新内容，点击更新/);
    responder = async () => new Response("down", { status: 503 });
    await click(btn!);
    assert.deepEqual(committed, [], "a failed update never replaces the list the reader was reading");
    const retry = h.button();
    assert.ok(retry, "the prompt stays up as the retry entry");
    assert.match(retry!.textContent ?? "", /更新失败，点击重试/);
  } finally { h.unmount(); releaseTimers(); }
});

test("a SUCCESSFUL update commits the fresh head and consumes the prompt", async () => {
  captureTimers();
  const committed: Ai4sFeedResponse[] = [];
  responder = async () => okFeed(["a1", "a2"]);
  const h = await mount("all|all", (p) => committed.push(p));
  try {
    await runCheck();
    const fresh = okFeed(["a1", "a2"], [{ id: "a2" } as Ai4sFeedResponse["items"][number]]);
    responder = async () => fresh;
    await click(h.button()!);
    assert.equal(committed.length, 1, "the fresh head becomes the list the reader sees");
    assert.equal(committed[0]!.groups.length, 2);
    assert.equal(h.button(), null, "only a success that replaced the list consumes the prompt");
  } finally { h.unmount(); releaseTimers(); }
});

test("switching filter mid-update aborts the apply: a late response commits nothing", async () => {
  captureTimers();
  const committed: Ai4sFeedResponse[] = [];
  responder = async () => okFeed(["a1", "a2"]);
  const h = await mount("all|all", (p) => committed.push(p));
  try {
    await runCheck();
    const held = gate<Response>();
    responder = () => held.promise;
    await click(h.button()!); // apply is now in flight, held open
    await h.setKey("all|astro"); // the reader switches domain: the old apply must lose authority
    await React.act(async () => { held.open(okFeed(["a1", "a2", "a3"])); await held.promise; await Promise.resolve(); });
    assert.deepEqual(committed, [], "a late apply response from the superseded filter commits nothing");
  } finally { h.unmount(); releaseTimers(); }
});