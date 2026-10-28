import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
const load = Module._load, read = fs.readFileSync;
const requests = [];
let failNext = true, fullUpdate = false, disconnected = false;
class SendMessage { constructor(args) { Object.assign(this, args); } }
class InputReplyToMessage { constructor(args) { Object.assign(this, args); } }
class UpdateShortSentMessage { constructor(args) { Object.assign(this, args); } }
const Api = { messages: { SendMessage }, InputReplyToMessage, UpdateShortSentMessage };
class Client {
  setLogLevel() {}
  async connect() {}
  async checkAuthorization() { return true; }
  async getMe() { return { id: 42, bot: false }; }
  async *iterDialogs() { yield { id: -1001234, inputEntity: 'trusted-peer' }; }
  async invoke(request) {
    requests.push(request);
    if (failNext) { failNext = false; throw new Error('acknowledgement lost'); }
    return fullUpdate ? { updates: [] } : new UpdateShortSentMessage({ id: 444 });
  }
  _getResponseMessage(request, result, peer) {
    assert.equal(peer, 'trusted-peer'); assert.equal(requests.at(-1), request);
    return { id: 555 };
  }
  async sendMessage(peer, options) {
    assert.equal(peer, 'trusted-peer'); assert.equal(options.replyTo, 101);
    return { id: 666 };
  }
  async disconnect() { disconnected = true; }
}
try {
  Module._load = function (name, ...args) {
    if (name === 'teleproto') return { TelegramClient: Client, Api };
    if (name === 'teleproto/sessions') return { StringSession: class {} };
    if (name === 'big-integer') return value => ({ toString: () => value });
    return load.call(this, name, ...args);
  };
  fs.readFileSync = function (file, ...args) {
    if (typeof file === 'string' && /[\\/]\.telegram-codex[\\/]user-session\.json$/.test(file)) {
      return JSON.stringify({ session: 'mock', apiId: 1, apiHash: 'mock' });
    }
    return read.call(this, file, ...args);
  };
  const { openPersonal } = await import('../scripts/telegram_user.mjs');
  const personal = await openPersonal(42, -1001234), receipt = { randomId: '123456789' };
  await assert.rejects(personal.send('copy', 101, receipt), /acknowledgement lost/);
  assert.equal((await personal.send('copy', 101, receipt)).id, 444);
  assert.equal(requests.length, 2);
  assert(requests.every(request => request.randomId.toString() === receipt.randomId));
  assert(requests.every(request => request.peer === 'trusted-peer' && request.replyTo.replyToMsgId === 101 && request.noWebpage));
  fullUpdate = true;
  assert.equal((await personal.send('copy', 101, receipt)).id, 555);
  assert.equal((await personal.send('legacy', 101)).id, 666);
  await assert.rejects(personal.send('bad topic', 0, receipt), /Topic không hợp lệ/);
  await personal.disconnect(); assert(disconnected);
} finally { Module._load = load; fs.readFileSync = read; }
console.log('telegram_personal_receipts: stable MTProto random_id, topic/identity, response IDs, uncertain acknowledgement and legacy sends passed (mocked transport).');
