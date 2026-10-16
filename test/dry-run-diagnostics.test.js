// Failure reporting and admin-free dry runs. Nothing elevates, changes a service or uses the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {powershell, failureDetail, redact} from '../src/process.js';
import {createElevator} from '../src/elevate.js';
import {fixture, winPs, isElevated} from './helpers.js';
const helper = fileURLToPath(new URL('../elevated/lda-service.ps1', import.meta.url));
const skip = process.platform !== 'win32';
const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Set-Acl : The process does not possess the &apos;SeSecurityPrivilege&apos; privilege which is required for this operation._x000D__x000A_</S><S S="Error">At line:1 char:477_x000D__x000A_</S><S S="Error">+ ... Set-Acl -LiteralPath $d -AclObject $a_x000D__x000A_</S><S S="Error">    + CategoryInfo          : PermissionDenied: (C:\\x:String) [Set-Acl], PrivilegeNotHeldException_x000D__x000A_</S></Objs>';
const failing = fields => async () => {throw Object.assign(new Error('Command failed: powershell.exe -EncodedCommand QQBCAEMA'), {code: 1, stdout: '', stderr: '', ...fields});};

test('failureDetail decodes the CLIXML error stream and drops position and category noise', () => {
  assert.equal(failureDetail({stderr: clixml}), "Set-Acl : The process does not possess the 'SeSecurityPrivilege' privilege which is required for this operation.");
});
test('failureDetail puts the helper ERROR line first and bounds the length', () => {
  assert.equal(failureDetail({stdout: 'DRY RUN: adopt graph\nERROR: Plan SHA-256 mismatch.', stderr: 'other'}), 'Plan SHA-256 mismatch. other');
  assert.ok(failureDetail({stderr: 'x'.repeat(2000)}).length <= 400);
});
test('redact removes tokens, bearer values, key=value secrets and encoded commands', () => {
  const out = redact('token=abc123 password: "p w" ghp_abcdefghijklmnop Bearer abcdefghijklmnop sdkKey=Qx12 -EncodedCommand QQBCAEMA');
  for (const secret of ['abc123', 'p w', 'ghp_abcdefghijklmnop', 'abcdefghijklmnop', 'Qx12', 'QQBCAEMA']) assert.ok(!out.includes(secret), secret);
});
test('powershell() failure names what Windows reported instead of a bare exit code', async () => {
  await assert.rejects(powershell('Set-Acl', {platform: 'win32', runner: failing({stderr: clixml})}), e => {
    assert.match(e.message, /^Windows command failed \(exit 1\): Set-Acl : The process does not possess the 'SeSecurityPrivilege' privilege which is required for this operation\. Run lda doctor/);
    assert.ok(!e.message.includes('QQBCAEMA'), 'no encoded command'); assert.ok(!e.message.includes('At line'));
    return true;
  });
});
test('powershell() failure surfaces the helper ERROR line and keeps secrets out', async () => {
  await assert.rejects(powershell('x', {platform: 'win32', runner: failing({stdout: 'ERROR: Refusing to use D:\\Data: NT AUTHORITY\\Authenticated Users can modify it.', stderr: 'token=supersecret'})}), e => {
    assert.match(e.message, /: Refusing to use D:\\Data: NT AUTHORITY\\Authenticated Users can modify it/); assert.ok(!e.message.includes('supersecret')); return true;
  });
  await assert.rejects(powershell('x', {platform: 'win32', runner: failing({})}), e => /^Windows command failed \(exit 1\)\. Run lda doctor/.test(e.message));
});
test('elevator adds the helper result-file message when the command fails after the helper wrote it', async t => {
  const f = await fixture(t);
  const runner = async (script, opts = {}) => {
    if (!opts.resultFile) return '';
    await writeFile(opts.resultFile, JSON.stringify({ok: false, operations: [{op: 'start', module: 'graph', ok: false, message: 'Port 8082 is in use by PID 9 (node). Use --port <free-port>.'}], log: []}));
    throw Object.assign(new Error('Windows command failed (exit 1). Run lda doctor from a regular Windows terminal and retry.'), {code: 1});
  };
  await assert.rejects(createElevator({paths: f.paths, platform: 'win32', runner})({version: 1, operations: [{op: 'start', module: 'graph'}]}), /Helper: Port 8082 is in use by PID 9/);
  assert.deepEqual(await readdir(f.paths.plans), []);
});
test('dry-run result is not ok when the helper reports that the real run would stop', async t => {
  const f = await fixture(t);
  const runner = async (script, opts = {}) => opts.dryRun ? 'DRY RUN: adopt graph\n  WOULD STOP: Refusing to use D:\\Data: x can modify it.\nDRY RUN RESULT: the real run would stop at 1 check(s) above. Fix them, then retry.' : '';
  const r = await createElevator({paths: f.paths, platform: 'win32', runner})({version: 1, operations: [{op: 'adopt', module: 'graph'}]}, {dryRun: true});
  assert.equal(r.ok, false); assert.equal(r.dryRun, true); assert.ok(r.log.some(l => l.includes('WOULD STOP')));
  const clean = await createElevator({paths: f.paths, platform: 'win32', runner: async (s, o = {}) => o.dryRun ? 'DRY RUN: start graph' : ''})({version: 1, operations: [{op: 'start', module: 'graph'}]}, {dryRun: true});
  assert.equal(clean.ok, true);
});
test('plans folder lock works on every run, not only the first (no SACL write, no admin)', {skip}, async t => {
  const f = await fixture(t);
  const runner = (script, opts = {}) => opts.dryRun ? 'DRY RUN: start graph' : powershell(script);
  const elevator = createElevator({paths: f.paths, platform: 'win32', runner});
  for (let i = 0; i < 3; i++) assert.equal((await elevator({version: 1, operations: [{op: 'start', module: 'graph'}]}, {dryRun: true})).ok, true, `run ${i + 1}`);
  const acl = JSON.parse(await powershell(`$a=Get-Acl -LiteralPath '${f.paths.plans.replaceAll("'", "''")}'; @{p=$a.AreAccessRulesProtected; n=@($a.Access).Count; me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; sid=@($a.Access)[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value} | ConvertTo-Json -Compress`));
  assert.equal(acl.p, true); assert.equal(acl.n, 1); assert.equal(acl.sid, acl.me);
});

