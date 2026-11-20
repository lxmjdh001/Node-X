import { createConnection, createServer, isIP, type Socket } from 'node:net';
import { domainToASCII } from 'node:url';
import { RequestError, Server as ProxyServer } from 'proxy-chain';
import { allowedBrowserTarget } from './public-proxy.js';

export type ProxySettings = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export type BrowserProxy = { port: number; close: () => Promise<void> };
export const PROXY_TIMEOUT_MS = 15_000;

export function proxyUrl(proxy: ProxySettings): string {
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

export async function createBridge(
  proxy: ProxySettings,
  credentials: { username: string; password: string } | null,
  restricted: boolean,
): Promise<BrowserProxy> {
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
      if (credentials && (request.username !== credentials.username || request.password !== credentials.password)) {
        return { requestAuthentication: true };
      }
      if ((!credentials && request.request.method !== 'CONNECT') ||
          (restricted && !allowedBrowserTarget(request.hostname, request.port))) {
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
