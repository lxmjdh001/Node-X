import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { get } from 'node:https';
import { createConnection, createServer, isIP, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { domainToASCII } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { RequestError, Server as ProxyServer } from 'proxy-chain';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { workspaceAuthorized } from './auth.js';
import { InputError } from './errors.js';
import { allowedBrowserTarget, publicProxy } from './public-proxy.js';
import { workspaceDirectory, workspaceId } from './store.js';

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
  deviceScaleFactor: number;
  colorScheme: 'light' | 'dark';
  reducedMotion: 'no-preference' | 'reduce';
  proxy: ProxySettings;
};

type BrowserSession = {
  context: BrowserContext;
  bridge: BrowserProxy;
  version: string;
  workspaceId: string | undefined;
  remote: boolean;
  lastUse: number;
  frame?: Promise<Buffer>;
  inputPending: boolean;
};

type BrowserProxy = { port: number; close: () => Promise<void> };

const IP_CHECK_URL = 'https://api.ipify.org?format=json';
const X_LOGIN_URL = 'https://x.com/i/flow/login';
const X_HOME_URL = 'https://x.com/home';
const PROXY_TIMEOUT_MS = 15_000;
const MAX_CHECK_BYTES = 4096;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const sessions = new Map<string, BrowserSession>();
const operations = new Map<string, Promise<unknown>>();
const remoteStarting = new Set<string>();
const REMOTE_BROWSER_LIMIT = 8;
const REMOTE_IDLE_MS = 15 * 60 * 1000;
let chromiumVersionCache: { signature: string; version: string } | undefined;
let chromiumVersionProbe: { signature: string; result: Promise<string | null> } | undefined;
let shuttingDown = false;

function sessionKey(id: string): string {
  return `${workspaceId() ?? 'owner'}:${id}`;
}

export function remoteBrowser(): boolean {
  return workspaceId() !== undefined || Boolean(process.env.NODEX_PUBLIC_ORIGIN) || process.env.NODEX_REMOTE_BROWSER === '1';
}

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

async function createBridge(proxy: ProxySettings, username: string, password: string, remote: boolean): Promise<BrowserProxy> {
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
    prepareRequestFunction: (request) => {
      if (request.username !== username || request.password !== password) return { requestAuthentication: true };
      if (remote && !allowedBrowserTarget(request.hostname, request.port)) {
        throw new RequestError('Browser destinations are limited to X and its sign-in services.', 403);
      }
      return { upstreamProxyUrl: upstream };
    },
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
  const key = sessionKey(profile.id);
  const customerId = workspaceId();
  const directory = resolve(workspaceDirectory(), 'profiles', profile.id);
  const remote = remoteBrowser();
  return serial(key, async () => {
    if (shuttingDown) throw new Error('服务正在关闭，请稍后重试。');
    const existing = sessions.get(key);
    if (existing) {
      await existing.context.pages()[0]?.bringToFront().catch(() => undefined);
      return { version: existing.version };
    }
    if (remote && remoteStarting.size + [...sessions.values()].filter((item) => item.remote).length >= REMOTE_BROWSER_LIMIT) {
      throw new InputError('在线浏览器目前已满，请关闭不用的环境或稍后重试。', 503);
    }
    if (remote) remoteStarting.add(key);
    const username = randomBytes(24).toString('hex');
    const password = randomBytes(24).toString('hex');
    let bridge: BrowserProxy | undefined;
    let context: BrowserContext | undefined;
    try {
      const proxy = remote ? await publicProxy(profile.proxy) : profile.proxy;
      if (shuttingDown || !workspaceAuthorized(customerId)) throw new InputError('当前授权无法启动浏览器。', 403);
      bridge = await createBridge(proxy, username, password, remote);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      context = await chromium.launchPersistentContext(directory, {
        headless: remote,
        ...(remote ? {
          channel: 'chromium',
          chromiumSandbox: true,
          acceptDownloads: false,
          env: { HOME: directory, PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR },
        } : {}),
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: profile.deviceScaleFactor,
        colorScheme: profile.colorScheme,
        reducedMotion: profile.reducedMotion,
        locale: profile.locale,
        timezoneId: profile.timezone,
        proxy: {
          server: `http://127.0.0.1:${bridge.port}`,
          username,
          password,
          bypass: '<-loopback>',
        },
        // HTTP(S)/WebSocket traffic uses the authenticated bridge. Prevent direct UDP transports.
        args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          ...(remote ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] : [])],
        timeout: 30_000,
      });
      const version = context.browser()?.version();
      if (!version) throw new Error('无法读取实际浏览器版本。');
      const sessionCookies = await context.cookies(X_HOME_URL);
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(sessionCookies.some(({ name, value }) => name === 'auth_token' && value) ? X_HOME_URL : X_LOGIN_URL,
        { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (!workspaceAuthorized(customerId)) throw new InputError('当前授权无法启动浏览器。', 403);
      const session: BrowserSession = { context, bridge, version, workspaceId: customerId, remote, lastUse: Date.now(), inputPending: false };
      sessions.set(key, session);
      remoteStarting.delete(key);
      context.once('close', () => {
        if (sessions.get(key) === session) sessions.delete(key);
        void session.bridge.close().catch(() => undefined);
      });
      await page.bringToFront();
      return { version };
    } catch (error) {
      await context?.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      sessions.delete(key);
      if (error instanceof InputError) throw error;
      if (error instanceof Error && /Executable doesn't exist|browserType\.launchPersistentContext.*executable/i.test(error.message)) {
        throw new Error('尚未安装 Chromium。请在项目目录运行 npx playwright install chromium。');
      }
      if (error instanceof Error && /SOCKS5|出口 IP/.test(error.message)) throw error;
      if (error instanceof Error && /goto|net::|navigation|Timeout 45000/i.test(error.message)) {
        throw new Error('浏览器未能通过代理打开 X，请检查代理和网站连接后重试。');
      }
      throw new Error(remote ? '在线浏览器启动失败，请联系管理员检查 Chromium 和服务器沙盒。'
        : '浏览器启动失败，请检查 Chromium 安装和本机桌面环境，或确认该环境未被其他进程打开。');
    } finally {
      remoteStarting.delete(key);
    }
  });
}