// Real helper -DryRun against synthetic folders the test owns.
async function dryRun(f, operation) {
  const file = path.join(f.root, `plan-${Date.now()}.json`), text = JSON.stringify({version: 1, createdAt: new Date().toISOString(), operations: [operation]});
  await writeFile(file, text);
  const {stdout} = await winPs(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-PlanFile', file, '-PlanSha256', createHash('sha256').update(text).digest('hex'), '-DryRun'], {env: {...process.env, LOCALAPPDATA: f.root}});
  return stdout;
}
const install = (f, runtimeRoot) => ({op: 'install', module: 'graph', version: '1.2.0', zip: path.join(f.paths.cache, 'release.zip'), sha256: 'a'.repeat(64), port: 40000 + Math.floor(Math.random() * 20000), runtimeRoot, memoryMb: 8192});
const ps = code => winPs(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; ${code}`, 'utf16le').toString('base64')]);
const lit = p => `'${p.replaceAll("'", "''")}'`;

// Administrators/SYSTEM full plus the given extra entries, protected, owned by the test user (who keeps the right to undo it).
const protect = (dir, extra = '') => ps(`$a=New-Object Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); foreach($s in 'S-1-5-18','S-1-5-32-544'){$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($s)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}; ${extra} (Get-Item -LiteralPath ${lit(dir)}).SetAccessControl($a)`);
const unprotect = dir => ps(`icacls ${lit(dir)} /reset /T /C /Q | Out-Null`).catch(() => {});
const fullPath = async p => (await ps(`[IO.Path]::GetFullPath(${lit(p)})`)).stdout.trim();

test('real helper DryRun reports a folder Authenticated Users can modify with the exact fix, and the fix works', {skip}, async t => {
  const f = await fixture(t), shared = path.join(f.root, 'shared'), inner = path.join(shared, 'inner'), runtime = path.join(inner, 'Graph');
  await mkdir(inner, {recursive: true});
  // Like D:\OptimizelyLocal: Administrators/SYSTEM plus Authenticated Users Modify, which "inner" inherits.
  await protect(shared, `$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-11')),'Modify','ContainerInherit,ObjectInherit','None','Allow')));`);
  try {
    const out = await dryRun(f, install(f, runtime)), sharedFull = await fullPath(shared), innerFull = await fullPath(inner);
    assert.match(out, /Checks for install graph \(read-only, without admin\):/);
    for (const dir of [sharedFull, innerFull]) assert.ok(out.includes(`WOULD STOP: Refusing to use ${dir}: NT AUTHORITY\\Authenticated Users can modify it.`), out);
    const fixFor = dir => out.split(/\r?\n/).find(l => l.includes(`Fix: remove write access for NT AUTHORITY\\Authenticated Users from ${dir} (read access is kept). In an elevated PowerShell run: `));
    // An explicit entry is removed directly; an inherited one needs inheritance turned off first.
    assert.ok(fixFor(sharedFull)?.endsWith(`icacls ${lit(sharedFull)} /remove:g '*S-1-5-11'; icacls ${lit(sharedFull)} /grant '*S-1-5-11:(OI)(CI)(RX)'`), out);
    assert.ok(fixFor(sharedFull).indexOf('/inheritance:d') === -1);
    assert.ok(fixFor(innerFull)?.endsWith(`icacls ${lit(innerFull)} /inheritance:d; icacls ${lit(innerFull)} /remove:g '*S-1-5-11'; icacls ${lit(innerFull)} /grant '*S-1-5-11:(OI)(CI)(RX)'`), out);
    assert.match(out, /DRY RUN RESULT: the real run would stop at \d+ check\(s\) above\. Fix them, then retry\./);
    assert.ok(!out.includes('ERROR:'));
    // The suggested commands clear both refusals (the test owns the folders, so no elevation is needed here).
    for (const dir of [sharedFull, innerFull]) await ps(`${fixFor(dir).split('In an elevated PowerShell run: ')[1]} | Out-Null`);
    const after = await dryRun(f, install(f, runtime));
    for (const dir of [sharedFull, innerFull]) assert.ok(after.includes(`OK: owner and write access of ${dir}.`), after);
  } finally {await unprotect(shared);}
});
test('real helper DryRun never suggests removing your own access from a folder you can write (your profile)', {skip}, async t => {
  const f = await fixture(t), out = await dryRun(f, install(f, path.join(f.root, 'mine', 'Graph')));
  const me = (await ps('[Security.Principal.WindowsIdentity]::GetCurrent().Name')).stdout.trim();
  const own = out.split(/\r?\n/).filter(l => l.includes('Fix:') && l.includes(me));
  assert.ok(own.length, out);
  for (const line of own) {assert.match(line, /Fix: use a data folder that only administrators can change/); assert.ok(!line.includes('icacls'), line);}
});
test('real helper DryRun says "needs admin" for a data folder it cannot list instead of failing', {skip}, async t => {
  const f = await fixture(t), runtime = path.join(f.root, 'locked', 'Graph');
  await mkdir(runtime, {recursive: true}); await writeFile(path.join(runtime, 'tenants.json'), '{}');
  await protect(runtime);
  try {
    const out = await dryRun(f, install(f, runtime)), full = await fullPath(runtime);
    const tree = `folders and files inside ${full} (service, data, logs, wrapper, XML, runtime marker; no junctions)`;
    assert.ok(!out.includes('ERROR:'), out); assert.ok(!out.includes('Windows command failed'), out);
    if (!(await isElevated())) {
      assert.ok(out.includes(`Would check the ${tree} (needs admin).`), out);
      return;
    }
    // Elevated (hosted CI runners): Administrators can list the locked folder, so the helper performs the real
    // checks instead of saying "needs admin". The folder's own checks ran, and the inside check either ran or was
    // deferred only because a parent folder (the runner's writable profile) would stop the real run first.
    assert.ok(!out.includes(`Would check the ${tree} (needs admin).`), out);
    assert.ok(out.includes(`OK: owner and write access of ${full}.`), out);
    assert.ok(out.includes(`OK: contents of ${full} are empty or a runtime layout.`), out);
    const lines = out.split(/\r?\n/).map(l => l.trim()), at = lines.indexOf(`OK: contents of ${full} are empty or a runtime layout.`), next = lines[at + 1] || '';
    assert.ok(next === `OK: ${tree}.` || next.startsWith('WOULD STOP: ') ||
      (next === `Would check the ${tree} once the folders above are fixed.` && lines.slice(0, at).some(l => l.startsWith('WOULD STOP: '))), out);
  } finally {await unprotect(runtime);}
});
test('real helper DryRun reports a missing service as a stop, not a crash', {skip}, async t => {
  const f = await fixture(t), out = await dryRun(f, {op: 'rollback', module: 'graph'});
  // LdaGraph is not installed on a test machine (an installed one is reported with its checks instead).
  assert.ok(/WOULD STOP: Service is not installed\.|Checks for rollback graph/.test(out), out);
  assert.ok(!out.includes('ERROR:'));
});

// Re-running a permission change on an already locked folder (upgrade, adopt, repair) must not need SeSecurityPrivilege:
// the helper writes only owner and DACL (SetAccessControl), never the SACL (Set-Acl did on a protected folder).
test('helper permission functions work twice in a row on an already locked folder (no SACL write)', {skip}, async t => {
  const f = await fixture(t), folder = path.join(f.root, 'locked-runtime'), files = path.join(f.root, 'files'), file = path.join(files, 'own.log');
  await mkdir(folder); await mkdir(files); await writeFile(file, '');
  const load = names => `$ast=[Management.Automation.Language.Parser]::ParseFile(${lit(helper)},[ref]$null,[ref]$null); foreach($n in @(${names.map(lit).join(',')})){$fn=$ast.Find({param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n},$true); $text=$fn.Extent.Text; if($n -eq 'Set-RestrictedDirectoryAcl'){ $text=$text.Replace("SecurityIdentifier('S-1-5-32-544')))", 'SecurityIdentifier($me))); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($me)),''FullControl'',''ContainerInherit,ObjectInherit'',''None'',''Allow'')))') }; . ([scriptblock]::Create($text))}`;
  try {
    // Only the owner line is adapted: a non-elevated test cannot hand ownership to Administrators, so the test user
    // stands in for them (owner plus the full control Administrators keep in the real DACL).
    const {stdout} = await ps(`$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ${load(['New-RestrictedSecurity', 'Set-RestrictedDirectoryAcl', 'Grant-LocalServiceAccess'])}
      $d=${lit(folder)}; $f=${lit(file)}
      $fs=New-Object Security.AccessControl.FileSecurity; $fs.SetAccessRuleProtection($true,$false); $fs.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($me)),'FullControl','Allow'))); (Get-Item -LiteralPath $f).SetAccessControl($fs)
      foreach($k in 'Runtime','Service','Code'){ foreach($i in 1,2){ if($k -eq 'Runtime'){Set-RestrictedDirectoryAcl $d} elseif($k -eq 'Service'){Set-RestrictedDirectoryAcl $d -Service} else {Set-RestrictedDirectoryAcl $d -Code} } }
      foreach($i in 1,2){ Grant-LocalServiceAccess $d }
      foreach($i in 1,2){ Grant-LocalServiceAccess $f -File }
      $ls={param($a) @($a.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -eq 'S-1-5-19'}) | ForEach-Object {[string]$_.FileSystemRights}}
      $da=Get-Acl -LiteralPath $d; $fa=Get-Acl -LiteralPath $f
      @{dirProtected=$da.AreAccessRulesProtected; dirOwner=$da.GetOwner([Security.Principal.SecurityIdentifier]).Value; dirLocalService=@(& $ls $da); fileProtected=$fa.AreAccessRulesProtected; fileLocalService=@(& $ls $fa); me=$me} | ConvertTo-Json -Compress`);
    const out = JSON.parse(stdout.trim());
    assert.equal(out.dirProtected, true); assert.equal(out.dirOwner, out.me);
    assert.ok(out.dirLocalService.length === 1 && /Modify/.test(out.dirLocalService[0]), JSON.stringify(out));
    assert.equal(out.fileProtected, true); assert.ok(out.fileLocalService.length === 1 && /Modify/.test(out.fileLocalService[0]), JSON.stringify(out));
  } finally {await unprotect(folder); await unprotect(files);}
});
