import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { fetchApod } from '../packages/backend/src/imagery/apod.ts';

// Pure SQL-boundary test: capture the real JSON payload and feed it back as a stored row.
// No database, network, migrations or model requests.
const state = { row: null as Record<string, unknown> | null };
(globalThis as typeof globalThis & { imageryRightsSqlState: typeof state }).imageryRightsSqlState = state;
const loader = `
export async function load(url, context, nextLoad) {
  if (url.endsWith('/packages/backend/src/db.ts')) return {format:'module',shortCircuit:true,source:
    'export async function sql(strings,...values) { const state = globalThis.imageryRightsSqlState; if (strings.join(\"\").includes(\"INSERT INTO imagery_archive\")) { state.row = { source:values[0],source_date:values[1],metadata:JSON.parse(values[2]),media_status:values[4],translation_status:\"pending\",title_zh:null,explanation_zh:null,local_path:null }; return []; } return state.row ? [state.row] : []; }'};
  return nextLoad(url,context);
}`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

test('store JSON retains raw rights provenance but public DTO exposes only exact text and structured links', async () => {
  const metadata = await fetchApod('2025-02-28', {fetchImpl: async () => new Response(JSON.stringify({
    date:'2025-02-28',title:'Fixture',explanation:'Fixture explanation',media_type:'image',
    permalink:'https://apod.nasa.gov/apod/ap250228.html',hdurl:null,
    credit:'<a href="https://author.example">Author</a>',copyright:'<b>© Author</b>',
  }))});
  assert.ok(metadata);
  const {saveImageryMetadata,getImagery} = await import('../packages/backend/src/imagery/store.ts');
  await saveImageryMetadata(metadata,'a'.repeat(64));
  const stored = state.row!.metadata as Record<string, unknown>;
  assert.equal(stored.rawCreditHtml, metadata.rawCreditHtml);
  assert.equal(stored.rawCopyrightHtml, metadata.rawCopyrightHtml);
  const item = await getImagery('nasa-apod','2025-02-28');
  assert.ok(item);
  assert.deepEqual(item.creditLinks, metadata.creditLinks);
  assert.deepEqual(item.copyrightLinks, metadata.copyrightLinks);
  assert.equal(item.credit, metadata.credit);
  assert.equal(item.copyright, metadata.copyright);
  assert.equal(item.sourceUrl, metadata.sourceUrl);
  assert.equal(item.imageUrl,null);
  assert.ok(!('rawCreditHtml' in item));
  assert.ok(!('rawCopyrightHtml' in item));
});


test('legacy metadata remains readable and public rights links are revalidated at the SQL boundary', async () => {
  const {saveImageryMetadata,getImagery} = await import('../packages/backend/src/imagery/store.ts');
  const metadata = state.row!.metadata as Record<string, unknown>;
  const {rawCreditHtml,rawCopyrightHtml,creditLinks,copyrightLinks,...legacy} = metadata;
  await saveImageryMetadata(legacy as unknown as Parameters<typeof saveImageryMetadata>[0], 'a'.repeat(64));
  const item = await getImagery('nasa-apod','2025-02-28');
  assert.ok(item);
  assert.ok(!('creditLinks' in item));
  assert.ok(!('copyrightLinks' in item));
  // Simulate corrupt/old JSON read back: unsafe URLs and private extras must not escape.
  (state.row!.metadata as Record<string, unknown>).creditLinks = [
    {label:'safe',url:'https://author.example/exact?x=1',private:'secret'},
    {label:'unsafe',url:'javascript:alert(1)'}, {label:'credentials',url:'https://u:p@author.example'},
    {label:'relative',url:'/rights'}, {label:' ',url:'https://author.example'},
  ];
  assert.deepEqual((await getImagery('nasa-apod','2025-02-28'))!.creditLinks,[{label:'safe',url:'https://author.example/exact?x=1'}]);
});
