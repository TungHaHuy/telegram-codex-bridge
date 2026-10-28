import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-outbox-process-'));
try {
  const moduleUrl = new URL('../scripts/telegram_codex.mjs', import.meta.url).href;
  const script = path.join(root, 'worker.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { Bridge, saveJson } from ${JSON.stringify(moduleUrl)};
const root = process.argv[2], restart = process.argv[3] === 'resume';
const file = root + '/state.json', received = root + '/received.jsonl';
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
  topicMode: true, topics: { A: 101 }, enabled: { A: true }, threads: { A: { title: 'A' } }, routes: {}, seen: {},
};
let sends = 0;
const bridge = new Bridge({ ownerId: 42, chatId: -1001234 }, state,
  async () => { throw new Error('delivery restart must not execute a model prompt'); },
  async (method, body) => {
    sends++;
    if (!restart && sends === 2) process.exit(17);
    fs.appendFileSync(received, JSON.stringify({ method, text: body.text, topic: body.message_thread_id }) + '\\n');
    return { message_id: (restart ? 100 : 0) + sends };
  }, () => saveJson(file, state));
if (!restart) bridge.queueDelivery('A', { key: 'restart-event', role: 'assistant',
  text: 'A'.repeat(3500) + 'B'.repeat(3500) + 'C'.repeat(500) });
await bridge.startDelivery('A');
`);
  const first = spawnSync(process.execPath, [script, root, 'crash'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(first.status, 17, first.stderr);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.equal(checkpoint.outbox.A.length, 1);
  assert.equal(checkpoint.deliveryParts['A:101:restart-event'].next, 1);
  assert(!checkpoint.delivered.A?.includes('restart-event'));
  const second = spawnSync(process.execPath, [script, root, 'resume'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(second.status, 0, second.stderr);
  const received = fs.readFileSync(path.join(root, 'received.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(received.map(item => item.text), ['A'.repeat(3500), 'B'.repeat(3500), 'C'.repeat(500)]);
  assert(received.every(item => item.topic === 101));
  const completed = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.deepEqual(completed.outbox, {});
  assert.deepEqual(completed.deliveryParts, {});
  assert(completed.delivered.A.includes('restart-event'));
} finally {
  const resolved = path.resolve(root);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert(path.basename(resolved).startsWith('telegram-outbox-process-'));
  fs.rmSync(resolved, { recursive: true });
}
console.log('telegram_outbox_restart: real process exit + disk checkpoint + second process resumed all 3 chunks exactly once (simulated Telegram).');
