import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, '.telegram-codex');
const MAX_FRAME = 8 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

// Same local protocol as the installed codex-app-tools plugin. No public listener.
export function pipeRequest(pipe, method, params, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('Codex App timeout; kết quả chưa xác định.')), timeout);
    function finish(error, value) {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    }
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Codex App đóng kết nối.')));
    socket.once('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      const length = data.readUInt32LE(0);
      if (length > MAX_FRAME) return finish(new Error('Codex App response quá lớn.'));
      if (data.length < length + 4) return;
      try {
        const response = JSON.parse(data.subarray(4, length + 4).toString('utf8'));
        if (response.error) throw new Error(response.error.message);
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}

export function findPipe() {
  // Discover again after an app restart; a shell's inherited pipe can be stale.
  const names = fs.readdirSync('\\\\.\\pipe\\').filter(name => name.startsWith('codex-app-tools-'));
  const inherited = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if (inherited && names.includes(inherited.split('\\').at(-1))) return inherited;
  if (names.length !== 1) throw new Error('Cần đúng một Codex App đang mở trên Windows.');
  return '\\\\.\\pipe\\' + names[0];
}

export async function appCall(callerThreadId, tool, args) {
  const response = await pipeRequest(findPipe(), 'tools/call', {
    arguments: args, callerSource: 'codex', hostId: 'local', namespace: 'codex_app',
    threadId: callerThreadId, tool,
    callId: 'telegram-' + crypto.randomUUID(), turnId: 'telegram-' + crypto.randomUUID(),
  });
  const text = response.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n');
  if (!response.success) throw new Error(text || 'Codex App từ chối thao tác.');
  try { return JSON.parse(text); } catch { return { message: text }; }
}

// Desktop's existing local coordination pipe. No second Codex runtime or listener.
export function desktopRequest(method, params, version, targetClientId, endpoint = '\\\\.\\pipe\\codex-ipc') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let data = Buffer.alloc(0), clientId = 'initializing-client', requestId;
    const timer = setTimeout(() => finish(new Error('Codex Desktop IPC timeout; kết quả chưa xác định.')), 15000);
    function finish(error, result) {
      clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    }
    function send(name, args, revision, target) {
      requestId = crypto.randomUUID();
      const body = Buffer.from(JSON.stringify({ type: 'request', requestId, sourceClientId: clientId,
        method: name, params: args, version: revision, targetClientId: target, timeoutMs: 10000 }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    }
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Codex Desktop IPC đóng kết nối.')));
    socket.once('connect', () => send('initialize', { clientType: 'telegram-codex' }, 0));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      try {
        while (data.length >= 4) {
          const size = data.readUInt32LE(0);
          if (size > MAX_FRAME) throw new Error('Codex Desktop IPC frame quá lớn.');
          if (data.length < size + 4) break;
          const message = JSON.parse(data.subarray(4, size + 4).toString('utf8'));
          data = data.subarray(size + 4);
          if (message.type === 'client-discovery-request') {
            const body = Buffer.from(JSON.stringify({ type: 'client-discovery-response', requestId: message.requestId,
              response: { canHandle: false } }));
            const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
            socket.write(Buffer.concat([header, body]));
          }
          if (message.type !== 'response' || message.requestId !== requestId) continue;
          if (message.resultType !== 'success') throw new Error(message.error || 'Codex Desktop từ chối thao tác.');
          if (clientId === 'initializing-client') {
            clientId = message.result.clientId;
            send(method, params, version, targetClientId);
          } else return finish(null, message);
        }
      } catch (error) { finish(error); }
    });
  });
}

export async function interruptChat(threadId, turnId) {
  const owner = await desktopRequest('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1);
  const response = await desktopRequest('thread-follower-interrupt-turn', {
    conversationId: threadId, mode: 'user-stop', expectedTurnId: turnId,
  }, 4, owner.handledByClientId);
  if (!response.result?.ok) throw new Error('Codex chưa xác nhận dừng chat.');
  return response.result;
}

export function pendingQuestion(threadId, callId, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const root = path.join(codexHome, 'sessions');
  const file = fs.readdirSync(root, { recursive: true }).find(name => name.endsWith('-' + threadId + '.jsonl'));
  if (!file) throw new Error('Không tìm thấy dữ liệu câu hỏi.');
  let questions;
  const answered = new Set();
  for (const line of fs.readFileSync(path.join(root, file), 'utf8').split('\n')) {
    if (!line.includes(callId)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const item = row.payload?.item;
    if (item?.id === callId && item.type === 'AgentMessage' && item.delivery === 'async') questions = item.questions;
    if (row.type !== 'response_item' || row.payload?.role !== 'user') continue;
    const match = row.payload.content?.map(p => p.text || '').join('\n').trim()
      .match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
    if (!match) continue;
    try {
      for (const reply of [JSON.parse(match[1])].flat()) {
        const [tool, id, index] = JSON.parse(reply.questionItemId);
        if (tool === 'request_user_input_async' && id === callId) answered.add(index);
      }
    } catch { /* Ignore unrelated input. */ }
  }
  const remaining = (questions || []).flatMap((q, index) => typeof q.title === 'string' && !answered.has(index) ?
    [{ questionItemId: JSON.stringify(['request_user_input_async', callId, index]), question: q.title }] : []);
  return remaining.length ? remaining : null;
}

export async function prepareQuestionReply(threadId, questions, answer, call, request = desktopRequest) {
  let owner;
  try { owner = await request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1); }
  catch (error) {
    if (error.message !== 'no-client-found') throw error;
    // Loading the selected chat restores its owner after Codex's idle unsubscribe.
    await call('navigate_to_codex_page', { threadId });
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(250);
      try { owner = await request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1); break; }
      catch (retry) { if (retry.message !== 'no-client-found') throw retry; }
    }
    if (!owner) throw new Error('Chưa nạp được chat để đóng thẻ.');
  }
  const current = await call('read_thread', { threadId, hostId: 'local', turnLimit: 1 });
  const prompt = '<send_user_message_question_reply>\n' + JSON.stringify(questions.map(q => ({
    ...q, answer: 'Trả lời từ Telegram: ' + answer,
  }))) + '\n</send_user_message_question_reply>';
  const input = [{ type: 'text', text: prompt, text_elements: [] }];
  const restoreMessage = { cwd: current.thread.cwd,
    context: { prompt, addedFiles: [], fileAttachments: [], imageAttachments: [], ideContext: null } };
  const active = current.turns?.[0]?.status === 'inProgress';
  return { prompt, send: async () => {
    const response = await request(active ? 'thread-follower-steer-turn' : 'thread-follower-start-turn', active ? {
      conversationId: threadId, input, restoreMessage, attachments: [], clientUserMessageId: crypto.randomUUID(),
    } : { conversationId: threadId, turnStart: {
      request: { threadId, input, turnTrigger: 'send_user_message_async_question', responsesapiClientMetadata: { source: 'telegram_bridge' } },
      context: { inheritThreadSettings: true, attachments: [], restoreMessage },
    } }, active ? 1 : 2, owner.handledByClientId);
    if (!response.result?.result) throw new Error('Codex chưa xác nhận câu trả lời.');
    return { message: 'Đã gửi câu trả lời và đóng thẻ câu hỏi.' };
  } };
}

