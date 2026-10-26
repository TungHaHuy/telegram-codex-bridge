import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { saveJson } from './telegram_codex.mjs';

const LOCAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.telegram-codex');
const USER_FILE = path.join(LOCAL, 'user-session.json');
const dependency = createRequire(path.join(LOCAL, 'user-client/package.json'));

function clientFor(data) {
  const { TelegramClient } = dependency('teleproto');
  const { StringSession } = dependency('teleproto/sessions');
  const client = new TelegramClient(new StringSession(data.session || ''), data.apiId, data.apiHash, {
    connectionRetries: 3, deviceModel: 'Codex Telegram Bridge', appVersion: '1.0',
  });
  client.setLogLevel('none');
  return client;
}

export async function openPersonal(ownerId, groupId) {
  if (!Number.isSafeInteger(groupId) || groupId >= 0) throw new Error('Phiên cá nhân chỉ gửi lịch sử vào nhóm riêng đã cấu hình.');
  const data = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
  const client = clientFor(data);
  try {
    await client.connect();
    if (!await client.checkAuthorization()) throw new Error('Phiên Telegram cá nhân hết hạn; chạy lại telegram_user.mjs --login.');
    const me = await client.getMe();
    if (me.bot || String(me.id) !== String(ownerId)) throw new Error('Phiên cá nhân không khớp chủ bot đã ghép.');
    let peer;
    for await (const dialog of client.iterDialogs({})) {
      if (String(dialog.id) === String(groupId)) { peer = dialog.inputEntity; break; }
    }
    if (!peer) throw new Error('Tài khoản cá nhân chưa ở trong nhóm Telegram đã cấu hình.');
    return {
      send: (text, topicId) => {
        if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error('Topic không hợp lệ.');
        return client.sendMessage(peer, { message: text, replyTo: topicId, parseMode: undefined, formattingEntities: [], linkPreview: false });
      },
      disconnect: () => client.disconnect(),
    };
  } catch (error) { await client.disconnect(); throw error; }
}

async function login() {
  const config = JSON.parse(fs.readFileSync(path.join(LOCAL, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  const input = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  const ask = async (label, secret = false) => {
    process.stdout.write(label);
    hidden = secret;
    try { return (await input.question('')).trim(); }
    finally { hidden = false; process.stdout.write('\n'); }
  };
  const data = fs.existsSync(USER_FILE) ? JSON.parse(fs.readFileSync(USER_FILE, 'utf8')) : {};
  if (!data.apiId) data.apiId = Number(await ask('App api_id tu my.telegram.org: '));
  if (!data.apiHash) data.apiHash = await ask('App api_hash (an): ', true);
  if (!Number.isSafeInteger(data.apiId) || data.apiId <= 0 || !/^[a-f0-9]{32}$/i.test(data.apiHash)) {
    input.close(); throw new Error('api_id/api_hash không hợp lệ.');
  }
  const client = clientFor(data);
  try {
    await client.connect();
    if (!await client.checkAuthorization()) {
      const credentials = { apiId: data.apiId, apiHash: data.apiHash };
      const auth = {
        password: () => ask('Mat khau Telegram 2 buoc (an, neu co): ', true),
        onError: async error => { throw error; },
      };
      if (process.argv.includes('--phone')) {
        await client.signInUser(credentials, {
          ...auth,
          phoneNumber: () => ask('So dien thoai Telegram (gom ma quoc gia, vi du +84...): '),
          phoneCode: viaApp => ask(viaApp ? 'Ma vua gui vao Telegram tren may tinh (an): ' :
            'Ma dang nhap Telegram vua gui (an): ', true),
          forceSMS: false,
        });
      } else {
        const QRCode = dependency('qrcode');
        await client.signInUserWithQrCode(credentials, {
          ...auth,
          qrCode: async code => {
            await QRCode.toFile(path.join(LOCAL, 'user-login-qr.png'), 'tg://login?token=' + code.token.toString('base64url'));
            console.log('Mở .telegram-codex/user-login-qr.png; Telegram điện thoại → Settings → Devices → Link Desktop Device để quét.');
          },
        });
      }
    }
    const me = await client.getMe();
    if (me.bot || String(me.id) !== String(config.ownerId)) throw new Error('Đăng nhập nhầm tài khoản; cần đúng chủ bot đã ghép.');
    data.session = client.session.save();
    saveJson(USER_FILE, data);
    console.log('Đã lưu phiên cá nhân riêng trên máy. Khởi động lại bridge để dùng.');
  } finally {
    input.close();
    await client.disconnect();
    fs.rmSync(path.join(LOCAL, 'user-login-qr.png'), { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--login')) {
  login().catch(error => { console.error(error.message); process.exitCode = 1; });
}
