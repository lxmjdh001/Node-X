import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { publicProxy } from '../server/public-proxy.js';
import { InputError } from '../server/errors.js';
import { openMacChrome } from './chrome.js';
import { launcherConfig, launchPayload, ticketPattern } from './protocol.js';

const preview = process.argv.includes('--preview');
const origin = preview ? launcherConfig.previewOrigin : launcherConfig.origin;
const root = join(homedir(), 'Library', 'Application Support', 'Node X Launcher', preview ? 'preview' : 'production');
const sessions = new Map<string, {
  version: string;
  chrome: Awaited<ReturnType<typeof openMacChrome>>;
  closed: Promise<void>;
}>();
const starting = new Map<string, Promise<string>>();
const maxMessageSize = 4096;
let buffer = Buffer.alloc(0);
let closing = false;

function send(reply: { id: string; success: boolean; message: string }) {
  if (closing) return;
  const body = Buffer.from(JSON.stringify(reply), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([length, body]));
}

class LaunchError extends Error {}

function reportPresence(token: string | undefined) {
  if (!token) return { ready: Promise.resolve(), stop: () => Promise.resolve() };
  const endpoint = new URL('/api/launcher/heartbeat', origin);
  let pending = Promise.resolve();
  function send(running: boolean) {
    pending = pending.then(async () => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, running }),
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      });
      await response.body?.cancel();
    }).catch(() => undefined);
    return pending;
  }
  const ready = send(true);
  const timer = setInterval(() => { void send(true); }, 15_000);
  timer.unref();
  return {
    ready,
    stop: () => {
      clearInterval(timer);
      return send(false);
    },
  };
}

async function launch(ticket: string, type: 'open' | 'open-composer' | 'open-messages'): Promise<string> {
  const response = await fetch(new URL('/api/launcher/redeem', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  }).catch(() => { throw new LaunchError('本机启动器无法连接工作台，请检查网络后重试。'); });
  if (!response.ok) {
    if (response.status === 401) throw new LaunchError('启动凭证已失效，请回到工作台重新打开。');
    throw new LaunchError('读取窗口配置失败，请刷新工作台后重试。');
  }
  const result = launchPayload.safeParse(await response.json());
  if (!result.success) throw new LaunchError('工作台返回的窗口配置无效。');
  const { workspace, profile, proxy, width, height, presenceToken, draftText } = result.data;
  const compose = type === 'open-composer';
  const messages = type === 'open-messages';
  if (compose !== Boolean(draftText) || messages !== Boolean(result.data.messages)) {
    throw new LaunchError('启动请求与窗口配置不匹配，请返回工作台重试。');
  }
  const opened = messages ? '已打开该账号的 X 私信页。'
    : compose ? '已打开 X 发帖页，请核对账号和正文后发布。' : '已打开该账号的本机 Chrome 窗口。';
  const directory = join(root, workspace, profile);
  const version = createHash('sha256').update(JSON.stringify({ proxy, width, height })).digest('hex');
  const active = starting.get(directory);
  if (active) await active.catch(() => undefined);
  if (starting.has(directory)) throw new LaunchError('该窗口正在启动，请稍后重试。');

  const running = sessions.get(directory);
  if (running?.version === version) {
    await running.chrome.show(draftText, messages);
    return opened;
  }
  const start = (async () => {
    const upstream = await publicProxy(proxy);
    if (closing) throw new LaunchError('启动器已关闭，请重新打开工作台。');
    if (running) await running.chrome.close();
    const chrome = await openMacChrome(directory, { width, height }, upstream, draftText, messages);
    const heartbeat = reportPresence(presenceToken);
    const closed = chrome.closed.then(async () => {
      if (sessions.get(directory) === session) sessions.delete(directory);
      await heartbeat.stop();
    });
    const session = { version, chrome, closed };
    sessions.set(directory, session);
    await heartbeat.ready;
    return opened;
  })();
  starting.set(directory, start);
  try {
    return await start;
  } finally {
    starting.delete(directory);
  }
}

async function onMessage(raw: Buffer) {
  let message: { id?: unknown; type?: unknown; ticket?: unknown };
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object') return;
    message = value;
  } catch { return; }
  const { id, type, ticket } = message;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return;
  if ((type !== 'open' && type !== 'open-composer' && type !== 'open-messages') || typeof ticket !== 'string' || !ticketPattern.test(ticket)) {
    send({ id, success: false, message: '无法识别启动请求。' });
    return;
  }
  try {
    send({ id, success: true, message: await launch(ticket, type) });
  } catch (error) {
    const failure = error instanceof LaunchError || error instanceof InputError
      ? error.message : '无法打开本机 Chrome。请检查 Chrome 安装状态，或退出之前的独立窗口后重试。';
    send({ id, success: false, message: failure });
  }
}

async function shutdown() {
  if (closing) return;
  closing = true;
  process.stdin.pause();
  await Promise.allSettled(starting.values());
  await Promise.allSettled([...sessions.values()].map(async (session) => {
    await session.chrome.close();
    await session.closed;
  }));
  process.exit(0);
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE();
    if (size < 1 || size > maxMessageSize) {
      void shutdown();
      return;
    }
    if (buffer.length < size + 4) return;
    void onMessage(buffer.subarray(4, size + 4));
    buffer = buffer.subarray(size + 4);
  }
});
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.stdout.on('error', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
