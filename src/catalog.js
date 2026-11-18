import {createRequire} from 'node:module';
export const suite = 'Local Developer Accelerator (LDA)';
export const suiteTagline = 'Free developer tools, built by Coding Koala';
// The single source of the CLI version is package.json (npm always ships it); the release script bumps only that,
// the lockfile, the licence and the changelog.
export const version = createRequire(import.meta.url)('../package.json').version;
export const wrapperSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA';
const cms13 = 'Made for CMS 13 sites. Not tested with CMS 12.';
export const catalog = Object.freeze([
  {key: 'graph', product: 'LDA Local Graph', compatibleWith: 'Optimizely Graph', cmsLine: cms13, repo: 'coding-koala-io/lda-graph', port: 8082, serviceId: 'LdaGraph', legacyServiceIds: ['OptimizelyGraphLocal'], runtimeFolder: 'Graph', hasTenants: true, hasDashboard: true, options: {memoryMb: {default: 8192, min: 1024, max: 65536}}},
  {key: 'assets', product: 'LDA Local Assets', compatibleWith: 'Optimizely CMS DAM picker', cmsLine: cms13, repo: 'coding-koala-io/lda-assets', port: 8083, serviceId: 'LdaAssets', legacyServiceIds: ['OptimizelyDamLocal'], runtimeFolder: 'Assets', hasTenants: true, hasDashboard: true, options: {}},
  {key: 'find', product: 'LDA Local Find', compatibleWith: 'Optimizely Search & Navigation (Find)', cmsLine: 'Made for CMS 12 sites that use Search & Navigation.', repo: 'coding-koala-io/lda-find', port: 8088, serviceId: 'LdaFind', legacyServiceIds: [], runtimeFolder: 'Find', hasTenants: false, hasDashboard: false, options: {}},
]);
export const toolCompatibility = catalog.map(mod => `${mod.product}: ${mod.cmsLine}`).join('\n');

export function moduleFor(key) {
  const mod = catalog.find(m => m.key === (key === 'dam' ? 'assets' : key));
  if (!mod) throw new Error(`Unknown module '${key}'. Use: ${catalog.map(m => m.key).join(', ')}.`);
  return mod;
}
export const selectModules = keys => [...new Set(keys.map(k => moduleFor(k).key))].map(moduleFor);
