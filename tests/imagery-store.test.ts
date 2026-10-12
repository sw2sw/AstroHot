import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const url = new URL(process.env.DATABASE_URL!);
// The shared per-file harness creates owned *_ci copies; standalone QA also uses *_test.
assert.match(url.pathname, /_(?:test|ci)$/);
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
const db = postgres(url.toString(), { max: 4, onnotice: () => {} });
const metadata = (sourceDate = "2026-01-01", mediaType: "image" | "video" | "iframe" = "image") => ({
  source: "nasa-apod" as const, sourceDate, sourceId: sourceDate,
  titleEn: "Nebula", explanationEn: "Public explanation", credit: "Exact credit",
  copyright: "Photographer", sourceUrl: "https://apod.nasa.gov/apod/ap260101.html",
  mediaType, imageUrl: "https://example.invalid/upstream.jpg", mediaUrl: null, altEn: "Nebula",
});
const hash = "a".repeat(64);

const store = () => import("../packages/backend/src/imagery/store.ts");
before(async () => {
  if (!(await admin`SELECT 1 FROM pg_database WHERE datname = ${url.pathname.slice(1)}`).length) {
    await admin`CREATE DATABASE ${admin(url.pathname.slice(1))}`;
  }
  // This suite owns this uniquely named database and exercises exactly the new migration.
  const migration = await readFile(new URL("../database/migrations/0057_imagery_archive.sql", import.meta.url), "utf8").catch(() => "");
  if (migration) { await db.unsafe(migration); await db`TRUNCATE imagery_archive`; }
});
after(async () => {
  const module = await store().catch(() => null);
  if (module) { const { closeDb } = await import("../packages/backend/src/db.ts"); await closeDb(); }
  await db.end();
  await admin.end();
});

test("metadata persists public fields and reads a privacy-safe DTO without upstream image hotlinks", async () => {
  const { saveImageryMetadata, getImagery } = await store();
  await saveImageryMetadata({ ...metadata(), birthday: "private", queryHistory: ["private"] } as ReturnType<typeof metadata>, hash);
  const item = await getImagery("nasa-apod", "2026-01-01");
  assert.deepEqual(item, {
    source: "nasa-apod", sourceDate: "2026-01-01", titleEn: "Nebula", titleZh: null,
    explanationEn: "Public explanation", explanationZh: null, credit: "Exact credit",
    copyright: "Photographer", sourceUrl: metadata().sourceUrl, mediaType: "image",
    imageUrl: null, mediaUrl: null, altEn: "Nebula", translationStatus: "pending", mediaStatus: "pending",
  });
  const rows = await db`SELECT * FROM imagery_archive WHERE source = 'nasa-apod' AND source_date = '2026-01-01'`;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.metadata, metadata());
  assert.equal(rows[0]!.content_hash, hash);
  assert.ok(rows[0]!.created_at instanceof Date);
  assert.ok(rows[0]!.updated_at instanceof Date);
  assert.equal(await getImagery("nasa-apod", "2026-01-02"), null);
});

test("media completion persists a safe local file key and cannot overwrite ready media", async () => {
  const { saveImageryMetadata, saveImageryMedia, getImagery } = await store();
  await saveImageryMetadata(metadata("2026-01-03"), hash);
  await saveImageryMedia("nasa-apod", "2026-01-03", { localPath: "apod-20260103.jpg", contentType: "image/jpeg" });
  const first = await getImagery("nasa-apod", "2026-01-03");
  assert.equal(first!.imageUrl, "/api/imagery/media/apod-20260103.jpg");
  assert.equal(first!.mediaStatus, "ready");
  await saveImageryMedia("nasa-apod", "2026-01-03", { localPath: "replacement.png", contentType: "image/png" });
  await saveImageryMetadata({ ...metadata("2026-01-03"), titleEn: "Changed upstream" }, "b".repeat(64));
  assert.deepEqual(await getImagery("nasa-apod", "2026-01-03"), first);
  const [row] = await db`SELECT * FROM imagery_archive WHERE source_date = '2026-01-03'`;
  assert.equal(row!.local_path, "apod-20260103.jpg");
  assert.equal(row!.content_type, "image/jpeg");
  assert.equal(row!.content_hash, hash);
});

test("media completion rejects unsafe paths, unsupported types, missing rows and non-image media", async () => {
  const { saveImageryMetadata, saveImageryMedia, getImagery } = await store();
  for (const localPath of ["/host/private.jpg", "../x.jpg", "a/b.jpg", "a\\b.jpg", "..", "%2f.jpg", "x".repeat(201)]) {
    await assert.rejects(saveImageryMedia("nasa-apod", "2026-01-04", { localPath, contentType: "image/jpeg" }));
  }
  await assert.rejects(saveImageryMedia("nasa-apod", "2026-01-04", { localPath: "x.jpg", contentType: "text/html" }));
  await assert.rejects(saveImageryMedia("nasa-apod", "2026-01-04", { localPath: "x.jpg", contentType: "image/jpeg" }), /not found|missing/i);
  await saveImageryMetadata({ ...metadata("2026-01-05", "video"), mediaUrl: "https://example.invalid/video" }, hash);
  await assert.rejects(saveImageryMedia("nasa-apod", "2026-01-05", { localPath: "x.jpg", contentType: "image/jpeg" }), /image|applicable/i);
  const item = await getImagery("nasa-apod", "2026-01-05");
  assert.equal(item!.mediaStatus, "not_applicable");
  assert.equal(item!.imageUrl, null);
  assert.equal(item!.mediaUrl, "https://example.invalid/video");
});
