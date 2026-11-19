import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { InputError } from './errors.js';

// CPM 0.7.0 contracts: https://github.com/polyackiy/camoufox-profile-manager/blob/v0.7.0/docs/api.md
// Browser status verifies the active installed bundle and required resources; it is not a profile's claimed UA.
export const MINIMUM_CAMOUFOX_MAJOR = 158;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_PAGES = 10;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION = /^\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]+)?$/;

export type ManagerProfile = {
  id: string;
  name: string;
  proxyAddress: string | null;
  notes: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type ManagerStatus = {
  configured: boolean;
  available: boolean;
  installed: boolean;
  version: string | null;
  minimumMajor: number;
  ready: boolean;
  message: string;
  versionSource: 'manager-installed-bundle' | null;
};

export type ManagerProfileInput = {
  name: string;
  notes: string;
  locale: string;
  timezone: string;
  width: number;
  height: number;
  proxy: { host: string; port: number; username: string; password: string };
};

/** A confirmed 4xx is safe to report as rejected; uncertain writes must be reconciled before retrying. */
export class CamoufoxClientError extends InputError {
  constructor(
    message: string,
    status: number,
    readonly code: string,
    readonly outcomeUnknown = false,
    readonly upstreamStatus: number | null = null,
  ) { super(message, status); this.name = 'CamoufoxClientError'; }
}

function portSetting(): string | undefined {
  return process.env.CAMOUFOX_PORT ?? process.env.CPM_PORT;
}

/** Explicitly setting CAMOUFOX_PORT (or its CPM_PORT alias) enables this local-only adapter. */
export function managerPort(): number | null {
  const value = portSetting()?.trim();
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

function configuredPort(): number {
  const port = managerPort();
  if (port === null) {
    throw new CamoufoxClientError(
      portSetting()?.trim() ? 'Camoufox 管理器端口配置无效，需为 1–65535 的整数。' : '请先配置 CAMOUFOX_PORT，并启动同机 Camoufox Profile Manager。',
      503, 'manager_not_configured',
    );
  }
  return port;
}

function clientError(status: number, code: string | undefined, mutation: boolean): CamoufoxClientError {
  if (code === 'browser_exit_unconfirmed') {
    return new CamoufoxClientError('管理器尚未确认浏览器退出；请在管理器中核对状态，再手动重试关闭。', 502, code, true, status);
  }
  const message = status === 401 ? 'Camoufox 管理器认证失败，请检查服务端 CAMOUFOX_API_KEY。'
    : status === 403 ? '当前 Camoufox 管理器 API 凭据没有执行该操作的权限。'
    : status === 404 ? 'Camoufox 环境不存在，或管理器不支持此版本 API。'
    : status === 409 ? 'Camoufox 环境正在运行、被占用或状态冲突，请在管理器中核对。'
    : status === 400 || status === 422 ? 'Camoufox 管理器拒绝了请求，请核对环境和 SOCKS5 配置。'
    : status === 503 ? 'Camoufox 管理器暂不可用或正在维护，请稍后核对状态。'
    : 'Camoufox 管理器返回异常，请先核对远端环境状态。';
  return new CamoufoxClientError(message, status >= 400 && status < 500 ? status : 502,
    status >= 400 && status < 500 ? 'manager_rejected' : 'manager_error', mutation && (status < 400 || status >= 500), status);
}

/** No redirects, arbitrary hosts, environment proxy routing, automatic retries, or upstream body disclosure. */
async function callManager(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, timeout = 10_000): Promise<unknown> {
  const port = configuredPort();
  const mutation = method === 'POST';
  const apiKey = process.env.CAMOUFOX_API_KEY;
  if (apiKey && (!/^[\x20-\x7e]{1,4096}$/.test(apiKey) || !apiKey.trim())) {
    throw new CamoufoxClientError('服务端 CAMOUFOX_API_KEY 格式无效。', 503, 'manager_key_invalid');
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((fulfill, reject) => {
    let settled = false;
    let sent = false;
    const finish = (error?: CamoufoxClientError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else fulfill(value);
    };
    const request = httpRequest({
      hostname: '127.0.0.1', family: 4, port, path, method, agent: false,
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      },
    }, (response) => {
      const status = response.statusCode ?? 502;
      if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')) {
        finish(status >= 400 && status < 500 ? clientError(status, undefined, mutation)
          : new CamoufoxClientError('该本地端口没有返回兼容的 Camoufox Profile Manager JSON API。', 502, 'manager_incompatible', mutation, status));
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          finish(new CamoufoxClientError('Camoufox 管理器响应超出限制，请缩小列表搜索范围。', 502, 'manager_response_limit', mutation, status));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch {
          finish(status >= 400 && status < 500 ? clientError(status, undefined, mutation)
            : new CamoufoxClientError('Camoufox 管理器返回了无效 JSON，请核对管理器版本。', 502, 'manager_incompatible', mutation, status));
          return;
        }
        if (status < 200 || status >= 300) {
          const error = z.object({ error: z.object({ code: z.string().max(80) }).optional() }).safeParse(value);
          finish(clientError(status, error.success ? error.data.error?.code : undefined, mutation));
          return;
        }
        finish(undefined, value);
      });
      const interrupted = () => finish(new CamoufoxClientError('Camoufox 管理器连接中断，请先核对环境状态再重试。', 502, 'manager_disconnected', mutation && sent, status));
      response.on('error', interrupted);
      response.on('aborted', interrupted);
    });
    const timer = setTimeout(() => {
      finish(new CamoufoxClientError('Camoufox 管理器请求超时，请先核对环境状态再重试。', 504, 'manager_timeout', mutation && sent));
      request.destroy();
    }, timeout);
    request.once('finish', () => { sent = true; });
    request.on('error', () => finish(new CamoufoxClientError(
      '无法连接本机 Camoufox Profile Manager，请检查是否已启动和端口配置。', 503, 'manager_unavailable', mutation && sent,
    )));
    request.end(payload);
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown, mutation = false): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CamoufoxClientError('Camoufox 管理器响应结构不兼容，请核对管理器版本。', 502, 'manager_incompatible', mutation);
  return result.data;
}

const healthSchema = z.object({ status: z.enum(['healthy', 'unhealthy']), api_version: z.string().min(1).max(40), database: z.enum(['connected', 'disconnected']) });
const browserSchema = z.object({ success: z.literal(true), data: z.object({ installed: z.boolean(), version: z.string().max(80).nullable(), state: z.enum(['idle', 'downloading', 'ready', 'error']) }) });
const profileSchema = z.object({
  id: z.string().regex(PROFILE_ID), name: z.string().min(1).max(255), notes: z.string().max(1000).nullable().optional(),
  status: z.string().max(40), created_at: z.string().max(80), updated_at: z.string().max(80), last_used: z.string().max(80).nullable(),
  proxy_config: z.object({ type: z.string().max(20), server: z.string().max(1024) }).nullable(),
});
type RawProfile = z.infer<typeof profileSchema>;

async function healthyManager(): Promise<void> {
  const health = parse(healthSchema, await callManager('/health', 'GET', undefined, 4000));
  if (health.status !== 'healthy' || health.database !== 'connected') {
    throw new CamoufoxClientError('Camoufox 管理器数据库尚未就绪。', 503, 'manager_unhealthy');
  }
}

export async function getManagerStatus(): Promise<ManagerStatus> {
  const result: ManagerStatus = { configured: Boolean(portSetting()?.trim()), available: false, installed: false, version: null,
    minimumMajor: MINIMUM_CAMOUFOX_MAJOR, ready: false, message: '尚未配置本机 Camoufox Profile Manager。', versionSource: null };
  if (!result.configured) return result;
  try {
    configuredPort();
    await healthyManager();
    const browser = parse(browserSchema, await callManager('/api/v1/system/browser')).data;
    result.available = true;
    result.installed = browser.installed;
    result.version = browser.installed && browser.version && VERSION.test(browser.version) ? browser.version : null;
    result.versionSource = result.version ? 'manager-installed-bundle' : null;
    const major = result.version ? Number(result.version.split('.')[0]) : null;
    result.ready = browser.installed && major !== null && major >= MINIMUM_CAMOUFOX_MAJOR && browser.state === 'ready';
    result.message = result.ready ? `Camoufox ${result.version} 已就绪。`
      : browser.state === 'downloading' ? 'Camoufox 浏览器正在安装，请等待管理器安装完成。'
      : browser.state === 'error' ? 'Camoufox 浏览器安装失败，请在管理器中查看并重试。'
      : !browser.installed ? '请在 Camoufox 管理器中完成浏览器安装。'
      : major === null ? '管理器没有返回有效的已安装浏览器版本。'
      : major < MINIMUM_CAMOUFOX_MAJOR ? `已安装浏览器版本过旧，最低需要 Firefox ${MINIMUM_CAMOUFOX_MAJOR}。`
      : 'Camoufox 浏览器尚未就绪，请在管理器中检查安装状态。';
  } catch (error) {
    result.message = error instanceof CamoufoxClientError ? error.message : '无法读取 Camoufox 管理器状态。';
  }
  return result;
}

async function readyManager(): Promise<void> {
  await healthyManager();
  const browser = parse(browserSchema, await callManager('/api/v1/system/browser')).data;
  const major = browser.installed && browser.version && VERSION.test(browser.version) ? Number(browser.version.split('.')[0]) : null;
  if (!browser.installed || major === null || major < MINIMUM_CAMOUFOX_MAJOR || browser.state !== 'ready') {
    throw new CamoufoxClientError(`Camoufox 尚未就绪；需完成浏览器安装并使用 Firefox ${MINIMUM_CAMOUFOX_MAJOR} 或更新版本。`, 409, 'manager_not_ready');
  }
}

function validId(id: string): string {
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new InputError('Camoufox 环境 ID 无效。');
  return id;
}

function normalizedHost(value: string): string {
  let host = value.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (isIP(host)) return host;
  host = domainToASCII(host);
  if (!host || host.length > 253 || !host.split('.').every((part) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))) {
    throw new InputError('SOCKS5 地址只填写 IP 或主机名，不包含协议、路径和端口。');
  }
  return host;
}

