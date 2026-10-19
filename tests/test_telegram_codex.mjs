import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, authorized, chunks, destination, events, pipeRequest, desktopRequest, localProjects, telegramImage, saveTelegramImage, quotaText, historyPair } from '../scripts/telegram_codex.mjs';

const owner = 1234;
const msg = { chat: { id: owner, type: 'private' }, from: { id: owner }, text: 'sửa đoạn này' };
assert(authorized(msg, owner));
assert(!authorized({ ...msg, from: { id: 99 } }, owner));
assert(!authorized({ ...msg, chat: { id: owner, type: 'group' } }, owner));
assert(!authorized(msg, null));
assert(authorized({ ...msg, chat: { id: -1001234, type: 'supergroup' } }, owner, -1001234));
assert(!authorized({ ...msg, chat: { id: -1009999, type: 'supergroup' } }, owner, -1001234));
assert(!authorized({ ...msg, from: { id: 99 }, chat: { id: -1001234, type: 'supergroup' } }, owner, -1001234));
assert.equal(destination({ reply_to_message: { message_id: 7 } }, { routes: { 7: 'A' }, selected: 'B' }), 'A');
assert.equal(destination({ reply_to_message: { message_id: 9 } }, { routes: {}, selected: 'B' }), null);
const long = '😀 xin chào '.repeat(1000);
assert.equal(chunks(long).join(''), long);
assert(chunks(long).every(part => Array.from(part).length <= 3500));
assert.equal(events([{ id: 't', status: 'inProgress', items: [{ type: 'agentMessage', id: 'm', text: 'partial' }] }]).length, 0);

const state = { routes: { 7: 'A' }, selected: 'B', threads: { A: { title: 'Chat A' }, B: { title: 'Chat B' } }, seen: {} };
const calls = [], sent = [];
let persistedPending = false;
let fail = false;
const bridge = new Bridge({ ownerId: owner }, state, async (tool, args) => {
  calls.push({ tool, args });
  if (tool === 'send_message_to_thread') {
    assert(persistedPending);
    if (fail) throw new Error('timeout');
    return { threadId: args.threadId };
  }
}, async (method, args) => { sent.push(args); return { message_id: 100 + sent.length }; },
() => { if (state.pending) persistedPending = true; });
await bridge.handle({ update_id: 1, message: { ...msg, from: { id: 99 } } });
assert.equal(calls.length, 0);
await bridge.handle({ update_id: 2, message: { ...msg, reply_to_message: { message_id: 7 } } });
assert.deepEqual(calls[0], { tool: 'send_message_to_thread', args: { threadId: 'A', hostId: 'local', prompt: msg.text } });
await bridge.handle({ update_id: 3, message: { ...msg, reply_to_message: { message_id: 999 } } });
assert.equal(calls.length, 1);
fail = true;
await bridge.handle({ update_id: 4, message: msg });
assert.equal(calls.length, 2, 'uncertain dispatch must not retry');
assert(sent.at(-1).text.includes('không tự gửi lại'));
assert.equal(state.pending, undefined);

// Real framed transport with fragmented bytes, including a multibyte response.
const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\telegram-codex-test-' + process.pid : '/tmp/telegram-codex-test-' + process.pid;
const server = net.createServer(socket => {
  let request = Buffer.alloc(0);
  socket.on('data', chunk => {
    request = Buffer.concat([request, chunk]);
    if (request.length < 4 || request.length < request.readUInt32LE(0) + 4) return;
    const parsed = JSON.parse(request.subarray(4));
    assert.equal(parsed.method, 'tools/list');
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'đã nối 😀' } }));
    const frame = Buffer.alloc(body.length + 4);
    frame.writeUInt32LE(body.length); body.copy(frame, 4);
    socket.write(frame.subarray(0, 3));
    setTimeout(() => socket.write(frame.subarray(3)), 5);
  });
});
await new Promise(resolve => server.listen(endpoint, resolve));
try { assert.deepEqual(await pipeRequest(endpoint, 'tools/list', {}), { text: 'đã nối 😀' }); }
finally { await new Promise(resolve => server.close(resolve)); }

