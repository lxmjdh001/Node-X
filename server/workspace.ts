import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { browserFrame, browserVersion, checkProxy, chromiumInfo, macChromeLauncher, remoteBrowser, sendBrowserInput, startBrowser, stopBrowser } from './browser.js';
import { managerPort } from './camoufox-client.js';
import { contentStatus, xAuthorizationMatches } from './content.js';
import { xAuthSettings } from './publishing-settings.js';
import { InputError, requireFound } from './errors.js';
import { clientLauncher, issueLauncherTicket, launcherDownload, launcherExtensionId } from './launcher.js';
import { launcherPresence } from './launcher-presence.js';
import { publicProxy } from './public-proxy.js';
import { isCustomerWorkspace, workspaceDb, workspaceDirectory, workspaceId, reveal, row, rows, seal, write } from './store.js';

export const workspace = Router();
const checkingProxies = new Set<string>();
const busyProfiles = new Set<string>();
const now = () => new Date().toISOString();
const ok = { ok: true };
const openProfileInput = z.object({ draftId: z.uuid().optional() });
const operationKey = (id: string) => `${workspaceId() ?? 'owner'}:${id}`;
const pointer = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) };
const browserInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ...pointer }),
  z.object({ type: z.literal('scroll'), ...pointer, delta: z.number().int().min(-1600).max(1600) }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(8000) }),
  z.object({ type: z.literal('key'), key: z.enum(['Backspace', 'Delete', 'Enter', 'Tab', 'Shift+Tab', 'Escape', 'Space',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Control+a']) }),
  z.object({ type: z.enum(['back', 'reload', 'home', 'login']) }),
]);

export type Account = {
  id: string; label: string; username: string; notes: string; createdAt: string;
  xUserId: string | null; xUsername: string | null; token: string | null;
};
type Proxy = {
  id: string; label: string; host: string; port: number; username: string; password: string | null;
  status: string; lastIp: string | null; latency: number | null; checkedAt: string | null; checkError: string | null;
};
type Profile = {
  id: string; accountId: string; proxyId: string; label: string;
  locale: string; timezone: string; width: number; height: number;
  deviceScaleFactor: number; colorScheme: 'light' | 'dark'; reducedMotion: 'no-preference' | 'reduce';
};

export const accountById = (id: string) => requireFound(row<Account>('SELECT * FROM accounts WHERE id = ?', id), '找不到这个账号。');
export const proxyById = (id: string) => requireFound(row<Proxy>('SELECT * FROM proxies WHERE id = ?', id), '找不到这个代理。');
export const profileById = (id: string) => requireFound(row<Profile>('SELECT * FROM profiles WHERE id = ?', id), '找不到这个浏览器环境。');
export const openProxy = (proxy: Proxy) => ({
  host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password ? reveal(proxy.password) : '',
});
export function accountBrowserProfile(accountId: string) {
  return row<Profile>('SELECT * FROM profiles WHERE accountId = ? ORDER BY rowid DESC LIMIT 1', accountId);
}

function draftTextForProfile(profile: Profile, draftId: string) {
  const draft = requireFound(row<{ text: string; status: string }>(
    "SELECT text, status FROM drafts WHERE id = ? AND accountId = ?", draftId, profile.accountId,
  ), '找不到该账号的草稿。');
  if (draft.status !== 'draft' && draft.status !== 'error') {
    throw new InputError('请打开尚未发布的草稿。', 409);
  }
  if (!draft.text.trim()) throw new InputError('请先填写草稿正文。');
  return draft.text;
}

export function launcherProfile(id: string, draftId?: string) {
  const profile = profileById(id);
  return {
    workspace: workspaceId() ?? 'owner', profile: profile.id,
    width: profile.width, height: profile.height, proxy: openProxy(proxyById(profile.proxyId)),
    ...(draftId ? { draftText: draftTextForProfile(profile, draftId) } : {}),
  };
}
const pendingFor = (id: string) =>
  row("SELECT 1 FROM drafts WHERE accountId = ? AND status IN ('scheduled', 'publishing') LIMIT 1", id);

const label = z.string().trim().min(1, '请输入名称。').max(80, '名称最多 80 个字符。');
export const accountInput = z.object({
  label,
  username: z.string().trim().transform((value) => value.replace(/^@/, ''))
    .refine((value) => /^[A-Za-z0-9_]{0,15}$/.test(value), 'X 用户名应为最多 15 位的英文字母、数字或下划线。'),
  notes: z.string().trim().max(2000, '备注最多 2000 个字符。').default(''),
});
export const proxyInput = z.object({
  label,
  host: z.string().trim().max(253).transform((host) => host.replace(/^\[(.+)\]$/, '$1'))
    .refine((host) => isIP(host) !== 0 || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host),
      '请输入代理主机名或 IP 地址，无需填写协议。'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().refine((value) => Buffer.byteLength(value) <= 255, '代理用户名超出限制。').default(''),
  password: z.string().refine((value) => Buffer.byteLength(value) <= 255, '代理密码超出限制。').optional(),
});
export const profileInput = z.object({
  label, accountId: z.uuid(), proxyId: z.uuid(),
  locale: z.string().trim().max(30).refine((locale) => {
    try { return Intl.getCanonicalLocales(locale).length === 1; } catch { return false; }
  }, '请输入有效的语言代码，如 zh-CN。'),
  timezone: z.string().trim().min(1).max(80).refine((timeZone) => {
    try { new Intl.DateTimeFormat('en', { timeZone }); return true; } catch { return false; }
  }, '请输入有效的时区，如 Asia/Shanghai。'),
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
  deviceScaleFactor: z.number().min(1).max(3).default(1),
  colorScheme: z.enum(['light', 'dark']).default('light'),
  reducedMotion: z.enum(['no-preference', 'reduce']).default('no-preference'),
});
const windowInput = profileInput.omit({ label: true, accountId: true, proxyId: true }).extend({
  id: z.uuid(),
  label: z.string().trim().max(80).default(''),
  accountId: z.uuid().optional(),
  proxy: z.union([
    z.object({ id: z.uuid() }).strict(),
    proxyInput.omit({ label: true }).strict(),
  ]),
});

export function checkProxyCredentials(username: string, password: string) {
  if (Boolean(username) !== Boolean(password)) throw new InputError('使用账号密码认证时，请同时填写代理用户名和密码。');
}

export function createAccount(data: z.output<typeof accountInput>): string {
  const id = randomUUID();
  write('INSERT INTO accounts (id, label, username, notes, createdAt) VALUES (?, ?, ?, ?, ?)',
    id, data.label, data.username, data.notes, now());
  return id;
}

export function createProxy(data: z.output<typeof proxyInput>): string {
  checkProxyCredentials(data.username, data.password || '');
  const id = randomUUID();
  write('INSERT INTO proxies (id, label, host, port, username, password) VALUES (?, ?, ?, ?, ?, ?)',
    id, data.label, data.host, data.port, data.username, data.password ? seal(data.password) : null);
  return id;
}

export function createProfile(data: z.output<typeof profileInput>, id: string = randomUUID()): void {
  write(`INSERT INTO profiles (id, accountId, proxyId, label, locale, timezone, width, height, deviceScaleFactor, colorScheme, reducedMotion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, data.accountId, data.proxyId, data.label, data.locale, data.timezone,
    data.width, data.height, data.deviceScaleFactor, data.colorScheme, data.reducedMotion);
}

function profileStatus(profile: Profile) {
  const version = browserVersion(profile.id);
  return {
    ...profile, running: Boolean(version), version,
    ...(clientLauncher ? { localPresence: launcherPresence(profile.id) } : {}),
  };
}

function ensureProxyFree(id: string) {
  const linked = rows<{ id: string }>('SELECT id FROM profiles WHERE proxyId = ?', id);
  if (checkingProxies.has(operationKey(id)) || linked.some((profile) => browserVersion(profile.id) || busyProfiles.has(operationKey(profile.id)))) {
    throw new InputError('代理正在使用，请等检查结束或先关闭关联的浏览器。', 409);
  }
}

function ensureProfileFree(id: string, allowRunning = false) {
  if (busyProfiles.has(operationKey(id)) || (!allowRunning && browserVersion(id))) {
    throw new InputError('浏览器正在使用，请等待操作完成或先关闭浏览器。', 409);
  }
}

workspace.get('/workspace', async (_req, res) => {
  const customer = isCustomerWorkspace();
  const chromium = clientLauncher ? undefined : await chromiumInfo();
  const clientId = xAuthSettings()?.clientId;
  const accounts = rows<Account>('SELECT * FROM accounts ORDER BY createdAt DESC').map(({ token, xUserId: _id, ...account }) => ({
    ...account, xConnected: xAuthorizationMatches(token, clientId),
  }));
  const proxies = rows<Proxy>('SELECT * FROM proxies ORDER BY rowid DESC').map(({ password, ...proxy }) => ({
    ...proxy, hasPassword: Boolean(password),
  }));
  const profiles = rows<Profile>('SELECT * FROM profiles ORDER BY rowid DESC').map(profileStatus);
  res.json({
    accounts, proxies, profiles, drafts: rows('SELECT * FROM drafts ORDER BY createdAt DESC'),
    settings: contentStatus(),
    workspaceScope: customer ? 'customer' : 'owner', chromium, remoteBrowser: !clientLauncher && remoteBrowser(), macChromeLauncher,
    ...(clientLauncher ? { launcherExtensionId, launcherDownload } : {}),
    camoufoxConfigured: managerPort() !== null, version: '0.1.0',
  });
});

workspace.post('/windows', (req, res) => {
  const input = windowInput.parse(req.body);
  const database = workspaceDb();
  database.exec('BEGIN IMMEDIATE');
  let profile: Profile;
  try {
    const saved = row<Profile>('SELECT * FROM profiles WHERE id = ?', input.id);
    if (saved) {
      profile = saved;
    } else {
      const account = input.accountId ? accountById(input.accountId) : undefined;
      if (account && row('SELECT 1 FROM profiles WHERE accountId = ?', account.id)) {
        throw new InputError('此账号已有浏览器窗口，请从列表打开。', 409);
      }
      const name = input.label || account?.label || `窗口 ${input.id.slice(0, 4).toUpperCase()}`;
      const proxyId = 'id' in input.proxy
        ? proxyById(input.proxy.id).id
        : createProxy({ ...input.proxy, label: `SOCKS5 ${input.proxy.host}:${input.proxy.port}`.slice(0, 80) });
      const accountId = account?.id ?? createAccount({ label: name, username: '', notes: '' });
      createProfile({ ...input, label: name, accountId, proxyId }, input.id);
      profile = profileById(input.id);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  res.status(201).json({ profile: profileStatus(profile) });
});

workspace.post('/accounts', (req, res) => {
  createAccount(accountInput.parse(req.body));
  res.status(201).json(ok);
});

workspace.patch('/accounts/:id', (req, res) => {
  const account = accountById(req.params.id);
  const data = accountInput.parse(req.body);
  if (account.xUsername && data.username && account.xUsername.toLowerCase() !== data.username.toLowerCase()) {
    throw new InputError('该账号已授权 X。如需修改用户名，请先断开授权。', 409);
  }
  write('UPDATE accounts SET label = ?, username = ?, notes = ? WHERE id = ?',
    data.label, data.username || account.xUsername || '', data.notes, account.id);
  res.json(ok);
});

workspace.delete('/accounts/:id', (req, res) => {
  const { id } = accountById(req.params.id);
  if (row('SELECT 1 FROM profiles WHERE accountId = ?', id) || row('SELECT 1 FROM drafts WHERE accountId = ?', id)) {
    throw new InputError('请先删除该账号关联的浏览器环境和草稿记录。', 409);
  }
  if (row('SELECT 1 FROM camoufox_links WHERE accountId = ?', id)) {
    throw new InputError('请先解除该账号的 Camoufox 关联。', 409);
  }
  write('DELETE FROM accounts WHERE id = ?', id);
  res.json(ok);
});

workspace.post('/accounts/:id/disconnect', (req, res) => {
  const { id } = accountById(req.params.id);
  if (pendingFor(id)) throw new InputError('该账号还有待发布或正在处理的任务。', 409);
  write('UPDATE accounts SET xUserId = NULL, xUsername = NULL, token = NULL WHERE id = ?', id);
  res.json(ok);
});

workspace.post('/proxies', (req, res) => {
  const data = proxyInput.parse(req.body);
  checkProxyCredentials(data.username, data.password || '');
  write('INSERT INTO proxies (id, label, host, port, username, password) VALUES (?, ?, ?, ?, ?, ?)',
    randomUUID(), data.label, data.host, data.port, data.username, data.password ? seal(data.password) : null);
  res.status(201).json(ok);
});

workspace.patch('/proxies/:id', (req, res) => {
  const previous = proxyById(req.params.id);
  ensureProxyFree(previous.id);
  const data = proxyInput.parse(req.body);
  const previousPassword = previous.password ? reveal(previous.password) : '';
  const password = data.password ?? previousPassword;
  checkProxyCredentials(data.username, password);
  write(`UPDATE proxies SET label = ?, host = ?, port = ?, username = ?, password = ?,
    status = 'unchecked', lastIp = NULL, latency = NULL, checkedAt = NULL, checkError = NULL WHERE id = ?`,
    data.label, data.host, data.port, data.username, password ? seal(password) : null, previous.id);
  res.json(ok);
});

workspace.delete('/proxies/:id', (req, res) => {
  const { id } = proxyById(req.params.id);
  ensureProxyFree(id);
  if (row('SELECT 1 FROM profiles WHERE proxyId = ?', id)) throw new InputError('请先解除浏览器环境对该代理的绑定。', 409);
  write('DELETE FROM proxies WHERE id = ?', id);
  res.json(ok);
});

workspace.post('/proxies/:id/check', async (req, res) => {
  const proxy = proxyById(req.params.id);
  const key = operationKey(proxy.id);
  if (checkingProxies.has(key)) throw new InputError('正在检查该代理。', 409);
  checkingProxies.add(key);
  try {
    const configuration = openProxy(proxy);
    const { ip, latency } = await checkProxy(remoteBrowser() ? await publicProxy(configuration) : configuration);
    write("UPDATE proxies SET status = 'ok', lastIp = ?, latency = ?, checkedAt = ?, checkError = NULL WHERE id = ?",
      ip, Math.round(latency), now(), proxy.id);
  } catch (error) {
    const message = error instanceof Error && /^(SOCKS5|出口 IP)/.test(error.message)
      ? error.message
      : '代理未能通过连通性检查。请核对代理地址、认证和出站网络。';
    write("UPDATE proxies SET status = 'error', lastIp = NULL, latency = NULL, checkedAt = ?, checkError = ? WHERE id = ?",
      now(), message, proxy.id);
    throw new InputError(message, error instanceof InputError ? error.status : 502);
  } finally {
    checkingProxies.delete(key);
  }
  res.json(ok);
});

workspace.post('/profiles', (req, res) => {
  const data = profileInput.parse(req.body);
  accountById(data.accountId);
  proxyById(data.proxyId);
  if (row('SELECT 1 FROM profiles WHERE accountId = ?', data.accountId)) throw new InputError('这个账号已有浏览器环境。', 409);
  createProfile(data);
  res.status(201).json(ok);
});

workspace.patch('/profiles/:id', (req, res) => {
  const profile = profileById(req.params.id);
  ensureProfileFree(profile.id);
  const data = profileInput.parse({
    deviceScaleFactor: profile.deviceScaleFactor, colorScheme: profile.colorScheme, reducedMotion: profile.reducedMotion,
    ...req.body,
  });
  if (data.accountId !== profile.accountId) throw new InputError('已建立的浏览器环境不能转给另一个账号。', 409);
  proxyById(data.proxyId);
  write(`UPDATE profiles SET proxyId = ?, label = ?, locale = ?, timezone = ?, width = ?, height = ?,
    deviceScaleFactor = ?, colorScheme = ?, reducedMotion = ? WHERE id = ?`,
    data.proxyId, data.label, data.locale, data.timezone, data.width, data.height,
    data.deviceScaleFactor, data.colorScheme, data.reducedMotion, profile.id);
  res.json(ok);
});

workspace.delete('/profiles/:id', async (req, res) => {
  const { id } = profileById(req.params.id);
  ensureProfileFree(id);
  if (!z.uuid().safeParse(id).success) throw new InputError('浏览器环境标识无效。');
  const key = operationKey(id);
  busyProfiles.add(key);
  try {
    await rm(resolve(workspaceDirectory(), 'profiles', id), { recursive: true, force: true });
    write('DELETE FROM profiles WHERE id = ?', id);
    res.json(ok);
  } finally {
    busyProfiles.delete(key);
  }
});

workspace.post('/profiles/:id/launcher-ticket', (req, res) => {
  const profile = profileById(req.params.id);
  const { draftId, messages } = openProfileInput.extend({ messages: z.literal(true).optional() }).parse(req.body ?? {});
  if (draftId && messages) throw new InputError('请选择发帖或私信入口。');
  if (draftId) draftTextForProfile(profile, draftId);
  issueLauncherTicket(req, res, profile.id, draftId, messages);
});

workspace.post('/profiles/:id/start', async (req, res) => {
  if (clientLauncher) throw new InputError('请使用 Chrome 本机启动器打开 X。', 409);
  const profile = profileById(req.params.id);
  const { draftId } = openProfileInput.parse(req.body ?? {});
  const draftText = draftId ? draftTextForProfile(profile, draftId) : undefined;
  ensureProfileFree(profile.id, Boolean(draftId));
  const key = operationKey(profile.id);
  busyProfiles.add(key);
  try {
    try {
      await startBrowser({ ...profile, proxy: openProxy(proxyById(profile.proxyId)) }, draftText);
    } catch (error) {
      if (error instanceof InputError) throw error;
      const message = error instanceof Error ? error.message : '浏览器启动失败。';
      throw new InputError(message, 502);
    }
    res.json(ok);
  } finally {
    busyProfiles.delete(key);
  }
});

workspace.post('/profiles/:id/stop', async (req, res) => {
  const { id } = profileById(req.params.id);
  ensureProfileFree(id, true);
  const key = operationKey(id);
  busyProfiles.add(key);
  try {
    await stopBrowser(id);
    res.json(ok);
  } finally {
    busyProfiles.delete(key);
  }
});

workspace.get('/profiles/:id/frame', async (req, res) => {
  const { id } = profileById(req.params.id);
  res.type('image/jpeg').send(await browserFrame(id));
});

workspace.post('/profiles/:id/input', async (req, res) => {
  const { id } = profileById(req.params.id);
  await sendBrowserInput(id, browserInput.parse(req.body));
  res.json(ok);
});
