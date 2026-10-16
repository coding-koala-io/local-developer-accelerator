import {readFile} from 'node:fs/promises';
import net from 'node:net';
import {catalog} from './catalog.js';
import {runtimePaths, windowsPaths} from './paths.js';
import {powershell} from './process.js';
import {versionPattern} from './verify.js';
const decode = s => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}[k]));
export function parseServiceXml(xml) {
  const tag = name => decode(xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))?.[1] || '');
  const env = {};
  for (const match of xml.matchAll(/<env\s+([^>]+)\/?\s*>/gi)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w]+)=["']([^"']*)["']/g)].map(m => [m[1], decode(m[2])]));
    if (attributes.name) env[attributes.name] = attributes.value;
  }
  const args = tag('arguments'), codeDir = args.match(/"([^"\r\n]+)[\\/]src[\\/]server\.js"/)?.[1] || tag('workingdirectory');
  const folder = codeDir && windowsPaths(codeDir).basename(codeDir);
  return {id: tag('id'), executable: tag('executable'), args, env, codeDir, version: versionPattern.test(folder || '') ? folder : undefined, port: Number(env.PORT), memoryMb: Number(args.match(/--max-old-space-size=(\d+)/)?.[1]) || undefined};
}
export function createServices({platform = process.platform, ps = powershell, read = readFile} = {}) {
  async function query() {
    if (platform !== 'win32') return [];
    const names = catalog.flatMap(m => [m.serviceId, ...m.legacyServiceIds]).map(n => `Name='${n}'`).join(' OR ');
    let raw;
    try {raw = await ps(`$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Service -Filter "${names}" | Select-Object Name,State,ProcessId,PathName) | ConvertTo-Json -Compress`);}
    catch {
      // WMI access can be denied by a restricted host even though SCM and HKLM reads work.
      const ids = catalog.flatMap(m => [m.serviceId, ...m.legacyServiceIds]).map(n => `'${n}'`).join(',');
      raw = await ps(`$ErrorActionPreference='Stop'; $rows=@(foreach($id in @(${ids})){ $s=Get-Service -Name $id -ErrorAction SilentlyContinue; if(!$s){continue}; $r=Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\'+$id); $q=(& sc.exe queryex $id) -join [Environment]::NewLine; $processId=0; if($q -match '(?m)^\\s*PID\\s*:\\s*(\\d+)'){$processId=[int]$Matches[1]}; @{Name=$id; State=[string]$s.Status; ProcessId=$processId; PathName=$r.ImagePath} }); ConvertTo-Json -InputObject $rows -Compress`);
    }
    const parsed = raw ? JSON.parse(raw) : []; return Array.isArray(parsed) ? parsed : [parsed];
  }
  async function describe(mod, rows) {
    const service = rows.find(s => s.Name === mod.serviceId) || rows.find(s => mod.legacyServiceIds.includes(s.Name));
    if (!service) return {module: mod.key, product: mod.product, installed: false, state: 'not installed', port: mod.port};
    const exe = service.PathName.match(/^"([^"]+)"/)?.[1] || service.PathName.trim();
    const p = windowsPaths(exe), runtimeRoot = p.dirname(p.dirname(exe)), paths = runtimePaths(runtimeRoot, service.Name);
    let config = {}, configError;
    try { config = parseServiceXml(await read(paths.xml, 'utf8')); } catch (e) { configError = e.message; }
    const legacy = service.Name !== mod.serviceId;
    // Legacy services run from a source folder, not a version folder: never derive a version from it.
    return {module: mod.key, product: mod.product, installed: true, legacy, legacyPresent: rows.some(s => mod.legacyServiceIds.includes(s.Name)), serviceId: service.Name, state: legacy ? 'legacy install' : service.State.toLowerCase(), serviceState: service.State.toLowerCase(), pid: service.ProcessId, pathName: service.PathName, runtimeRoot, ...config, version: legacy ? 'legacy' : config.version, port: config.port || mod.port, configError};
  }
  return {query, describe, async owner(port) {
    if (platform !== 'win32') return 'another process';
    return await ps(`Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "PID $($_.OwningProcess) ($($p.ProcessName))" }`) || 'another process';
  }, async ownsPort(port, pid) {
    if (platform !== 'win32') return null;
    const raw = await ps(`$listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue); $owned=($listeners.Count -gt 0); foreach($l in $listeners){ $n=[int]$l.OwningProcess; $seen=@{}; while($n -gt 0 -and $n -ne ${Number(pid)} -and !$seen.ContainsKey($n)){ $seen[$n]=$true; $p=Get-CimInstance Win32_Process -Filter "ProcessId=$n"; if(!$p){break}; $n=[int]$p.ParentProcessId }; if($n -ne ${Number(pid)}){$owned=$false} }; $owned | ConvertTo-Json`);
    return JSON.parse(raw);
  }};
}
export async function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', e => e.code === 'EADDRINUSE' || e.code === 'EACCES' ? resolve(false) : reject(e));
    server.listen({host: '127.0.0.1', port, exclusive: true}, () => server.close(() => resolve(true)));
  });
}