// Desktop IPC initializes before an exact-turn interrupt; unrelated broadcasts are ignored.
const ipcServer = net.createServer(socket => {
  let input = Buffer.alloc(0);
  socket.on('data', chunk => {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4 && input.length >= input.readUInt32LE(0) + 4) {
      const length = input.readUInt32LE(0);
      const request = JSON.parse(input.subarray(4, length + 4)); input = input.subarray(length + 4);
      if (request.method === 'initialize') assert.equal(request.sourceClientId, 'initializing-client');
      else {
        assert.equal(request.sourceClientId, 'client-test');
        assert.equal(request.method, 'thread-follower-interrupt-turn');
        assert.equal(request.version, 4);
        assert.equal(request.targetClientId, 'owner-test');
        assert.deepEqual(request.params, { conversationId: 'A', mode: 'user-stop', expectedTurnId: 'turn-test' });
      }
      const messages = [{ type: 'broadcast', method: 'irrelevant' }, { type: 'response', requestId: request.requestId,
        method: request.method, resultType: 'success', result: request.method === 'initialize' ?
          { clientId: 'client-test' } : { ok: true, interruptedTurnId: 'turn-test' } }];
      for (const message of messages) {
        const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      }
    }
  });
});
await new Promise(resolve => ipcServer.listen(endpoint, resolve));
try {
  const result = await desktopRequest('thread-follower-interrupt-turn',
    { conversationId: 'A', mode: 'user-stop', expectedTurnId: 'turn-test' }, 4, 'owner-test', endpoint);
  assert.equal(result.result.interruptedTurnId, 'turn-test');
} finally { await new Promise(resolve => ipcServer.close(resolve)); }

// Only selected chats are scanned. Desktop output waits for /update.
const t = { id: 'A', kind: 'codex', hostId: 'local', status: 'active', title: 'Chat A', updatedAt: 1 };
const desktopTurn = (id, text, status = 'completed') => ({ id, status, items: [
  { type: 'userMessage', id: id + '-prompt', content: [{ type: 'text', text: 'desktop ' + id }] },
  { type: 'agentMessage', id: id + '-reply', text },
] });
const telegramAnchor = { id: 'anchor', status: 'completed', items: [
  { type: 'functionCallOutput', id: 'anchor-prompt', namespace: 'codex_app', name: 'send_message_to_thread',
    output: { text: '<codex_delegation>\n<source_thread_id>bridge</source_thread_id>\n<input>anchor</input>\n</codex_delegation>' } },
] };
let turns = [desktopTurn('one', 'desktop response one'), telegramAnchor], flags = [];
const scanState = { routes: { old: 'UNSELECTED' }, selected: 'A', topics: { UNSELECTED: 99 },
  threads: { A: t, UNSELECTED: { title: 'Unselected' }, C: { title: 'C' } }, seen: {},
  delivered: { A: ['anchor-prompt'] }, sources: { 'anchor-prompt': 'telegram' } };
const outgoing = [], scanReads = [], cancelCalls = [];
const scanner = new Bridge({ ownerId: owner, callerThreadId: 'bridge' }, scanState, async (tool, args) => {
  if (tool === 'send_message_to_thread') return {};
  assert.equal(tool, 'read_thread'); scanReads.push(args.threadId);
  if (args.threadId === 'C') return { turns: [], page: {}, thread: { status: {} } };
  assert.equal(args.threadId, 'A', 'recent chats and old auto-created topics must stay dormant');
  if (args.cursor) return { turns: [], page: {} };
  return { turns, page: {}, thread: { status: { type: 'active', activeFlags: flags } } };
}, async (method, args) => { outgoing.push(args); return { message_id: outgoing.length }; }, () => {},
undefined, undefined, async (id, turnId) => { cancelCalls.push({ id, turnId }); return { interruptedTurnId: turnId }; });
await scanner.scan(); assert.equal(outgoing.length, 0);
turns.unshift(desktopTurn('two', 'desktop response two'));
await scanner.scan(); assert.equal(outgoing.length, 0);
await scanner.handle({ message: { ...msg, text: '/update' } });
assert(outgoing.some(m => m.text.includes('desktop response two')));
const count = outgoing.filter(m => m.text.includes('desktop response')).length;
await scanner.handle({ message: { ...msg, text: '/update' } });
assert.equal(outgoing.filter(m => m.text.includes('desktop response')).length, count, 'manual sync must not duplicate');
const delegatedTurn = (id, prompt, reply, caller = 'bridge') => ({ id, status: 'completed', items: [
  { type: 'functionCallOutput', id: id + '-prompt', namespace: 'codex_app', name: 'send_message_to_thread',
    output: { text: '<codex_delegation>\n<source_thread_id>' + caller + '</source_thread_id>\n<input>' + prompt + '</input>\n</codex_delegation>' } },
  { type: 'agentMessage', id: id + '-reply', text: reply },
] });
await scanner.handle({ message: { ...msg, text: 'telegram request' } });
turns.unshift(delegatedTurn('tele', 'telegram request', 'TELEGRAM_AUTO_OK'));
await scanner.scan(); await scanner.scan();
assert.equal(outgoing.filter(m => m.text.includes('TELEGRAM_AUTO_OK')).length, 1);
// A Telegram response still streaming must wait, then finish once, also after restart.
await scanner.handle({ message: { ...msg, text: 'stream request' } });
const streaming = delegatedTurn('stream', 'stream request', 'STREAM_FINAL_OK');
streaming.status = 'inProgress'; turns.unshift(streaming);
await scanner.scan();
assert(!outgoing.some(m => m.text.includes('STREAM_FINAL_OK')));
streaming.status = 'completed'; await scanner.scan();
assert.equal(outgoing.filter(m => m.text.includes('STREAM_FINAL_OK')).length, 1);
const restarted = new Bridge(scanner.config, JSON.parse(JSON.stringify(scanState)), scanner.call,
  scanner.telegram, () => {});
