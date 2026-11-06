import net from 'node:net';
import {networkInterfaces} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const services = [[8082, 'graph'], [8083, 'assets']];
export async function healthy(port, product) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(1500), redirect: 'error'});
    return r.ok && (await r.json()).product === product;
  } catch {return false;}
}
export function listening(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = net.connect({host, port});
    const done = value => {socket.destroy(); resolve(value);};
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
}
export async function waitForServices({closed = false, timeout = 120000, probe = closed ? async port => !await listening(port) : healthy, now = Date.now, sleep = delay} = {}) {
  const deadline = now() + timeout;
  let results;
  do {
    results = await Promise.all(services.map(([port, product]) => probe(port, product)));
    if (results.every(Boolean)) return;
    if (now() >= deadline) break;
    await sleep(Math.min(1000, deadline - now()));
  } while (now() <= deadline);
  throw new Error(`Services did not ${closed ? 'close' : 'become healthy'}: ${services.filter((_, i) => !results[i]).map(([p]) => `127.0.0.1:${p}`).join(', ')}`);
}
export async function checkLanBindings() {
  const addresses = Object.values(networkInterfaces()).flat().filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address);
  if (!addresses.length) throw new Error('No LAN interface available to check published ports.');
  for (const host of addresses) for (const [port] of services) {
    if (await listening(port, host)) throw new Error(`Published port ${port} is reachable on the host LAN interface.`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'lan') await checkLanBindings();
    else await waitForServices({closed: process.argv[2] === 'closed', timeout: process.argv[2] === 'closed' ? 30000 : 120000});
    console.log(`Both service ports: ${process.argv[2] || 'healthy'}`);
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
