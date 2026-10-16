// lda self-update: npm first; while the package is not on npm (HTTP 404), the latest GitHub release tarball.
// Every request goes to a fake fetcher and every npm run to a fake runner; nothing is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from '../src/cli.js';
import {version} from '../src/catalog.js';
import {findLatestCli, tarballUrl, tarballName, cliRepo, stableTarballName, stableTarballUrl} from '../src/self-update.js';
import {fixture, fakeEngine} from './helpers.js';
const output = () => ({text: '', isTTY: false, write(s) {this.text += s;}});
const json = (status, body) => ({ok: status >= 200 && status < 300, status, json: async () => body});
const npmUrl = /^https:\/\/registry\.npmjs\.org\/@coding-koala-io%2faccelerator\/latest$/;
const ghUrl = `https://api.github.com/repos/${cliRepo}/releases/latest`;
const release = (version, extra = []) => ({tag_name: `v${version}`, assets: [{name: tarballName(version)}, {name: 'SHA256SUMS'}, ...extra]});
function fakeFetch(routes) {
  const calls = [];
  const fetcher = async (url, init) => {calls.push({url, init}); const route = routes.find(([match]) => (typeof match === 'string' ? url === match : match.test(url))); if (!route) throw new Error(`unexpected request ${url}`); return route[1]();};
  return {fetcher, calls};
}
async function run(t, args, deps) {
  const f = await fixture(t), {engine} = fakeEngine(f), stdout = output(), stderr = output(), npm = [];
  const record = async (...a) => {npm.push(a); return '';};
  const code = await main([...args, '--accept-notice'], {engine, stdout, stderr, env: {}, runner: record, ps: record, ...deps});
  return {code, stdout, stderr, npm};
}

test('tarball URL is the GitHub release asset named like npm pack output', () => {
  assert.equal(tarballName('1.0.0'), 'coding-koala-io-accelerator-1.0.0.tgz');
  assert.equal(tarballUrl('1.0.0'), 'https://github.com/coding-koala-io/local-developer-accelerator/releases/download/v1.0.0/coding-koala-io-accelerator-1.0.0.tgz');
});

test('npm package found: npm command, GitHub never asked', async () => {
  const {fetcher, calls} = fakeFetch([[npmUrl, () => json(200, {version: '1.1.0'})]]);
  const found = await findLatestCli({fetcher});
  assert.deepEqual(found, {source: 'npm', latest: '1.1.0', spec: '@coding-koala-io/accelerator@latest', command: 'npm i -g @coding-koala-io/accelerator@latest'});
  assert.equal(calls.length, 1);
});

test('npm 404: falls back to the latest GitHub release tarball', async () => {
  const {fetcher, calls} = fakeFetch([[npmUrl, () => json(404, {error: 'Not found'})], [ghUrl, () => json(200, release('1.2.0'))]]);
  const found = await findLatestCli({fetcher, userAgent: 'lda-cli/test'});
  assert.deepEqual(found, {source: 'github', latest: '1.2.0', spec: tarballUrl('1.2.0'), command: `npm i -g ${tarballUrl('1.2.0')}`});
  assert.deepEqual(calls.map(c => c.url.startsWith('https://registry') ? 'npm' : c.url), ['npm', ghUrl]);
  assert.equal(calls[1].init.headers['User-Agent'], 'lda-cli/test');
  assert.ok(!('Authorization' in calls[1].init.headers), 'the public release lookup sends no token');
});

test('npm 404 and the release carries the unversioned tarball: prefer the stable latest URL', async () => {
  assert.equal(stableTarballUrl, 'https://github.com/coding-koala-io/local-developer-accelerator/releases/latest/download/coding-koala-io-accelerator.tgz');
  const {fetcher} = fakeFetch([[npmUrl, () => json(404, {})], [ghUrl, () => json(200, release('1.1.0', [{name: stableTarballName}, {name: 'install.ps1'}, {name: 'install.sh'}]))]]);
  assert.deepEqual(await findLatestCli({fetcher}), {source: 'github', latest: '1.1.0', spec: stableTarballUrl, command: `npm i -g ${stableTarballUrl}`});
  const onlyStable = fakeFetch([[npmUrl, () => json(404, {})], [ghUrl, () => json(200, {tag_name: 'v1.1.0', assets: [{name: stableTarballName}, {name: 'SHA256SUMS'}]})]]);
  assert.equal((await findLatestCli({fetcher: onlyStable.fetcher})).spec, stableTarballUrl);
});

