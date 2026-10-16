import path from 'node:path';
import {readFile, mkdir, writeFile, access, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {catalog, moduleFor, selectModules} from './catalog.js';
import {getPaths, runtimePaths, assertRuntimeLayout, runtimesOverlap} from './paths.js';
import {createConfig} from './config.js';
import {createReleases} from './releases.js';
import {createServices, portAvailable} from './services.js';
import {checkHealth} from './health.js';
import {createElevator} from './elevate.js';
import {buildPlan} from './plan.js';
import {compareVersions, versionPattern} from './verify.js';
import {openUrl, spawnChild} from './process.js';
import {extractArchive} from './archive.js';
import {trayNotice} from './notice.js';
import {initializeRuntime} from './foreground.js';
export function createEngine(deps = {}) {
  const paths = deps.paths || getPaths(), config = deps.config || createConfig(paths.config), platform = deps.platform || process.platform;
  const listeners = new Set();
  const progress = message => {deps.progress?.(message); for (const cb of listeners) cb(message);};
  const releases = deps.releases || createReleases({paths, progress}), services = deps.services || createServices({platform});
  const health = deps.health || checkHealth, elevate = deps.elevate || createElevator({paths, platform, progress});
  const available = deps.portAvailable || portAvailable, open = deps.open || openUrl, spawn = deps.spawn || spawnChild, extract = deps.extract || extractArchive;
  const confirm = deps.confirm || (async () => false);
  const read = deps.readFile || readFile, list = deps.readdir || readdir;
  let lastUpdateCheck = null;
  const knownReleases = new Map();
  let lastBase = null;
  // Legacy services (old ids or /health without product) show version 'legacy' and never an update.
  function decorate({s, latest, updateError}, h) {
    const version = s.legacy ? 'legacy' : s.version || (h?.legacy ? 'legacy' : h?.version);
    const comparable = !!version && version !== 'legacy' && versionPattern.test(version);
    return {...s, version, dataVersion: h?.dataVersion, health: h, dashboard: `http://localhost:${s.port}/`, latest, update: !!(latest && s.installed && comparable && compareVersions(latest, version) > 0), updateError};
  }
  const check = (s, mod) => s.installed ? health(s.port, {expectedProduct: mod}) : null;
  async function status({checkUpdates = false, fresh = false} = {}) {
    const c = await config.read(), rows = await services.query();
    const base = await Promise.all(catalog.map(async mod => {
      const s = await services.describe(mod, rows); if (!s.installed) s.port = c.ports[mod.key];
      let latest = knownReleases.get(mod.key) || await releases.knownLatest?.(mod), updateError;
      if (checkUpdates || c.checkUpdates) {try {latest = await releases.latest(mod, {fresh}); knownReleases.set(mod.key, latest);} catch (e) {updateError = e.message;}}
      return {s, latest, updateError};
    }));
    const result = await Promise.all(base.map(async b => decorate(b, await check(b.s, b.s.module))));
    if (checkUpdates || c.checkUpdates) lastUpdateCheck = new Date().toISOString();
    lastBase = base; return result;
  }
  // Cheap poll: re-check /health of the last known services; no service query, XML read or release lookup.
  async function quickStatus() {
    if (!lastBase) return status();
    return Promise.all(lastBase.map(async b => decorate(b, await check(b.s, b.s.module))));
  }
  async function writeTray(rows) {
    const c = await config.read(); await mkdir(paths.state, {recursive: true});
    const data = {modules: rows.filter(r => r.installed).map(r => ({key: r.module, product: r.product, port: r.port, serviceId: r.serviceId, update: r.update, legacy: !!r.legacy, runtimeRoot: r.runtimeRoot})), total: catalog.length, hubPort: c.hubPort, checkUpdates: c.checkUpdates, lastUpdateCheck, about: trayNotice(paths.data), cli: fileURLToPath(new URL('../bin/lda.js', import.meta.url)), node: process.execPath};
    await writeFile(paths.tray, JSON.stringify(data, null, 2)); return data;
  }
  async function checkPort(port, module) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
    if (!(await available(port))) throw new Error(`Port ${port} is in use by ${await services.owner(port)}. Use lda install ${module} --port <free-port> (or lda run ${module} --port <free-port>).`);
  }
  function releaseFields(bundle) {return {version: bundle.version, zip: bundle.zip, sha256: bundle.sha256};}
  async function act(action, keys = [], opts = {}) {
    if (platform !== 'win32' && !opts.dryRun) return {ok: false, unsupported: true, log: ['Windows only in v1; use `lda run`']};
    const rows = await status(), c = await config.read(), ask = opts.confirm || confirm;
    let selected = keys.length ? selectModules(keys) : catalog.filter(m => rows.find(s => s.module === m.key)?.[action === 'adopt' ? 'legacy' : 'installed']);
    const ops = [], reserved = new Set(), notes = [];
    if (!keys.length && ['start', 'stop', 'restart'].includes(action)) {
      // --all acts on new-id services only; a legacy service is skipped with a note instead of failing the batch.
      for (const mod of selected.filter(m => rows.find(s => s.module === m.key)?.legacy)) notes.push(`Skipped ${mod.key}: legacy install — run lda adopt ${mod.key} first.`);
      selected = selected.filter(m => !rows.find(s => s.module === m.key)?.legacy);
    }
    if (selected.length > 1 && (opts.port !== undefined || opts.dataDir || opts.from)) throw new Error('--port, --data-dir and --from require a single module.');
    for (const mod of selected) {
      const s = rows.find(s => s.module === mod.key);
      if (['install', 'upgrade'].includes(action) && s.legacy) throw new Error(`${mod.product}: legacy install — run lda adopt ${mod.key}; data will be kept.`);
      if (action === 'install') {
        if (s.installed) throw new Error(`${mod.key} is already installed. Use lda upgrade ${mod.key}.`);
        const port = Number(opts.port ?? c.ports[mod.key]); if (reserved.has(port)) throw new Error(`Port ${port} was selected for two modules. Set different ports in lda config.`); reserved.add(port);
        await checkPort(port, mod.key);
        if (opts.memoryMb !== undefined && !mod.options.memoryMb) throw new Error(`${mod.key} has no --memory-mb option.`);
        const runtimeRoot = opts.dataDir || path.win32.join(paths.data, mod.runtimeFolder);
        // Never share or nest a data directory with another installed or planned module (the helper checks again).
        for (const other of [...rows.filter(r => r.module !== mod.key && r.installed && r.runtimeRoot).map(r => ({module: r.module, root: r.runtimeRoot})), ...ops.filter(o => o.runtimeRoot).map(o => ({module: o.module, root: o.runtimeRoot}))]) {
          if (runtimesOverlap(runtimeRoot, other.root)) throw new Error(`Refusing ${runtimeRoot}: it overlaps the ${other.module} data directory ${other.root}. Choose a separate folder with --data-dir.`);
        }
        await assertRuntimeLayout(runtimeRoot, {list});
        const b = await releases.bundle(mod, opts);
        ops.push({op: action, module: mod.key, ...releaseFields(b), port, runtimeRoot, ...(mod.options.memoryMb ? {memoryMb: Number(opts.memoryMb ?? mod.options.memoryMb.default)} : {})});
      } else if (action === 'upgrade') {
        if (!s.installed) throw new Error(`${mod.key} is not installed. Run lda install ${mod.key}.`);
        const b = await releases.bundle(mod, opts);
        if (!opts.version && compareVersions(b.version, s.version) <= 0) continue;
        // An unknown data version is treated as 1, the first data format.
        let dataVersion = s.dataVersion;
        if (!Number.isInteger(dataVersion)) {try {dataVersion = JSON.parse(await read(runtimePaths(s.runtimeRoot, s.serviceId).tenants, 'utf8')).dataVersion;} catch {dataVersion = undefined;}}
        if (!Number.isInteger(dataVersion)) dataVersion = 1;
        if (b.dataVersion > dataVersion && !opts.yes && !(await ask(`Upgrading ${mod.key} changes data version ${dataVersion} to ${b.dataVersion}. Back up ${s.runtimeRoot} first. Continue? [y/N] `))) throw new Error('Data upgrade not confirmed. Back up the runtime folder and retry with --yes.');
        ops.push({op: action, module: mod.key, ...releaseFields(b)});
      } else if (action === 'adopt') {
        if (!s.legacy) throw new Error(`${mod.key} has no legacy service to adopt.`);
        progress(`Adopt ${mod.key}: keep data at ${s.runtimeRoot}, same port ${s.port}; replace ${s.serviceId} with ${mod.serviceId}.`);
        const b = await releases.bundle(mod, opts); ops.push({op: action, module: mod.key, legacyServiceId: s.serviceId, ...releaseFields(b)});
      } else {
        if (!s.installed) throw new Error(`${mod.key} is not installed. Run lda install ${mod.key}.`);
        if (s.legacy) throw new Error(`Legacy install — run lda adopt ${mod.key}.`);
        if (action === 'uninstall') {
          if (opts.purge) await assertRuntimeLayout(s.runtimeRoot, {list});
          if (opts.purge && !opts.yes && !(await ask(`Permanently delete ${s.runtimeRoot}. Type ${mod.key} to confirm: `, mod.key))) throw new Error(`Purge not confirmed. Type ${mod.key} or pass --yes.`);
          ops.push({op: action, module: mod.key, purge: !!opts.purge});
        } else ops.push({op: action, module: mod.key});
      }
    }
    if (!ops.length) return {ok: true, operations: [], log: [...notes, 'No changes needed.']};
    const plan = buildPlan(ops, {cache: paths.cache}), result = await elevate(plan, {dryRun: opts.dryRun});
    if (!opts.dryRun) await writeTray(await status());
    return {...result, log: [...notes, ...(result.log || [])], plan};
  }
  async function logs(key, {lines = 50} = {}) {
    if (!Number.isInteger(Number(lines)) || Number(lines) < 1 || Number(lines) > 10000) throw new Error('Log line count must be from 1 to 10000.');
    const mod = moduleFor(key), s = (await status()).find(r => r.module === mod.key);
    if (!s.installed) return 'No service logs yet. Install the module first.';
    const p = runtimePaths(s.runtimeRoot, s.serviceId), output = [];
    for (const suffix of ['out', 'err', 'wrapper']) {
      const file = pathFor(p.logs, `${s.serviceId}.${suffix}.log`);
      try {output.push(`--- ${file} ---\n${(await read(file, 'utf8')).split(/\r?\n/).slice(-Number(lines)).join('\n')}`);} catch (e) {
        if (['EACCES', 'EPERM'].includes(e.code)) return `Access denied. In an elevated PowerShell, run:\nGet-Content -LiteralPath '${file.replaceAll("'", "''")}' -Tail ${Number(lines)} -Wait\nDashboard request log: ${s.dashboard}#request-log`;
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return output.join('\n') || `No wrapper logs yet. Dashboard request log: ${s.dashboard}#request-log`;
  }
  async function run(keys, opts = {}) {
    const selected = keys.includes('all') ? catalog : selectModules(keys), rows = await status(), c = await config.read();
    if (selected.length > 1 && opts.port !== undefined) throw new Error('--port requires a single module.');
    const prepared = [];
    for (const mod of selected) {
      const s = rows.find(r => r.module === mod.key), port = Number(opts.port ?? c.ports[mod.key]); await checkPort(port, mod.key);
      if (prepared.some(p => p.port === port)) throw new Error(`Two modules use port ${port}. Change lda config ports.${mod.key}.`);
      let code = s.installed && s.codeDir;
      if (!code) {
        const b = await releases.bundle(mod), dest = path.join(paths.cache, 'modules', mod.key, b.version);
        try {await access(path.join(dest, 'src', 'server.js'));} catch {await extract(b.zip, dest);} code = dest;
      }
      const root = path.join(paths.run, mod.runtimeFolder); await mkdir(root, {recursive: true});
      for (const folder of ['data', 'logs']) await mkdir(path.join(root, folder), {recursive: true});
      try {await access(path.join(root, 'tenants.json'));} catch {await (deps.initialize || initializeRuntime)(code, root, port);}
      prepared.push({mod, port, code, root});
    }
    const children = [];
    const stop = () => {for (const child of children) child.kill('SIGTERM');};
    try {
      for (const {mod, port, code, root} of prepared) {
        const args = [...(mod.options.memoryMb ? [`--max-old-space-size=${mod.options.memoryMb.default}`] : []), pathFor(code, 'src', 'server.js')];
        const child = spawn(process.execPath, args, {cwd: code, env: {...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(root, 'data'), LOG_DIR: path.join(root, 'logs'), TENANTS_FILE: path.join(root, 'tenants.json')}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
        children.push(child);
        for (const stream of [child.stdout, child.stderr]) {
          let pending = ''; stream?.setEncoding('utf8'); stream?.on('data', chunk => {pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop(); for (const line of lines) progress(`[${mod.key}] ${line}`);}); stream?.on('end', () => {if (pending) progress(`[${mod.key}] ${pending}`);});
        }
      }
    } catch (e) {stop(); throw e;}
    return {children, stop};
  }
  return {paths, config, releases, services, platform, status, quickStatus, act, logs, run, writeTray, subscribe(cb) {listeners.add(cb); return () => listeners.delete(cb);}, get lastUpdateCheck() {return lastUpdateCheck;}, async open(key) { const c = await config.read(); const s = key === 'hub' ? {dashboard: `http://localhost:${c.hubPort}/`} : (await status()).find(s => s.module === moduleFor(key).key); return open(s.dashboard); }};
}
function pathFor(root, ...parts) { return /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32.join(root, ...parts) : path.join(root, ...parts); }