await restarted.scan();
assert.equal(outgoing.filter(m => m.text.includes('STREAM_FINAL_OK')).length, 1);
const afterAuto = outgoing.length;
await scanner.handle({ message: { ...msg, text: '/update' } });
assert.equal(outgoing.filter(m => m.text.includes('TELEGRAM_AUTO_OK')).length, 1);
assert(!outgoing.slice(afterAuto).some(m => m.text.includes('telegram request')), 'original Telegram prompt is already visible');
// Steer changes the source only from that prompt onward, within the same turn.
await scanner.handle({ message: { ...msg, text: 'steer' } });
const mixed = desktopTurn('mixed', 'DESKTOP_BEFORE_STEER');
mixed.items.push(...delegatedTurn('mixed-steer', 'steer', 'TELEGRAM_AFTER_STEER').items);
mixed.items.push(...desktopTurn('desktop-after', 'DESKTOP_AFTER_STEER').items);
turns.unshift(mixed);
await scanner.scan();
assert(!outgoing.some(m => m.text.includes('DESKTOP_BEFORE_STEER')));
assert(outgoing.some(m => m.text.includes('TELEGRAM_AFTER_STEER')));
await scanner.update('A');
assert(!outgoing.some(m => m.text.includes('DESKTOP_BEFORE_STEER')), 'exclude everything before the latest Telegram prompt, even inside the same turn');
assert(outgoing.some(m => m.text.includes('DESKTOP_AFTER_STEER')));
assert.equal(outgoing.filter(m => m.text.includes('TELEGRAM_AFTER_STEER')).length, 1);
const noAnchorReplies = [];
const noAnchor = new Bridge({ ownerId: owner }, { selected: 'A', routes: {}, threads: { A: t }, seen: {} },
  async () => assert.fail('no Telegram prompt means no history import'),
  async (method, args) => { noAnchorReplies.push(args.text); return { message_id: 1 }; }, () => {});
await noAnchor.update('A');
assert(noAnchorReplies[0].includes('Chưa có prompt Telegram làm mốc'));
// Pending approvals notify without /update, once per waiting episode.
flags = ['waitingOnApproval'];
await scanner.scan(); await scanner.scan();
assert.equal(outgoing.filter(m => m.text.includes('đang chờ bạn cấp quyền')).length, 1);
flags = []; await scanner.scan(); flags = ['waitingOnApproval']; await scanner.scan();
assert.equal(outgoing.filter(m => m.text.includes('đang chờ bạn cấp quyền')).length, 2);
assert(scanReads.every(id => id !== 'UNSELECTED'));
await assert.rejects(scanner.topic('UNSELECTED'), /chưa được chọn/);
// /cancel interrupts the actual active turn, never sends a stop prompt.
turns[0].status = 'inProgress';
await scanner.handle({ message: { ...msg, text: '/cancel' } });
assert.deepEqual(cancelCalls, [{ id: 'A', turnId: 'mixed' }]);
scanState.newChats[owner + ':0'] = 'P';
await scanner.handle({ message: { ...msg, text: '/cancel' } });
assert.equal(cancelCalls.length, 1, 'cancel wizard before stopping an unrelated chat');
turns[0].status = 'completed';
await scanner.handle({ message: { ...msg, text: '/cancel' } });
assert.equal(cancelCalls.length, 1);
scanner.state.enabled.C = true;
const normalCall = scanner.call;
scanner.call = async (tool, args) => { if (args.threadId === 'A') throw new Error('history limit'); return normalCall(tool, args); };
await scanner.scan(); assert(scanner.state.seen.C, 'a broken chat must not block the other selected chat');
await scanner.handle({ message: { ...msg, text: '/update' } });
assert(outgoing.at(-1).text.includes('Chưa cập nhật đủ tin từ desktop: history limit'));

