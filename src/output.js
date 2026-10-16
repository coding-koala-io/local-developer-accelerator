import {Chalk} from 'chalk';
import Table from 'cli-table3';
import terminalLink from 'terminal-link';
import isUnicodeSupported from 'is-unicode-supported';
import {suite, version} from './catalog.js';
export function renderStatus(rows, {tty = !!process.stdout.isTTY, env = process.env, unicode = isUnicodeSupported(), links = terminalLink} = {}) {
  const rich = tty && !('NO_COLOR' in env), useUnicode = rich && unicode, c = new Chalk({level: rich ? 1 : 0});
  const table = new Table({head: ['MODULE', 'STATE', 'PORT', 'VERSION', 'HEALTH', 'DASHBOARD'], chars: {top: '', 'top-mid': '', 'top-left': '', 'top-right': '', bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '', left: '', 'left-mid': '', mid: '', 'mid-mid': '', right: '', 'right-mid': '', middle: '  '}, style: {head: [], border: [], 'padding-left': 0, 'padding-right': 1}});
  for (const r of rows) {
    const running = r.serviceState === 'running' || r.state === 'running', dot = useUnicode ? running ? '●' : r.installed ? '○' : '·' : '*';
    const color = !r.installed ? c.gray : r.health?.ok ? c.green : c.yellow;
    const h = r.health ? r.health.ok ? `${r.health.latency >= 500 ? 'slow' : 'ok'} ${r.health.latency}ms` : 'down' : '-';
    const url = r.dashboard || '';
    table.push([color(`${dot} ${r.product}`), r.state, r.port || '-', `${r.version || '-'}${r.update ? useUnicode ? ' ↑' : ' (update)' : ''}`, h, rich ? links(url, url, {fallback: () => url}) : url]);
  }
  const updates = rows.filter(r => r.update).length;
  const result = [`${suite} ${useUnicode ? '·' : '-'} development use only    lda ${version}`, '', table.toString(), ...(updates ? [`${useUnicode ? '↑' : '(update)'} ${updates} updates — run lda upgrade`] : []), ...(rows.some(r => r.legacy) ? ['legacy install — run lda adopt'] : []), ...rows.filter(r => r.updateError).map(r => `${r.module}: update check unavailable: ${r.updateError}`)].join('\n');
  return useUnicode ? result : result.replace(/[—–]/g, '-');
}
export function renderList(rows, options) {
  const text = renderStatus(rows.map(r => ({...r, version: `installed: ${r.version || '-'}; latest: ${r.latest || 'unavailable'}`})), options);
  return text;
}
export const statusExitCode = rows => rows.some(r => r.installed && !r.health?.ok) ? 1 : 0;
export const renderDoctor = (checks, {unicode = !!process.stdout.isTTY && !('NO_COLOR' in process.env)} = {}) => checks.map(c => `${unicode ? c.ok ? '✔' : '✖' : c.ok ? '[OK]' : '[FAIL]'} ${c.name}: ${c.message}\n  Fix: ${c.fix}`).join('\n');
