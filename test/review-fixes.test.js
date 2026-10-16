import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import React from 'react';
import {render, cleanup} from 'ink-testing-library';
import {catalog} from '../src/catalog.js';
import {checkHealth} from '../src/health.js';
import {createServices} from '../src/services.js';
import {doctor} from '../src/doctor.js';
import {tarPath, extractArchive} from '../src/archive.js';
import {startHub, renderHub} from '../src/hub.js';
import {main} from '../src/cli.js';
import {App} from '../src/tui/app.js';
import {fixture, fakeEngine, installed, delay} from './helpers.js';
const legacyState = (mod = catalog[0]) => installed(mod, {legacy: true, state: 'legacy install', serviceId: mod.legacyServiceIds[0], version: 'legacy', codeDir: 'D:\\src\\server'});
const reply = (status, body) => async () => ({ok: status >= 200 && status < 300, status, json: async () => body});

test('health: product absent is healthy legacy, other product or non-2xx is not', async () => {
  const legacy = await checkHealth(1, {fetcher: reply(200, {status: 'ok'}), expectedProduct: 'graph'});
  assert.equal(legacy.ok, true); assert.equal(legacy.legacy, true);
  const match = await checkHealth(1, {fetcher: reply(200, {product: 'graph', version: '1.0.0'}), expectedProduct: 'graph'});
  assert.equal(match.ok, true); assert.equal(match.legacy, false);
  assert.equal((await checkHealth(1, {fetcher: reply(200, {product: 'assets'}), expectedProduct: 'graph'})).ok, false);
  assert.equal((await checkHealth(1, {fetcher: reply(503, {status: 'starting'}), expectedProduct: 'graph'})).ok, false);
});

test('legacy services show version legacy and never an update, even without a version to compare', async t => {
  const svc = createServices({platform: 'win32', ps: async () => JSON.stringify([{Name: 'OptimizelyGraphLocal', State: 'Running', ProcessId: 5, PathName: '"D:\\Rt\\service\\OptimizelyGraphLocal.exe"'}]), read: async () => '<service><id>OptimizelyGraphLocal</id><workingdirectory>D:\\src\\optimizely-graph-server</workingdirectory></service>'});
  assert.equal((await svc.describe(catalog[0], await svc.query())).version, 'legacy');
  const f = await fixture(t), {engine} = fakeEngine(f, {states: {graph: {...legacyState(), version: undefined}, assets: installed(catalog[1], {version: undefined})}, health: async () => ({ok: true, legacy: true, latency: 3})});
  const rows = await engine.status({checkUpdates: true});
  assert.equal(rows[0].version, 'legacy'); assert.equal(rows[0].update, false); assert.equal(rows[0].health.ok, true);
  assert.equal(rows[1].version, 'legacy', 'a new-id service whose /health has no product is shown as legacy'); assert.equal(rows[1].update, false);
});

test('quickStatus re-checks health only, without service queries or release lookups', async t => {
  const f = await fixture(t); let describes = 0, healths = 0, lookups = 0;
  const {engine, services} = fakeEngine(f, {states: {graph: installed()}, health: async (port, o) => {healths++; return {ok: true, latency: 1, product: o.expectedProduct, version: '1.0.0'};}});
  const describe = services.describe; services.describe = async (...a) => {describes++; return describe(...a);}; engine.releases.latest = async () => {lookups++; return '1.2.0';};
  await engine.status(); const before = describes; const rows = await engine.quickStatus(); await engine.quickStatus();
  assert.equal(describes, before); assert.equal(lookups, 0); assert.equal(healths, 3); assert.equal(rows[0].health.ok, true);
});

test('start/stop --all skip legacy services with a note instead of failing', async t => {
  const f = await fixture(t), {engine, calls} = fakeEngine(f, {states: {graph: legacyState(), assets: installed(catalog[1])}});
  const r = await engine.act('start', []); assert.equal(r.ok, true); assert.equal(calls[0].plan.operations.length, 1); assert.equal(calls[0].plan.operations[0].module, 'assets'); assert.match(r.log[0], /Skipped graph: legacy install — run lda adopt graph/);
  const only = fakeEngine(f, {states: {graph: legacyState()}}); const s = await only.engine.act('stop', []); assert.equal(s.ok, true); assert.equal(only.calls.length, 0); assert.match(s.log.join('\n'), /Skipped graph/);
  await assert.rejects(engine.act('start', ['graph']), /lda adopt graph/);
});

