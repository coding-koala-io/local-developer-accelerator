// Security re-review hardening of the elevated helper. Every test runs either a single helper function loaded
// from the AST with fakes, or the real helper with -DryRun. Nothing elevates, changes a service or uses the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile, mkdir, readdir, rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fixture, fakeEngine, installed, winPs} from './helpers.js';
import {catalog} from '../src/catalog.js';
import {buildPlan} from '../src/plan.js';
import {createElevator} from '../src/elevate.js';
import {assertRuntimeLayout, runtimesOverlap} from '../src/paths.js';
const exec = promisify(execFile), skip = process.platform !== 'win32';
const helper = fileURLToPath(new URL('../elevated/lda-service.ps1', import.meta.url));
const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
const q = s => `'${String(s).replaceAll("'", "''")}'`;
const load = names => `$ast=[Management.Automation.Language.Parser]::ParseFile(${q(helper)},[ref]$null,[ref]$null); foreach($name in @(${names.map(q).join(',')})){$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true); if(!$fn){throw "missing $name"}; . ([scriptblock]::Create($fn.Extent.Text))};`;
// The helper's own constants, so tests cannot drift from the script.
const constants = async () => (await readFile(helper, 'utf8')).split(/\r?\n/).filter(l => /^\$(trustedInstallerSid|adminSids|creatorOwnerSid|localServiceSid|writeMask|markerName|markerTempPattern|runtimeLayout|versionPattern) = /.test(l)).join('; ');
// Temp folders are owned by and writable for the test user; treating that user as trusted lets the real checks
// run against real ACLs, while the principals under test (Users, LocalService, ...) stay untrusted.
const trustMe = `$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $adminSids+=$me;`;
// Folders created through the real DACL builders keep the test user able to clean them up.
const keepAccess = `Set-Item function:Real-RestrictedSecurity (Get-Item function:New-RestrictedSecurity).ScriptBlock; function New-RestrictedSecurity([string]$Kind){ $a=Real-RestrictedSecurity $Kind; $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($me)),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); $a }`;
async function ps(code) {
  const {stdout} = await winPs(['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $utf8=New-Object Text.UTF8Encoding($false); $result=@{log=@()}; ${await constants()}; ${code}`, 'utf16le').toString('base64')], {maxBuffer: 8 * 1024 * 1024});
  return JSON.parse(stdout.trim());
}
const err = (expr, name) => `$${name}=''; try{${expr}}catch{$${name}=$_.Exception.Message};`;
const grant = (target, ace) => exec(icacls, [target, '/grant', ace]);
// %TEMP% may carry extra writable ACEs (for example a sandbox group); fixtures get an exact, protected DACL.
async function protect(dir) {
  const me = (await exec(path.join(path.dirname(icacls), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'])).stdout.trim().split(',').pop().replaceAll('"', '');
  await exec(icacls, [dir, '/inheritance:r', '/grant:r', `*${me}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
}
// A file created by an elevated administrator (as on hosted CI runners) is owned by Administrators, not the
// user: set the current user as owner explicitly so "owned by a non-admin" fixtures mean the same everywhere.
// The helper canonicalises paths with [IO.Path]::GetFullPath, which expands 8.3 short names (a hosted runner's
// TEMP is C:\Users\RUNNER~1\...): compare helper output with the long form of an existing fixture path.
const longPath = p => realpathSync.native(p);
async function ownByMe(file) {
  const me = (await exec(path.join(path.dirname(icacls), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'])).stdout.trim().split(',').pop().replaceAll('"', '');
  await exec(icacls, [file, '/setowner', `*${me}`]);
}
// Folders above the fixture are treated like system parents (owner checked only).
const fixtureParents = root => `function Get-SystemParentFolders { @(Get-RuntimeAncestors ${q(root)}) };`;

// ---- fix 1: write-rights validation ----
test('write-rights check: only SYSTEM, Administrators, TrustedInstaller, inherit-only CREATOR OWNER and allowed LocalService may write', {skip}, async () => {
  const out = await ps(`${load(['Find-UntrustedWriter'])}
    function Sec($rules){ $a=New-Object Security.AccessControl.DirectorySecurity; foreach($r in $rules){ $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($r[0])),[Security.AccessControl.FileSystemRights]$r[1],[Security.AccessControl.InheritanceFlags]$r[2],[Security.AccessControl.PropagationFlags]$r[3],[Security.AccessControl.AccessControlType]$r[4]))) }; $a }
    $admins=@(@('S-1-5-18','FullControl','None','None','Allow'),@('S-1-5-32-544','FullControl','None','None','Allow'),@($trustedInstallerSid,'FullControl','None','None','Allow'),@('S-1-5-32-545','ReadAndExecute','None','None','Allow'))
    $rights=@{}; foreach($r in 'WriteData','AppendData','WriteExtendedAttributes','DeleteSubdirectoriesAndFiles','WriteAttributes','Delete','ChangePermissions','TakeOwnership'){ $rights[$r]=Find-UntrustedWriter (Sec ($admins+,@('S-1-5-32-545',$r,'None','None','Allow'))) }
    $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    @{trusted=(Find-UntrustedWriter (Sec $admins)); rights=$rights;
      deny=(Find-UntrustedWriter (Sec ($admins+,@('S-1-5-32-545','Modify','None','None','Deny'))));
      creatorInherit=(Find-UntrustedWriter (Sec ($admins+,@('S-1-3-0','FullControl','ContainerInherit,ObjectInherit','InheritOnly','Allow'))));
      creatorEffective=(Find-UntrustedWriter (Sec ($admins+,@('S-1-3-0','FullControl','None','None','Allow'))));
      usersInheritOnly=(Find-UntrustedWriter (Sec ($admins+,@('S-1-5-32-545','Modify','ContainerInherit','InheritOnly','Allow'))));
      localService=(Find-UntrustedWriter (Sec ($admins+,@('S-1-5-19','Modify','None','None','Allow'))));
      localServiceAllowed=(Find-UntrustedWriter (Sec ($admins+,@('S-1-5-19','Modify','None','None','Allow'))) -AllowLocalService);
      currentUser=((Find-UntrustedWriter (Sec ($admins+,@($me,'Modify','None','None','Allow')))) -eq $me)} | ConvertTo-Json -Compress`);
  assert.equal(out.trusted, null); assert.equal(out.deny, null); assert.equal(out.creatorInherit, null); assert.equal(out.localServiceAllowed, null);
  for (const [right, sid] of Object.entries(out.rights)) assert.equal(sid, 'S-1-5-32-545', right);
  assert.equal(out.creatorEffective, 'S-1-3-0'); assert.equal(out.usersInheritOnly, 'S-1-5-32-545'); assert.equal(out.localService, 'S-1-5-19'); assert.equal(out.currentUser, true);
});

test('runtime tree: LocalService may modify runtime data but not ancestors or service\\; generic write, junctions and writable wrappers refused', {skip}, async t => {
  const f = await fixture(t), anc = path.join(f.root, 'anc'), rt = path.join(anc, 'rt'), svc = path.join(rt, 'service');
  await protect(f.root); for (const d of [path.join(svc, 'logs'), path.join(rt, 'data'), path.join(rt, 'logs'), path.join(f.root, 'target'), path.join(f.root, 'gw')]) await mkdir(d, {recursive: true});
  await writeFile(path.join(svc, 'LdaGraph.exe'), 'x'); await protect(svc); // like a real install: service\ does not inherit from the root
  for (const p of [rt,path.join(svc, 'logs'), path.join(rt, 'data')]) await grant(p, '*S-1-5-19:(OI)(CI)M');
  const tree = `Assert-RuntimeTree ${q(rt)} 'LdaGraph'`;
  const out = await ps(`${trustMe} ${load(['Full', 'Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'Get-SystemParentFolders', 'Get-RuntimeAncestors', 'Assert-RuntimeChain', 'Assert-RuntimeTree'])} ${fixtureParents(f.root)}
    ${err(tree, 'ok')}
    & ${q(icacls)} ${q(svc)} /grant '*S-1-5-19:(OI)(CI)M' | Out-Null; ${err(tree, 'service')}; & ${q(icacls)} ${q(svc)} /remove:g '*S-1-5-19' | Out-Null
    & ${q(icacls)} ${q(path.join(svc, 'LdaGraph.exe'))} /grant '*S-1-5-32-545:M' | Out-Null; ${err(tree, 'wrapper')}; & ${q(icacls)} ${q(path.join(svc, 'LdaGraph.exe'))} /remove:g '*S-1-5-32-545' | Out-Null
    & ${q(icacls)} ${q(anc)} /grant '*S-1-5-19:M' | Out-Null; ${err(tree, 'ancestor')}; & ${q(icacls)} ${q(anc)} /remove:g '*S-1-5-19' | Out-Null
    & ${q(icacls)} ${q(path.join(f.root, 'gw'))} /grant '*S-1-5-32-545:(GW)' | Out-Null; ${err(`Assert-SafeItem ${q(path.join(f.root, 'gw'))}`, 'generic')}
    New-Item -ItemType Junction -Path ${q(path.join(f.root, 'link'))} -Target ${q(path.join(f.root, 'target'))} | Out-Null; ${err(`Assert-RuntimeChain ${q(path.join(f.root, 'link', 'Graph'))}`, 'junction')}
    @{ok=$ok; service=$service; wrapper=$wrapper; ancestor=$ancestor; generic=$generic; junction=$junction} | ConvertTo-Json -Compress`);
  assert.equal(out.ok, '', 'LocalService Modify on the runtime root, data and service\\logs is accepted');
  assert.match(out.service, /Refusing to use .*\\service: .*LOCAL SERVICE can modify it/);
  assert.match(out.wrapper, /LdaGraph\.exe: .*Users can modify it/);
  assert.match(out.ancestor, /Refusing to use .*\\anc: .*LOCAL SERVICE can modify it/);
  assert.match(out.generic, /gw: .*Users can modify it/); assert.match(out.junction, /junction or symbolic link/);
});

// ---- fix 2: directory creation ----
test('missing runtime folders are created top-down with a protected DACL and validated; a writable existing ancestor stops creation', {skip}, async t => {
  const f = await fixture(t), root = path.join(f.root, 'new', 'Coding Koala', 'Local Developer Accelerator', 'Graph'), open = path.join(f.root, 'open');
  await protect(f.root); await mkdir(open); await grant(open, '*S-1-5-32-545:(OI)(CI)M');
  const out = await ps(`${trustMe} ${load(['Full', 'Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'Get-SystemParentFolders', 'Get-RuntimeAncestors', 'Assert-RuntimeChain', 'New-RestrictedSecurity', 'New-SecureDirectory', 'New-RuntimeRoot', 'New-RuntimeFolders'])}
    ${fixtureParents(f.root)} ${keepAccess}
    $acls=New-Object Collections.Generic.List[string]; function Set-RestrictedDirectoryAcl($Path,[switch]$Service){$acls.Add("$(Split-Path $Path -Leaf)|$Service")}
    New-RuntimeRoot ${q(root)}; New-RuntimeFolders @{Root=${q(root)}}
    function Describe($p){ $a=Get-Acl -LiteralPath $p; $rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { "$($_.IdentityReference.Value)=$($_.FileSystemRights)" }); @{protected=$a.AreAccessRulesProtected; inherited=@($a.GetAccessRules($false,$true,[Security.Principal.SecurityIdentifier])).Count; rules=$rules} }
    ${err(`New-RuntimeRoot ${q(path.join(open, 'Graph'))}`, 'refused')}
    @{acls=@($acls); ancestor=(Describe ${q(path.dirname(root))}); root=(Describe ${q(root)}); service=(Describe ${q(path.join(root, 'service'))}); logs=(Describe ${q(path.join(root, 'service', 'logs'))}); refused=$refused; created=(Test-Path ${q(path.join(open, 'Graph'))})} | ConvertTo-Json -Compress -Depth 4`);
  assert.deepEqual(out.acls, ['new|True', 'Coding Koala|True', 'Local Developer Accelerator|True', 'Graph|False']);
  for (const key of ['ancestor', 'root', 'service', 'logs']) {assert.equal(out[key].protected, true, key); assert.equal(out[key].inherited, 0, key);}
  assert.ok(out.root.rules.some(r => /^S-1-5-19=Modify/.test(r))); assert.ok(out.logs.rules.some(r => /^S-1-5-19=Modify/.test(r)));
  assert.ok(out.ancestor.rules.some(r => /^S-1-5-19=ReadAndExecute/.test(r))); assert.ok(out.service.rules.some(r => /^S-1-5-32-545=ReadAndExecute/.test(r)));
  assert.match(out.refused, /open: .*Users can modify it/); assert.equal(out.created, false);
  const source = await readFile(helper, 'utf8');
  assert.ok(source.includes('[IO.Directory]::CreateDirectory($Path, (New-RestrictedSecurity $Kind))'));
  assert.ok(!/New-Item -ItemType Directory/.test(source), 'no directory is created with inherited permissions');
});

test('Program Files code chain is created with the code DACL and refuses escapes, junctions, user write and LocalService write', {skip}, async t => {
  const f = await fixture(t), pf = path.join(f.root, 'pf'), base = path.join(pf, 'Coding Koala', 'Local Developer Accelerator'); await protect(f.root); await mkdir(pf); await mkdir(path.join(f.root, 'elsewhere'));
  const out = await ps(`${trustMe} ${load(['Full', 'Is-Within', 'Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'New-RestrictedSecurity', 'New-SecureDirectory', 'Get-CodeChain', 'Assert-CodeChain', 'New-CodeFolder'])}
    ${keepAccess}
    $env:ProgramFiles=${q(pf)}; $codes=New-Object Collections.Generic.List[string]; function Set-RestrictedDirectoryAcl($Path,[switch]$Code){ if(!$Code){throw 'code ACL expected'}; $codes.Add((Split-Path $Path -Leaf)) }
    New-CodeFolder ${q(path.join(base, 'Graph'))}
    ${err(`Get-CodeChain ${q(path.join(f.root, 'elsewhere'))} | Out-Null`, 'escape')}
    New-Item -ItemType Junction -Path ${q(path.join(base, 'Assets'))} -Target ${q(path.join(f.root, 'elsewhere'))} | Out-Null; ${err(`Assert-CodeChain ${q(path.join(base, 'Assets', '1.0.0'))}`, 'junction')}
    New-Item -ItemType Directory ${q(path.join(base, 'Graph', '1.0.0'))} | Out-Null; & ${q(icacls)} ${q(path.join(base, 'Graph', '1.0.0'))} /grant '*S-1-5-19:(OI)(CI)M' | Out-Null; ${err(`Assert-CodeChain ${q(path.join(base, 'Graph', '1.0.0'))}`, 'localService')}
    & ${q(icacls)} ${q(path.join(base, 'Graph'))} /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null; ${err(`Assert-CodeChain ${q(path.join(base, 'Graph', '2.0.0'))}`, 'writable')}
    @{codes=@($codes); escape=$escape; junction=$junction; localService=$localService; writable=$writable} | ConvertTo-Json -Compress`);
  assert.deepEqual(out.codes, ['Coding Koala', 'Local Developer Accelerator', 'Graph']);
  assert.match(out.escape, /escaped Program Files/); assert.match(out.junction, /junction or symbolic link/);
  assert.match(out.localService, /1\.0\.0: .*LOCAL SERVICE can modify it/); assert.match(out.writable, /Graph: .*Users can modify it/);
});

// ---- fix 3: node chain and absolute tools ----
test('node.exe: the file and every ancestor up to the volume root must be admin-owned and admin-only writable', {skip}, async t => {
  const f = await fixture(t), file = path.join(f.root, 'nodejs', 'node.exe'); await mkdir(path.dirname(file)); await writeFile(file, 'x'); await ownByMe(file);
  const fns = load(['Full', 'Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'Assert-TrustedExecutable']);
  const node = /^[A-Za-z]:\\Program Files\\/i.test(process.execPath) ? process.execPath : '';
  const out = await ps(`${fns} Assert-TrustedExecutable (Join-Path ([Environment]::SystemDirectory) 'tar.exe'); if(${q(node)}){Assert-TrustedExecutable ${q(node)}}
    ${err(`Assert-TrustedExecutable ${q(file)}`, 'owner')}
    $seen=New-Object Collections.Generic.List[string]; function Assert-SafeItem($Path,[switch]$AdminOwner){ $seen.Add("$Path|$AdminOwner"); if($Path -like '*\\nodejs'){throw "Refusing to use $($Path): BUILTIN\\Users can modify it."} }
    ${err(`Assert-TrustedExecutable 'C:\\Program Files\\nodejs\\node.exe'`, 'ancestor')}
    @{owner=$owner; ancestor=$ancestor; seen=@($seen)} | ConvertTo-Json -Compress`);
  assert.match(out.owner, /Refusing to use .*node\.exe: it is owned by/);
  assert.match(out.ancestor, /nodejs: BUILTIN\\Users can modify it/);
  assert.deepEqual(out.seen, ['C:\\Program Files\\nodejs\\node.exe|True', 'C:\\Program Files\\nodejs|True'],'file first, then each folder, all requiring an admin owner');
  const walk = await ps(`${fns} $seen=New-Object Collections.Generic.List[string]; function Assert-SafeItem($Path,[switch]$AdminOwner){ $seen.Add($Path) }; Assert-TrustedExecutable ${q(file)}; @{seen=@($seen)} | ConvertTo-Json -Compress`);
  const longFile = longPath(file);
  assert.equal(walk.seen[0], longFile); assert.equal(walk.seen.at(-1), longFile.split('\\').slice(0, 2).join('\\'), 'walks to the top folder; the volume root is excluded');
  assert.equal(walk.seen.length, longFile.split('\\').length - 1);
  const source = await readFile(helper, 'utf8');
  assert.equal((source.match(/Get-Command node/g) || []).length, 1, 'node is resolved in one place'); assert.ok(source.includes('$nodePath=Get-NodePath'));
  assert.ok(source.includes('$system32 = [Environment]::SystemDirectory'));
  for (const tool of ['tar', 'icacls', 'sc']) assert.ok(source.includes(`$${tool}Exe = Join-Path $system32 '${tool}.exe'`), tool);
  assert.ok(!/&\s+(tar|icacls|sc)(\.exe)?\s/i.test(source), 'no external tool is resolved from PATH');
  assert.ok(source.includes('& $icaclsExe') && source.includes('& $scExe config'));
});

test('elevation starts the System32 Windows PowerShell by absolute path', async t => {
  const f = await fixture(t), scripts = [];
  const elevate = createElevator({paths: f.paths, platform: 'win32', runner: async script => {scripts.push(script); return '';}});
  await assert.rejects(elevate({version: 1, createdAt: 'x', operations: [{op: 'start', module: 'graph'}]}), /returned no result/);
  const start = scripts.find(s => s.includes('-Verb RunAs'));
  assert.ok(start.includes("$exe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'"), start);
  assert.ok(start.includes('Start-Process -FilePath $exe -Verb RunAs')); assert.ok(!/Start-Process powershell/.test(start));
});

// ---- fix 4: runtime identity and overlap ----
test('runtime marker: written admin-only, reuse needs a matching marker, markerless data only for legacy adopt', {skip}, async t => {
  const f = await fixture(t), rt = path.join(f.root, 'rt'), legacy = path.join(f.root, 'legacy'), empty = path.join(f.root, 'empty');
  await protect(f.root); await mkdir(rt); await mkdir(legacy); await writeFile(path.join(legacy, 'tenants.json'), '{}'); await mkdir(empty);
  const out = await ps(`${trustMe} ${load(['Full', 'Get-Field', 'Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'New-AdminFileSecurity', 'Get-RuntimeMarker', 'Get-MarkerTemps', 'Read-MarkerFile', 'Resolve-RuntimeMarker', 'Assert-RuntimeIdentity', 'Write-RuntimeMarker'])}
    $real=New-AdminFileSecurity; $realRules=@($real.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { "$($_.IdentityReference.Value)=$($_.FileSystemRights)" })
    Set-Item function:New-AdminFileSecurity { $s=New-Object Security.AccessControl.FileSecurity; $s.SetAccessRuleProtection($true,$false); foreach($sid in @('S-1-5-18','S-1-5-32-544',$me)){ $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','Allow'))) }; $s }
    Assert-RuntimeIdentity ${q(empty)} 'graph' 'LdaGraph'; Write-RuntimeMarker ${q(rt)} 'graph' 'LdaGraph'; Assert-RuntimeIdentity ${q(rt)} 'graph' 'LdaGraph'
    ${err(`Assert-RuntimeIdentity ${q(rt)} 'assets' 'LdaAssets'`, 'other')} ${err(`Assert-RuntimeIdentity ${q(legacy)} 'graph' 'LdaGraph'`, 'markerless')}
    Assert-RuntimeIdentity ${q(legacy)} 'graph' 'LdaGraph' -LegacyAdopt
    $acl=Get-Acl -LiteralPath (Join-Path ${q(rt)} $markerName)
    @{realProtected=$real.AreAccessRulesProtected; realRules=$realRules; fileProtected=$acl.AreAccessRulesProtected; other=$other; markerless=$markerless} | ConvertTo-Json -Compress`);
  assert.equal(out.realProtected, true); assert.deepEqual(out.realRules.sort(), ['S-1-5-18=FullControl', 'S-1-5-32-544=FullControl']); assert.equal(out.fileProtected, true);
  assert.match(out.other, /runtime folder of graph \(LdaGraph\), not assets \(LdaAssets\)/); assert.match(out.markerless, /without an LDA runtime marker\. Use lda adopt/);
  const marker = JSON.parse(await readFile(path.join(rt, '.lda-runtime.json'), 'utf8'));
  assert.equal(marker.module, 'graph'); assert.equal(marker.serviceId, 'LdaGraph'); assert.equal(marker.canonicalPath.toLowerCase(), longPath(rt).toLowerCase()); assert.ok(Date.parse(marker.createdAt));
});

test('purge requires a runtime marker matching the module and canonical path', {skip}, async t => {
  const f = await fixture(t), rt = path.join(f.root, 'rt'); await protect(f.root); await mkdir(path.join(rt, 'service'), {recursive: true});
  await writeFile(path.join(rt, 'service', 'LdaGraph.xml'), '<service><id>LdaGraph</id></service>');
  const marker = body => writeFile(path.join(rt, '.lda-runtime.json'), JSON.stringify(body));
  const run = () => ps(`${trustMe} ${load(['Full', 'Get-Field', 'Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'Get-RuntimeMarker', 'Assert-NoReparse', 'Assert-SafeRemoval'])} function Assert-Runtime($r,[switch]$Deep){}; function Assert-RuntimeTree($r,$i){}; function Assert-RuntimeLayout($r){}
    ${err(`Assert-SafeRemoval @{Root=${q(rt)}; Id='LdaGraph'; Module='graph'; Xml=${q(path.join(rt, 'service', 'LdaGraph.xml'))}}`, 'e')} @{e=$e} | ConvertTo-Json -Compress`);
  assert.match((await run()).e, /Refusing purge: .* no LDA runtime marker for graph at this path/);
  await marker({module: 'assets', serviceId: 'LdaAssets', canonicalPath: rt}); assert.match((await run()).e, /Refusing purge/);
  await marker({module: 'graph', serviceId: 'LdaGraph', canonicalPath: path.join(f.root, 'elsewhere')}); assert.match((await run()).e, /Refusing purge/);
  await marker({module: 'graph', serviceId: 'LdaGraph', canonicalPath: rt}); assert.equal((await run()).e, '');
});

test('helper refuses runtime folders equal to, inside or around another installed or planned module runtime', {skip}, async () => {
  const out = await ps(`${load(['Full', 'Is-Within', 'Get-ServiceRoot', 'Assert-NoRuntimeOverlap'])} $Modules=@{graph=@{ServiceId='LdaGraph'; LegacyServiceId='OptimizelyGraphLocal'}; assets=@{ServiceId='LdaAssets'; LegacyServiceId='OptimizelyDamLocal'}}
    function Get-ServiceRow($Id){ if($Id -eq 'OptimizelyDamLocal'){ [pscustomobject]@{PathName='"D:\\Rt\\Assets\\service\\OptimizelyDamLocal.exe"'} } }
    $script:plan=$null; ${err("Assert-NoRuntimeOverlap 'D:\\Rt\\Assets' 'graph'", 'equal')} ${err("Assert-NoRuntimeOverlap 'D:\\Rt\\Assets\\Graph' 'graph'", 'inside')} ${err("Assert-NoRuntimeOverlap 'D:\\Rt' 'graph'", 'around')}
    Assert-NoRuntimeOverlap 'D:\\Rt\\Graph' 'graph'; Assert-NoRuntimeOverlap 'D:\\Rt\\Assets' 'assets'
    function Get-ServiceRow($Id){}; $script:plan=[pscustomobject]@{operations=@([pscustomobject]@{op='install'; module='assets'; runtimeRoot='D:\\P\\Assets'})}
    ${err("Assert-NoRuntimeOverlap 'D:\\P\\Assets\\Graph' 'graph'", 'planned')}
    @{equal=$equal; inside=$inside; around=$around; planned=$planned} | ConvertTo-Json -Compress`);
  for (const key of ['equal', 'inside', 'around']) assert.match(out[key], /overlaps the runtime folder of assets \(D:\\Rt\\Assets\)/, key);
  assert.match(out.planned, /overlaps the runtime folder of assets \(D:\\P\\Assets\)/);
});

test('real helper DryRun rejects two planned installs sharing or nesting a data directory', {skip}, async t => {
  const f = await fixture(t), zip = v => path.join(f.paths.cache, `r${v}.zip`), file = path.join(f.root, 'plan.json');
  const text = JSON.stringify({version: 1, createdAt: 'x', operations: [{op: 'install', module: 'graph', version: '1.0.0', zip: zip(1), sha256: 'a'.repeat(64), port: 9001, runtimeRoot: 'D:\\Shared'}, {op: 'install', module: 'assets', version: '1.0.0', zip: zip(2), sha256: 'a'.repeat(64), port: 9002, runtimeRoot: 'D:\\Shared\\Assets'}]});
  await writeFile(file, text);
  await assert.rejects(winPs(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-PlanFile', file, '-PlanSha256', createHash('sha256').update(text).digest('hex'), '-DryRun'], {env: {...process.env, LOCALAPPDATA: f.root}}), e => e.stdout.includes('Each module needs its own separate data directory') && !e.stdout.includes('DRY RUN:'));
});

test('engine and plan refuse overlapping data directories before elevation; the marker counts as runtime layout', async t => {
  const f = await fixture(t), {engine, calls} = fakeEngine(f, {states: {assets: installed(catalog[1], {runtimeRoot: 'D:\\Lda\\Assets'})}});
  for (const dataDir of ['D:\\Lda\\Assets', 'D:\\lda\\assets\\Graph', 'D:\\Lda']) await assert.rejects(engine.act('install', ['graph'], {dataDir}), /overlaps the assets data directory D:\\Lda\\Assets/, dataDir);
  assert.equal(calls.length, 0); await engine.act('install', ['graph'], {dataDir: 'D:\\Lda\\Graph'}); assert.equal(calls.length, 1);
  const op = (module, runtimeRoot) => ({op: 'install', module, version: '1.0.0', zip: path.join(f.paths.cache, `${module}.zip`), sha256: 'a'.repeat(64), port: module === 'graph' ? 9001 : 9002, runtimeRoot});
  assert.throws(() => buildPlan([op('graph', 'D:\\X'), op('assets', 'D:\\X\\Assets')], {cache: f.paths.cache}), /cannot share or nest/);
  assert.ok(buildPlan([op('graph', 'D:\\X\\Graph'), op('assets', 'D:\\X\\Assets')], {cache: f.paths.cache}));
  assert.equal(runtimesOverlap('D:\\X\\Graph', 'D:\\X\\Graph2'), false);
  await assertRuntimeLayout('D:\\rt', {list: async () => ['tenants.json', '.lda-runtime.json', 'data']});
});

test('overlap check treats short (8.3) and long spellings of the same folder as the same folder', {skip}, async t => {
  const f = await fixture(t), dir = path.join(f.root, 'Long Runtime Folder'); await mkdir(dir);
  const long = longPath(dir);
  const short = execFileSync(path.join(path.dirname(icacls), 'cmd.exe'), ['/d', '/c', `for %I in ("${dir}") do @echo %~sI`], {windowsVerbatimArguments: true, encoding: 'utf8'}).trim();
  if (!short || short.toLowerCase() === long.toLowerCase() || !short.includes('~')) {t.skip('8.3 short names are disabled on this volume'); return;}
  assert.equal(runtimesOverlap(short, long), true, `${short} vs ${long}`);
  assert.equal(runtimesOverlap(short.toUpperCase() + '\\', long.toLowerCase()), true, 'case and trailing separator do not matter');
  assert.equal(runtimesOverlap(short, path.join(long, 'Graph')), true, 'a missing folder inside the long spelling is nested');
  assert.equal(runtimesOverlap(path.join(short, 'Graph'), long), true);
  assert.equal(runtimesOverlap(path.join(short, 'Graph'), path.join(long, 'Graph')), true, 'the missing rest is appended to the expanded prefix');
  assert.equal(runtimesOverlap(path.join(short, 'Graph'), path.join(long, 'Assets')), false);
});

// ---- fix 5: adopt ----
async function adopt(t, {fail = false, state = 'Running', legacyHealthy = true, stopNewFails = false, account = 'NT AUTHORITY\\LocalService', commitFails = false, stopLegacyTimesOut = false} = {}) {
  const f = await fixture(t), svc = path.join(f.root, 'service'); await mkdir(svc); await protect(f.root); await protect(svc);
  for (const [name, text] of [['OptimizelyGraphLocal.exe', 'wrapper-bytes'], ['OptimizelyGraphLocal.xml', '<service/>'], ['OptimizelyGraphLocal.wrapper.log', 'log']]) await writeFile(path.join(svc, name), text);
  const out = await ps(`${load(['Full', 'Get-Field', 'Get-SecuritySnapshot', 'Restore-SecuritySnapshot', 'Invoke-Adopt', 'Assert-LegacyAccount', 'Undo-Adopt', 'Remove-LegacyService'])} $wrapperSha256='W'; $scExe='Z:\\never\\sc.exe'; $Modules=@{graph=@{ServiceId='LdaGraph'}}; $svc=${q(svc)}; $rtRoot=${q(f.root)}
    $fail=$${fail}; $legacyHealthy=$${legacyHealthy}; $stopNewFails=$${stopNewFails}; $commitFails=$${commitFails}; $stopLegacyTimesOut=$${stopLegacyTimesOut}
    function Sddl($p){ (Get-Acl -LiteralPath $p).GetSecurityDescriptorSddlForm('Access, Owner') }; $before=@{root=(Sddl $rtRoot); svc=(Sddl $svc)}
    $events=New-Object Collections.Generic.List[string]; $script:registered=@{OptimizelyGraphLocal=$true}
    function Get-ServiceRow($Id){ if($script:registered[$Id]){ [pscustomobject]@{State='Stopped'} } }
    function Get-Context($Module,$Id,$Root,[switch]$Deep){ $events.Add("context:$($Id):$Deep"); @{Id=$Id; Root=$rtRoot; Service=$svc; Wrapper=(Join-Path $svc "$Id.exe"); Logs=$svc; Port=9010; MemoryMb=9000; Config=$true; Row=[pscustomobject]@{State=${q(state)}; StartName=${q(account)}}} }
    function Assert-RuntimeTree($r,$i){$events.Add('tree')}; function Assert-NoRuntimeOverlap($r,$m){$events.Add('overlap')}; function Assert-RuntimeIdentity($r,$m,$i,[switch]$LegacyAdopt){$events.Add("identity:$LegacyAdopt")}
    function Assert-Wrapper($c){}; function Assert-Port($c){}; function Assert-NoReparse($p){}; function Assert-SafeItem($p,[switch]$AllowLocalService){}
    function New-SecureDirectory($p,$k){ if(!(Test-Path $p)){New-Item -ItemType Directory $p | Out-Null}; $events.Add("mkdir:$k") }
    function Install-Code($o){$events.Add('code'); 'C:\\code\\1.2.0'}
    function Stop-Module($c){ $events.Add("stop:$($c.Id)"); if($stopNewFails -and $c.Id -eq 'LdaGraph'){throw 'synthetic stop failure'}; if($stopLegacyTimesOut -and $c.Id -eq 'OptimizelyGraphLocal'){throw 'WaitForStatus timed out'} }
    function Invoke-Wrapper($c,$a){ if($a -ne 'start' -and !$script:registered[$c.Id]){throw "not registered: $($c.Id)"}; $events.Add("$($a):$($c.Id)"); if($a -eq 'uninstall'){$script:registered[$c.Id]=$false} }
    function Wait-Healthy($c,$v,[switch]$Legacy){ $events.Add("health:$($c.Id)"); if(!$legacyHealthy){throw 'synthetic no answer'} }
    function Hash-File($p){ if([IO.File]::ReadAllText($p) -eq 'wrapper-bytes'){'W'}else{'X'} }
    function Install-Module($o,$c,[switch]$Adopting){ $events.Add("module:$($o.port):$($o.memoryMb):$Adopting"); if(!$script:registered['OptimizelyGraphLocal']){throw 'legacy was unregistered before the new service was healthy'}; if(!(Test-Path (Join-Path $svc 'LdaGraph.exe'))){throw 'wrapper was not reused'}; [IO.File]::WriteAllText((Join-Path $svc 'LdaGraph.xml'),'x'); foreach($p in @($rtRoot,$svc)){ & ${q(icacls)} $p /grant '*S-1-5-19:(OI)(CI)M' | Out-Null }; $events.Add('acl-reset'); $script:registered['LdaGraph']=$true; if($fail){throw 'synthetic unhealthy'} }
    function Remove-Code($p){$events.Add("remove:$p")}; function Set-CommittedVersions($m,$c,$p){$events.Add("commit:$($c)"); if($commitFails){throw 'synthetic commit failure'}}; function Invoke-WebRequest{throw 'download forbidden'}
    ${err("Invoke-Adopt ([pscustomobject]@{op='adopt';module='graph';legacyServiceId='OptimizelyGraphLocal';version='1.2.0'})", 'err')}
    $backup=@(Get-ChildItem (Join-Path $rtRoot 'backups') -Directory -ErrorAction SilentlyContinue | ForEach-Object { @{name=$_.Name; files=@(Get-ChildItem $_.FullName | ForEach-Object Name | Sort-Object)} })
    $after=@{root=(Sddl $rtRoot); svc=(Sddl $svc)}
    @{events=@($events); err=$err; log=@($result.log); files=@(Get-ChildItem $svc | ForEach-Object Name | Sort-Object); backup=$backup; registered=$script:registered; aclRestored=(($before.root -eq $after.root) -and ($before.svc -eq $after.svc)); aclChanged=($before.root -ne $after.root)} | ConvertTo-Json -Compress -Depth 5`);
  out.at = e => out.events.indexOf(e); return out;
}
test('adopt success: legacy stays registered until the new service is healthy, then is unregistered, backed up and deleted', {skip}, async t => {
  const out = await adopt(t);
  assert.equal(out.err, ''); assert.deepEqual(out.files, ['LdaGraph.exe', 'LdaGraph.xml']);
  for (const e of ['tree', 'overlap', 'identity:True']) assert.ok(out.at(e) >= 0 && out.at(e) < out.at('code'), `${e} before any change`);
  assert.ok(out.at('stop:OptimizelyGraphLocal') < out.at('module:9010:9000:True'));
  assert.ok(out.at('module:9010:9000:True') < out.at('commit:1.2.0') && out.at('commit:1.2.0') < out.at('uninstall:OptimizelyGraphLocal'), 'legacy unregistered only after health and commit');
  assert.equal(out.backup.length, 1); assert.match(out.backup[0].name, /^adopt-OptimizelyGraphLocal-\d{14}$/);
  assert.deepEqual(out.backup[0].files, ['OptimizelyGraphLocal.exe', 'OptimizelyGraphLocal.wrapper.log', 'OptimizelyGraphLocal.xml']);
  assert.equal(out.registered.OptimizelyGraphLocal, false); assert.equal(out.registered.LdaGraph, true);
});
test('adopt failure while legacy was running: new service removed, legacy never unregistered, restarted and verified', {skip}, async t => {
  const out = await adopt(t, {fail: true});
  assert.match(out.err, /^Adoption failed: synthetic unhealthy Recovery: Stopped the new service LdaGraph\. Removed the new service LdaGraph\..*Legacy service OptimizelyGraphLocal is running again and answered \/health\./);
  assert.ok(!out.events.includes('uninstall:OptimizelyGraphLocal')); assert.equal(out.registered.OptimizelyGraphLocal, true); assert.equal(out.registered.LdaGraph, false);
  assert.deepEqual(out.files, ['OptimizelyGraphLocal.exe', 'OptimizelyGraphLocal.wrapper.log', 'OptimizelyGraphLocal.xml']);
  assert.ok(out.at('start:OptimizelyGraphLocal') < out.at('health:OptimizelyGraphLocal')); assert.ok(out.events.includes('remove:C:\\code\\1.2.0'));
  assert.ok(out.log.some(l => l === 'Recovery: Legacy service OptimizelyGraphLocal is running again and answered /health.'));
});
test('adopt failure while legacy was stopped: legacy is left stopped and nothing claims it was restored', {skip}, async t => {
  const out = await adopt(t, {fail: true, state: 'Stopped'});
  assert.match(out.err, /was stopped before adoption and was left stopped/); assert.ok(!out.events.includes('start:OptimizelyGraphLocal')); assert.doesNotMatch(out.err, /running again/);
});
test('adopt recovery steps are independent and an unverified legacy restart is reported as such', {skip}, async t => {
  const out = await adopt(t, {fail: true, legacyHealthy: false, stopNewFails: true});
  assert.match(out.err, /Could not stop the new service LdaGraph: synthetic stop failure/); assert.match(out.err, /Removed the new service LdaGraph/);
  assert.match(out.err, /was started but could NOT be confirmed healthy: synthetic no answer/); assert.doesNotMatch(out.err, /running again|restored/);
});
test('dry-run adopt describes the non-destructive order', {skip}, async t => {
  const f = await fixture(t), file = path.join(f.root, 'plan.json'), text = JSON.stringify({version: 1, createdAt: 'x', operations: [{op: 'adopt', module: 'graph', legacyServiceId: 'OptimizelyGraphLocal', version: '1.2.0', zip: path.join(f.paths.cache, 'r.zip'), sha256: 'a'.repeat(64)}]});
  await writeFile(file, text); const {stdout} = await winPs(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-PlanFile', file, '-PlanSha256', createHash('sha256').update(text).digest('hex'), '-DryRun'], {env: {...process.env, LOCALAPPDATA: f.root}});
  for (const s of ['validate owner and write access', 'stop legacy (registration kept)', 'normalise runtime ACLs to the standard policy', 'then unregister legacy and back up then delete its wrapper files', 'restart legacy only if it was running and verify /health']) assert.ok(stdout.includes(s), s);
  assert.ok(!stdout.includes('adopt-bak'));
});

// ---- fix 6: upgrade recovery ----
for (const oldHealthy of [true, false]) test(`upgrade recovery attempts every step independently (previous version ${oldHealthy ? 'healthy' : 'unhealthy'})`, {skip}, async t => {
  const f = await fixture(t), oldCode = path.join(f.root, 'Graph', '1.0.0'), newCode = path.join(f.root, 'Graph', '1.2.0'), xmlFile = path.join(f.root, 'LdaGraph.xml');
  const xml = `<service><id>LdaGraph</id><arguments>&quot;${oldCode}\\src\\server.js&quot;</arguments><workingdirectory>${oldCode}</workingdirectory></service>`; await writeFile(xmlFile, xml);
  const out = await ps(`${load(['Switch-Code'])} $events=New-Object Collections.Generic.List[string]; $stops=0
    function Current-Code($c){${q(oldCode)}}; function Assert-CodeTarget($p){}; function Assert-Port($c){}
    function Stop-Module($c){ $script:stops++; $events.Add('stop'); if($script:stops -eq 2){throw 'synthetic stop failure'} }
    function Invoke-Wrapper($c,$a){$events.Add($a)}; function Wait-Healthy($c,$v){ $events.Add("health:$v"); if($v -eq '1.2.0' -or !$${oldHealthy}){throw "synthetic unhealthy $v"} }
    ${err(`Switch-Code @{Xml=${q(xmlFile)}; Module='graph'} ${q(newCode)} '1.2.0'`, 'err')}
    @{err=$err; events=@($events); log=@($result.log)} | ConvertTo-Json -Compress`);
  assert.equal(await readFile(xmlFile, 'utf8'), xml);
  assert.deepEqual(out.events, ['stop', 'start', 'health:1.2.0', 'stop', 'start', 'health:1.0.0']);
  assert.match(out.err, /^Upgrade\/rollback failed: synthetic unhealthy 1\.2\.0 The previous XML restored/);
  assert.deepEqual(out.log.slice(0, 3), ['Recovery: Could not stop the failed version: synthetic stop failure', 'Recovery: Restored the previous service XML.', 'Recovery: Started version 1.0.0 again.']);
  if (oldHealthy) {assert.match(out.err, /version 1\.0\.0 is running and healthy/); assert.equal(out.log[3], 'Recovery: Version 1.0.0 answered /health.');}
  else {assert.match(out.err, /version 1\.0\.0 is not healthy/); assert.match(out.log[3], /Version 1\.0\.0 is NOT healthy: synthetic unhealthy 1\.0\.0/);}
});

// ---- fix 7: committed versions ----
test('versions.json is written atomically and trusted only when it matches the active version', {skip}, async t => {
  const f = await fixture(t), dir = path.join(f.root, 'Graph'); for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0-rc.1']) await mkdir(path.join(dir, v), {recursive: true});
  const out = await ps(`${load(['Get-Field', 'Test-ReparsePoint', 'Compare-ReleaseVersion', 'Get-VersionFolders', 'Get-VersionsFile', 'Set-CommittedVersions', 'Get-CommittedVersions', 'Prune-Versions'])} $codeRoot=${q(f.root)}; $Modules=@{graph=@{RuntimeFolder='Graph'}}
    $none=(Get-CommittedVersions 'graph' '1.2.0').previous
    Set-CommittedVersions 'graph' '1.1.0' ''; $first=[IO.File]::ReadAllText(${q(path.join(dir, 'versions.json'))})
    Set-CommittedVersions 'graph' '1.2.0' '1.0.0'
    $match=(Get-CommittedVersions 'graph' '1.2.0').previous; $mismatch=(Get-CommittedVersions 'graph' '1.3.0-rc.1').previous
    $removed=New-Object Collections.Generic.List[string]; function Remove-Code($p){$removed.Add((Split-Path $p -Leaf))}; Prune-Versions 'graph' '1.2.0' '1.0.0'
    Set-CommittedVersions 'graph' '1.2.0' '0.9.0'; $missing=(Get-CommittedVersions 'graph' '1.2.0').previous
    @{none=$none; first=$first; match=$match; mismatch=$mismatch; missing=$missing; removed=@($removed | Sort-Object); log=@($result.log)} | ConvertTo-Json -Compress`);
  assert.equal(out.none, null); assert.equal(JSON.parse(out.first).previous, null); assert.equal(JSON.parse(out.first).current, '1.1.0');
  assert.equal(out.match, '1.0.0'); assert.equal(out.mismatch, null); assert.equal(out.missing, null);
  assert.ok(out.log.some(l => /records 1\.2\.0, but version 1\.3\.0-rc\.1 is active/.test(l)));
  assert.deepEqual(out.removed, ['1.1.0', '1.3.0-rc.1']);
  const saved = JSON.parse(await readFile(path.join(dir, 'versions.json'), 'utf8')); assert.equal(saved.current, '1.2.0'); assert.equal(saved.previous, '0.9.0'); assert.ok(Date.parse(saved.committedAt));
  assert.deepEqual((await readdir(dir)).filter(n => n.endsWith('.tmp')), [], 'no temp file is left behind');
  const source = await readFile(helper, 'utf8'); assert.ok(source.includes('[IO.File]::Replace($temp,$file,[NullString]::Value)')); assert.ok(source.includes('$stream.Flush($true)')); assert.ok(!source.includes('previous.json'));
});

// ---- every operation: trust first; failed upgrade cleanup; rollback from committed versions only ----
async function operations(ops, {switchFails = false, previous = '1.0.0', candidate = '1.2.0', released = true, commitFails = false} = {}) {
  return ps(`${load(['Full', 'Get-Field', 'Invoke-Operation', 'Assert-OperationTrust', 'Remove-Candidate', 'Write-VersionRecord'])} $Modules=@{graph=@{ServiceId='LdaGraph'; LegacyServiceId='OptimizelyGraphLocal'}}; $runs=@()
    $events=New-Object Collections.Generic.List[string]; $switchFails=$${switchFails}; $released=$${released}; $commitFails=$${commitFails}
    function Assert-ServiceNode($c){$events.Add('node')}; function Assert-CodeFiles($p){$events.Add("files:$(Split-Path $p -Leaf)")}; function Test-CandidateReleased($c,$code,$r){$events.Add('released?'); $released}
    function Get-ServiceRow($Id){$null}; function Get-Context($Module,$Id,[string]$Root,[switch]$Deep){$events.Add("context:$Deep"); @{Id=$Id; Module=$Module; Root='Z:\\rt'; Row=($Root -eq ''); Wrapper='Z:\\w.exe'; Config=$true}}
    function Assert-RuntimeChain($r){$events.Add('chain')}; function Assert-RuntimeLayout($r){$events.Add('layout')}; function Assert-RuntimeTree($r,$i){$events.Add('tree')}; function Assert-NoRuntimeOverlap($r,$m){$events.Add('overlap')}; function Assert-RuntimeIdentity($r,$m,$i){$events.Add('identity')}
    function Current-Code($c){$events.Add('codecheck'); 'C:\\pf\\Graph\\1.1.0'}; function Assert-Wrapper($c){}; function Assert-Port($c){}
    function Stop-Module($c){$events.Add('CHANGE:stop')}; function Invoke-Wrapper($c,$a){$events.Add("CHANGE:$a")}; function Wait-Healthy($c,$v){}; function Assert-SafeRemoval($c){$events.Add('safe')}; function Remove-Item{}
    function Install-Code($o){$events.Add('CHANGE:code'); ${q(`C:\\pf\\Graph\\${candidate}`)}}; function Install-Module($o,$c){$events.Add('CHANGE:module')}
    function Switch-Code($c,$code,$v){$events.Add("CHANGE:switch:$v"); if($switchFails){throw 'synthetic switch failure'}}
    function Get-CommittedVersions($m,$a){@{current=$a; previous=${previous ? q(previous) : '$null'}}}; function Set-CommittedVersions($m,$c,$p){$events.Add("commit:$($c):$p"); if($commitFails){throw 'synthetic disk full'}}; function Prune-Versions($m,$c,$p){$events.Add("prune:$($c):$p")}
    function Remove-Code($p){$events.Add("remove:$(Split-Path $p -Leaf)")}
    foreach($op in @(${ops.map(o => `@{${Object.entries(o).map(([k, v]) => `${k}=${typeof v === 'boolean' ? `$${v}` : q(v)}`).join(';')}}`).join(',')})){ $o=[pscustomobject]($op+@{module='graph'}); $events.Clear(); $e=''; try{Invoke-Operation $o}catch{$e=$_.Exception.Message}; $runs+=@{op=$o.op; events=@($events); err=$e} }
    @{runs=$runs; log=@($result.log)} | ConvertTo-Json -Compress -Depth 4`);
}
test('every operation validates the runtime tree, overlap and code chain before its first change', {skip}, async () => {
  const out = await operations([{op: 'start'}, {op: 'stop'}, {op: 'restart'}, {op: 'upgrade', version: '1.2.0'}, {op: 'rollback'}, {op: 'uninstall', purge: false}, {op: 'uninstall', purge: true}, {op: 'install', runtimeRoot: 'D:\\Rt', port: 1, version: '1.2.0'}]);
  for (const run of out.runs) {
    const first = run.events.findIndex(e => e.startsWith('CHANGE:'));
    assert.equal(run.err, '', run.op); assert.ok(first > 0, run.op);
    for (const check of ['tree', 'overlap']) assert.ok(run.events.indexOf(check) >= 0 && run.events.indexOf(check) < first, `${run.op}: ${check} before the first change`);
    if (run.op !== 'install') assert.ok(run.events.indexOf('codecheck') < first, `${run.op}: code chain first`);
  }
  const by = op => out.runs.filter(r => r.op === op);
  assert.deepEqual(by('start')[0].events.slice(0, 1), ['context:False']); assert.equal(by('uninstall')[1].events[0], 'context:True');
  assert.deepEqual(by('install')[0].events.slice(0, 6), ['chain', 'layout', 'context:True', 'tree', 'overlap', 'identity']);
  assert.ok(by('install')[0].events.includes('commit:1.2.0:'));
  assert.deepEqual(by('upgrade')[0].events.slice(-2), ['commit:1.2.0:1.1.0', 'prune:1.2.0:1.1.0']);
  assert.deepEqual(by('rollback')[0].events.slice(-2), ['CHANGE:switch:1.0.0', 'commit:1.0.0:1.1.0']);
});
test('a failed upgrade deletes only its own candidate folder; rollback needs a committed previous version', {skip}, async () => {
  const failed = await operations([{op: 'upgrade', version: '1.2.0'}], {switchFails: true});
  assert.match(failed.runs[0].err, /synthetic switch failure/); assert.ok(failed.runs[0].events.includes('remove:1.2.0')); assert.ok(!failed.runs[0].events.some(e => e.startsWith('commit')));
  const kept = await operations([{op: 'upgrade', version: '1.0.0'}], {switchFails: true, candidate: '1.0.0'});
  assert.ok(!kept.runs[0].events.some(e => e.startsWith('remove:'))); assert.ok(kept.log.some(l => /Kept .*1\.0\.0 because it is a committed version/.test(l)));
  const none = await operations([{op: 'rollback'}], {previous: null});
  assert.match(none.runs[0].err, /No committed previous version/); assert.ok(!none.runs[0].events.some(e => e.startsWith('CHANGE:')));
});

// ---- final verification fixes ----
// A: the failed candidate is deleted only when recovery completed (real Switch-Code, Invoke-Operation and cleanup).
async function failedUpgrade(t, scenario) {
  const f = await fixture(t), oldCode = path.join(f.root, 'Graph', '1.0.0'), newCode = path.join(f.root, 'Graph', '1.2.0'), xmlFile = path.join(f.root, 'LdaGraph.xml');
  await writeFile(xmlFile, `<service><id>LdaGraph</id><arguments>&quot;${oldCode}\\src\\server.js&quot;</arguments><workingdirectory>${oldCode}</workingdirectory></service>`);
  return ps(`${load(['Full', 'Get-Field', 'Invoke-Operation', 'Assert-OperationTrust', 'Remove-Candidate', 'Test-CandidateReleased', 'Switch-Code', 'Write-VersionRecord'])}
    $Modules=@{graph=@{ServiceId='LdaGraph'; LegacyServiceId='OptimizelyGraphLocal'}}; $scenario=${q(scenario)}; $xmlFile=${q(xmlFile)}
    $events=New-Object Collections.Generic.List[string]; $script:stops=0; $script:starts=0
    function Get-ServiceRow($Id){ if($Id -eq 'LdaGraph'){ $s='Running'; if($scenario -eq 'old-unhealthy-stopped'){$s='Stopped'}; [pscustomobject]@{State=$s} } }
    function Get-Context($Module,$Id,[string]$Root,[switch]$Deep){ @{Id=$Id; Module=$Module; Root='Z:\\rt'; Row=$true; Wrapper='Z:\\w.exe'; Xml=$xmlFile; Config=$true} }
    function Assert-RuntimeTree($r,$i){}; function Assert-NoRuntimeOverlap($r,$m){}; function Assert-Wrapper($c){}; function Assert-Port($c){}; function Assert-ServiceNode($c){}; function Assert-CodeFiles($p){}; function Assert-CodeTarget($p){}
    function Current-Code($c){ ${q(oldCode)} }; function Install-Code($o){ ${q(newCode)} }
    function Get-CommittedVersions($m,$a){ @{current=$a; previous=$null} }; function Set-CommittedVersions($m,$c,$p){$events.Add('commit')}; function Prune-Versions($m,$c,$p){$events.Add('prune')}
    function Stop-Module($c){ $script:stops++; $events.Add('stop'); if($scenario -eq 'before-switch' -and $script:stops -eq 1){throw 'WaitForStatus timed out'}; if($scenario -eq 'xml-locked' -and $script:stops -eq 2){throw 'synthetic stop failure'} }
    function Invoke-Wrapper($c,$a){ $script:starts++; $events.Add($a); if($scenario -eq 'xml-locked' -and $script:starts -eq 1){ (Get-Item -LiteralPath $xmlFile).IsReadOnly=$true } }
    function Wait-Healthy($c,$v){ $events.Add("health:$v"); if($v -eq '1.2.0' -or $scenario -like 'old-unhealthy*'){throw "synthetic unhealthy $v"} }
    function Remove-Code($p){ $events.Add("remove:$(Split-Path $p -Leaf)") }
    ${err("Invoke-Operation ([pscustomobject]@{op='upgrade'; module='graph'; version='1.2.0'})", 'err')}
    (Get-Item -LiteralPath $xmlFile).IsReadOnly=$false
    @{err=$err; events=@($events); log=@($result.log); xml=[IO.File]::ReadAllText($xmlFile)} | ConvertTo-Json -Compress`);
}
test('a failed upgrade deletes its candidate only after recovery completed; otherwise it is kept and reported', {skip}, async t => {
  for (const scenario of ['healthy', 'old-unhealthy-stopped', 'before-switch']) {
    const out = await failedUpgrade(t, scenario);
    assert.ok(out.events.includes('remove:1.2.0'), scenario); assert.doesNotMatch(out.err, /Candidate kept/, scenario); assert.doesNotMatch(out.xml, /1\.2\.0/, scenario);
    assert.ok(!out.events.includes('commit') && !out.events.includes('prune'), scenario);
  }
  for (const scenario of ['xml-locked', 'old-unhealthy-running']) {
    const out = await failedUpgrade(t, scenario);
    assert.ok(!out.events.some(e => e.startsWith('remove:')), scenario);
    assert.match(out.err, /Candidate kept because recovery did not complete: .*1\.2\.0/, scenario);
    assert.ok(out.log.some(l => /Kept the candidate .*1\.2\.0 because recovery did not complete/.test(l)), scenario);
  }
  const locked = await failedUpgrade(t, 'xml-locked');
  assert.match(locked.err, /previous XML could not be restored/); assert.match(locked.xml, /1\.2\.0/, 'the XML still names the candidate, so it must stay');
});

// B: adopt account check, permission restore, stop timeout, commit inside the transaction.
test('adopt refuses a legacy service that does not run as LocalService before changing anything', {skip}, async t => {
  const out = await adopt(t, {account: 'NT AUTHORITY\\NetworkService'});
  assert.match(out.err, /^Refusing to adopt: legacy service OptimizelyGraphLocal runs as 'NT AUTHORITY\\NetworkService', not NT AUTHORITY\\LocalService\..*could lose access to its own data.*Nothing was changed\./);
  assert.deepEqual(out.events.filter(e => !e.startsWith('context:')), [], 'no check-and-change step ran'); assert.equal(out.aclRestored, true);
  const local = await adopt(t, {account: 'NT AUTHORITY\\LOCAL SERVICE'}); assert.equal(local.err, '');
});
test('failed adopt restores the runtime and service folder permissions it snapshotted; success keeps the new policy', {skip}, async t => {
  const failed = await adopt(t, {fail: true});
  assert.ok(failed.events.includes('acl-reset')); assert.equal(failed.aclRestored, true);
  assert.equal(failed.log.filter(l => /^Recovery: Restored the original permissions of /.test(l)).length, 2);
  const ok = await adopt(t); assert.equal(ok.aclChanged, true, 'a successful adoption keeps the normalised permissions');
});
test('adopt: a legacy stop that timed out still counts as stopped, so recovery restarts the legacy service', {skip}, async t => {
  const out = await adopt(t, {stopLegacyTimesOut: true});
  assert.match(out.err, /^Adoption failed: WaitForStatus timed out Recovery: /); assert.doesNotMatch(out.err, /was not stopped/);
  assert.ok(out.events.includes('start:OptimizelyGraphLocal')); assert.match(out.err, /Legacy service OptimizelyGraphLocal is running again and answered \/health\./);
  assert.ok(!out.events.some(e => e.startsWith('module:')));
});
test('adopt: a failed versions.json commit undoes the adoption, so only the legacy service stays registered', {skip}, async t => {
  const out = await adopt(t, {commitFails: true});
  assert.match(out.err, /^Adoption failed: synthetic commit failure Recovery: Stopped the new service LdaGraph\. Removed the new service LdaGraph\./);
  assert.equal(out.registered.LdaGraph, false); assert.equal(out.registered.OptimizelyGraphLocal, true); assert.ok(!out.events.includes('uninstall:OptimizelyGraphLocal'));
  assert.ok(out.at('commit:1.2.0') < out.at('uninstall:LdaGraph')); assert.ok(out.at('uninstall:LdaGraph') < out.at('start:OptimizelyGraphLocal'));
  assert.equal(out.aclRestored, true); assert.deepEqual(out.files, ['OptimizelyGraphLocal.exe', 'OptimizelyGraphLocal.wrapper.log', 'OptimizelyGraphLocal.xml']);
});

// C: runtime marker temp-file write and recovery from an interrupted write.
test('runtime marker: written through a temp file; an interrupted write is recovered for the same module and blocks any other', {skip}, async t => {
  const f = await fixture(t); await protect(f.root);
  const dirs = {}; for (const name of ['partialTemp', 'badFinalGoodTemp', 'badFinalOtherTemp', 'otherFinal', 'badFinalOnly', 'fresh']) {dirs[name] = path.join(f.root, name); await mkdir(dirs[name]);}
  const tmpName = `.lda-runtime.json.${'a'.repeat(32)}.tmp`, temp = name => path.join(dirs[name], tmpName), final = name => path.join(dirs[name], '.lda-runtime.json');
  const body = (module, serviceId, dir) => JSON.stringify({module, serviceId, canonicalPath: dir, createdAt: 'x'});
  await writeFile(temp('partialTemp'), '{"module":"gr');
  await writeFile(final('badFinalGoodTemp'), '{"modu'); await writeFile(temp('badFinalGoodTemp'), body('graph', 'LdaGraph', dirs.badFinalGoodTemp));
  await writeFile(final('badFinalOtherTemp'), ''); await writeFile(temp('badFinalOtherTemp'), body('assets', 'LdaAssets', dirs.badFinalOtherTemp));
  await writeFile(final('otherFinal'), body('assets', 'LdaAssets', dirs.otherFinal)); await writeFile(temp('otherFinal'), '{');
  await writeFile(final('badFinalOnly'), '{"modu');
  const out = await ps(`${trustMe} ${load(['Full', 'Get-Field', 'Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'New-AdminFileSecurity', 'Get-MarkerTemps', 'Read-MarkerFile', 'Resolve-RuntimeMarker', 'Assert-RuntimeIdentity', 'Write-RuntimeMarker', 'Assert-RuntimeLayout'])}
    Set-Item function:New-AdminFileSecurity { $s=New-Object Security.AccessControl.FileSecurity; $s.SetAccessRuleProtection($true,$false); foreach($sid in @('S-1-5-18','S-1-5-32-544',$me)){ $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','Allow'))) }; $s }
    $d=@{}; ${Object.entries(dirs).map(([k, v]) => `$d[${q(k)}]=${q(v)}`).join('; ')}
    Assert-RuntimeLayout $d.partialTemp
    ${err("Assert-RuntimeIdentity $d.partialTemp 'graph' 'LdaGraph'", 'partial')} Write-RuntimeMarker $d.partialTemp 'graph' 'LdaGraph'
    ${err("Assert-RuntimeIdentity $d.badFinalGoodTemp 'graph' 'LdaGraph'", 'recovered')}
    ${err("Assert-RuntimeIdentity $d.badFinalOtherTemp 'graph' 'LdaGraph'", 'otherTemp')}
    ${err("Assert-RuntimeIdentity $d.otherFinal 'graph' 'LdaGraph'", 'otherFinal')}
    ${err("Assert-RuntimeIdentity $d.badFinalOnly 'graph' 'LdaGraph'", 'badOnly')}
    Write-RuntimeMarker $d.fresh 'graph' 'LdaGraph'
    $list=@{}; foreach($k in $d.Keys){ $list[$k]=@(Get-ChildItem -LiteralPath $d[$k] -Force | ForEach-Object Name | Sort-Object) }
    @{partial=$partial; recovered=$recovered; otherTemp=$otherTemp; otherFinal=$otherFinal; badOnly=$badOnly; list=$list; log=@($result.log)} | ConvertTo-Json -Compress -Depth 4`);
  assert.equal(out.partial, '', 'a half-written temp alone does not block a retry'); assert.deepEqual(out.list.partialTemp, ['.lda-runtime.json']);
  assert.equal(JSON.parse(await readFile(final('partialTemp'), 'utf8')).module, 'graph');
  assert.equal(out.recovered, ''); assert.deepEqual(out.list.badFinalGoodTemp, ['.lda-runtime.json']); assert.equal(JSON.parse(await readFile(final('badFinalGoodTemp'), 'utf8')).serviceId, 'LdaGraph');
  assert.ok(out.log.some(l => /Recovered the runtime marker of .*badFinalGoodTemp from an interrupted write/.test(l)));
  assert.match(out.otherTemp, /interrupted runtime marker write in it belongs to assets \(LdaAssets\)/); assert.deepEqual(out.list.badFinalOtherTemp, ['.lda-runtime.json', tmpName], 'the other module folder is left untouched');
  assert.match(out.otherFinal, /runtime folder of assets \(LdaAssets\), not graph \(LdaGraph\)/); assert.deepEqual(out.list.otherFinal, ['.lda-runtime.json', tmpName]);
  assert.match(out.badOnly, /runtime marker .* is not valid/);
  assert.deepEqual(out.list.fresh, ['.lda-runtime.json'], 'no temp file is left after a normal write');
  const source = await readFile(helper, 'utf8');
  assert.ok(source.includes("$temp = Join-Path $r ($markerName + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')")); assert.ok(source.includes('[IO.File]::Move($temp, $file)'));
  await assertRuntimeLayout('D:\\rt', {list: async () => ['tenants.json', tmpName]});
});

// D: a folder that already exists when CreateDirectory runs (creation race) is validated before any ACL change.
test('New-SecureDirectory validates a folder another user created first and refuses it before changing its ACL', {skip}, async t => {
  const f = await fixture(t), raced = path.join(f.root, 'raced'), mine = path.join(f.root, 'mine'); await protect(f.root); await mkdir(raced); await grant(raced, '*S-1-5-32-545:(OI)(CI)M');
  const out = await ps(`${trustMe} ${load(['Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'New-RestrictedSecurity', 'New-SecureDirectory'])} ${keepAccess}
    function Test-Path { $false }
    ${err(`New-SecureDirectory ${q(raced)} 'Runtime' | Out-Null`, 'raced')} $created=New-SecureDirectory ${q(mine)} 'Runtime'
    @{raced=$raced; created=$created; usersStill=[bool](@((Get-Acl -LiteralPath ${q(raced)}).Access | Where-Object { $_.IdentityReference -like '*Users' }).Count)} | ConvertTo-Json -Compress`);
  assert.match(out.raced, /raced: .*Users can modify it/); assert.equal(out.usersStill, true, 'the raced folder ACL was not changed'); assert.equal(out.created, true);
  const source = await readFile(helper, 'utf8'), fn = source.slice(source.indexOf('function New-SecureDirectory'), source.indexOf('function New-RuntimeRoot'));
  assert.ok(fn.lastIndexOf('Assert-SafeItem $Path') > fn.indexOf('CreateDirectory'));
});

// E: the Node executable named in an existing service XML is revalidated.
test('start, restart, upgrade and rollback revalidate the Node executable in the service XML and the code files first', {skip}, async t => {
  const f = await fixture(t), unsafe = path.join(f.root, 'node.exe'); await writeFile(unsafe, 'x'); await ownByMe(unsafe);
  const fns = load(['Full', 'Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'Assert-TrustedExecutable', 'Assert-ServiceNode']);
  const ctx = exe => `@{Id='LdaGraph'; Module='graph'; Config=[xml]('<service><id>LdaGraph</id>' + ${exe === null ? "''" : `'<executable>' + ${q(exe)} + '</executable>'`} + '</service>')}`;
  const out = await ps(`${fns} ${err(`Assert-ServiceNode ${ctx(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'))}`, 'trusted')}
    ${err(`Assert-ServiceNode ${ctx(unsafe)}`, 'unsafe')} ${err(`Assert-ServiceNode ${ctx('node')}`, 'relative')} ${err(`Assert-ServiceNode ${ctx(null)}`, 'missing')}
    @{trusted=$trusted; unsafe=$unsafe; relative=$relative; missing=$missing} | ConvertTo-Json -Compress`);
  assert.equal(out.trusted, '');
  for (const key of ['unsafe', 'relative', 'missing']) assert.match(out[key], /^Refusing to run LdaGraph: its service uses the Node executable .*Install Node 24 or newer system-wide \(into Program Files\)/, key);
  assert.match(out.unsafe, /node\.exe: it is owned by/); assert.match(out.relative, /not an absolute path/);
  const ops = await operations([{op: 'start'}, {op: 'restart'}, {op: 'upgrade', version: '1.2.0'}, {op: 'rollback'}, {op: 'stop'}]);
  for (const run of ops.runs) {
    const first = run.events.findIndex(e => e.startsWith('CHANGE:'));
    if (run.op === 'stop') {assert.ok(!run.events.includes('node')); continue;}
    assert.ok(run.events.indexOf('node') >= 0 && run.events.indexOf('node') < first, `${run.op}: node checked first`);
    assert.ok(run.events.indexOf('files:1.1.0') < first, `${run.op}: active code files checked first`);
  }
  const by = op => ops.runs.find(r => r.op === op).events;
  assert.ok(by('upgrade').indexOf('files:1.2.0') < by('upgrade').indexOf('CHANGE:switch:1.2.0')); assert.ok(by('rollback').indexOf('files:1.0.0') < by('rollback').indexOf('CHANGE:switch:1.0.0'));
});

// G: the version folder's executed files must not be writable by untrusted principals.
test('code files: server.js, service-xml.js, package.json and their folders must be admin-only writable', {skip}, async t => {
  const f = await fixture(t), code = path.join(f.root, '1.0.0'); await protect(f.root);
  for (const d of ['src', 'scripts']) await mkdir(path.join(code, d), {recursive: true});
  for (const file of ['src\\server.js', 'scripts\\service-xml.js', 'package.json']) await writeFile(path.join(code, file), '{}');
  const run = () => ps(`${trustMe} ${load(['Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'Assert-CodeFiles', 'Assert-CodeTree'])} ${err(`Assert-CodeFiles ${q(code)}`, 'e')} @{e=$e} | ConvertTo-Json -Compress`);
  assert.equal((await run()).e, '');
  for (const [target, pattern] of [['package.json', /package\.json: .*Users can modify it/], ['src\\server.js', /server\.js: .*Users can modify it/], ['scripts', /scripts: .*Users can modify it/]]) {
    await grant(path.join(code, target), '*S-1-5-32-545:M'); assert.match((await run()).e, pattern, target);
    await exec(icacls, [path.join(code, target), '/remove:g', '*S-1-5-32-545']);
  }
  assert.equal((await run()).e, '');
  await rm(path.join(code, 'scripts', 'service-xml.js')); assert.match((await run()).e, /scripts\\service-xml\.js is missing/);
  const source = await readFile(helper, 'utf8'), node = source.slice(source.indexOf('function Invoke-ModuleNode'));
  assert.ok(node.indexOf('Assert-CodeFiles $Code') < node.indexOf('& $nodePath'), 'checked before node runs service-xml.js');
});

// F: a failed version record after a successful switch is reported and nothing is pruned.
test('a version record write failure after a successful switch is reported and blocks pruning', {skip}, async () => {
  const out = await operations([{op: 'upgrade', version: '1.2.0'}, {op: 'rollback'}], {commitFails: true});
  for (const run of out.runs) assert.ok(!run.events.some(e => e.startsWith('prune')), run.op);
  assert.match(out.runs[0].err, /^Service switched to 1\.2\.0 but version record could not be written; rollback unavailable until next successful upgrade\. \(synthetic disk full\)/);
  assert.match(out.runs[1].err, /^Service switched to 1\.0\.0 but version record could not be written/);
  assert.ok(out.log.some(l => l.startsWith('Service switched to 1.2.0 but version record could not be written')));
  const kept = await operations([{op: 'upgrade', version: '1.2.0'}], {switchFails: true, released: false});
  assert.match(kept.runs[0].err, /synthetic switch failure Candidate kept because recovery did not complete: C:\\pf\\Graph\\1\.2\.0/); assert.ok(!kept.runs[0].events.some(e => e.startsWith('remove:')));
});

// Review 4, finding 1: the whole version folder (node_modules included) is checked before anything in it runs.
test('code tree: one writable nested file or a nested junction anywhere in the version folder is refused', {skip}, async t => {
  const f = await fixture(t), code = path.join(f.root, '1.0.0'); await protect(f.root);
  const nested = path.join(code, 'node_modules', 'dep', 'lib');
  for (const d of ['src', 'scripts', nested]) await mkdir(path.isAbsolute(d) ? d : path.join(code, d), {recursive: true});
  for (const file of ['src\\server.js', 'scripts\\service-xml.js', 'package.json', 'node_modules\\dep\\lib\\index.js', 'node_modules\\dep\\package.json']) await writeFile(path.join(code, file), '{}');
  const run = () => ps(`${trustMe} ${load(['Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'Assert-CodeFiles', 'Assert-CodeTree'])} ${err(`Assert-CodeFiles ${q(code)}`, 'e')} @{e=$e} | ConvertTo-Json -Compress`);
  assert.equal((await run()).e, '', 'a clean tree passes');
  const deep = path.join(nested, 'index.js');
  await grant(deep, '*S-1-5-32-545:M');
  assert.match((await run()).e, /^Refusing to run the code in .*1\.0\.0: .*Users can modify .*node_modules\\dep\\lib\\index\.js/);
  await exec(icacls, [deep, '/remove:g', '*S-1-5-32-545']); assert.equal((await run()).e, '');
  await grant(nested, '*S-1-5-19:(OI)(CI)M');
  assert.match((await run()).e, /LOCAL SERVICE can modify .*node_modules\\dep\\lib/i, 'LocalService may not modify code either');
  await exec(icacls, [nested, '/remove:g', '*S-1-5-19']); assert.equal((await run()).e, '');
  await exec(path.join(path.dirname(icacls), 'cmd.exe'), ['/d', '/c', 'mklink', '/J', path.join(code, 'node_modules', 'link'), f.root]);
  assert.match((await run()).e, /node_modules\\link is a junction or symbolic link/);
  const source = await readFile(helper, 'utf8'), fn = source.slice(source.indexOf('function Assert-CodeTree'), source.indexOf('function Assert-ServiceNode'));
  assert.equal(fn.match(/Get-ChildItem/g).length, 1, 'a single recursive pass'); assert.ok(fn.includes('-Recurse -Force'));
  assert.ok(fn.includes('$trusted.ContainsKey($sddl)'), 'identical ACLs are checked once');
});

// Review 4, finding 2: a folder that appears between listing the missing folders and creating it is validated
// before New-RuntimeRoot changes its ACL.
test('a runtime folder that appears after the missing folders were listed is refused before any ACL change', {skip}, async t => {
  const f = await fixture(t), raced = path.join(f.root, 'raced'); await protect(f.root); await mkdir(raced); await grant(raced, '*S-1-5-32-545:(OI)(CI)M');
  const out = await ps(`${trustMe} ${load(['Full', 'Get-PrincipalName', 'Find-UntrustedWriter', 'Assert-SafeItem', 'New-RestrictedSecurity', 'New-SecureDirectory', 'New-RuntimeRoot'])}
    $acls=New-Object Collections.Generic.List[string]; function Set-RestrictedDirectoryAcl($Path,[switch]$Service){$acls.Add($Path)}; function Assert-RuntimeChain($r){}
    $script:seen=0; function Test-Path([string]$LiteralPath){ if((Full $LiteralPath) -eq (Full ${q(raced)})){ $script:seen++; return ($script:seen -gt 1) }; Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath }
    ${err(`New-RuntimeRoot ${q(raced)}`, 'e')}
    ${err(`New-SecureDirectory ${q(raced)} 'Service' | Out-Null`, 'direct')}
    @{e=$e; direct=$direct; acls=@($acls); seen=$script:seen; usersStill=[bool](@((Get-Acl -LiteralPath ${q(raced)}).Access | Where-Object { $_.IdentityReference -like '*Users' }).Count)} | ConvertTo-Json -Compress`);
  assert.equal(out.seen >= 2, true, 'missing at collection, present at creation');
  assert.match(out.e, /raced: .*Users can modify it/); assert.deepEqual(out.acls, [], 'no ACL or owner change before validation'); assert.equal(out.usersStill, true);
  assert.match(out.direct, /raced: .*Users can modify it/, 'an existing folder is validated, not silently accepted');
  const source = await readFile(helper, 'utf8'), fn = source.slice(source.indexOf('function New-SecureDirectory'), source.indexOf('function New-RuntimeRoot'));
  assert.match(fn, /if \(Test-Path -LiteralPath \$Path\) \{ Assert-SafeItem \$Path [^}]*return \$false \}/);
});
