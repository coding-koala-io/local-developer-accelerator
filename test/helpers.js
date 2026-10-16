import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {getPaths} from '../src/paths.js';
import {createConfig} from '../src/config.js';
import {catalog} from '../src/catalog.js';
import {createEngine} from '../src/engine.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {windowsPowerShellPath, childEnv} from '../src/process.js';
export async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lda-test-')); t.after(() => rm(root, {recursive: true, force: true}));
  const paths = getPaths({LOCALAPPDATA: root}), config = createConfig(paths.config);
  await mkdir(paths.cache, {recursive: true}); return {root, paths, config};
}
export async function releaseFixture(root, key = 'graph', version = '1.2.0', overrides = {}) {
  const dir = path.join(root, key, version); await mkdir(dir, {recursive: true});
  const file = `lda-${key}-${version}.zip`, bytes = Buffer.from('synthetic fixture zip bytes'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = {module: key, product: `LDA Local ${key}`, version, minNode: 24, dataVersion: 1, file, sha256, size: bytes.length, commit: 'synthetic', builtAt: '2026-10-16T00:00:00Z', ...overrides};
  await Promise.all([writeFile(path.join(dir, file), bytes), writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest)), writeFile(path.join(dir, 'SHA256SUMS'), `${sha256}  ${file}\n`)]);
  return {dir, zip: path.join(dir, file), manifest, sums: `${sha256}  ${file}\n`};
}
export function fakeEngine(f, overrides = {}) {
  const calls = [], states = overrides.states || {};
  const services = {async query() {return [];}, async describe(mod) {return {module: mod.key, product: mod.product, installed: false, state: 'not installed', port: mod.port, ...states[mod.key]};}, async owner() {return 'PID 123 (synthetic)';}, async ownsPort() {return true;}};
  const releases = {async latest() {return '1.2.0';}, async bundle(mod, opts = {}) {return {version: opts.version || '1.2.0', sha256: 'a'.repeat(64), zip: path.join(f.paths.cache, `lda-${mod.key}-1.2.0.zip`), dataVersion: 1};}};
  const engine = createEngine({paths: f.paths, config: f.config, platform: 'win32', services, releases, initialize: async () => {}, health: async (port, opts) => ({ok: true, latency: 12, product: opts.expectedProduct, version: '1.0.0', dataVersion: 1}), portAvailable: async () => true, elevate: async (plan, opts) => {calls.push({plan, opts}); return {ok: true, operations: plan.operations.map(o => ({...o, ok: true})), log: []};}, ...overrides});
  return {engine, calls, services, releases};
}
export function installed(mod = catalog[0], extras = {}) {
  return {installed: true, serviceId: mod.serviceId, serviceState: 'running', state: 'running', runtimeRoot: `C:\\ProgramData\\Coding Koala\\Local Developer Accelerator\\${mod.runtimeFolder}`, codeDir: `C:\\Program Files\\Coding Koala\\Local Developer Accelerator\\${mod.runtimeFolder}\\1.0.0`, version: '1.0.0', pid: 42, ...extras};
}
export const delay = ms => new Promise(r => setTimeout(r, ms));
// Tests start real Windows PowerShell the same way the CLI does: System32 path, no inherited PSModulePath
// (a pwsh 7 value would make 5.1 load PowerShell 7 core modules and fail).
const execFileAsync = promisify(execFile);
export const winPs = (args, opts = {}) => execFileAsync(windowsPowerShellPath(), args, {...opts, env: childEnv(opts.env || process.env)});
// Whether this test process runs elevated (hosted CI runners do; a normal developer terminal does not). Checks the
// Administrators SID (S-1-5-32-544), which is language-independent; under UAC a non-elevated token holds it deny-only,
// so IsInRole is false there. Asked once per test file.
let elevated;
export const isElevated = () => elevated ??= process.platform !== 'win32' ? Promise.resolve(false)
  : winPs(['-NoProfile', '-NonInteractive', '-Command', "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.SecurityIdentifier]'S-1-5-32-544')"])
    .then(({stdout}) => {const v = stdout.trim(); if (v !== 'True' && v !== 'False') throw new Error(`Unexpected elevation check output: ${v}`); return v === 'True';});
