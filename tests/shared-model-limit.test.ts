// Shared model limit: six physical database rows with a four-held normal admission cap.
// Real database behaviour: four concurrent permits, a bounded wait that sends nothing,
// release, and quarantine that is never freed automatically.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { stub, tag } from "./setup.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { acquireModelPermit, ModelLimitBusyError, modelFetch, quarantineModelPermit, releaseModelPermit } from "@aihot/backend/providers/model-limit";
import { ProviderRejectedError } from "@aihot/backend/providers/receipts";

const occupied = async () => {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM model_permits WHERE token IS NOT NULL`;
  return row!.n;
};
const reset = () => sql`UPDATE model_permits SET token = NULL, state = 'active', purpose = NULL, subject = NULL, acquired_at = NULL`;

after(async () => {
  await reset();
  await closeDb();
});

test("shared model quota has a dedicated append-only migration", () => {
  assert.ok(existsSync(new URL("../database/migrations/0055_shared_model_limit.sql", import.meta.url)), "global quota migration missing");
});

test("the fifth concurrent model call is refused after a bounded wait", async () => {
  await reset();
  const held: string[] = [];
  try {
    for (let i = 0; i < 4; i++) held.push(await acquireModelPermit("invariant_test", `slot-${tag()}`));
    assert.equal(await occupied(), 4);
    const started = Date.now();
    await assert.rejects(
      acquireModelPermit("invariant_test", `overflow-${tag()}`, { waitMs: 150 }),
      ModelLimitBusyError,
      "a full limiter must refuse instead of queueing forever",
    );
    const waited = Date.now() - started;
    assert.ok(waited >= 100, `gave up before its bounded wait (${waited}ms)`);
    assert.ok(waited < 5_000, `bounded wait ran away (${waited}ms)`);
    assert.equal(await occupied(), 4, "a refused call must not take a slot");
  } finally {
    await Promise.all(held.map((t) => releaseModelPermit(t)));
  }
});

test("releasing a slot lets the next caller in", async () => {
  await reset();
  const held: string[] = [];
  try {
    for (let i = 0; i < 4; i++) held.push(await acquireModelPermit("invariant_test", `slot-${tag()}`));
    const freed = held.pop()!;
    assert.equal(await releaseModelPermit(freed), true);
    const next = await acquireModelPermit("invariant_test", `next-${tag()}`, { waitMs: 200 });
    assert.ok(next);
    assert.equal(await occupied(), 4);
  } finally {
    await reset();
  }
});

test("a quarantined permit stays occupied and is never freed automatically", async () => {
  await reset();
  const quarantined = await acquireModelPermit("invariant_test", `quarantine-${tag()}`);
  try {
    assert.equal(await quarantineModelPermit(quarantined), true);
    const [row] = await sql<{ token: string | null; state: string }[]>`SELECT token, state FROM model_permits WHERE token = ${quarantined}`;
    assert.equal(row!.state, "quarantined");
    assert.ok(row!.token, "the token stays withheld, so no reaper can pick the slot up");
    // Only three normal slots remain usable; the quarantined one is not among them.
    for (let i = 0; i < 3; i++) await acquireModelPermit("invariant_test", `after-quarantine-${tag()}`);
    await assert.rejects(acquireModelPermit("invariant_test", `over-${tag()}`, { waitMs: 120 }), ModelLimitBusyError);
    assert.equal(await occupied(), 4, "the quarantined slot is still held");
  } finally {
    await reset();
  }
});

test("an aborted acquisition takes no permit and sends nothing", async () => {
  await reset();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    acquireModelPermit("invariant_test", `aborted-${tag()}`, { signal: controller.signal }),
    ProviderRejectedError,
  );
  assert.equal(await occupied(), 0, "an aborted caller must not consume a slot");

  // Aborting while waiting for a full limiter also takes nothing.
  const held: string[] = [];
  try {
    for (let i = 0; i < 4; i++) held.push(await acquireModelPermit("invariant_test", `slot-${tag()}`));
    const waiting = new AbortController();
    const pending = acquireModelPermit("invariant_test", `lost-${tag()}`, { waitMs: 10_000, signal: waiting.signal });
    setTimeout(() => waiting.abort(), 50);
    await assert.rejects(pending, ProviderRejectedError);
    assert.equal(await occupied(), 4);
  } finally {
    await Promise.all(held.map((t) => releaseModelPermit(t)));
  }
});

test("a malformed model request is refused before any slot is taken", async () => {
  await reset();
  await assert.rejects(modelFetch("not a url", { method: "POST", body: "{}" }, "invariant_test", `bad-url-${tag()}`), ProviderRejectedError);
  await assert.rejects(modelFetch("http://127.0.0.1:1/x", { method: "POST", body: "" }, "invariant_test", `bad-body-${tag()}`), ProviderRejectedError);
  assert.equal(await occupied(), 0);
});

test("modelFetch holds a slot for the call and frees it on a normal answer", async () => {
  await reset();
  const server = await stub(() => ({ ok: true }));
  try {
    const { res, text } = await modelFetch(
      `${server.url}/chat/completions`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }), signal: AbortSignal.timeout(5_000) },
      "invariant_test",
      `fetch-ok-${tag()}`,
    );
    assert.equal(res.status, 200);
    assert.match(text, /ok/);
    assert.equal(server.hits(), 1);
    assert.equal(await occupied(), 0, "a completed call releases its slot");
  } finally {
    await server.close();
    await reset();
  }
});

test("a timed-out modelFetch quarantines its slot instead of freeing it", async () => {
  await reset();
  const server = await stub(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); return { ok: true }; });
  try {
    await assert.rejects(
      modelFetch(
        `${server.url}/chat/completions`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}), signal: AbortSignal.timeout(80) },
        "invariant_test",
        `fetch-timeout-${tag()}`,
      ),
    );
    assert.equal(await occupied(), 1, "an unknown outcome keeps its slot occupied");
    const [row] = await sql<{ state: string }[]>`SELECT state FROM model_permits WHERE token IS NOT NULL`;
    assert.equal(row!.state, "quarantined", "a timed-out call is quarantined, not freed");
  } finally {
    await server.close();
    await reset();
  }
});

// Independent cross-process, poolmax1 and receipt boundary coverage lives in
// tests/shared-model-limit-independent.test.ts; the controller executes it separately.
