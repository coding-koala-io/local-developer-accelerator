import {fileURLToPath} from 'node:url';
import {powershell, psQuote} from './process.js';
export const trayScript = fileURLToPath(new URL('../tray/lda-tray.ps1', import.meta.url));
export async function tray(engine, {atLogin = false, removeAtLogin = false, stop = false, dryRun = false, runner = powershell, cli = fileURLToPath(new URL('../bin/lda.js', import.meta.url))} = {}) {
  if (engine.platform !== 'win32') return 'Windows only in v1; use `lda run`';
  if (dryRun) return `Tray: ${stop ? 'signal quit (services keep running)' : 'start hidden, STA, single instance'}${atLogin ? '; set HKCU Run LocalDeveloperAccelerator' : ''}${removeAtLogin ? '; remove HKCU Run LocalDeveloperAccelerator' : ''}`;
  const quoteArg = s => `"${s}"`;
  const command = `${quoteArg(process.execPath)} ${quoteArg(cli)} tray`;
  const registry = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  if (atLogin) await runner(`New-Item -Path ${psQuote(registry)} -Force | Out-Null; Set-ItemProperty -LiteralPath ${psQuote(registry)} -Name LocalDeveloperAccelerator -Value ${psQuote(command)}`);
  if (removeAtLogin) await runner(`Remove-ItemProperty -LiteralPath ${psQuote(registry)} -Name LocalDeveloperAccelerator -ErrorAction SilentlyContinue`);
  if (stop) {await runner("try { $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $e=[Threading.EventWaitHandle]::OpenExisting('Local\\LdaTrayStop-'+$sid); $e.Set() | Out-Null; $e.Dispose() } catch [Threading.WaitHandleCannotBeOpenedException] {}"); return 'Tray stopped; services keep running.';}
  await engine.writeTray(await engine.status());
  const call = `& ${psQuote(trayScript)} -ConfigFile ${psQuote(engine.paths.tray)}`;
  // Windows PowerShell 5.1 by System32 path; no pwsh 7 PSModulePath reaches the tray.
  await runner(`$ErrorActionPreference='Stop'; Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue; $exe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'; Start-Process -FilePath $exe -WindowStyle Hidden -ArgumentList '-NoProfile','-STA','-ExecutionPolicy','Bypass','-EncodedCommand','${Buffer.from(call, 'utf16le').toString('base64')}'`);
  return 'Tray started; services keep running when you quit the tray.';
}
