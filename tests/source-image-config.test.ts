import test from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedConfig } from '../packages/backend/src/sources/config-keys.ts';
import { readFileSync } from 'node:fs';
test('ESA Webb image permission is scoped, requires complete credit and does not grant full text',()=>{
 const sources=JSON.parse(readFileSync(new URL('../industry/sources.json',import.meta.url),'utf8')).sources;
 const source=sources.find((s:any)=>s.id==='rss-esa-webb');
 assert.ok(source); assert.equal(source.config.cardImageAllowed,true); assert.equal(source.config.cardImageRequiresCredit,true);
 assert.equal(source.site_fulltext,false); assert.equal(source.syndicate_fulltext,false);
 assert.equal(source.config._aihot.initialBackfillLimit,5);
 assert.deepEqual(unsupportedConfig('rss',source.config),[]);
});
test('ESA Space Science image permission requires per-image credit without granting full text',()=>{
 const sources=JSON.parse(readFileSync(new URL('../industry/sources.json',import.meta.url),'utf8')).sources;
 const source=sources.find((s:any)=>s.id==='rss-esa-science');
 assert.equal(source.config.cardImageAllowed,true); assert.equal(source.config.cardImageRequiresCredit,true);
 assert.equal(source.site_fulltext,false); assert.equal(source.syndicate_fulltext,false);
 assert.equal(source.config._aihot.initialBackfillLimit,5);
 assert.deepEqual(unsupportedConfig('rss',source.config),[]);
});
test('Hubble thumbnail permission booleans do not disable RSS collection or relax unknown-key guards',()=>{
 assert.deepEqual(unsupportedConfig('rss',{feedUrl:'https://esahubble.org/news/feed/',cardImageAllowed:true,cardImageRequiresCredit:true}),[]);
 assert.deepEqual(unsupportedConfig('rss',{cardImageAllowed:false,cardImageRequiresCredit:false}),[]);
 for(const value of ['true',null,1,{},[]]) assert.deepEqual(unsupportedConfig('rss',{cardImageAllowed:value}),['cardImageAllowed']);
 assert.deepEqual(unsupportedConfig('rss',{unknownImagePermission:true}),['unknownImagePermission']);
 assert.deepEqual(unsupportedConfig('external',{cardImageAllowed:true}),['cardImageAllowed']);
});
