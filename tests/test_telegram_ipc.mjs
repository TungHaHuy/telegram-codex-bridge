import assert from 'node:assert/strict';
import net from 'node:net';
import { pipeRequest, desktopRequest } from '../scripts/telegram_codex.mjs';
import { threadSnapshot } from '../scripts/telegram_codex_controls.mjs';

const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\telegram-ipc-large-' + process.pid : '/tmp/telegram-ipc-large-' + process.pid;
const padding = 'x'.repeat(16 * 1024 * 1024);
let mode = 'large';
const sockets = new Set();
const frame = message => {
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
const server = net.createServer(socket => {
  sockets.add(socket);
  let input = Buffer.alloc(0), timer;
  socket.on('close', () => { sockets.delete(socket); clearTimeout(timer); });
  socket.on('error', () => {});
  const send = message => {
    const bytes = frame(message);
    socket.write(bytes.subarray(0, 2)); // Split both the header and body.
    for (let at = 2; at < bytes.length; at += 65536) socket.write(bytes.subarray(at, at + 65536));
  };
  socket.on('data', chunk => {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4 && input.length >= input.readUInt32LE(0) + 4) {
      const size = input.readUInt32LE(0), request = JSON.parse(input.subarray(4, size + 4));
      input = input.subarray(size + 4);
      if (request.type === 'client-discovery-response') continue;
      if (mode === 'timeout') continue;
      if (mode === 'oversize') {
        const header = Buffer.alloc(4); header.writeUInt32LE(1024 * 1024 * 1024 + 1);
        socket.write(header); continue;
      }
      if (mode === 'malformed') { socket.write(Buffer.from([1, 0, 0, 0, 123])); continue; }
      if (request.jsonrpc) { send({ result: { padding } }); continue; }
      if (request.method === 'initialize') {
        socket.write(Buffer.concat([frame({ type: 'client-discovery-request', requestId: 'discovery' }),
          frame({ type: 'response', requestId: request.requestId, resultType: 'success', result: { clientId: 'fixture' } })]));
      } else if (request.method === 'thread-stream-following-changed') {
        if (!request.params.following) continue;
        const respond = () => send({ method: 'thread-stream-state-changed', params: {
          conversationId: 'large-chat', change: { type: 'snapshot', conversationState: {
            latestModel: 'fixture-model', latestReasoningEffort: 'high', requests: [], padding: mode === 'slow' ? '' : padding,
          } },
        } });
        if (mode === 'slow') timer = setTimeout(respond, 8200); else respond();
      } else {
        assert.equal(request.timeoutMs, 300000, 'the Desktop deadline must also be raised');
        send({ type: 'response', requestId: request.requestId, resultType: 'success', result: { padding } });
      }
    }
  });
});
await new Promise(resolve => server.listen(endpoint, resolve));
try {
  assert.equal((await pipeRequest(endpoint, 'tools/list', {})).padding, padding);
  assert.equal((await desktopRequest('fixture-read', {}, 1, undefined, endpoint)).result.padding, padding);
  const snapshot = await threadSnapshot('large-chat', endpoint);
  assert.equal(snapshot.padding, padding); assert.equal(snapshot.latestModel, 'fixture-model');
  mode = 'slow';
  assert.equal((await threadSnapshot('large-chat', endpoint)).latestModel, 'fixture-model', 'a response after the old 8-second deadline must succeed');
  mode = 'oversize';
  for (const read of [() => pipeRequest(endpoint, 'tools/list', {}),
    () => desktopRequest('fixture-read', {}, 1, undefined, endpoint), () => threadSnapshot('large-chat', endpoint)]) {
    await assert.rejects(read(), /vượt 1 GiB/);
  }
  mode = 'malformed';
  await assert.rejects(pipeRequest(endpoint, 'tools/list', {}), SyntaxError);
  mode = 'timeout';
  await assert.rejects(pipeRequest(endpoint, 'tools/list', {}, 20), /timeout/);
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
console.log('telegram_ipc: three 16-MiB transports, fragmented/coalesced frames, >8s snapshot, invalid frames and explicit timeout passed.');
