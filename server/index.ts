import './env.js';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { ZodError } from 'zod';
import { auth, operatorAuth, requireAuth } from './auth.js';
import { shutdownBrowsers } from './browser.js';
import { camoufox } from './camoufox-routes.js';
import { ContentError } from './content.js';
import { editor } from './editor.js';
import { InputError } from './errors.js';
import { imports } from './imports.js';
import { recoverPublishQueue, runPublishQueue, waitForPublisher } from './publisher.js';
import { closeDatabases, isCustomerWorkspace } from './store.js';
import { workspace } from './workspace.js';

function readPort(value: string | number, name: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} 必须是 1–65535 之间的整数。`);
  return port;
}

function publicOrigin(name: string) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} 必须是完整的 HTTPS 来源，不含路径、查询参数或凭据。`);
  }
  return url;
}

const port = readPort(process.env.PORT || 4173, 'PORT');
const operatorPort = readPort(process.env.NODEX_OPERATOR_PORT || port + 1, 'NODEX_OPERATOR_PORT');
if (port === operatorPort) throw new Error('工作台和生成页必须使用不同端口。');
const external = publicOrigin('NODEX_PUBLIC_ORIGIN');
const operatorExternal = publicOrigin('NODEX_OPERATOR_PUBLIC_ORIGIN');
if (external) process.env.NODEX_PUBLIC_HTTPS = '1';
const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const operatorAccessPort = readPort(process.env.NODEX_OPERATOR_ACCESS_PORT || operatorPort, 'NODEX_OPERATOR_ACCESS_PORT');
const operatorHost = `127.0.0.1:${operatorPort}`;
const operatorHosts = new Set([operatorHost, `127.0.0.1:${operatorAccessPort}`]);
const dev = process.argv.includes('--dev');

const app = express();
const operatorApp = express();
app.disable('x-powered-by');
operatorApp.disable('x-powered-by');
// Only the same-host reverse proxy may supply the effective public protocol or client IP.
app.set('trust proxy', 'loopback');
operatorApp.set('trust proxy', 'loopback');
const server = createServer(app);
const operatorServer = createServer(operatorApp);

const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'");
  next();
};

app.use(securityHeaders, (req, res, next) => {
  const host = req.headers.host || '';
  const valid = external ? host === external.host && req.secure : localHosts.has(host);
  if (!valid) {
    res.status(403).json({ error: '此工作台只能通过配置的地址访问。' });
    return;
  }
  next();
});
app.get('/healthz', (_req, res) => { res.set('Cache-Control', 'no-store').json({ ok: true }); });
app.use('/operator', (_req, res) => { res.sendStatus(404); });

function sameOrigin(expected: (host: string) => string, allowOAuth = false): RequestHandler {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const callback = allowOAuth && req.method === 'GET' && req.path === '/x/callback';
    if (!callback && (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== expected(req.headers.host || '')))) {
      res.status(403).json({ error: '请求必须来自当前工作台。' });
      return;
    }
    const writesBody = req.method === 'POST' || req.method === 'PATCH';
    if (writesBody && (req.headers['content-length'] !== undefined || req.headers['transfer-encoding']) &&
        req.headers['content-length'] !== '0' && !req.is('application/json')) {
      res.status(415).json({ error: '请求正文必须为 JSON。' });
      return;
    }
    next();
  };
}

app.use('/api', sameOrigin((host) => external?.origin || `http://${host}`, true));
app.use('/api/auth', express.json({ limit: '8kb' }));
app.use('/api', auth);
app.use('/api', requireAuth);
// Customer sessions may manage records in their own database. Shared execution
// services (browser, network checks, model and X credentials) remain owner-only.
const customerRoutes: Partial<Record<string, RegExp>> = {
  GET: /^\/workspace\/?$/i,
  POST: /^\/(?:accounts|proxies|profiles|drafts|import\/(?:preview|commit))\/?$/i,
  PATCH: /^\/(?:accounts|proxies|profiles|drafts)\/[^/]+\/?$/i,
  DELETE: /^\/(?:accounts|proxies|profiles|drafts)\/[^/]+\/?$/i,
};
app.use('/api', (req, _res, next) => {
  if (isCustomerWorkspace() && !customerRoutes[req.method]?.test(req.path)) {
    throw new InputError('此功能需要独立执行节点，当前客户空间暂未开放。', 403);
  }
  next();
});
app.use('/api/import', express.json({ limit: '1200kb' }), imports);
app.use('/api/camoufox', express.json({ limit: '32kb' }), camoufox);
app.use('/api', express.json({ limit: '32kb' }), workspace, editor, (_req, res) => {
  res.status(404).json({ error: '找不到这个接口。' });
});

