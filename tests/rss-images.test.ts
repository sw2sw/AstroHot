import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";

// Reduced ESA feed shape: candidate image lives in description, not content or enclosure.
const rss = (description: string, extra = "") => `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Space news</title><item>
  <title>Solar wind update</title><link>https://publisher.example/news/update</link>
  <description><![CDATA[${description}]]></description>${extra}
</item></channel></rss>`;
let feed = rss('<img src="/media/solar.png"><p>Solar wind research.</p>');
let requests = 0;
const server = http.createServer((_req, res) => {
  requests++;
  res.setHeader("content-type", "application/rss+xml");
  res.end(feed);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previous = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previous;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("RSS description-only image becomes a candidate without promoting summary to body", async () => {
  const [item] = (await fetchRss({ config: { feedUrl: root }, participation_mode: "editorial" } as never)).candidates;
  assert.deepEqual(item!.media, [{ kind: "image", url: "https://publisher.example/media/solar.png" }]);
  assert.equal(item!.bodyHtml, null);
  assert.equal(item!.bodyText, null);
  assert.equal(item!.bodyStatus, "pending");
  assert.equal(item!.excerpt, "Solar wind research.");
});

async function read(summaryIsBody = false) {
  return (await fetchRss({ config: { feedUrl: root, summaryIsBody }, participation_mode: "editorial" } as never)).candidates[0]!;
}

test("RSS enclosure and content images retain priority over summary candidates", async () => {
  feed = rss('<img src="/summary.jpg"><p>Summary.</p>',
    '<enclosure type="image/jpeg" url="https://publisher.example/enclosure.jpg"/>' +
    `<content:encoded><![CDATA[<img src="/body.jpg"><p>${"Body research. ".repeat(30)}</p>]]></content:encoded>`);
  const item = await read();
  assert.deepEqual(item.media!.map(m => m.url), [
    "https://publisher.example/enclosure.jpg", "https://publisher.example/body.jpg", "https://publisher.example/summary.jpg",
  ]);
  assert.equal(item.bodyText, "Body research. ".repeat(30).trim());
});

test("summaryIsBody keeps its text semantics and does not duplicate description images", async () => {
  feed = rss(`<img src="/solar.jpg"><p>${"Summary body. ".repeat(30)}</p>`);
  const item = await read(true);
  assert.deepEqual(item.media, [{ kind: "image", url: "https://publisher.example/solar.jpg" }]);
  assert.equal(item.bodyText, "Summary body. ".repeat(30).trim());
  assert.ok(item.bodyHtml!.includes("Summary body."));
});

test("image-free description remains image-free and stays a pending body", async () => {
  feed = rss("<p>Text only.</p>");
  const item = await read();
  assert.deepEqual(item.media, []);
  assert.equal(item.bodyText, null);
  assert.equal(item.bodyHtml, null);
  assert.equal(item.bodyStatus, "pending");
});

test("description candidates are capped at six and are not fetched or auto-approved", async () => {
  feed = rss(Array.from({ length: 9 }, (_, i) => `<img src="/image-${i}.jpg">`).join(""));
  const before = requests;
  const item = await read();
  assert.equal(item.media!.length, 6);
  assert.equal(item.media![5]!.url, "https://publisher.example/image-5.jpg");
  assert.equal(requests - before, 1);
  assert.ok(item.media!.every(m => Object.keys(m).sort().join(",") === "kind,url"));
});
