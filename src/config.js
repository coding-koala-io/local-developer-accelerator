import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {catalog, moduleFor} from './catalog.js';
export function createConfig(file) {
  const defaults = () => ({checkUpdates: false, hubPort: 8080, ports: Object.fromEntries(catalog.map(m => [m.key, m.port]))});
  async function read() {
    try { const value = JSON.parse(await readFile(file, 'utf8')); return {...defaults(), ...value, ports: {...defaults().ports, ...value.ports}}; }
    catch (e) { if (e.code === 'ENOENT') return defaults(); throw new Error(`Cannot read ${file}: ${e.message}. Fix or remove this config file.`); }
  }
  async function save(value) {
    await mkdir(path.dirname(file), {recursive: true});
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600}); await rename(tmp, file);
  }
  function validate(key, value) {
    if (key === 'checkUpdates') { if (![true, false, 'true', 'false'].includes(value)) throw new Error('checkUpdates must be true or false.'); return value === true || value === 'true'; }
    if (key === 'hubPort' || key.startsWith('ports.')) {
      if (key.startsWith('ports.')) { const m = moduleFor(key.slice(6)); if (m.key !== key.slice(6)) throw new Error('Use ports.assets, not ports.dam.'); }
      const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Port must be an integer from 1 to 65535.'); return n;
    }
    throw new Error('Unknown config key. Use checkUpdates, hubPort, or ports.<module>.');
  }
  return {read, save, async get(key) { const c = await read(); if (!key) return c; validate(key, key === 'checkUpdates' ? false : 8080); return key.startsWith('ports.') ? c.ports[key.slice(6)] : c[key]; },
    async set(key, value) { const v = validate(key, value), c = await read(); if (key.startsWith('ports.')) c.ports[key.slice(6)] = v; else c[key] = v; await save(c); return v; }};
}
