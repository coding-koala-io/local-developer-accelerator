import path from 'node:path';
import os from 'node:os';
import {realpathSync} from 'node:fs';
export const windowsPaths = value => /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? path.win32 : path;
export function getPaths(env = process.env) {
  const state = path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Coding Koala', 'Local Developer Accelerator');
  return {state, config: path.join(state, 'config.json'), cache: path.join(state, 'cache'), run: path.join(state, 'run'), plans: path.join(state, 'plans'), tray: path.join(state, 'tray.json'),
    code: path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Coding Koala', 'Local Developer Accelerator'),
    data: path.win32.join(env.ProgramData || 'C:\\ProgramData', 'Coding Koala', 'Local Developer Accelerator')};
}
export function runtimePaths(root, id) {
  const p = windowsPaths(root), service = p.join(root, 'service');
  return {root, service, xml: p.join(service, `${id}.xml`), wrapper: p.join(service, `${id}.exe`), logs: p.join(service, 'logs'), tenants: p.join(root, 'tenants.json')};
}
export function isWithin(parent, child) {
  const p = windowsPaths(parent), relative = p.relative(p.resolve(parent), p.resolve(child));
  return relative !== '' && !relative.startsWith(`..${p.sep}`) && relative !== '..' && !p.isAbsolute(relative);
}
// Canonical form of a Windows path, like the elevated helper's: the longest existing prefix expanded to its long
// form (8.3 short names such as C:\Users\RUNNER~1 resolved), the missing rest appended unchanged.
export function canonicalWindowsPath(value) {
  const w = path.win32, full = w.resolve(value);
  if (process.platform !== 'win32') return full;
  const rest = [];
  for (let cursor = full; ;) {
    try {return w.join(realpathSync.native(cursor), ...rest);} catch {}
    const parent = w.dirname(cursor);
    if (parent === cursor) return full;
    rest.unshift(w.basename(cursor)); cursor = parent;
  }
}
// True when two runtime folders are the same folder or one contains the other (case-insensitive on Windows,
// short and long spellings of the same folder treated as equal).
export function runtimesOverlap(a, b) {
  const p = windowsPaths(a);
  if (p === path.win32) {
    const [x, y] = [canonicalWindowsPath(a), canonicalWindowsPath(b)];
    return x.toLowerCase() === y.toLowerCase() || isWithin(x, y) || isWithin(y, x);
  }
  return p.resolve(a) === p.resolve(b) || isWithin(a, b) || isWithin(b, a);
}
// A runtime folder may be reused only when it is empty or holds nothing but a runtime layout.
export const runtimeLayout = Object.freeze(['tenants.json', 'data', 'logs', 'service', 'backups', '.lda-runtime.json']);
export async function assertRuntimeLayout(root, {list}) {
  let names;
  try {names = await list(root);} catch (e) {if (['ENOENT', 'EACCES', 'EPERM'].includes(e.code)) return; throw e;}
  // Leftover temp files of an interrupted runtime marker write are part of the layout (the helper resolves them).
  const extra = names.filter(n => !runtimeLayout.includes(String(n).toLowerCase()) && !/^\.lda-runtime\.json\.[0-9a-f]{32}\.tmp$/i.test(String(n)));
  if (extra.length) throw new Error(`Refusing ${root}: it contains ${extra.slice(0, 3).join(', ')}${extra.length > 3 ? ', …' : ''}, which is not part of a runtime folder. Choose an empty folder or an existing runtime folder.`);
}
