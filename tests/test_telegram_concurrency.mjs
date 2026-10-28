import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { Bridge } from '../scripts/telegram_codex.mjs';

const gate = () => Promise.withResolvers();
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert(Date.now() < deadline, 'timed out waiting for independent chat progress');
    await pause(5);
  }
}
const owner = 1234, group = -1001234;
const metadata = id => ({ id, title: id, kind: 'codex', hostId: 'local', updatedAt: 2, status: 'idle' });
const state = ids => ({ offset: 0, topicMode: true, realtimeBaseline: {}, routes: {},
  enabled: Object.fromEntries(ids.map(id => [id, true])),
  topics: Object.fromEntries(ids.map((id, i) => [id, 100 + i])),
  threads: Object.fromEntries(ids.map(id => [id, metadata(id)])),
  seen: Object.fromEntries(ids.map(id => [id, { turnId: id, keys: [], updatedAt: 1, wasActive: false }])),
});

// Match the observed 108-chat inventory. One stuck App read must not stop
// delivery or a later scan of a healthy chat, or create overlapping reads.
const ids = Array.from({ length: 108 }, (_, i) => 'chat-' + i);
const scanState = state(ids), blocked = gate(), delivered = [];
let running = 0, peak = 0;
const reads = new Map();
const scanner = new Bridge({ ownerId: owner, chatId: group }, scanState, async (tool, args) => {
  if (tool === 'list_threads') return { threads: Object.values(scanState.threads), pinnedThreads: [] };
  assert.equal(tool, 'read_thread');
  const id = args.threadId;
  reads.set(id, (reads.get(id) || 0) + 1);
  running++; peak = Math.max(peak, running);
  try {
    if (id === ids[0]) await blocked.promise;
    await pause(1);
    return { thread: { status: { type: 'idle' } }, page: {}, turns: [{ id, status: 'completed', items: [
      { id: id + ':' + scanState.threads[id].updatedAt, type: 'agentMessage', phase: 'final_answer', text: id },
    ] }] };
  } finally { running--; }
}, async (_method, body) => { delivered.push(body); return { message_id: delivered.length }; }, () => {});
try {
  await scanner.scanDesktop({ wait: false });
  await until(() => scanner.scans.size === 1);
  assert.equal(delivered.length, 107, 'healthy chats deliver while one read remains stuck');
  assert(peak > 1 && peak <= 4, 'App reads are concurrent and bounded');
  scanState.threads[ids[1]].updatedAt++;
  await scanner.scanDesktop({ wait: false });
  await until(() => delivered.length === 108);
  assert.equal(reads.get(ids[0]), 1, 'never overlap scans of the same chat');
  assert.equal(reads.get(ids[1]), 2, 'healthy chat can be polled again before slow chat finishes');
  assert.equal(reads.get(ids[2]), 1, 'unchanged idle chat is not reread');
} finally {
  blocked.resolve();
  await scanner.scan();
}

// The same topic stays FIFO, but another topic is independent. Persist both
// in-flight operations and waiting updates so one completion cannot erase another.
const inputState = state(['A', 'B']), first = gate(), other = gate();
const calls = [], sent = [], snapshots = [];
const bridge = new Bridge({ ownerId: owner, chatId: group }, inputState, async (tool, args) => {
  assert.equal(tool, 'send_message_to_thread');
  calls.push(args.prompt);
  if (args.prompt === 'A1') await first.promise;
  if (args.prompt === 'B1') await other.promise;
  if (args.prompt === 'A2') throw new Error('uncertain dispatch');
  return { message: 'accepted ' + args.prompt };
}, async (_method, body) => { sent.push(body); return { message_id: sent.length }; },
() => snapshots.push(structuredClone(inputState)));
const update = (id, topic, text) => ({ update_id: id, message: {
  message_id: id, chat: { id: group, type: 'supergroup' }, from: { id: owner },
  message_thread_id: inputState.topics[topic], text,
} });
const jobs = [bridge.enqueue(update(10, 'A', 'A1')), bridge.enqueue(update(11, 'A', 'A2')),
  bridge.enqueue(update(12, 'B', 'B1'))];
try {
  await until(() => calls.length === 2);
  assert.deepEqual(calls, ['A1', 'B1']);
  assert.equal(Object.keys(inputState.pendingOps).length, 2);
  assert.deepEqual(Object.keys(inputState.inbox), ['11']);
  assert.equal(inputState.offset, 13);
  const restartedState = structuredClone(inputState);
  const restored = new Bridge({ ownerId: owner, chatId: group }, restartedState, async (_tool, args) => {
    assert.equal(args.prompt, 'A2', 'restart resumes waiting inputs, never uncertain submissions');
    return {};
  }, async () => ({ message_id: 1 }), () => {});
  await restored.enqueue(restartedState.inbox[11]);
  assert.equal(restartedState.offset, 13, 'restoring an older queued input cannot move the polling offset backward');
  assert.equal(Object.keys(restartedState.pendingOps).length, 2, 'recovery does not erase uncertain operations');
  other.resolve(); await jobs[2];
  assert.deepEqual(calls, ['A1', 'B1']);
  assert.equal(Object.keys(inputState.pendingOps).length, 1);
  assert(sent.some(body => body.message_thread_id === 101 && body.text === 'accepted B1'));
} finally {
  first.resolve(); other.resolve(); await Promise.all(jobs);
}
assert.deepEqual(calls, ['A1', 'B1', 'A2']);
assert.equal(Object.keys(inputState.pendingOps).length, 0);
assert.equal(Object.keys(inputState.inbox).length, 0);
assert(sent.some(body => body.message_thread_id === 100 && body.text.includes('không tự gửi lại')));
assert(snapshots.some(s => Object.keys(s.pendingOps).length === 2));

// A legacy single pending operation is retained for the existing no-replay warning.
const legacy = { ...state(['A']), pending: { threadId: 'A', updateId: 9 } };
new Bridge({ ownerId: owner }, legacy, async () => {}, async () => {}, () => {});
assert.deepEqual(legacy.pendingOps.legacy, { threadId: 'A', updateId: 9 });
assert.equal(legacy.pending, undefined);

// Concurrent creations keep independent operation records and completion counts.
const createState = state([]), createA = gate(), createB = gate();
const creator = new Bridge({ ownerId: owner, chatId: group }, createState, async (tool, args) => {
  assert.equal(tool, 'create_thread');
  await (args.title === 'A' ? createA.promise : createB.promise);
  return { threadId: args.title, hostId: 'local' };
}, async (method, args) => method === 'createForumTopic' ?
  { message_thread_id: args.name === 'A' ? 100 : 101 } : { message_id: 1 }, () => {});
const project = { projectId: 'P', label: 'Project' };
const creations = [creator.createChat(project, 'A', 'first A', 20, text => assert.fail(text)),
  creator.createChat(project, 'B', 'first B', 21, text => assert.fail(text))];
try {
  assert.equal(creator.creatingChat, 2);
  assert.equal(Object.keys(createState.pendingOps).length, 2);
  createB.resolve(); await creations[1];
  assert.equal(creator.creatingChat, 1);
  assert.equal(Object.values(createState.pendingOps)[0].updateId, 20);
} finally {
  createA.resolve(); createB.resolve(); await Promise.all(creations);
}
assert.equal(creator.creatingChat, 0);
assert.equal(Object.keys(createState.pendingOps).length, 0);
assert.deepEqual(createState.telegramPrompts, { A: ['first A'], B: ['first B'] });

console.log('telegram_concurrency: passed (108 chats, bounded reads, slow isolation, topic FIFO, durable waiting inputs, independent pending operations, no replay).');
