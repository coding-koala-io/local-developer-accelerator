import {mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {powershell, psQuote, failureDetail} from './process.js';
import {planSteps} from './plan.js';
export const helper = fileURLToPath(new URL('../elevated/lda-service.ps1', import.meta.url));
export class CancelledError extends Error { constructor() {super('Cancelled at the Windows prompt'); this.exitCode = 2;} }
export function createElevator({paths, platform = process.platform, runner = powershell, progress = () => {}}) {
  return async (plan, {dryRun = false} = {}) => {
    if (dryRun && platform !== 'win32') return {ok: true, dryRun: true, operations: plan.operations, log: planSteps(plan)};
    if (platform !== 'win32') return {ok: false, unsupported: true, log: ['Windows only in v1; use `lda run`']};
    await mkdir(paths.plans, {recursive: true, mode: 0o700});
    // Replace the DACL, including previously inherited ACEs, before writing a plan. SetAccessControl writes only the
    // owner and DACL; Set-Acl also tries the audit (SACL) section once the folder is protected, which needs
    // SeSecurityPrivilege, so every run after the first failed for a normal user.
    await runner(`$ErrorActionPreference='Stop'; $d=${psQuote(paths.plans)}; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a.SetOwner($sid); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); (Get-Item -LiteralPath $d -Force).SetAccessControl($a)`);
    const id = randomUUID(), planFile = path.join(paths.plans, `${id}.plan.json`), resultFile = path.join(paths.plans, `${id}.result.json`);
    const text = JSON.stringify(plan), hash = createHash('sha256').update(text).digest('hex');
    await writeFile(planFile, text, {mode: 0o600, flag: 'wx'});
    const call = `& ${psQuote(helper)} -PlanFile ${psQuote(planFile)} -PlanSha256 ${psQuote(hash)} -ResultFile ${psQuote(resultFile)}`;
    const encoded = Buffer.from(call, 'utf16le').toString('base64');
    try {
      if (dryRun) {
        const output = await runner(`${call} -DryRun`, {planFile, resultFile, dryRun: true});
        const log = String(output).split(/\r?\n/).filter(Boolean);
        // ok is false when a read-only check showed that the real run would stop (the helper's summary line).
        return {ok: !log.some(l => l.startsWith('DRY RUN RESULT: the real run would stop')), dryRun: true, operations: plan.operations, log};
      }
      progress('Waiting for Windows approval…');
      await runner(`$ErrorActionPreference='Stop'; try { Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue; $exe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'; if(!(Test-Path -LiteralPath $exe -PathType Leaf)){throw 'Windows PowerShell was not found in System32.'}; $p=Start-Process -FilePath $exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; if($p.ExitCode -eq 1223){exit 1223} } catch { if($_.Exception.NativeErrorCode -eq 1223 -or $_ -match 'cancel[l]?ed by the user'){exit 1223}; throw }`, {planFile, resultFile});
      const result = JSON.parse(await readFile(resultFile, 'utf8'));
      if (typeof result.ok !== 'boolean' || !Array.isArray(result.operations)) throw new Error('Invalid helper result. Run lda doctor.');
      return result;
    } catch (e) {
      if (e.code === 1223 || e.exitCode === 1223 || /cancel[l]?ed by the user|1223/.test(`${e.message} ${e.stderr || ''}`)) throw new CancelledError();
      if (e.code === 'ENOENT') throw new Error('Windows helper returned no result. Run lda doctor and retry.');
      // The helper's own explanation, when it wrote one before the command failed.
      const said = await helperMessage(resultFile);
      if (said && !e.message.includes(said)) e.message = `${e.message} Helper: ${said}`;
      throw e;
    } finally { await Promise.all([rm(planFile, {force: true}), rm(resultFile, {force: true})]); }
  };
}
async function helperMessage(file) {
  try {
    const r = JSON.parse(await readFile(file, 'utf8'));
    const said = [...(Array.isArray(r.log) ? r.log : []), ...(Array.isArray(r.operations) ? r.operations.map(o => o?.message) : [])].filter(m => typeof m === 'string' && m && m !== 'Completed').at(-1);
    return said ? failureDetail({stderr: said}) : '';
  } catch {return '';}
}
