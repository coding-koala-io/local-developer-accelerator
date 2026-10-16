import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {main} from '../src/cli.js';
import {ensureNotice} from '../src/notice.js';
import {createElevator,CancelledError} from '../src/elevate.js';
import {tray} from '../src/tray.js';
import {fixture,fakeEngine,installed} from './helpers.js';
const output=()=>({text:'',isTTY:false,write(s){this.text+=s;}});
async function cli(t,args,overrides={}){const f=await fixture(t),{engine,calls}=fakeEngine(f),stdout=output(),stderr=output();const code=await main(args,{engine,stdout,stderr,env:{},...overrides});return{code,stdout,stderr,engine,calls,...f};}
test('about/privacy/licence/help/version bypass notice acceptance',async t=>{
  for(const args of [['about'],['privacy'],['licence'],['--help'],['--version']]){const r=await cli(t,args);assert.equal(r.code,0,r.stderr.text);assert.equal((await r.config.read()).noticeAcceptedMajor,undefined);assert.ok(r.stdout.text.length>0);}
});
test('first run in automation rejects without explicit acceptance, --yes is insufficient',async t=>{const r=await cli(t,['status','--yes']);assert.equal(r.code,1);assert.match(r.stderr.text,/--accept-notice/);assert.match(r.stderr.text,/development and research/);});
test('CLI status JSON is an array and acceptance persists by major',async t=>{const r=await cli(t,['status','--json','--accept-notice']);assert.equal(r.code,0,r.stderr.text);assert.equal(JSON.parse(r.stdout.text).length,2);assert.equal((await r.config.read()).noticeAcceptedMajor,1);});
test('no-argument automation prints the two-module status table',async t=>{const r=await cli(t,['--accept-notice']);assert.equal(r.code,0,r.stderr.text);assert.match(r.stdout.text,/LDA Local Graph/);assert.match(r.stdout.text,/LDA Local Assets/);});
test('TTY notice accepts only y, prompts again for a new major',async t=>{
  const f=await fixture(t);const args={...f,tty:true,env:{},prompt:async()=> 'y',print:()=>{}};await ensureNotice(args);assert.equal((await f.config.read()).noticeAcceptedMajor,1);await f.config.save({noticeAcceptedMajor:0});await assert.rejects(ensureNotice({...args,prompt:async()=> 'yes'}),/not accepted/);await ensureNotice({...args,env:{LDA_ACCEPT_NOTICE:'1'},tty:false});
});
test('install CLI parses local flags and produces one multi-module plan',async t=>{const r=await cli(t,['install','graph','assets','--dry-run','--accept-notice']);assert.equal(r.code,0,r.stderr.text);assert.equal(r.calls.length,1);assert.equal(r.calls[0].opts.dryRun,true);});
test('service CLI requires module arguments or --all',async t=>{const r=await cli(t,['start','--accept-notice']);assert.equal(r.code,1);assert.match(r.stderr.text,/--all/);});
test('config CLI set/get performs typed update',async t=>{const r=await cli(t,['config','set','hubPort','9090','--accept-notice']);assert.equal(r.code,0,r.stderr.text);assert.equal(await r.config.get('hubPort'),9090);});
test('upgrade --check only reports and never elevates',async t=>{const r=await cli(t,['upgrade','--all','--check','--json','--accept-notice']);assert.equal(r.code,0,r.stderr.text);assert.equal(r.calls.length,0);assert.equal(JSON.parse(r.stdout.text).length,2);});
test('status returns exit 1 for an unhealthy installed module',async t=>{const f=await fixture(t),{engine}=fakeEngine(f,{states:{graph:installed()},health:async()=>({ok:false})});const code=await main(['status','--json','--accept-notice'],{engine,stdout:output(),stderr:output(),env:{}});assert.equal(code,1);});
test('UAC runner cancels cleanly with exit 2 and removes temporary plan files',async t=>{
  const f=await fixture(t);let calls=0;const elevate=createElevator({paths:f.paths,platform:'win32',runner:async(script,meta)=>{calls++;if(meta?.planFile){throw Object.assign(Error('The operation was canceled by the user'),{code:1223});}}});
  await assert.rejects(elevate({version:1,operations:[{op:'start',module:'graph'}]}),e=>e instanceof CancelledError&&e.exitCode===2&&e.message==='Cancelled at the Windows prompt');assert.equal(calls,2);assert.deepEqual(await readdir(f.paths.plans),[]);
});
test('elevation writes a hashed plan, invokes one RunAs and reads result with injected runner',async t=>{
  const f=await fixture(t);let prompts=0;const elevator=createElevator({paths:f.paths,platform:'win32',runner:async(script,meta)=>{
    if(!meta?.planFile){assert.match(script,/SetAccessRuleProtection\(\$true,\$false\)/);return '';}
    prompts++;assert.match(script,/-Verb RunAs -Wait -PassThru -WindowStyle Hidden/);const plan=JSON.parse(await readFile(meta.planFile,'utf8'));await writeFile(meta.resultFile,JSON.stringify({ok:true,operations:plan.operations,log:[]}));return '';
  }});
  const result=await elevator({version:1,operations:[{op:'start',module:'graph'},{op:'start',module:'assets'}]});assert.equal(result.ok,true);assert.equal(prompts,1);assert.deepEqual(await readdir(f.paths.plans),[]);
});
test('CLI maps UAC cancellation to a plain message and exit 2 without stack',async t=>{const f=await fixture(t),{engine}=fakeEngine(f,{states:{graph:installed()},elevate:async()=>{throw new CancelledError();}}),stderr=output();const code=await main(['start','graph','--accept-notice'],{engine,stdout:output(),stderr,env:{}});assert.equal(code,2);assert.equal(stderr.text.split('\n').filter(s=>s.includes('Cancelled')).length,1);assert.ok(!/\n\s+at /.test(stderr.text));});
test('self-update uses fake registry and --dry-run never executes npm',async t=>{let requests=0;const r=await cli(t,['self-update','--yes','--dry-run','--accept-notice'],{fetcher:async url=>{requests++;assert.match(url,/registry.npmjs.org/);return{ok:true,json:async()=>({version:'1.1.0'})};},runner:()=>{throw Error('npm forbidden');},ps:()=>{throw Error('npm forbidden');}});assert.equal(r.code,0,r.stderr.text);assert.equal(requests,1);assert.match(r.stdout.text,/npm i -g @coding-koala-io\/accelerator@latest/);});
test('tray startup/login/stop use injected scripts without UAC or service commands',async t=>{const f=await fixture(t),{engine}=fakeEngine(f),scripts=[];const runner=async s=>scripts.push(s);await tray(engine,{atLogin:true,runner});assert.ok(scripts.some(s=>s.includes('Set-ItemProperty')));assert.ok(scripts.some(s=>s.includes('Start-Process -FilePath $exe -WindowStyle Hidden')));assert.ok(scripts.every(s=>!s.includes('RunAs')));await tray(engine,{stop:true,runner});assert.match(scripts.at(-1),/EventWaitHandle/);});
test('CLI elevator dry-run invokes helper -DryRun with no RunAs',async t=>{const f=await fixture(t),scripts=[];const elevator=createElevator({paths:f.paths,platform:'win32',runner:async script=>{scripts.push(script);return'DRY RUN: start graph';}});const result=await elevator({version:1,operations:[{op:'start',module:'graph'}]},{dryRun:true});assert.equal(result.dryRun,true);assert.ok(scripts.some(s=>s.endsWith('-DryRun')));assert.ok(scripts.every(s=>!s.includes('-Verb RunAs')));assert.deepEqual(await readdir(f.paths.plans),[]);});
test('list output shows available latest as well as installed version',async t=>{const r=await cli(t,['list','--accept-notice']);assert.equal(r.code,0,r.stderr.text);assert.match(r.stdout.text,/latest: 1.2.0/);assert.match(r.stdout.text,/installed: -/);});
