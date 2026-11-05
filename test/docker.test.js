import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {EventEmitter, once} from 'node:events';
import {containerAddresses, createRelay, startContainer} from '../docker/entrypoint.js';
const interfaces = {lo: [{internal: true, family: 'IPv4', address: '127.0.0.1'}], eth0: [{internal: false, family: 'IPv4', address: '172.18.0.2'}, {internal: false, family: 'IPv6', address: '::2'}]};
test('image forwarding selects only container IPv4 interfaces', () => {
  assert.deepEqual(containerAddresses(interfaces), ['172.18.0.2']);
});
test('image entrypoint starts lda run all and propagates stop before closing relays', async () => {
  const signals = new EventEmitter(), child = new EventEmitter(), events = [];
  child.kill = signal => {events.push(signal); queueMicrotask(() => child.emit('exit', 0));};
  const done = startContainer({interfaces, signals, relay: async (host, port) => {
    events.push([host, port]); return {close: async () => events.push('closed')};
  }, launch: (exe, args, opts) => {
    assert.equal(exe, 'lda'); assert.deepEqual(args, ['run', 'all']); assert.equal(opts.stdio, 'inherit');
    queueMicrotask(() => signals.emit('SIGTERM')); return child;
  }});
  assert.equal(await done, 0);
  assert.deepEqual(events, [['172.18.0.2', 8082], ['172.18.0.2', 8083], 'SIGTERM', 'closed', 'closed']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
test('entrypoint cleans up partially-created relays when a port is unavailable', async () => {
  let closed = 0;
  await assert.rejects(startContainer({interfaces, signals: new EventEmitter(), relay: async (_, port) => {
    if (port === 8083) throw new Error('port unavailable'); return {close: async () => closed++};
  }, launch: () => {throw new Error('must not launch');}}), /port unavailable/);
  assert.equal(closed, 1);
});
test('entrypoint propagates CLI failure and refuses host networking without a container interface', async () => {
  const child = new EventEmitter();
  assert.equal(await startContainer({interfaces, signals: new EventEmitter(), relay: async () => ({close: async () => {}}), launch: () => {queueMicrotask(() => child.emit('exit', 9)); return child;}}), 9);
  await assert.rejects(startContainer({interfaces: {}, signals: new EventEmitter()}), /bridge network/);
});
test('TCP relay preserves streamed bytes and closes active connections', async t => {
  const server = net.createServer(socket => socket.pipe(socket));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const relay = await createRelay('127.0.0.1', 0, {targetPort: server.address().port});
  t.after(() => relay.close());
  const client = net.connect({host: '127.0.0.1', port: relay.port});
  t.after(() => client.destroy());
  await once(client, 'connect');
  const data = once(client, 'data'); client.write('synthetic stream');
  assert.equal((await data)[0].toString(), 'synthetic stream');
  const closed = once(client, 'close'); await relay.close(); await closed;
});
