import {mkdir, readFile, writeFile, readdir, copyFile, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {verifyRelease, versionPattern, compareVersions} from './verify.js';
const exec = promisify(execFile);
export function createReleases({paths, env = process.env, fetcher = fetch, runner = exec, now = Date.now, progress = () => {}}) {
  let tokenPromise;
  async function token() {
    return tokenPromise ??= (async () => {
      for (const key of ['LDA_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) if (env[key]) return env[key];
      try { return (await runner('gh', ['auth', 'token'], {windowsHide: true, timeout: 5000})).stdout.trim(); } catch { return ''; }
    })();
  }
  async function request(url, binary = false) {
    const auth = await token();
    const res = await fetcher(url, {headers: {'User-Agent': 'lda-cli/1.0.0', Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', ...(auth ? {Authorization: `Bearer ${auth}`} : {})}, signal: AbortSignal.timeout(120000)});
    if (!res.ok) throw new Error(`Release request failed (HTTP ${res.status}). Check the release version and GitHub token.`);
    return res;
  }
  const localRoot = () => env.LDA_RELEASE_SOURCE?.startsWith('dir:') ? env.LDA_RELEASE_SOURCE.slice(4) : null;
  async function localVersions(mod) { return (await readdir(path.join(localRoot(), mod.key), {withFileTypes: true})).filter(e => e.isDirectory() && versionPattern.test(e.name)).map(e => e.name).sort((a, b) => compareVersions(b, a)); }
  async function lookup(mod, version, {fresh = false, list = false} = {}) {
    if (version && !versionPattern.test(version)) throw new Error('Version must look like 1.2.3 or 1.2.3-beta.1.');
    if (localRoot()) {
      const versions = version ? [version] : await localVersions(mod);
      const records = await Promise.all(versions.slice(0, list ? 20 : 1).map(async v => ({tag_name: `v${v}`, manifest: JSON.parse(await readFile(path.join(localRoot(), mod.key, v, 'manifest.json'), 'utf8')), local: path.join(localRoot(), mod.key, v)})));
      if (!records.length) throw new Error(`No releases found for ${mod.key}.`); return list ? records : records[0];
    }
    const cache = path.join(paths.cache, 'releases', `${mod.key}-${list ? 'list' : version || 'latest'}.json`);
    if (!fresh) { try {const c = JSON.parse(await readFile(cache, 'utf8')); if (now() - c.at < 3600000) return c.value;} catch (e) {if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;} }
    const suffix = list ? '?per_page=20' : version ? `/tags/v${version}` : '/latest';
    const value = await (await request(`https://api.github.com/repos/${mod.repo}/releases${suffix}`)).json();
    await mkdir(path.dirname(cache), {recursive: true}); await writeFile(cache, JSON.stringify({at: now(), value}));
    return value;
  }
  async function download(asset, target) {
    if (!asset?.url?.startsWith('https://api.github.com/')) throw new Error('Release is missing a GitHub API asset URL.');
    const response = await request(asset.url, true), chunks = []; let size = 0;
    const total = Number(response.headers.get('content-length')) || asset.size;
    for await (const chunk of response.body) { chunks.push(chunk); size += chunk.length; progress({file: asset.name, received: size, total}); }
    await writeFile(target, Buffer.concat(chunks));
  }
  async function bundle(mod, {version, from, fresh = false} = {}) {
    let record, source, manifest;
    if (from) {source = path.dirname(path.resolve(from)); manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));}
    else {record = await lookup(mod, version, {fresh}); source = record.local; if (source) manifest = record.manifest;}
    const v = manifest?.version || record?.tag_name?.replace(/^v/, '');
    if (!versionPattern.test(v || '')) throw new Error('Release has an invalid version.');
    if (version && v !== version) throw new Error('Requested version differs from the release manifest.');
    const filename = `lda-${mod.key}-${v}.zip`, dest = path.join(paths.cache, 'downloads', mod.key, v);
    const readBundle = async dir => verifyRelease({module: mod.key, zip: path.join(dir, filename), manifest: path.join(dir, 'manifest.json'), sums: await readFile(path.join(dir, 'SHA256SUMS'), 'utf8')});
    if (!from && !source) {try { return await readBundle(dest); } catch (e) {if (e.code !== 'ENOENT') throw e;} }
    const temp = `${dest}.${randomUUID()}.partial`; await mkdir(temp, {recursive: true});
    try {
      if (source) {
        if (from && path.basename(from) !== filename) throw new Error(`Release zip must be named ${filename}.`);
        for (const name of [filename, 'manifest.json', 'SHA256SUMS']) await copyFile(path.join(source, name), path.join(temp, name));
      } else {
        for (const name of [filename, 'manifest.json', 'SHA256SUMS']) await download(record.assets?.find(a => a.name === name), path.join(temp, name));
      }
      const verified = await readBundle(temp);
      if (verified.version !== v) throw new Error('Release tag and manifest version disagree.');
      await mkdir(path.dirname(dest), {recursive: true});
      // A verified existing cache is reused; never replace a directory in use by another process.
      try {await rename(temp, dest);} catch (e) {if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(e.code)) throw e; const existing = await readBundle(dest); if (existing.sha256 !== verified.sha256) throw new Error('Cached release differs from the requested ZIP. Remove this cached version and retry.');}
      return await readBundle(dest);
    } finally {await rm(temp, {recursive: true, force: true});}
  }
  return {lookup, bundle, async knownLatest(mod) {try {const c = JSON.parse(await readFile(path.join(paths.cache, 'releases', `${mod.key}-latest.json`), 'utf8')); const v = c.value.tag_name?.replace(/^v/, ''); return versionPattern.test(v || '') ? v : undefined;} catch {return undefined;}}, async latest(mod, opts) {const r = await lookup(mod, undefined, opts); return r.tag_name.replace(/^v/, '');}, async list(mod, opts) { return lookup(mod, undefined, {...opts, list: true}); }};
}
