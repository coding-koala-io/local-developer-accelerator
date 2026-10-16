import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startHub} from '../src/hub.js';
import {fixture,fakeEngine} from './helpers.js';
async function hubFixture(t){const f=await fixture(t),fake=fakeEngine(f);const hub=await startHub({engine:fake.engine,port:0,doctor:async()=>[{name:'Node',ok:true,message:'fake',fix:'none'}]});t.after(()=>hub.close());return{...hub,...fake};}
test('hub binds loopback on port 0 and server-renders banner, cards, legal links and controls',async t=>{
  const hub=await hubFixture(t),response=await fetch(hub.url),html=await response.text();assert.equal(hub.server.address().address,'127.0.0.1');
  for(const text of ['Development and research use only','not affiliated','LDA Local Graph','LDA Local Assets','Compatible with Optimizely','Check for updates now','Run doctor','No telemetry','/privacy','/licence','/legal','Logs'])assert.ok(html.includes(text),text);
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('hub status JSON has two catalogue modules and dashboard URLs',async t=>{const hub=await hubFixture(t),rows=await(await fetch(hub.url+'api/status')).json();assert.equal(rows.length,2);assert.equal(rows[0].module,'graph');assert.equal(rows[1].state,'not installed');assert.match(rows[0].dashboard,/localhost:8082/);});
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
