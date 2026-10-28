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
    output: '<codex_delegation>\n<source_thread_id>bridge</source_thread_id>\n<input>First prompt</input>\n</codex_delegation>' }),
  item('one', { type: 'CommandExecution', id: 'large-tool', aggregated_output: 'PRIVATE_TOOL_OUTPUT'.repeat(10000) }),
  item('one', { type: 'Reasoning', id: 'reason', raw_content: 'PRIVATE_REASONING' }),
  item('one', { type: 'ImageView', id: 'image', data: 'PRIVATE_IMAGE_BYTES' }),
  item('one', { type: 'UserMessage', id: 'steer', content: [{ type: 'text', text: 'Steer' }, { type: 'image', image_url: 'PRIVATE_IMAGE' }] }),
  item('one', { type: 'AgentMessage', id: 'reply-one', phase: 'final_answer', content: [{ type: 'Text', text: 'First reply' }] }),
  event('one', { type: 'task_complete' }), start('two'),
  item('two', { type: 'AgentMessage', id: 'reply-two', phase: 'final_answer', content: [{ type: 'Text', text: 'Second reply' }] }),
  event('two', { type: 'turn_aborted' }), start('three'),
  item('three', { type: 'AgentMessage', id: 'call_question', delivery: 'async', questions: [{ title: 'Choose?', options: ['A', 'B'] }] }),
  item('three', { type: 'AgentMessage', id: 'progress', phase: 'commentary', content: [{ type: 'Text', text: 'Completed progress' }] }),
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
    turnId: 'three', question: true, activeQuestion: true }, { key: 'progress', text: 'Completed progress', role: 'assistant', turnId: 'three' }]);
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
  const currentLimit = await readThread(async (tool, args) => {
    if (tool === 'read_thread') throw new Error('Tool response exceeds the size limit. Request fewer turns or omit outputs. A single oversized turn cannot be returned by this tool.');
    assert.equal(tool, 'list_threads');
    return { threads: [metadata], pinnedThreads: [] };
  }, { threadId: id }, root);
  assert.equal(currentLimit.turns[0].id, 'three', 'current App size-limit wording uses the existing local projection');
  await assert.rejects(readThread(async () => { throw new Error('unrelated timeout'); }, { threadId: id }, root), /unrelated timeout/);
  const recovered = await readThread(call, { threadId: id, turnLimit: 1 }, root);
  assert.deepEqual(recovered.thread, metadata, 'runtime flags come from the App, not a guessed local status');
  await readThread(call, { threadId: id, turnLimit: 1, cursor: cursor(second) }, root);
  assert.equal(calls.filter(c => c.tool === 'list_threads').length, 1, 'older pages retain metadata already read');
  await assert.rejects(readThread(async () => { throw new Error('network unavailable'); }, { threadId: id }, root), /network unavailable/);
  const native = { native: true };
  assert.equal(await readThread(async () => native, { threadId: id }, '/missing'), native);
  const indexedHome = path.join(root, 'indexed');
  fs.mkdirSync(path.join(indexedHome, 'sessions'), { recursive: true });
  const indexedFile = path.join(indexedHome, 'sessions', 'rollout-' + id + '_continued.jsonl');
  fs.writeFileSync(indexedFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const { DatabaseSync } = await import('node:sqlite');
  const indexDb = new DatabaseSync(path.join(indexedHome, 'state_5.sqlite'));
  try {
    indexDb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
    indexDb.prepare('INSERT INTO threads VALUES (?, ?)').run(id, indexedFile);
    const indexed = await readLocalTurnPage(id, {}, indexedHome);
    assert.equal(indexed.turns[0].id, 'three', 'use the owning index for continuation filenames');
    assert.equal((await readLocalTurnPage(id, { cursor: indexed.page.nextCursor }, indexedHome)).turns[0].id, 'two');
    const wrongFile = path.join(indexedHome, 'sessions', 'wrong.jsonl');
    fs.writeFileSync(wrongFile, JSON.stringify({ type: 'session_meta', payload: { id: 'another-thread' } }) + '\n');
    indexDb.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(wrongFile, id);
    await assert.rejects(readLocalTurnPage(id, {}, indexedHome), /không khớp ID chat/);
  } finally { indexDb.close(); }
  process.env.CODEX_HOME = root;
  const sent = [];
  const bridge = new Bridge({ ownerId: 42 }, { selected: id, routes: {}, seen: {}, threads: { [id]: { title: 'Test' } }, enabled: { [id]: true } },
    async (tool, args) => tool === 'list_threads' ? { threads: [{ ...metadata, status: { type: 'active', activeFlags: [] } }], pinnedThreads: [] } :
      Promise.reject(new Error(limit)), async (method, args) => { sent.push(args.text); return { message_id: sent.length }; }, () => {});
  await bridge.scan(); await bridge.scan();
  assert.deepEqual(sent, ['[Test]\nChoose?\n- A\n- B'], 'fallback questions arrive once with original IDs');
  assert.equal(bridge.state.awaitingQuestions[id], 'call_question');
  const syncMessages = [];
  const sync = new Bridge({ ownerId: 42, callerThreadId: 'bridge' }, {
    selected: id, routes: {}, seen: { [id]: { turnId: 'one', keys: [] } },
    threads: { [id]: { title: 'Test' } }, enabled: { [id]: true }, telegramPrompts: { [id]: ['First prompt'] },
  }, async (tool, args) => tool === 'list_threads' ? { threads: [{ ...metadata, status: { type: 'active', activeFlags: [] } }], pinnedThreads: [] } :
    Promise.reject(new Error(limit)), async (method, args) => { syncMessages.push(args.text); return { message_id: syncMessages.length }; }, () => {});
  await sync.scan();
  assert.equal(sync.state.sources.delegation, 'telegram', 'raw string delegation preserves Telegram attribution');
  assert(!syncMessages.some(text => text.includes('First reply')), 'native desktop steer remains manual');
  await sync.update(id);
  assert(syncMessages.some(text => text.includes('First reply')));
  assert(syncMessages.some(text => text.includes('Steer')));
  const deliveredReplyCount = syncMessages.filter(text => text.includes('First reply')).length;
  await sync.update(id);
  assert.equal(syncMessages.filter(text => text.includes('First reply')).length, deliveredReplyCount);
  const historyMessages = [];
  const importer = new Bridge({ ownerId: 42 }, { threads: { [id]: { title: 'Test' } }, routes: {}, seen: {} },
    async tool => tool === 'list_threads' ? { threads: [metadata], pinnedThreads: [] } : Promise.reject(new Error(limit)),
    async (method, args) => { historyMessages.push(args.text); return { message_id: historyMessages.length }; }, () => {});
  await importer.importRecentHistory(id);
  assert(historyMessages.some(text => text.includes('First prompt')));
  assert(historyMessages.some(text => text.includes('First reply')));
  fs.appendFileSync(file, '{"type":"event_msg",');
  assert.equal((await readLocalTurnPage(id, {}, root)).turns[0].id, 'three', 'live partial tail does not break completed history');
  fs.appendFileSync(file, '"payload":' + JSON.stringify({ thread_id: id, turn_id: 'three', type: 'item_completed', item: {
    type: 'AgentMessage', id: 'appended', phase: 'commentary', content: [{ type: 'Text', text: 'New visible progress' }],
  } }) + '}\n');
  const createStream = fs.createReadStream, offsets = [];
  try {
    fs.createReadStream = (name, options) => { offsets.push(options?.start); return createStream(name, options); };
    const appended = await readLocalTurnPage(id, {}, root);
    assert(appended.turns[0].items.some(item => item.id === 'appended'), 'finish a partial line without losing the event');
    assert(offsets[0] > 0, 'polling reads only bytes appended after the previous complete snapshot');
    offsets.length = 0;
    assert.deepEqual(await readLocalTurnPage(id, {}, root), appended);
    assert.deepEqual(offsets, [], 'unchanged history does not reopen the full rollout stream');
    fs.appendFileSync(file, [event('three', { type: 'task_complete' }), start('four'),
      item('four', { type: 'AgentMessage', id: 'four-progress', phase: 'commentary', content: [{ type: 'Text', text: 'Fourth turn' }] }),
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const fourth = await readLocalTurnPage(id, {}, root);
    assert.equal(fourth.turns[0].id, 'four');
    assert.equal((await readLocalTurnPage(id, { cursor: fourth.page.nextCursor }, root)).turns[0].id, 'three',
      'incremental reads retain native cursor line ordinals');
    const changed = fs.readFileSync(file, 'utf8').replace('Fourth turn', 'FOURTH TURN');
    fs.writeFileSync(file, changed);
    const rebuilt = await readLocalTurnPage(id, {}, root);
    assert.equal(rebuilt.turns[0].items[0].text, 'FOURTH TURN', 'rewrites invalidate the append cache');
    assert.equal(offsets.at(-1), 0);
  } finally { fs.createReadStream = createStream; }
  const longReply = 'Full response '.repeat(2500);
  const fullRows = [{ type: 'session_meta', payload: { id } }];
  for (let n = 0; n < 25; n++) fullRows.push(start('full-' + n),
    item('full-' + n, { type: 'UserMessage', id: 'prompt-' + n, content: [{ type: 'text', text: 'Prompt ' + n }] }),
    item('full-' + n, { type: 'AgentMessage', id: 'full-answer-' + n, phase: 'final_answer', content: [{ type: 'Text', text: longReply }] }),
    event('full-' + n, { type: 'task_complete' }));
  fs.writeFileSync(file, fullRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const full = await readLocalTurnPage(id, { all: true }, root);
  assert.equal(full.turns.length, 25, '/full must exceed the twenty-pair history limit');
  assert.equal(full.page.nextCursor, null);
  assert.equal(full.turns[0].id, 'full-24'); assert.equal(full.turns.at(-1).id, 'full-0');
  assert.equal(full.turns[0].items.at(-1).text, longReply, 'full history does not truncate responses at 20,000 characters');
  const continuation = path.join(root, 'sessions', 'rollout-z-' + id + '_22222222-2222-2222-2222-222222222222.jsonl');
  fs.writeFileSync(continuation, [{ type: 'session_meta', payload: { id } }, start('continued'),
    item('continued', { type: 'UserMessage', id: 'continued-prompt', content: [{ type: 'text', text: 'Newest continuation' }] }),
    event('continued', { type: 'task_complete' })].map(r => JSON.stringify(r)).join('\n'));
  const continued = await readLocalTurnPage(id, { all: true }, root);
  assert.equal(continued.turns.length, 26);
  assert.equal(continued.turns[0].id, 'continued', '/full includes rotated session files for the same Codex chat');
  fs.unlinkSync(continuation);
  fs.writeFileSync(file, [{ type: 'session_meta', payload: { id: 'wrong' } }, ...rows.slice(1)].map(r => JSON.stringify(r)).join('\n'));
  await assert.rejects(readLocalTurnPage(id, {}, root), /không khớp ID/);
  console.log('telegram_history: oversized-page fallback, native cursor/IDs, no private payloads, runtime flags and deduplication passed.');
} finally {
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'telegram-history-')) throw new Error('Unsafe test cleanup');
  fs.rmSync(root, { recursive: true, force: true });
}