// Topics are the routing authority, including when a reply or selection disagrees.
const topicState = {
  enabled: { A: true, B: true }, topicMode: true, topics: { A: 101, B: 202 }, routes: { 7: 'B' }, selected: 'B',
  threads: { A: { title: 'Chat A' }, B: { title: 'Chat B' } }, seen: {},
};
assert.equal(destination({ message_thread_id: 101, reply_to_message: { message_id: 7 } }, topicState), 'A');
assert.equal(destination({ message_thread_id: 999 }, topicState), null);
assert.equal(destination({}, topicState), null);
assert.equal(destination({ chat: { id: -1001234, type: 'supergroup' }, reply_to_message: { message_id: 7 } }, topicState), null);
const topicCalls = [], topicMessages = [];
const topics = new Bridge({ ownerId: owner }, topicState, async (tool, args) => {
  topicCalls.push({ tool, args }); return {};
}, async (method, args) => {
  topicMessages.push({ method, args });
  if (method === 'createForumTopic') return { message_thread_id: 303 };
  return { message_id: 1000 + topicMessages.length };
}, () => {});
await topics.handle({ update_id: 100, message: { ...msg, message_thread_id: 101 } });
assert.equal(topicCalls[0].args.threadId, 'A');
assert.equal(topicMessages.at(-1).args.message_thread_id, 101);
await topics.handle({ update_id: 101, message: { ...msg, message_thread_id: 999 } });
await topics.handle({ update_id: 102, message: msg });
assert.equal(topicCalls.length, 1, 'unknown topics and the lobby must not use the selected chat');
await topics.handle({ update_id: 103, message: { ...msg, text: undefined, forum_topic_created: { name: 'A' } } });
assert.equal(topicCalls.length, 1, 'service messages must not become prompts');
delete topicState.topics.B;
await Promise.all([topics.send('first', 'B'), topics.send('second', 'B')]);
assert.equal(topicMessages.filter(m => m.method === 'createForumTopic').length, 1);
assert(topicMessages.slice(-2).every(m => m.args.message_thread_id === 303));
const groupState = { ...topicState, routes: {}, topics: { A: 101, B: 202 } };
const groupMessages = [];
const groupBridge = new Bridge({ ownerId: owner, chatId: -1001234 }, groupState, async () => ({}),
  async (method, args) => { groupMessages.push(args); return { message_id: 7 }; }, () => {});
await groupBridge.send('answer', 'A');
assert.equal(groupMessages[0].text, 'answer', 'topic replies have no redundant title prefix');
assert.equal(groupMessages[0].chat_id, -1001234);
assert.equal(groupMessages[0].message_thread_id, 101);
assert.equal(groupState.routes['-1001234:7'], 'A');
await groupBridge.handle({ update_id: 104, message: { ...msg, text: '/help' } });
assert.equal(groupMessages.at(-1).chat_id, owner, 'private help must remain private');

// Manual import stops at the Telegram boundary; opening a topic imports nothing.
const historyTurn = n => ({ id: 'history-' + n, status: 'completed', items: [
  { type: 'userMessage', content: [{ type: 'text', text: 'prompt ' + n }] },
  { type: 'agentMessage', id: 'comment-' + n, phase: 'commentary', text: 'working' },
  { type: 'commandExecution', output: { text: 'PRIVATE_TOOL_LOG' } },
  { type: 'agentMessage', id: 'answer-' + n, phase: 'final_answer', text: 'response ' + n },
] });
assert.equal(historyPair({ ...historyTurn(1), status: 'inProgress' }), null);
assert.equal(historyPair({ status: 'completed', items: [historyTurn(1).items.at(-1)] }), null);
const delegated = { id: 'delegated', status: 'completed', items: [
  { type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread',
    output: { text: '<codex_delegation>\n<source_thread_id>source</source_thread_id>\n<input>Telegram prompt</input>\n</codex_delegation>' } },
  historyTurn(1).items.at(-1),
] };
assert.equal(historyPair(delegated).prompt, 'Telegram prompt');
assert.equal(historyPair({ ...delegated, items: [{ ...delegated.items[0], name: 'arbitrary_tool' }, delegated.items[1]] }), null);
assert.equal(historyPair({ ...delegated, items: [{ ...delegated.items[0], name: 'create_thread' }, delegated.items[1]] }).prompt, 'Telegram prompt');

