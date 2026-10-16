import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
export const versionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export async function sha256(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
export async function verifyRelease({zip, manifest, sums, module, nodeMajor = Number(process.versions.node.split('.')[0])}) {
  if (typeof manifest === 'string') manifest = JSON.parse(await readFile(manifest, 'utf8'));
  if (typeof sums !== 'string') throw new Error('SHA256SUMS is required.');
  if (manifest.module !== module) throw new Error(`Release module mismatch: expected ${module}. Download the correct module.`);
  if (!versionPattern.test(manifest.version)) throw new Error('Release has an invalid version.');
  const min = Number(String(manifest.minNode).match(/^(?:>=)?(\d+)(?:\.\d+(?:\.\d+)?)?$/)?.[1]);
  if (!min || min > nodeMajor) throw new Error(`Release requires Node ${manifest.minNode}; install a supported Node version.`);
  if (!Number.isInteger(manifest.dataVersion) || manifest.dataVersion < 0) throw new Error('Release has an invalid dataVersion.');
  if (manifest.file !== path.basename(zip)) throw new Error('Release filename does not match manifest.file.');
  const line = sums.split(/\r?\n/).map(l => l.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).find(m => m && m[2] === manifest.file);
  const actual = await sha256(zip);
  if (!/^[a-f\d]{64}$/i.test(manifest.sha256) || actual !== manifest.sha256.toLowerCase() || !line || actual !== line[1].toLowerCase()) throw new Error('Release SHA-256 mismatch. Remove the cached release and download again; nothing was elevated.');
  return {...manifest, zip, sha256: actual};
}
// Semver precedence, including prereleases (a final release sorts after its prerelease).
export function compareVersions(a = '0.0.0', b = '0.0.0') {
  const parse = s => {const [core, ...pre] = s.replace(/^v/, '').split('-'); return {core: core.split('.').map(Number), pre: pre.join('-')};};
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) { const d = (x.core[i] || 0) - (y.core[i] || 0); if (d) return Math.sign(d); }
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
  const xp = x.pre.split('.'), yp = y.pre.split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    if (xp[i] === yp[i]) continue; if (xp[i] === undefined) return -1; if (yp[i] === undefined) return 1;
    const xn = /^\d+$/.test(xp[i]), yn = /^\d+$/.test(yp[i]);
    return xn && yn ? Math.sign(Number(xp[i]) - Number(yp[i])) : xn !== yn ? xn ? -1 : 1 : xp[i] < yp[i] ? -1 : 1;
  } return 0;
}
