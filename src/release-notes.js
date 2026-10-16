import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function releaseNotes(changelog, version) {
  const section = changelog.split(`## [${version}]`)[1];
  if (!section) throw new Error(`Missing changelog section for ${version}.`);
  return section.split(/\r?\n## /)[0].replace(/^[^\n]*\n/, '').trim() + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('Tag and package version differ.');
  writeFileSync('release-notes.txt', releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version));
}
