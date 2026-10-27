import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Bridge } from '../scripts/telegram_codex.mjs';
import { approvalChoices, controlCodexApp } from '../scripts/telegram_codex_controls.mjs';

const msg = { from: { id: 1 }, chat: { id: -10, type: 'supergroup' }, message_thread_id: 101 };
const state = { topicMode: true, topics: { A: 101, B: 102 }, enabled: { A: true }, threads: { A: { title: 'A' } }, routes: {}, seen: {} };
const calls = [], sends = [], lifecycle = [];
let ackExpires = false;
const bridge = new Bridge({ ownerId: 1, chatId: -10 }, state, async (tool, args) => {
  calls.push({ tool, args }); return { threads: [], pinnedThreads: [] };
}, async (method, args) => {
  if (method === 'answerCallbackQuery' && ackExpires) throw new Error('Telegram 400: Bad Request: query is too old and response timeout expired or query ID is invalid');
  sends.push({ method, args }); return { message_id: sends.length };
}, () => {});
bridge.appControl = async action => { lifecycle.push(action); };
const input = text => ({ message: { ...msg, text } });
await bridge.handle({ message: { ...msg, from: { id: 99 }, text: '/restart' } });
assert.deepEqual(lifecycle, [], 'unauthorized senders cannot control the app');
await bridge.handle(input('/start')); await bridge.handle(input('/restart'));
assert.deepEqual(lifecycle, ['start', 'restart']);
assert(calls.every(c => c.tool === 'list_threads'), 'lifecycle commands never send model prompts');
await assert.rejects(async () => controlCodexApp('shutdown'), /Invalid app action/);

// Startup uses the same sequence as /start, without probing before the launch completes.
const startupEvents = [];
let readyAttempts = 0;
const startup = new Bridge({ ownerId: 1 }, {}, async (tool, args) => {
  startupEvents.push('probe');
  assert.equal(tool, 'list_threads'); assert.equal(args.limit, 1);
  if (++readyAttempts < 3) throw new Error('App is loading');
  return {};
}, async () => ({}), () => {});
startup.appControl = async action => {
  startupEvents.push(action);
  await new Promise(resolve => setImmediate(resolve));
  startupEvents.push('launched');
};
assert.equal(await startup.startApp('start', async () => { startupEvents.push('wait'); }), true);
assert.deepEqual(startupEvents, ['start', 'launched', 'probe', 'wait', 'probe', 'wait', 'probe']);
startup.appControl = async () => { throw new Error('Launch failed'); };
const beforeFailedLaunch = readyAttempts;
await assert.rejects(startup.startApp(), /Launch failed/);
assert.equal(readyAttempts, beforeFailedLaunch, 'failed launch must not probe Codex');
startup.appControl = async () => {};
startup.call = async () => { throw new Error('App unavailable'); };
assert.equal(await startup.startApp('start', async () => {}), false, 'timeout must not report readiness');

let currentModel = 'old';
let currentEffort = 'high';
bridge.models = () => [{ model: 'new', label: 'New model', defaultEffort: 'low', efforts: ['low', 'medium'] }];
let requests = [];
bridge.snapshot = async () => ({ latestModel: currentModel, latestReasoningEffort: currentEffort, requests });
const native = [];
bridge.desktop = async (method, params) => {
  native.push({ method, params });
  if (method === 'thread-owner-discovery') return { handledByClientId: 'owner' };
  if (method === 'thread-follower-update-thread-settings') { currentModel = params.threadSettings.model; currentEffort = params.threadSettings.effort; return { result: { applied: true } }; }
  requests = []; return { result: { ok: true } };
};
await bridge.handle(input('/model'));
const modelButton = sends.at(-1).args.reply_markup.inline_keyboard[0][0];
const callback = (data, extras = {}) => ({ callback_query: { id: 'button', data, from: msg.from, message: { ...msg, ...extras } } });
await bridge.handle(callback(modelButton.callback_data, { message_thread_id: 102 }));
assert.equal(currentModel, 'old', 'model button is bound to its chat');
await bridge.handle(callback(modelButton.callback_data));
assert.equal(currentModel, 'new');
assert.deepEqual(native.find(c => c.method === 'thread-follower-update-thread-settings').params.threadSettings, { model: 'new', effort: 'low' });
await bridge.handle(input('/effort'));
const effortButtons = sends.at(-1).args.reply_markup.inline_keyboard.flat();
assert.deepEqual(effortButtons.map(b => b.text), ['✓ low', 'medium']);
await bridge.handle(callback(effortButtons[1].callback_data));
assert.equal(currentEffort, 'medium'); assert.equal(currentModel, 'new');
await bridge.handle(input('/effort'));
const staleEffort = sends.at(-1).args.reply_markup.inline_keyboard[0][0];
currentModel = 'changed-elsewhere';
await bridge.handle(callback(staleEffort.callback_data));
assert.equal(currentModel, 'changed-elsewhere', 'stale effort menu must not change model back');
assert.equal(currentEffort, 'medium');
currentModel = 'new';

