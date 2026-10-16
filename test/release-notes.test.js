import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {version} from '../src/catalog.js';
import {releaseNotes} from '../src/release-notes.js';
// Release metadata is checked by format, so a version bump does not break the tests.
// package.json is the only place the CLI version is written; everything else is checked against it.
test('package, lockfile, CLI and licence versions agree; licence Change Date is a valid date',async t=>{
  const[p,lock,license,catalogSource,releasesSource]=await Promise.all(['package.json','package-lock.json','LICENSE.md','src/catalog.js','src/releases.js'].map(f=>readFile(new URL('../'+f,import.meta.url),'utf8')));
  const pkg=JSON.parse(p).version;
  assert.match(pkg,/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(JSON.parse(lock).version,pkg,'package-lock.json version');assert.equal(JSON.parse(lock).packages[''].version,pkg,'package-lock.json packages[""] version');
  assert.equal(license.match(/^Licensed Work:\s+(.+)$/m)?.[1].trim(),`Local Developer Accelerator for Optimizely (CLI) ${pkg}`,'LICENSE.md Licensed Work');
  assert.equal(version,pkg,'the CLI reads its version from package.json');
  for(const source of [catalogSource,releasesSource])assert.doesNotMatch(source,/['"`](lda-cli\/)?\d+\.\d+\.\d+['"`]/,'no hard-coded version copy in the source');
  const state=mkdtempSync(join(tmpdir(),'lda-version-'));t.after(()=>rmSync(state,{recursive:true,force:true}));
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/lda.js',import.meta.url)),'--version'],{encoding:'utf8',windowsHide:true,env:{...process.env,LOCALAPPDATA:state}});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),pkg,'lda --version prints the package.json version');
  const changeDate=license.match(/^Change Date:\s+(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];assert.ok(changeDate&&new Date(changeDate).toISOString().startsWith(changeDate),'Change Date is a valid YYYY-MM-DD date');assert.ok(!license.includes('{{'));});
test('release notes include only the selected changelog section',()=>{const notes=releaseNotes('# Changelog\n\n## [1.0.0] - unreleased\n\n- first\n\n## [0.1.0] - earlier\n- older','1.0.0');assert.equal(notes,'- first\n');assert.throws(()=>releaseNotes('','1.0.0'),/Missing/);});
test('the committed CHANGELOG has an unreleased or dated section for the package version',async()=>{const changelog=await readFile(new URL('../CHANGELOG.md',import.meta.url),'utf8');const heading=changelog.split(/\r?\n/).find(line=>line.startsWith(`## [${version}] - `));assert.ok(heading&&/ - (unreleased|\d{4}-\d{2}-\d{2})$/.test(heading),`## [${version}] heading`);assert.ok(releaseNotes(changelog,version).trim().length>0);});