function proxyAddress(proxy: RawProfile['proxy_config']): string | null {
  if (proxy?.type !== 'socks5') return null;
  try {
    const url = new URL(`socks5://${proxy.server}`);
    if (!url.port || url.username || url.password || url.pathname || url.search || url.hash) return null;
    const host = normalizedHost(url.hostname);
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  } catch { return null; }
}

function publicProfile(profile: RawProfile): ManagerProfile {
  return { id: profile.id, name: profile.name, proxyAddress: proxyAddress(profile.proxy_config), notes: profile.notes ?? '', status: profile.status,
    createdAt: profile.created_at, updatedAt: profile.updated_at, lastUsedAt: profile.last_used };
}

async function rawProfile(id: string): Promise<RawProfile> {
  const profile = parse(profileSchema, await callManager(`/api/v1/profiles/${validId(id)}`));
  if (profile.id !== id) throw new CamoufoxClientError('管理器返回的环境 ID 不匹配。', 502, 'manager_incompatible');
  return profile;
}

export async function getManagerProfile(id: string): Promise<ManagerProfile> {
  return publicProfile(await rawProfile(id));
}

export async function listManagerProfiles(search?: string): Promise<ManagerProfile[]> {
  if (search !== undefined && (typeof search !== 'string' || search.length > 255)) throw new InputError('环境搜索不能超过 255 个字符。');
  const pageSchema = z.object({ profiles: z.array(profileSchema).max(100), total: z.number().int().nonnegative(), page: z.number().int().positive(),
    per_page: z.number().int().positive().max(100), has_next: z.boolean(), has_prev: z.boolean() });
  const profiles = new Map<string, ManagerProfile>();
  const deadline = Date.now() + 30_000;
  for (let page = 1; page <= MAX_PROFILE_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CamoufoxClientError('环境列表读取超时，请缩小搜索范围。', 504, 'manager_timeout');
    const query = new URLSearchParams({ page: String(page), per_page: '100', ...(search ? { search } : {}) });
    const result = parse(pageSchema, await callManager(`/api/v1/profiles?${query}`, 'GET', undefined, Math.min(10_000, remaining)));
    if (result.page !== page || (result.has_next && result.profiles.length === 0)) {
      throw new CamoufoxClientError('管理器分页响应不兼容，请核对管理器版本。', 502, 'manager_incompatible');
    }
    const before = profiles.size;
    for (const profile of result.profiles) profiles.set(profile.id, publicProfile(profile));
    if (!result.has_next) return [...profiles.values()];
    if (profiles.size === before) throw new CamoufoxClientError('管理器分页未推进，请缩小搜索范围后重试。', 502, 'manager_incompatible');
  }
  throw new CamoufoxClientError('环境列表超过 1000 条，请缩小搜索范围后重试。', 413, 'manager_list_limit');
}

