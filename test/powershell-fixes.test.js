// Review fixes in the elevated helper and tray, exercised through -DryRun, real non-elevated
// runs that stop before any service change, or single functions loaded from the AST with fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {catalog} from '../src/catalog.js';
import {fixture, winPs} from './helpers.js';
const exec = promisify(execFile), skip = process.platform !== 'win32';
const helper = fileURLToPath(new URL('../elevated/lda-service.ps1', import.meta.url)), trayScript = fileURLToPath(new URL('../tray/lda-tray.ps1', import.meta.url));
const q = s => `'${String(s).replaceAll("'", "''")}'`;
const load = (file, names) => `$ast=[Management.Automation.Language.Parser]::ParseFile(${q(file)},[ref]$null,[ref]$null); foreach($name in @(${names.map(q).join(',')})){$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true); if(!$fn){throw "missing $name"}; . ([scriptblock]::Create($fn.Extent.Text))};`;
async function ps(code) {
  const {stdout} = await winPs(['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $utf8=New-Object Text.UTF8Encoding($false); $result=@{log=@()}; ${code}`, 'utf16le').toString('base64')], {maxBuffer: 8 * 1024 * 1024});
  return JSON.parse(stdout.trim());
}
const prelude = `$adminSids=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'); $runtimeLayout=@('tenants.json','data','logs','service','backups'); $versionPattern='^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$';`;

// Trust, adopt, upgrade recovery and version tests live in hardening.test.js.
test('runtime layout check accepts empty or runtime-only folders and refuses anything else', {skip}, async t => {
  const f = await fixture(t), ok = path.join(f.root, 'ok'), bad = path.join(f.root, 'bad'); await mkdir(path.join(ok, 'data'), {recursive: true}); await writeFile(path.join(ok, 'tenants.json'), '{}'); await mkdir(bad); await writeFile(path.join(bad, 'thesis.docx'), 'x');
  const out = await ps(`${prelude} ${load(helper, ['Assert-RuntimeLayout'])} Assert-RuntimeLayout ${q(ok)}; Assert-RuntimeLayout ${q(path.join(f.root, 'missing'))}; $e=''; try{Assert-RuntimeLayout ${q(bad)}}catch{$e=$_.Exception.Message}; @{e=$e} | ConvertTo-Json -Compress`);
  assert.match(out.e, /thesis\.docx, which is not part of a runtime folder/);
});

async function plansSetup(t) {
  const f = await fixture(t), plans = path.join(f.root, 'Coding Koala', 'Local Developer Accelerator', 'plans'); await mkdir(plans, {recursive: true});
  const plan = path.join(plans, 'p.plan.json'), resultFile = path.join(plans, 'p.result.json'); await writeFile(plan, JSON.stringify({version: 1, createdAt: 'x', operations: [{op: 'start', module: 'graph'}]}));
  // A wrong plan hash stops the helper before validation or any service step, even when elevated.
  const run = () => winPs(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-PlanFile', plan, '-PlanSha256', '0'.repeat(64), '-ResultFile', resultFile], {env: {...process.env, LOCALAPPDATA: f.root}}).catch(e => e);
  return {plans, resultFile, run};
}
test('result file is created exclusively and written through the verified handle', {skip}, async t => {
  const {resultFile, run} = await plansSetup(t); const r = await run();
  assert.match(r.stdout, /ERROR: Plan SHA-256 mismatch/);
  const written = JSON.parse((await readFile(resultFile, 'utf8')).replace(/^\uFEFF/, '')); assert.equal(written.ok, false); assert.ok(written.log.some(l => /Plan SHA-256 mismatch/.test(l)));
});
test('a pre-existing (planted) result file is never overwritten', {skip}, async t => {
  const {resultFile, run} = await plansSetup(t); await writeFile(resultFile, 'planted'); const r = await run();
  assert.match(r.stdout, /ERROR: .*exists/); assert.equal(await readFile(resultFile, 'utf8'), 'planted');
  const source = await readFile(helper, 'utf8'); assert.ok(source.includes('[IO.FileMode]::CreateNew')); assert.ok(source.includes('GetFinalPathNameByHandle')); assert.ok(!source.includes('WriteAllText($ResultFile'));
});

// ---- tray ----
test('tray catalogue keys match src/catalog.js and no variable shadows $args', async () => {
  const source = await readFile(trayScript, 'utf8');
  assert.equal(source.match(/\$script:CatalogKeys=@\(([^)]*)\)/)[1], catalog.map(m => `'${m.key}'`).join(','));
  assert.ok(!/\$args\s*=/i.test(source)); assert.ok(!source.includes('Invoke-RestMethod'), 'health polling is asynchronous');
  assert.ok(source.includes('GetStringAsync'));
});
test('tray health accepts a missing product (legacy) and rejects another product', {skip}, async () => {
  const out = await ps(`${load(trayScript, ['Get-HealthState'])} @{legacy=(Get-HealthState '{"status":"ok"}' 'graph'); match=(Get-HealthState '{"product":"graph"}' 'graph'); other=(Get-HealthState '{"product":"assets"}' 'graph'); bad=(Get-HealthState 'not json' 'graph')} | ConvertTo-Json -Compress`);
  assert.deepEqual(out, {legacy: {ok: true, legacy: true}, match: {ok: true, legacy: false}, other: {ok: false, legacy: false}, bad: {ok: false, legacy: false}});
});
test('tray validates module keys and CLI paths and quotes every argument', {skip}, async t => {
  const f = await fixture(t), cli = path.join(f.root, 'pkg', 'bin', 'lda.js'); await mkdir(path.dirname(cli), {recursive: true}); await writeFile(cli, '');
  const out = await ps(`${load(trayScript, ['Test-ModuleKey', 'Get-CliPaths', 'Format-ProcessArgument', 'Invoke-Cli'])} $script:CatalogKeys=@('graph','assets');
    $starts=New-Object Collections.Generic.List[object]; function Start-Process{param($FilePath,$ArgumentList,$WindowStyle) $starts.Add(@{file=$FilePath; args=@($ArgumentList)})}
    $script:config=[pscustomobject]@{cli=${q(cli)}; node=${q(process.execPath)}}
    Invoke-Cli @('start','graph'); Invoke-Cli @('logs','graph','-f') -Console
    $decoded=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($starts[1].args[-1]))
    $inject=''; try{Invoke-Cli @('start','graph"&calc')}catch{$inject=$_.Exception.Message}
    $script:config=[pscustomobject]@{cli='C:\\evil\\payload.js'; node=${q(process.execPath)}}; $badCli=''; try{Invoke-Cli @('start','graph')}catch{$badCli=$_.Exception.Message}
    @{keys=@((Test-ModuleKey 'graph'),(Test-ModuleKey 'Graph'),(Test-ModuleKey 'graph;calc'),(Test-ModuleKey 'flags')); hidden=$starts[0]; decoded=$decoded; inject=$inject; badCli=$badCli; count=$starts.Count} | ConvertTo-Json -Compress -Depth 4`);
  assert.deepEqual(out.keys, [true, false, false, false]);
  assert.deepEqual(out.hidden.args, [`"${cli}"`, '"start"', '"graph"']); assert.equal(out.hidden.file, process.execPath);
  assert.equal(out.decoded, `& '${process.execPath}' '${cli}' 'logs' 'graph' '-f'`);
  assert.match(out.inject, /Unsafe CLI argument/); assert.match(out.badCli, /bin\\lda\.js/); assert.equal(out.count, 2);
});
