import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { controlCodexApp, modelCatalog, threadSnapshot, approvalChoices, ensureOwner, readIpcFrames, IPC_TIMEOUT_MS } from './telegram_codex_controls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = path.join(ROOT, '.telegram-codex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const localTurnCache = new Map();

function historyTail(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(size, 256));
    fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(file + '.tmp', file); break; }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt >= 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

// Same local protocol as the installed codex-app-tools plugin. No public listener.
export function pipeRequest(pipe, method, params, timeout = IPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
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
    readIpcFrames(socket, response => {
      if (response.error) throw new Error(response.error.message);
      finish(null, response.result);
    }, finish);
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

export async function appCall(callerThreadId, tool, args, timeout = IPC_TIMEOUT_MS) {
  const response = await pipeRequest(findPipe(), 'tools/call', {
    arguments: args, callerSource: 'codex', hostId: 'local', namespace: 'codex_app',
    threadId: callerThreadId, tool,
    callId: 'telegram-' + crypto.randomUUID(), turnId: 'telegram-' + crypto.randomUUID(),
  }, timeout);
  const text = response.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n');
  if (!response.success) throw new Error(text || 'Codex App từ chối thao tác.');
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export async function readLocalTurnPage(threadId, { cursor, all = false } = {}, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), selectedFile) {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw new Error('ID chat local không hợp lệ.');
  const root = path.join(codexHome, 'sessions');
  let files = selectedFile ? [selectedFile] : fs.readdirSync(root, { recursive: true }).filter(name =>
    name.endsWith('-' + threadId + '.jsonl') || (all && path.basename(name).includes('-' + threadId + '_'))).sort();
  if (!selectedFile && !all && files.length !== 1 && fs.existsSync(path.join(codexHome, 'state_5.sqlite'))) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'), { readOnly: true });
    try {
      const owned = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId)?.rollout_path;
      if (owned && fs.existsSync(owned)) files = [owned];
    } finally { db.close(); }
  }
  if (all && files.length > 1) {
    const merged = new Map();
    for (const file of files) {
      const page = await readLocalTurnPage(threadId, { all: true }, codexHome, file);
      for (const turn of page.turns.reverse()) {
        const prior = merged.get(turn.id);
        const items = [...(prior?.items || []), ...turn.items].filter(i => i.type !== 'localReadBoundary');
        turn.items = [...new Map(items.map(i => [i.id, i])).values()];
        if (turn.status === 'inProgress') turn.items.push({ type: 'localReadBoundary' });
        merged.set(turn.id, turn);
      }
    }
    return { thread: { id: threadId }, turns: [...merged.values()].reverse(), page: { nextCursor: null } };
  }
  if (files.length !== 1) throw new Error('Không xác định được đúng một file lịch sử local của chat.');
  const anchor = cursor ? JSON.parse(cursor) : null;
  if (anchor && (anchor.requestedThreadId !== threadId || anchor.scope?.kind !== 'turns' ||
      !Number.isSafeInteger(anchor.rolloutOrdinal) || anchor.rolloutOrdinal < 0 || typeof anchor.includeAnchor !== 'boolean')) {
    throw new Error('Mốc lịch sử không hỗ trợ đọc local; chưa đồng bộ.');
  }
  const filename = path.isAbsolute(files[0]) ? files[0] : path.join(root, files[0]), stat = fs.statSync(filename);
  if (!stat.size) throw new Error('Chưa xác minh được file/mốc lịch sử local.');
  const cached = !all && !anchor && localTurnCache.get(filename);
  // Rollouts append. Verify file identity and the old tail before resuming;
  // truncation, replacement, and rewrites must rebuild the projection.
  const resume = cached && stat.ino === cached.ino && stat.size >= cached.size &&
    (stat.size > cached.size || stat.mtimeMs === cached.mtimeMs) &&
    historyTail(filename, cached.size).equals(cached.tail) ? cached : null;
  let ordinal = resume?.ordinal ?? -1, bound = !!resume, anchorFound = !anchor,
    turn = resume?.turn && structuredClone(resume.turn), hasPrevious = resume?.hasPrevious || false;
  const previousTurns = [];
  const offset = resume?.size || 0;
  const input = offset === stat.size ? null : fs.createReadStream(filename, {
    start: offset, end: stat.size - 1, highWaterMark: 1024 * 1024,
  });
  const lines = input ? createInterface({ input, crlfDelay: Infinity }) : [];
  try {
    for await (const line of lines) {
      ordinal++;
      const prefix = line.slice(0, 1024);
      // Skip image/tool payloads before parsing: the fallback only projects visible messages.
      const isAnchor = anchor && ordinal === anchor.rolloutOrdinal;
      if (!isAnchor && !/"type"\s*:\s*"(?:session_meta|event_msg)"/.test(prefix)) continue;
      if (!isAnchor && /"type"\s*:\s*"item_(?:completed|started)"/.test(prefix) &&
          !/"type"\s*:\s*"(?:UserMessage|AgentMessage|FunctionCallOutput)"/.test(prefix)) continue;
      if (!isAnchor && /"type"\s*:\s*"FunctionCallOutput"/.test(prefix) &&
          !/"namespace"\s*:\s*"codex_app"/.test(prefix)) continue;
      let row;
      try { row = JSON.parse(line); }
      catch { if (!line.endsWith('}')) continue; throw new Error('Bản lưu lịch sử local có dữ liệu JSON không hợp lệ.'); }
      const p = row.payload || {};
      if (row.type === 'session_meta') {
        if (p.id !== threadId) throw new Error('File lịch sử không khớp ID chat.');
        bound = true;
      }
      if (isAnchor) {
        if (row.type !== 'event_msg' || p.type !== 'task_started') throw new Error('Mốc Codex không khớp file local; chưa đồng bộ.');
        anchorFound = true;
      }
      if (row.type !== 'event_msg') continue;
      if (p.type === 'task_started') {
        if (anchor && (ordinal > anchor.rolloutOrdinal || (isAnchor && !anchor.includeAnchor))) break;
        hasPrevious = !!turn;
        if (all && turn) previousTurns.push(turn);
        turn = { id: p.turn_id, status: 'inProgress', items: [], ordinal };
        continue;
      }
      if (!turn || p.turn_id !== turn.id) continue;
      if (p.type === 'task_complete') turn.status = 'completed';
      if (p.type === 'turn_aborted') turn.status = 'interrupted';
      if (p.type === 'error') turn.error = { message: p.message };
      if (p.type !== 'item_completed') continue;
      const item = p.item;
      if (item?.type === 'UserMessage') turn.items.push({ type: 'userMessage', id: item.id,
        content: (item.content || []).map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image' }) });
      if (item?.type === 'AgentMessage') {
        const question = item.delivery === 'async' && Array.isArray(item.questions);
        const text = question ? item.questions.map(q => q.title + (q.options?.length ? '\n' + q.options.map(o => '- ' + o).join('\n') : '')).join('\n\n') :
          (item.content || []).filter(part => part.type === 'Text').map(part => part.text).join('\n');
        turn.items.push({ type: 'agentMessage', id: item.id, text, phase: question ? 'final_answer' : item.phase });
      }
      if (item?.type === 'FunctionCallOutput' && item.namespace === 'codex_app' &&
          ['create_thread', 'send_message_to_thread'].includes(item.name)) {
        turn.items.push({ type: 'functionCallOutput', id: item.id, namespace: item.namespace, name: item.name,
          output: typeof item.output === 'string' ? { text: item.output } : item.output });
      }
    }
  } finally { lines.close?.(); input?.destroy(); }
  if (!bound || !anchorFound) throw new Error('Chưa xác minh được file/mốc lịch sử local.');
  if (!all && !anchor) {
    const tail = historyTail(filename, stat.size);
    // A partial final line is reread on the next poll, never cached as consumed.
    if (tail.at(-1) === 10) localTurnCache.set(filename, { size: stat.size, ino: stat.ino,
      mtimeMs: stat.mtimeMs, tail, ordinal, hasPrevious, turn: turn && structuredClone(turn) });
  }
  const nextCursor = !all && turn && hasPrevious ? JSON.stringify({ requestedThreadId: threadId,
    rolloutOrdinal: turn.ordinal, includeAnchor: false, scope: { kind: 'turns' } }) : null;
  const projected = [...previousTurns, ...(turn ? [turn] : [])];
  for (const value of projected) {
    delete value.ordinal;
    // These items are completed: do not suppress the last message as a streaming item.
    if (value.status === 'inProgress') value.items.push({ type: 'localReadBoundary' });
  }
  return { thread: { id: threadId }, turns: projected.reverse(), page: { nextCursor } };
}

export async function readThread(call, args, codexHome) {
  try { return await call('read_thread', args); }
  catch (error) {
    if (!/^(?:Thread history exceeds the read size limit\.|Tool response exceeds the size limit\.)/.test(error.message)) throw error;
    const result = await readLocalTurnPage(args.threadId, args, codexHome);
    if (!args.cursor) {
      const thread = localThreads(await call('list_threads', { limit: 50 })).find(t => t.id === args.threadId);
      if (!thread) throw new Error('Chưa đọc được trạng thái chat; chưa đồng bộ lịch sử local.');
      result.thread = thread;
    }
    return result;
  }
}

// Desktop's existing local coordination pipe. No second Codex runtime or listener.
export function desktopRequest(method, params, version, targetClientId, endpoint = '\\\\.\\pipe\\codex-ipc') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let clientId = 'initializing-client', requestId;
    const timer = setTimeout(() => finish(new Error('Codex Desktop IPC timeout; kết quả chưa xác định.')), IPC_TIMEOUT_MS + 60000);
    function finish(error, result) {
      clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    }
    function send(name, args, revision, target) {
      requestId = crypto.randomUUID();
      const body = Buffer.from(JSON.stringify({ type: 'request', requestId, sourceClientId: clientId,
        method: name, params: args, version: revision, targetClientId: target, timeoutMs: IPC_TIMEOUT_MS }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    }
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Codex Desktop IPC đóng kết nối.')));
    socket.once('connect', () => send('initialize', { clientType: 'telegram-codex' }, 0));
    readIpcFrames(socket, message => {
      if (message.type === 'client-discovery-request') {
        const body = Buffer.from(JSON.stringify({ type: 'client-discovery-response', requestId: message.requestId,
          response: { canHandle: false } }));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      }
      if (message.type !== 'response' || message.requestId !== requestId) return;
      if (message.resultType !== 'success') throw new Error(message.error || 'Codex Desktop từ chối thao tác.');
      if (clientId === 'initializing-client') {
        clientId = message.result.clientId;
        send(method, params, version, targetClientId);
      } else return finish(null, message);
    }, finish);
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

async function downloadTelegramFile(file, telegram, token, fetchFile) {
  const limit = 20 * 1024 * 1024; // Telegram getFile download limit.
  if (file.file_size > limit) throw new Error('File vượt giới hạn tải 20 MB của Telegram.');
  const info = await telegram('getFile', { file_id: file.file_id });
  if (!info.file_path) throw new Error('Telegram chưa cung cấp đường dẫn tải file.');
  const response = await fetchFile('https://api.telegram.org/file/bot' + token + '/' +
    info.file_path.split('/').map(encodeURIComponent).join('/'), {
    signal: AbortSignal.timeout(10 * 60 * 1000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Không tải được file Telegram (HTTP ' + response.status + ').');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('File vượt giới hạn tải 20 MB của Telegram.');
  return bytes;
}

export async function saveTelegramDocument(file, telegram, token, fetchFile = fetch, inbox = path.join(LOCAL, 'inbox')) {
  const bytes = await downloadTelegramFile(file, telegram, token, fetchFile);
  const name = path.win32.basename(file.file_name || 'attachment.bin').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  const filePath = path.join(inbox, crypto.randomUUID() + '-' + (name.slice(-160) || 'attachment.bin'));
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 });
  return filePath;
}

export async function saveTelegramImage(file, telegram, token, fetchFile = fetch, inbox = path.join(LOCAL, 'inbox')) {
  const bytes = await downloadTelegramFile(file, telegram, token, fetchFile);
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

export async function authorized(message, owner, groupId, getMember) {
  const sender = message.from;
  if (!owner || !Number.isSafeInteger(sender?.id) || sender.id <= 0 || sender.is_bot || message.sender_chat) return false;
  if (message.chat?.type === 'private') return sender.id === owner && message.chat.id === owner;
  if (!(groupId < 0 && message.chat?.type === 'supergroup' && message.chat.id === groupId)) return false;
  if (sender.id === owner) return true;
  if (!getMember) return false;
  try {
    const member = await getMember({ chat_id: groupId, user_id: sender.id });
    return member.user?.id === sender.id && !member.user.is_bot && ['creator', 'administrator'].includes(member.status);
  } catch (error) {
    console.error('Kiểm tra quyền Telegram:', error.message);
    return false;
  }
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
  const pattern = /!?\[([^\]\n]*)\]\(<?(\/?[A-Za-z]:[\\/](?:[^()\n]|\([^()\n]*\))*?)>?\)|`([A-Za-z]:[\\/][^`\n]+)`|(?<![A-Za-z0-9_])([A-Za-z]:[\\/][^\s`<>"|]*\.[A-Za-z0-9]{1,10})(?=[\s,;!?)]|$)/g;
  const parts = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    let file = match[2] || match[3] || match[4];
    if (!match[2] && !path.win32.extname(file)) continue;
    if (file.startsWith('/')) file = file.slice(1);
    file = file.replace(/:\d+(?::\d+)?$/, '');
    try { file = decodeURI(file); } catch { /* Keep literal filenames with %. */ }
    try { if (fs.statSync(file).isDirectory()) continue; }
    catch { /* Missing files still get the existing upload error notice. */ }
    if (match.index > end) parts.push({ text: text.slice(end, match.index) });
    parts.push({ file, label: match[1] || path.win32.basename(file), original: match[0] });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}

export function checkedTelegramFile(filename) {
  const file = fs.realpathSync(filename);
  const segments = file.replace(/\\/g, '/').split('/');
  if (segments.some((s, i) => /^\.env(?:\.|$)/i.test(s) ||
      ['.telegram-codex', '.git', '.aws', '.ssh'].includes(s.toLowerCase()) ||
      (s.toLowerCase() === '.codex' && segments[i + 1]?.toLowerCase() !== 'visualizations'))) {
    throw new Error('Không tự gửi file cấu hình/đăng nhập riêng tư.');
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Đường dẫn không phải file.');
  return { file, stat };
}

export async function telegramFileBody(body) {
  const { file, stat } = checkedTelegramFile(body.document);
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
          ...(!question && item.phase === 'final_answer' ? { finalAnswer: true } : {}),
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
    this.rawCall = call;
    this.call = (tool, args) => tool === 'read_thread' ? readThread(call, args) : call(tool, args);
    this.telegram = telegram;
    this.persist = persist;
    this.receiveImage = receiveImage;
    this.receiveDocument = file => saveTelegramDocument(file, telegram, config.token);
    this.appControl = controlCodexApp;
    this.models = modelCatalog;
    this.snapshot = threadSnapshot;
    this.desktop = desktopRequest;
    this.sendPersonal = sendPersonal;
    this.interrupt = interrupt;
    this.readProjectState = readProjectState;
    this.readQuestion = pendingQuestion;
    this.fullHistory = id => readLocalTurnPage(id, { all: true });
    this.prepareQuestion = (id, questions, answer) => prepareQuestionReply(id, questions, answer, this.call);
    this.readErrors = new Map();
    this.localReadUntil = new Map();
    this.inventoryStale = false;
    this.creatingTopics = new Map();
    this.syncing = new Map();
    this.scans = new Map();
    this.scanQueue = [];
    this.scansRunning = 0;
    this.incoming = new Map();
    this.deliveryWorkers = new Map();
    this.approvalWork = new Map();
    this.deliveries = new Map();
    this.pauseDelivery = sleep;
    this.state.outbox ||= {};
    this.state.deliveryParts ||= {};
    this.state.readPending ||= {};
    this.state.inbox ||= {};
    this.state.pendingOps ||= {};
    if (this.state.pending) {
      this.state.pendingOps.legacy = this.state.pending;
      delete this.state.pending;
    }
    this.state.topics ||= {};
    this.state.projects ||= {};
    this.state.newChats ||= {};
    this.state.ignoredPrompts ||= {};
    this.state.historyPending ||= {};
    // Explicit selection works before the first realtime inventory is available.
    this.state.enabled ||= this.state.selected ? { [this.state.selected]: true } : {};
    this.state.delivered ||= {};
    this.state.telegramPrompts ||= {};
    this.state.sources ||= {};
    this.state.attention ||= {};
    this.state.awaitingQuestions ||= {};
    this.state.historyImported ||= {};
    this.state.controlActions ||= {};
    this.state.topicReplacements ||= {};
    this.state.approvalNotices ||= {};
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
    const topic = this.state.topicMode ? await this.topic(threadId) : 0;
    const key = threadId + ':' + topic + ':' + event.key;
    if (!this.deliveries.has(key)) this.deliveries.set(key, this.deliverEvent(threadId, event, armQuestion, key));
    const work = this.deliveries.get(key);
    try { return await work; }
    finally { if (this.deliveries.get(key) === work) this.deliveries.delete(key); }
  }

  async deliverEvent(threadId, event, armQuestion, key) {
    const delivered = this.state.delivered[threadId] ||= [];
    if (delivered.includes(event.key)) return;
    const progress = this.state.deliveryParts[key] ||= { next: 0 };
    if (event.role === 'user' && event.origin === 'telegram') {
      // The original Telegram prompt is already visible in the topic.
    } else if (event.role === 'user' && this.sendPersonal && this.state.topicMode) {
      const topicId = await this.topic(threadId);
      progress.parts ||= chunks(event.text).map(text => ({ text }));
      for (let index = progress.next; index < progress.parts.length; index++) {
        const receipt = progress.parts[index], part = receipt.text;
        const pendingKey = this.config.chatId + ':' + topicId;
        receipt.pendingKey = pendingKey;
        receipt.randomId ||= crypto.randomBytes(8).readBigInt64LE().toString();
        this.state.historyPending[pendingKey] = part;
        this.persist();
        const sent = receipt.receivedId ? { id: receipt.receivedId } : await this.sendPersonal(part, topicId, receipt);
        this.state.ignoredPrompts[this.config.chatId + ':' + sent.id] = true;
        delete this.state.historyPending[pendingKey];
        progress.next = index + 1;
        this.persist();
      }
    } else {
      const text = event.finalAnswer && !event.text.trimEnd().endsWith('[end]') ? event.text.trimEnd() + '\n[end]' : event.text;
      await this.send((event.role === 'user' ? 'Bạn:\n' : '') + text, threadId, {}, event.role === 'assistant', progress);
    }
    delivered.push(event.key);
    delete this.state.deliveryParts[key];
    if (armQuestion && event.question) this.state.awaitingQuestions[threadId] = event.key;
    this.persist();
  }

  queueDelivery(threadId, event, armQuestion = false) {
    if (this.state.delivered[threadId]?.includes(event.key)) return;
    const queue = this.state.outbox[threadId] ||= [];
    if (!queue.some(item => item.event.key === event.key)) {
      queue.push({ event, armQuestion });
      this.persist();
    }
    this.startDelivery(threadId);
  }

  startDelivery(threadId) {
    if (this.deliveryWorkers.has(threadId)) return this.deliveryWorkers.get(threadId);
    const work = this.drainDelivery(threadId).finally(() => this.deliveryWorkers.delete(threadId));
    this.deliveryWorkers.set(threadId, work);
    void work.catch(error => console.error(new Date().toISOString(), 'Hàng gửi', threadId + ':', error.message));
    return work;
  }

  async drainDelivery(threadId) {
    const queue = this.state.outbox[threadId];
    while (queue?.length && !this.syncing.has(threadId)) {
      const item = queue[0];
      try { await this.deliver(threadId, item.event, item.armQuestion); }
      catch (error) {
        item.attempts = (item.attempts || 0) + 1;
        item.error = error.message;
        this.persist();
        console.error(new Date().toISOString(), 'Chưa gửi xong; giữ hàng chờ', threadId + ':', error.message);
        await this.pauseDelivery(Math.max(Number(error.seconds || 0) * 1000,
          Math.min(60000, 1000 * 2 ** Math.min(item.attempts, 6))));
        continue;
      }
      queue.shift();
      if (!queue.length) delete this.state.outbox[threadId];
      this.persist();
    }
  }

  async update(threadId) {
    if (!this.syncing.has(threadId)) this.syncing.set(threadId, this.pullUpdate(threadId));
    try { return await this.syncing.get(threadId); }
    finally { this.syncing.delete(threadId); await this.startDelivery(threadId); }
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
    } while (cursor && pairs.length < 20);
    for (const { turn } of pairs.slice(0, 20).reverse()) {
      const finalIds = new Set(turn.items.filter(i => i.type === 'agentMessage' &&
        (!i.phase || i.phase === 'final_answer')).map(i => i.id));
      for (const event of conversationEvents([turn])) {
        if (event.role === 'user' || finalIds.has(event.key) || event.key === turn.id + ':error') {
          this.queueDelivery(threadId, { ...event, origin: 'desktop' });
        }
      }
    }
    await this.startDelivery(threadId);
    this.state.historyImported[threadId] = true;
    this.persist();
  }

  async replaceTopic(id, oldTopic) {
    const operation = { kind: 'full', threadId: id, oldTopic,
      oldDelivered: this.state.delivered[id] || [] };
    this.state.topicReplacements[id] = operation;
    this.persist();
    try {
      const me = await this.telegram('getMe', {});
      const member = await this.telegram('getChatMember', { chat_id: this.config.chatId, user_id: me.id });
      if (!member.can_delete_messages) throw new Error('Bot cần quyền Delete messages để dùng /full.');
      const { turns } = await this.fullHistory(id);
      const topic = await this.telegram('createForumTopic', { chat_id: this.config.chatId,
        name: Array.from(this.state.threads[id].title).slice(0, 128).join('') });
      operation.newTopic = topic.message_thread_id;
      this.state.topics[id] = operation.newTopic;
      this.state.delivered[id] = [];
      this.persist();
      for (const event of conversationEvents(turns)) {
        await this.deliver(id, { ...event, origin: 'desktop' }, !!event.activeQuestion);
      }
      await this.send('Đã chép toàn bộ lịch sử tin nhắn. Topic này nối với cùng chat Codex; đang thay topic cũ.', id);
      this.state.historyImported[id] = true;
      operation.copied = true;
      this.persist();
      const deleted = await this.telegram('deleteForumTopic', { chat_id: this.config.chatId, message_thread_id: oldTopic });
      if (!deleted) throw new Error('Telegram chưa xác nhận xóa topic cũ.');
    } catch (error) {
      if (!operation.copied) {
        this.state.topics[id] = oldTopic;
        this.state.delivered[id] = operation.oldDelivered;
        this.persist();
        await this.send('Chưa chép đủ lịch sử; đã giữ topic cũ. ' + error.message +
          (operation.newTopic ? '\nTopic mới đang chép dở chưa được liên kết.' : ''), id);
      } else {
        await this.send('Lịch sử đã chép đủ vào topic này, nhưng chưa xác nhận xóa topic cũ. Không tự xóa lại. ' + error.message, id);
      }
    } finally {
      delete this.state.topicReplacements[id];
      this.persist();
    }
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
    this.queueDelivery(threadId, all[boundary]);
    let count = 0;
    for (const event of all.slice(boundary + 1)) {
      if (event.origin === 'telegram' || this.state.delivered[threadId]?.includes(event.key)) continue;
      this.queueDelivery(threadId, event);
      count++;
    }
    this.persist();
    if (!count) await this.send('Chưa có tin mới từ prompt trên desktop.', threadId);
  }

  async send(text, threadId, extra = {}, attachFiles = false, progress) {
    const topicId = threadId && this.state.topicMode ? await this.topic(threadId) : null;
    if (threadId && !this.state.topicMode) text = '[' + this.state.threads[threadId].title + ']\n' + text;
    const destination = { chat_id: this.config.chatId || this.config.ownerId, ...extra,
      ...(topicId ? { message_thread_id: topicId } : {}) };
    const parts = progress?.parts || (attachFiles ? localFileParts(text) : [{ text }]).flatMap(part =>
      part.file ? [part] : chunks(part.text || '').filter(text => text.trim()).map(text => ({ text })));
    if (progress && !progress.parts) { progress.parts = parts; this.persist(); }
    for (let index = progress?.next || 0; index < parts.length; index++) {
      const part = parts[index];
      if (part.file) {
        try {
          const sent = await this.telegram('sendDocument', { ...destination, document: part.file, caption: part.label.slice(0, 1024) });
          if (threadId) this.state.routes[destination.chat_id + ':' + sent.message_id] = threadId;
          if (progress) progress.next = index + 1;
          this.persist();
          continue;
        } catch (error) {
          // Keep transient/uncertain uploads pending. Invalid or forbidden local
          // files retain the existing explicit path+reason notice.
          if (progress && !['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES'].includes(error.code) &&
              !/Không tự gửi file cấu hình|Đường dẫn không phải file/.test(error.message)) throw error;
          part.text = part.original + '\nChưa gửi được file: ' + error.message;
          const replacement = chunks(part.text).map(text => ({ text }));
          parts.splice(index, 1, ...replacement);
          if (progress) this.persist();
          index--;
          continue;
        }
      }
      const sent = await this.telegram('sendMessage', { ...destination, text: part.text });
      if (threadId) this.state.routes[(extra.chat_id || this.config.chatId || this.config.ownerId) + ':' + sent.message_id] = threadId;
      if (progress) progress.next = index + 1;
      this.persist();
    }
  }

  async startApp(action = 'start', pause = sleep) {
    if (action === 'start') {
      try { await this.call('list_threads', { limit: 1 }); return true; }
      catch { /* Launch only when the existing App connection is unavailable. */ }
    }
    await this.appControl(action);
    if (action === 'restart') {
      this.state.controlActions = {}; this.state.approvalNotices = {}; this.persist();
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await this.call('list_threads', { limit: 1 }); return true; }
      catch { await pause(1000); }
    }
    return false;
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
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
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

  async modelMenu(id, effortMenu = false) {
    await ensureOwner(id, this.call, this.desktop);
    const current = await this.snapshot(id), models = this.models();
    const kind = effortMenu ? 'effort' : 'model';
    const activeModel = models.find(m => m.model === current.latestModel);
    if (effortMenu && !activeModel) throw new Error('Không có danh mục effort cho model hiện tại.');
    for (const [key, action] of Object.entries(this.state.controlActions)) {
      if (action.kind === kind && action.threadId === id) delete this.state.controlActions[key];
    }
    const entries = effortMenu ? activeModel.efforts.map(effort => ({ model: current.latestModel, effort, label: effort })) : models;
    const buttons = entries.map(model => {
      const key = crypto.randomBytes(6).toString('hex');
      this.state.controlActions[key] = { kind, threadId: id, model: model.model, ...(effortMenu ? { effort: model.effort } : {}) };
      const selected = effortMenu ? current.latestReasoningEffort === model.effort : current.latestModel === model.model;
      return [{ text: (selected ? '✓ ' : '') + model.label, callback_data: 'control:' + key }];
    });
    this.persist();
    await this.send('Model hiện tại: ' + current.latestModel + (effortMenu ? '\nEffort hiện tại: ' + current.latestReasoningEffort +
      '\nChọn effort cho các lượt tiếp theo:' : '\nChọn model cho các lượt tiếp theo của chat này:'), id,
      { reply_markup: { inline_keyboard: buttons } });
  }

  async approvalMenu(id) {
    const snapshot = await this.snapshot(id), requests = snapshot.requests || [];
    const activeKeys = new Set(requests.map(r => id + ':' + r.id));
    for (const key of Object.keys(this.state.approvalNotices)) {
      if (key.startsWith(id + ':') && !activeKeys.has(key)) delete this.state.approvalNotices[key];
    }
    for (const request of requests) {
      const spec = approvalChoices(request), notice = id + ':' + request.id;
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
      if (!spec?.choices.length || this.state.approvalNotices[notice] === fingerprint) continue;
      for (const [key, action] of Object.entries(this.state.controlActions)) {
        if (action.kind === 'approval' && action.threadId === id && action.requestId === request.id) delete this.state.controlActions[key];
      }
      const key = crypto.randomBytes(6).toString('hex');
      const owner = await this.desktop('thread-owner-discovery', { hostId: 'local', conversationId: id }, 1);
      this.state.controlActions[key] = { kind: 'approval', threadId: id, requestId: request.id,
        ownerClientId: owner.handledByClientId,
        fingerprint };
      this.persist();
      const p = request.params || {};
      const details = p.message || p.reason || 'Codex yêu cầu cấp quyền.';
      const scope = Object.fromEntries(Object.entries({ command: p.command, cwd: p.cwd, grantRoot: p.grantRoot,
        permissions: p.permissions, network: p.networkApprovalContext,
        tool: p._meta?.tool_name, app: p._meta?.connector_id, parameters: p._meta?.tool_params,
      }).filter(([, value]) => value != null));
      // Keep exact request details visible. No answer is preselected or auto-approved.
      await this.send('Yêu cầu cấp quyền\n' + details + (Object.keys(scope).length ? '\n' + JSON.stringify(scope) : ''), id);
      await this.send('Chọn cho yêu cầu ' + request.id + ':', id, { reply_markup: { inline_keyboard:
        spec.choices.map((choice, index) => [{ text: choice.label, callback_data: 'control:' + key + ':' + index }]),
      } });
      this.state.approvalNotices[notice] = fingerprint;
      this.persist();
    }
  }

  async handleControl(key, choice, message) {
    const action = this.state.controlActions[key];
    const id = destination(message, this.state);
    if (!action || action.threadId !== id) return this.send('Nút đã hết hiệu lực hoặc không thuộc topic này.', id);
    if (action.kind === 'model' || action.kind === 'effort') {
      const model = this.models().find(m => m.model === action.model);
      if (!model) throw new Error('Model không còn trong danh mục. Gửi /model để chọn lại.');
      const owner = await ensureOwner(id, this.call, this.desktop), before = await this.snapshot(id);
      if (action.kind === 'effort' && (before.latestModel !== action.model || !model.efforts.includes(action.effort))) {
        delete this.state.controlActions[key]; this.persist();
        return this.send('Model đã đổi hoặc effort không còn hỗ trợ. Gửi /effort để chọn lại.', id);
      }
      const effort = action.kind === 'effort' ? action.effort :
        model.efforts.includes(before.latestReasoningEffort) ? before.latestReasoningEffort : model.defaultEffort;
      delete this.state.controlActions[key]; this.persist();
      const changed = await this.desktop('thread-follower-update-thread-settings', {
        conversationId: id, threadSettings: { model: model.model, effort },
        ...(action.kind === 'effort' ? { condition: { ifModelEquals: before.latestModel, ifEffortEquals: before.latestReasoningEffort } } : {}),
      }, 2, owner.handledByClientId);
      const after = await this.snapshot(id);
      if (!changed.result?.applied || after.latestModel !== model.model || after.latestReasoningEffort !== effort) throw new Error('Codex chưa xác nhận model/effort mới.');
      return this.send((action.kind === 'effort' ? 'Đã đổi effort: ' + effort + ' · model: ' + model.label :
        'Đã đổi model: ' + model.label + ' · effort: ' + effort) + '. Áp dụng từ lượt tiếp theo.', id);
    }
    const request = (await this.snapshot(id)).requests?.find(r => r.id === action.requestId);
    const fingerprint = request && crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    if (!request || fingerprint !== action.fingerprint) {
      delete this.state.approvalNotices[id + ':' + action.requestId];
      delete this.state.controlActions[key]; this.persist();
      return this.send('Yêu cầu đã thay đổi hoặc đã xử lý trong Codex. Không gửi quyết định cũ.', id);
    }
    const spec = approvalChoices(request), selected = spec?.choices[Number(choice)];
    if (!selected || choice == null) throw new Error('Lựa chọn cấp quyền không hợp lệ.');
    const owner = await this.desktop('thread-owner-discovery', { hostId: 'local', conversationId: id }, 1);
    if (action.ownerClientId !== owner.handledByClientId) {
      delete this.state.approvalNotices[id + ':' + action.requestId];
      delete this.state.controlActions[key]; this.persist();
      return this.send('Cửa sổ xử lý yêu cầu đã đổi. Không gửi quyết định cũ.', id);
    }
    delete this.state.controlActions[key]; this.persist();
    const result = await this.desktop(spec.method, { conversationId: id, requestId: request.id, ...selected.args }, 1, owner.handledByClientId);
    if (!result.result?.ok) throw new Error('Codex chưa xác nhận quyết định. Không tự gửi lại.');
    if ((await this.snapshot(id)).requests?.some(r => r.id === request.id)) throw new Error('Yêu cầu vẫn đang chờ; kiểm tra trong Codex. Không tự gửi lại.');
    return this.send('Đã xử lý: ' + selected.label, id);
  }

  async createChat(project, title, prompt, updateId, reply) {
    const key = crypto.randomUUID();
    const operation = this.state.pendingOps[key] = { kind: 'create', projectId: project.projectId, updateId };
    this.creatingChat++;
    this.persist();
    let id;
    try {
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
      operation.threadId = id;
      this.persist();
      if (this.state.topicMode) {
        // Persist the initial prompt before a nonessential acknowledgement can fail.
        this.queueDelivery(id, { key: 'initial-prompt:' + id, role: 'user', text: prompt, origin: 'desktop' });
      }
      await this.send('Đã tạo chat mới trong project ' + project.label +
        '. Tiếp tục nhắn tại topic này.', id);
      if (this.state.topicMode) {
        // The first prompt was sent in the creation topic, not this new topic.
        await this.startDelivery(id);
      }
    } catch (error) {
      await reply((id ? 'Chat đã được tạo, nhưng chưa hoàn tất thông báo Telegram: ' :
        'Tạo chat chưa được xác nhận: ') + error.message + '\nBot không tự tạo lại để tránh trùng chat.');
    } finally {
      this.creatingChat--;
      delete this.state.pendingOps[key];
      this.persist();
    }
  }

  enqueue(update) {
    const message = update.message || update.callback_query?.message;
    const key = this.state.topicMode && message ? menuContext(message) : 'legacy';
    // Persist waiting inputs before advancing getUpdates. On restart only inputs
    // that never began handling are resumed; uncertain submissions are not replayed.
    this.state.inbox[update.update_id] = update;
    this.state.offset = Math.max(this.state.offset || 0, update.update_id + 1);
    this.persist();
    const work = (this.incoming.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      delete this.state.inbox[update.update_id];
      this.persist();
      try { await this.handle(update); }
      catch (error) {
        console.error(new Date().toISOString(), 'Xử lý Telegram', key + ':', error.message);
        if (message) await this.send('Lỗi xử lý Telegram: ' + error.message, null, {
          chat_id: message.chat.id,
          ...(message.message_thread_id == null ? {} : { message_thread_id: message.message_thread_id }),
        });
      }
    }).finally(() => {
      if (this.incoming.get(key) === work) this.incoming.delete(key);
    });
    this.incoming.set(key, work);
    return work;
  }

  async handle(update) {
    const message = update.message || update.callback_query?.message;
    const sender = update.callback_query?.from || message?.from;
    if (!message || !await authorized({ ...message, from: sender }, this.config.ownerId, this.config.chatId,
      args => this.telegram('getChatMember', args))) return;
    const controlReply = text => this.send(text, null, { chat_id: message.chat.id,
      ...(message.message_thread_id == null ? {} : { message_thread_id: message.message_thread_id }) });
    const replacing = Object.values(this.state.topicReplacements).find(op =>
      message.chat.id === this.config.chatId && [op.oldTopic, op.newTopic].includes(message.message_thread_id));
    if (replacing) {
      if (update.message && (this.state.ignoredPrompts[message.chat.id + ':' + message.message_id] ||
        this.state.historyPending[message.chat.id + ':' + message.message_thread_id] === message.text)) return;
      return controlReply('Topic này đang chép toàn bộ lịch sử. Chờ hoàn tất rồi nhắn tiếp; các chat khác vẫn dùng được.');
    }
    if (update.message && message.message_thread_id != null) {
      const threadId = destination(message, this.state);
      if (this.creatingTopics.has(threadId)) await this.creatingTopics.get(threadId);
      if (this.syncing.has(threadId)) await this.syncing.get(threadId);
      if (this.state.ignoredPrompts[message.chat.id + ':' + message.message_id]) return;
      const pending = this.state.historyPending[message.chat.id + ':' + message.message_thread_id];
      if (pending != null && pending === message.text) {
        const key = message.chat.id + ':' + message.message_thread_id;
        const part = Object.values(this.state.deliveryParts).flatMap(progress => progress.parts || [])
          .find(part => part.pendingKey === key && part.text === message.text && !part.receivedId);
        if (part) {
          part.receivedId = message.message_id;
          this.state.ignoredPrompts[message.chat.id + ':' + message.message_id] = true;
          this.persist();
          return;
        }
        return controlReply('Tin này khớp prompt lịch sử có kết quả gửi chưa xác định. Bot không chạy lại; kiểm tra lịch sử topic trước.');
      }
    }
    if (update.callback_query) {
      const id = update.callback_query.data || '';
      // Stop the button spinner before any slow Codex read. Telegram may have
      // expired this UI acknowledgement while an earlier operation was running.
      try { await this.telegram('answerCallbackQuery', { callback_query_id: update.callback_query.id }); }
      catch (error) {
        if (!/^Telegram 400: Bad Request: (?:query is too old and response timeout expired or query ID is invalid|QUERY_ID_INVALID)$/i.test(error.message)) throw error;
      }
      if (id.startsWith('control:')) {
        const [, key, choice] = id.split(':');
        try { return await this.handleControl(key, choice, message); }
        catch (error) { return controlReply('Chưa thực hiện được: ' + error.message); }
      }
      if (id.startsWith('project:') || id.startsWith('newchat:')) {
        const [action, projectId] = id.split(':');
        // Refresh the trusted project inventory; never accept an arbitrary callback ID.
        const projects = localProjects(await this.call('list_projects', {}));
        this.state.projects = Object.fromEntries(projects.map(p => [p.projectId, p]));
        this.persist();
        const project = this.state.projects[projectId];
        if (!project) return controlReply('Project không còn khả dụng. Gửi /projects để chọn lại.');
        if (action === 'project') return this.projectMenu(projectId, message);
        this.state.newChats[menuContext(message)] = { projectId, title: null };
        this.persist();
        return controlReply('Project: ' + project.label + '\nNhập tên chat mới (một dòng, tối đa 80 ký tự). /cancel để hủy.');
      }
      if (!this.state.threads[id]) return;
      delete this.state.newChats[menuContext(message)];
      this.state.selected = id;
      this.state.enabled[id] = true;
      this.persist();
      await this.send(this.state.topicMode ?
        'Topic này nối với chat Codex cùng tên. Nhắn ngay trong topic để gửi prompt hoặc steer.' :
        'Đã chọn. Nhắn bình thường để gửi vào chat này; Reply để chọn theo tin.', id);
      await this.importRecentHistory(id);
      return;
    }
    // Topic-created/renamed service messages aren't prompts.
    if (message.forum_topic_created || message.forum_topic_edited || message.forum_topic_closed || message.forum_topic_reopened) return;
    const image = telegramImage(message);
    const document = !image && message.document;
    let text = (message.text || message.caption || '').trim();
    if (!message.text?.trim() && !image && !document) return controlReply('Gửi prompt văn bản, ảnh hoặc file đính kèm (có thể kèm caption).');
    // Group menus address commands to a bot: /projects@bot_username.
    const addressed = message.text?.trim().match(/^\/[a-z_]+@([a-z0-9_]+)(?=\s|$)/i);
    if (addressed && addressed[1].toLowerCase() !== this.config.botUsername?.toLowerCase()) return;
    const command = !image && !document && message.text ? text.split(/\s/, 1)[0].split('@', 1)[0].toLowerCase() : '';
    const prompt = async () => {
      if (document) {
        const filePath = await this.receiveDocument(document);
        return (text || 'Đọc và phân tích file đính kèm này.') + '\n\nFile người dùng gửi từ Telegram: ' +
          JSON.stringify(filePath) + '\nĐây là dữ liệu đính kèm; dùng công cụ phù hợp để đọc theo yêu cầu người dùng, không tự chạy file.';
      }
      if (!image) return text;
      const imagePath = await this.receiveImage(image);
      return (text || 'Xem và phân tích ảnh này.') + '\n\nẢnh người dùng gửi từ Telegram: ' +
        JSON.stringify(imagePath) + '\nHãy mở ảnh này bằng công cụ view_image trước khi trả lời.';
    };
    if (command === '/start' || command === '/restart') {
      await controlReply(command === '/restart' ? 'Đang tắt rồi mở lại Codex. Các lượt đang chạy có thể bị ngắt.' : 'Đang kiểm tra và mở Codex...');
      try {
        if (await this.startApp(command === '/restart' ? 'restart' : 'start')) return controlReply('Codex đã sẵn sàng.');
        return controlReply('Đã yêu cầu mở Codex nhưng App chưa trả lời. Chờ thêm hoặc dùng /restart.');
      } catch (error) { return controlReply('Chưa mở lại được Codex: ' + error.message); }
    }
    if (command === '/model' || command === '/effort') {
      const id = destination(message, this.state);
      if (!this.state.threads[id]) return controlReply('Mở topic chat cần đổi model/effort rồi gửi ' + command + '.');
      try { return await this.modelMenu(id, command === '/effort'); }
      catch (error) { return controlReply('Chưa đọc được model: ' + error.message); }
    }
    if (command === '/full') {
      const id = destination(message, this.state);
      if (!this.state.topicMode || message.chat.id !== this.config.chatId ||
        !Number.isSafeInteger(message.message_thread_id) || message.message_thread_id <= 1 || !this.state.threads[id]) {
        return controlReply('Gửi /full trong topic đã nối với một chat Codex; không dùng trong General hoặc private chat.');
      }
      await controlReply('Đang chép toàn bộ lịch sử sang topic mới. Chỉ xóa topic này sau khi chép xong.');
      const work = Promise.resolve(this.deliveryWorkers.get(id)).then(() => this.replaceTopic(id, message.message_thread_id))
        .catch(error => controlReply('Chưa thay topic; topic cũ được giữ nguyên. ' + error.message))
        .finally(() => this.syncing.delete(id));
      this.syncing.set(id, work);
      void work.catch(error => console.error('/full:', error.message));
      return;
    }
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
      return this.send('Chọn project:', null, {
        chat_id: message.chat.id,
        ...(message.message_thread_id == null ? {} : { message_thread_id: message.message_thread_id }),
        reply_markup: { inline_keyboard: projects
          .map(p => [{ text: p.label, callback_data: 'project:' + p.projectId }]) },
      });
    }
    if (command === '/help') {
      return controlReply('/start — bật Codex\n/restart — tắt rồi mở lại Codex (ngắt các lượt đang chạy)\n/model — đổi model cho chat đang chọn\n/effort — đổi mức suy nghĩ cho model hiện tại\n/projects — chọn project, mở chat gần đây hoặc New chat\nNew chat → đặt tên → gửi prompt đầu tiên (có thể kèm ảnh/file).\n/chats — chọn chat có sẵn\nNhắn trong topic để gửi prompt hoặc steer. Chat, prompt và phản hồi mới trên desktop tự đồng bộ; không cần /update.\n/update — lấy tin desktop mới sau prompt Telegram gần nhất\n/full — thay topic hiện tại, chép toàn bộ lịch sử chat Codex\n/cancel — dừng lượt đang chạy, hoặc hủy bước New chat\n/status — trạng thái chat\n/quota — hạn mức Codex và thời điểm reset\nChờ cấp quyền: chọn bằng nút khi có; yêu cầu không hỗ trợ thì xử lý trong App.');
    }
    if (command === '/chats') {
      const threads = await this.chats();
      if (!threads.length) return;
      return this.send(this.state.topicMode ? 'Chọn chat để mở topic riêng:' : 'Chọn chat:', null, {
        chat_id: message.chat.id,
        ...(message.message_thread_id == null ? {} : { message_thread_id: message.message_thread_id }),
        reply_markup: { inline_keyboard:
          threads.map(t => [{ text: t.title, callback_data: t.id }]),
        },
      });
    }
    let newChat = this.state.newChats[menuContext(message)];
    if (newChat && !['/status', '/update'].includes(command)) {
      if (typeof newChat === 'string') newChat = this.state.newChats[menuContext(message)] = { projectId: newChat, title: null };
      if (!newChat.title) {
        if (!message.text || image || document || /[\r\n]/.test(text) || Array.from(text).length > 80 || text.startsWith('/')) {
          return controlReply('Nhập tên chat bằng văn bản một dòng, tối đa 80 ký tự. Sau đó mới gửi prompt hoặc file.');
        }
        newChat.title = text;
        this.persist();
        return controlReply('Tên chat: ' + text + '\nBây giờ gửi prompt đầu tiên, ảnh hoặc file kèm yêu cầu. /cancel để hủy.');
      }
      try { text = await prompt(); }
      catch (error) { return controlReply('Chưa nhận được file/ảnh: ' + error.message + ' Gửi lại để thử lại.'); }
      // Consume intent before dispatch, so an uncertain creation is never replayed.
      delete this.state.newChats[menuContext(message)];
      this.persist();
      const projects = localProjects(await this.call('list_projects', {}));
      const project = projects.find(p => p.projectId === newChat.projectId);
      if (!project) return controlReply('Project không còn khả dụng. Gửi /projects để chọn lại.');
      return this.createChat(project, newChat.title, text, update.update_id, controlReply);
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
    catch (error) { return controlReply('Chưa nhận được file/ảnh: ' + error.message + ' Gửi lại để thử lại.'); }
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
    const pendingKey = crypto.randomUUID();
    this.state.pendingOps[pendingKey] = { updateId: update.update_id, threadId: id };
    (this.state.telegramPrompts[id] ||= []).push(text);
    this.persist();
    let result;
    try {
      result = submission ? await submission.send() :
        await this.call('send_message_to_thread', { threadId: id, hostId: 'local', prompt: text });
    } catch (error) {
      return await this.send('Gửi chưa được xác nhận: ' + error.message + '\nBot không tự gửi lại. Kiểm tra chat trên máy trước khi gửi lại.', id);
    } finally {
      delete this.state.pendingOps[pendingKey];
      this.persist();
    }
    // An acknowledgement delivery failure does not undo Codex's acceptance.
    await this.send(result.message || 'Codex App đã nhận prompt.', id);
  }

  async scanDesktop(options) {
    let inventory;
    try {
      inventory = await this.rawCall('list_threads', { limit: 50 }, { timeout: 30000 });
      this.inventoryStale = false;
    } catch (error) {
      this.inventoryStale = error.message === 'Codex App timeout; kết quả chưa xác định.';
      throw error;
    }
    const threads = localThreads(inventory, this.readProjectState());
    // First enablement establishes a baseline; subsequent discoveries are new chats.
    if (!this.state.realtimeBaseline) {
      this.state.realtimeBaseline = Object.fromEntries(
        [...new Set([...Object.keys(this.state.threads), ...threads.map(t => t.id)])].map(id => [id, true]));
      for (const id of Object.keys(this.state.realtimeBaseline)) this.state.enabled[id] = true;
    }
    for (const thread of threads) {
      this.state.threads[thread.id] = thread;
      this.state.enabled[thread.id] = true;
    }
    this.persist();
    await this.scan(options);
  }

  async readDesktopPage(args) {
    const local = () => readLocalTurnPage(args.threadId, args);
    if (this.inventoryStale || (this.localReadUntil.get(args.threadId) || 0) > Date.now()) return local();
    try {
      // Background reads can recover from disk; uncertain submissions are never replayed.
      return await readThread((tool, body) => this.rawCall(tool, body, { timeout: 30000 }), args);
    } catch (error) {
      if (error.message !== 'Codex App timeout; kết quả chưa xác định.') throw error;
      this.localReadUntil.set(args.threadId, Date.now() + 60000);
      console.error(new Date().toISOString(), 'App đọc chậm; dùng lịch sử local:', args.threadId);
      return local();
    }
  }

  async scan({ wait = true } = {}) {
    for (const id of Object.keys(this.state.outbox)) this.startDelivery(id);
    const jobs = [];
    for (const id of Object.keys(this.state.enabled).filter(id => this.state.enabled[id])) {
      if (!this.scans.has(id)) {
        const job = new Promise(resolve => this.scanQueue.push({ id, resolve }));
        this.scans.set(id, job);
      }
      jobs.push(this.scans.get(id));
    }
    this.drainScans();
    if (wait) {
      await Promise.all(jobs);
      await Promise.all([...this.approvalWork.values()]);
      await Promise.all([...this.deliveryWorkers.values()]);
    }
  }

  drainScans() {
    // Bound App reads; a stalled chat occupies one slot, not the whole scan loop.
    while (this.scansRunning < 4 && this.scanQueue.length) {
      const { id, resolve } = this.scanQueue.shift();
      this.scansRunning++;
      void this.scanThread(id).catch(error => {
        console.error(new Date().toISOString(), 'Đồng bộ chat', id + ':', error.message);
      }).finally(() => {
        this.scansRunning--;
        this.scans.delete(id);
        resolve();
        this.drainScans();
      });
    }
  }

  async scanThread(id) {
    const thread = this.state.threads[id];
    if (!thread || !this.state.enabled[id]) return;
    if (this.syncing.has(id)) return;
    // Keep the copied first prompt ahead of responses, including fast turns.
    if (Object.values(this.state.pendingOps).some(op => op.kind === 'create' && op.threadId === id)) return;
    try {
      const prior = this.state.seen[id];
      const realtime = !!this.state.realtimeBaseline;
      const baseline = !!this.state.realtimeBaseline?.[id];
      if (realtime && !prior && this.creatingChat) return;
      const active = (typeof thread.status === 'string' ? thread.status : thread.status?.type) === 'active';
      if (realtime && !this.inventoryStale && !this.state.readPending[id] && !baseline && prior && !active && !prior.wasActive &&
        prior.updatedAt === thread.updatedAt && !this.state.telegramPrompts[id]?.length) return;
      if (realtime && !baseline && !prior && this.state.topicMode) await this.topic(id);
      const turns = [];
      let cursor, status;
      // Walk back to the last observed turn, so fast consecutive turns aren't lost.
      do {
        const result = await this.readDesktopPage({
          threadId: id, hostId: 'local', turnLimit: 1, includeOutputs: true,
          maxOutputCharsPerItem: 20000, ...(cursor ? { cursor } : {}),
        });
        status ||= result.thread?.status;
        turns.push(...(result.turns || []));
        cursor = result.page?.nextCursor;
      } while (prior && !baseline && cursor && !turns.some(t => t.id === prior.turnId));
      if (this.syncing.has(id)) return;
      if (status) {
        const flags = status?.activeFlags || [];
        const waiting = flags.filter(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag));
        if (waiting.length && !this.approvalWork.has(id)) {
          const work = this.approvalMenu(id)
            .catch(error => console.error('Đọc lựa chọn cấp quyền:', error.message))
            .finally(() => this.approvalWork.delete(id));
          this.approvalWork.set(id, work);
        }
        const attention = waiting.length ? turns[0]?.id + ':' + waiting.join(',') : '';
        if (attention && this.state.attention[id] !== attention) {
          this.state.attention[id] = attention;
          this.queueDelivery(id, { key: 'attention:' + attention + ':' + crypto.randomUUID(), role: 'assistant', text: waiting.includes('waitingOnApproval') ?
            '⚠️ Codex đang chờ bạn cấp quyền. Dùng nút lựa chọn nếu đã hiện; yêu cầu không có nút cần xử lý trong App. /cancel để dừng lượt này.' :
            '⚠️ Codex đang chờ bạn trả lời câu hỏi trong App. /update để xem tin mới; /cancel để dừng.' });
        }
        this.state.attention[id] = attention;
      }
      const all = this.sourcedEvents(id, turns);
      for (const event of all) {
        if (this.syncing.has(id)) break;
        // Questions need attention even for desktop prompts; do not backfill old completed questions.
        const newQuestion = event.question && (event.activeQuestion || (prior && !prior.keys.includes(event.key)));
        if (realtime ? !baseline && !prior?.keys?.includes(event.key) : event.origin === 'telegram' || newQuestion) {
          this.queueDelivery(id, event, !!newQuestion);
        }
      }
      if (this.syncing.has(id)) return;
      this.state.seen[id] = {
        turnId: turns[0]?.id,
        keys: all.map(event => event.key),
        updatedAt: thread.updatedAt,
        wasActive: (status?.type || (active ? 'active' : 'idle')) === 'active' || turns[0]?.status === 'inProgress',
      };
      if (status) thread.status = status;
      if (baseline) delete this.state.realtimeBaseline[id];
      delete this.state.readPending[id];
      this.persist();
      this.readErrors.delete(id);
    } catch (error) {
      this.state.readPending[id] = { error: error.message, since: this.state.readPending[id]?.since || new Date().toISOString() };
      this.persist();
      if (this.readErrors.get(id) !== error.message) {
        console.error(new Date().toISOString(), 'Đọc chat', id + ':', error.message);
        if (this.state.realtimeBaseline?.[id]) console.error('Chưa ghi được mốc chat local:', error.message);
        else if (!/^(?:Codex App timeout;|fetch failed$|Không xác định được đúng một file lịch sử local)/.test(error.message)) {
          await this.send('Không đọc được chat: ' + error.message, id);
        }
        this.readErrors.set(id, error.message);
      }
    }
  }
}

