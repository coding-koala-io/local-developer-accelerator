import os from 'node:os';
import {statfs, access} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {catalog, wrapperSha256} from './catalog.js';
import {runtimePaths, isWithin, windowsPaths} from './paths.js';
import {sha256} from './verify.js';
import {powershell, psQuote} from './process.js';
import {tarPath} from './archive.js';
const exec = promisify(execFile);
// The elevated helper registers services with the node.exe found on PATH; check that one, not this process.
async function serviceNode({platform, ps}) {
  if (platform !== 'win32') return process.execPath;
  try {return (await ps('(Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source')) || process.execPath;} catch {return process.execPath;}
}
async function versionOf(node) {
  if (node === process.execPath) return process.versions.node;
  try {return (await exec(node, ['--version'], {windowsHide: true, timeout: 5000})).stdout.trim().replace(/^v/, '');} catch {return '0.0.0';}
}
const follow = (file, real) => {try {return real(file);} catch {return file;}};
export async function doctor(engine, {online = false, ps = powershell, hash = sha256, disk = statfs, exists = access, fetcher = fetch, nodeVersion, nodePath, realpath = realpathSync, platform = process.platform, osVersion = os.release(), env = process.env, now = Date.now} = {}) {
  const checks = [], add = (name, ok, message, fix) => checks.push({name, ok: !!ok, message, fix});
  const node = follow(nodePath || await serviceNode({platform, ps}), realpath), version = nodeVersion || await versionOf(node);
  add('Node', Number(version.split('.')[0]) >= 24, `${version} at ${node}`, 'Install Node 24 or newer.');
  add('Node location', !/\\(?:Users|AppData|nvm)\\|\/(?:home|Users)\//i.test(node), node, 'Use an administrator-managed Node installation in Program Files for Windows services.');
  add('Windows version', platform === 'win32', `${platform} ${osVersion}`, 'Windows only in v1; use `lda run` on macOS/Linux.');
  if (platform === 'win32') {const tar = tarPath({platform, env}); try {await exists(tar); add('tar', true, tar, '');} catch {add('tar', false, `${tar} not found`, 'Windows 10 1803 or newer includes tar.exe in System32; repair Windows or update it.');}}
  else add('tar', true, 'tar (foreground extraction)', '');
  const rows = await engine.status();
  for (const mod of catalog) {
    const s = rows.find(r => r.module === mod.key), prefix = mod.key;
    // A legacy service is fixed by adopting it, never by start/reinstall.
    const fix = normal => s.legacy ? `Run lda adopt ${mod.key}; it keeps the data folder and port.` : normal;
    add(`${prefix} service`, s.installed && !s.legacy && s.serviceState === 'running', s.state, s.legacy ? fix() : `Run lda ${s.installed ? 'start' : 'install'} ${mod.key}.`);
    add(`${prefix} legacy service`, !(s.legacyPresent || s.legacy), s.legacyPresent || s.legacy ? mod.legacyServiceIds.join(', ') : 'none', `Run lda adopt ${mod.key}.`);
    if (!s.installed) continue;
    add(`${prefix} code path`, !!s.codeDir && isWithin(engine.paths.code, s.codeDir), s.codeDir || s.configError || 'XML unavailable', fix(`Reinstall ${mod.key} into Program Files.`));
    const runtime = runtimePaths(s.runtimeRoot, s.serviceId);
    try {add(`${prefix} WinSW`, (await hash(runtime.wrapper)).toUpperCase() === wrapperSha256, runtime.wrapper, fix(`Remove the mismatched wrapper as Administrator and reinstall ${mod.key}.`));} catch (e) {add(`${prefix} WinSW`, false, e.message, fix(`Run lda doctor in an elevated terminal to verify access, or reinstall ${mod.key}.`));}
    try {add(`${prefix} port owner`, await engine.services.ownsPort(s.port, s.pid), `Port ${s.port}; service PID ${s.pid}`, `Stop the conflicting process, then lda restart ${mod.key}.`);} catch (e) {add(`${prefix} port owner`, false, e.message, 'Run lda doctor in an elevated terminal.');}
    add(`${prefix} health`, s.health?.ok, s.health?.message || `${s.health?.ok ? 'ok' : 'down'}; product ${s.health?.product || (s.health?.legacy ? 'not reported (legacy)' : 'unknown')}`, fix(`Run lda logs ${mod.key}, then lda restart ${mod.key}.`));
    try {
      const acl = JSON.parse(await ps(`$a=Get-Acl -LiteralPath ${psQuote(s.runtimeRoot)} -ErrorAction Stop; @{protected=$a.AreAccessRulesProtected; rules=@($a.Access | ForEach-Object { @{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; type=[string]$_.AccessControlType} })} | ConvertTo-Json -Depth 5 -Compress`));
      add(`${prefix} runtime ACL`, acl.protected && acl.rules.length > 0 && acl.rules.every(r => ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-19'].includes(r.sid) && r.type === 'Allow'), acl.protected ? 'inheritance off; checked explicit identities' : 'inheritance enabled', fix(`Reinstall ${mod.key} to replace runtime permissions.`));
    } catch {add(`${prefix} runtime ACL`, false, 'needs admin to verify', 'Run lda doctor in an elevated terminal.');}
    const drive = windowsPaths(s.runtimeRoot).parse(s.runtimeRoot).root;
    try {const d = await disk(drive); const bytes = Number(d.bavail) * Number(d.bsize); add(`${prefix} free space`, bytes >= 5 * 1024 ** 3, `${(bytes / 1024 ** 3).toFixed(1)} GB available on ${drive}`, 'Free at least 5 GB on the data drive.');} catch (e) {add(`${prefix} free space`, false, e.message, 'Check access to the runtime data drive.');}
  }
  if (online) {
    try {const r = await fetcher('https://api.github.com/', {method: 'HEAD', signal: AbortSignal.timeout(5000)}); const date = Date.parse(r.headers.get('date')); const skew = Math.abs(now() - date); add('Clock', Number.isFinite(date) && skew < 300000, `${Math.round(skew / 1000)} seconds skew from GitHub`, 'Enable automatic time synchronization in Windows settings.');} catch (e) {add('Clock', false, e.message, 'Check the internet connection or run doctor without --online.');}
  }
  return checks;
}
