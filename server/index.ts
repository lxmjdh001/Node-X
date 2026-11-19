import './env.js';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { shutdownBrowsers } from './browser.js';
import { camoufox } from './camoufox-routes.js';
import { ContentError } from './content.js';
import { editor } from './editor.js';
import { InputError } from './errors.js';
import { imports } from './imports.js';
import { recoverPublishQueue, runPublishQueue, waitForPublisher } from './publisher.js';
import { db } from './store.js';
import { workspace } from './workspace.js';

const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const dev = process.argv.includes('--dev');
const app = express();
app.disable('x-powered-by');
const server = createServer(app);

app.use((req, res, next) => {
  if (!hosts.has(req.headers.host || '')) {
    res.status(403).json({ error: '只允许通过本机地址访问。' });
    return;
  }
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const origin = req.headers.origin;
  const callback = req.method === 'GET' && req.path === '/x/callback';
  if (!callback && (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== `http://${req.headers.host}`))) {
    res.status(403).json({ error: '请求必须来自本地工作台。' });
    return;
  }
  const writesBody = req.method === 'POST' || req.method === 'PATCH';
  if (writesBody && (req.headers['content-length'] !== undefined || req.headers['transfer-encoding']) &&
      req.headers['content-length'] !== '0' && !req.is('application/json')) {
    res.status(415).json({ error: '请求正文必须为 JSON。' });
    return;
  }
  next();
});
app.use('/api/import', express.json({ limit: '1200kb' }), imports);
app.use('/api/camoufox', express.json({ limit: '32kb' }), camoufox);
app.use('/api', express.json({ limit: '32kb' }), workspace, editor, (_req, res) => {
  res.status(404).json({ error: '找不到这个接口。' });
});

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

let closePreview: (() => Promise<void>) | undefined;
if (dev) {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({
    server: { middlewareMode: true, hmr: { server } },
  });
  app.use(vite.middlewares);
  closePreview = () => vite.close();
} else {
  const dist = resolve('dist');
  if (!existsSync(resolve(dist, 'index.html'))) throw new Error('请先运行 npm run build。');
  app.use(express.static(dist));
  app.get('/', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

let queue: ReturnType<typeof setInterval>;
server.listen(port, '127.0.0.1', () => {
  recoverPublishQueue();
  runPublishQueue();
  queue = setInterval(runPublishQueue, 2000);
  console.log(`Node X 本地工作台 http://127.0.0.1:${port}`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(queue);
  const drained = new Promise<void>((done) => server.close(() => done()));
  const watchdog = setTimeout(() => process.exit(1), 15_000);
  watchdog.unref();
  await Promise.allSettled([closePreview?.(), shutdownBrowsers(), drained]);
  await waitForPublisher();
  db.close();
  clearTimeout(watchdog);
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