export function readCodexProjectState(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  try {
    return JSON.parse(fs.readFileSync(path.join(codexHome, '.codex-global-state.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch { return {}; }
}

export function localThreads(result, projectState = {}) {
  const assignments = projectState['thread-project-assignments'] || {};
  const hosts = projectState['thread-project-membership-host-ids'] || {};
  const projects = projectState['local-projects'] || {};
  const projectless = new Set(projectState['projectless-thread-ids'] || []);
  return [...new Map([...result.pinnedThreads, ...result.threads]
    .filter(t => t.kind === 'codex' && t.hostId === 'local').map(t => {
      // Desktop can omit a new/live chat's project while its saved assignment is valid.
      // Recover only an explicit local assignment; cwd alone does not establish membership.
      const assignment = assignments[t.id];
      if (t.projectId == null && !projectless.has(t.id) &&
          (hosts[t.id] == null || hosts[t.id] === 'local') &&
          assignment?.projectKind === 'local' && projects[assignment.projectId]) {
        t = { ...t, projectId: assignment.projectId };
      }
      return [t.id, t];
    })).values()];
}

export function localProjects(result) {
  return result.projects.filter(p => p.projectKind === 'local' && p.hostId === 'local');
}

export function telegramImage(message) {
  return message.photo?.at(-1) ||
    (/^image\/(png|jpeg|webp)$/.test(message.document?.mime_type) ? message.document : null);
}

export async function saveTelegramImage(file, telegram, token, fetchFile = fetch, inbox = path.join(LOCAL, 'inbox')) {
  const limit = 20 * 1024 * 1024; // Telegram getFile download limit.
  if (file.file_size > limit) throw new Error('Ảnh vượt giới hạn tải 20 MB của Telegram.');
  const info = await telegram('getFile', { file_id: file.file_id });
  if (!info.file_path) throw new Error('Telegram chưa cung cấp file ảnh.');
  const response = await fetchFile('https://api.telegram.org/file/bot' + token + '/' +
    info.file_path.split('/').map(encodeURIComponent).join('/'), {
    signal: AbortSignal.timeout(45000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Không tải được ảnh Telegram (HTTP ' + response.status + ').');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('Ảnh vượt giới hạn tải 20 MB của Telegram.');
  const extension = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png' :
    bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'jpg' :
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  if (!extension) throw new Error('Gửi ảnh PNG, JPEG hoặc WebP; file nhận được không đúng định dạng ảnh.');
  fs.mkdirSync(inbox, { recursive: true });
  const imagePath = path.join(inbox, crypto.randomUUID() + '.' + extension);
  fs.writeFileSync(imagePath, bytes, { flag: 'wx', mode: 0o600 });
  return imagePath;
}

function menuContext(message) {
  return message.chat.id + ':' + (message.message_thread_id || 0);
}

export function authorized(message, owner, groupId) {
  return !!owner && message.from?.id === owner && (
    (message.chat?.type === 'private' && message.chat.id === owner) ||
    (groupId < 0 && message.chat?.type === 'supergroup' && message.chat.id === groupId));
}

export function destination(message, state) {
  if (message.message_thread_id != null) {
    return Object.keys(state.topics || {}).find(id => state.topics[id] === message.message_thread_id) || null;
  }
  // Unknown replies must never fall through to another conversation.
  if (message.reply_to_message) {
    const mid = message.reply_to_message.message_id;
    return state.routes[message.chat?.id + ':' + mid] ||
      (message.chat?.type !== 'supergroup' ? state.routes[mid] : null) || null;
  }
  if (state.topicMode) return null;
  return state.selected || null;
}

export function chunks(text, size = 3500) {
  // Count code points so an emoji is never cut in half. Stay below Telegram's limit.
  const points = Array.from(text);
  const result = [];
  for (let i = 0; i < points.length; i += size) result.push(points.slice(i, i + size).join(''));
  return result.length ? result : ['(Trống)'];
}

export function quotaText(result) {
  const buckets = Object.values(result.rateLimitsByLimitId || {});
  if (!buckets.length && result.rateLimits) buckets.push(result.rateLimits);
  if (!buckets.length) return 'Chưa lấy được hạn mức Codex từ tài khoản này.';
  return 'Hạn mức Codex (dùng chung tài khoản):\n' + buckets.map(bucket => {
    const lines = [bucket.limitName || bucket.limitId || 'Codex'];
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window) continue;
      const minutes = window.windowDurationMins;
      const label = minutes === 10080 ? 'Tuần' : minutes == null ? 'Hạn mức' :
        minutes % 60 === 0 ? minutes / 60 + ' giờ' : minutes + ' phút';
      const remaining = window.usedPercent == null ? 'chưa có dữ liệu' :
        'còn ' + Math.max(0, Math.min(100, 100 - window.usedPercent)) + '%';
      const reset = window.resetsAt == null ? '' : ' · reset ' +
        new Date(window.resetsAt * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) + ' (giờ VN)';
      lines.push(label + ': ' + remaining + reset);
    }
    if (!bucket.primary && !bucket.secondary) lines.push('Chưa có dữ liệu hạn mức.');
    const credits = bucket.credits;
    if (credits?.unlimited) lines.push('Credit: không giới hạn');
    else if (credits?.balance != null) lines.push('Credit: ' + Number(credits.balance).toLocaleString('vi-VN', { maximumFractionDigits: 2 }));
    return lines.join('\n');
  }).join('\n\n');
}

export function events(turns) {
  const result = [];
  for (const turn of [...turns].reverse()) {
    const items = turn.items || [];
    for (const [index, item] of items.entries()) {
      if (item.type === 'agentMessage' && item.text) {
        // The last item of an active turn may still be streaming.
        if (turn.status === 'inProgress' && index === items.length - 1) continue;
        result.push({ key: item.id, text: item.text, phase: item.phase });
      }
    }
    if (turn.error) result.push({ key: turn.id + ':error', text: 'Lỗi Codex: ' + JSON.stringify(turn.error) });
  }
  return result;
}

function delegationText(text) {
  // Codex serializes delegation input as XML text; decode exactly one layer.
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => entities[name]);
}

export function localFileParts(text) {
  const pattern = /!?\[([^\]\n]*)\]\(<?(\/?[A-Za-z]:[\\/](?:[^()\n]|\([^()\n]*\))*?)>?\)|`([A-Za-z]:[\\/][^`\n]+)`|([A-Za-z]:[\\/][^\s`<>"|]*\.[A-Za-z0-9]{1,10})(?=[\s,;!?)]|$)/g;
  const parts = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    let file = match[2] || match[3] || match[4];
    if (!match[2] && !path.win32.extname(file)) continue;
    if (file.startsWith('/')) file = file.slice(1);
    file = file.replace(/:\d+(?::\d+)?$/, '');
    try { file = decodeURI(file); } catch { /* Keep literal filenames with %. */ }
    if (match.index > end) parts.push({ text: text.slice(end, match.index) });
    parts.push({ file, label: match[1] || path.win32.basename(file), original: match[0] });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}

export async function telegramFileBody(body) {
  const file = fs.realpathSync(body.document);
  const segments = file.replace(/\\/g, '/').split('/');
  if (segments.some((s, i) => /^\.env(?:\.|$)/i.test(s) ||
      ['.telegram-codex', '.git', '.aws', '.ssh'].includes(s.toLowerCase()) ||
      (s.toLowerCase() === '.codex' && segments[i + 1]?.toLowerCase() !== 'visualizations'))) {
    throw new Error('Không tự gửi file cấu hình/đăng nhập riêng tư.');
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Đường dẫn không phải file.');
  if (stat.size > 50 * 1024 * 1024) throw new Error('File vượt giới hạn gửi 50 MB.');
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (key === 'document') form.set(key, await fs.openAsBlob(file), path.basename(file));
    else if (value != null) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return form;
}

export function historyPair(turn) {
  if (turn.status === 'inProgress') return null;
  const prompts = [];
  const replies = [];
  for (const item of turn.items || []) {
    if (item.type === 'userMessage') {
      const text = (item.content || []).map(part => part.type === 'text' ? part.text : '[Ảnh]').join('\n');
      if (text.trim()) prompts.push(text);
    }
    if (item.type === 'functionCallOutput' && item.namespace === 'codex_app' &&
        ['create_thread', 'send_message_to_thread'].includes(item.name)) {
      const input = item.output?.text?.match(/^<codex_delegation>\s*<source_thread_id>[^<]+<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
      if (input) prompts.push(delegationText(input[1]));
    }
    if (item.type === 'agentMessage' && item.text && (!item.phase || item.phase === 'final_answer')) replies.push(item.text);
  }
  if (turn.error) replies.push('Lỗi Codex: ' + JSON.stringify(turn.error));
  return prompts.length && replies.length ? { turn, prompt: prompts.join('\n\n'), response: replies.join('\n\n') } : null;
}

export function conversationEvents(turns) {
  const result = [];
  for (const turn of [...turns].reverse()) {
    const items = turn.items || [];
    for (const [index, item] of items.entries()) {
      const key = item.id || turn.id + ':item:' + index;
      if (item.type === 'userMessage') {
        const text = (item.content || []).map(p => p.type === 'text' ? p.text : '[Ảnh]').join('\n');
        if (text.trim()) result.push({ key, text, role: 'user', turnId: turn.id });
      } else if (item.type === 'functionCallOutput' && item.namespace === 'codex_app' &&
          ['create_thread', 'send_message_to_thread'].includes(item.name)) {
        const match = item.output?.text?.match(/^<codex_delegation>\s*<source_thread_id>([^<]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
        if (match) result.push({ key, text: delegationText(match[2]), role: 'user', caller: match[1], turnId: turn.id });
      } else if (item.type === 'agentMessage' && item.text) {
        // App Tools projects request_user_input_async as a final agent message with its call ID.
        const question = item.phase === 'final_answer' && item.id?.startsWith('call_');
        if (!question && turn.status === 'inProgress' && index === items.length - 1) continue;
        result.push({ key, text: item.text, role: 'assistant', turnId: turn.id,
          ...(question ? { question: true, activeQuestion: turn.status === 'inProgress' } : {}) });
      }
    }
    if (turn.error) result.push({ key: turn.id + ':error', text: 'Lỗi Codex: ' + JSON.stringify(turn.error), role: 'assistant', turnId: turn.id });
  }
  return result;
}

export class Bridge {
  constructor(config, state, call, telegram, persist, receiveImage = file => saveTelegramImage(file, telegram, config.token), sendPersonal, interrupt = interruptChat, readProjectState = readCodexProjectState) {
    this.config = config;
    this.state = state;
    this.call = call;
    this.telegram = telegram;
    this.persist = persist;
    this.receiveImage = receiveImage;
    this.sendPersonal = sendPersonal;
    this.interrupt = interrupt;
    this.readProjectState = readProjectState;
    this.readQuestion = pendingQuestion;
    this.prepareQuestion = (id, questions, answer) => prepareQuestionReply(id, questions, answer, this.call);
    this.readErrors = new Map();
    this.creatingTopics = new Map();
    this.syncing = new Map();
    this.state.topics ||= {};
    this.state.projects ||= {};
    this.state.newChats ||= {};
    this.state.ignoredPrompts ||= {};
    this.state.historyPending ||= {};
    // Old auto-created topics are dormant until selected or used again.
    this.state.enabled ||= this.state.selected ? { [this.state.selected]: true } : {};
    this.state.delivered ||= {};
    this.state.telegramPrompts ||= {};
    this.state.sources ||= {};
    this.state.attention ||= {};
    this.state.awaitingQuestions ||= {};
    this.state.historyImported ||= {};
    this.creatingChat = false;
  }

  async topic(threadId) {
    if (!this.state.enabled[threadId]) throw new Error('Chat chưa được chọn trên Telegram.');
    if (!this.creatingTopics.has(threadId) && this.state.topics[threadId]) return this.state.topics[threadId];
    if (!this.creatingTopics.has(threadId)) {
      const creating = (async () => {
        const topic = await this.telegram('createForumTopic', {
          chat_id: this.config.chatId || this.config.ownerId,
          name: Array.from(this.state.threads[threadId].title).slice(0, 128).join(''),
        });
        this.state.topics[threadId] = topic.message_thread_id;
        this.persist();
        return topic.message_thread_id;
      })();
      this.creatingTopics.set(threadId, creating);
    }
    try { return await this.creatingTopics.get(threadId); }
    finally { this.creatingTopics.delete(threadId); }
  }

  sourcedEvents(threadId, turns) {
    const seen = new Set(this.state.seen[threadId]?.keys || []);
    const pending = this.state.telegramPrompts[threadId] ||= [];
    let origin = 'desktop', turnId;
    return conversationEvents(turns).map(event => {
      if (event.turnId !== turnId) { origin = 'desktop'; turnId = event.turnId; }
      if (event.role === 'user') {
        const receipt = event.text.startsWith('<send_user_message_question_reply>');
        if (!this.state.sources[event.key] && !seen.has(event.key) && (event.caller === this.config.callerThreadId || receipt)) {
          const index = pending.indexOf(event.text);
          if (index >= 0) { pending.splice(index, 1); this.state.sources[event.key] = 'telegram'; }
        }
        origin = this.state.sources[event.key] || 'desktop';
      }
      return { ...event, origin };
    });
  }

  async deliver(threadId, event, armQuestion = false) {
    const delivered = this.state.delivered[threadId] ||= [];
    if (delivered.includes(event.key)) return;
    if (event.role === 'user' && event.origin === 'telegram') {
      // The original Telegram prompt is already visible in the topic.
    } else if (event.role === 'user' && this.sendPersonal && this.state.topicMode) {
      const topicId = await this.topic(threadId);
      for (const part of chunks(event.text)) {
        const pendingKey = this.config.chatId + ':' + topicId;
        this.state.historyPending[pendingKey] = part;
        this.persist();
        const sent = await this.sendPersonal(part, topicId);
        this.state.ignoredPrompts[this.config.chatId + ':' + sent.id] = true;
        delete this.state.historyPending[pendingKey];
        this.persist();
      }
    } else await this.send((event.role === 'user' ? 'Bạn:\n' : '') + event.text, threadId, {}, event.role === 'assistant');
    delivered.push(event.key);
    if (armQuestion && event.question) this.state.awaitingQuestions[threadId] = event.key;
    this.persist();
  }

  async update(threadId) {
    if (!this.syncing.has(threadId)) this.syncing.set(threadId, this.pullUpdate(threadId));
    try { return await this.syncing.get(threadId); }
    finally { this.syncing.delete(threadId); }
  }

  async importRecentHistory(threadId) {
    if (this.state.historyImported[threadId]) return;
    const pairs = [];
    let cursor;
    do {
      const result = await this.call('read_thread', {
        threadId, hostId: 'local', turnLimit: 1, includeOutputs: true,
        maxOutputCharsPerItem: 20000, ...(cursor ? { cursor } : {}),
      });
      for (const turn of result.turns || []) {
        const pair = historyPair(turn);
        if (pair) pairs.push(pair);
      }
      cursor = result.page?.nextCursor;
    } while (cursor && pairs.length < 5);
    for (const { turn } of pairs.slice(0, 5).reverse()) {
      const finalIds = new Set(turn.items.filter(i => i.type === 'agentMessage' &&
        (!i.phase || i.phase === 'final_answer')).map(i => i.id));
      for (const event of conversationEvents([turn])) {
        if (event.role === 'user' || finalIds.has(event.key) || event.key === turn.id + ':error') {
          await this.deliver(threadId, { ...event, origin: 'desktop' });
        }
      }
    }
    this.state.historyImported[threadId] = true;
    this.persist();
  }

  async pullUpdate(threadId) {
    const knownTelegram = (this.state.delivered[threadId] || []).some(key => this.state.sources[key] === 'telegram');
    if (!knownTelegram && !this.state.telegramPrompts[threadId]?.length) {
      return this.send('Chưa có prompt Telegram làm mốc. Gửi prompt trong topic này trước khi dùng /update.', threadId);
    }
    const turns = [];
    let cursor, all;
    do {
      const result = await this.call('read_thread', {
        threadId, hostId: 'local', turnLimit: 1, includeOutputs: true,
        maxOutputCharsPerItem: 20000, ...(cursor ? { cursor } : {}),
      });
      turns.push(...(result.turns || []));
      cursor = result.page?.nextCursor;
      all = this.sourcedEvents(threadId, turns);
    } while (cursor && !all.some(event => event.role === 'user' && event.origin === 'telegram'));
    const boundary = all.findLastIndex(event => event.role === 'user' && event.origin === 'telegram');
    if (boundary < 0) return this.send('Chưa xác định được prompt Telegram làm mốc; chưa nhập tin desktop.', threadId);
    await this.deliver(threadId, all[boundary]);
    let count = 0;
    for (const event of all.slice(boundary + 1)) {
      if (event.origin === 'telegram' || this.state.delivered[threadId]?.includes(event.key)) continue;
      await this.deliver(threadId, event);
      count++;
    }
    this.persist();
    if (!count) await this.send('Chưa có tin mới từ prompt trên desktop.', threadId);
  }

  async send(text, threadId, extra = {}, attachFiles = false) {
    const topicId = threadId && this.state.topicMode ? await this.topic(threadId) : null;
    if (threadId && !this.state.topicMode) text = '[' + this.state.threads[threadId].title + ']\n' + text;
    const destination = { chat_id: this.config.chatId || this.config.ownerId, ...extra,
      ...(topicId ? { message_thread_id: topicId } : {}) };
    const parts = attachFiles ? localFileParts(text) : [{ text }];
    for (const part of parts) {
      if (part.file) {
        try {
          const sent = await this.telegram('sendDocument', { ...destination, document: part.file, caption: part.label.slice(0, 1024) });
          if (threadId) this.state.routes[destination.chat_id + ':' + sent.message_id] = threadId;
          this.persist();
          continue;
        } catch (error) {
          part.text = part.original + '\nChưa gửi được file: ' + error.message;
        }
      }
      for (const chunk of chunks(part.text || '')) {
        if (!chunk.trim()) continue;
        const sent = await this.telegram('sendMessage', { ...destination, text: chunk });
        if (threadId) this.state.routes[(extra.chat_id || this.config.chatId || this.config.ownerId) + ':' + sent.message_id] = threadId;
        this.persist();
      }
    }
  }

  async chats() {
    const threads = localThreads(await this.call('list_threads', { limit: 50 }), this.readProjectState());
    for (const thread of threads) this.state.threads[thread.id] = thread;
    this.persist();
    return threads;
  }

  async projectMenu(projectId, message) {
    const project = this.state.projects[projectId];
    if (!project) return;
    delete this.state.newChats[menuContext(message)];
    await this.chats();
    const recent = Object.values(this.state.threads).filter(t => t.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
    await this.send('Project: ' + project.label + '\nTạo chat mới hoặc mở chat gần đây:', null, {
      chat_id: message.chat.id,
      ...(message.message_thread_id == null ? {} : { message_thread_id: message.message_thread_id }),
      reply_markup: { inline_keyboard: [
        [{ text: '＋ New chat', callback_data: 'newchat:' + projectId }],
        ...recent.map(t => [{ text: t.title, callback_data: t.id }]),
      ] },
    });
    this.persist();
  }

  async createChat(project, prompt, updateId, reply) {
    this.state.pending = { kind: 'create', projectId: project.projectId, updateId };
    this.creatingChat = true;
    this.persist();
    let id;
    try {
      const title = Array.from(prompt.split('\n')[0]).slice(0, 80).join('');
      const result = await this.call('create_thread', {
        prompt, title,
        target: { type: 'project', projectId: project.projectId, environment: { type: 'local' } },
      });
      id = result.threadId;
      if (!id) throw new Error('Codex chưa trả ID chat sẵn sàng; kiểm tra App trước khi tạo lại.');
      this.state.threads[id] = {
        id, title, kind: 'codex', hostId: result.hostId || 'local', projectId: project.projectId,
        updatedAt: Date.now() / 1000, status: 'active',
      };
      // Register before the first scan, including replies that finish immediately.
      this.state.seen[id] = { keys: [], wasActive: true };
      this.state.selected = id;
      this.state.enabled[id] = true;
      (this.state.telegramPrompts[id] ||= []).push(prompt);
      this.state.pending.threadId = id;
      this.persist();
      await this.send('Đã tạo chat mới trong project ' + project.label +
        '. Tiếp tục nhắn tại topic này.', id);
    } catch (error) {
      await reply((id ? 'Chat đã được tạo, nhưng chưa hoàn tất thông báo Telegram: ' :
        'Tạo chat chưa được xác nhận: ') + error.message + '\nBot không tự tạo lại để tránh trùng chat.');
    } finally {
      this.creatingChat = false;
      delete this.state.pending;
      this.persist();
    }
  }

  async handle(update) {
    const message = update.message || update.callback_query?.message;
    const sender = update.callback_query?.from || message?.from;
    if (!message || !authorized({ ...message, from: sender }, this.config.ownerId, this.config.chatId)) return;
    const controlReply = text => this.send(text, null, { chat_id: message.chat.id,
      ...(message.message_thread_id == null ? {} : { message_thread_id: message.message_thread_id }) });
    if (update.message && message.message_thread_id != null) {
      const threadId = destination(message, this.state);
      if (this.creatingTopics.has(threadId)) await this.creatingTopics.get(threadId);
      if (this.syncing.has(threadId)) await this.syncing.get(threadId);
      if (this.state.ignoredPrompts[message.chat.id + ':' + message.message_id]) return;
      const pending = this.state.historyPending[message.chat.id + ':' + message.message_thread_id];
      if (pending != null && pending === message.text) {
        return controlReply('Tin này khớp prompt lịch sử có kết quả gửi chưa xác định. Bot không chạy lại; kiểm tra lịch sử topic trước.');
      }
    }
    if (update.callback_query) {
      const id = update.callback_query.data || '';
      if (id.startsWith('project:') || id.startsWith('newchat:')) {
        const [action, projectId] = id.split(':');
        // Refresh the trusted project inventory; never accept an arbitrary callback ID.
        const projects = localProjects(await this.call('list_projects', {}));
        this.state.projects = Object.fromEntries(projects.map(p => [p.projectId, p]));
        this.persist();
        await this.telegram('answerCallbackQuery', { callback_query_id: update.callback_query.id });
        const project = this.state.projects[projectId];
        if (!project) return controlReply('Project không còn khả dụng. Gửi /projects để chọn lại.');
        if (action === 'project') return this.projectMenu(projectId, message);
        this.state.newChats[menuContext(message)] = projectId;
        this.persist();
        return controlReply('Project: ' + project.label + '\nGửi prompt đầu tiên để tạo chat mới. /cancel để hủy.');
      }
      if (!this.state.threads[id]) return;
      delete this.state.newChats[menuContext(message)];
      this.state.selected = id;
      this.state.enabled[id] = true;
      this.persist();
      await this.telegram('answerCallbackQuery', { callback_query_id: update.callback_query.id });
      await this.send(this.state.topicMode ?
        'Topic này nối với chat Codex cùng tên. Nhắn ngay trong topic để gửi prompt hoặc steer.' :
        'Đã chọn. Nhắn bình thường để gửi vào chat này; Reply để chọn theo tin.', id);
      await this.importRecentHistory(id);
      return;
    }
    // Topic-created/renamed service messages aren't prompts.
    if (message.forum_topic_created || message.forum_topic_edited || message.forum_topic_closed || message.forum_topic_reopened) return;
    const image = telegramImage(message);
    let text = (message.text || message.caption || '').trim();
    if (!message.text?.trim() && !image) return controlReply('Gửi prompt văn bản hoặc ảnh PNG, JPEG, WebP (có thể kèm caption).');
    // Group menus address commands to a bot: /projects@bot_username.
    const addressed = message.text?.trim().match(/^\/[a-z_]+@([a-z0-9_]+)(?=\s|$)/i);
    if (addressed && addressed[1].toLowerCase() !== this.config.botUsername?.toLowerCase()) return;
    const command = !image && message.text ? text.split(/\s/, 1)[0].split('@', 1)[0].toLowerCase() : '';
    const prompt = async () => {
      if (!image) return text;
      const imagePath = await this.receiveImage(image);
      return (text || 'Xem và phân tích ảnh này.') + '\n\nẢnh người dùng gửi từ Telegram: ' +
        JSON.stringify(imagePath) + '\nHãy mở ảnh này bằng công cụ view_image trước khi trả lời.';
    };
    if (command === '/cancel') {
      if (this.state.newChats[menuContext(message)]) {
        delete this.state.newChats[menuContext(message)];
        this.persist();
        return controlReply('Đã hủy tạo chat mới.');
      }
      const id = destination(message, this.state);
      if (!this.state.threads[id]) return controlReply('Mở đúng topic của chat cần dừng, rồi gửi /cancel.');
      delete this.state.awaitingQuestions[id];
      this.state.enabled[id] = true;
      this.persist();
      try {
        const result = await this.call('read_thread', { threadId: id, hostId: 'local', turnLimit: 1 });
        const active = result.turns?.find(turn => turn.status === 'inProgress');
        if (!active) return controlReply('Chat hiện không có lượt đang chạy.');
        const stopped = await this.interrupt(id, active.id);
        return controlReply(stopped.interruptedTurnId ? 'Đã dừng lượt đang chạy.' +
          (stopped.goalPauseError ? '\nChưa tạm dừng được goal: ' + stopped.goalPauseError : '') : 'Lượt đó đã kết thúc.');
      } catch (error) { return controlReply('Chưa xác nhận dừng chat: ' + error.message + ' Kiểm tra Codex trước khi thử lại.'); }
    }
    if (command === '/quota') {
      try { return await controlReply(quotaText(await this.call('get_usage_limits', {}))); }
      catch (error) { return controlReply('Chưa đọc được hạn mức Codex: ' + error.message); }
    }
    if (command === '/projects') {
      delete this.state.newChats[menuContext(message)];
      const projects = localProjects(await this.call('list_projects', {}));
      this.state.projects = Object.fromEntries(projects.map(p => [p.projectId, p]));
      this.persist();
      if (!projects.length) return controlReply('Chưa có project local trên máy này.');
      for (let i = 0; i < projects.length; i += 10) {
        await this.send('Chọn project:', null, {
          chat_id: message.chat.id,
          ...(message.message_thread_id == null ? {} : { message_thread_id: message.message_thread_id }),
          reply_markup: { inline_keyboard: projects.slice(i, i + 10)
            .map(p => [{ text: p.label, callback_data: 'project:' + p.projectId }]) },
        });
      }
      return;
    }
    if (command === '/start' || command === '/help') {
      return controlReply('/projects — chọn project, mở chat gần đây hoặc New chat\n/chats — chọn chat có sẵn\nNhắn trong topic để gửi prompt hoặc steer; phản hồi Telegram tự cập nhật.\n/update — lấy tin desktop mới sau prompt Telegram gần nhất\n/cancel — dừng lượt đang chạy, hoặc hủy bước New chat\n/status — trạng thái chat\n/quota — hạn mức Codex và thời điểm reset\nChờ cấp quyền: bot báo ngay; duyệt trong Codex App.');
    }
    if (command === '/chats') {
      const threads = await this.chats();
      // Telegram keyboards are limited; split the recent list into small pages.
      for (let i = 0; i < threads.length; i += 10) {
        await this.send(this.state.topicMode ? 'Chọn chat để mở topic riêng:' : 'Chọn chat:', null, {
          chat_id: message.chat.id,
          ...(message.message_thread_id == null ? {} : { message_thread_id: message.message_thread_id }),
          reply_markup: { inline_keyboard:
          threads.slice(i, i + 10).map(t => [{ text: t.title, callback_data: t.id }]),
        } });
      }
      return;
    }
    const newProjectId = this.state.newChats[menuContext(message)];
    if (newProjectId && !['/status', '/update'].includes(command)) {
      try { text = await prompt(); }
      catch (error) { return controlReply('Chưa gửi ảnh vào Codex: ' + error.message + ' Gửi lại ảnh để thử lại.'); }
      // Consume intent before dispatch, so an uncertain creation is never replayed.
      delete this.state.newChats[menuContext(message)];
      this.persist();
      const projects = localProjects(await this.call('list_projects', {}));
      const project = projects.find(p => p.projectId === newProjectId);
      if (!project) return controlReply('Project không còn khả dụng. Gửi /projects để chọn lại.');
      return this.createChat(project, text, update.update_id, controlReply);
    }
    const id = destination(message, this.state);
    const thread = this.state.threads[id];
    if (!thread) return controlReply(this.state.topicMode ?
      'Mở topic của chat cần nhắn. Dùng /chats để tạo topic cho chat có sẵn.' :
      'Chưa xác định được chat. Dùng /chats hoặc Reply đúng tin của bot.');
    this.state.enabled[id] = true;
    this.persist();
    if (command === '/update') {
      try { return await this.update(id); }
      catch (error) { return controlReply('Chưa cập nhật đủ tin từ desktop: ' + error.message); }
    }
    if (command === '/status') {
      const result = await this.call('read_thread', { threadId: id, hostId: 'local', turnLimit: 1 });
      return this.send(JSON.stringify(result.thread.status), id);
    }
    try { text = await prompt(); }
    catch (error) { return controlReply('Chưa gửi ảnh vào Codex: ' + error.message + ' Gửi lại ảnh để thử lại.'); }
    // Only a newly forwarded question arms one reply; history never intercepts ordinary prompts.
    const callId = this.state.awaitingQuestions[id];
    delete this.state.awaitingQuestions[id];
    this.persist();
    let submission;
    if (callId) {
      try {
        const questions = this.readQuestion(id, callId);
        if (questions) submission = await this.prepareQuestion(id, questions, text);
      } catch (error) {
        await controlReply('Chưa đóng được thẻ: ' + error.message + ' Vẫn gửi nguyên tin nhắn vào chat.');
      }
    }
    text = submission?.prompt || text;
    // Persist intent before dispatch. Never replay an uncertain prompt on restart.
    this.state.pending = { updateId: update.update_id, threadId: id };
    (this.state.telegramPrompts[id] ||= []).push(text);
    this.persist();
    try {
      const result = submission ? await submission.send() :
        await this.call('send_message_to_thread', { threadId: id, hostId: 'local', prompt: text });
      await this.send(result.message || 'Codex App đã nhận prompt.', id);
    } catch (error) {
      await this.send('Gửi chưa được xác nhận: ' + error.message + '\nBot không tự gửi lại. Kiểm tra chat trên máy trước khi gửi lại.', id);
    } finally {
      delete this.state.pending;
      this.persist();
    }
  }

  async scan() {
    // Selection is explicit. Neither recent desktop chats nor old routes opt in.
    for (const id of Object.keys(this.state.enabled).filter(id => this.state.enabled[id])) {
      const thread = this.state.threads[id];
      if (!thread) continue;
      try {
        const prior = this.state.seen[id];
        const turns = [];
        let cursor, status;
        // Walk back to the last observed turn, so fast consecutive turns aren't lost.
        do {
          const result = await this.call('read_thread', {
            threadId: id, hostId: 'local', turnLimit: 1, includeOutputs: true,
            maxOutputCharsPerItem: 20000, ...(cursor ? { cursor } : {}),
          });
          status ||= result.thread?.status;
          turns.push(...(result.turns || []));
          cursor = result.page?.nextCursor;
        } while (prior && cursor && !turns.some(t => t.id === prior.turnId));
        const flags = status?.activeFlags || [];
        const waiting = flags.filter(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag));
        const attention = waiting.length ? turns[0]?.id + ':' + waiting.join(',') : '';
        if (attention && this.state.attention[id] !== attention) {
          await this.send(waiting.includes('waitingOnApproval') ?
            '⚠️ Codex đang chờ bạn cấp quyền. Mở chat này trong Codex App để xem và duyệt yêu cầu. /cancel để dừng lượt này.' :
            '⚠️ Codex đang chờ bạn trả lời câu hỏi trong App. /update để xem tin mới; /cancel để dừng.', id);
        }
        this.state.attention[id] = attention;
        const all = this.sourcedEvents(id, turns);
        for (const event of all) {
          // Questions need attention even for desktop prompts; do not backfill old completed questions.
          const newQuestion = event.question && (event.activeQuestion || (prior && !prior.keys.includes(event.key)));
          if (event.origin === 'telegram' || newQuestion) await this.deliver(id, event, !!newQuestion);
        }
        this.state.seen[id] = {
          turnId: turns[0]?.id,
          keys: all.map(event => event.key),
        };
        this.persist();
        this.readErrors.delete(id);
      } catch (error) {
        if (this.readErrors.get(id) !== error.message) {
          await this.send('Không đọc được chat: ' + error.message, id);
          this.readErrors.set(id, error.message);
        }
      }
    }
  }
}

async function telegram(token, method, body) {
  const upload = method === 'sendDocument' && typeof body.document === 'string' && /^[A-Za-z]:[\\/]/.test(body.document);
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', ...(upload ? { body: await telegramFileBody(body) } : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(upload ? 180000 : 45000),
  });
  const data = await response.json();
  if (!data.ok) {
    if (data.parameters?.retry_after) await sleep(data.parameters.retry_after * 1000);
    throw new Error('Telegram ' + data.error_code + ': ' + data.description);
  }
  return data.result;
}

async function main() {
  const configFile = path.join(LOCAL, 'config.json');
  const stateFile = path.join(LOCAL, 'state.json');
  if (process.argv.includes('--probe')) {
    const caller = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
    if (!caller) throw new Error('Chạy probe từ terminal của chat Codex.');
    const threads = localThreads(await appCall(caller, 'list_threads', { limit: 5 }));
    const read = await appCall(caller, 'read_thread', { threadId: caller, turnLimit: 1 });
    console.log(JSON.stringify({ threads: threads.map(t => ({ id: t.id, title: t.title })), currentThread: read.thread.id }));
    return;
  }
  fs.mkdirSync(LOCAL, { recursive: true });
  if (!fs.existsSync(configFile) && fs.existsSync(path.join(LOCAL, 'token.txt'))) {
    const caller = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
    if (!caller) throw new Error('Chạy setup từ terminal của chat Codex hoặc dùng start_telegram_codex.ps1 để nhập ID chat.');
    saveJson(configFile, {
      token: fs.readFileSync(path.join(LOCAL, 'token.txt'), 'utf8').trim(),
      callerThreadId: caller,
    });
  }
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  if (!config.token || !config.callerThreadId) throw new Error('Chạy start_telegram_codex.ps1 để cấu hình.');
  // The Windows account is the security boundary for local Codex access.
  const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[0-9-]+/)?.[0];
  if (!sid) throw new Error('Không xác định được tài khoản Windows.');
  execFileSync('icacls.exe', [LOCAL, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe' });
  const lock = path.join(LOCAL, 'bridge.pid');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); throw new Error('Bot đã chạy (PID ' + pid + ').'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  process.once('exit', () => { try { fs.unlinkSync(lock); } catch {} });
  const call = (tool, args) => appCall(config.callerThreadId, tool, args);
  await call('list_threads', { limit: 1 });
  const tg = (method, body) => telegram(config.token, method, body);
  const me = await tg('getMe', {});
  config.botUsername = me.username;
  await tg('setMyCommands', { commands: [
    { command: 'projects', description: 'Chọn project, mở hoặc tạo chat' },
    { command: 'chats', description: 'Chọn chat có sẵn' },
    { command: 'update', description: 'Lấy tin mới từ prompt trên desktop' },
    { command: 'cancel', description: 'Dừng lượt đang chạy hoặc hủy New chat' },
    { command: 'status', description: 'Trạng thái chat trong topic' },
    { command: 'quota', description: 'Hạn mức Codex và giờ reset' },
    { command: 'help', description: 'Hướng dẫn sử dụng' },
  ] });
  const webhook = await tg('getWebhookInfo', {});
  if (webhook.url) throw new Error('Bot đang có webhook. Dùng bot Telegram riêng để tránh tranh update.');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) :
    { offset: 0, routes: {}, threads: {}, seen: {} };
  state.topicMode = !!me.has_topics_enabled || config.chatId < 0;
  if (!config.ownerId) {
    const code = crypto.randomBytes(24).toString('hex');
    console.log('Mở link này trên Telegram của bạn để ghép tài khoản (không chia sẻ):');
    console.log('https://t.me/' + me.username + '?start=' + code);
    while (!config.ownerId) {
      const updates = await tg('getUpdates', { offset: state.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        state.offset = update.update_id + 1;
        const m = update.message;
        if (m?.chat.type === 'private' && m.chat.id === m.from.id && m.text === '/start ' + code) {
          config.ownerId = m.from.id;
          saveJson(configFile, config);
          break;
        }
      }
      saveJson(stateFile, state);
    }
  }
  if (!Number.isSafeInteger(config.ownerId) || config.ownerId <= 0) throw new Error('ownerId không hợp lệ.');
  const userFile = path.join(LOCAL, 'user-session.json');
  let personal;
  if (fs.existsSync(userFile) && JSON.parse(fs.readFileSync(userFile, 'utf8')).session) {
    const { openPersonal } = await import('./telegram_user.mjs');
    try { personal = await openPersonal(config.ownerId, config.chatId); }
    catch (error) {
      console.error('Phiên cá nhân:', error.message);
      personal = { send: async () => { throw error; } };
    }
  }
  const bridge = new Bridge(config, state, call, tg, () => saveJson(stateFile, state), undefined, personal?.send);
  if (state.pending) {
    await bridge.send('Bot đã dừng khi đang gửi prompt hoặc tạo chat. Kết quả chưa xác định; kiểm tra App trước khi thử lại.', state.pending.threadId);
    delete state.pending;
    bridge.persist();
  }
  await bridge.scan();
  await bridge.send('Đã kết nối Codex. /projects để chọn chat. Prompt Telegram nhận phản hồi tự động; /update lấy tin từ desktop. /cancel dừng lượt đang chạy.');
  console.log('Bot đang chạy. Ctrl+C để dừng.');
  // Independent loops: a slow Codex read must not block incoming steering.
  void (async () => {
    let lastError = '';
    for (;;) {
      try { await bridge.scan(); lastError = ''; }
      catch (error) {
        console.error('Đọc Codex:', error.message);
        if (error.message !== lastError) {
          try { await bridge.send('Lỗi cầu nối Codex: ' + error.message); } catch {}
          lastError = error.message;
        }
      }
      await sleep(3000);
    }
  })();
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset: state.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        state.offset = update.update_id + 1;
        bridge.persist();
        try { await bridge.handle(update); }
        catch (error) {
          console.error('Xử lý Telegram:', error.message);
          await bridge.send('Lỗi xử lý Telegram: ' + error.message);
        }
      }
    } catch (error) { console.error(error.message); await sleep(3000); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
