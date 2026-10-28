import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { Bridge } from '../scripts/telegram_codex.mjs';

const gate = () => Promise.withResolvers();
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert(Date.now() < deadline, 'outbox did not make independent progress'); await pause(5); }
}
const config = { ownerId: 42, chatId: -1001234 };
const stateFor = ids => ({ topicMode: true, realtimeBaseline: {}, routes: {},
  enabled: Object.fromEntries(ids.map(id => [id, true])),
  topics: Object.fromEntries(ids.map((id, i) => [id, 101 + i])),
  threads: Object.fromEntries(ids.map(id => [id, { id, title: id, status: 'idle', updatedAt: 2 }])),
  seen: Object.fromEntries(ids.map(id => [id, { turnId: id, updatedAt: 1, keys: [] }])),
});

// Four slow uploads/sends previously occupied the entire read pool. A fifth
// chat must now be read, durably queued, and delivered before any of them finish.
const ids = ['A', 'B', 'C', 'D', 'E'], state = stateFor(ids);
const blocked = new Map(ids.slice(0, 4).map((_, i) => [101 + i, gate()]));
const reads = [], sent = [], snapshots = [];
const bridge = new Bridge(config, state, async (tool, args) => {
  assert.equal(tool, 'read_thread'); reads.push(args.threadId);
  return { page: {}, thread: { status: { type: 'idle' } }, turns: [{ id: args.threadId, status: 'completed', items: [
    { type: 'agentMessage', id: 'reply-' + args.threadId, text: 'reply ' + args.threadId, phase: 'final_answer' },
  ] }] };
}, async (_method, body) => {
  if (blocked.has(body.message_thread_id)) await blocked.get(body.message_thread_id).promise;
  sent.push(body); return { message_id: sent.length };
}, () => snapshots.push(structuredClone(state)));
try {
  await bridge.scan({ wait: false });
  await until(() => reads.length === 5 && sent.some(m => m.message_thread_id === 105));
  assert.equal(sent.length, 1, 'healthy chat delivers while four other chat senders are blocked');
  assert.equal(bridge.scans.size, 0, 'slow Telegram sends release all read slots');
  assert.equal(bridge.deliveryWorkers.size, 4);
  assert.equal(state.outbox.A[0].event.key, 'reply-A');
  assert(state.seen.A.keys.includes('reply-A'));
  assert(snapshots.some(s => s.outbox.A?.[0]?.event.key === 'reply-A' && !s.delivered?.A?.includes('reply-A')));
} finally {
  for (const item of blocked.values()) item.resolve();
  await bridge.scan();
}
assert.equal(sent.length, 5);
assert.deepEqual(state.outbox, {});

// Save two acknowledged text chunks, fail at the file, then restart. The new
// worker resumes at the file rather than sending the acknowledged prefix again.
const partialState = stateFor(['A']), retry = gate(), attempts = [];
let broken = true;
const partial = new Bridge(config, partialState, async () => assert.fail('outbox must not rerun model prompts'),
  async (method, body) => {
    attempts.push({ method, body });
    if (method === 'sendDocument' && broken) throw new Error('upload acknowledgement timeout');
    return { message_id: attempts.length };
  }, () => {});
partial.pauseDelivery = () => retry.promise;
const event = { key: 'long-event', role: 'assistant', text: 'x'.repeat(5000) + ' [report](D:/work/report.pdf) tail' };
partial.queueDelivery('A', event);
await until(() => partialState.outbox.A?.[0]?.attempts === 1);
assert.equal(partialState.deliveryParts['A:101:long-event'].next, 2);
assert(!partialState.delivered.A?.includes(event.key));
const durable = JSON.parse(JSON.stringify(partialState)), resumed = [];
const restored = new Bridge(config, durable, async () => assert.fail('restart must only resume delivery'),
  async (method, body) => { resumed.push({ method, body }); return { message_id: 100 + resumed.length }; }, () => {});
await restored.startDelivery('A');
assert.deepEqual(resumed.map(item => item.method), ['sendDocument', 'sendMessage']);
assert.equal(resumed[1].body.text, ' tail');
assert(durable.delivered.A.includes(event.key));
assert.deepEqual(durable.outbox, {});
assert.deepEqual(durable.deliveryParts, {});
broken = false; retry.resolve(); await partial.deliveryWorkers.get('A');
assert.equal(attempts.filter(item => item.method === 'sendMessage' && item.body.text.startsWith('x')).length, 2);

// More than a handful of failures still cannot silently exhaust delivery.
const manyState = stateFor(['A']), retries = [];
let failures = 12, successes = 0;
const many = new Bridge(config, manyState, async () => {}, async () => {
  if (failures-- > 0) throw new Error('network unavailable');
  successes++; return { message_id: 1 };
}, () => {});
many.pauseDelivery = async delay => { retries.push(delay); };
many.queueDelivery('A', { key: 'eventually', role: 'assistant', text: 'must arrive' });
await many.deliveryWorkers.get('A');
assert.equal(retries.length, 12);
assert(retries.every(delay => delay <= 60000));
assert.equal(successes, 1);
assert(manyState.delivered.A.includes('eventually'));

// An owner-copy whose acknowledgement is lost can be confirmed by its incoming
// Telegram update. It must never become a fresh Codex prompt during retries.
const ownerState = stateFor(['A']); let ownerSends = 0;
let ownerCopy;
ownerCopy = new Bridge(config, ownerState, async () => assert.fail('history copy must not become a model prompt'),
  async () => ({ message_id: 1 }), () => {}, undefined,
  async (text, topic, receipt) => {
    ownerSends++; assert.match(receipt.randomId, /^-?\d+$/);
    await ownerCopy.handle({ message: { message_id: 444, chat: { id: config.chatId, type: 'supergroup' },
      from: { id: config.ownerId }, message_thread_id: topic, text } });
    throw new Error('owner send acknowledgement lost');
  });
ownerCopy.pauseDelivery = async () => {};
ownerCopy.queueDelivery('A', { key: 'copied-prompt', role: 'user', origin: 'desktop', text: 'original desktop prompt' });
await ownerCopy.deliveryWorkers.get('A');
assert.equal(ownerSends, 1);
assert(ownerState.ignoredPrompts[config.chatId + ':444']);
assert(ownerState.delivered.A.includes('copied-prompt'));
assert.deepEqual(ownerState.outbox, {});

// A crash after the delivered receipt was saved but before queue removal must
// not resend the event on restart.
durable.outbox.A = [{ event }];
const acknowledged = new Bridge(config, durable, async () => {}, async () => assert.fail('already acknowledged event'), () => {});
await acknowledged.startDelivery('A');
assert.deepEqual(durable.outbox, {});
console.log('telegram_outbox: independent senders, durable queue, partial/restart receipts, unlimited transient retries, owner-copy safety and acknowledged-event dedup passed.');
