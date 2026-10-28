import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-user-login-'));
try {
  const scripts = path.join(root, 'scripts'), local = path.join(root, '.telegram-codex');
  const modules = path.join(local, 'user-client/node_modules');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(modules, 'teleproto'), { recursive: true });
  fs.mkdirSync(path.join(modules, 'qrcode'), { recursive: true });
  fs.copyFileSync(new URL('../scripts/telegram_user.mjs', import.meta.url), path.join(scripts, 'telegram_user.mjs'));
  fs.writeFileSync(path.join(scripts, 'telegram_codex.mjs'),
    'import fs from "node:fs"; export function saveJson(file,data){fs.writeFileSync(file,JSON.stringify(data));}\n' +
    'export {checkedTelegramFile} from ' + JSON.stringify(new URL('../scripts/telegram_codex.mjs', import.meta.url).href) + ';');
  fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ ownerId: 42 }));
  fs.writeFileSync(path.join(local, 'user-client/package.json'), '{}');
  fs.writeFileSync(path.join(modules, 'teleproto/sessions.js'),
    'exports.StringSession=class{constructor(s){this.value=s;}save(){return "TEST_SESSION"}};');
  fs.writeFileSync(path.join(modules, 'qrcode/index.js'),
    'exports.toFile=async(file)=>require("node:fs").writeFileSync(file,"TEST_QR");');
  fs.writeFileSync(path.join(modules, 'teleproto/index.js'), `
const assert=require('node:assert/strict');
exports.TelegramClient=class{
  constructor(session){this.session=session;} setLogLevel(){} async connect(){} async disconnect(){if(process.env.TEST_BOT)console.log('DISCONNECTED');}
  async signInBot(credentials,a){
    assert.equal(this.session.value,'','must not reuse the personal login');
    assert.deepEqual(credentials,{apiId:1,apiHash:'a'.repeat(32)});
    assert.equal(a.botAuthToken,'42:TEST_ONLY');
  }
  async sendFile(peer,args){
    assert.equal(peer,-100123);assert.equal(args.replyTo,101);
    assert.equal(args.caption,'Video');assert.equal(args.forceDocument,true);
    assert.equal(args.parseMode,undefined);assert.deepEqual(args.formattingEntities,[]);
    assert.equal(require('node:fs').statSync(args.file).size,50*1024*1024+1);
    assert(!process.env.TEST_WRONG_OWNER,'must verify bot identity before uploading');
    if(process.env.TEST_UPLOAD_FAIL)throw Error('UPLOAD_UNCERTAIN');
    return {id:765};
  }
  async checkAuthorization(){return false;}
  async signInUser(credentials,a){
    assert.equal(process.env.TEST_LOGIN_MODE,'phone'); assert.equal(a.forceSMS,false);
    assert.equal(await a.phoneNumber(),'+10000000000');
    assert.equal(await a.phoneCode(true),'12345');
    assert.equal(await a.password(),'test-password');
  }
  async signInUserWithQrCode(credentials,a){
    assert.equal(process.env.TEST_LOGIN_MODE,'qr');
    await a.qrCode({token:Buffer.from('TEST_ONLY')});
  }
  async getMe(){return {id:process.env.TEST_WRONG_OWNER?'99':'42',bot:!!process.env.TEST_BOT};}
};`);
  async function run(mode, wrongOwner = false) {
    fs.writeFileSync(path.join(local, 'user-session.json'), JSON.stringify({ apiId: 1, apiHash: 'a'.repeat(32) }));
    const child = spawn(process.execPath, [path.join(scripts, 'telegram_user.mjs'), '--login', ...(mode === 'phone' ? ['--phone'] : [])], {
      env: { ...process.env, TEST_LOGIN_MODE: mode, TEST_WRONG_OWNER: wrongOwner ? '1' : '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const prompts = ['So dien thoai Telegram', 'Ma vua gui vao Telegram', 'Mat khau Telegram'];
    const answers = ['+10000000000', '12345', 'test-password'];
    let stdout = '', stderr = '', stage = 0;
    child.stdout.on('data', bytes => {
      stdout += bytes;
      if (mode === 'phone' && stage < prompts.length && stdout.includes(prompts[stage])) child.stdin.write(answers[stage++] + '\n');
    });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const timeout = setTimeout(() => child.kill(), 10000);
    const exitCode = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    clearTimeout(timeout);
    const saved = JSON.parse(fs.readFileSync(path.join(local, 'user-session.json'), 'utf8'));
    assert.equal(stage, mode === 'phone' ? 3 : 0);
    assert(!stdout.includes('12345') && !stdout.includes('test-password'), 'login secrets must not be printed');
    assert.equal(fs.existsSync(path.join(local, 'user-login-qr.png')), false, 'temporary QR is cleaned up');
    if (wrongOwner) {
      assert.equal(exitCode, 1);
      assert(!saved.session, 'never persist a session belonging to a different owner');
      assert(stderr.includes('Đăng nhập nhầm tài khoản'));
    } else {
      assert.equal(exitCode, 0, stderr);
      assert.equal(saved.session, 'TEST_SESSION');
    }
  }
  await run('phone'); await run('phone', true); await run('qr');
  const large = path.join(root, 'video.mp4');
  fs.writeFileSync(large, '');fs.truncateSync(large, 50*1024*1024+1);
  const { execFileSync } = await import('node:child_process');
  for (const mode of ['success', 'wrong-bot', 'uncertain']) {
    const code = `import assert from 'node:assert/strict';import {sendBotFile} from ${JSON.stringify(pathToFileURL(path.join(scripts, 'telegram_user.mjs')).href)};
      const send=()=>sendBotFile('42:TEST_ONLY',${JSON.stringify({chat_id:-100123,message_thread_id:101,document:large,caption:'Video'})});
      ${mode === 'success' ? "assert.deepEqual(await send(),{message_id:765});" : `await assert.rejects(send,/${mode === 'wrong-bot' ? 'khớp bot' : 'UPLOAD_UNCERTAIN'}/);`}`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', env: {...process.env, TEST_BOT:'1', TEST_WRONG_OWNER: mode === 'wrong-bot' ? '1' : '', TEST_UPLOAD_FAIL: mode === 'uncertain' ? '1' : ''},
    });
    assert.equal(result.trim(), 'DISCONNECTED', 'disconnect after success or failure; never retry an uncertain send');
  }
  console.log('telegram_user: phone/QR login, secret output, paired owner, large bot upload, identity check and uncertain-send cleanup passed (mocked Telegram).');
} finally {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'telegram-user-login-')) throw new Error('Unsafe test cleanup');
  fs.rmSync(root, { recursive: true, force: true });
}
