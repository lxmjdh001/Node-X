import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { beginXAuthorization, ContentError, contentStatus, finishXAuthorization, generateDraft, validatePostText } from './content.js';
import { InputError, requireFound } from './errors.js';
import { publishable, runPublishQueue } from './publisher.js';
import { row, seal, write } from './store.js';
import { accountById } from './workspace.js';

export const editor = Router();
const pending = new Map<string, { accountId: string; verifier: string; nonce: string; expires: number }>();
const oauthCookie = 'nodex_oauth';
const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, path: '/api/x' };
const ok = { ok: true };
const creationInput = z.object({
  accountId: z.uuid(),
  prompt: z.string().trim().max(4000, '写作要求最多 4000 个字符。').default(''),
  text: z.string().max(8000, '草稿最多 8000 个字符。').optional(),
});
const textInput = z.object({ text: z.string().max(8000, '草稿最多 8000 个字符。') });
const scheduleInput = z.object({ scheduledAt: z.iso.datetime({ offset: true }).optional() });
type Draft = { id: string; accountId: string; text: string; status: string };

const draftById = (id: string) => requireFound(row<Draft>('SELECT * FROM drafts WHERE id = ?', id), '找不到这条草稿。');

function addDraft(accountId: string, prompt: string, text: string) {
  const id = randomUUID();
  write('INSERT INTO drafts (id, accountId, prompt, text, createdAt) VALUES (?, ?, ?, ?, ?)',
    id, accountId, prompt, text, new Date().toISOString());
  return id;
}

function assertAccountIdle(accountId: string) {
  if (row("SELECT 1 FROM drafts WHERE accountId = ? AND status IN ('scheduled', 'publishing') LIMIT 1", accountId)) {
    throw new InputError('该账号有待发布任务。请先取消或等发布完成。', 409);
  }
}

editor.get('/x/connect/:accountId', (req, res) => {
  const account = accountById(req.params.accountId);
  assertAccountIdle(account.id);
  if (!contentStatus().xConfigured) throw new InputError('请先在 .env 配置 X OAuth。', 409);
  const { url, codeVerifier, state } = beginXAuthorization();
  const nonce = randomBytes(24).toString('base64url');
  const maxAge = 10 * 60 * 1000;
  for (const [key, item] of pending) if (item.expires <= Date.now()) pending.delete(key);
  if (pending.size >= 100) throw new InputError('授权请求过多，请稍后再试。', 429);
  pending.set(state, { accountId: account.id, verifier: codeVerifier, nonce, expires: Date.now() + maxAge });
  res.cookie(oauthCookie, nonce, { ...cookieOptions, maxAge }).redirect(url);
});

editor.get('/x/callback', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const entry = pending.get(state);
  const cookie = req.headers.cookie?.match(/(?:^|;\s*)nodex_oauth=([^;]+)/)?.[1];
  if (!entry || entry.nonce !== cookie || entry.expires <= Date.now()) {
    res.redirect('/?x=error&reason=expired');
    return;
  }
  pending.delete(state);
  res.clearCookie(oauthCookie, cookieOptions);
  try {
    if (!code) throw new Error('Authorization declined.');
    const result = await finishXAuthorization(code, entry.verifier);
    const account = accountById(entry.accountId);
    assertAccountIdle(account.id);
    if ((account.username && account.username.toLowerCase() !== result.username.toLowerCase()) ||
      (account.xUserId && account.xUserId !== result.userId)) {
      res.redirect('/?x=error&reason=handle');
      return;
    }
    write('UPDATE accounts SET username = ?, xUserId = ?, xUsername = ?, token = ? WHERE id = ?',
      result.username, result.userId, result.username, seal(JSON.stringify(result.token)), account.id);
    res.redirect('/?x=connected');
  } catch {
    res.redirect('/?x=error');
  }
});

editor.post('/drafts', (req, res) => {
  const { accountId, prompt, text } = creationInput.parse(req.body);
  accountById(accountId);
  res.status(201).json({ ...ok, id: addDraft(accountId, prompt, text || '') });
});

editor.post('/drafts/generate', async (req, res) => {
  const { accountId, prompt } = creationInput.parse(req.body);
  const account = accountById(accountId);
  if (!prompt) throw new InputError('请填写写作要求。');
  if (!contentStatus().aiConfigured) throw new InputError('请在 .env 配置 AI 模型。', 409);
  let text: string;
  try {
    text = await generateDraft(prompt, account.xUsername || account.username || account.label);
  } catch (error) {
    if (error instanceof ContentError) throw new InputError(error.message, error.statusCode);
    throw new InputError('AI 草稿生成失败。', 502);
  }
  accountById(accountId);
  res.status(201).json({ ...ok, id: addDraft(accountId, prompt, text) });
});

editor.patch('/drafts/:id', (req, res) => {
  const { id } = draftById(req.params.id);
  const { text } = textInput.parse(req.body);
  if (!write(`UPDATE drafts SET text = ?, status = 'draft', error = NULL, scheduledAt = NULL
    WHERE id = ? AND ${publishable}`, text, id)) {
    throw new InputError('请先取消待发布任务。已发出或结果待确认的记录不能修改。', 409);
  }
  res.json(ok);
});

editor.delete('/drafts/:id', (req, res) => {
  const { id } = draftById(req.params.id);
  if (!write("DELETE FROM drafts WHERE id = ? AND status NOT IN ('scheduled', 'publishing')", id)) {
    throw new InputError('请先取消待发布任务或等待发布结束。', 409);
  }
  res.json(ok);
});

editor.post('/drafts/:id/publish', (req, res) => {
  const draft = draftById(req.params.id);
  const { scheduledAt } = scheduleInput.parse(req.body ?? {});
  const text = validatePostText(draft.text);
  if (!contentStatus().xConfigured || !accountById(draft.accountId).token) throw new InputError('请先为这个账号连接 X。', 409);
  const time = scheduledAt ? new Date(scheduledAt) : new Date();
  if (!Number.isFinite(time.getTime()) || (scheduledAt && time.getTime() < Date.now() - 5000)) {
    throw new InputError('请选择有效的未来发布时间。');
  }
  if (!write(`UPDATE drafts SET text = ?, status = 'scheduled', scheduledAt = ?, error = NULL
    WHERE id = ? AND ${publishable}`, text, time.toISOString(), draft.id)) {
    throw new InputError('这条记录无法再次发布。', 409);
  }
  runPublishQueue();
  res.status(202).json(ok);
});

editor.post('/drafts/:id/cancel', (req, res) => {
  const { id } = draftById(req.params.id);
  if (!write("UPDATE drafts SET status = 'draft', scheduledAt = NULL WHERE id = ? AND status = 'scheduled'", id)) {
    throw new InputError('只有等待发布的任务可以取消。', 409);
  }
  res.json(ok);
});
