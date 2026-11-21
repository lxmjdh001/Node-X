import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MESSAGE_CONFIRMATION_MS = 60_000;
const NODEX_REPLY_ID = 'org.nodex.reply_id';
const MATRIX = '/_matrix/client/v3';
const CONNECTOR = '/api/dm/connector';

export class ProtocolError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class BridgeAuthorizationPending extends ProtocolError {}

async function readPrivateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.size > 64 * 1024) {
      throw new ProtocolError('配置和状态文件必须属于当前用户，权限为 600，大小不得超过 64 KiB。');
    }
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

async function saveState(path, state) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(state) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function baseUrl(input) {
  if (typeof input !== 'string') throw new ProtocolError('请填写服务地址。');
  let url;
  try { url = new URL(input); } catch { throw new ProtocolError('服务地址格式无效。'); }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new ProtocolError('服务地址须使用 HTTPS，并且只包含主机与端口。本机可用 HTTP。');
  }
  return url.origin;
}

function provisioningUrl(input) {
  if (typeof input !== 'string') throw new ProtocolError('请配置 mautrix 管理接口。');
  let url;
  try { url = new URL(input); } catch { throw new ProtocolError('mautrix 管理接口地址无效。'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProtocolError('mautrix 管理接口地址不能包含凭据或查询参数。');
  }
  return baseUrl(url.origin) + url.pathname.replace(/\/+$/, '');
}

function matrixId(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > 2 &&
    value.length <= 250 && !/\s/u.test(value);
}

function readConfig(raw) {
  if (!raw || typeof raw !== 'object' ||
      typeof raw.matrixAccessToken !== 'string' || !raw.matrixAccessToken || /[\r\n]/.test(raw.matrixAccessToken) ||
      typeof raw.xUserId !== 'string' || !/^[1-9][0-9]{0,29}$/.test(raw.xUserId) ||
      !matrixId(raw.bridgeBotId, '@') ||
      (raw.matrixSelfPuppetId !== undefined && !matrixId(raw.matrixSelfPuppetId, '@')) ||
      (raw.roomIds !== undefined && (!Array.isArray(raw.roomIds) || !raw.roomIds.length ||
        raw.roomIds.length > 200 || !raw.roomIds.every(id => matrixId(id, '!'))))) {
    throw new ProtocolError('连接器配置无效，请检查 Matrix 凭据、桥接机器人、X 用户编号和房间范围。');
  }
  return {
    nodeXUrl: baseUrl(raw.nodeXUrl),
    matrixUrl: baseUrl(raw.matrixUrl),
    matrixAccessToken: raw.matrixAccessToken,
    xUserId: raw.xUserId,
    bridgeBotId: raw.bridgeBotId,
    matrixSelfPuppetId: raw.matrixSelfPuppetId ?? null,
    roomIds: raw.roomIds === undefined ? null : [...new Set(raw.roomIds)].sort(),
    pairTicket: typeof raw.pairTicket === 'string' ? raw.pairTicket : null,
  };
}

async function readResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ProtocolError('服务返回空响应。');
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProtocolError('同步响应超过大小限制。可缩小房间范围。');
      }
      parts.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(parts, size).toString('utf8'));
    } catch {
      throw new ProtocolError('服务返回了无效的 JSON。');
    }
  } finally {
    reader.releaseLock();
  }
}

