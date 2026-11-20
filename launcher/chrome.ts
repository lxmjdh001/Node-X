import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createBridge, type ProxySettings } from '../server/browser-proxy.js';
import { xComposeUrl } from '../src/x-compose.js';

const MAC_CHROME_APP = '/Applications/Google Chrome.app';
export const MAC_CHROME = `${MAC_CHROME_APP}/Contents/MacOS/Google Chrome`;
const X_URL = 'https://x.com/';
const X_CHAT_URL = 'https://x.com/i/chat';
const X_LOGIN_URL = 'https://x.com/i/flow/login';
const run = promisify(execFile);

async function chromePid(directory: string): Promise<number | undefined> {
  const { stdout } = await run('/bin/ps', ['-U', String(process.getuid!()), '-ww', '-o', 'pid=,args='],
    { timeout: 2500, maxBuffer: 2 * 1024 * 1024 });
  const profileArg = ` --user-data-dir=${directory} --no-first-run `;
  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trimStart());
    if (match?.[2].startsWith(MAC_CHROME + ' ') && match[2].includes(profileArg)) return Number(match[1]);
  }
}

export async function openMacChrome(directory: string, size: { width: number; height: number }, proxy: ProxySettings, draftText?: string, messages = false) {
  if (process.platform !== 'darwin') throw new Error('当前启动器适用于 macOS。');
  await access(MAC_CHROME, constants.X_OK).catch(() => { throw new Error('请先在此 Mac 安装 Google Chrome。'); });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'nodex-launcher.lock');
  await run('/usr/bin/shlock', ['-p', String(process.pid), '-f', lock]).catch(() => {
    throw new Error('此窗口已由另一个启动器打开，请退出该窗口后重试。');
  });
  let locked = true;
  const unlock = async () => {
    if (!locked) return;
    locked = false;
    await unlink(lock).catch(() => undefined);
  };
  try {
    if (await chromePid(directory)) throw new Error('请先退出之前打开的独立 Chrome 窗口。');
    const hasProfile = await access(join(directory, 'Default', 'Preferences')).then(() => true, () => false);
    const bridge = await createBridge(proxy, null, false);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: userInfo().homedir };
    delete env.CFFIXED_USER_HOME;
    const openArgs = [
      '-n', '-a', MAC_CHROME_APP, '--env', `HOME=${env.HOME}`, '--args',
      `--user-data-dir=${directory}`,
      '--no-first-run', '--no-default-browser-check', '--new-window',
      `--window-size=${size.width},${size.height}`,
      `--proxy-server=http://127.0.0.1:${bridge.port}`, '--proxy-bypass-list=<-loopback>',
      '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ];
    const target = messages ? X_CHAT_URL : draftText ? xComposeUrl(draftText) : hasProfile ? X_URL : X_LOGIN_URL;
    const child = spawn('/usr/bin/open', ['-W', ...openArgs, target], { stdio: 'ignore', env });
    let stopped = false;
    const closed = new Promise<void>((done) => child.once('close', () => {
      stopped = true;
      done();
    })).then(async () => { await bridge.close().catch(() => undefined); await unlock(); });
    try {
      await once(child, 'spawn');
      const deadline = Date.now() + 6000;
      while (!stopped && Date.now() < deadline) {
        const pid = await chromePid(directory);
        if (pid && !stopped) {
          return {
            closed,
            show: async (nextDraft?: string, nextMessages = false) => {
              if (stopped || pid !== await chromePid(directory)) throw new Error('Chrome 已关闭，请重试。');
              await run('/usr/bin/open', [...openArgs, nextMessages ? X_CHAT_URL : nextDraft ? xComposeUrl(nextDraft) : X_URL], { env, timeout: 4000 });
            },
            close: async () => {
              if (!stopped && pid === await chromePid(directory)) {
                try { process.kill(pid, 'SIGTERM'); } catch { /* Chrome exited before the signal. */ }
              }
              await closed;
            },
          };
        }
        await delay(150);
      }
      throw new Error('Chrome 未打开独立窗口。请退出之前的窗口后重试。');
    } catch (error) {
      child.kill('SIGTERM');
      await closed;
      throw error;
    }
  } catch (error) {
    await unlock();
    throw error;
  }
}
