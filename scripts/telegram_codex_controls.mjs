import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const IPC_TIMEOUT_MS = 5 * 60 * 1000;

// Socket buffering assembles each frame once, including large chat snapshots.
export function readIpcFrames(socket, receive, fail) {
  let size;
  socket.on('readable', () => {
    try {
      while (!socket.destroyed) {
        if (size === undefined) {
          const header = socket.read(4);
          if (!header) return;
          size = header.readUInt32LE(0);
          if (!size || size > 1024 * 1024 * 1024) throw new Error('Codex IPC frame không hợp lệ hoặc vượt 1 GiB.');
        }
        const body = socket.read(size);
        if (!body) return;
        size = undefined;
        receive(JSON.parse(body.toString('utf8')));
      }
    } catch (error) { fail(error); }
  });
}

export function controlCodexApp(action) {
  if (!['start', 'restart'].includes(action)) throw new Error('Invalid app action.');
  const script = fileURLToPath(new URL('./control_codex_app.ps1', import.meta.url));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise((resolve, reject) => execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Action', action], { windowsHide: true, timeout: IPC_TIMEOUT_MS }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}

export function modelCatalog(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const cache = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
  return cache.models.filter(m => m.visibility === 'list').map(m => ({
    model: m.slug, label: m.display_name || m.slug,
    defaultEffort: m.default_reasoning_level, efforts: m.supported_reasoning_levels.map(e => e.effort),
  }));
}

// One read-only follower subscription. Disconnecting releases the subscription.
export function threadSnapshot(threadId, endpoint = '\\\\.\\pipe\\codex-ipc') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let client = 'initializing-client', done = false;
    const requestId = crypto.randomUUID();
    const send = message => {
      const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
      header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
    };
    const following = value => send({ type: 'broadcast', sourceClientId: client, version: 1,
      method: 'thread-stream-following-changed', params: { hostId: 'local', conversationId: threadId, following: value } });
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer);
      if (client !== 'initializing-client' && socket.writable) following(false);
      socket.end(); socket.destroy(); error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Không đọc được trạng thái trực tiếp của chat.')), IPC_TIMEOUT_MS);
    socket.once('connect', () => send({ type: 'request', requestId, sourceClientId: client, version: 0,
      method: 'initialize', params: { clientType: 'telegram-codex' } }));
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Codex đóng kết nối snapshot.')));
    readIpcFrames(socket, message => {
      if (message.type === 'client-discovery-request') send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      if (message.type === 'response' && message.requestId === requestId) {
        if (message.resultType !== 'success') throw new Error(message.error || 'Codex từ chối snapshot.');
        client = message.result.clientId; following(true);
      }
      if (message.method === 'thread-stream-state-changed' && message.params?.conversationId === threadId && message.params.change?.type === 'snapshot') {
        finish(null, message.params.change.conversationState);
      }
    }, finish);
  });
}

export function approvalChoices(request) {
  const p = request.params || {};
  if (request.method === 'item/commandExecution/requestApproval') return {
    method: 'thread-follower-command-approval-decision', choices: [
      { label: 'Cho phép một lần', args: { decision: 'accept' } }, { label: 'Từ chối', args: { decision: 'decline' } },
    ].filter(c => !p.availableDecisions || p.availableDecisions.includes(c.args.decision)),
  };
  if (request.method === 'item/fileChange/requestApproval') return {
    method: 'thread-follower-file-approval-decision', choices: [
      { label: 'Cho phép một lần', args: { decision: 'accept' } }, { label: 'Từ chối', args: { decision: 'decline' } },
    ],
  };
  if (request.method === 'item/permissions/requestApproval') return {
    method: 'thread-follower-permissions-request-approval-response', choices: [
      { label: 'Cho phép trong lượt này', args: { response: { permissions: p.permissions, scope: 'turn' } } },
      { label: 'Từ chối', args: { response: { permissions: {}, scope: 'turn' } } },
    ],
  };
  if (request.method === 'mcpServer/elicitation/request' && p.mode === 'form' && p._meta?.codex_approval_kind === 'mcp_tool_call') {
    const schema = p.requestedSchema || {}, fields = Object.keys(schema.properties || {});
    // Relay only actual tool consent forms. Login, OTP, user verification and arbitrary forms stay in the App.
    const simple = fields.length === 0 || (fields.length === 1 && fields[0] === 'approved' && schema.properties.approved.type === 'boolean');
    if (!simple || p._meta.approveDisabled) return null;
    return { method: 'thread-follower-submit-mcp-server-elicitation-response', choices: [
      { label: 'Cho phép một lần', args: { response: { action: 'accept', content: fields.length ? { approved: true } : {} } } },
      { label: 'Từ chối', args: { response: { action: 'decline' } } },
    ] };
  }
  return null;
}

export async function ensureOwner(threadId, call, request) {
  try { return await request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1); }
  catch (error) {
    if (error.message !== 'no-client-found') throw error;
    await call('navigate_to_codex_page', { threadId });
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try { return await request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1); }
      catch (retry) { if (retry.message !== 'no-client-found') throw retry; }
    }
    throw new Error('Chưa nạp được chat.');
  }
}