const historyTurns = [{ ...historyTurn(8), status: 'inProgress' },
  ...Array.from({ length: 5 }, (_, i) => historyTurn(7 - i)), telegramAnchor, historyTurn(2), historyTurn(1)];
const historyState = { enabled: { A: true }, topicMode: true, topics: {}, routes: {}, threads: { A: { ...t } },
  delivered: { A: ['anchor-prompt'] }, sources: { 'anchor-prompt': 'telegram' },
  seen: { A: { keys: [], turnId: 'history-7', updatedAt: 0 } } };
const historyCalls = [], historyMessages = [];
const historyBridge = new Bridge({ ownerId: owner }, historyState, async (tool, args) => {
  historyCalls.push({ tool, args });
  if (tool === 'list_threads') return { pinnedThreads: [], threads: [{ ...t, status: 'notLoaded', updatedAt: 2 }] };
  assert.equal(tool, 'read_thread'); assert.equal(args.turnLimit, 1);
  if (!args.includeOutputs) return { turns: [historyTurn(7)], page: {} };
  const index = Number(args.cursor || 0);
  await new Promise(resolve => setImmediate(resolve));
  return { turns: [historyTurns[index]], page: { nextCursor: String(index + 1) } };
}, async (method, args) => {
  historyMessages.push({ method, args });
  return method === 'createForumTopic' ? { message_thread_id: 505 } : { message_id: historyMessages.length };
}, () => {});
await Promise.all([historyBridge.send('connected', 'A'), historyBridge.send('connected again', 'A')]);
assert.equal(historyMessages.filter(m => m.method === 'createForumTopic').length, 1);
assert.equal(historyCalls.length, 0, 'opening a topic must not import desktop history');
await historyBridge.update('A');
assert.equal(historyCalls.filter(c => c.tool === 'read_thread').length, 7, 'walk back to the Telegram prompt even past five turns');
const imported = historyMessages.filter(m => m.method === 'sendMessage').map(m => m.args.text);
assert.deepEqual(imported.filter(text => /^response/.test(text)), [3,4,5,6,7].map(n => 'response ' + n));
assert(!imported.join('\n').includes('PRIVATE_TOOL_LOG'));
const historyCount = historyMessages.length;
await historyBridge.scan();
assert.equal(historyMessages.length, historyCount, 'desktop responses must not auto-forward after manual sync');

// Personal-account history keeps the sender roles and never re-executes old prompts.
const roleMessages = [], replayUpdates = [], roleCalls = [];
const roleState = { enabled: { A: true }, topicMode: true, topics: {}, routes: {}, threads: { A: { title: 'A' } }, seen: {},
  delivered: { A: ['anchor-prompt'] }, sources: { 'anchor-prompt': 'telegram' } };
let roleBridge, personalId = 9000;
roleBridge = new Bridge({ ownerId: owner, chatId: -1001234 }, roleState, async (tool, args) => {
  roleCalls.push({ tool, args });
  if (tool === 'read_thread') return { turns: [historyTurn(1), telegramAnchor], page: {} };
  return {};
}, async (method, args) => {
  roleMessages.push({ sender: 'bot', method, ...args });
  return { message_thread_id: 707, message_id: roleMessages.length };
}, () => {}, undefined, async (text, topicId) => {
  const id = ++personalId;
  assert.equal(roleState.historyPending['-1001234:707'], text, 'persist replay intent before sending');
  roleMessages.push({ sender: 'user', text, topicId });
  const replay = { ...msg, message_id: id, text, message_thread_id: topicId, chat: { id: -1001234, type: 'supergroup' } };
  replayUpdates.push(roleBridge.handle({ message: replay })); // Bot update can arrive before sendMessage returns.
  return { id };
});
await roleBridge.send('connected', 'A');
await roleBridge.update('A');
await Promise.all(replayUpdates);
assert(roleMessages.some(m => m.sender === 'user' && m.text === 'prompt 1' && m.topicId === 707));
assert(roleMessages.some(m => m.sender === 'bot' && m.text === 'response 1' && m.message_thread_id === 707));
assert(!roleMessages.some(m => /^Bạn:|^Codex:/.test(m.text || '')), 'real sender roles need no artificial prefixes');
assert(!roleCalls.some(c => c.tool === 'send_message_to_thread'), 'replayed history must not become a Codex prompt');
await roleBridge.handle({ message: { ...msg, text: 'fresh prompt', message_id: 9999,
  message_thread_id: 707, chat: { id: -1001234, type: 'supergroup' } } });
