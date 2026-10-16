import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);
export const psQuote = v => `'${String(v).replaceAll("'", "''")}'`;
// Windows PowerShell 5.1 by absolute path, so a pwsh 7 (or other) powershell.exe earlier on PATH is never used.
export function windowsPowerShellPath({platform = process.platform, env = process.env} = {}) {
  if (platform !== 'win32') return 'powershell.exe';
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
// Copy of env without PSModulePath (any casing): a PSModulePath inherited from pwsh 7 makes 5.1 load
// PowerShell 7 core modules and fail (for example "Get-Acl ... module could not be loaded").
export function childEnv(env = process.env) {
  const out = {...env};
  for (const k of Object.keys(out)) if (k.toLowerCase() === 'psmodulepath') delete out[k];
  return out;
}
export async function powershell(script, {runner = exec, platform = process.platform, env = process.env, ...opts} = {}) {
  try {
    const {stdout} = await runner(windowsPowerShellPath({platform, env}), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue'; ${script}`, 'utf16le').toString('base64')], {windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts, env: childEnv(env)});
    return stdout.trim().replace(/^\uFEFF/, '');
  } catch (e) {
    const detail = `${e.message} ${e.stderr || ''}`;
    if (e.code === 1223 || /cancel[l]?ed by the user/.test(detail)) throw Object.assign(new Error('Cancelled at the Windows prompt'), {code: 1223});
    const reason = /access (?:is )?denied/i.test(detail) ? 'access denied' : e.code === 'ENOENT' ? 'PowerShell is unavailable' : `command failed${typeof e.code === 'number' ? ` (exit ${e.code})` : ''}`;
    throw Object.assign(new Error(`Windows ${reason}. Run lda doctor from a regular Windows terminal and retry.`, {cause: e}), {code: e.code, stderr: e.stderr});
  }
}
export async function openUrl(url, {platform = process.platform, runner = exec} = {}) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url)) throw new Error('Dashboard URL must be local.');
  if (platform === 'win32') return powershell(`Start-Process ${psQuote(url)}`, {runner});
  return runner(platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}
export function spawnChild(...args) { return spawn(...args); }
