import {versionPattern} from './verify.js';
// The CLI is published as a tarball on its GitHub releases; npm publishing follows once the npm scope exists.
export const cliRepo = 'coding-koala-io/local-developer-accelerator';
export const npmPackage = '@coding-koala-io/accelerator';
export const tarballName = v => `coding-koala-io-accelerator-${v}.tgz`;
export const tarballUrl = v => `https://github.com/${cliRepo}/releases/download/v${v}/${tarballName(v)}`;
const npmLatestUrl = `https://registry.npmjs.org/${npmPackage.replace('/', '%2f')}/latest`;
const githubLatestUrl = `https://api.github.com/repos/${cliRepo}/releases/latest`;

// npm first; only when the package is not on npm (HTTP 404) fall back to the latest GitHub release tarball.
export async function findLatestCli({fetcher = fetch, userAgent = 'lda-cli'} = {}) {
  const get = (url, headers = {}) => fetcher(url, {headers: {'User-Agent': userAgent, ...headers}, signal: AbortSignal.timeout(10000)});
  const npm = await get(npmLatestUrl);
  if (npm.ok) {
    const latest = (await npm.json()).version;
    if (!versionPattern.test(latest || '')) throw new Error('The npm registry returned an invalid version. Retry later.');
    const spec = `${npmPackage}@latest`;
    return {source: 'npm', latest, spec, command: `npm i -g ${spec}`};
  }
  if (npm.status !== 404) throw new Error(`npm registry returned HTTP ${npm.status}. Retry when connected.`);
  const gh = await get(githubLatestUrl, {Accept: 'application/vnd.github+json'});
  if (gh.status === 404) throw new Error(`The CLI is not on npm yet and no GitHub release of ${cliRepo} was found (HTTP 404). See https://github.com/${cliRepo}/releases.`);
  if (!gh.ok) throw new Error(`The CLI is not on npm yet and GitHub returned HTTP ${gh.status} for its latest release (${cliRepo}). Retry when connected.`);
  const release = await gh.json(), latest = String(release.tag_name || '').replace(/^v/, '');
  if (!versionPattern.test(latest)) throw new Error(`The latest GitHub release of ${cliRepo} has an invalid tag.`);
  const spec = tarballUrl(latest);
  if (Array.isArray(release.assets) && !release.assets.some(a => a.name === tarballName(latest))) throw new Error(`The GitHub release v${latest} has no ${tarballName(latest)}. Install manually from https://github.com/${cliRepo}/releases.`);
  return {source: 'github', latest, spec, command: `npm i -g ${spec}`};
}
