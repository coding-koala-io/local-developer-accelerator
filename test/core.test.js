import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile, writeFile} from 'node:fs/promises';
import {catalog, moduleFor, selectModules, wrapperSha256} from '../src/catalog.js';
import {getPaths, runtimePaths, isWithin} from '../src/paths.js';
import {parseServiceXml, createServices} from '../src/services.js';
import {checkHealth} from '../src/health.js';
import {compareVersions, verifyRelease} from '../src/verify.js';
import {validateEntries} from '../src/archive.js';
import {buildPlan} from '../src/plan.js';
import {renderStatus, statusExitCode} from '../src/output.js';
import {fixture, releaseFixture, fakeEngine, installed} from './helpers.js';
test('catalogue and aliases describe exactly the two v1 modules', () => {
  assert.deepEqual(catalog.map(m => m.key), ['graph', 'assets']); assert.equal(moduleFor('dam').key, 'assets');
  assert.equal(selectModules(['dam', 'assets']).length, 1); assert.throws(() => moduleFor('flags'), /Unknown module/);
  assert.equal(catalog[0].options.memoryMb.default, 8192);
});
test('path layout and containment reject sibling-prefix escapes', () => {
  const p = getPaths({LOCALAPPDATA: 'C:\\Users\\Fake\\AppData\\Local'});
  assert.match(p.code, /Program Files\\Coding Koala/); assert.match(p.data, /ProgramData\\Coding Koala/);
  assert.equal(runtimePaths('D:\\Runtime', 'LdaGraph').xml, 'D:\\Runtime\\service\\LdaGraph.xml');
  assert.ok(isWithin('C:\\cache', 'C:\\cache\\graph\\file.zip')); assert.ok(!isWithin('C:\\cache', 'C:\\cache-evil\\file.zip')); assert.ok(!isWithin('C:\\cache', 'C:\\cache\\..\\file.zip'));
});
test('configuration has typed defaults, atomic persistence and rejects unknown keys', async t => {
  const {config} = await fixture(t); assert.equal(await config.get('checkUpdates'), false); assert.equal(await config.get('hubPort'), 8080);
  await config.set('ports.graph', '9000'); assert.equal(await config.get('ports.graph'), 9000); await config.set('checkUpdates', 'true'); assert.equal(await config.get('checkUpdates'), true);
  await assert.rejects(config.set('ports.flags', 1)); await assert.rejects(config.set('hubPort', 0)); await assert.rejects(config.set('checkUpdates', 'yes'));
});
test('service XML derives version, memory, port and entities', () => {
  const x = parseServiceXml('<service><id>LdaGraph</id><executable>C:\\node.exe</executable><arguments>--max-old-space-size=8192 &quot;C:\\Program Files\\Coding Koala\\Local Developer Accelerator\\Graph\\1.2.0\\src\\server.js&quot;</arguments><env value="9000" name="PORT" /><env name="DATA_DIR" value="D:\\A&amp;B" /></service>');
  assert.equal(x.version, '1.2.0'); assert.equal(x.port, 9000); assert.equal(x.memoryMb, 8192); assert.equal(x.env.DATA_DIR, 'D:\\A&B');
});
test('service query discovers legacy id and reads matching XML without admin', async () => {
  const service = createServices({platform: 'win32', ps: async () => JSON.stringify([{Name: 'OptimizelyGraphLocal', State: 'Running', ProcessId: 5, PathName: '"D:\\Runtime\\service\\OptimizelyGraphLocal.exe"'}]), read: async file => {assert.equal(file, 'D:\\Runtime\\service\\OptimizelyGraphLocal.xml'); return '<service><id>OptimizelyGraphLocal</id><env name="PORT" value="8089" /></service>';}});
  const row = await service.describe(catalog[0], await service.query()); assert.equal(row.state, 'legacy install'); assert.equal(row.port, 8089); assert.equal(row.runtimeRoot, 'D:\\Runtime');
});
test('non-Windows discovery never invokes PowerShell', async () => {const s = createServices({platform: 'linux', ps: () => {throw Error('must not run');}}); assert.deepEqual(await s.query(), []);});
test('service discovery falls back to read-only SCM/registry when WMI is denied', async () => {let calls=0;const s=createServices({platform:'win32',ps:async script=>{if(++calls===1)throw Error('Access denied');assert.match(script,/Get-Service/);assert.match(script,/Get-ItemProperty/);assert.match(script,/sc.exe queryex/);assert.ok(!script.includes('Start-Service'));return '[{"Name":"OptimizelyGraphLocal","State":"Running","ProcessId":42,"PathName":"D:\\\\Runtime\\\\service\\\\OptimizelyGraphLocal.exe"}]';}});assert.equal((await s.query())[0].Name,'OptimizelyGraphLocal');assert.equal(calls,2);});
test('health rejects a different product, handles timeout and measures latency using fakes', async () => {
  let time = 0; const result = await checkHealth(1, {fetcher: async () => ({ok: true, json: async () => ({product: 'assets'})}), expectedProduct: 'graph', now: () => time += 12});
  assert.equal(result.ok, false); assert.equal(result.latency, 12); assert.match(result.message, /Expected product/);
  assert.equal((await checkHealth(1, {fetcher: async () => {throw Error('timeout');}})).ok, false);
});
test('release verification accepts all matching hashes and identity', async t => {const f = await fixture(t), r = await releaseFixture(f.root); const v = await verifyRelease({...r, module: 'graph'}); assert.equal(v.version, '1.2.0');});
for (const [name, change, pattern] of [
  ['bad manifest SHA', {manifest: {sha256: 'b'.repeat(64)}}, /SHA-256 mismatch/],
  ['wrong module', {manifest: {module: 'assets'}}, /module mismatch/],
  ['newer Node', {manifest: {minNode: 99}}, /requires Node/],
  ['bad sums', {sums: `${'b'.repeat(64)}  lda-graph-1.2.0.zip`}, /SHA-256 mismatch/],
  ['wrong file', {manifest: {file: 'else.zip'}}, /filename/],
  ['missing minNode', {manifest: {minNode: undefined}}, /requires Node/],
]) test(`verification fails before elevation: ${name}`, async t => {const f = await fixture(t), r = await releaseFixture(f.root); await assert.rejects(verifyRelease({...r, ...change, manifest: {...r.manifest, ...change.manifest}, module: 'graph'}), pattern);});
test('semver comparison handles numeric components and prereleases', () => {for (const [a,b] of [['1.10.0','1.2.0'],['1.0.0','1.0.0-rc.2'],['1.0.0-rc.10','1.0.0-rc.2']]) assert.equal(compareVersions(a,b),1); assert.equal(compareVersions('1.0.0','1.0.0'),0);});
test('archive validation forbids traversal, absolute paths and links', () => {
  validateEntries('src/server.js\nscripts/service-xml.js', '-rw-r--r-- fake src/server.js\n-rw-r--r-- fake scripts/service-xml.js');
  for (const name of ['../evil', '/evil', 'C:\\evil', 'src\\..\\evil', 'file:stream']) assert.throws(() => validateEntries(name, '-rw-r--r-- file'), /Unsafe/);
  assert.throws(() => validateEntries('link', 'lrwxrwxrwx link -> elsewhere'), /links/);
});
test('plans validate options and contain only fixed operation fields', async t => {
  const {paths} = await fixture(t); const install = {op: 'install', module: 'graph', version: '1.2.0', zip: path.join(paths.cache,'g.zip'), sha256: 'a'.repeat(64), port: 8082, runtimeRoot: 'D:\\Runtime', memoryMb: 8192};
  assert.equal(buildPlan([install], {cache: paths.cache}).version, 1);
  for (const extra of [{port: 0}, {runtimeRoot: 'relative'}, {memoryMb: 2}, {zip: path.join(paths.state, 'evil.zip')}, {command: 'injected'}]) assert.throws(() => buildPlan([{...install,...extra}], {cache: paths.cache}));
  assert.throws(() => buildPlan([install, install], {cache: paths.cache}), /once/);
});
test('status derives state and makes no release call by default', async t => {
  const f = await fixture(t); const {engine} = fakeEngine(f, {releases: {latest: () => {throw Error('network forbidden');}}}); const rows = await engine.status(); assert.equal(rows.length, 2); assert.equal(rows[0].latest, undefined);
});
for (const options of [{tty:false}, {tty:true,env:{NO_COLOR:''}}, {tty:true,unicode:false}, {tty:true,unicode:true,env:{},links: (label,url) => label}]) test(`status rendering: ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t), {engine} = fakeEngine(f, {states: {graph: installed()}}); const rows = await engine.status({checkUpdates:true}), text = renderStatus(rows, options);
  assert.match(text, /MODULE\s+STATE\s+PORT/); assert.match(text, /http:\/\/localhost:8082\//); assert.match(text, /1.0.0/);
  if (!options.tty || options.env?.NO_COLOR !== undefined) assert.ok(!/\x1b/.test(text));
  if (options.unicode === false || !options.tty || options.env?.NO_COLOR !== undefined) assert.match(text, /\(update\)/);
  assert.equal(statusExitCode(rows), 0); rows[0].health.ok=false; assert.equal(statusExitCode(rows),1);
});
test('pinned WinSW hash is exactly 64 hex characters', () => assert.match(wrapperSha256,/^[A-F\d]{64}$/));
