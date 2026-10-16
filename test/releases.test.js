import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {readFile, writeFile} from 'node:fs/promises';
import {createReleases} from '../src/releases.js';
import {catalog} from '../src/catalog.js';
import {fixture, releaseFixture} from './helpers.js';
async function fakeGithub(t, release) {
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    requests.push({url:req.url,headers:req.headers});
    if(req.url.startsWith('/assets/')) {const name=decodeURIComponent(req.url.slice(8));res.end(await readFile(path.join(release.dir,name)));return;}
    const record={tag_name:'v1.2.0',assets:[release.manifest.file,'manifest.json','SHA256SUMS'].map(name=>({name,url:`https://api.github.com/assets/${encodeURIComponent(name)}`}))};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('?per_page=20')?[record]:record));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {requests,fetcher:(url,opts)=>{const u=new URL(url);assert.equal(u.hostname,'api.github.com');return fetch(`http://127.0.0.1:${server.address().port}${u.pathname}${u.search}`,opts);}};
}
test('fake GitHub latest/tag/list and private API asset downloads use auth and binary Accept',async t=>{
  const f=await fixture(t),release=await releaseFixture(path.join(f.root,'remote')),github=await fakeGithub(t,release);
  const r=createReleases({paths:f.paths,env:{LDA_GITHUB_TOKEN:'synthetic-token'},fetcher:github.fetcher,runner:()=>{throw Error('token fallback forbidden');}});
  assert.equal(await r.latest(catalog[0]),'1.2.0');assert.equal((await r.lookup(catalog[0],'1.2.0')).tag_name,'v1.2.0');assert.equal((await r.list(catalog[0])).length,1);
  const b=await r.bundle(catalog[0]);assert.equal(b.sha256,release.manifest.sha256);assert.ok(b.zip.startsWith(f.paths.cache));
  assert.ok(github.requests.some(r=>r.url.endsWith('/releases/latest')));assert.ok(github.requests.some(r=>r.url.endsWith('/releases/tags/v1.2.0')));assert.ok(github.requests.some(r=>r.url.endsWith('/releases?per_page=20')));
  assert.ok(github.requests.every(r=>r.headers.authorization==='Bearer synthetic-token'));assert.equal(github.requests.filter(r=>r.headers.accept==='application/octet-stream').length,3);
});
test('release lookups use one-hour cache and explicit fresh bypasses it',async t=>{
  const f=await fixture(t);let count=0,time=0;const r=createReleases({paths:f.paths,env:{GH_TOKEN:'fake'},now:()=>time,fetcher:async()=>{count++;return {ok:true,json:async()=>({tag_name:'v1.0.0'})};}});
  await r.latest(catalog[0]);await r.latest(catalog[0]);assert.equal(count,1);time=3600001;await r.latest(catalog[0]);assert.equal(count,2);await r.latest(catalog[0],{fresh:true});assert.equal(count,3);
});
test('token precedence chooses LDA, GH, GITHUB then gh auth token; public fallback works',async t=>{
  const f=await fixture(t);
  for(const [i,env,expected] of [[0,{LDA_GITHUB_TOKEN:'lda',GH_TOKEN:'gh',GITHUB_TOKEN:'github'},'lda'],[1,{GH_TOKEN:'gh',GITHUB_TOKEN:'github'},'gh'],[2,{GITHUB_TOKEN:'github'},'github'],[3,{},'cli'],[4,{},undefined]]) {
    const r=createReleases({paths:{...f.paths,cache:path.join(f.paths.cache,String(i))},env,runner:async(bin,args)=>{assert.equal(bin,'gh');assert.deepEqual(args,['auth','token']);if(i===4)throw Error('missing');return {stdout:'cli\n'};},fetcher:async(url,opts)=>{assert.equal(opts.headers.Authorization,expected&&`Bearer ${expected}`);return {ok:true,json:async()=>({tag_name:'v1.0.0'})};}});await r.latest(catalog[0]);
  }
});
test('offline directory releases select semver latest without network',async t=>{
  const f=await fixture(t),source=path.join(f.root,'source');await releaseFixture(source,'graph','1.2.0');await releaseFixture(source,'graph','1.10.0');
  const r=createReleases({paths:f.paths,env:{LDA_RELEASE_SOURCE:`dir:${source}`},fetcher:()=>{throw Error('network forbidden');},runner:()=>{throw Error('runner forbidden');}});
  assert.equal(await r.latest(catalog[0]),'1.10.0');assert.equal((await r.bundle(catalog[0],{version:'1.2.0'})).version,'1.2.0');assert.equal((await r.list(catalog[0])).length,2);
});
test('--from verifies neighbouring manifest/sums and stages only verified cache ZIP',async t=>{
  const f=await fixture(t),release=await releaseFixture(path.join(f.root,'source'));const r=createReleases({paths:f.paths,env:{},fetcher:()=>{throw Error('network forbidden');}});
  const b=await r.bundle(catalog[0],{from:release.zip});assert.ok(b.zip.startsWith(f.paths.cache));await writeFile(release.zip,'tampered');await assert.rejects(r.bundle(catalog[0],{from:release.zip}),/SHA-256 mismatch/);
});
test('release API errors give actionable message without leaking token',async t=>{
  const f=await fixture(t),r=createReleases({paths:f.paths,env:{GH_TOKEN:'secret-value'},fetcher:async()=>({ok:false,status:401})});await assert.rejects(r.latest(catalog[0]),e=>/GitHub token/.test(e.message)&&!e.message.includes('secret-value'));
});
