// A17: the Anthropic listing read through the collector itself — two official entries become ONE
// source identity, a repeated URL is not a second article, the date comes from the page, and the
// second round creates nothing new. Synthetic pages on a local server; no external request.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const T = tag();
config.allowPrivateNetworkFetch = true;

const SCIENCE = `<!doctype html><html><body><main>
  <article><a href="/research/claude-black-hole-physics"><h3>Claude and the Hawking–Page transition</h3></a>
    <p>A model-assisted calculation of the Hawking–Page phase transition in four dimensions.</p>
    <time>Nov 17, 2026</time></article>
  <article><a href="/research/claude-shaped-science"><h3>Claude-shaped science</h3></a>
    <p>How the models are used across scientific workflows.</p><time>Nov 4, 2026</time></article>
  <nav><a href="/research/team/alignment">Alignment</a></nav>
</main></body></html>`;

const SEARCH = `<!doctype html><html><body><ul>
  <details><summary>
    <p>Announcements</p><p>Oct 28, 2026</p>
    <p>AI for Science expands to foundations and institutions</p>
  </summary><div><p>Twenty scientific institutions join the program.</p>
    <a href="/news/ai-for-science-expands">View article</a></div></details>
  <details><summary>
    <p>Announcements</p><p>Nov 17, 2026</p>
    <p>Claude and the Hawking–Page transition</p>
  </summary><div><a href="/research/claude-black-hole-physics">View article</a></div></details>
</ul></body></html>`;

let scienceHits = 0;
let searchHits = 0;
const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/science") { scienceHits++; res.writeHead(200, { "content-type": "text/html" }).end(SCIENCE); return; }
  if (path === "/search") { searchHits++; res.writeHead(200, { "content-type": "text/html" }).end(SEARCH); return; }
  res.writeHead(404).end("not found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

const overHttps = (u: string) => u.replace(/^http:/, "https:");
async function mkSource() {
  const id = `anthropic-${T}`;
  const cfg = {
    url: `${base}/science`,
    supplementaryUrl: `${base}/search?topic=discovery`,
    adapter: "anthropic_science",
    parseMode: "html",
    allowUrlPrefixes: [`${base}/research/`, `${base}/news/`],
    allowUrlRegex: `^${overHttps(base)}/(research/(?!team/)[^/?#]+|news/[^/?#]+)`,
    publishedAtUtcOffset: "+00:00",
    sharedPrefilter: true,
    cardImageAllowed: false,
  };
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'Anthropic 采集测试','web_list',${sql.json(cfg as never)},'T1','editorial',null,'2100-01-01')`;
  return id;
}
const rowsOf = (id: string) =>
  sql`SELECT url,title,published_at,body_status,coverage FROM articles WHERE source_id=${id} ORDER BY url`;

test("A14/A17 the two official entries collect as one identity, a repeat round creates nothing", async () => {
  const id = await mkSource();
  const first = await collectSource(id);
  assert.equal(first.status, "ok");
  const rows = await rowsOf(id);
  const urls = rows.map((r) => r.url);
  assert.equal(new Set(urls).size, urls.length, "one article per canonical URL");
  assert.equal(urls.length, 3, "two cards and one search row; the repeated black-hole row is the same article");
  assert.ok(!urls.some((u) => u.includes("/research/team/")), "a team page is not collected");
  assert.equal(scienceHits, 1, "the main entry is read once per round");
  assert.equal(searchHits, 1, "the supplementary entry is read once per round");

  const blackHole = rows.find((r) => r.url.endsWith("/research/claude-black-hole-physics"))!;
  assert.equal(blackHole.title, "Claude and the Hawking–Page transition");
  assert.equal(blackHole.published_at.toISOString(), "2026-11-17T00:00:00.000Z", "the page's own date, not a sitemap lastmod");

  const second = await collectSource(id);
  assert.equal(second.status, "ok");
  assert.equal(second.created, 0, "a second round does not create the same articles again");
  assert.equal((await rowsOf(id)).length, 3);
  assert.equal(scienceHits, 2, "each round reads the main entry exactly once");
  assert.equal(searchHits, 2, "each round reads the supplementary entry exactly once");
});
