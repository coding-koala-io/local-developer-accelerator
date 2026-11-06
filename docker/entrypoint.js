import net from 'node:net';
import {networkInterfaces} from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export function containerAddresses(interfaces) {
  return [...new Set(Object.values(interfaces).flat().filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address))];
}

// Image-only TCP forwarding. The released servers keep their loopback binding,
// Host/Origin checks and local dashboard access. No credentials or HTTP rewriting.
export async function createRelay(host, port, {targetPort = port} = {}) {
  const sockets = new Set();
  const track = socket => {sockets.add(socket); socket.on('close', () => sockets.delete(socket)); return socket;};
  const server = net.createServer(client => {
    track(client);
    const upstream = track(net.connect({host: '127.0.0.1', port: targetPort}));
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, host, resolve);});
  return {port: server.address().port, close: () => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  })};
}

export async function startContainer({interfaces = networkInterfaces(), relay = createRelay, launch = spawn, signals = process, args = ['run', 'all']} = {}) {
  const addresses = containerAddresses(interfaces), relays = [];
  if (!addresses.length) throw new Error('No container IPv4 interface. Use the default Docker bridge network.');
  let child, stopping = false;
  const stop = () => {stopping = true; child?.kill('SIGTERM');};
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  try {
    for (const host of addresses) for (const port of [8082, 8083]) relays.push(await relay(host, port));
    if (stopping) return 0;
    child = launch('lda', args, {stdio: 'inherit'});
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (stopping && signal === 'SIGTERM' ? 0 : 1)));
    });
  } finally {
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
    await Promise.all(relays.map(r => r.close()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {process.exitCode = await startContainer({args: process.argv.slice(2)});}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