export async function stopBrowser(id: string): Promise<void> {
  validateId(id);
  await stopSession(sessionKey(id));
}

async function stopSession(key: string): Promise<void> {
  await serial(key, async () => {
    const session = sessions.get(key);
    if (session) await closeSession(key, session);
  });
}

export function browserVersion(id: string): string | null {
  return sessions.get(sessionKey(id))?.version ?? null;
}

function viewingSession(id: string): { session: BrowserSession; page: Page } {
  const session = sessions.get(sessionKey(id));
  const page = session?.context.pages().at(-1);
  if (!session?.remote || !page || !workspaceAuthorized(session.workspaceId)) {
    throw new InputError('此在线浏览器已关闭，请重新打开。', 409);
  }
  session.lastUse = Date.now();
  return { session, page };
}

export function browserFrame(id: string): Promise<Buffer> {
  const { session, page } = viewingSession(id);
  session.frame ??= page.screenshot({ type: 'jpeg', quality: 55, scale: 'css', timeout: 5000 })
    .catch(() => { throw new InputError('暂时无法获取浏览器画面，请重试。', 503); })
    .finally(() => { session.frame = undefined; });
  return session.frame;
}

export type BrowserInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; delta: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'back' | 'reload' | 'home' | 'login' };

export async function sendBrowserInput(id: string, input: BrowserInput): Promise<void> {
  const { session, page } = viewingSession(id);
  if (session.inputPending) throw new InputError('上一项浏览器操作尚未完成。', 409);
  session.inputPending = true;
  try {
    if (input.type === 'click' || input.type === 'scroll') {
      const viewport = page.viewportSize()!;
      const x = Math.min(viewport.width - 1, input.x * viewport.width);
      const y = Math.min(viewport.height - 1, input.y * viewport.height);
      if (input.type === 'click') await page.mouse.click(x, y);
      else {
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, input.delta);
      }
    } else if (input.type === 'text') await page.keyboard.insertText(input.text);
    else if (input.type === 'key') await page.keyboard.press(input.key);
    else {
      const options = { waitUntil: 'domcontentloaded' as const, timeout: 15_000 };
      if (input.type === 'back') await page.goBack(options);
      if (input.type === 'reload') await page.reload(options);
      if (input.type === 'home') await page.goto(X_HOME_URL, options);
      if (input.type === 'login') await page.goto(X_LOGIN_URL, options);
    }
  } catch {
    throw new InputError('浏览器未完成此操作，请重试。', 502);
  } finally {
    session.inputPending = false;
  }
}

export function reapBrowsers() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.remote && !operations.has(key) &&
        (now - session.lastUse >= REMOTE_IDLE_MS || !workspaceAuthorized(session.workspaceId))) {
      void stopSession(key).catch(() => undefined);
    }
  }
}

export async function shutdownBrowsers(): Promise<void> {
  shuttingDown = true;
  const ids = new Set([...sessions.keys(), ...operations.keys()]);
  await Promise.allSettled([...ids].map(stopSession));
}
