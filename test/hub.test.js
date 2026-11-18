import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startHub} from '../src/hub.js';
import {catalog, moduleFor} from '../src/catalog.js';
import {fixture,fakeEngine,installed} from './helpers.js';
async function hubFixture(t){const f=await fixture(t),fake=fakeEngine(f,{states:{find:installed(moduleFor('find'))}});const hub=await startHub({engine:fake.engine,port:0,doctor:async()=>[{name:'Node',ok:true,message:'fake',fix:'none'}]});t.after(()=>hub.close());return{...hub,...fake};}
test('hub binds loopback on port 0 and server-renders banner, cards, legal links and controls',async t=>{
  const hub=await hubFixture(t),response=await fetch(hub.url),html=await response.text();assert.equal(hub.server.address().address,'127.0.0.1');
  for(const text of ['Development and research use only','Not affiliated with or endorsed by Optimizely.','LDA Local Graph','LDA Local Assets','LDA Local Find','Compatible with Optimizely','Made for CMS 13 sites. Not tested with CMS 12.','Made for CMS 12 sites that use Search &amp; Navigation.','Check for updates now','Run doctor','No telemetry','/privacy','/licence','/legal','Logs'])assert.ok(html.includes(text),text);
  const findCard = html.match(/<article class="module" id="find">.*?<\/article>/s)[0];
  assert.match(findCard, /data-state>running/);
  assert.match(findCard, /data-health>ok 12ms/);
  assert.doesNotMatch(findCard, /Open dashboard|data-dashboard|localhost:8088/);
  assert.match(html, /data-dashboard href="http:\/\/localhost:8082\//);
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('hub status and health return Find alongside dashboard-capable modules', async t => {
  const hub = await hubFixture(t);
  for (const route of ['api/status', 'api/health']) {
    const rows = await (await fetch(hub.url + route)).json();
    assert.deepEqual(rows.map(row => row.module), ['graph', 'assets', 'find']);
    assert.equal(rows[1].state, 'not installed');
    assert.match(rows[0].dashboard, /localhost:8082/);
    const find = rows[2];
    assert.equal(find.port, 8088);
    assert.equal(find.state, 'running');
    assert.equal(find.health.product, 'find');
    assert.equal(find.health.ok, true);
    assert.equal(Object.hasOwn(find, 'dashboard'), false);
  }
});
test('hub POST rejects missing CSRF and missing/wrong Origin before engine action',async t=>{
  const hub=await hubFixture(t),html=await(await fetch(hub.url)).text(),token=html.match(/const csrf="([a-f\d]+)"/)[1];
  for(const headers of [ {'Content-Type':'application/json',Origin:hub.url.slice(0,-1)}, {'Content-Type':'application/json','X-LDA-CSRF':token,Origin:'https://evil.example'}, {'Content-Type':'application/json','X-LDA-CSRF':token} ]) {const r=await fetch(hub.url+'api/start',{method:'POST',headers,body:JSON.stringify({module:'graph'})});assert.equal(r.status,403);}
  assert.equal(hub.calls.length,0);
});
test('hub rejects rebinding Host even for reads',async t=>{const hub=await hubFixture(t);const status=await new Promise((resolve,reject)=>{const req=http.get(hub.url+'api/status',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(status,403);});
test('valid local CSRF POST calls same engine once; doctor uses injected checks',async t=>{
  const hub=await hubFixture(t),html=await(await fetch(hub.url)).text(),token=html.match(/const csrf="([a-f\d]+)"/)[1],headers={'Content-Type':'application/json','X-LDA-CSRF':token,Origin:hub.url.slice(0,-1)};
  const r=await fetch(hub.url+'api/install',{method:'POST',headers,body:JSON.stringify({module:'graph'})});assert.equal(r.status,200);assert.equal((await r.json()).ok,true);assert.equal(hub.calls.length,1);assert.equal(hub.calls[0].plan.operations[0].op,'install');
  const d=await(await fetch(hub.url+'api/doctor',{method:'POST',headers,body:'{}'})).json();assert.equal(d.checks[0].name,'Node');
});
test('hub rejects arbitrary actions, module keys and malformed JSON',async t=>{const hub=await hubFixture(t),html=await(await fetch(hub.url)).text(),headers={'Content-Type':'application/json','X-LDA-CSRF':html.match(/const csrf="([a-f\d]+)"/)[1],Origin:hub.url.slice(0,-1)};for(const [action,body]of[['execute','{}'],['install','{"module":"../escape"}'],['install','{bad']]){const r=await fetch(hub.url+'api/'+action,{method:'POST',headers,body});assert.equal(r.status,400);}assert.equal(hub.calls.length,0);});

test('hub About has product, licence, copyright and trademark details', async t => {
  const hub = await hubFixture(t), response = await fetch(hub.url + 'about'), text = await response.text();
  assert.equal(response.status, 200);
  for (const row of ['Product: LDA CLI', 'Version:', 'Suite: Local Developer Accelerator (LDA)',
    'Built by: Coding Koala (https://codingkoala.io)',
    'Source: https://github.com/coding-koala-io/local-developer-accelerator',
    'Licence: Apache License 2.0', 'Copyright: 2026 Coding Koalas Pty Ltd (ACN 668 775 433).',
    'Not affiliated with or endorsed by Optimizely.', 'Optimizely® is a trademark of Optimizely North America Inc.',
    'Provided as is, without warranty.']) assert.ok(text.includes(row), row);
  const html = await (await fetch(hub.url)).text();
  assert.match(html, /Free developer tools, built by <a href="https:\/\/codingkoala\.io" target="_blank" rel="noopener noreferrer">Coding Koala<\/a>/);
  assert.ok(!html.includes('Optimizely® is a trademark'));
  assert.doesNotMatch(text, /compatible with: Optimizely CMS/i);
  for (const mod of catalog) assert.ok(text.includes(`${mod.product}: ${mod.cmsLine}`), mod.key);
  assert.equal((await fetch(hub.url + 'legal')).status, 200);
});
