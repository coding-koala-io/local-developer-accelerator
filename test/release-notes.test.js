import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {version} from '../src/catalog.js';
import {releaseNotes} from '../src/release-notes.js';
// Release metadata is checked by format, so a version bump does not break the tests.
test('package, lockfile, CLI and licence versions agree; licence Change Date is a valid date',async()=>{const[p,lock,license]=await Promise.all(['package.json','package-lock.json','LICENSE.md'].map(f=>readFile(new URL('../'+f,import.meta.url),'utf8')));assert.equal(JSON.parse(p).version,version);assert.equal(JSON.parse(lock).version,version);assert.equal(JSON.parse(lock).packages[''].version,version);assert.equal(license.match(/^Licensed Work:\s+(.+)$/m)?.[1].trim(),`Local Developer Accelerator for Optimizely (CLI) ${version}`);const changeDate=license.match(/^Change Date:\s+(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];assert.ok(changeDate&&new Date(changeDate).toISOString().startsWith(changeDate),'Change Date is a valid YYYY-MM-DD date');assert.ok(!license.includes('{{'));});
test('release notes include only the selected changelog section',()=>{const notes=releaseNotes('# Changelog\n\n## [1.0.0] - unreleased\n\n- first\n\n## [0.1.0] - earlier\n- older','1.0.0');assert.equal(notes,'- first\n');assert.throws(()=>releaseNotes('','1.0.0'),/Missing/);});
test('the committed CHANGELOG has an unreleased or dated section for the package version',async()=>{const changelog=await readFile(new URL('../CHANGELOG.md',import.meta.url),'utf8');const heading=changelog.split(/\r?\n/).find(line=>line.startsWith(`## [${version}] - `));assert.ok(heading&&/ - (unreleased|\d{4}-\d{2}-\d{2})$/.test(heading),`## [${version}] heading`);assert.ok(releaseNotes(changelog,version).trim().length>0);});