assert.equal(roleCalls.filter(c => c.tool === 'send_message_to_thread').length, 1, 'fresh user messages still dispatch');
roleState.historyPending['-1001234:707'] = 'uncertain replay';
await roleBridge.handle({ message: { ...msg, text: 'uncertain replay', message_id: 10000,
  message_thread_id: 707, chat: { id: -1001234, type: 'supergroup' } } });
assert.equal(roleCalls.filter(c => c.tool === 'send_message_to_thread').length, 1, 'an uncertain replay after restart must not execute');
assert(roleMessages.at(-1).text.includes('kết quả gửi chưa xác định'));

// Quota is an account command: no prompt dispatch, even while New chat is pending.
const quota = { rateLimitsByLimitId: { codex: { limitId: 'codex',
  primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1767225600 },
  secondary: { usedPercent: 100, windowDurationMins: 10080 }, credits: { balance: '12.5' } } },
  rateLimits: { primary: { usedPercent: 99 } } };
const formattedQuota = quotaText(quota);
assert(formattedQuota.includes('5 giờ: còn 77%'));
assert(formattedQuota.includes('Tuần: còn 0%'));
assert(formattedQuota.includes('7:00:00') && formattedQuota.includes('giờ VN'));
assert(formattedQuota.includes('Credit: 12,5'));
assert(!formattedQuota.includes('còn 1%'), 'prefer named limit buckets over the legacy snapshot');
assert(quotaText({}).includes('Chưa lấy được'));
assert(quotaText({ rateLimits: { primary: { usedPercent: null } } }).includes('chưa có dữ liệu'));
const quotaCalls = [], quotaReplies = [];
let quotaFails = false;
const quotaState = { topicMode: true, routes: {}, threads: {}, seen: {}, newChats: { [owner + ':101']: 'P' } };
const quotaBridge = new Bridge({ ownerId: owner, botUsername: 'our_bot' }, quotaState,
  async (tool, args) => { quotaCalls.push({ tool, args }); if (quotaFails) throw new Error('offline'); return quota; },
  async (method, args) => { quotaReplies.push(args); return { message_id: quotaReplies.length }; }, () => {});
for (const text of ['/quota', '/quota@OUR_BOT']) {
  await quotaBridge.handle({ message: { ...msg, text, message_thread_id: 101 } });
  assert.equal(quotaReplies.at(-1).text, formattedQuota);
  assert.equal(quotaReplies.at(-1).message_thread_id, 101);
}
assert(quotaCalls.every(c => c.tool === 'get_usage_limits'));
assert.equal(quotaState.newChats[owner + ':101'], 'P');
await quotaBridge.handle({ message: { ...msg, text: '/quota', from: { id: 99 } } });
await quotaBridge.handle({ message: { ...msg, text: '/quota@another_bot' } });
assert.equal(quotaCalls.length, 2);
quotaFails = true;
await quotaBridge.handle({ message: { ...msg, text: '/quota' } });
assert(quotaReplies.at(-1).text.includes('Chưa đọc được hạn mức Codex: offline'));

