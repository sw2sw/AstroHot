// Where a reader came from, so the list can put focus back on the card that opened an article. The
// marker is claimed once and then gone: a later, unrelated visit to the list must not steal focus.
// (The DOM half — focusing the card — is exercised in the browser run, logs/a12-playwright.md.)
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let mod: typeof import("../app/features/item/return-focus.ts");
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  mod = (await vite.ssrLoadModule("/app/features/item/return-focus.ts")) as typeof mod;
});
after(async () => { await vite?.close(); });

test("the origin is claimed exactly once", () => {
  assert.equal(mod.takeOrigin(), null, "nothing is pending before a card opens");
  mod.rememberOrigin("item-a");
  assert.equal(mod.takeOrigin(), "item-a");
  assert.equal(mod.takeOrigin(), null, "the second claim of a visit gets nothing");
});

test("the newest card opened wins", () => {
  mod.rememberOrigin("first");
  mod.rememberOrigin("second");
  assert.equal(mod.takeOrigin(), "second");
});

test("focusCard focuses the card's own link, not the card box", () => {
  // A minimal stand-in for the DOM the list renders: one card holding one anchor.
  const anchor = { focused: false, focus() { this.focused = true; }, scrollIntoView() {} };
  const card = { querySelector: (sel: string) => (sel.includes("a[href]") ? anchor : null) };
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    activeElement: null as unknown,
    querySelector: (sel: string) => (sel.includes('[data-item-id="item-a"]') ? card : null),
  };
  try {
    assert.equal(mod.focusCard("item-a"), true);
    assert.equal(anchor.focused, true, "the link is the focus target, so the card is reachable again");
    assert.equal(mod.focusCard("missing"), false, "a card that is not there is reported, not guessed at");
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
});
