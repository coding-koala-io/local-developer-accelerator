// One-line installers (install.ps1, install.sh) and the release workflow that attaches them.
// The end-to-end runs use a FAKE local releases API on 127.0.0.1, a real `npm pack` of this repo,
// a temporary npm prefix and npm in offline mode, so nothing global changes and nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile, mkdtemp, rm, readdir, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {winPs} from './helpers.js';
import {windowsPowerShellPath, childEnv} from '../src/process.js';
import {stableTarballName, stableTarballUrl} from '../src/self-update.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const ps1 = path.join(root, 'install.ps1'), sh = path.join(root, 'install.sh'), workflow = path.join(root, '.github', 'workflows', 'release.yml');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const psQuote = s => `'${s.replaceAll("'", "''")}'`;
const shAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('PowerShell parser accepts install.ps1', {skip: process.platform !== 'win32'}, async () => {
  const code = `$tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseFile(${psQuote(ps1)},[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}`;
  await winPs(['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]);
});

test('sh -n accepts install.sh', {skip: !shAvailable && 'sh not available'}, async () => {
  await exec('sh', ['-n', sh]);
  assert.ok(!(await readFile(sh, 'utf8')).includes('\r'), 'install.sh must have LF line endings');
});

test('install.ps1 is safe to pipe to iex and contains the required checks', async () => {
  const s = await readFile(ps1, 'utf8');
  assert.ok(!/^\s*param\s*\(/im.test(s), 'no param block (options are environment variables)');
  assert.ok(!/(^|[;\s])exit(\s|$)/im.test(s.replace(/^\s*#.*$/gm, '')), 'never calls exit (it would close the user\'s shell under iex)');
  assert.ok(s.trimStart().replace(/^(#.*\r?\n)+/, '').startsWith('& {'), 'runs in its own scope');
  for (const text of ['SecurityProtocolType]::Tls12', 'Get-FileHash -Algorithm SHA256', 'Checksum mismatch', "-lt 24", 'winget install OpenJS.NodeJS.LTS', 'https://nodejs.org', 'npm.cmd',
    '/releases/latest', '/releases/tags/', '$env:LDA_VERSION', '$env:GITHUB_TOKEN', 'SHA256SUMS', '--version', 'lda install graph assets', 'lda adopt', 'lda tray',
    'Never use in production', 'No telemetry', 'not affiliated'])
    assert.ok(s.includes(text), text);
  assert.ok(!/RunAs|winget install(?! OpenJS\.NodeJS\.LTS)/.test(s), 'never elevates and never installs Node.js itself');
  assert.ok(s.indexOf('Checksum mismatch') < s.indexOf(' i -g '), 'verifies before npm install');
});

test('install.sh contains the required checks', async () => {
  const s = await readFile(sh, 'utf8');
  for (const text of ['set -eu', 'sha256sum', 'shasum -a 256', 'Checksum mismatch', '-ge 24', 'https://nodejs.org', '/releases/latest', '/releases/tags/', 'LDA_VERSION', 'GITHUB_TOKEN',
    'SHA256SUMS', '--version', 'lda install graph assets', 'lda adopt', 'Never use in production', 'No telemetry', 'not affiliated'])
    assert.ok(s.includes(text), text);
  assert.ok(!/\bsudo npm\b|apt-get install|brew install node &&/.test(s), 'never installs Node.js or uses sudo itself');
  assert.ok(s.indexOf('Checksum mismatch') < s.indexOf('npm i -g'), 'verifies before npm install');
});

test('release workflow attaches the installers and the stable tarball, all in SHA256SUMS', async () => {
  const s = await readFile(workflow, 'utf8');
  assert.match(s, /STABLE="coding-koala-io-accelerator\.tgz"/);
  assert.equal(stableTarballName, 'coding-koala-io-accelerator.tgz');
  assert.match(s, /cp "\$FILE" "\$STABLE"/);
  assert.match(s, /sha256sum "\$FILE" "\$STABLE" install\.ps1 install\.sh > SHA256SUMS/);
  assert.match(s, /gh release create "\$GITHUB_REF_NAME" "\$FILE" "\$STABLE" install\.ps1 install\.sh SHA256SUMS /);
  for (const kept of ["GITHUB_REF_NAME !== 'v'+p.version", 'node src/release-notes.js', '--notes-file release-notes.txt', "if: vars.NPM_PUBLISH == 'true'", 'npm publish --provenance --access public'])
    assert.ok(s.includes(kept), kept);
});

test('README leads with the one-liners and the stable npm URL', async () => {
  const s = await readFile(path.join(root, 'README.md'), 'utf8'), install = s.slice(s.indexOf('## Install'));
  const a = install.indexOf('releases/latest/download/install.ps1 | iex'), b = install.indexOf('releases/latest/download/install.sh | sh'), c = install.indexOf(`npm i -g ${stableTarballUrl}`), d = install.indexOf('npm i -g @coding-koala-io/accelerator');
  assert.ok(a > 0 && a < b && b < c && c < d, 'order: Windows, macOS/Linux, stable npm URL, npm package');
});

// ---------- end-to-end against a fake releases API ----------
async function packFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lda-installer-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const out = path.join(dir, 'pack'); await mkdir(out);
  const env = {...process.env, npm_config_offline: 'true'};
  if (process.platform === 'win32') await exec('cmd.exe', ['/d', '/c', 'npm', 'pack', '--silent', '--pack-destination', out], {cwd: root, env});
  else await exec('npm', ['pack', '--silent', '--pack-destination', out], {cwd: root, env});
  const [name] = await readdir(out);
  assert.equal(name, `coding-koala-io-accelerator-${pkg.version}.tgz`);
  return {dir, name, bytes: await readFile(path.join(out, name))};
}
async function fakeReleases(t, {name, bytes, sums}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({url: req.url, auth: req.headers.authorization});
    const base = `http://127.0.0.1:${server.address().port}`, tag = `v${pkg.version}`;
    const release = {tag_name: tag, assets: [name, stableTarballName, 'SHA256SUMS'].map(n => ({name: n, browser_download_url: `${base}/download/${tag}/${n}`}))};
    if (req.url === '/repos/x/releases/latest' || req.url === `/repos/x/releases/tags/${tag}`) {res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(release));}
    if (req.url.startsWith('/repos/x/releases/tags/')) {res.statusCode = 404; return res.end('{"message":"Not Found"}');}
    if (req.url === `/download/${tag}/${name}` || req.url === `/download/${tag}/${stableTarballName}`) return res.end(bytes);
    if (req.url === `/download/${tag}/SHA256SUMS`) return res.end(sums ?? `${sha256(bytes)}  ${name}\n${sha256(bytes)}  ${stableTarballName}\n`);
    if (req.url === '/install.ps1') return res.end(await readFile(ps1));
    if (req.url === '/install.sh') return res.end(await readFile(sh));
    res.statusCode = 404; res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return {base: `http://127.0.0.1:${server.address().port}`, requests};
}
// Same shape as the documented one-liner: irm <url>/install.ps1 | iex
async function runPs1(base, env, shell = windowsPowerShellPath()) {
  const code = `irm ${base}/install.ps1 | iex`;
  try {
    const r = await exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {env: childEnv(env), maxBuffer: 16 * 1024 * 1024, timeout: 240000});
    return r.stdout; // Write-Host goes to stdout; stderr only carries the host's CLIXML progress records
  } catch (e) {return `${e.stdout}${e.stderr}${e.message}`;}
}
const baseEnv = (dir, base, extra = {}) => {
  const env = {...process.env, LDA_INSTALL_API: `${base}/repos/x`, npm_config_prefix: path.join(dir, 'prefix'), npm_config_cache: undefined, npm_config_offline: 'true', npm_config_update_notifier: 'false', ...extra};
  for (const k of Object.keys(env)) if (env[k] === undefined || /^(LDA_VERSION|GITHUB_TOKEN)$/i.test(k) && !(k in extra)) delete env[k];
  return env;
};

test('install.ps1 end to end: fake API, real tarball, temporary npm prefix', {skip: process.platform !== 'win32', timeout: 300000}, async t => {
  const f = await packFixture(t), api = await fakeReleases(t, f);
  const out = await runPs1(api.base, baseEnv(f.dir, api.base, {LDA_VERSION: pkg.version, GITHUB_TOKEN: 'synthetic-token'}));
  assert.match(out, /Never use in production/);
  assert.match(out, /SHA-256 verified/, out);
  assert.ok(out.includes(`Installed lda ${pkg.version}.`), out);
  assert.match(out, /lda install graph assets/);
  const shim = path.join(f.dir, 'prefix', 'lda.cmd');
  assert.ok(existsSync(shim), 'lda installed into the temporary prefix only');
  const {stdout} = await exec('cmd.exe', ['/d', '/c', shim, '--version']);
  assert.equal(stdout.trim(), pkg.version);
  assert.ok(api.requests.some(r => r.url === `/repos/x/releases/tags/v${pkg.version}` && r.auth === 'Bearer synthetic-token'), 'LDA_VERSION pins via /releases/tags and GITHUB_TOKEN goes to the API');
  assert.ok(api.requests.filter(r => r.url.startsWith('/download/')).every(r => !r.auth), 'the token is never sent to download URLs');
});

test('install.ps1 refuses a checksum mismatch and installs nothing', {skip: process.platform !== 'win32', timeout: 120000}, async t => {
  const f = await packFixture(t), api = await fakeReleases(t, {...f, sums: `${'0'.repeat(64)}  ${f.name}\n`});
  const out = await runPs1(api.base, baseEnv(f.dir, api.base));
  assert.match(out, /Install failed: Checksum mismatch/);
  assert.match(out, /nothing was installed/);
  assert.ok(api.requests.some(r => r.url === '/repos/x/releases/latest'));
  assert.ok(!existsSync(path.join(f.dir, 'prefix', 'lda.cmd')));
});

test('install.ps1 stops with install advice when Node.js is older than 24', {skip: process.platform !== 'win32', timeout: 60000}, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lda-installer-')); t.after(() => rm(dir, {recursive: true, force: true}));
  await writeFile(path.join(dir, 'node.cmd'), '@echo v22.11.0\r\n');
  const api = await fakeReleases(t, {name: 'x.tgz', bytes: Buffer.from('x')});
  const env = baseEnv(dir, api.base); const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path');
  env[pathKey] = `${dir};${env[pathKey]}`;
  const out = await runPs1(api.base, env);
  assert.match(out, /Node\.js v22\.11\.0 is too old/);
  assert.match(out, /winget install OpenJS\.NodeJS\.LTS/);
  assert.ok(!api.requests.some(r => r.url.startsWith('/repos/')), 'stops before contacting the releases API');
});

test('install.sh end to end: fake API, real tarball, temporary npm prefix', {skip: (!shAvailable && 'sh not available'), timeout: 300000}, async t => {
  const f = await packFixture(t), api = await fakeReleases(t, f);
  const env = baseEnv(f.dir, api.base);
  let out;
  try {const r = await exec('sh', ['-c', `curl -fsSL ${api.base}/install.sh | sh`], {env, maxBuffer: 16 * 1024 * 1024, timeout: 240000}); out = r.stdout + r.stderr;}
  catch (e) {out = `${e.stdout}${e.stderr}${e.message}`;}
  assert.match(out, /SHA-256 verified/, out);
  assert.ok(out.includes(`Installed lda ${pkg.version}.`), out);
});

const pwsh7 = process.platform === 'win32' && spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
test('install.ps1 end to end in PowerShell 7 (latest release, no pin)', {skip: !pwsh7 && 'PowerShell 7 not available', timeout: 300000}, async t => {
  const f = await packFixture(t), api = await fakeReleases(t, f);
  const out = await runPs1(api.base, baseEnv(f.dir, api.base), 'pwsh');
  assert.match(out, /SHA-256 verified/, out);
  assert.ok(out.includes(`Installed lda ${pkg.version}.`), out);
  assert.ok(api.requests.some(r => r.url === '/repos/x/releases/latest' && !r.auth), 'latest release, no token when GITHUB_TOKEN is unset');
});
