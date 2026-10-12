import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {fromHtml} from "../packages/backend/src/sources/web-list.ts";
import type {SourceRow} from "../packages/backend/src/sources/types.ts";
const {sources}: {sources:SourceRow[]}=JSON.parse(readFileSync(new URL("../industry/sources.json",import.meta.url),"utf8"));
const fixtures=[
 {id:"web-bao-research",html:'<ul><li><div class="box-s h16 fix"><a class="box-title" href="./202609/t20260918_8284947.html">中国天眼发现星系超大气泡</a><span class="box-date">[2026-09-18]</span></div></li></ul>',day:"2026-09-18"},
 {id:"web-pmo-research",html:'<ul class="comment_list"><li><a href="https://pmo.cas.cn/xwdt2019/kyjz2019/202609/t20260929_8288466.html">双星摄动下S型行星的新特征</a><span>2026/09/29</span></li></ul>',day:"2026-09-29"},
 {id:"web-shao-research",html:'<ul><li><span class="right">2026-09-24</span><a href="https://shao.cas.cn/2020Ver/xwdt/kyjz/202609/t20260924_8286709.html">月基甚长基线黑洞成像研究</a></li></ul>',day:"2026-09-24"}
];
for(const f of fixtures)test(f.id+": source listing date is captured from the article row",()=>{
 const source=sources.find(s=>s.id===f.id)!;
 const rows=fromHtml(f.html,source.config.url,source);
 assert.equal(rows.length,1);
 assert.ok(rows[0].publishedAt,"publication day must not become discovery time");
 const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(rows[0].publishedAt!);
 assert.equal(day,f.day);
 assert.equal(rows[0].publishedAt!.toISOString(),new Date(f.day+"T00:00:00+08:00").toISOString(),"explicit source offset applies consistently to date-only rows");
});
