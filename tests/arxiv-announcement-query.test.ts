import test from 'node:test';
import assert from 'node:assert/strict';
import { loadArxivFeed } from '../packages/backend/src/publication/arxiv.ts';
import type { Db } from '../packages/backend/src/db.ts';
test('global source-backed announcement sorting is performed by backend before pagination',async()=>{
 let query='';const db=((strings:TemplateStringsArray)=>{query=strings.join('${value}');return Promise.resolve([{items:[],total:0,report:null,synced_at:null}]);}) as unknown as Db;
 await loadArxivFeed({page:2,pageSize:1,category:'astro-ph.CO'},db);
 assert.match(query,/arxiv_announcements/);assert.match(query,/announce_type\s*=\s*'new'/);
 assert.match(query,/announced_on/);assert.match(query,/ORDER BY display_day DESC/);
 const page=query.slice(query.indexOf('page_items AS'));
 assert.ok(page.indexOf('ORDER BY display_day DESC')<page.indexOf('LIMIT'));
 assert.match(query,/paper->>'verdict'\s*=\s*'SELECT'/);
 assert.doesNotMatch(query,/UPDATE/);
});