test('--data-dir must be empty or a runtime layout; purge checks the same before deleting', async t => {
  const f = await fixture(t), foreign = path.join(f.root, 'Documents'), runtime = path.join(f.root, 'Runtime');
  await mkdir(foreign); await writeFile(path.join(foreign, 'thesis.docx'), 'x'); await mkdir(path.join(runtime, 'data'), {recursive: true}); await writeFile(path.join(runtime, 'tenants.json'), '{}');
  const {engine, calls} = fakeEngine(f);
  await assert.rejects(engine.act('install', ['graph'], {dataDir: foreign}), /thesis\.docx, which is not part of a runtime folder/); assert.equal(calls.length, 0);
  await engine.act('install', ['graph'], {dataDir: runtime}); await engine.act('install', ['assets'], {dataDir: path.join(f.root, 'new')}); assert.equal(calls.length, 2);
  const purge = fakeEngine(f, {states: {graph: installed(catalog[0], {runtimeRoot: foreign})}});
  await assert.rejects(purge.engine.act('uninstall', ['graph'], {purge: true, yes: true}), /not part of a runtime folder/); assert.equal(purge.calls.length, 0);
});

test('unknown data version is treated as 1', async t => {
  const f = await fixture(t), base = fakeEngine(f), states = {graph: installed()};
  const none = {health: async () => ({ok: true, latency: 1, product: 'graph', version: '1.0.0'}), readFile: async () => {throw Object.assign(Error('denied'), {code: 'EACCES'});}};
  base.releases.bundle = async () => ({version: '2.0.0', dataVersion: 1, zip: path.join(f.paths.cache, 'n.zip'), sha256: 'a'.repeat(64)});
  const same = fakeEngine(f, {states, releases: base.releases, ...none}); await same.engine.act('upgrade', ['graph']); assert.equal(same.calls.length, 1, 'dataVersion 1 release needs no backup prompt');
  const next = {...base.releases, bundle: async () => ({version: '2.0.0', dataVersion: 2, zip: path.join(f.paths.cache, 'n.zip'), sha256: 'a'.repeat(64)})};
  const higher = fakeEngine(f, {states, releases: next, ...none}); let asked = ''; await assert.rejects(higher.engine.act('upgrade', ['graph'], {confirm: async q => {asked = q; return false;}}), /not confirmed/); assert.match(asked, /data version 1 to 2/);
});

test('lda adopt accepts --version and --from like install', async t => {
  const f = await fixture(t), {engine, calls} = fakeEngine(f, {states: {graph: legacyState()}});
  const out = {text: '', write(s) {this.text += s;}};
  assert.equal(await main(['adopt', 'graph', '--version', '1.3.0', '--dry-run', '--accept-notice'], {engine, stdout: out, stderr: out, env: {}}), 0, out.text);
  assert.equal(calls[0].plan.operations[0].op, 'adopt'); assert.equal(calls[0].plan.operations[0].version, '1.3.0');
  let seen; engine.releases.bundle = async (mod, opts) => {seen = opts; return {version: '1.2.0', sha256: 'a'.repeat(64), zip: path.join(f.paths.cache, 'x.zip')};};
  assert.equal(await main(['adopt', 'graph', '--from', 'D:\\rel\\lda-graph-1.2.0.zip', '--dry-run', '--accept-notice'], {engine, stdout: out, stderr: out, env: {}}), 0, out.text);
  assert.equal(seen.from, 'D:\\rel\\lda-graph-1.2.0.zip');
});

test('tar is always System32 tar.exe on Windows', async () => {
  assert.equal(tarPath({platform: 'win32', env: {SystemRoot: 'C:\\Windows'}}), 'C:\\Windows\\System32\\tar.exe'); assert.equal(tarPath({platform: 'linux', env: {}}), 'tar');
  const used = []; await assert.rejects(extractArchive('x.zip', 'dest', {tar: 'C:\\Windows\\System32\\tar.exe', runner: async exe => {used.push(exe); return {stdout: ''};}}), /Unsafe archive/);
  assert.deepEqual([...new Set(used)], ['C:\\Windows\\System32\\tar.exe']);
});