// Projects -> project menu -> explicit New chat -> first prompt.
const project = { projectId: 'P', projectKind: 'local', hostId: 'local', label: 'My project' };
assert.deepEqual(localProjects({ projects: [project, { ...project, hostId: 'remote' }, { ...project, projectKind: 'chatgpt' }] }), [project]);
const recent = Array.from({ length: 7 }, (_, i) => ({ ...t, id: 'r' + i, title: 'Recent ' + i, projectId: 'P', updatedAt: i }));
const createState = { topicMode: true, routes: {}, threads: {}, seen: {} };
const createCalls = [], createMessages = [];
let creationFails = false, projectAvailable = true;
let creator;
creator = new Bridge({ ownerId: owner, callerThreadId: 'bridge', botUsername: 'our_bot' }, createState, async (tool, args) => {
  createCalls.push({ tool, args });
  if (tool === 'list_projects') return { projects: projectAvailable ? [project] : [] };
  if (tool === 'list_threads') return { pinnedThreads: [], threads: [...recent, { ...t, id: 'other', projectId: 'Q' },
    ...(creator.creatingChat || createState.threads.created ? [{ ...t, id: 'created', projectId: 'P' }] : [])] };
  if (tool === 'create_thread') {
    if (creationFails) throw new Error('timeout');
    await creator.scan(); // A fast response is discoverable before create_thread returns.
    return { threadId: 'created', hostId: 'local' };
  }
  if (tool === 'read_thread') return { turns: [delegatedTurn('fast', createState.telegramPrompts.created?.[0] || 'Create test\nInitial prompt', 'FIRST_REPLY_OK')], page: {} };
  return {};
}, async (method, args) => {
  createMessages.push({ method, args });
  return method === 'createForumTopic' ? { message_thread_id: 404 } : { message_id: 2000 + createMessages.length };
}, () => {});
const input = (text, extras = {}) => ({ update_id: 200, message: { ...msg, text, ...extras } });
const click = data => ({ callback_query: { id: 'callback', from: msg.from, data, message: { chat: msg.chat } } });
await creator.handle(input('/projects'));
assert.equal(createMessages.at(-1).args.reply_markup.inline_keyboard[0][0].callback_data, 'project:P');
for (const command of ['/projects@our_bot', '/projects@OUR_BOT', '/projects@our_bot ']) {
  await creator.handle(input(command));
  assert.equal(createMessages.at(-1).args.reply_markup.inline_keyboard[0][0].callback_data, 'project:P');
}
const beforeWrongBot = createMessages.length;
await creator.handle(input('/projects@another_bot'));
assert.equal(createMessages.length, beforeWrongBot, 'commands addressed to another bot must be ignored');
await creator.handle(click('project:P'));
const projectButtons = createMessages.at(-1).args.reply_markup.inline_keyboard;
assert.equal(projectButtons[0][0].callback_data, 'newchat:P');
assert.deepEqual(projectButtons.slice(1).map(row => row[0].callback_data), ['r6','r5','r4','r3','r2']);
await creator.handle(click('newchat:P'));
assert(!createCalls.some(c => c.tool === 'create_thread'), 'selecting a project must not start a chat');
await creator.handle(input('another topic', { message_thread_id: 999 }));
assert(!createCalls.some(c => c.tool === 'create_thread'), 'new-chat intent is scoped to the originating topic');
await creator.handle(input('Create test\nInitial prompt'));
const creation = createCalls.find(c => c.tool === 'create_thread');
assert.deepEqual(creation.args, { prompt: 'Create test\nInitial prompt', title: 'Create test',
  target: { type: 'project', projectId: 'P', environment: { type: 'local' } } });
assert.equal(createState.threads.created.projectId, 'P');
assert.equal(createState.topics.created, 404);
assert(createMessages.some(m => m.args.text?.startsWith('Đã tạo chat mới trong project My project') && m.args.message_thread_id === 404));
await creator.scan();
assert(createMessages.some(m => m.args.text?.includes('FIRST_REPLY_OK') && m.args.message_thread_id === 404));
await creator.handle(click('newchat:P'));
await creator.handle(input('/cancel@our_bot'));
await creator.handle(input('do not create'));
assert.equal(createCalls.filter(c => c.tool === 'create_thread').length, 1);
await creator.handle(click('newchat:P'));
creationFails = true;
await creator.handle(input('uncertain creation'));
assert.equal(createCalls.filter(c => c.tool === 'create_thread').length, 2, 'creation must not retry on timeout');
assert.equal(createState.pending, undefined);
assert.deepEqual(createState.newChats, {});
await creator.handle(click('newchat:P'));
projectAvailable = false;
await creator.handle(input('removed project'));
assert.equal(createCalls.filter(c => c.tool === 'create_thread').length, 2, 'a removed project must not receive a new chat');

