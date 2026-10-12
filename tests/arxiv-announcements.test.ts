import test from 'node:test';
import assert from 'node:assert/strict';
async function parser() {
 const module = await import('../packages/backend/src/arxiv/announcements.ts').catch(() => null);
 assert.equal(typeof module?.parseArxivAnnouncements, 'function', 'official announcement parser must exist');
 return module!.parseArxivAnnouncements;
}
function rss(type='new', date='Tue, 06 Oct 2026 00:00:00 -0400', id='2610.03738v1') {
 return `<?xml version="1.0"?><rss xmlns:arxiv="http://arxiv.org/schemas/atom" version="2.0"><channel><title>astro-ph updates</title><pubDate>${date}</pubDate><item><guid isPermaLink="false">oai:arXiv.org:${id}</guid><link>https://arxiv.org/abs/${id.replace(/v\d+$/,'')}</link><category>astro-ph.HE</category><pubDate>${date}</pubDate><arxiv:announce_type>${type}</arxiv:announce_type></item></channel></rss>`;
}
test('official new RSS retains source announcement DATE without pretending to know first visibility instant',async()=>{
 const parse=await parser();const rows=parse(rss());
 assert.deepEqual(rows,[{arxiv_id:'2610.03738v1',base_id:'2610.03738',version:1,announce_type:'new',announced_on:'2026-10-06'}]);
 assert.equal(Object.hasOwn(rows[0]!, 'first_public_at'),false);
 assert.equal(parse(rss('new','Tue, 06 Oct 2026 00:00:00 +1400'))[0]!.announced_on,'2026-10-06');
});
test('cross/replacement announcements are retained with their true types, not called first release',async()=>{
 const parse=await parser();for(const type of ['cross','replace','replace-cross']) assert.equal(parse(rss(type))[0]!.announce_type,type);
});
test('valid empty channel differs from invalid XML/error responses',async()=>{
 const parse=await parser();assert.deepEqual(parse('<rss version="2.0"><channel><title>astro-ph</title></channel></rss>'),[]);
 for(const xml of ['','<rss>','<html>Unavailable</html>','<rss><channel><item/></channel></rss>',rss('unrecognized'),rss('new','Tue, 30 Feb 2026 00:00:00 -0400'),rss('new','garbage'),rss('new',undefined,'2610.03738v0'),rss('new',undefined,'2610.03738'),rss('new').replace('http://arxiv.org/schemas/atom','http://attacker.invalid'),'<rss><channel/></rss><rss><channel/></rss>','<!DOCTYPE rss [<!ENTITY x "data">]>'+rss()]) assert.throws(()=>parse(xml),xml.slice(0,80));
});
test('duplicate source entries dedupe but incompatible announcement evidence must fail',async()=>{
 const parse=await parser();const xml=rss();const item=xml.match(/<item>.*<\/item>/)![0];
 assert.equal(parse(xml.replace('</channel>',item+'</channel>')).length,1);
 assert.throws(()=>parse(xml.replace('</channel>',item.replaceAll('Tue, 06 Oct 2026','Wed, 07 Oct 2026')+'</channel>')));
});