async function api({ base, path, service, token, method = 'GET', body, signal, timeout = 15_000, transport = fetch }) {
  let response;
  try {
    response = await transport(base + path, {
      method, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ProtocolError(`${service} 请求中断。`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ProtocolError(`${service} 返回 HTTP ${response.status}。`, response.status);
  }
  try {
    return await readResponse(response);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(`${service} 响应读取中断。`);
  }
}

async function matrixIdentity(config, signal, transport) {
  const identity = await api({ base: config.matrixUrl, path: MATRIX + '/account/whoami',
    token: config.matrixAccessToken, service: 'Matrix', signal, transport });
  if (!matrixId(identity?.user_id, '@') || identity.user_id === config.bridgeBotId) {
    throw new ProtocolError('请使用已连接该 X 账号的普通 Matrix 用户凭据。');
  }
  return identity.user_id;
}

function bridgeIdentity(config, userId, signal, transport) {
  return api({ base: config.bridgeProvisioningUrl,
    path: '/v3/whoami?' + new URLSearchParams({ user_id: userId }),
    token: config.matrixAccessToken, service: 'mautrix', signal, transport });
}

function normalizedUsername(value) {
  return typeof value === 'string' ? value.replace(/^@/, '').toLowerCase() : '';
}

export async function discoverBridgeAccount(config, username, { signal, transport, expectedBot }) {
  const userId = await matrixIdentity(config, signal, transport);
  const bridge = await bridgeIdentity(config, userId, signal, transport);
  if (bridge?.network?.network_id !== 'twitter' || !matrixId(bridge.bridge_bot, '@')) {
    throw new ProtocolError('该地址未返回有效的 mautrix Twitter 桥接信息。');
  }
  if (expectedBot && bridge.bridge_bot !== expectedBot) throw new ProtocolError('私信桥接机器人与账号配置不符。');
  if (bridge.bridge_bot === userId) throw new ProtocolError('请使用自己的 Matrix 用户凭据。');
  const matches = events(bridge.logins).filter(login =>
    normalizedUsername(login.profile?.username || login.name) === normalizedUsername(username));
  if (!matches.length) throw new BridgeAuthorizationPending('桥接中未找到匹配的 X 用户名。请确认对应账号已在 mautrix 完成登录。');
  const login = matches[0];
  if (matches.length !== 1 || typeof login.id !== 'string' || !/^[1-9][0-9]{0,29}$/.test(login.id)) {
    throw new ProtocolError('桥接未返回唯一、有效的 X 用户编号。');
  }
  if (login.state?.state_event !== 'CONNECTED') {
    throw new BridgeAuthorizationPending('这个 X 账号在 mautrix 中还未就绪，请完成登录和 X Chat 验证后再试。');
  }
  return { xUserId: login.id, bridgeBotId: bridge.bridge_bot };
}

function events(value) {
  return Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object') : [];
}

function applyRoomState(previous, changes, bridgeBotId) {
  const room = { ...previous };
  for (const evt of changes) {
    const content = evt.content ?? {};
    if (evt.type === 'm.room.encryption') room.encrypted = true;
    if (evt.type === 'm.room.join_rules') room.public = content.join_rule === 'public';
    if (evt.type === 'm.room.name' && evt.state_key === '') room.title = content.name;
    if ((evt.type === 'm.bridge' || evt.type === 'uk.half-shot.bridge') && evt.sender === bridgeBotId &&
        (content.bridgebot === bridgeBotId || evt.state_key === room.bridgeStateKey)) {
      room.bridgeStateKey = evt.state_key;
      room.xUserId = content.protocol?.id === 'twitter' ? content.channel?.receiver : null;
      room.bridgeTitle = content.channel?.displayname;
    }
  }
  return room;
}

function authorizedRoom(config, roomId, room) {
  return matrixId(roomId, '!') && room?.xUserId === config.xUserId && !room.public &&
    (!config.roomIds || config.roomIds.includes(roomId));
}

function normalizeText(evt, ownIds, matrixUserId, bridgeBotId) {
  if (evt.type !== 'm.room.message' || typeof evt.event_id !== 'string' || evt.event_id.length > 512 ||
      !evt.event_id.startsWith('$') || !matrixId(evt.sender, '@') || evt.sender === bridgeBotId ||
      evt.content?.msgtype !== 'm.text' || typeof evt.content.body !== 'string' || !evt.content.body.trim() ||
      evt.content['m.relates_to']?.rel_type === 'm.replace' ||
      (evt.sender === matrixUserId && typeof evt.content[NODEX_REPLY_ID] === 'string') ||
      !Number.isSafeInteger(evt.origin_server_ts) || evt.origin_server_ts < 0 || evt.origin_server_ts >= 253402300800000) return null;
  return {
    id: evt.event_id,
    text: evt.content.body.slice(0, 10000),
    sender: evt.sender,
    direction: ownIds.has(evt.sender) ? 'out' : 'in',
    createdAt: new Date(evt.origin_server_ts).toISOString(),
  };
}

function takeStatus(eventsByRoom, pending, botId) {
  const statuses = (eventsByRoom.get(pending.roomId) ?? []).filter(evt =>
    evt.type === 'com.beeper.message_send_status' && evt.sender === botId &&
    (evt.content?.['m.relates_to']?.event_id === pending.eventId ||
      evt.content?.relates_to_txn_id === pending.id));
  if (statuses.some(evt => evt.content.status === 'SUCCESS')) return { status: 'sent', remoteId: pending.eventId };
  if (statuses.some(evt => evt.content.status === 'FAIL_PERMANENT')) {
    // The status event does not expose the bridge's internal certainty flag.
    return { status: 'uncertain', error: '桥接服务返回发送异常，请在 X 中核对后再尝试。' };
  }
  return null;
}

function filter(config) {
  return JSON.stringify({
    presence: { types: [] },
    account_data: { types: [] },
    room: {
      ...(config.roomIds ? { rooms: config.roomIds } : {}),
      state: { types: ['m.bridge', 'uk.half-shot.bridge', 'm.room.encryption', 'm.room.name', 'm.room.join_rules'] },
      timeline: {
        types: ['m.room.message', 'm.room.encrypted', 'm.room.encryption', 'm.room.join_rules', 'm.room.name',
          'm.bridge', 'uk.half-shot.bridge', 'com.beeper.message_send_status'],
        limit: 50,
      },
      ephemeral: { types: [] },
      account_data: { types: [] },
    },
  });
}

async function connect(config, stateFile, { signal, managed, log = console.log, warn = console.warn } = {}) {
  const stop = signal ?? new AbortController().signal;
  const mx = (path, opts) => api({ base: config.matrixUrl, path: MATRIX + path, service: 'Matrix',
    token: config.matrixAccessToken, signal: stop, transport: managed?.transport, ...opts });
  const matrixUserId = await matrixIdentity(config, stop, managed?.transport);
  let bridgeCheckedAt = 0;
  const checkBridge = async () => {
    const bridge = await bridgeIdentity(config, matrixUserId, stop, managed.transport);
    if (bridge.bridge_bot !== config.bridgeBotId) throw new ProtocolError('私信桥接机器人与账号配置不符。', 409);
    const login = Array.isArray(bridge.logins) && bridge.logins.find(item => item?.id === config.xUserId);
    if (!login || login.state?.state_event === 'BAD_CREDENTIALS') {
      throw new ProtocolError('请先在 mautrix 登录此 X 账号并按提示完成 X Chat 验证。', 401);
    }
    if (login.state?.state_event !== 'CONNECTED') throw new ProtocolError('X 私信桥接尚未就绪，请稍后重试。');
    bridgeCheckedAt = Date.now();
  };
  if (managed) await checkBridge();
  const ownIds = new Set([matrixUserId, config.matrixSelfPuppetId]);
  const scope = createHash('sha256').update(JSON.stringify({ ...config, pairTicket: null, matrixUser: matrixUserId })).digest('hex');
  let state;
  try { state = await readPrivateJson(stateFile); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (managed && typeof state?.token === 'string' && !managed.hasToken(state.token, config.xUserId)) state = undefined;
  if (state && (state.version !== 1 || state.scope !== scope || typeof state.token !== 'string' || !state.token)) {
    throw new ProtocolError('状态文件属于另一组服务或账号配置。请使用独立配置文件重新配对。');
  }

  const nodeX = (path, body, token = state?.token) => api({ base: config.nodeXUrl, path: CONNECTOR + path,
    service: 'Node X', token, method: 'POST', body, signal: stop });

  if (!state) {
    if (!managed && !config.pairTicket) throw new ProtocolError('首次运行请输入工作台生成的配对码。');
    stop.throwIfAborted();
    const paired = managed ? managed.pair(config.xUserId) :
      await nodeX('/pair', { ticket: config.pairTicket, xUserId: config.xUserId });
    if (typeof paired.token !== 'string' || !paired.token) throw new ProtocolError('Node X 未返回连接凭据。');
    if (paired.account?.xUserId && paired.account.xUserId !== config.xUserId) {
      throw new ProtocolError('Node X 的 X 用户编号与配置不符。请在工作台撤销该连接后重新配对。');
    }
    state = { version: 1, scope, token: paired.token, since: null, pending: null };
    managed?.onPaired(state.token);
    await saveState(stateFile, state);
    if (!managed) log('Node X 账号已配对。可从配置文件删除一次性配对码。');
  } else {
    managed?.onPaired(state.token);
  }

  const rooms = new Map();
  const warned = new Set();
  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    warn(message);
  };
  let initialized = false;
  const roomFilter = filter(config);

  async function storePending(pending) {
    state.pending = pending;
    await saveState(stateFile, state);
  }

  async function flushResult() {
    if (state.pending?.phase !== 'result') return;
    const { id, result } = state.pending;
    try {
      await nodeX(`/jobs/${encodeURIComponent(id)}/result`, result);
    } catch (err) {
      if (err.status !== 409 && err.status !== 404) throw err;
      warn('Node X 已结束该发送任务。连接器保留当前会话结果，不会再次发送。');
    }
    await storePending(null);
  }

  if (state.pending?.phase === 'submitting') {
    await storePending({ ...state.pending, phase: 'result',
      result: { status: 'uncertain', error: '提交期间连接器已重启，请到 X 核对结果。' } });
  }

  async function sync() {
    const query = new URLSearchParams({ timeout: '2000', filter: roomFilter, full_state: String(!initialized) });
    if (state.since) query.set('since', state.since);
    const response = await mx('/sync?' + query);
    if (typeof response.next_batch !== 'string' || !response.next_batch) {
      throw new ProtocolError('Matrix 同步响应缺少游标。');
    }
    if (!initialized) rooms.clear();
    for (const id of Object.keys(response.rooms?.leave ?? {})) rooms.delete(id);

    const observed = new Map();
    let batch = [];
    let count = 0;
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await nodeX('/events', { conversations: batch });
      batch = [];
      count = 0;
      bytes = 0;
    };
    for (const [id, info] of Object.entries(response.rooms?.join ?? {})) {
      const timeline = events(info?.timeline?.events);
      const stateEvents = [...events(info?.state?.events), ...timeline.filter(evt => typeof evt.state_key === 'string')];
      const next = applyRoomState(rooms.get(id), stateEvents, config.bridgeBotId);
      if (timeline.some(evt => evt.type === 'm.room.encrypted')) next.encrypted = true;
      rooms.set(id, next);
      if (!authorizedRoom(config, id, next)) continue;
      if (next.encrypted) {
        warnOnce(id + ':encrypted', '跳过一个启用 Matrix 端到端加密的 X 会话，当前连接器无法解密。');
        continue;
      }
      if (initialized && info.timeline?.limited) {
        warnOnce(id + ':limited', '某个会话在 Matrix 返回的近期记录中存在间隔。最新消息仍会同步。');
      }
      observed.set(id, timeline);
      const messages = timeline.map(evt => normalizeText(evt, ownIds, matrixUserId, config.bridgeBotId)).filter(Boolean);
      const title = [next.title, next.bridgeTitle].find(value => typeof value === 'string' && value.trim()) ?? id;
      for (let offset = 0; offset < Math.max(1, messages.length); offset += 10) {
        const chunk = messages.slice(offset, offset + 10);
        const item = { id, title: title.trim().slice(0, 250), messages: chunk };
        const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (batch.length === 50 || count + chunk.length > 200 || bytes + itemBytes > 900_000 ||
            batch.at(-1)?.id === id) await flush();
        batch.push(item);
        count += chunk.length;
        bytes += itemBytes;
      }
    }
    await flush();
    if (managed && !observed.size) await nodeX('/events', { conversations: [] });

    const pending = state.pending;
    if (pending?.phase === 'awaiting') {
      const status = takeStatus(observed, pending, config.bridgeBotId);
      if (status || Date.now() >= pending.deadline || rooms.get(pending.roomId)?.encrypted) {
        state.pending = { ...pending, phase: 'result', result: status ??
          { status: 'uncertain', error: '未收到 X 桥接发送确认，请检查目标会话。' } };
      }
    }
    state.since = response.next_batch;
    await saveState(stateFile, state);
    initialized = true;
    if (![...rooms.entries()].some(([id, room]) => authorizedRoom(config, id, room) && !room.encrypted)) {
      warnOnce('no-rooms', '还没有可同步的 X 会话。请确认已加入该账号的桥接房间，且桥接绑定了配置中的 X 用户编号。');
    }
  }

  async function claim() {
    if (state.pending) return;
    const response = await nodeX('/jobs/claim', {});
    if (!Array.isArray(response.jobs) || response.jobs.length > 1) {
      throw new ProtocolError('Node X 返回了无效的私信任务列表。');
    }
    const job = response.jobs[0];
    if (!job) return;
    if (typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(job.id)) {
      throw new ProtocolError('Node X 返回了无效的任务编号。');
    }
    const roomId = job.conversationId;
    const fail = error => storePending({ id: job.id, roomId, phase: 'result', result: { status: 'failed', error } });
    if (!authorizedRoom(config, roomId, rooms.get(roomId)) || rooms.get(roomId)?.encrypted) {
      return fail('该会话未通过桥接账号核验，或启用了 Matrix 端到端加密。');
    }
    if (typeof job.text !== 'string' || !job.text.trim() || job.text.length > 10000 ||
        job.text.trimStart().startsWith('!')) {
      return fail('仅支持发送普通文本，开头不能是桥接命令前缀。');
    }
    const path = '/rooms/' + encodeURIComponent(roomId);
    let latestState;
    try {
      latestState = await mx(path + '/state');
    } catch {
      return fail('发送前无法核验会话。请检查 Matrix 连接后重试。');
    }
    const current = applyRoomState({}, events(latestState), config.bridgeBotId);
    if (!authorizedRoom(config, roomId, current) || current.encrypted) {
      return fail('会话已变更，无法安全确认目标账号或加密状态。');
    }
    await storePending({ id: job.id, roomId, phase: 'submitting' });
    let result;
    try {
      result = await mx(path + '/send/m.room.message/' + job.id, {
        method: 'PUT', body: { msgtype: 'm.text', body: job.text, [NODEX_REPLY_ID]: job.id },
      });
    } catch (err) {
      const rejected = [400, 401, 403, 404, 413, 429].includes(err.status);
      await storePending({ id: job.id, roomId, phase: 'result', result: rejected
        ? { status: 'failed', error: 'Matrix 拒绝接受该消息。' }
        : { status: 'uncertain', error: '提交到 Matrix 时连接中断，请到 X 核对结果。' } });
      return;
    }
    if (typeof result.event_id !== 'string' || !result.event_id.startsWith('$') || result.event_id.length > 512) {
      await storePending({ id: job.id, roomId, phase: 'result',
        result: { status: 'uncertain', error: 'Matrix 未返回有效的消息编号。' } });
      return;
    }
    await storePending({ id: job.id, roomId, phase: 'awaiting', eventId: result.event_id,
      deadline: Date.now() + MESSAGE_CONFIRMATION_MS });
  }

  log('正在同步已核验的 X 桥接会话。');
  let backoff = 1000;
  while (!stop.aborted) {
    try {
      if (managed && Date.now() - bridgeCheckedAt >= 45_000) await checkBridge();
      await flushResult();
      await sync();
      managed?.onSync();
      await flushResult();
      await claim();
      await flushResult();
      backoff = 1000;
      await delay(500, null, { signal: stop });
    } catch (err) {
      if (stop.aborted) break;
      if (err.status === 401 || err.status === 403 || (managed && err.status === 409)) throw err;
      managed?.onRetry(err instanceof ProtocolError ? err.message : '私信同步中断，正在重试。');
      warn(err instanceof ProtocolError ? err.message : '连接器操作失败，稍后继续。');
      await delay(backoff, null, { signal: stop }).catch(() => {});
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

async function prepareHostedConfig(raw, configFile, { managed, signal }) {
  if (!managed?.hosted || raw?.xUserId) return raw;
  const username = normalizedUsername(raw?.expectedUsername);
  if (!/^[a-z0-9_]{1,15}$/.test(username)) throw new ProtocolError('托管账号的 X 用户名配置无效。');
  // Validate every service address and the pinned bot before attempting an authorization.
  const base = readConfig({ ...raw, nodeXUrl: managed.nodeXUrl, xUserId: '1' });
  const bridge = { ...base, bridgeProvisioningUrl: provisioningUrl(raw.bridgeProvisioningUrl) };
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    signal.throwIfAborted();
    managed.hosted.checkAccess();
    try {
      const verified = await discoverBridgeAccount(bridge, username, { signal, expectedBot: base.bridgeBotId });
      signal.throwIfAborted();
      managed.hosted.verifyIdentity(verified.xUserId);
      const pinned = { ...raw, xUserId: verified.xUserId };
      await saveState(configFile, pinned);
      return pinned;
    } catch (error) {
      if (!(error instanceof BridgeAuthorizationPending)) throw error;
      if (Date.now() >= deadline) throw new ProtocolError('等待 X 授权超时。完成授权后，可在窗口管理重新连接。');
      managed.hosted.onAwaiting(username);
      await delay(6000, null, { signal });
    }
  }
}

export async function runConnector(configFile, options) {
  const stateFile = configFile + '.state.json';
  const managed = options.managed;
  const raw = managed?.readConfig ? managed.readConfig() : await readPrivateJson(configFile);
  const lockFile = stateFile + '.lock';
  const lock = await open(lockFile, 'wx', 0o600).catch(err => {
    if (err.code === 'EEXIST') throw new ProtocolError('此配置已有连接器在运行。停止它后才能重启。');
    throw err;
  });
  try {
    await lock.writeFile(String(process.pid) + '\n');
    options.signal.throwIfAborted();
    const prepared = managed?.hosted ? await prepareHostedConfig(raw, configFile, options) : raw;
    const config = managed ? {
      ...readConfig({ ...prepared, nodeXUrl: managed.nodeXUrl, pairTicket: null }),
      bridgeProvisioningUrl: provisioningUrl(prepared?.bridgeProvisioningUrl),
    } : readConfig(prepared);
    await connect(config, stateFile, options);
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  const run = process.argv.length === 3 ? runConnector(resolve(process.argv[2]), { signal: controller.signal }) :
    Promise.reject(new ProtocolError('用法：node scripts/dm-matrix/connector.mjs /路径/config.json'));
  run.catch(err => {
    if (controller.signal.aborted) return;
    console.error(err instanceof ProtocolError ? err.message : '启动失败。请检查配置和状态文件。');
    process.exitCode = 1;
  });
}
