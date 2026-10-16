import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {mkdir, rename, rm, lstat, readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const exec = promisify(execFile);
// Always the Windows tar from System32, never a tar.exe found earlier on PATH.
export function tarPath({platform = process.platform, env = process.env} = {}) {
  return platform === 'win32' ? path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}
export function validateEntries(names, verbose) {
  const entries = names.split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.some(n => /[\x00-\x1f]/.test(n) || /^[\\/]|^[a-z]:/i.test(n) || n.replaceAll('\\', '/').split('/').includes('..') || n.includes(':'))) throw new Error('Unsafe archive paths. Download a valid release.');
  if (verbose.split(/\r?\n/).filter(Boolean).some(n => !/^[-d]/.test(n) || / -> | link to /.test(n))) throw new Error('Archive links or special files are forbidden.');
}
export async function extractArchive(zip, destination, {runner = exec, tar = tarPath()} = {}) {
  const [names, verbose] = await Promise.all([runner(tar, ['-tf', zip], {windowsHide: true, maxBuffer: 8 * 1024 * 1024}), runner(tar, ['-tvf', zip], {windowsHide: true, maxBuffer: 8 * 1024 * 1024})]);
  validateEntries(names.stdout, verbose.stdout);
  const tmp = `${destination}.${randomUUID()}.partial`; await mkdir(tmp, {recursive: true});
  async function assertNoLinks(dir) {for (const name of await readdir(dir)) {const f = path.join(dir, name), info = await lstat(f); if (info.isSymbolicLink()) throw new Error('Archive links are forbidden.'); if (info.isDirectory()) await assertNoLinks(f);}}
  try {await runner(tar, ['-xf', zip, '-C', tmp], {windowsHide: true}); await assertNoLinks(tmp); await mkdir(path.dirname(destination), {recursive: true}); await rename(tmp, destination);}
  finally {await rm(tmp, {recursive: true, force: true});}
  return destination;
}
