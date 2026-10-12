import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { archiveImage, readArchivedImage } from '../packages/backend/src/imagery/media.ts';

const url = 'https://assets.science.nasa.gov/image/example.png';
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'astrohot-imagery-'));
  const body = await sharp({create: {width: 2, height: 2, channels: 3, background: '#112233'}}).png().toBuffer();
  let hits = 0;
  const fetchImpl = async () => { hits++; return {status: 200, url, headers: new Headers({'content-type':'image/png'}), body, text: () => ''}; };
  return {directory, body, fetchImpl, hits: () => hits, close: () => rm(directory, {recursive:true,force:true})};
}

test('image bytes are archived and second lookup uses local file without fetch', async () => {
  const f = await fixture();
  try {
    const one = await archiveImage(url, {directory:f.directory, fetchImpl:f.fetchImpl});
    assert.match(one.localPath, /^[a-f0-9]{64}$/);
    assert.equal(one.contentType,'image/png');
    assert.deepEqual(await readFile(path.join(f.directory,one.localPath)),f.body);
    const two = await archiveImage(url,{directory:f.directory,fetchImpl:async()=>{throw Error('must not fetch');}});
    assert.deepEqual(two,one);
    assert.equal(f.hits(),1);
    assert.deepEqual((await readArchivedImage(one.localPath,{directory:f.directory})).body,f.body);
  } finally {await f.close();}
});

test('concurrent same-file misses are coalesced', async () => {
 const f=await fixture();try {const [a,b]=await Promise.all([archiveImage(url,{directory:f.directory,fetchImpl:f.fetchImpl}),archiveImage(url,{directory:f.directory,fetchImpl:f.fetchImpl})]);assert.deepEqual(a,b);assert.equal(f.hits(),1);}finally {await f.close();}
});

test('bad image bytes are never archived and later successful fetch can retry',async()=>{
 const f=await fixture();try {
  await assert.rejects(archiveImage(url,{directory:f.directory,fetchImpl:async()=>({...await f.fetchImpl(),body:Buffer.from('<script>bad</script>')})}));
  assert.deepEqual(await readdir(f.directory),[]);
  await archiveImage(url,{directory:f.directory,fetchImpl:f.fetchImpl});
 } finally {await f.close();}
});

test('HTTP errors leave no persistent image',async()=>{
 const f=await fixture();try {await assert.rejects(archiveImage(url,{directory:f.directory,fetchImpl:async()=>({...await f.fetchImpl(),status:429})}));assert.deepEqual(await readdir(f.directory),[]);}finally {await f.close();}
});

test('unexpected media hosts and credentials are refused before fetching',async()=>{
 const f=await fixture();try {for(const bad of ['http://assets.science.nasa.gov/a.png','https://127.0.0.1/a.png','https://evil.example/a.png','https://user:pass@assets.science.nasa.gov/a.png'])await assert.rejects(archiveImage(bad,{directory:f.directory,fetchImpl:f.fetchImpl}));assert.equal(f.hits(),0);}finally {await f.close();}
});

test('reading media refuses traversal and malformed keys',async()=>{
 const f=await fixture();try {for(const bad of ['../secret','.env','a'.repeat(63),'A'.repeat(64)])await assert.rejects(readArchivedImage(bad,{directory:f.directory}));}finally {await f.close();}
});
