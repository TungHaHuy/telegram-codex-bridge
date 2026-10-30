import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../scripts/telegram_codex.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-read-timeout-'));
const previousHome = process.env.CODEX_HOME;
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const timeout = 'Codex App timeout; kết quả chưa xác định.';
const row = (id, payload) => JSON.stringify({ type: 'event_msg', payload: { turn_id: id, ...payload } });
const message = (id, key, text) => row(id, { type: 'item_completed', item: {
  type: 'AgentMessage', id: key, phase: 'commentary', content: [{ type: 'Text', text }],
} });
const file = id => path.join(root, 'sessions', 'rollout-' + id + '.jsonl');
const outputs = [], reads = [];
let busy = false, inventoryBusy = false, approvalReads = 0;
const metadata = id => ({ id, kind: 'codex', hostId: 'local', title: id, status: 'idle', updatedAt: 2 });
const state = { topicMode: true, realtimeBaseline: {}, routes: {},
  threads: { [A]: metadata(A), [B]: metadata(B) }, enabled: { [A]: true, [B]: true },
  topics: { [A]: 101, [B]: 102 }, attention: { [A]: 'prior-approval' },
  seen: { [A]: { turnId: A, keys: [], updatedAt: 1 }, [B]: { turnId: B, keys: [], updatedAt: 1 } },
};
try {
  process.env.CODEX_HOME = root;
  fs.mkdirSync(path.join(root, 'sessions'));
  for (const id of [A, B]) fs.writeFileSync(file(id), [JSON.stringify({ type: 'session_meta', payload: { id } }),
    row(id, { type: 'task_started' }), message(id, 'local-' + id, 'LOCAL_' + id),
    row(id, { type: 'task_complete' }),
  ].join('\n') + '\n');
  const bridge = new Bridge({ ownerId: 42, chatId: -1001234 }, state, async (tool, args, options) => {
    if (tool === 'list_threads') {
      assert.equal(options?.timeout, 30000);
      if (inventoryBusy) throw new Error(timeout);
      return { threads: Object.values(state.threads), pinnedThreads: [] };
    }
    assert.equal(tool, 'read_thread', 'a read fallback cannot submit prompts or control decisions');
    reads.push({ id: args.threadId, options });
    if (!options || busy || args.threadId === A) throw new Error(timeout);
    return { thread: { status: { type: 'idle', activeFlags: [] } }, page: {}, turns: [{ id: B, status: 'completed', items: [
      { type: 'agentMessage', id: 'native-B', phase: 'final_answer', text: 'NATIVE_B' },
    ] }] };
  }, async (method, args) => {
    assert.equal(method, 'sendMessage'); outputs.push(args); return { message_id: outputs.length };
  }, () => {});
  bridge.approvalMenu = async () => { approvalReads++; };
  await bridge.scan();
  assert(outputs.some(m => m.message_thread_id === 101 && m.text === 'LOCAL_' + A));
  assert(outputs.some(m => m.message_thread_id === 102 && m.text === 'NATIVE_B\n[end]'));
  assert.equal(state.attention[A], 'prior-approval', 'local content cannot clear or invent live approval status');
  assert.equal(approvalReads, 0);
  assert(reads.every(read => read.options.timeout === 30000));
  state.threads[A].updatedAt++;
  await bridge.scan();
  assert.equal(reads.filter(read => read.id === A).length, 1, 'avoid hammering an unresponsive App on every content poll');

  // Controls still require an App acknowledgement. Only background history uses
  // the timeout fallback, never a cached guess about cancellation or approvals.
  await assert.rejects(bridge.handle({ message: { chat: { id: -1001234, type: 'supergroup' },
    from: { id: 42 }, message_thread_id: 101, text: '/status' } }), new RegExp('Codex App timeout'));

  // Inventory timeout does not prevent polling an idle chat whose saved updatedAt
  // has gone stale. Its newly appended message must arrive through local history.
  inventoryBusy = true; busy = true;
  await assert.rejects(bridge.scanDesktop({ wait: false }), /Codex App timeout/);
  assert(bridge.inventoryStale);
  fs.appendFileSync(file(B), message(B, 'new-offline', 'ARRIVED_WHILE_INVENTORY_UNAVAILABLE') + '\n');
  const nativeReadsBefore = reads.length;
  await bridge.scan(); await bridge.scan();
  assert.equal(reads.length, nativeReadsBefore, 'stale inventory polls use disk, not more stalled App requests');
  assert.equal(outputs.filter(m => m.text === 'ARRIVED_WHILE_INVENTORY_UNAVAILABLE').length, 1);
  assert(!outputs.some(m => m.text.startsWith('Không đọc được chat:')), 'successful recovery is not a failed-read notification');

  inventoryBusy = false; busy = false;
  await bridge.scanDesktop();
  assert.equal(bridge.inventoryStale, false, 'fresh inventory restores normal idle skipping');
  bridge.localReadUntil.set(A, 0);
  await bridge.readDesktopPage({ threadId: A });
  assert.equal(reads.filter(read => read.id === A && read.options).length, 2, 'native reads are probed again after the cooldown');
  assert.equal(approvalReads, 0, 'timeout recovery never invokes an approval automatically');
  const missing = '33333333-3333-3333-3333-333333333333';
  state.threads[missing] = { ...metadata(missing), updatedAt: 2 };
  state.topics[missing] = 103; state.enabled[missing] = true;
  state.seen[missing] = { turnId: missing, updatedAt: 1, keys: [] };
  busy = true;
  await bridge.scan();
  assert.match(state.readPending[missing].error, /file lịch sử local/);
  assert(!outputs.some(m => m.text.startsWith('Không đọc được chat:')), 'retryable reads are retained without error-message spam');
  // Matching metadata cannot suppress a retained failed read.
  state.seen[missing].updatedAt = 2;
  fs.writeFileSync(file(missing), [JSON.stringify({ type: 'session_meta', payload: { id: missing } }),
    row(missing, { type: 'task_started' }), message(missing, 'restored-file', 'RESTORED_AFTER_READ_FAILURE'),
    row(missing, { type: 'task_complete' }),
  ].join('\n') + '\n');
  await bridge.scan();
  assert.equal(state.readPending[missing], undefined);
  assert.equal(outputs.filter(m => m.text === 'RESTORED_AFTER_READ_FAILURE').length, 1);

} finally {
  if (previousHome == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true });
}
console.log('telegram_read_timeout: local delivery, stale idle inventory, deduplication, cooldown, 30-second background deadline and unchanged control acknowledgement passed.');
