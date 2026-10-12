// End-to-end local CAS fixture replay on a disposable test database only; no model calls.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "../packages/backend/src/config.ts";
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { upsertMaterial } from "../packages/backend/src/content/materials.ts";
import { stopBoss } from "../packages/backend/src/jobs/queue.ts";
import { publishArticle } from "../packages/backend/src/publication/publish.ts";
import { collectSource } from "../packages/backend/src/sources/collect.ts";

const { sources } = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8"));
const seed = sources.find((s: { id: string }) => s.id === "web-pmo-research").config;
const fixture = readFileSync(new URL("./fixtures/cas-pmo-article.html", import.meta.url), "utf8");
const directory = "/xwdt2019/kyjz2019/";
const article = directory + "202604/t20260401_8180092.html";
const other = directory + "202604/t20260401_8180093.html";
let capture = 0;
let oldArticle: string | null = null;
let detailHits = 0;
let bulkLinks: string[] | null = null;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (req.url === directory) {
    const links = bulkLinks ?? (oldArticle ? [oldArticle] : [article, article + `?utm_source=capture${capture}`, article + "#top", other,
      directory + "index_7.html", directory + "index_4.html", "/xwdt2019/"]);
    res.end(`<ul class="comment_list">${links.map(href => `<li><a href="${href}">中国现代天文学的摇篮</a><span>2026/04/01</span></li>`).join("\n")}</ul>`);
  } else {
    detailHits++;
    res.end(fixture);
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

async function source() {
  const id = `cas-identity-${tag()}`;
  // Change only the fixture origin: use exactly the seed article-path rule and date policy.
  const settings = { ...seed, url: base + directory, allowUrlPrefixes: [base + directory + "20"],
    allowUrlRegex: seed.allowUrlRegex.replace("^https://pmo\\.cas\\.cn", "^https://127\\.0\\.0\\.1:" + new URL(base).port) };
  await sql`INSERT INTO sources(id,name,kind,config,cursor) VALUES (${id},'Local PMO fixture','web_list',
    ${sql.json(settings)},${sql.json({ initializedAt: new Date().toISOString() })})`;
  return id;
}

test("CAS repeated captures and tracking/fragment aliases keep one publication per real URL, not per title", async () => {
  const id = await source();
  detailHits = 0;
  const first = await collectSource(id);
  assert.equal(first.status, "ok");
  assert.equal(first.created, 2, "two different real article URLs with identical titles must survive");
  assert.equal(detailHits, 2, "aliases must not buy duplicate detail requests");
  const rows = await sql`SELECT id,published_at FROM articles WHERE source_id=${id}`;
  for (const row of rows) {
    assert.equal(row.published_at.toISOString(), "2026-03-31T16:00:00.000Z");
    await publishArticle(row.id);
  }
  capture++;
  const again = await collectSource(id);
  assert.equal(again.status, "ok");
  assert.equal(again.created, 0);
  assert.equal(again.revised, 0);
  assert.equal(detailHits, 2, "known articles do not fetch details again");
  const [counts] = await sql`SELECT count(*)::int AS articles,
    (SELECT count(*)::int FROM publications WHERE source_id=${id}) AS publications
    FROM articles WHERE source_id=${id}`;
  assert.deepEqual({ ...counts }, { articles: 2, publications: 2 });
});

test("adding authoritative detail rules does not backfill dates on previously stored articles", async () => {
  const id = await source();
  oldArticle = article + `?case=${id}`;
  const { articleId } = await upsertMaterial({ sourceId: id, url: base + oldArticle, title: "中国现代天文学的摇篮", via: "fetch" });
  const run = await collectSource(id);
  assert.equal(run.status, "ok");
  const [old] = await sql`SELECT published_at FROM articles WHERE id=${articleId}`;
  assert.equal(old.published_at, null);
});

test("reliable article-row dates survive bounded detail enrichment for all new candidates", async () => {
 oldArticle=null;
 bulkLinks=Array.from({length:13},(_,i)=>directory+`202604/t20260401_${9000000+i}.html`);
 detailHits=0;
 const id=await source();
 const result=await collectSource(id);
 assert.equal(result.created,13);
 const rows=await sql`SELECT published_at FROM articles WHERE source_id=${id}`;
 assert.equal(rows.length,13);
 assert.equal(rows.filter(r=>r.published_at!==null).length,13,"detail budget must not erase trustworthy listing dates");
 assert.equal(detailHits,10);
 bulkLinks=null;
});
