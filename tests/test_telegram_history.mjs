import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, conversationEvents, historyPair, readLocalTurnPage, readThread } from '../scripts/telegram_codex.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-history-'));
const id = '11111111-1111-1111-1111-111111111111';
const limit = 'Thread history exceeds the read size limit. Try fewer turns. A single oversized turn cannot be read by this tool.';
const event = (turn, payload) => ({ type: 'event_msg', payload: { thread_id: id, turn_id: turn, ...payload } });
const item = (turn, value) => event(turn, { type: 'item_completed', item: value });
const start = turn => event(turn, { type: 'task_started' });
const cursor = (ordinal, includeAnchor = false) => JSON.stringify({ requestedThreadId: id,
  rolloutOrdinal: ordinal, includeAnchor, scope: { kind: 'turns' } });
const rows = [
  { type: 'session_meta', payload: { id } }, start('one'),
  { type: 'response_item', payload: { role: 'user', content: [{ text: 'AGENTS_MUST_NOT_BE_FORWARDED' }] } },
  item('one', { type: 'FunctionCallOutput', id: 'delegation', namespace: 'codex_app', name: 'send_message_to_thread',
    output: { text: '<codex_delegation>\n<source_thread_id>bridge</source_thread_id>\n<input>First prompt</input>\n</codex_delegation>' } }),
  item('one', { type: 'CommandExecution', id: 'large-tool', aggregated_output: 'PRIVATE_TOOL_OUTPUT'.repeat(10000) }),
  item('one', { type: 'Reasoning', id: 'reason', raw_content: 'PRIVATE_REASONING' }),
  item('one', { type: 'ImageView', id: 'image', data: 'PRIVATE_IMAGE_BYTES' }),
  item('one', { type: 'UserMessage', id: 'steer', content: [{ type: 'text', text: 'Steer' }, { type: 'image', image_url: 'PRIVATE_IMAGE' }] }),
  item('one', { type: 'AgentMessage', id: 'reply-one', phase: 'final_answer', content: [{ type: 'Text', text: 'First reply' }] }),
  event('one', { type: 'task_complete' }), start('two'),
  item('two', { type: 'AgentMessage', id: 'reply-two', phase: 'final_answer', content: [{ type: 'Text', text: 'Second reply' }] }),
  event('two', { type: 'turn_aborted' }), start('three'),
  item('three', { type: 'AgentMessage', id: 'call_question', delivery: 'async', questions: [{ title: 'Choose?', options: ['A', 'B'] }] }),
];
const second = rows.findIndex(r => r.payload?.type === 'task_started' && r.payload.turn_id === 'two');
const third = rows.findIndex(r => r.payload?.type === 'task_started' && r.payload.turn_id === 'three');
const originalHome = process.env.CODEX_HOME;
try {
  fs.mkdirSync(path.join(root, 'sessions'));
  const file = path.join(root, 'sessions', 'rollout-test-' + id + '.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const latest = await readLocalTurnPage(id, {}, root);
  assert.equal(latest.turns[0].status, 'inProgress');
  assert.deepEqual(conversationEvents(latest.turns), [{ key: 'call_question', text: 'Choose?\n- A\n- B', role: 'assistant',
    turnId: 'three', question: true, activeQuestion: true }]);
  const middle = await readLocalTurnPage(id, { cursor: latest.page.nextCursor }, root);
  assert.equal(middle.turns[0].id, 'two');
  assert.equal(middle.turns[0].status, 'interrupted');
  const oldest = await readLocalTurnPage(id, { cursor: middle.page.nextCursor }, root);
  assert.equal(oldest.turns[0].id, 'one');
  assert.equal(oldest.page.nextCursor, null);
  assert.equal(historyPair(oldest.turns[0]).prompt, 'First prompt\n\nSteer\n[Ảnh]');
  assert.deepEqual(oldest.turns[0].items.map(i => i.id), ['delegation', 'steer', 'reply-one']);
  assert(!JSON.stringify(oldest).includes('PRIVATE_'));
  assert(!JSON.stringify(oldest).includes('AGENTS_MUST_NOT_BE_FORWARDED'));
  assert.equal((await readLocalTurnPage(id, { cursor: cursor(second, true) }, root)).turns[0].id, 'two');
  assert.deepEqual((await readLocalTurnPage(id, { cursor: cursor(1) }, root)).turns, []);
  await assert.rejects(readLocalTurnPage(id, { cursor: cursor(5) }, root), /Mốc Codex/);
  await assert.rejects(readLocalTurnPage(id, { cursor: cursor(999) }, root), /Chưa xác minh/);
  await assert.rejects(readLocalTurnPage(id, { cursor: cursor(third).replace(id, 'other') }, root), /Mốc lịch sử/);
  await assert.rejects(readLocalTurnPage('../invalid', {}, root), /ID chat/);
  const calls = [];
  const metadata = { id, kind: 'codex', hostId: 'local', status: { type: 'active', activeFlags: ['waitingOnApproval'] } };
  const call = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'read_thread') throw new Error(limit);
    assert.equal(tool, 'list_threads');
    return { threads: [metadata], pinnedThreads: [] };
  };
  const recovered = await readThread(call, { threadId: id, turnLimit: 1 }, root);
  assert.deepEqual(recovered.thread, metadata, 'runtime flags come from the App, not a guessed local status');
  await readThread(call, { threadId: id, turnLimit: 1, cursor: cursor(second) }, root);
  assert.equal(calls.filter(c => c.tool === 'list_threads').length, 1, 'older pages retain metadata already read');
  await assert.rejects(readThread(async () => { throw new Error('network unavailable'); }, { threadId: id }, root), /network unavailable/);
  const native = { native: true };
  assert.equal(await readThread(async () => native, { threadId: id }, '/missing'), native);
  process.env.CODEX_HOME = root;
  const sent = [];
  const bridge = new Bridge({ ownerId: 42 }, { selected: id, routes: {}, seen: {}, threads: { [id]: { title: 'Test' } }, enabled: { [id]: true } },
    async (tool, args) => tool === 'list_threads' ? { threads: [{ ...metadata, status: { type: 'active', activeFlags: [] } }], pinnedThreads: [] } :
      Promise.reject(new Error(limit)), async (method, args) => { sent.push(args.text); return { message_id: sent.length }; }, () => {});
  await bridge.scan(); await bridge.scan();
  assert.deepEqual(sent, ['[Test]\nChoose?\n- A\n- B'], 'fallback questions arrive once with original IDs');
  assert.equal(bridge.state.awaitingQuestions[id], 'call_question');
  fs.writeFileSync(file, [{ type: 'session_meta', payload: { id: 'wrong' } }, ...rows.slice(1)].map(r => JSON.stringify(r)).join('\n'));
  await assert.rejects(readLocalTurnPage(id, {}, root), /không khớp ID/);
  console.log('telegram_history: oversized-page fallback, native cursor/IDs, no private payloads, runtime flags and deduplication passed.');
} finally {
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'telegram-history-')) throw new Error('Unsafe test cleanup');
  fs.rmSync(root, { recursive: true, force: true });
}