test('doctor: legacy fixes say adopt, health uses health.ok, free space on drive root, System32 tar, service node path followed', async t => {
  const f = await fixture(t), {engine} = fakeEngine(f, {states: {graph: {...legacyState(), runtimeRoot: 'D:\\DevRuntimes\\Graph'}}, health: async () => ({ok: true, legacy: true, latency: 2})});
  const disks = [], probed = [];
  const checks = await doctor(engine, {platform: 'win32', env: {SystemRoot: 'C:\\Windows'}, ps: async cmd => {if (cmd.includes('Get-Command node')) return 'C:\\Program Files\\nodejs\\node.exe'; throw Error('denied');}, realpath: p => p.replace('nodejs', 'nodejs-real'), nodeVersion: '24.1.0', exists: async p => probed.push(p), hash: async () => 'bad', disk: async p => {disks.push(p); return {bavail: 10 * 1024 ** 3, bsize: 1};}});
  const by = name => checks.find(c => c.name === name);
  assert.match(by('graph service').fix, /lda adopt graph/); assert.match(by('graph WinSW').fix, /lda adopt graph/); assert.match(by('graph code path').fix, /lda adopt graph/);
  assert.equal(by('graph health').ok, true); assert.deepEqual(disks, ['D:\\']);
  assert.deepEqual(probed, ['C:\\Windows\\System32\\tar.exe']); assert.equal(by('tar').ok, true);
  assert.match(by('Node').message, /C:\\Program Files\\nodejs-real\\node\.exe/);
});

test('hub: cheap /api/health poll every 3 s, full status every 30 s, Start hidden while running', async t => {
  const f = await fixture(t), fake = fakeEngine(f, {states: {graph: installed()}}); let quick = 0;
  const original = fake.engine.quickStatus; fake.engine.quickStatus = async () => {quick++; return original();};
  const hub = await startHub({engine: fake.engine, port: 0}); t.after(() => hub.close());
  const rows = await (await fetch(hub.url + 'api/health')).json(); assert.equal(rows.length, 2); assert.equal(quick, 1);
  const html = await (await fetch(hub.url)).text();
  assert.ok(html.includes("setInterval(()=>refresh(false),3000)")); assert.ok(html.includes("setInterval(()=>refresh(true),30000)")); assert.ok(html.includes("full?'/api/status':'/api/health'"));
  const graphCard = renderHub([{module: 'graph', installed: true, state: 'running', serviceState: 'running', port: 8082}], {token: 't'}).split('id="assets"')[0];
  assert.match(graphCard, /data-action="start" data-module="graph" hidden/); assert.doesNotMatch(graphCard, /data-action="stop" data-module="graph" hidden/);
});

test('TUI polls health only between full refreshes and shows s stop when running', async t => {
  t.after(cleanup); const calls = [];
  const rows = catalog.map(m => ({module: m.key, product: m.product, state: 'running', serviceState: 'running', installed: true, port: m.port, version: '1.0.0', health: {ok: true, latency: 1}}));
  const engine = {async status() {calls.push('status'); return rows;}, async quickStatus() {calls.push('quick'); return rows;}, async logs() {return '';}, subscribe() {return () => {};}};
  const view = render(React.createElement(App, {engine, refreshMs: 20, fullRefreshMs: 60000}));
  await delay(200); const frame = view.lastFrame(); view.unmount();
  assert.equal(calls.filter(c => c === 'status').length, 1); assert.ok(calls.filter(c => c === 'quick').length >= 3);
  assert.match(frame, /s stop/);
});

test('tray.json marks legacy modules and names this package bin\\lda.js', async t => {
  const f = await fixture(t), {engine} = fakeEngine(f, {states: {graph: legacyState()}}); await engine.writeTray(await engine.status());
  const data = JSON.parse(await readFile(f.paths.tray, 'utf8')); assert.equal(data.modules[0].legacy, true); assert.match(data.cli, /[\\/]bin[\\/]lda\.js$/);
});
