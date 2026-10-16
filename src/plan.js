import path from 'node:path';
import {moduleFor} from './catalog.js';
import {versionPattern} from './verify.js';
import {isWithin, runtimesOverlap} from './paths.js';
const allowed = {
  install: ['module', 'version', 'zip', 'sha256', 'port', 'runtimeRoot', 'memoryMb'], upgrade: ['module', 'version', 'zip', 'sha256'], adopt: ['module', 'legacyServiceId', 'version', 'zip', 'sha256'],
  rollback: ['module'], uninstall: ['module', 'purge'], start: ['module'], stop: ['module'], restart: ['module'],
};
export function buildPlan(operations, {cache, now = () => new Date()} = {}) {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error('No operations selected.');
  const seen = new Set();
  for (const item of operations) {
    const mod = moduleFor(item.module), fields = allowed[item.op];
    if (mod.key !== item.module || !fields || Object.keys(item).some(k => k !== 'op' && !fields.includes(k))) throw new Error('Invalid operation or unexpected plan field.');
    if (seen.has(item.module)) throw new Error('A plan can act on each module only once.'); seen.add(item.module);
    if (['install', 'upgrade', 'adopt'].includes(item.op)) {
      if (!versionPattern.test(item.version) || !/^[a-f\d]{64}$/i.test(item.sha256) || !item.zip || !cache || !isWithin(cache, item.zip)) throw new Error('Invalid release fields: zip must be under the user cache.');
    }
    if (item.op === 'install') {
      if (!Number.isInteger(item.port) || item.port < 1 || item.port > 65535) throw new Error('Port must be from 1 to 65535.');
      if (typeof item.runtimeRoot !== 'string' || !(path.isAbsolute(item.runtimeRoot) || path.win32.isAbsolute(item.runtimeRoot)) || /[\x00-\x1f"%]/.test(item.runtimeRoot)) throw new Error('Data directory must be absolute, without quotes, control characters or %.');
      if (item.memoryMb !== undefined && (!mod.options.memoryMb || !Number.isInteger(item.memoryMb) || item.memoryMb < 1024 || item.memoryMb > 65536)) throw new Error('memoryMb must be from 1024 to 65536 and supported by the module.');
    }
    if (item.op === 'adopt' && !mod.legacyServiceIds.includes(item.legacyServiceId)) throw new Error('Legacy service id does not belong to the module.');
    if (item.op === 'uninstall' && typeof item.purge !== 'boolean') throw new Error('purge must be boolean.');
  }
  const installs = operations.filter(o => o.op === 'install');
  for (let i = 0; i < installs.length; i++) for (let j = i + 1; j < installs.length; j++) {
    if (runtimesOverlap(installs[i].runtimeRoot, installs[j].runtimeRoot)) throw new Error(`${installs[i].module} and ${installs[j].module} cannot share or nest data directories (${installs[i].runtimeRoot}, ${installs[j].runtimeRoot}).`);
  }
  return {version: 1, createdAt: now().toISOString(), operations};
}
export function planSteps(plan) {
  return plan.operations.map(o => `${o.op} ${o.module}${o.version ? ` ${o.version} (verify SHA-256; code side-by-side)` : ''}${o.port ? `; port ${o.port}; data ${o.runtimeRoot}` : ''}${o.purge ? '; permanently remove runtime data' : ''}${o.op === 'upgrade' ? '; preserve settings; restore previous XML on failed health check' : ''}`);
}