export async function createManagerProfile(data: ManagerProfileInput): Promise<ManagerProfile> {
  const parsedInput = z.object({
    name: z.string().trim().min(1).max(255), notes: z.string().max(1000), locale: z.string().max(80), timezone: z.string().max(120),
    width: z.number().int().min(320).max(7680), height: z.number().int().min(320).max(4320),
    proxy: z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), username: z.string(), password: z.string() }),
  }).safeParse(data);
  if (!parsedInput.success) throw new InputError('Camoufox 环境名称、备注、窗口尺寸或 SOCKS5 参数无效。');
  const input = parsedInput.data;
  const host = normalizedHost(input.proxy.host);
  if (Boolean(input.proxy.username) !== Boolean(input.proxy.password) || Buffer.byteLength(input.proxy.username) > 255 || Buffer.byteLength(input.proxy.password) > 255) {
    throw new InputError('SOCKS5 用户名和密码需一起填写或一起留空，且各不能超过 255 字节。');
  }
  await healthyManager();
  // Only ordinary window/UI fields are forwarded. No os/UA/hardware/noise/preset/config/additional_options overrides.
  const created = parse(profileSchema, await callManager('/api/v1/profiles', 'POST', {
    name: input.name, notes: input.notes,
    browser_settings: { browser_ui: 'desktop', window_width: input.width, window_height: input.height },
    proxy_config: { type: 'socks5', server: `${isIP(host) === 6 ? `[${host}]` : host}:${input.proxy.port}`,
      ...(input.proxy.username ? { username: input.proxy.username, password: input.proxy.password } : {}) },
  }, 30_000), true);
  const profile = publicProfile(created);
  const expectedProxy = `${isIP(host) === 6 ? `[${host}]` : host}:${input.proxy.port}`;
  if (profile.proxyAddress !== expectedProxy || profile.name !== input.name || profile.notes !== input.notes) {
    throw new CamoufoxClientError('创建响应未确认环境和 SOCKS5 绑定；请先在管理器核对，勿直接重复创建。', 502, 'manager_create_unconfirmed', true);
  }
  return profile;
}

