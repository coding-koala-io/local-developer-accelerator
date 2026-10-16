import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {catalog,wrapperSha256} from '../src/catalog.js';
import {fixture, winPs} from './helpers.js';
const exec=promisify(execFile),helper=fileURLToPath(new URL('../elevated/lda-service.ps1',import.meta.url)),tray=fileURLToPath(new URL('../tray/lda-tray.ps1',import.meta.url));
const psQuote=s=>`'${s.replaceAll("'","''")}'`;
test('PowerShell module table is identical to catalogue data',async()=>{
  const source=await readFile(helper,'utf8');for(const m of catalog){const table=source.match(new RegExp(`${m.key} = @\\{([^\\n]+)\\}`))?.[1];assert.ok(table);for(const [key,value] of Object.entries({Product:m.product,CompatibleWith:m.compatibleWith,Repo:m.repo,Port:m.port,ServiceId:m.serviceId,LegacyServiceId:m.legacyServiceIds[0],RuntimeFolder:m.runtimeFolder,MemoryMb:m.options.memoryMb?.default||0}))assert.ok(table.includes(`${key}=${typeof value==='string'?`'${value}'`:value}`),`${m.key}.${key}`);}assert.ok(source.includes(wrapperSha256));
});
test('elevated helper retains the required safety barriers',async()=>{
  const source=await readFile(helper,'utf8');for(const text of ['SetAccessRuleProtection($true,$false)','Assert-SafeItem','Assert-RuntimeTree','Assert-OperationTrust','Test-OwnedProcess','Assert-NoReparse','Assert-SafeRemoval','previous XML restored','Hash-File $sealed','if (!(Test-Path -LiteralPath (Join-Path $ctx.Root \'tenants.json\')))'])assert.ok(source.includes(text),text);
  assert.equal((source.match(/ReadAllBytes\(\$PlanFile\)/g)||[]).length,1);assert.ok(source.indexOf('Hash-Bytes $bytes) -ne $PlanSha256')<source.indexOf('$plan=$utf8.GetString($bytes) | ConvertFrom-Json'));
});
for(const script of [helper,tray])test(`PowerShell parser accepts ${path.basename(script)}`,{skip:process.platform!=='win32'},async()=>{
  const code=`$tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseFile(${psQuote(script)},[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}`;
  await winPs(['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')]);
});
test('tray menu has all required actions and user-session safety',async()=>{const source=await readFile(tray,'utf8');for(const text of ['Open dashboard','Start','Stop','Restart','View logs','Start all','Stop all','Open hub','Updates available','Run doctor','Settings','Start at login','Check for updates daily','About','Quit tray (services keep running)','Threading.Mutex','Threading.EventWaitHandle','Interval=10000'])assert.ok(source.includes(text),text);assert.ok(!source.includes('-Verb RunAs'));});
for(const op of ['install','upgrade','adopt','rollback','uninstall','start','stop','restart'])test(`real helper -DryRun: ${op} (never elevates)`,{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);const operation={op,module:'graph'};
  if(['install','upgrade','adopt'].includes(op))Object.assign(operation,{version:'1.2.0',zip:path.join(f.paths.cache,'release.zip'),sha256:'a'.repeat(64)});
  if(op==='install')Object.assign(operation,{port:8082,runtimeRoot:'D:\\SyntheticRuntime',memoryMb:8192});if(op==='adopt')operation.legacyServiceId='OptimizelyGraphLocal';if(op==='uninstall')operation.purge=true;
  const file=path.join(f.root,'plan.json'),text=JSON.stringify({version:1,createdAt:new Date().toISOString(),operations:[operation]});await writeFile(file,text);const hash=createHash('sha256').update(text).digest('hex');
  const {stdout}=await winPs(['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-PlanFile',file,'-PlanSha256',hash,'-DryRun'],{env:{...process.env,LOCALAPPDATA:f.root}});assert.match(stdout,new RegExp(`DRY RUN: ${op} graph`));assert.ok(!stdout.includes('ERROR:'));
});
test('real helper DryRun rejects tampered plan hash before any steps',{skip:process.platform!=='win32'},async t=>{const f=await fixture(t),file=path.join(f.root,'bad.json');await writeFile(file,'{}');await assert.rejects(winPs(['-NoProfile','-NonInteractive','-File',helper,'-PlanFile',file,'-PlanSha256','0'.repeat(64),'-DryRun'],{env:{...process.env,LOCALAPPDATA:f.root}}),e=>e.stdout.includes('Plan SHA-256 mismatch')&&!e.stdout.includes('DRY RUN:'));});
for(const fail of [false,true])test(`XML switch ${fail?'failure restores previous configuration':'success preserves port, memory and environment'} with all service/health calls faked`,{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),oldCode=path.join(f.root,'Graph','1.0.0'),newCode=path.join(f.root,'Graph','1.2.0'),xmlFile=path.join(f.root,'service.xml');
  const xml=`<service><id>LdaGraph</id><arguments>--max-old-space-size=9000 &quot;${oldCode}\\src\\server.js&quot;</arguments><workingdirectory>${oldCode}</workingdirectory><env name="PORT" value="9010"/><env name="CUSTOM" value="kept"/></service>`;
  await writeFile(xmlFile,xml);
  // Load ONLY the XML-switch function through its AST. Every service/health dependency is a fake.
  const code=`$ErrorActionPreference='Stop'; $utf8=New-Object Text.UTF8Encoding($false); $result=@{log=@()}; $events=New-Object Collections.Generic.List[string]; $ast=[Management.Automation.Language.Parser]::ParseFile(${psQuote(helper)},[ref]$null,[ref]$null); $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Switch-Code'},$true); . ([scriptblock]::Create($fn.Extent.Text)); function Current-Code($c){return ${psQuote(oldCode)}}; function Assert-CodeTarget($p){}; function Assert-Port($c){}; function Stop-Module($c){$events.Add('stop')}; function Invoke-Wrapper($c,$a){$events.Add($a)}; function Wait-Healthy($c,$v){if(${fail?'$true':'$false'} -and $v -eq '1.2.0'){throw 'synthetic unhealthy release'}}; $ctx=@{Xml=${psQuote(xmlFile)}}; try {Switch-Code $ctx ${psQuote(newCode)} '1.2.0'; if(${fail?'$true':'$false'}){throw 'expected failure'}} catch {if(!${fail?'$true':'$false'} -or $_ -notmatch 'previous XML restored'){throw}}; $events | ConvertTo-Json -Compress`;
  const {stdout}=await winPs(['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')]);
  const changed=await readFile(xmlFile,'utf8');if(fail){assert.equal(changed,xml);assert.deepEqual(JSON.parse(stdout),['stop','start','stop','start']);}else{assert.ok(changed.includes(newCode));assert.ok(!changed.includes(oldCode));assert.ok(changed.includes('9000'));assert.ok(changed.includes('9010'));assert.ok(changed.includes('kept'));}
});
test('real helper DryRun rejects fields outside the allowlist',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),file=path.join(f.root,'invalid.json'),text=JSON.stringify({version:1,createdAt:new Date().toISOString(),operations:[{op:'start',module:'graph',command:'injected'}]});await writeFile(file,text);const hash=createHash('sha256').update(text).digest('hex');
  await assert.rejects(winPs(['-NoProfile','-NonInteractive','-File',helper,'-PlanFile',file,'-PlanSha256',hash,'-DryRun'],{env:{...process.env,LOCALAPPDATA:f.root}}),e=>e.stdout.includes('Unexpected operation field')&&!e.stdout.includes('DRY RUN:'));
});
