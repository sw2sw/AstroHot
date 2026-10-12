import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("bundled dataset preserves exactly the 6 synthetic sample rows", () => {
  const text = readFileSync(new URL("../app/features/calendar/events.json", import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), "cf3faf8818d373283be17efb13f96b3fe6d88e8677f47d837086ba2ecdc20d4c");
  const rows = JSON.parse(text);
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((row: { id: string }) => row.id)).size, 6);
  for (const row of rows) {
    assert.match(row.id, /^SYNTH_/);
    assert.match(row.date, /^202610\d{2}$/);
    assert.deepEqual(Object.keys(row), ["id", "date", "title", "description"]);
  }
});

test("month grid keeps blank padding and handles leap years without local timezone arithmetic", async () => {
  const { monthDays } = await import(modelPath);
  const october = monthDays("202610");
  assert.deepEqual(october.slice(0, 5), [null, null, null, "20261001", "20261002"]);
  assert.equal(october.length, 35);
  assert.equal(october.filter(Boolean).length, 31);
  assert.equal(monthDays("202402").filter(Boolean).length, 29);
});

test("previous/next months cross years and today resets selection to Shanghai date", async () => {
  const { calendarState } = await import(modelPath);
  const state = { month: "202612", date: "20261231" };
  assert.deepEqual(calendarState(state, { type: "move", offset: 1 }), { month: "202701", date: "20270101" });
  assert.deepEqual(calendarState({ month: "202601", date: "20260131" }, { type: "move", offset: -1 }), { month: "202512", date: "20251201" });
  assert.deepEqual(calendarState(state, { type: "select", date: "20261202" }), { month: "202612", date: "20261202" });
  assert.deepEqual(calendarState(state, { type: "today", now: new Date("2026-10-05T16:01:00Z") }), { month: "202610", date: "20261006" });
});

test("native dialog lifecycle restores opener focus and backdrop only closes outside bounds", async () => {
  const { openCalendarDialog, closeCalendarBackdrop } = await import(new URL("../app/features/calendar/dialog.ts", import.meta.url).href);
  const calls: string[] = [];
  const dialog = { showModal: () => calls.push("show"), close: () => calls.push("close"), getBoundingClientRect: () => ({ left: 10, right: 110, top: 10, bottom: 110 }) };
  const cleanup = openCalendarDialog(dialog, { focus: () => calls.push("focus") });
  closeCalendarBackdrop(dialog, { target: dialog, clientX: 50, clientY: 50 });
  assert.deepEqual(calls, ["show"]);
  closeCalendarBackdrop(dialog, { target: {}, clientX: 0, clientY: 0 });
  assert.deepEqual(calls, ["show"]);
  closeCalendarBackdrop(dialog, { target: dialog, clientX: 0, clientY: 50 });
  assert.deepEqual(calls, ["show", "close"]);
  cleanup();
  assert.deepEqual(calls, ["show", "close", "close", "focus"]);
});

const modelPath = new URL("../app/features/calendar/model.ts", import.meta.url).href;

test("today uses Asia/Shanghai across the UTC day boundary", async () => {
  const { shanghaiDate } = await import(modelPath);
  assert.equal(shanghaiDate(new Date("2026-10-05T16:01:00Z")), "20261006");
  assert.equal(shanghaiDate(new Date("2026-12-31T16:00:00Z")), "20270101");
});