export async function launchManagerProfile(id: string): Promise<{ profileId: string; status: 'launched' | 'already_running' }> {
  validId(id);
  await readyManager();
  if (!proxyAddress((await rawProfile(id)).proxy_config)) throw new InputError('此 Camoufox 环境未绑定有效 SOCKS5，请先在管理器中配置代理。', 409);
  const result = parse(z.object({ profile_id: z.literal(id), status: z.enum(['launched', 'already_running']) }),
    await callManager(`/api/v1/profiles/${id}/launch`, 'POST', { headless: false }, 60_000), true);
  return { profileId: result.profile_id, status: result.status };
}

export async function closeManagerProfile(id: string): Promise<{ profileId: string; status: 'closed' | 'not_running' }> {
  validId(id);
  await healthyManager();
  const result = parse(z.object({ profile_id: z.literal(id), status: z.enum(['closed', 'not_running']) }),
    await callManager(`/api/v1/profiles/${id}/close`, 'POST', undefined, 30_000), true);
  return { profileId: result.profile_id, status: result.status };
}

export async function activeManagerProfiles(): Promise<Set<string>> {
  const result = parse(z.object({ active_browsers: z.array(z.object({ profile_id: z.string().regex(PROFILE_ID) })).max(1000), count: z.number().int().nonnegative() }),
    await callManager('/api/v1/browsers/active'));
  if (result.count !== result.active_browsers.length) throw new CamoufoxClientError('管理器活动环境响应不兼容。', 502, 'manager_incompatible');
  return new Set(result.active_browsers.map((profile) => profile.profile_id));
}