// Actual image bytes are saved under generated names; no user filename is used.
const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-image-test-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
const photo = { file_id: 'large', file_size: png.length };
const document = { ...photo, mime_type: 'image/png', file_name: '../../outside.png' };
assert.equal(telegramImage({ photo: [{ file_id: 'small' }, photo] }), photo);
assert.equal(telegramImage({ document }), document);
try {
  const imagePath = await saveTelegramImage(photo, async (method, args) => {
    assert.equal(method, 'getFile'); assert.equal(args.file_id, 'large');
    return { file_path: 'photos/file_1.png' };
  }, 'test-token', async url => {
    assert.equal(url, 'https://api.telegram.org/file/bottest-token/photos/file_1.png');
    return new Response(png);
  }, imageDir);
  assert.equal(path.dirname(imagePath), imageDir);
  assert.deepEqual(fs.readFileSync(imagePath), png);
  await assert.rejects(saveTelegramImage({ ...photo, file_size: 21 * 1024 * 1024 }, async () => {
    assert.fail('oversized image must be rejected before download');
  }), /20 MB/);
  await assert.rejects(saveTelegramImage(photo, async () => ({ file_path: 'documents/invalid.png' }), '',
    async () => new Response('not an image'), imageDir), /định dạng ảnh/);

  const imageCalls = [], imageReplies = [];
  let downloads = 0, downloadFails = false;
  const imageBridge = new Bridge({ ownerId: owner, chatId: -1001234, botUsername: 'our_bot' },
    { topicMode: true, topics: { A: 101 }, routes: {}, threads: { A: { title: 'A' } }, seen: {} },
    async (tool, args) => { imageCalls.push({ tool, args }); return {}; },
    async (method, args) => { imageReplies.push(args); return { message_id: imageReplies.length }; }, () => {},
    async file => { downloads++; if (downloadFails) throw new Error('download failed'); assert.equal(file.file_id, 'large'); return imagePath; });
  const imageMessage = { ...msg, text: undefined, chat: { id: -1001234, type: 'supergroup' },
    message_thread_id: 101, photo: [photo], caption: 'Có gì trong ảnh?' };
  await imageBridge.handle({ message: { ...imageMessage, from: { id: 99 } } });
  await imageBridge.handle({ message: { ...imageMessage, message_thread_id: 999 } });
  assert.equal(downloads, 0, 'untrusted sender and unknown topic must not download images');
  await imageBridge.handle({ message: imageMessage });
  assert.equal(imageCalls[0].args.threadId, 'A');
  assert(imageCalls[0].args.prompt.startsWith('Có gì trong ảnh?\n'));
  assert(imageCalls[0].args.prompt.includes(JSON.stringify(imagePath)) && imageCalls[0].args.prompt.includes('view_image'));
  assert.equal(imageReplies.at(-1).message_thread_id, 101);
  await imageBridge.handle({ message: { ...imageMessage, photo: undefined, document, caption: undefined } });
  assert(imageCalls.at(-1).args.prompt.startsWith('Xem và phân tích ảnh này.'));
  const priorImageCalls = imageCalls.length;
  await imageBridge.handle({ message: { ...imageMessage, photo: undefined, document: { mime_type: 'application/pdf' } } });
  assert.equal(imageCalls.length, priorImageCalls, 'unsupported attachment must not silently become a caption-only prompt');
  downloadFails = true;
  await imageBridge.handle({ message: imageMessage });
  assert.equal(imageCalls.length, priorImageCalls, 'failed download must not dispatch a text-only prompt');
  assert(imageReplies.at(-1).text.includes('Chưa gửi ảnh'));
  assert.equal(imageBridge.state.pending, undefined);
  await imageBridge.handle({ message: { ...imageMessage, photo: undefined, caption: undefined, text: '/help@OUR_BOT' } });
  assert(imageReplies.at(-1).text.startsWith('/projects'));

  projectAvailable = true;
  creationFails = false;
  creator.receiveImage = async () => { throw new Error('download failed'); };
  await creator.handle(click('newchat:P'));
  await creator.handle(input(undefined, { photo: [photo], caption: 'Chat ảnh' }));
  assert.equal(createState.newChats[owner + ':0'], 'P', 'failed image download must preserve New chat intent');
  assert.equal(createCalls.filter(c => c.tool === 'create_thread').length, 2);
  creator.receiveImage = async () => imagePath;
  await creator.handle(input(undefined, { photo: [photo], caption: 'Chat ảnh' }));
  const imageCreation = createCalls.filter(c => c.tool === 'create_thread').at(-1);
  assert.equal(imageCreation.args.title, 'Chat ảnh');
  assert(imageCreation.args.prompt.includes(JSON.stringify(imagePath)));
  assert.equal(imageCreation.args.target.projectId, 'P');
}
finally { fs.rmSync(imageDir, { recursive: true }); }
console.log('telegram_codex: checks passed (commands, images, authorization, routing, projects, no retry, pipe, streaming, deduplication).');
