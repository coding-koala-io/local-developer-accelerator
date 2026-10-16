import {Command} from 'commander';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {catalog, suite, version} from './catalog.js';
import {createEngine} from './engine.js';
import {ensureNotice, firstRunNotice} from './notice.js';
import {renderStatus, renderList, statusExitCode, renderDoctor} from './output.js';
import {doctor} from './doctor.js';
import {startHub} from './hub.js';
import {tray} from './tray.js';
import {findLatestCli} from './self-update.js';
const exec = promisify(execFile);
export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr, env = deps.env || process.env;
  const print = value => stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  const tty = !!stdout.isTTY && !!(deps.stdin || process.stdin).isTTY;
  const program = new Command(); let exitCode = 0;
  const prompt = deps.prompt || (async question => {const rl = createInterface({input: process.stdin, output: stderr}); try {return await rl.question(question);} finally {rl.close();}});
  const engine = deps.engine || createEngine({progress: value => {if (!program.opts().json) stderr.write(`${typeof value === 'string' ? value : `Downloading ${value.file}: ${value.received}${value.total ? '/' + value.total : ''} bytes`}\r${tty ? '' : '\n'}`);}, confirm: async (question, typed) => tty && !env.CI && !program.opts().nonInteractive && (typed ? await prompt(question) === typed : /^y$/i.test(await prompt(question)))});
  const opts = cmd => typeof cmd.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : {...program.opts(), ...cmd};
  program.name('lda').description(`${suite} — by Coding Koala. Development use only.`).addHelpText('after', '\nRun lda --version (or -V) on its own to print the CLI version.')
    .option('--json', 'Output JSON').option('--yes', 'Confirm requested operations').option('--non-interactive', 'Never ask for input').option('--dry-run', 'Print elevated plan steps without service changes').option('--accept-notice', 'Accept the first-run notice for this major version').exitOverride();
  program.configureOutput({writeOut: s => stdout.write(s), writeErr: s => stderr.write(s)});
  program.hook('preAction', async (_, cmd) => {
    if (['about', 'privacy', 'licence'].includes(cmd.name())) return;
    const flags = opts(cmd);
    await ensureNotice({config: engine.config, paths: engine.paths, accept: flags.acceptNotice, env, tty, nonInteractive: flags.nonInteractive, prompt, print: s => stderr.write(s + '\n')});
  });
  async function showStatus(flags) {const rows = await engine.status(flags); await engine.writeTray(rows); print(flags.json ? rows : renderStatus(rows, {tty, env})); exitCode = statusExitCode(rows);}
  async function action(name, keys, flags) {
    const result = await engine.act(name, keys, flags);
    print(flags.json ? result : [...(result.log || []), ...(result.operations || []).map(o => `${o.ok === false ? 'Failed' : result.dryRun ? 'Plan' : 'Completed'}: ${o.op} ${o.module}${o.message ? ` — ${o.message}` : ''}`)].join('\n'));
    if (!result.ok) exitCode = 1;
  }
  program.action(async cmd => {
    if (tty && !env.CI && !opts(cmd).nonInteractive && !opts(cmd).json) {const {launchTui} = await import('./tui/index.js'); await launchTui(engine);} else await showStatus(opts(cmd));
  });
  program.command('status').description('Show installed services and health').option('--check-updates', 'Check release versions').action(async cmd => showStatus(opts(cmd)));
  program.command('list').description('List modules and latest releases').action(async cmd => {const rows = await engine.status({checkUpdates: true}); await engine.writeTray(rows); print(opts(cmd).json ? rows : renderList(rows, {tty, env}));});
  program.command('install <modules...>').description('Install verified releases as Windows services').option('--version <version>').option('--port <number>', '', Number).option('--data-dir <path>').option('--memory-mb <number>', '', Number).option('--from <zip>').action((keys, cmd) => action('install', keys, opts(cmd)));
  program.command('upgrade [modules...]').description('Upgrade installed modules; back up data first').option('--all').option('--check').option('--version <version>').action(async (keys, cmd) => {const flags = opts(cmd); if (flags.check) {const rows = (await engine.status({checkUpdates: true})).filter(r => !keys.length || keys.includes(r.module)); print(flags.json ? rows : renderStatus(rows, {tty, env}));} else await action('upgrade', keys, flags);});
  program.command('rollback <module>').description('Switch to the previous code version').action((key, cmd) => action('rollback', [key], opts(cmd)));
  program.command('uninstall <module>').description('Remove a service; retain data unless --purge').option('--purge').action((key, cmd) => action('uninstall', [key], opts(cmd)));
  for (const verb of ['start', 'stop', 'restart']) program.command(`${verb} [modules...]`).option('--all').action(async (keys, cmd) => {if (!keys.length && !opts(cmd).all) throw new Error(`Select modules or use lda ${verb} --all.`); await action(verb, keys, opts(cmd));});
  program.command('adopt [modules...]').description('Adopt legacy services while keeping data and ports').option('--version <version>').option('--from <zip>').action((keys, cmd) => action('adopt', keys, opts(cmd)));
  program.command('open <module>').description('Open a module dashboard or hub').action(key => engine.open(key));
  program.command('logs <module>').option('-n <lines>', 'Lines per log', Number, 50).option('-f, --follow').action(async (key, cmd) => {
    const flags = opts(cmd); const render = async () => print(await engine.logs(key, {lines: flags.n})); await render();
    if (flags.follow) {let last; const timer = setInterval(async () => {try {const text = await engine.logs(key, {lines: flags.n}); if (text !== last) {last = text; print(text);}} catch (e) {stderr.write(e.message + '\n');}}, 1000); await untilSignal(() => clearInterval(timer));}
  });
  program.command('run <modules...>').description('Run without admin, with foreground output').option('--port <number>', '', Number).action(async (keys, cmd) => {
    const job = await engine.run(keys, opts(cmd));
    const done = job.children.map(child => new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', code => {if (code) exitCode = code; resolve();});}));
    let stop; const signal = new Promise(resolve => {stop = () => {job.stop(); resolve();}; process.once('SIGINT', stop); process.once('SIGTERM', stop);});
    try {await Promise.race([Promise.all(done), signal]);} finally {job.stop(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);}
  });
  program.command('doctor').option('--online', 'Check clock against GitHub (network)').action(async cmd => {const flags = opts(cmd), checks = await (deps.doctor || doctor)(engine, {online: flags.online}); print(flags.json ? checks : renderDoctor(checks, {unicode: tty && !('NO_COLOR' in env)})); if (checks.some(c => !c.ok)) exitCode = 1;});
  const cfg = program.command('config').description('Get or set checkUpdates, hubPort, ports.<module>');
  cfg.command('get [key]').action(async key => print(await engine.config.get(key)));
  cfg.command('set <key> <value>').action(async (key, value) => {print(await engine.config.set(key, value)); await engine.writeTray(await engine.status());});
  program.command('tray').option('--at-login').option('--remove-at-login').option('--stop').action(async cmd => print(await (deps.tray || tray)(engine, opts(cmd))));
  program.command('hub').option('--port <number>', '', Number).option('--open').action(async cmd => {const flags = opts(cmd), port = flags.port ?? await engine.config.get('hubPort'); const hub = await (deps.startHub || startHub)({engine, port}); print(`Hub: ${hub.url}`); if (flags.open) {const {openUrl} = await import('./process.js'); await (deps.openUrl || openUrl)(hub.url);} await untilSignal(() => hub.close());});
  program.command('about').action(() => print(`${firstRunNotice(engine.paths.data)}\n\nPublisher: Coding Koalas Pty Ltd (ACN 668 775 433)\nby Coding Koala · lda ${version}\nSee LEGAL-NOTICE.md and LICENSE.md.`));
  for (const [name, file] of [['privacy', 'PRIVACY.md'], ['licence', 'LICENSE.md']]) program.command(name).action(async () => print(await readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
  program.command('self-update').description('Check npm, or the latest GitHub release while the CLI is not on npm; with --yes, update this CLI').action(async cmd => {
    const flags = opts(cmd), found = await findLatestCli({fetcher: deps.fetcher || fetch, userAgent: `lda-cli/${version}`});
    const from = found.source === 'npm' ? 'npm' : `GitHub release v${found.latest}`;
    print(flags.json ? {current: version, latest: found.latest, source: found.source, command: found.command} : `CLI ${version}; latest ${found.latest} (${from})\n${found.command}\nRun lda self-update --yes to apply.`);
    if (flags.yes && !flags.dryRun) {
      if (process.platform === 'win32') {const {powershell, psQuote} = await import('./process.js'); await (deps.ps || powershell)(`npm i -g ${psQuote(found.spec)}; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`);}
      else await (deps.runner || exec)('npm', ['i', '-g', found.spec]);
    }
  });
  // The CLI version is printed only as the first argument; a program-wide --version would swallow
  // install/upgrade/adopt --version x.y.z.
  if (['--version', '-V'].includes(argv[0])) {print(version); return 0;}
  try {await program.parseAsync(argv, {from: 'user'});} catch (e) {
    if (['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(e.code)) return 0;
    const code = e.exitCode || 1; stderr.write(`${env.LDA_DEBUG === '1' ? e.stack : e.message}\n`); return code;
  }
  return exitCode;
}
async function untilSignal(cleanup) {
  await new Promise(resolve => {const stop = async () => {process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await cleanup(); resolve();}; process.once('SIGINT', stop); process.once('SIGTERM', stop);});
}
