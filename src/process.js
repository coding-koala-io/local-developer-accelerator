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
// Secrets never reach an error message: tokens, bearer values, key=value secrets and encoded command lines.
export function redact(text) {
  return String(text)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b((?:access[_-]?)?token|password|passwd|pwd|secret|api[_-]?key|sdk[_-]?key|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]')
    .replace(/(-EncodedCommand)\s+\S+/gi, '$1 [redacted]');
}
// Decodes the CLIXML error stream Windows PowerShell writes to a redirected stderr ("#< CLIXML ... <S S="Error">").
function decodeClixml(text) {
  if (!text.includes('#< CLIXML')) return text;
  return [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m => m[1]).join('')
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
// The first meaningful lines a failed command reported: the elevated helper's "ERROR: ..." lines on stdout first,
// then stderr without PowerShell's position and category noise. Redacted and bounded.
export function failureDetail({stderr = '', stdout = ''} = {}) {
  const helper = String(stdout || '').split(/\r?\n/).map(l => l.trim()).filter(l => /^ERROR:/.test(l)).map(l => l.replace(/^ERROR:\s*/, ''));
  const noise = /^(?:At line:\d+|At .*:\d+ char:\d+|\+|~+$|CategoryInfo\s*:|FullyQualifiedErrorId\s*:|#< CLIXML)/;
  const errors = decodeClixml(String(stderr || '')).split(/\r?\n/).map(l => l.trim()).filter(l => l && !noise.test(l));
  const text = redact([...helper, ...errors].slice(0, 2).join(' ').replace(/\s+/g, ' ').trim());
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}
export async function powershell(script, {runner = exec, platform = process.platform, env = process.env, ...opts} = {}) {
  try {
    const {stdout} = await runner(windowsPowerShellPath({platform, env}), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue'; ${script}`, 'utf16le').toString('base64')], {windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts, env: childEnv(env)});
    return stdout.trim().replace(/^﻿/, '');
  } catch (e) {
    const detail = `${e.message} ${e.stderr || ''}`;
    if (e.code === 1223 || /cancel[l]?ed by the user/.test(detail)) throw Object.assign(new Error('Cancelled at the Windows prompt'), {code: 1223});
    const reason = /access (?:is )?denied/i.test(detail) ? 'access denied' : e.code === 'ENOENT' ? 'PowerShell is unavailable' : `command failed${typeof e.code === 'number' ? ` (exit ${e.code})` : ''}`;
    // Say what Windows actually reported, not only that something failed.
    const said = e.code === 'ENOENT' ? '' : failureDetail(e);
    throw Object.assign(new Error(`Windows ${reason}${said ? `: ${said.replace(/[.\s]+$/, '')}` : ''}. Run lda doctor from a regular Windows terminal and retry.`, {cause: e}), {code: e.code, stderr: e.stderr, detail: said});
  }
}
export async function openUrl(url, {platform = process.platform, runner = exec} = {}) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url)) throw new Error('Dashboard URL must be local.');
  if (platform === 'win32') return powershell(`Start-Process ${psQuote(url)}`, {runner});
  return runner(platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}
export function spawnChild(...args) { return spawn(...args); }