requests = [{ id: 7, method: 'mcpServer/elicitation/request', params: { mode: 'form', message: 'Allow Chrome access to example.com?',
  _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'browser-use', tool_name: 'access_browser_origin' },
  requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] },
} }];
assert.equal(approvalChoices(requests[0]).choices[0].args.response.content.approved, true);
assert.equal(approvalChoices({ ...requests[0], params: { ...requests[0].params, mode: 'openai/userVerification' } }), null);
assert.equal(approvalChoices({ ...requests[0], params: { ...requests[0].params, _meta: { codex_approval_kind: 'browser_email_otp' } } }), null);
assert.equal(approvalChoices({ ...requests[0], params: { ...requests[0].params, requestedSchema: { properties: { password: { type: 'string' } } } } }), null);
assert.deepEqual(approvalChoices({ method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['decline'] } }).choices.map(c => c.args.decision), ['decline']);
await bridge.approvalMenu('A');
const approvalButton = sends.at(-1).args.reply_markup.inline_keyboard[0][0];
assert(sends.some(s => s.args.text?.includes('Allow Chrome access to example.com?')));
const noticeCount = sends.length;
await bridge.approvalMenu('A'); assert.equal(sends.length, noticeCount, 'no duplicate pending permission menus');
ackExpires = true; // UI ack expiry must retain request/topic/fingerprint and one-shot validation.
await bridge.handle(callback(approvalButton.callback_data));
assert.equal(native.at(-1).method, 'thread-follower-submit-mcp-server-elicitation-response');
assert.equal(native.at(-1).params.requestId, 7);
assert.deepEqual(native.at(-1).params.response, { action: 'accept', content: { approved: true } });
const decisions = native.length;
await bridge.handle(callback(approvalButton.callback_data));
assert.equal(native.length, decisions, 'button cannot submit twice');

const pending = { id: 8, method: 'item/commandExecution/requestApproval', params: { command: 'echo harmless', reason: 'test' } };
requests = [pending]; await bridge.approvalMenu('A');
const stale = sends.at(-1).args.reply_markup.inline_keyboard[0][0];
const beforeStaleClick = native.length;
requests = [{ ...pending, params: { command: 'different command' } }];
await bridge.handle(callback(stale.callback_data));
assert.equal(native.length, beforeStaleClick, 'changed requests must not accept an old decision');
requests = [pending];
const key = 'timeout'; state.controlActions[key] = { kind: 'approval', threadId: 'A', requestId: pending.id,
  ownerClientId: 'owner',
  fingerprint: crypto.createHash('sha256').update(JSON.stringify(pending)).digest('hex') };
bridge.desktop = async method => {
  if (method === 'thread-owner-discovery') return { handledByClientId: 'owner' };
  throw new Error('timeout');
};
await bridge.handle(callback('control:' + key + ':0'));
assert.equal(state.controlActions[key], undefined, 'uncertain decisions cannot be retried');
assert(!calls.some(c => c.tool === 'send_message_to_thread'));
const markerMessages = [];
const marker = new Bridge({ ownerId: 1 }, { threads: { A: { title: 'A' } }, routes: {}, seen: {} }, () => {},
  async (method, args) => { markerMessages.push(args.text); return { message_id: markerMessages.length }; }, () => {});
await marker.deliver('A', { key: 'progress', role: 'assistant', text: 'Working' });
await marker.deliver('A', { key: 'question', role: 'assistant', question: true, text: 'Choose?' });
await marker.deliver('A', { key: 'final', role: 'assistant', finalAnswer: true, text: 'Done' });
await marker.deliver('A', { key: 'already-marked', role: 'assistant', finalAnswer: true, text: 'Done [end]' });
assert.deepEqual(markerMessages, ['[A]\nWorking', '[A]\nChoose?', '[A]\nDone\n[end]', '[A]\nDone [end]']);
console.log('telegram_controls: lifecycle authorization, models, request-bound approvals, stale/duplicate/uncertain decisions passed.');
