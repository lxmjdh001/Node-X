import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { get } from 'node:https';
import { createConnection, createServer, isIP, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { domainToASCII } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';
import { Server as ProxyServer } from 'proxy-chain';
import { SocksProxyAgent } from 'socks-proxy-agent';

export type ProxySettings = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export type BrowserSettings = {
  id: string;
  locale: string;
  timezone: string;
  width: number;
  height: number;
  proxy: ProxySettings;
};

type BrowserSession = {
  context: BrowserContext;
  bridge: BrowserProxy;
  version: string;
};

type BrowserProxy = { port: number; close: () => Promise<void> };

const IP_CHECK_URL = 'https://api.ipify.org?format=json';
const PROXY_TIMEOUT_MS = 15_000;
const MAX_CHECK_BYTES = 4096;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const sessions = new Map<string, BrowserSession>();
const operations = new Map<string, Promise<unknown>>();
let chromiumVersionCache: { signature: string; version: string } | undefined;
let chromiumVersionProbe: { signature: string; result: Promise<string | null> } | undefined;
let shuttingDown = false;

/** Reports the installed executable's own version without launching a browsing session or using the network. */
export async function chromiumInfo(): Promise<{ installed: boolean; version: string | null }> {
  const executable = chromium.executablePath();
  let signature: string;
  try {
    const [metadata] = await Promise.all([stat(executable), access(executable, constants.X_OK)]);
    if (!metadata.isFile()) return { installed: false, version: null };
    signature = `${executable}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
  } catch {
    // Recheck the filesystem on each request so installing a missing browser is visible immediately.
    return { installed: false, version: null };
  }
  if (chromiumVersionCache?.signature === signature) {
    return { installed: true, version: chromiumVersionCache.version };
  }
  // --version exits directly on macOS/Linux. Avoid invoking it on platforms where it may open a window.
  if (process.platform !== 'darwin' && process.platform !== 'linux') return { installed: true, version: null };
  if (chromiumVersionProbe?.signature !== signature) {
    const result = new Promise<string | null>((fulfill) => {
      execFile(executable, ['--version'], {
        timeout: 3000,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
      }, (error, stdout) => {
        if (error) { fulfill(null); return; }
        const match = stdout.trim().match(/^(?:Chromium|Google Chrome(?: for Testing)?)\s+(\d+\.\d+\.\d+\.\d+)(?:\s|$)/);
        fulfill(match?.[1] ?? null);
      });
    });
    chromiumVersionProbe = { signature, result };
  }
  const probe = chromiumVersionProbe;
  const version = await probe.result;
  if (version) chromiumVersionCache = { signature, version };
  if (chromiumVersionProbe === probe) chromiumVersionProbe = undefined;
  return { installed: true, version };
}

function validateId(id: string): void {
  if (!UUID_PATTERN.test(id)) throw new Error('账号环境 ID 必须是 UUID。');
}

function proxyUrl(proxy: ProxySettings): string {
  if (!proxy || typeof proxy.host !== 'string') throw new Error('请填写 SOCKS5 代理地址。');
  let host = proxy.host.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!isIP(host)) {
    host = domainToASCII(host);
    if (!host || host.length > 253 || !host.split('.').every((label) =>
      /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
      throw new Error('代理地址只填写 IP 或主机名，不包含协议、路径和端口。');
    }
  }
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
    throw new Error('代理端口必须是 1–65535 的整数。');
  }
  if (typeof proxy.username !== 'string' || typeof proxy.password !== 'string') {
    throw new Error('代理用户名和密码必须是文本。');
  }
  if (Boolean(proxy.username) !== Boolean(proxy.password)) {
    throw new Error('SOCKS5 用户名和密码需一起填写，或一起留空。');
  }
  if (Buffer.byteLength(proxy.username) > 255 || Buffer.byteLength(proxy.password) > 255) {
    throw new Error('SOCKS5 用户名和密码分别不能超过 255 字节。');
  }
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : '';
  return `socks5h://${auth}${isIP(host) === 6 ? `[${host}]` : host}:${proxy.port}`;
}

function validateProfile(profile: BrowserSettings): void {
  validateId(profile.id);
  if (!Number.isInteger(profile.width) || profile.width < 320 || profile.width > 7680 ||
      !Number.isInteger(profile.height) || profile.height < 320 || profile.height > 4320) {
    throw new Error('浏览器宽度需为 320–7680，高度需为 320–4320 的整数。');
  }
  try {
    if (!profile.locale || Intl.getCanonicalLocales(profile.locale).length !== 1) throw new Error();
    if (!profile.timezone) throw new Error();
    new Intl.DateTimeFormat(profile.locale, { timeZone: profile.timezone }).format();
  } catch {
    throw new Error('浏览器语言或时区无效。');
  }
  proxyUrl(profile.proxy);
}

function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = operations.get(id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  operations.set(id, current);
  void current.finally(() => {
    if (operations.get(id) === current) operations.delete(id);
  }).catch(() => undefined);
  return current;
}

async function createBridge(proxy: ProxySettings, username: string, password: string): Promise<BrowserProxy> {
  let upstream = proxyUrl(proxy);
  let closeRelay: (() => Promise<void>) | undefined;
  const rawHost = new URL(upstream).hostname.replace(/^\[|\]$/g, '');
  // proxy-chain currently passes IPv6 URL brackets to net.connect(). A loopback TCP relay
  // preserves the SOCKS protocol and authentication while giving it an IPv4 upstream address.
  if (isIP(rawHost) === 6) {
    const sockets = new Set<Socket>();
    const relay = createServer((incoming) => {
      const outgoing = createConnection({ host: rawHost, port: proxy.port });
      sockets.add(incoming);
      sockets.add(outgoing);
      incoming.on('close', () => { sockets.delete(incoming); outgoing.destroy(); });
      outgoing.on('close', () => { sockets.delete(outgoing); incoming.destroy(); });
      incoming.on('error', () => outgoing.destroy());
      outgoing.on('error', () => incoming.destroy());
      outgoing.setTimeout(PROXY_TIMEOUT_MS, () => outgoing.destroy());
      outgoing.once('connect', () => outgoing.setTimeout(0));
      incoming.pipe(outgoing).pipe(incoming);
    });
    await new Promise<void>((fulfill, reject) => {
      relay.once('error', reject);
      relay.listen(0, '127.0.0.1', () => { relay.removeListener('error', reject); fulfill(); });
    });
    closeRelay = () => new Promise<void>((fulfill) => {
      for (const socket of sockets) socket.destroy();
      relay.close(() => fulfill());
    });
    const address = relay.address();
    if (!address || typeof address === 'string') {
      await closeRelay();
      throw new Error('无法创建本地代理连接。');
    }
    upstream = proxyUrl({ ...proxy, host: '127.0.0.1', port: address.port });
  }
  const server = new ProxyServer({
    host: '127.0.0.1',
    port: 0,
    verbose: false,
    prepareRequestFunction: (credentials) => ({
      requestAuthentication: credentials.username !== username || credentials.password !== password,
      upstreamProxyUrl: upstream,
    }),
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await server.close(true).catch(() => undefined);
    await closeRelay?.();
  })();
  try {
    await server.listen();
    return { port: server.port, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Checks one fixed HTTPS endpoint through SOCKS5; never follows redirects or falls back to direct access. */
export async function checkProxy(proxy: ProxySettings): Promise<{ ip: string; latency: number }> {
  const upstream = proxyUrl(proxy);
  const agent = new SocksProxyAgent(upstream, { timeout: PROXY_TIMEOUT_MS, keepAlive: false });
  // URL.hostname contains brackets for IPv6 literals; the SOCKS client needs the raw address.
  if (agent.proxy.host?.startsWith('[')) agent.proxy.host = agent.proxy.host.slice(1, -1);
  const started = performance.now();
  try {
    const ip = await new Promise<string>((fulfill, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else fulfill(value!);
      };
      const request = get(IP_CHECK_URL, {
        agent,
        headers: { Accept: 'application/json', 'User-Agent': 'NodeX-ProxyCheck/1.0' },
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(new Error('出口 IP 检测服务响应异常，请稍后重试。'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_CHECK_BYTES) {
            finish(new Error('出口 IP 检测响应超出限制。'));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          try {
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const value = result && typeof result === 'object' && 'ip' in result ? result.ip : null;
            if (typeof value !== 'string' || !isIP(value)) throw new Error();
            finish(undefined, value);
          } catch {
            finish(new Error('出口 IP 检测返回了无效结果。'));
          }
        });
        response.on('error', () => finish(new Error('SOCKS5 检测连接中断。')));
        response.on('aborted', () => finish(new Error('SOCKS5 检测连接中断。')));
      });
      const timer = setTimeout(() => {
        finish(new Error('SOCKS5 检测超时，请检查代理是否可用。'));
        request.destroy();
      }, PROXY_TIMEOUT_MS);
      request.on('error', (error) => {
        const authenticationError = /authentication|auth failed|credentials|username|password/i.test(error.message);
        finish(new Error(authenticationError
          ? 'SOCKS5 认证失败，请检查用户名和密码。'
          : 'SOCKS5 代理连接失败，请检查地址、端口及网络；未改用直连。'));
      });
    });
    return { ip, latency: Math.max(1, Math.round(performance.now() - started)) };
  } finally {
    agent.destroy();
  }
}

async function closeSession(id: string, session: BrowserSession): Promise<void> {
  try {
    await session.context.close();
  } finally {
    await session.bridge.close().catch(() => undefined);
    if (sessions.get(id) === session) sessions.delete(id);
  }
}

/** Opens an ordinary Chromium window for manual use. The actual engine supplies its own UA/version. */
export async function startBrowser(profile: BrowserSettings): Promise<{ version: string }> {
  profile = { ...profile, proxy: { ...profile.proxy } };
  validateProfile(profile);
  if (shuttingDown) throw new Error('服务正在关闭，请稍后重试。');
  return serial(profile.id, async () => {
    if (shuttingDown) throw new Error('服务正在关闭，请稍后重试。');
    const existing = sessions.get(profile.id);
    if (existing) {
      await existing.context.pages()[0]?.bringToFront().catch(() => undefined);
      return { version: existing.version };
    }
    // Validate availability before opening a window. The bridge below always uses this upstream.
    await checkProxy(profile.proxy);
    if (shuttingDown) throw new Error('服务正在关闭，请稍后重试。');
    const username = randomBytes(24).toString('hex');
    const password = randomBytes(24).toString('hex');
    let bridge: BrowserProxy | undefined;
    let context: BrowserContext | undefined;
    try {
      bridge = await createBridge(profile.proxy, username, password);
      const directory = resolve(process.env.NODEX_DATA_DIR || './data', 'profiles', profile.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      context = await chromium.launchPersistentContext(directory, {
        headless: false,
        viewport: { width: profile.width, height: profile.height },
        locale: profile.locale,
        timezoneId: profile.timezone,
        proxy: {
          server: `http://127.0.0.1:${bridge.port}`,
          username,
          password,
          bypass: '<-loopback>',
        },
        // HTTP(S)/WebSocket traffic uses the authenticated bridge. Prevent direct UDP transports.
        args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        timeout: 30_000,
      });
      const version = context.browser()?.version();
      if (!version) throw new Error('无法读取实际浏览器版本。');
      const session: BrowserSession = { context, bridge, version };
      sessions.set(profile.id, session);
      context.once('close', () => {
        if (sessions.get(profile.id) === session) sessions.delete(profile.id);
        void session.bridge.close().catch(() => undefined);
      });
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto('https://x.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.bringToFront();
      return { version };
    } catch (error) {
      await context?.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      sessions.delete(profile.id);
      if (error instanceof Error && /Executable doesn't exist|browserType\.launchPersistentContext.*executable/i.test(error.message)) {
        throw new Error('尚未安装 Chromium。请在项目目录运行 npx playwright install chromium。');
      }
      if (error instanceof Error && /goto|net::|navigation|Timeout 45000/i.test(error.message)) {
        throw new Error('浏览器未能通过代理打开 X，请检查代理和网站连接后重试。');
      }
      throw new Error('浏览器启动失败，请检查 Chromium 安装和本机桌面环境，或确认该环境未被其他进程打开。');
    }
  });
}

export async function stopBrowser(id: string): Promise<void> {
  validateId(id);
  await serial(id, async () => {
    const session = sessions.get(id);
    if (session) await closeSession(id, session);
  });
}

export function browserVersion(id: string): string | null {
  return sessions.get(id)?.version ?? null;
}

export async function shutdownBrowsers(): Promise<void> {
  shuttingDown = true;
  const ids = new Set([...sessions.keys(), ...operations.keys()]);
  await Promise.allSettled([...ids].map((id) => stopBrowser(id)));
}