operatorApp.use(securityHeaders, (req, res, next) => {
  const host = req.headers.host || '';
  if (!operatorHosts.has(host) && !(operatorExternal && host === operatorExternal.host && req.secure)) {
    res.sendStatus(404);
    return;
  }
  next();
});
operatorApp.get('/healthz', (_req, res) => { res.set('Cache-Control', 'no-store').json({ ok: true }); });
operatorApp.use((req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  const brands = req.headers['sec-ch-ua'];
  const desktopChrome = /Macintosh/.test(ua) && /\bChrome\/\d/.test(ua) &&
    !/\b(Edg|OPR|Vivaldi|Brave)\//.test(ua) && (typeof brands !== 'string' || brands.includes('"Google Chrome"'));
  if (!desktopChrome) {
    res.status(403).type('text/plain; charset=utf-8').send('请在已登记的 Mac Chrome 浏览器中打开登录码生成页。');
    return;
  }
  res.set('Cache-Control', 'no-store');
  next();
});
operatorApp.use('/operator/api', sameOrigin((host) => host === operatorExternal?.host ? operatorExternal.origin : `http://${host}`), express.json({ limit: '8kb' }));
operatorApp.use(operatorAuth);
operatorApp.use('/operator/api', (_req, res) => { res.status(404).json({ error: '找不到这个接口。' }); });
operatorApp.use('/api', (_req, res) => { res.sendStatus(404); });

const apiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof InputError) {
    res.status(error.status).json({ error: error.message });
  } else if (error instanceof ContentError) {
    res.status(error.statusCode).json({ error: error.message });
  } else if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues[0]?.message || '请检查输入。' });
  } else if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON 请求正文无效。' });
  } else if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: '请求正文超出大小限制。' });
  } else if (String(error?.message).startsWith('UNIQUE constraint failed')) {
    res.status(409).json({ error: '这条记录已存在，请检查账号或环境是否重复。' });
  } else {
    console.error('本地请求失败：', error instanceof Error ? error.name : 'Error');
    res.status(500).json({ error: '操作未能完成。请检查本地服务和数据目录权限。' });
  }
};
app.use('/api', apiError);
operatorApp.use(apiError);

let closePreview: (() => Promise<void>) | undefined;
if (dev) {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({
    server: { middlewareMode: true, hmr: { server } },
  });
  app.use(vite.middlewares);
  operatorApp.use(vite.middlewares);
  closePreview = () => vite.close();
} else {
  const dist = resolve('dist');
  const index = resolve(dist, 'index.html');
  if (!existsSync(index)) throw new Error('请先运行 npm run build。');
  app.use(express.static(dist));
  app.get('/', (_req, res) => res.sendFile(index));
  operatorApp.use('/assets', express.static(resolve(dist, 'assets')));
  operatorApp.get('/operator', (_req, res) => res.sendFile(index));
}

let queue: ReturnType<typeof setInterval>;
await Promise.all([
  new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  }),
  new Promise<void>((done, reject) => {
    operatorServer.once('error', reject);
    operatorServer.listen(operatorPort, '127.0.0.1', done);
  }),
]);
recoverPublishQueue();
runPublishQueue();
queue = setInterval(runPublishQueue, 2000);
console.log(`Node X 工作台 ${external?.origin || `http://127.0.0.1:${port}`}`);
console.log(`Node X 登录码管理 ${operatorExternal?.origin || `http://${operatorHost}`}/operator`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(queue);
  const drained = [server, operatorServer].map((service) => new Promise<void>((done) => service.close(() => done())));
  const watchdog = setTimeout(() => process.exit(1), 15_000);
  watchdog.unref();
  await Promise.allSettled([closePreview?.(), shutdownBrowsers(), ...drained]);
  await waitForPublisher();
  closeDatabases();
  clearTimeout(watchdog);
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
