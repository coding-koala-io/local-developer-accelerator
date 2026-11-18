import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {catalog, moduleFor} from '../src/catalog.js';
import {buildPlan, planSteps} from '../src/plan.js';
import {doctor} from '../src/doctor.js';
import {fixture, fakeEngine, installed} from './helpers.js';
test('multi-module install resolves releases and elevates one plan once', async t => {
  const f = await fixture(t), {engine,calls} = fakeEngine(f); const result = await engine.act('install',['graph','assets']);
  assert.equal(result.ok,true); assert.equal(calls.length,1); assert.equal(calls[0].plan.operations.length,2); assert.equal(calls[0].plan.operations[0].memoryMb,8192); assert.equal(calls[0].plan.operations[1].port,8083);
});
test('Find install plans port 8088, folder Find and service LdaFind without memory or adoption', async t => {
  const f = await fixture(t), {engine, calls} = fakeEngine(f);
  const {plan} = await engine.act('install', ['find'], {dryRun: true});
  const [op] = plan.operations;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.dryRun, true);
  assert.equal(op.module, 'find');
  assert.equal(op.port, 8088);
  assert.equal(op.runtimeRoot, path.win32.join(f.paths.data, 'Find'));
  assert.equal(Object.hasOwn(op, 'memoryMb'), false);
  assert.equal(Object.hasOwn(op, 'legacyServiceId'), false);
  assert.match(planSteps(plan)[0], /register LdaFind/);
  await assert.rejects(engine.act('install', ['find'], {memoryMb: 8192}), /no --memory-mb/);
  await assert.rejects(engine.act('adopt', ['find']), /no legacy service to adopt/);
  assert.throws(() => buildPlan([{
    op: 'adopt', module: 'find', legacyServiceId: '', version: op.version, zip: op.zip, sha256: op.sha256,
  }], {cache: f.paths.cache}), /Legacy service id/);
  assert.equal(calls.length, 1);
});
test('install resolves alias and custom settings into the plan', async t => {
  const f = await fixture(t), {engine,calls} = fakeEngine(f); await engine.act('install',['dam'],{port:9000,dataDir:'D:\\Assets'}); assert.equal(calls[0].plan.operations[0].module,'assets'); assert.equal(calls[0].plan.operations[0].runtimeRoot,'D:\\Assets');
});
test('legacy install blocks install before download or elevation', async t => {
  const f=await fixture(t); const {engine,calls}=fakeEngine(f,{states:{graph:installed(catalog[0],{legacy:true,state:'legacy install'})}, releases:{bundle(){throw Error('must not download');}}});
  await assert.rejects(engine.act('install',['graph']),/lda adopt/); assert.equal(calls.length,0);
});
test('port conflict names owning process and fix before release lookup', async t => {
  const f=await fixture(t),{engine,calls}=fakeEngine(f,{portAvailable:async()=>false, releases:{bundle(){throw Error('must not download');}}});
  await assert.rejects(engine.act('install',['graph']),/PID 123.*--port/); assert.equal(calls.length,0);
});
test('invalid install options and shared overrides cannot elevate', async t => {
  const f=await fixture(t),{engine,calls}=fakeEngine(f); await assert.rejects(engine.act('install',['graph','assets'],{port:9000}),/single module/);
  await assert.rejects(engine.act('install',['assets'],{memoryMb:8192}),/no --memory-mb/); await assert.rejects(engine.act('install',['graph'],{memoryMb:10}),/memoryMb/); assert.equal(calls.length,0);
});
test('multi-module upgrades create one plan with only release fields', async t => {
  const f=await fixture(t),{engine,calls}=fakeEngine(f,{states:{graph:installed(),assets:installed(catalog[1])}}); await engine.act('upgrade',[]);
  assert.equal(calls.length,1); assert.equal(calls[0].plan.operations.length,2); assert.deepEqual(Object.keys(calls[0].plan.operations[0]).sort(),['module','op','sha256','version','zip']);
});
test('data-changing upgrade requires backup confirmation, --yes permits it', async t => {
  const f=await fixture(t),base=fakeEngine(f); base.releases.bundle=async mod=>({version:'2.0.0',dataVersion:2,zip:f.paths.cache+'/new.zip',sha256:'a'.repeat(64)});
  const {engine,calls}=fakeEngine(f,{states:{graph:installed()},releases:base.releases});
  await assert.rejects(engine.act('upgrade',['graph']),/Back up/); assert.equal(calls.length,0); await engine.act('upgrade',['graph'],{yes:true}); assert.equal(calls.length,1);
});
test('adopt detects legacy services and keeps changes in one elevated plan', async t => {
  const f=await fixture(t),{engine,calls}=fakeEngine(f,{states:{graph:installed(catalog[0],{legacy:true,state:'legacy install',serviceId:'OptimizelyGraphLocal'}),assets:installed(catalog[1],{legacy:true,state:'legacy install',serviceId:'OptimizelyDamLocal'})}});
  await engine.act('adopt',[]); assert.equal(calls.length,1); assert.deepEqual(calls[0].plan.operations.map(o=>o.legacyServiceId),['OptimizelyGraphLocal','OptimizelyDamLocal']);
});
test('start/stop/restart all use one elevation per job', async t => {
  const f=await fixture(t),{engine,calls}=fakeEngine(f,{states:{graph:installed(),assets:installed(catalog[1])}});
  for(const op of ['start','stop','restart']) await engine.act(op,[]); assert.equal(calls.length,3); assert.ok(calls.every(c=>c.plan.operations.length===2));
});
test('purge requires typed module confirmation or --yes', async t => {
  const f=await fixture(t),{engine,calls}=fakeEngine(f,{states:{graph:installed()}}); await assert.rejects(engine.act('uninstall',['graph'],{purge:true}),/Purge not confirmed/); await engine.act('uninstall',['graph'],{purge:true,yes:true}); assert.equal(calls[0].plan.operations[0].purge,true);
});
test('dry-run passes only the dry-run path to the injected elevator', async t => {const f=await fixture(t),{engine,calls}=fakeEngine(f); await engine.act('install',['graph'],{dryRun:true}); assert.equal(calls[0].opts.dryRun,true);});
test('service operations on Linux return foreground guidance without elevation', async t => {
  const f=await fixture(t),{engine,calls}=fakeEngine(f,{platform:'linux'}); const result=await engine.act('install',['graph']); assert.match(result.log[0],/Services are Windows only.*lda run all/); assert.equal(calls.length,0);
});
test('tray.json is catalogue driven and includes installed custom ports and notice', async t => {
  const f=await fixture(t),{engine}=fakeEngine(f,{states:{graph:installed()}}); const rows=await engine.status({checkUpdates:true}); rows[0].port=9010; await engine.writeTray(rows);
  const data=JSON.parse(await readFile(f.paths.tray,'utf8')); assert.equal(data.modules.length,1); assert.equal(data.modules[0].port,9010); assert.equal(data.modules[0].cmsLine,catalog[0].cmsLine); assert.equal(data.total,3); assert.equal(data.checkUpdates,false); assert.match(data.about,/not for production/); assert.equal(data.modules[0].update,true);
});
test('foreground all spawns local children with isolated env, prefixes logs and stops all', async t => {
  const f=await fixture(t),children=[],messages=[];
  const {engine}=fakeEngine(f,{states:{graph:installed(),assets:installed(catalog[1]),find:installed(moduleFor('find'))},progress:m=>messages.push(m),spawn:(exe,args,opts)=>{const c=new EventEmitter(); c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{c.stopped=true;};children.push({c,exe,args,opts});return c;}});
  const job=await engine.run(['all']); assert.deepEqual(children.map(c => c.opts.env.PORT), ['8082', '8083', '8088']); assert.ok(children.every(c => c.opts.env.HOST === '127.0.0.1')); assert.match(children[0].opts.env.TENANTS_FILE,/run.*Graph.*tenants.json/); children[0].c.stdout.write('hello\n'); assert.ok(messages.includes('[graph] hello'));job.stop(); assert.ok(children.every(c=>c.c.stopped));
});
test('Find foreground invokes the init contract and uses the runtime data directory on loopback', async t => {
  const f = await fixture(t), codeDir = path.join(f.root, 'release'), scripts = path.join(codeDir, 'scripts');
  const root = path.join(f.paths.run, 'Find'), data = path.join(root, 'data');
  await mkdir(scripts, {recursive: true});
  await writeFile(path.join(scripts, 'service-xml.js'), `
    import fs from 'node:fs';
    import path from 'node:path';
    if (process.argv[2] !== 'init') process.exit(1);
    const options = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.appendFileSync(path.join(options.runtimeRoot, 'data', 'init.jsonl'), JSON.stringify(options) + '\\n');
  `);
  const {engine} = fakeEngine(f, {
    platform: 'linux',
    states: {find: installed(moduleFor('find'), {codeDir})},
    initialize: undefined,
    spawn(exe, args, {env}) {
      assert.equal(exe, process.execPath);
      assert.deepEqual(args, [path.join(codeDir, 'src', 'server.js')]);
      assert.equal(env.PORT, '8088');
      assert.equal(env.HOST, '127.0.0.1');
      assert.equal(env.DATA_ROOT, data);
      assert.equal(env.DATA_DIR, data);
      return {kill() {}};
    },
  });
  for (let i = 0; i < 2; i++) (await engine.run(['find'])).stop();
  const inits = (await readFile(path.join(data, 'init.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const options = {nodePath: process.execPath, repoRoot: codeDir, runtimeRoot: root, port: 8088};
  assert.deepEqual(inits, [options, options]);
  await assert.rejects(readFile(path.join(root, 'tenants.json')), {code: 'ENOENT'});
});
test('Find logs and open avoid dashboard URLs', async t => {
  const f = await fixture(t), {engine} = fakeEngine(f, {
    states: {find: installed(moduleFor('find'))},
    open: () => assert.fail('Find must not launch a browser'),
    readFile: async () => {throw Object.assign(new Error('missing'), {code: 'ENOENT'});},
  });
  assert.equal(await engine.logs('find'), 'No wrapper logs yet.');
  await assert.rejects(engine.open('find'), /LDA Local Find has no dashboard/);
});
test('foreground mode refuses a busy service port before spawning', async t => {const f=await fixture(t),{engine}=fakeEngine(f,{portAvailable:async()=>false,spawn:()=>{throw Error('must not spawn');}}); await assert.rejects(engine.run(['graph']),/Port 8082/);});
test('doctor with fakes verifies hash, product, ACL, free space and default offline policy', async t => {
  const f=await fixture(t),{engine}=fakeEngine(f,{states:{graph:installed()}});let requests=0;
  const checks=await doctor(engine,{platform:'win32',nodePath:'C:\\Program Files\\nodejs\\node.exe',nodeVersion:'24.1.0',ps:async cmd=>cmd.includes('Get-Acl')?JSON.stringify({protected:true,rules:[{sid:'S-1-5-19',type:'Allow'}]}):'C:\\Windows\\tar.exe',hash:async()=> '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA',disk:async()=>({bavail:10*1024**3,bsize:1}),fetcher:async()=>{requests++;throw Error('forbidden');}});
  assert.equal(requests,0);for(const name of ['graph WinSW','graph code path','graph port owner','graph runtime ACL','graph free space','graph health']) assert.equal(checks.find(c=>c.name===name).ok,true,name);
});
test('doctor reports access denial as needs admin and warns about user Node', async t => {
  const f=await fixture(t),{engine}=fakeEngine(f,{states:{graph:installed()}});const checks=await doctor(engine,{platform:'win32',nodePath:'C:\\Users\\Fake\\nvm\\node.exe',ps:async()=>{throw Error('access denied');},hash:async()=> 'bad',disk:async()=>({bavail:1,bsize:1})});
  assert.equal(checks.find(c=>c.name==='Node location').ok,false);assert.equal(checks.find(c=>c.name==='graph runtime ACL').message,'needs admin to verify');assert.equal(checks.find(c=>c.name==='graph free space').ok,false);
});
test('doctor online clock comparison uses an injected request only when asked', async t=>{const f=await fixture(t),{engine}=fakeEngine(f);const checks=await doctor(engine,{online:true,platform:'linux',runner:async()=>{},now:()=>0,fetcher:async()=>({headers:new Headers({date:'Thu, 01 Jan 1970 00:00:00 GMT'})})});assert.equal(checks.find(c=>c.name==='Clock').ok,true);});
test('known updates survive health-only polling without new release lookups',async t=>{const f=await fixture(t);let lookups=0;const{engine}=fakeEngine(f,{states:{graph:installed()},releases:{latest:async()=>{lookups++;return'1.2.0';}}});const checked=await engine.status({checkUpdates:true});assert.equal(checked[0].update,true);const polled=await engine.status();assert.equal(polled[0].update,true);assert.equal(lookups,3);});
test('foreground initializes each missing tenant file through an injected initializer',async t=>{const f=await fixture(t),inits=[];const{engine}=fakeEngine(f,{states:{graph:installed()},initialize:async(...args)=>inits.push(args),spawn:()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};return c;}});const job=await engine.run(['graph']);job.stop();assert.equal(inits.length,1);assert.match(inits[0][1],/run.*Graph/);assert.equal(inits[0][2],8082);});
test('logs access-denied response prints exact elevated command and dashboard request-log URL',async t=>{const f=await fixture(t),{engine}=fakeEngine(f,{states:{graph:installed()},readFile:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}});const text=await engine.logs('graph',{lines:7});assert.match(text,/Get-Content -LiteralPath 'C:\\ProgramData.*LdaGraph.out.log' -Tail 7 -Wait/);assert.match(text,/http:\/\/localhost:8082\/#request-log/);});
