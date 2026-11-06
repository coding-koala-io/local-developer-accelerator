import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {tarPath, extractArchive} from '../src/archive.js';
import {superviseForeground} from '../src/foreground.js';
import {powershell} from '../src/process.js';
import {createElevator} from '../src/elevate.js';
import {tray} from '../src/tray.js';
import {main} from '../src/cli.js';
import {doctor} from '../src/doctor.js';
import {fixture, fakeEngine} from './helpers.js';
import {waitForServices} from '../scripts/e2e-health.js';

const child = () => Object.assign(new EventEmitter(), {kills: [], kill(signal) {this.kills.push(signal);}});
test('Linux doctor accepts user-installed Node, checks bsdtar, and skips Windows diagnostics', async t => {
  const f = await fixture(t), {engine} = fakeEngine(f, {platform: 'linux'}), commands = [];
  const options = {platform: 'linux', nodePath: '/home/developer/.nvm/bin/node', nodeVersion: '24.0.0', realpath: p => p, ps: () => {throw new Error('must not call PowerShell');}};
  const checks = await doctor(engine, {...options, runner: async (...args) => commands.push(args)});
  assert.ok(checks.every(c => c.ok)); assert.equal(commands[0][0], 'bsdtar');
  assert.equal(checks.some(c => /Windows version|Node location|ACL|service/.test(c.name)), false);
  const missing = await doctor(engine, {...options, runner: async () => {throw new Error('missing');}});
  assert.equal(missing.find(c => c.name === 'ZIP extractor').ok, false);
  assert.match(missing.find(c => c.name === 'ZIP extractor').fix, /libarchive-tools/);
});
test('ZIP extraction selects libarchive on Linux and keeps macOS and Windows tools', () => {
  assert.equal(tarPath({platform: 'linux'}), 'bsdtar');
  assert.equal(tarPath({platform: 'darwin'}), 'tar');
  assert.match(tarPath({platform: 'win32'}), /System32\\tar.exe$/);
});
test('missing Linux extractor gives package-manager advice rather than ENOENT', async () => {
  await assert.rejects(extractArchive('unused.zip', 'unused', {tar: 'bsdtar', runner: async () => {throw Object.assign(new Error('missing'), {code: 'ENOENT'});}}), /libarchive-tools.*lda run all/);
});
test('Linux extraction lists before extracting and preserves the service layout', async t => {
  const f = await fixture(t), dest = path.join(f.root, 'release'), calls = [];
  await extractArchive('fixture.zip', dest, {tar: 'bsdtar', runner: async (tool, args) => {
    calls.push({tool, args});
    if (args[0] === '-tf') return {stdout: 'src/\nsrc/server.js\n'};
    if (args[0] === '-tvf') return {stdout: 'drwxr-xr-x src/\n-rw-r--r-- src/server.js\n'};
    const tmp = args.at(-1); await mkdir(path.join(tmp, 'src')); await writeFile(path.join(tmp, 'src', 'server.js'), 'fixture');
    return {stdout: ''};
  }});
  assert.deepEqual(calls.map(c => c.args[0]), ['-tf', '-tvf', '-xf']);
  assert.ok(calls.every(c => c.tool === 'bsdtar'));
  assert.equal(await readFile(path.join(dest, 'src', 'server.js'), 'utf8'), 'fixture');
});
test('unsafe ZIPs never reach extraction on Linux', async t => {
  const f = await fixture(t); let extracted = false;
  await assert.rejects(extractArchive('fixture.zip', path.join(f.root, 'bad'), {tar: 'bsdtar', runner: async (_, args) => {
    if (args[0] === '-xf') extracted = true;
    return {stdout: args[0] === '-tf' ? '../outside\n' : '-rw-r--r-- ../outside\n'};
  }}), /Unsafe archive/);
  assert.equal(extracted, false);
});
test('foreground SIGTERM waits for both children and removes signal handlers', async () => {
  const signals = new EventEmitter(), a = child(), b = child();
  let finished = false;
  const done = superviseForeground([a, b], {signals}).then(code => {finished = true; return code;});
  signals.emit('SIGTERM'); signals.emit('SIGINT');
  assert.deepEqual(a.kills, ['SIGTERM']); assert.deepEqual(b.kills, ['SIGTERM']);
  a.emit('exit', 0); await Promise.resolve(); assert.equal(finished, false);
  b.emit('exit', 0); assert.equal(await done, 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
});
test('an early foreground failure stops its sibling and keeps the failing status', async () => {
  const a = child(), b = child(), done = superviseForeground([a, b], {signals: new EventEmitter()});
  a.emit('exit', 7); assert.deepEqual(b.kills, ['SIGTERM']); b.emit('exit', 0);
  assert.equal(await done, 7);
});
test('unexpected clean foreground exit also stops the group with failure', async () => {
  const a = child(), b = child(), done = superviseForeground([a, b], {signals: new EventEmitter()});
  a.emit('exit', 0); b.emit('exit', 0); assert.equal(await done, 1);
});
test('a failed spawn is handled and shuts down the other foreground service', async () => {
  const a = child(), b = child(), done = superviseForeground([a, b], {signals: new EventEmitter()});
  a.emit('error', new Error('synthetic spawn failure')); assert.deepEqual(b.kills, ['SIGTERM']);
  b.emit('exit', 0); await assert.rejects(done, /synthetic spawn failure/);
});
test('foreground shutdown kills a child that ignores the grace period', async () => {
  const signals = new EventEmitter(), a = child(), done = superviseForeground([a], {signals, timeout: 5});
  signals.emit('SIGINT'); await delay(20); assert.deepEqual(a.kills, ['SIGTERM', 'SIGKILL']);
  a.emit('exit', null, 'SIGKILL'); assert.equal(await done, 1);
});
test('already-exited children cannot leave a foreground job waiting forever', async () => {
  const a = Object.assign(child(), {exitCode: 3}), b = child();
  const done = superviseForeground([a, b], {signals: new EventEmitter()});
  assert.deepEqual(b.kills, ['SIGTERM']); b.emit('exit', 0); assert.equal(await done, 3);
});
test('Linux Windows-only commands never query services, download, or elevate', async t => {
  const f = await fixture(t), forbidden = () => {throw new Error('Windows work must be skipped');};
  const {engine} = fakeEngine(f, {platform: 'linux', services: {query: forbidden}, releases: {bundle: forbidden}, elevate: forbidden});
  for (const action of ['install', 'upgrade', 'rollback', 'uninstall', 'start', 'stop', 'restart', 'adopt']) {
    const r = await engine.act(action, ['graph']); assert.equal(r.ok, false); assert.match(r.log[0], /Windows only.*lda run all/);
  }
  const out = {text: '', write(s) {this.text += s;}};
  assert.equal(await main(['adopt', 'graph', '--accept-notice'], {engine, stdout: out, stderr: out, env: {}}), 1);
  assert.match(out.text, /Windows only/); assert.doesNotMatch(out.text, /\n\s+at /);
  assert.match(await tray(engine, {runner: forbidden}), /Windows only/);
  const r = await createElevator({paths: f.paths, platform: 'linux', runner: forbidden})({operations: []});
  assert.equal(r.unsupported, true); assert.match(r.log[0], /Windows only/);
  await assert.rejects(powershell('unused', {platform: 'linux', runner: forbidden}), /Windows only.*lda run all/);
});
test('CI readiness requires both services and reports which service timed out', async () => {
  let now = 0, probes = 0;
  await assert.rejects(waitForServices({timeout: 2000, now: () => now, sleep: async ms => {now += ms;}, probe: async port => {probes++; return port === 8082;}}), /127.0.0.1:8083/);
  assert.equal(now, 2000); assert.equal(probes, 6);
  let rounds = 0;
  await waitForServices({probe: async port => port === 8082 || ++rounds === 2, sleep: async () => {}});
});
