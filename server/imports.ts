import { Router } from 'express';
import { z } from 'zod';
import { InputError } from './errors.js';
import { parseImportCsv, type ImportCandidate } from './import-csv.js';
import { reveal, row, rows, workspaceDb } from './store.js';
import {
  accountInput, checkProxyCredentials, createAccount, createProfile, createProxy, profileInput, proxyInput,
} from './workspace.js';

export const imports = Router();
const importInput = z.object({ format: z.enum(['nodex', 'camoufox']), csv: z.string() });
const profileSettings = profileInput.omit({ accountId: true, proxyId: true });
type ImportInput = z.output<typeof importInput>;
type PreviewRow = {
  row: number; username: string; accountLabel: string; profileLabel: string;
  proxyAddress: string; locale: string; timezone: string; status: 'ready' | 'skip' | 'error'; message: string;
};
type StoredProxy = { id: string; password: string | null };
type NewProxy = z.output<typeof proxyInput>;

function errorRow(row: number, message: string): PreviewRow {
  return { row, username: '', accountLabel: '', profileLabel: '', proxyAddress: '', locale: '', timezone: '', status: 'error', message };
}

function addressFor(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function validate(candidate: ImportCandidate) {
  const account = accountInput.parse({
    label: candidate.accountLabel,
    username: candidate.username,
    notes: candidate.notes,
  });
  if (!account.username) throw new InputError('请填写 X 用户名。');

  const proxy = proxyInput.parse({
    label: candidate.username,
    host: candidate.proxyHost,
    port: candidate.proxyPort,
    username: candidate.proxyUsername,
    password: candidate.proxyPassword,
  });
  checkProxyCredentials(proxy.username, proxy.password ?? '');

  const profile = profileSettings.parse({
    label: candidate.profileLabel,
    locale: candidate.locale,
    timezone: candidate.timezone,
    width: candidate.width,
    height: candidate.height,
  });
  return { account, proxy: { ...proxy, label: addressFor(proxy.host, proxy.port).slice(0, 80) }, profile };
}

type PlannedImport = ReturnType<typeof validate> & { accountId: string | undefined };

function planImport(input: ImportInput) {
  const parsed = parseImportCsv(input.format, input.csv);
  const ready: PlannedImport[] = [];
  const handles = new Set<string>();
  const preview: PreviewRow[] = parsed.map((entry) => {
    if ('error' in entry) return errorRow(entry.row, entry.error);
    try {
      const data = validate(entry.candidate);
      const handle = data.account.username.toLowerCase();
      if (handles.has(handle)) throw new InputError('此用户名在文件中重复，请保留一行。');
      handles.add(handle);

      const existing = row<{
        id: string; label: string; profileLabel: string | null; locale: string | null; timezone: string | null;
        host: string | null; port: number | null;
      }>(`
        SELECT accounts.id, accounts.label, profiles.label AS profileLabel,
          profiles.locale, profiles.timezone, proxies.host, proxies.port
        FROM accounts
        LEFT JOIN profiles ON profiles.accountId = accounts.id
        LEFT JOIN proxies ON proxies.id = profiles.proxyId
        WHERE accounts.username = ? COLLATE NOCASE
      `, handle);
      const display = {
        row: entry.row,
        username: data.account.username,
        accountLabel: existing?.label ?? data.account.label,
        profileLabel: data.profile.label,
        proxyAddress: addressFor(data.proxy.host, data.proxy.port),
        locale: data.profile.locale,
        timezone: data.profile.timezone,
      };
      if (existing?.profileLabel) {
        return {
          ...display,
          profileLabel: existing.profileLabel,
          locale: existing.locale ?? '',
          timezone: existing.timezone ?? '',
          proxyAddress: existing.host && existing.port ? addressFor(existing.host, existing.port) : '',
          status: 'skip',
          message: '已有浏览器环境，保留原绑定。',
        };
      }
      ready.push({ ...data, accountId: existing?.id });
      return { ...display, status: 'ready', message: existing ? '为现有账号创建环境。' : '创建账号和绑定环境。' };
    } catch (error) {
      if (error instanceof InputError) return errorRow(entry.row, error.message);
      if (error instanceof z.ZodError) return errorRow(entry.row, error.issues[0]?.message || '请检查该行配置。');
      throw error;
    }
  });
  return { ready, preview, skipped: preview.filter((r) => r.status === 'skip').length,
    errors: preview.filter((r) => r.status === 'error').length };
}

function findOrCreateProxy(proxy: NewProxy) {
  const matches = rows<StoredProxy>(
    'SELECT id, password FROM proxies WHERE host = ? COLLATE NOCASE AND port = ? AND username = ? ORDER BY rowid',
    proxy.host, proxy.port, proxy.username,
  );
  const exact = matches.find(({ password }) => (password ? reveal(password) : '') === (proxy.password || ''));
  return exact?.id ?? createProxy(proxy);
}

imports.post('/preview', (req, res) => {
  const { ready, preview, skipped, errors } = planImport(importInput.parse(req.body));
  res.json({ rows: preview, ready: ready.length, skipped, errors });
});

imports.post('/commit', (req, res) => {
  const input = importInput.parse(req.body);
  const db = workspaceDb();
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    const { ready, skipped, errors } = planImport(input);
    if (errors) throw new InputError('还有需要修正的行。请重新预览并处理错误。', 409);
    if (!ready.length) throw new InputError('没有需要导入的行。请重新预览。', 409);
    for (const { account, proxy, profile, accountId } of ready) {
      createProfile({
        ...profile,
        accountId: accountId ?? createAccount(account),
        proxyId: findOrCreateProxy(proxy),
      });
    }
    result = { ok: true, imported: ready.length, skipped };
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  res.json(result);
});