test('lda self-update --yes installs from the stable latest URL when the release has it', async t => {
  const {fetcher} = fakeFetch([[npmUrl, () => json(404, {})], [ghUrl, () => json(200, release('1.1.0', [{name: stableTarballName}]))]]);
  const r = await run(t, ['self-update', '--yes'], {fetcher});
  assert.equal(r.code, 0, r.stderr.text);
  assert.ok(r.stdout.text.includes(`npm i -g ${stableTarballUrl}`));
  if (process.platform === 'win32') assert.equal(r.npm[0][0], `npm i -g '${stableTarballUrl}'; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`);
  else assert.deepEqual(r.npm[0].slice(0, 2), ['npm', ['i', '-g', stableTarballUrl]]);
});

test('npm errors other than 404 do not fall back; GitHub failures and bad releases give plain errors', async () => {
  await assert.rejects(findLatestCli({fetcher: fakeFetch([[npmUrl, () => json(503, {})]]).fetcher}), /npm registry returned HTTP 503/);
  await assert.rejects(findLatestCli({fetcher: fakeFetch([[npmUrl, () => json(404, {})], [ghUrl, () => json(404, {})]]).fetcher}), /not on npm yet and no GitHub release of coding-koala-io\/local-developer-accelerator was found \(HTTP 404\)/);
  await assert.rejects(findLatestCli({fetcher: fakeFetch([[npmUrl, () => json(404, {})], [ghUrl, () => json(200, {tag_name: 'latest', assets: []})]]).fetcher}), /invalid tag/);
  await assert.rejects(findLatestCli({fetcher: fakeFetch([[npmUrl, () => json(404, {})], [ghUrl, () => json(200, {tag_name: 'v1.2.0', assets: [{name: 'SHA256SUMS'}]})]]).fetcher}), /has no coding-koala-io-accelerator-1\.2\.0\.tgz/);
});

test('lda self-update prints the GitHub tarball command and --dry-run never runs npm', async t => {
  const {fetcher} = fakeFetch([[npmUrl, () => json(404, {})], [ghUrl, () => json(200, release('1.2.0'))]]);
  const r = await run(t, ['self-update', '--yes', '--dry-run'], {fetcher});
  assert.equal(r.code, 0, r.stderr.text);
  assert.match(r.stdout.text, /latest 1\.2\.0 \(GitHub release v1\.2\.0\)/);
  assert.ok(r.stdout.text.includes(`npm i -g ${tarballUrl('1.2.0')}`));
  assert.deepEqual(r.npm, []);
});

test('lda self-update --yes installs the GitHub tarball when npm has no package', async t => {
  const {fetcher} = fakeFetch([[npmUrl, () => json(404, {})], [ghUrl, () => json(200, release('1.2.0'))]]);
  const r = await run(t, ['self-update', '--yes'], {fetcher});
  assert.equal(r.code, 0, r.stderr.text);
  assert.equal(r.npm.length, 1);
  if (process.platform === 'win32') assert.equal(r.npm[0][0], `npm i -g '${tarballUrl('1.2.0')}'; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`);
  else assert.deepEqual(r.npm[0].slice(0, 2), ['npm', ['i', '-g', tarballUrl('1.2.0')]]);
});

test('lda self-update --yes uses the npm package once it is published', async t => {
  const {fetcher, calls} = fakeFetch([[npmUrl, () => json(200, {version: '1.3.0'})]]);
  const r = await run(t, ['self-update', '--yes', '--json'], {fetcher});
  assert.equal(r.code, 0, r.stderr.text);
  assert.deepEqual(JSON.parse(r.stdout.text), {current: version, latest: '1.3.0', source: 'npm', command: 'npm i -g @coding-koala-io/accelerator@latest'});
  assert.equal(calls.length, 1);
  assert.ok(JSON.stringify(r.npm[0]).includes('@coding-koala-io/accelerator@latest'));
});

test('lda self-update exits 1 with a plain message when neither npm nor GitHub answers', async t => {
  const {fetcher} = fakeFetch([[npmUrl, () => json(404, {})], [ghUrl, () => json(500, {})]]);
  const r = await run(t, ['self-update'], {fetcher});
  assert.equal(r.code, 1);
  assert.match(r.stderr.text, /GitHub returned HTTP 500/);
  assert.ok(!/\n\s+at /.test(r.stderr.text));
});
