import { Router } from 'express';
import { z } from 'zod';
import {
  activeManagerProfiles,
  CamoufoxClientError,
  closeManagerProfile,
  createManagerProfile,
  getManagerProfile,
  getManagerStatus,
  launchManagerProfile,
  listManagerProfiles,
  managerPort,
  type ManagerProfile,
} from './camoufox-client.js';
import { InputError } from './errors.js';
import { row, rows, write } from './store.js';
import { accountById, openProxy, profileById, proxyById } from './workspace.js';

export const camoufox = Router();
type Link = { accountId: string; profileId: string | null; name: string };
type Result = { id: string; status: 'ok' | 'skipped' | 'error'; message: string };
const profileIds = z.object({ profileIds: z.array(z.uuid()).min(1).max(20) });
const accountIds = (max: number) => z.object({ accountIds: z.array(z.uuid()).min(1).max(max) });
const linkInput = z.object({
  accountId: z.uuid(),
  profileId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

let operating = false;

async function operation<T>(action: () => Promise<T>): Promise<T> {
  if (operating) throw new InputError('Camoufox 正在处理另一项操作，请在完成后重试。', 409);
  operating = true;
  try {
    return await action();
  } finally {
    operating = false;
  }
}

function portOrThrow() {
  const port = managerPort();
  if (port === null) throw new InputError('请在 .env 中配置 CAMOUFOX_PORT 后重启 Node X。', 409);
  return port;
}

async function checkManager(requireBrowser: boolean) {
  const port = portOrThrow();
  const status = await getManagerStatus();
  if (!status.available || (requireBrowser && !status.ready)) throw new InputError(status.message, 409);
  return port;
}

function getLink(port: number, accountId: string) {
  return row<Link>('SELECT accountId, profileId, name FROM camoufox_links WHERE managerPort = ? AND accountId = ?', port, accountId);
}

function setLink(port: number, accountId: string, profile: ManagerProfile) {
  if (!profile.proxyAddress) throw new InputError('该环境当前没有有效的 SOCKS5 代理。', 409);
  const used = row<{ accountId: string }>('SELECT accountId FROM camoufox_links WHERE managerPort = ? AND profileId = ?', port, profile.id);
  if (used && used.accountId !== accountId) throw new InputError('该 Camoufox 环境已经关联到另一个账号。', 409);
  write(`
    INSERT INTO camoufox_links (managerPort, accountId, profileId, name) VALUES (?, ?, ?, ?)
    ON CONFLICT (managerPort, accountId) DO UPDATE SET profileId = excluded.profileId, name = excluded.name
  `, port, accountId, profile.id, profile.name);
}

async function eachResult(ids: string[], action: (id: string) => Promise<Omit<Result, 'id'>>): Promise<Result[]> {
  const results: Result[] = [];
  for (const id of new Set(ids)) {
    try {
      results.push({ id, ...await action(id) });
    } catch (error) {
      if (!(error instanceof InputError)) console.error('本地 Camoufox 操作失败。');
      results.push({ id, status: 'error', message: error instanceof InputError ? error.message : '操作未能完成，请在 Camoufox 中核对环境状态。' });
    }
  }
  return results;
}

camoufox.get('/', async (_req, res) => {
  const status = await getManagerStatus();
  const port = managerPort();
  const links = port === null ? [] : rows<Link>(
    'SELECT accountId, profileId, name FROM camoufox_links WHERE managerPort = ? ORDER BY name', port,
  );
  let managerProfiles: ManagerProfile[] = [];
  let active: Set<string> | null = null;
  if (status.available) {
    const [profilesResult, activeResult] = await Promise.allSettled([listManagerProfiles(), activeManagerProfiles()]);
    if (profilesResult.status === 'fulfilled') managerProfiles = profilesResult.value;
    else if (status.ready) status.message = '已连接管理器，但暂时无法读取环境列表。';
    if (activeResult.status === 'fulfilled') active = activeResult.value;
  }
  const profileIndex = new Map(managerProfiles.map((profile) => [profile.id, profile]));
  const linkedIds = new Set(links.map((link) => link.profileId));
  const running = (id: string) => active?.has(id) ?? null;
  const catalog = managerProfiles
    .filter((profile): profile is ManagerProfile & { proxyAddress: string } => !!profile.proxyAddress && !linkedIds.has(profile.id))
    .map(({ id, name, proxyAddress }) => ({ id, name, proxyAddress, running: running(id) }));
  res.json({
    status,
    links: links.map((link) => {
      const online = link.profileId === null ? undefined : profileIndex.get(link.profileId);
      return {
        ...link,
        name: online?.name ?? link.name,
        running: link.profileId ? running(link.profileId) : null,
        proxyAddress: online?.proxyAddress ?? null,
      };
    }),
    catalog,
  });
});

camoufox.post('/link', async (req, res) => {
  const { accountId, profileId } = linkInput.parse(req.body);
  await operation(async () => {
    const port = await checkManager(false);
    accountById(accountId);
    const link = getLink(port, accountId);
    if (link?.profileId && link.profileId !== profileId) throw new InputError('这个账号已有 Camoufox 环境，请先解除原关联。', 409);
    if (link && link.profileId === null) throw new InputError('上次创建还待核对，请使用批量创建重新检查该环境。', 409);
    const profile = await getManagerProfile(profileId);
    accountById(accountId);
    setLink(port, accountId, profile);
  });
  res.json({ ok: true });
});

camoufox.delete('/link/:accountId', async (req, res) => {
  const accountId = z.uuid().parse(req.params.accountId);
  await operation(async () => {
    const port = portOrThrow();
    const link = getLink(port, accountId);
    if (!link) throw new InputError('找不到此关联。', 404);
    if (!link.profileId) throw new InputError('创建结果待核对，请先在创建页重试核对。', 409);
    write('DELETE FROM camoufox_links WHERE managerPort = ? AND accountId = ?', port, accountId);
  });
  res.json({ ok: true });
});

camoufox.post('/create', async (req, res) => {
  const { profileIds: ids } = profileIds.parse(req.body);
  const results = await operation(async () => {
    const port = await checkManager(false);
    return eachResult(ids, async (id) => {
      const current = profileById(id);
      const previous = getLink(port, current.accountId);
      if (previous?.profileId) return { status: 'skipped', message: '已关联 Camoufox，保留原环境。' };
      const marker = `[Node X ${current.accountId}]`;
      const name = previous?.name ?? `${current.label.slice(0, 50)} ${marker}`;
      if (previous) {
        const matches = (await listManagerProfiles(current.accountId)).filter((profile) => profile.notes === marker);
        if (matches.length !== 1) {
          throw new InputError('上次创建结果仍待核对，请在 Camoufox 中检查此账号的环境。系统不会重复创建。', 409);
        }
        setLink(port, current.accountId, matches[0]);
        return { status: 'ok', message: '已恢复与原 Camoufox 环境的关联。' };
      }
      const proxy = openProxy(proxyById(current.proxyId));
      write('INSERT INTO camoufox_links (managerPort, accountId, profileId, name) VALUES (?, ?, NULL, ?)', port, current.accountId, name);
      let created: ManagerProfile;
      try {
        created = await createManagerProfile({
          name, notes: marker, locale: current.locale, timezone: current.timezone,
          width: current.width, height: current.height, proxy,
        });
      } catch (error) {
        if (error instanceof InputError && !(error instanceof CamoufoxClientError && error.outcomeUnknown)) {
          write('DELETE FROM camoufox_links WHERE managerPort = ? AND accountId = ? AND profileId IS NULL', port, current.accountId);
          throw error;
        }
        throw new InputError('未收到创建确认。可再次选择该环境以核对，系统不会自动重复创建。', 502);
      }
      setLink(port, current.accountId, created);
      return { status: 'ok', message: '已创建并关联 Camoufox 环境。' };
    });
  });
  res.json({ results });
});

camoufox.post('/open', async (req, res) => {
  const { accountIds: ids } = accountIds(5).parse(req.body);
  const results = await operation(async () => {
    const port = await checkManager(true);
    const active = await activeManagerProfiles();
    return eachResult(ids, async (accountId) => {
      const link = getLink(port, accountId);
      if (!link?.profileId) throw new InputError('这个账号还没有可打开的 Camoufox 环境。', 409);
      const profile = await getManagerProfile(link.profileId);
      if (!profile.proxyAddress) throw new InputError('该环境当前没有有效的 SOCKS5 代理，请在 Camoufox 中补齐。', 409);
      if (active.has(link.profileId)) return { status: 'skipped', message: '该环境已打开。' };
      await launchManagerProfile(link.profileId);
      return { status: 'ok', message: '已打开窗口，可在窗口内手动使用。' };
    });
  });
  res.json({ results });
});

camoufox.post('/close', async (req, res) => {
  const { accountIds: ids } = accountIds(20).parse(req.body);
  const results = await operation(async () => {
    const port = await checkManager(false);
    const active = await activeManagerProfiles();
    return eachResult(ids, async (accountId) => {
      const link = getLink(port, accountId);
      if (!link?.profileId) throw new InputError('这个账号还没有关联 Camoufox 环境。', 409);
      if (!active.has(link.profileId)) return { status: 'skipped', message: '环境没有打开。' };
      await closeManagerProfile(link.profileId);
      return { status: 'ok', message: '已关闭窗口并保留环境数据。' };
    });
  });
  res.json({ results });
});
