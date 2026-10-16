// lda started from PowerShell 7 (pwsh): child Windows PowerShell 5.1 processes must not inherit pwsh's
// PSModulePath, or 5.1 loads PowerShell 7 core modules and fails ("Get-Acl ... module could not be loaded").
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {powershell, childEnv, windowsPowerShellPath} from '../src/process.js';
import {createElevator} from '../src/elevate.js';
import {tray} from '../src/tray.js';
import {fixture, fakeEngine} from './helpers.js';

const pwshModulePath = 'C:\\Users\\X\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules';
const system32Join = "$exe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'";

test('powershell() runs System32 Windows PowerShell by absolute path with PSModulePath removed', async () => {
  for (const key of ['PSModulePath', 'psmodulepath', 'PSMODULEPATH']) {
    const calls = [];
    const runner = async (exe, args, opts) => {calls.push({exe, args, opts}); return {stdout: 'ok\n'};};
    const env = {SystemRoot: 'D:\\Win', Path: 'C:\\x', [key]: pwshModulePath};
    assert.equal(await powershell('Get-Acl .', {runner, platform: 'win32', env}), 'ok');
    assert.equal(calls[0].exe, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.ok(Object.keys(calls[0].opts.env).every(k => k.toLowerCase() !== 'psmodulepath'), key);
    assert.equal(calls[0].opts.env.Path, 'C:\\x');
    assert.equal(env[key], pwshModulePath, 'caller env is not mutated');
  }
  assert.equal(windowsPowerShellPath({platform: 'win32', env: {}}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(windowsPowerShellPath({platform: 'linux', env: {}}), 'powershell.exe');
  assert.deepEqual(childEnv({A: '1', PsModulePath: 'x'}), {A: '1'});
});

test('elevated start clears PSModulePath before starting System32 Windows PowerShell', async t => {
  const f = await fixture(t), scripts = [];
  const elevate = createElevator({paths: f.paths, platform: 'win32', runner: async script => {scripts.push(script); return '';}});
  await assert.rejects(elevate({version: 1, createdAt: 'x', operations: [{op: 'start', module: 'graph'}]}), /returned no result/);
  const start = scripts.find(s => s.includes('-Verb RunAs'));
  const clear = start.indexOf('Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue');
  assert.ok(clear >= 0 && clear < start.indexOf('Start-Process'), start);
  assert.ok(start.includes(system32Join));
});

test('tray start uses System32 Windows PowerShell and clears PSModulePath', async t => {
  const f = await fixture(t), {engine} = fakeEngine(f), scripts = [];
  await tray(engine, {runner: async s => scripts.push(s)});
  const start = scripts.find(s => s.includes('-STA'));
  assert.ok(start.includes(system32Join), start);
  assert.ok(start.indexOf('Remove-Item Env:PSModulePath') < start.indexOf('Start-Process -FilePath $exe'));
  assert.ok(!/Start-Process powershell/i.test(start));
});

test('tray script starts console windows with System32 Windows PowerShell and no PSModulePath', async () => {
  const source = await readFile(fileURLToPath(new URL('../tray/lda-tray.ps1', import.meta.url)), 'utf8');
  assert.ok(!/Start-Process\s+powershell/i.test(source));
  assert.ok(source.includes(system32Join));
  const clear = source.indexOf('Remove-Item Env:PSModulePath'), start = source.indexOf('Start-Process -FilePath $exe');
  assert.ok(clear >= 0 && clear < start);
  assert.ok(source.includes('$env:PSModulePath=$savedModulePath'), 'tray restores its own module path');
});

test('real Windows PowerShell loads core modules when the caller has a pwsh PSModulePath', {skip: process.platform !== 'win32'}, async () => {
  const env = {...process.env, PSModulePath: pwshModulePath};
  const out = await powershell("(Get-Acl -LiteralPath $env:SystemRoot).Owner; $PSVersionTable.PSVersion.Major; [bool]($env:PSModulePath -match 'PowerShell\\\\7')", {env});
  const [owner, major, leaked] = out.split(/\r?\n/).map(s => s.trim());
  assert.ok(owner.length > 0);
  assert.equal(major, '5');
  assert.equal(leaked, 'False');
});
