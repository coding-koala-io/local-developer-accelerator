import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {fixture, winPs} from './helpers.js';

const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../elevated/lda-service.ps1', import.meta.url));
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const quote = value => "'" + value.replaceAll("'", "''") + "'";

async function buildRelease(f, version) {
  const source = path.join(f.root, 'release', version);
  await mkdir(path.join(source, 'src'), {recursive: true});
  await mkdir(path.join(source, 'scripts'));
  await copyFile(new URL('./fixtures/find-service-xml.js', import.meta.url),
    path.join(source, 'scripts', 'service-xml.js'));
  await writeFile(path.join(source, 'src', 'server.js'), "throw new Error('The fixture uses simulated service startup');\n");
  await writeFile(path.join(source, 'package.json'), JSON.stringify({name: 'lda-find', type: 'module', version}));
  const zip = path.join(f.paths.cache, `lda-find-${version}.zip`);
  await exec(tar, ['-a', '-c', '-f', zip, '-C', source, '.']);
  return {version, zip, sha256: createHash('sha256').update(await readFile(zip)).digest('hex')};
}

test('Windows helper runs the Local Find init/XML contract through install, reinstall, switching and removal',
  {skip: process.platform !== 'win32'}, async t => {
    const f = await fixture(t);
    const base = await realpath(f.root);
    const [first, next, unhealthy] = await Promise.all(['1.0.0', '1.1.0', '1.2.0'].map(version => buildRelease(f, version)));
    const programFiles = path.join(base, 'Program Files');
    await mkdir(programFiles);
    const runtime = path.join(base, 'Find & data');
    const data = path.join(runtime, 'data');
    const payload = 'synthetic retained content';
    const port = 9088;
    const wrapper = 'synthetic wrapper';
    const wrapperHash = createHash('sha256').update(wrapper).digest('hex');
    const install = {op: 'install', module: 'find', ...first, runtimeRoot: runtime, port};
    const upgrade = release => ({op: 'upgrade', module: 'find', ...release});
    const uninstall = purge => ({op: 'uninstall', module: 'find', purge});
    const op = operation => `(${quote(JSON.stringify(operation))} | ConvertFrom-Json)`;
    const driver = path.join(base, 'find-lifecycle.ps1');
    // As in the Graph lifecycle tests, load helper functions from their AST without running the
    // elevation entry point. Keep real ZIP handling, init/XML, runtime marker, switching and removal.
    await writeFile(driver, '\uFEFF' + String.raw`
$env:LOCALAPPDATA = ${quote(base)}
$env:ProgramFiles = ${quote(programFiles)}
$ast = [Management.Automation.Language.Parser]::ParseFile(${quote(helper)},[ref]$null,[ref]$null)
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {break}
    if ($statement.Extent.Text.StartsWith('$repoRoot =')) {continue}
    . ([scriptblock]::Create($statement.Extent.Text))
}
$repoRoot = ${quote(path.dirname(path.dirname(helper)))}
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}
$node = ${quote(process.execPath)}
$runtime = ${quote(runtime)}
$serviceXml = Join-Path $runtime 'service\LdaFind.xml'
$data = Join-Path $runtime 'data'
$payload = Join-Path $data 'content.json'
$versions = Get-VersionsFile 'find'
$candidate = Join-Path (Split-Path $versions -Parent) ${quote(unhealthy.version)}
$scExe = 'Invoke-TestSc'
$wrapperSha256 = ${quote(wrapperHash)}
$script:row = $null
$events = New-Object Collections.Generic.List[string]

# Simulate privileged boundaries and health. Every real filesystem target is disposable.
function Assert-SafeItem($Path,[switch]$AllowLocalService,[switch]$AdminOwner,[switch]$OwnerOnly) {}
function Assert-CodeTree($Path) {}
function Assert-Port($Ctx) {}
function Set-RestrictedDirectoryAcl($Path,[switch]$Service,[switch]$Code) {}
function Set-RuntimePermissions($Ctx) {}
function New-SecureDirectory($Path,$Kind) { [IO.Directory]::CreateDirectory($Path) | Out-Null }
function New-AdminFileSecurity {
    $security = New-Object Security.AccessControl.FileSecurity
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
    return $security
}
function Get-NodePath { return $node }
function Assert-TrustedExecutable($Path) { if ($Path -ne $node) {throw 'Unexpected executable'} }
function Invoke-WebRequest([switch]$UseBasicParsing,$Uri,$OutFile) {
    [IO.File]::WriteAllText($OutFile,${quote(wrapper)},$utf8)
}
function Invoke-TestSc { $global:LASTEXITCODE = 0 }
function Get-ServiceRow($Id) { if ($Id -eq 'LdaFind') {return $script:row} }
function Stop-Module($Ctx) {
    if (!$script:row) {throw 'Cannot stop an unregistered service'}
    $events.Add('stop')
    $script:row.State = 'Stopped'
}
function Invoke-Wrapper($Ctx,$Action) {
    if ($Ctx.Id -ne 'LdaFind') {throw 'Unexpected service id'}
    $events.Add($Action)
    switch ($Action) {
        'install' {
            if ($script:row) {throw 'Service already registered'}
            $script:row = [pscustomobject]@{PathName=('"'+$Ctx.Wrapper+'"'); State='Stopped'}
        }
        'start' {
            if (!$script:row) {throw 'Cannot start an unregistered service'}
            $script:row.State = 'Running'
        }
        'uninstall' {
            if ($script:row.State -ne 'Stopped') {throw 'Cannot uninstall a running service'}
            $script:row = $null
        }
        default {throw "Unexpected wrapper action $Action"}
    }
}
function Wait-Healthy($Ctx,$Version) {
    [xml]$config = [IO.File]::ReadAllText($Ctx.Xml)
    $active = Split-Path $config.service.workingdirectory -Leaf
    if ($script:row.State -ne 'Running' -or $active -ne $Version) {throw "Unexpected running version $active"}
    $events.Add("health:$Version")
    if ($Version -eq ${quote(unhealthy.version)}) {throw 'synthetic unhealthy release'}
}
function Read-Install {
    $raw = [IO.File]::ReadAllText($serviceXml)
    [xml]$config = $raw
    $vars = @{}
    $content = $null
    if (Test-Path -LiteralPath $payload) {$content = [IO.File]::ReadAllText($payload)}
    foreach ($entry in $config.service.env) {$vars[$entry.name] = $entry.value}
    @{
        raw=$raw; id=$config.service.id; description=$config.service.description
        exe=$config.service.executable; args=$config.service.arguments
        code=$config.service.workingdirectory; logs=$config.service.logpath
        account=($config.service.serviceaccount.domain+'\'+$config.service.serviceaccount.user)
        env=$vars; versions=([IO.File]::ReadAllText($versions) | ConvertFrom-Json)
        init=@([IO.File]::ReadAllLines((Join-Path $data 'init.log'))).Count
        hasTenants=(Test-Path -LiteralPath (Join-Path $runtime 'tenants.json'))
        content=$content
    }
}

Invoke-Operation ${op(install)}
$fresh = Read-Install
[IO.File]::WriteAllText($payload,${quote(payload)},$utf8)
Invoke-Operation ${op(uninstall(false))}
$retained = @{
    registered=($null -ne $script:row)
    content=[IO.File]::ReadAllText($payload)
    codeExists=(Test-Path -LiteralPath (Split-Path $versions -Parent))
}
Invoke-Operation ${op(install)}
$reinstalled = Read-Install
Invoke-Operation ${op(upgrade(next))}
$upgraded = Read-Install
Invoke-Operation ${op({op: 'rollback', module: 'find'})}
$rolledBack = Read-Install
$events.Clear()
$failure = ''
try {Invoke-Operation ${op(upgrade(unhealthy))}} catch {$failure=$_.Exception.Message}
$recovered = Read-Install
$recoveryEvents = @($events.ToArray())
$candidateExists = Test-Path -LiteralPath $candidate
Invoke-Operation ${op(uninstall(true))}
@{
    fresh=$fresh; retained=$retained; reinstalled=$reinstalled; upgraded=$upgraded
    rolledBack=$rolledBack; recovered=$recovered; failure=$failure
    recoveryEvents=$recoveryEvents; candidateExists=$candidateExists
    purged=(!(Test-Path -LiteralPath $runtime) -and !(Test-Path -LiteralPath (Split-Path $versions -Parent)))
    registered=($null -ne $script:row)
} | ConvertTo-Json -Compress -Depth 6
`, 'utf8');

    const {stdout} = await winPs(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
      {timeout: 60_000});
    const out = JSON.parse(stdout.trim());
    for (const [stage, version, previous, init] of [
      ['fresh', first.version, null, 1],
      ['reinstalled', first.version, null, 2],
      ['upgraded', next.version, first.version, 2],
      ['rolledBack', first.version, next.version, 2],
      ['recovered', first.version, next.version, 2],
    ]) {
      const state = out[stage];
      const code = path.join(programFiles, 'Coding Koala', 'Local Developer Accelerator', 'Find', version);
      assert.equal(state.id, 'LdaFind', stage);
      assert.equal(state.code, code, stage);
      assert.equal(state.exe, process.execPath, stage);
      assert.equal(state.args, '"' + path.join(code, 'src', 'server.js') + '"', stage);
      assert.equal(state.account, 'NT AUTHORITY\\LocalService', stage);
      assert.equal(state.logs, path.join(runtime, 'service', 'logs'), stage);
      assert.deepEqual(state.env, {PORT: String(port), HOST: '127.0.0.1', DATA_ROOT: data, DATA_DIR: data}, stage);
      assert.equal(state.versions.current, version, stage);
      assert.equal(state.versions.previous, previous, stage);
      assert.equal(state.init, init, stage);
      assert.equal(state.hasTenants, false, stage);
      assert.equal(state.content, stage === 'fresh' ? null : payload, stage);
    }
    assert.match(out.fresh.description, /Made for CMS 12 sites that use Search & Navigation\./);
    assert.match(out.fresh.description, /Not affiliated with or endorsed by Optimizely\./);
    assert.deepEqual(out.retained, {registered: false, content: payload, codeExists: false});
    assert.match(out.failure, /synthetic unhealthy release.*previous XML restored.*1\.0\.0 is running and healthy/);
    assert.equal(out.recovered.raw, out.rolledBack.raw);
    assert.deepEqual(out.recoveryEvents, ['stop', 'start', 'health:1.2.0', 'stop', 'start', 'health:1.0.0']);
    assert.equal(out.candidateExists, false);
    assert.equal(out.purged, true);
    assert.equal(out.registered, false);
  });