export async function telegram(token, method, body) {
  const upload = method === 'sendDocument' && typeof body.document === 'string' && /^[A-Za-z]:[\\/]/.test(body.document);
  if (upload && checkedTelegramFile(body.document).stat.size > 50 * 1024 * 1024) {
    const { sendBotFile } = await import('./telegram_user.mjs');
    return sendBotFile(token, body);
  }
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', ...(upload ? { body: await telegramFileBody(body) } : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(upload ? 30 * 60 * 1000 : IPC_TIMEOUT_MS),
  });
  const data = await response.json();
  if (!data.ok) {
    if (data.error_code === 429 && data.parameters?.retry_after) {
      // Telegram explicitly rejected this request; retrying after its wait is safe.
      await sleep(data.parameters.retry_after * 1000);
      return telegram(token, method, body);
    }
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
  const call = (tool, args, options) => appCall(config.callerThreadId, tool, args, options?.timeout);
  const tg = (method, body) => telegram(config.token, method, body);
  const me = await tg('getMe', {});
  config.botUsername = me.username;
  const commands = [
    { command: 'start', description: 'Bật Codex trên máy' },
    { command: 'restart', description: 'Tắt rồi mở lại Codex' },
    { command: 'model', description: 'Đổi model cho chat đang chọn' },
    { command: 'effort', description: 'Đổi mức suy nghĩ cho chat đang chọn' },
    { command: 'projects', description: 'Chọn project, mở hoặc tạo chat' },
    { command: 'chats', description: 'Chọn chat có sẵn' },
    { command: 'update', description: 'Lấy tin mới từ prompt trên desktop' },
    { command: 'full', description: 'Thay topic hiện tại bằng toàn bộ lịch sử Codex' },
    { command: 'cancel', description: 'Dừng lượt đang chạy hoặc hủy New chat' },
    { command: 'status', description: 'Trạng thái chat trong topic' },
    { command: 'quota', description: 'Hạn mức Codex và giờ reset' },
    { command: 'help', description: 'Hướng dẫn sử dụng' },
  ];
  await tg('setMyCommands', { commands });
  if (config.chatId) await tg('setMyCommands', { commands, scope: { type: 'chat', chat_id: config.chatId } });
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
  for (const operation of Object.values(state.topicReplacements)) {
    if (!operation.copied) {
      state.topics[operation.threadId] = operation.oldTopic;
      state.delivered[operation.threadId] = operation.oldDelivered;
    }
    await bridge.send(operation.copied ?
      'Lịch sử đã chép đủ; trạng thái xóa topic cũ chưa xác định. Bot không tự xóa lại.' :
      'Bot dừng khi chép lịch sử. Topic cũ được giữ nguyên; topic mới có thể đang chép dở.', operation.threadId);
    delete state.topicReplacements[operation.threadId];
    bridge.persist();
  }
  for (const [key, operation] of Object.entries(state.pendingOps)) {
    await bridge.send('Bot đã dừng khi đang gửi prompt hoặc tạo chat. Kết quả chưa xác định; kiểm tra App trước khi thử lại.', operation.threadId);
    delete state.pendingOps[key];
    bridge.persist();
  }
  for (const id of Object.keys(state.outbox)) bridge.startDelivery(id);
  void bridge.send('Bot Telegram đã bật, đang mở Codex. Chat, prompt và phản hồi mới trên máy sẽ tự đồng bộ về Telegram. /projects chọn chat; /model đổi model.')
    .catch(error => console.error(new Date().toISOString(), 'Thông báo khởi động:', error.message));
  console.log('Bot đang chạy. Ctrl+C để dừng.');
  // Independent loops: a slow Codex read must not block incoming steering.
  void (async () => {
    let lastError = '', ready = false;
    for (;;) {
      try {
        if (!ready) {
          ready = await bridge.startApp();
          if (!ready) throw new Error('Đã yêu cầu mở Codex nhưng App chưa trả lời. Bot sẽ thử lại.');
          console.log('Codex đã sẵn sàng, bắt đầu tự đồng bộ các chat local.');
        }
        await bridge.scanDesktop({ wait: false }); lastError = '';
      }
      catch (error) {
        console.error(new Date().toISOString(), 'Đọc Codex:', error.message);
        if (error.message !== lastError) {
          if (error.message !== 'Codex App timeout; kết quả chưa xác định.') {
            try { await bridge.send('Lỗi cầu nối Codex: ' + error.message); } catch {}
          }
          lastError = error.message;
        }
      }
      await sleep(3000);
    }
  })();
  // Inventory can stall independently of the visible histories already on disk.
  void (async () => {
    for (;;) {
      if (state.realtimeBaseline) {
        try { await bridge.scan({ wait: false }); }
        catch (error) { console.error(new Date().toISOString(), 'Quét lịch sử:', error.message); }
      }
      await sleep(3000);
    }
  })();
  const dispatch = update => {
    void bridge.enqueue(update).catch(error => console.error(new Date().toISOString(), 'Trả lỗi Telegram:', error.message));
  };
  for (const update of Object.values(state.inbox).sort((a, b) => a.update_id - b.update_id)) dispatch(update);
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset: state.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        dispatch(update);
      }
    } catch (error) { console.error(new Date().toISOString(), 'Telegram getUpdates:', error.message); await sleep(3000); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
