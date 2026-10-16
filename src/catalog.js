import {createRequire} from 'node:module';
export const suite = 'Local Developer Accelerator for Optimizely';
// The single source of the CLI version is package.json (npm always ships it); the release script bumps only that,
// the lockfile, the licence and the changelog.
export const version = createRequire(import.meta.url)('../package.json').version;
export const wrapperSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA';
export const catalog = Object.freeze([
  {key: 'graph', product: 'LDA Local Graph', compatibleWith: 'Optimizely Graph', repo: 'coding-koala-io/lda-graph', port: 8082, serviceId: 'LdaGraph', legacyServiceIds: ['OptimizelyGraphLocal'], runtimeFolder: 'Graph', options: {memoryMb: {default: 8192, min: 1024, max: 65536}}},
  {key: 'assets', product: 'LDA Local Assets', compatibleWith: 'Optimizely CMS DAM picker', repo: 'coding-koala-io/lda-assets', port: 8083, serviceId: 'LdaAssets', legacyServiceIds: ['OptimizelyDamLocal'], runtimeFolder: 'Assets', options: {}},
]);
export function moduleFor(key) {
  const mod = catalog.find(m => m.key === (key === 'dam' ? 'assets' : key));
  if (!mod) throw new Error(`Unknown module '${key}'. Use: ${catalog.map(m => m.key).join(', ')}.`);
  return mod;
}
export const selectModules = keys => [...new Set(keys.map(k => moduleFor(k).key))].map(moduleFor);
