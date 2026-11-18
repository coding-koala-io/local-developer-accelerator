import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {render,cleanup} from 'ink-testing-library';
import {App} from '../src/tui/app.js';
import {catalog} from '../src/catalog.js';
import {CancelledError} from '../src/elevate.js';
import {delay} from './helpers.js';
async function waitFor(fn){for(let i=0;i<80;i++){if(fn())return;await delay(25);}assert.ok(fn(),'UI did not reach expected state');}
function tuiEngine(){const calls=[];let progress;const rows=catalog.map(m=>({module:m.key,product:m.product,state:'running',serviceState:'running',installed:true,port:m.port,version:'1.0.0',update:true,health:{ok:true,latency:12,uptime:100},dashboard:`http://localhost:${m.port}/`}));const engine={async status(opts){calls.push(['status',opts]);return rows;},async open(key){calls.push(['open',key]);},async act(op,keys){calls.push([op,keys]);return{ok:true,operations:[]};},async logs(key){calls.push(['logs',key]);return'synthetic log line';},subscribe(cb){progress=cb;return()=>{progress=null;};}};return{engine,calls,progress:m=>progress?.(m)};}
test('Ink renders module list, selected details, banner and uptime',async t=>{t.after(cleanup);const fake=tuiEngine(),view=render(React.createElement(App,{engine:fake.engine,showBranding:true}));await waitFor(()=>view.lastFrame()?.includes('Ready'));for(const text of ['Graph','Assets','8082','1.0.0','12ms','100s','Made for CMS 13 sites.','Made for CMS 12 sites','Development use only','built by Coding Koala','Not affiliated with or endorsed by Optimizely'])assert.ok(view.lastFrame().replace(/\s+/g,' ').includes(text),text);view.unmount();});
test('Ink keyboard opens, starts/stops, restarts, upgrades, selects and tails logs',async t=>{
  t.after(cleanup);const {engine,calls}=tuiEngine(),view=render(React.createElement(App,{engine}));await waitFor(()=>view.lastFrame()?.includes('Ready'));
  for(const [key,action] of [['o','open'],['s','stop'],['r','restart'],['u','upgrade']]){view.stdin.write(key);await waitFor(()=>calls.some(c=>c[0]===action));await delay(40);}
  view.stdin.write('\u001b[B');await waitFor(()=>view.lastFrame().includes('8083'));view.stdin.write('l');await waitFor(()=>view.lastFrame().includes('synthetic log line'));assert.ok(calls.some(c=>c[0]==='logs'&&c[1]==='assets'));view.stdin.write('?');await waitFor(()=>view.lastFrame().includes('Windows approval'));view.unmount();
});
test('Ink shows Find service health without a dashboard action', async t => {
  t.after(cleanup);
  const {engine,calls} = tuiEngine(), view = render(React.createElement(App, {engine}));
  await waitFor(() => view.lastFrame()?.includes('Ready'));
  view.stdin.write('\u001b[B');
  await waitFor(() => view.lastFrame().includes('8083'));
  view.stdin.write('\u001b[B');
  await waitFor(() => view.lastFrame().includes('8088'));
  assert.match(view.lastFrame(), /State: running/);
  assert.match(view.lastFrame(), /Health: ok 12ms/);
  assert.doesNotMatch(view.lastFrame(), /o open|localhost:8088/);
  view.stdin.write('o');
  assert.equal(calls.some(c => c[0] === 'open'), false);
  view.unmount();
});
test('Ink install key and act-on-all use catalogue keys',async t=>{t.after(cleanup);const {engine,calls}=tuiEngine();engine.status=async()=>catalog.map(m=>({module:m.key,installed:false,state:'not installed',port:m.port}));const view=render(React.createElement(App,{engine}));await waitFor(()=>view.lastFrame()?.includes('Ready'));view.stdin.write('a');await waitFor(()=>view.lastFrame().includes('[ALL]'));view.stdin.write('i');await waitFor(()=>calls.some(c=>c[0]==='install'));assert.deepEqual(calls.find(c=>c[0]==='install')[1],['graph','assets','find']);view.unmount();});
test('Ink shows Windows approval progress and cancellation result',async t=>{t.after(cleanup);const fake=tuiEngine();fake.engine.act=async()=>{fake.progress('Waiting for Windows approval…');await delay(80);throw new CancelledError();};const view=render(React.createElement(App,{engine:fake.engine}));await waitFor(()=>view.lastFrame()?.includes('Ready'));view.stdin.write('r');await waitFor(()=>view.lastFrame().includes('Waiting for Windows approval'));await waitFor(()=>view.lastFrame().includes('Cancelled at the Windows prompt'));view.unmount();});
test('Ink shows the update discovery key and confirms data migration without a competing readline',async t=>{t.after(cleanup);const fake=tuiEngine();const original=fake.engine.status;fake.engine.status=async opts=>(await original(opts)).map(r=>({...r,update:!!opts?.checkUpdates}));let confirmed;fake.engine.act=async(op,keys,opts)=>{confirmed=await opts.confirm('Back up runtime before the data version change. Continue? [y/N]');return{ok:confirmed};};const view=render(React.createElement(App,{engine:fake.engine}));await waitFor(()=>view.lastFrame()?.includes('u check updates'));view.stdin.write('u');await waitFor(()=>view.lastFrame().includes('Back up runtime'));view.stdin.write('y');await waitFor(()=>confirmed===true);view.unmount();});
test('Ink NO_COLOR screen uses ASCII indicators and labels',async t=>{const old=process.env.NO_COLOR;process.env.NO_COLOR='1';t.after(()=>{cleanup();if(old===undefined)delete process.env.NO_COLOR;else process.env.NO_COLOR=old;});const fake=tuiEngine(),view=render(React.createElement(App,{engine:fake.engine}));await waitFor(()=>view.lastFrame()?.includes('Ready'));assert.ok(!/[^\x00-\x7f]/.test(view.lastFrame()));assert.match(view.lastFrame(),/\* Graph/);view.unmount();});

test('Ink startup omits attribution when the shared branding gate is closed',async t=>{
  t.after(cleanup);const fake=tuiEngine(),view=render(React.createElement(App,{engine:fake.engine,showBranding:false}));
  await waitFor(()=>view.lastFrame()?.includes('Ready'));
  const screen=view.lastFrame().replace(/\s+/g,' ');
  assert.ok(!screen.includes('Coding Koala'));
  assert.equal((screen.match(/Not affiliated with or endorsed by Optimizely\./g)||[]).length,1);
  view.unmount();
});
