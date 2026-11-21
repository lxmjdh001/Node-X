import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { sessionHasAccess, workspaceAuthorized } from './auth.js';
import { InputError, requireFound } from './errors.js';
import { reveal, row, rows, runInWorkspace, seal, workspaceDb, workspaceId, write } from './store.js';

export const dm = Router();
export const dmConnector = Router();

const maxInbox = 500;
const maxMessages = 150;
const onlineMs = 135_000;
const claimMs = 90_000;
const ticketMs = 300_000;
const id = z.uuid();
const remoteId = z.string().min(1).max(512);
const requestId = z.string().min(1).max(128);
const labelSchema = z.string().trim().min(1).max(32);
const timestamp = z.iso.datetime({ offset: true })
  .refine(value => Number.isFinite(Date.parse(value)), '私信时间无效。')
  .transform(value => new Date(value).toISOString());
const tokenPattern = /^(owner|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const eventsInput = z.object({
  conversations: z.array(z.object({
    id: remoteId,
    title: z.string().trim().min(1).max(250),
    messages: z.array(z.object({
      id: remoteId,
      text: z.string().max(10_000),
      sender: z.string().max(250),
      createdAt: timestamp,
      direction: z.enum(['in', 'out']),
    })).max(200),
  })).max(50),
}).refine(input => input.conversations.reduce((count, conversation) => count + conversation.messages.length, 0) <= 200,
  '每批最多同步 200 条私信。');
const bulkInput = z.object({
  ids: z.array(id).min(1).max(maxInbox).refine(values => new Set(values).size === values.length, '会话不能重复选择。'),
  action: z.enum(['resolve', 'reopen', 'read', 'label', 'unlabel']),
  label: labelSchema.optional(),
});
const replyInput = z.object({ text: z.string().trim().min(1).max(5000), requestId });
const resultInput = z.object({
  status: z.enum(['sent', 'failed', 'uncertain']),
  remoteId: remoteId.optional(),
}).refine(value => value.status === 'sent' || value.remoteId === undefined, '只有已发送的回复可以关联远程消息。');

type Ticket = {
  workspace: string | undefined;
  accountId: string;
  authorize: () => boolean;
  expires: number;
};
const tickets = new Map<string, Ticket>();
type Account = { id: string; label: string; username: string; xUserId: string | null };
type Connection = { accountId: string; tokenHash: string; lastSeenAt: string; lastSyncAt: string | null };
type Conversation = {
  id: string;
  accountId: string;
  remoteId: string;
  title: string;
  preview: string;
  updatedAt: string;
  status: 'open' | 'resolved';
  unread: number;
  labels: string;
};
type Status = 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain';
type Message = {
  id: string;
  conversationId: string;
  remoteId: string | null;
  text: string;
  sender: string;
  createdAt: string;
  direction: 'in' | 'out';
  status: Status | null;
  claimedBy: string | null;
};

const now = () => new Date().toISOString();
const before = (ms: number) => new Date(Date.now() - ms).toISOString();

function tokenHash(token: string) {
  return createHash('sha256').update(`nodex:dm:${token}`).digest('hex');
}

function transaction<T>(work: () => T): T {
  const database = workspaceDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function account(id: string) {
  return requireFound(row<Account>('SELECT id, label, username, xUserId FROM accounts WHERE id = ?', id), '找不到这个 X 账号。');
}

function conversation(id: string) {
  return requireFound(row<Conversation>('SELECT * FROM dm_conversations WHERE id = ?', id), '找不到这个私信会话。');
}

function clearTickets(accountId: string, workspace: string | undefined) {
  for (const [key, ticket] of tickets) {
    if (ticket.expires <= Date.now() || (ticket.workspace === workspace && ticket.accountId === accountId)) tickets.delete(key);
  }
}

function device<T>(req: Request, work: (connection: Connection) => T): T {
  const token = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  const parts = token?.match(tokenPattern);
  if (!token || !parts) throw new InputError('私信连接凭证无效。', 401);
  const workspace = parts[1] === 'owner' ? undefined : parts[1];
  if (!workspaceAuthorized(workspace)) throw new InputError('工作空间授权已失效。', 401);
  return runInWorkspace(workspace, () => {
    const connection = row<Connection>('SELECT * FROM dm_connections WHERE tokenHash = ?', tokenHash(token));
    if (!connection) throw new InputError('私信连接已失效，请重新连接。', 401);
    return work(connection);
  });
}

function expireClaims() {
  write("UPDATE dm_messages SET status = 'uncertain' WHERE status = 'sending' AND claimedAt < ?", before(claimMs));
}

function cancelReplies(accountId: string) {
  write(`
    UPDATE dm_messages SET status = CASE status WHEN 'queued' THEN 'failed' ELSE 'uncertain' END
    WHERE status IN ('queued', 'sending') AND conversationId IN (SELECT id FROM dm_conversations WHERE accountId = ?)
  `, accountId);
}

function messageView(message: Message) {
  const { id, text, sender, createdAt, direction, status } = message;
  return {
    id, text: reveal(text), sender: reveal(sender), createdAt, direction,
    ...(status ? { status: status === 'sending' ? 'queued' : status } : {}),
  };
}

function updatePreview(id: string, text: string, createdAt: string, inbound: boolean) {
  write(`
    UPDATE dm_conversations SET preview = ?, updatedAt = ?,
      unread = CASE WHEN ? THEN 1 ELSE unread END,
      status = CASE WHEN ? THEN 'open' ELSE status END
    WHERE id = ? AND updatedAt <= ?
  `, seal(text.slice(0, 300)), createdAt, Number(inbound), Number(inbound), id, createdAt);
}

dm.get('/dm/inbox', (req, res) => {
  const accountId = z.uuid().optional().parse(req.query.accountId);
  const cursorId = id.optional().parse(req.query.before);
  const cursor = cursorId ? conversation(cursorId) : undefined;
  if (cursor && accountId && cursor.accountId !== accountId) throw new InputError('会话游标与账号不匹配。');
  const accounts = rows<Account & { lastSeenAt: string | null; lastSyncAt: string | null }>(`
    SELECT accounts.id, accounts.label, accounts.username, d.lastSeenAt, d.lastSyncAt
    FROM accounts LEFT JOIN dm_connections d ON d.accountId = accounts.id ORDER BY accounts.createdAt DESC
  `).map(({ lastSeenAt, ...account }) => ({ ...account, connected: lastSeenAt !== null && lastSeenAt > before(onlineMs) }));
  const result = rows<Conversation>(`
    SELECT * FROM dm_conversations WHERE (? IS NULL OR accountId = ?)
      AND (? IS NULL OR (updatedAt, id) < (?, ?)) ORDER BY updatedAt DESC, id DESC LIMIT ?
  `, accountId ?? null, accountId ?? null, cursor?.id ?? null, cursor?.updatedAt ?? null, cursor?.id ?? null, maxInbox + 1);
  const conversations = result.slice(0, maxInbox).map(({ id, accountId, title, preview, updatedAt, status, unread, labels }) => ({
    id, accountId, title: reveal(title), preview: reveal(preview), updatedAt, status, unread: Boolean(unread),
    labels: JSON.parse(labels) as string[],
  }));
  res.json({ accounts, conversations, before: result.length > maxInbox ? result[maxInbox - 1].id : null });
});

dm.get('/dm/conversations/:id/messages', (req, res) => {
  const current = conversation(id.parse(req.params.id));
  const cursorId = id.optional().parse(req.query.before);
  const cursor = cursorId ? requireFound(row<{ id: string; createdAt: string }>(
    'SELECT id, createdAt FROM dm_messages WHERE id = ? AND conversationId = ?', cursorId, current.id,
  ), '找不到这条私信。') : undefined;
  expireClaims();
  const messages = rows<Message>(`
    SELECT * FROM dm_messages WHERE conversationId = ?
      AND (? IS NULL OR (createdAt, id) < (?, ?))
    ORDER BY createdAt DESC, id DESC LIMIT ?
  `, current.id, cursor?.id ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, maxMessages + 1);
  const next = messages.length > maxMessages ? messages[maxMessages - 1].id : null;
  res.json({ messages: messages.slice(0, maxMessages).reverse().map(messageView), before: next });
});

dm.post('/dm/conversations/bulk-update', (req, res) => {
  const { ids, action, label } = bulkInput.parse(req.body);
  if ((action === 'label' || action === 'unlabel') && !label) throw new InputError('请填写标签。');
  const updated = transaction(() => {
    const targets = ids.map(conversation);
    let count = 0;
    for (const target of targets) {
      if (action === 'resolve' || action === 'reopen') {
        const next = action === 'resolve' ? 'resolved' : 'open';
        if (target.status !== next) count += write('UPDATE dm_conversations SET status = ? WHERE id = ?', next, target.id);
      } else if (action === 'read') {
        if (target.unread) count += write('UPDATE dm_conversations SET unread = 0 WHERE id = ?', target.id);
      } else if (label) {
        const labels = JSON.parse(target.labels) as string[];
        const hasLabel = labels.includes(label);
        if (action === 'label' && !hasLabel && labels.length >= 16) throw new InputError('每条会话最多添加 16 个标签。');
        if (hasLabel !== (action === 'label')) {
          const next = hasLabel ? labels.filter(value => value !== label) : [...labels, label];
          count += write('UPDATE dm_conversations SET labels = ? WHERE id = ?', JSON.stringify(next), target.id);
        }
      }
    }
    return count;
  });
  res.json({ ok: true, updated, skipped: ids.length - updated });
});

dm.post('/dm/conversations/:id/replies', (req, res) => {
  const current = conversation(id.parse(req.params.id));
  const { text, requestId } = replyInput.parse(req.body);
  const message = transaction(() => {
    expireClaims();
    const existing = row<Message>('SELECT * FROM dm_messages WHERE requestId = ?', requestId);
    if (existing) {
      if (existing.conversationId !== current.id || reveal(existing.text) !== text) {
        throw new InputError('这次发送与已有请求不一致。', 409);
      }
      return existing;
    }
    if (!row('SELECT 1 FROM dm_connections WHERE accountId = ? AND lastSeenAt > ?', current.accountId, before(onlineMs))) {
      throw new InputError('这个 X 账号的私信连接已离线。', 409);
    }
    const sender = account(current.accountId);
    const messageId = randomUUID();
    write(`
      INSERT INTO dm_messages (id, conversationId, requestId, text, sender, createdAt, direction, status)
      VALUES (?, ?, ?, ?, ?, ?, 'out', 'queued')
    `, messageId, current.id, requestId, seal(text), seal(sender.username || sender.label), now());
    return requireFound(row<Message>('SELECT * FROM dm_messages WHERE id = ?', messageId));
  });
  res.status(202).json({ message: messageView(message) });
});

dm.post('/dm/accounts/:id/connect-ticket', (req, res) => {
  const boundAccount = account(id.parse(req.params.id));
  const workspace = workspaceId();
  clearTickets(boundAccount.id, workspace);
  if (tickets.size >= 500) throw new InputError('连接请求过多，请稍后再试。', 429);
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, { accountId: boundAccount.id, workspace, authorize: sessionHasAccess(req), expires: Date.now() + ticketMs });
  res.json({ ticket, expiresAt: new Date(Date.now() + ticketMs).toISOString() });
});

dm.post('/dm/accounts/:id/disconnect', (req, res) => {
  const boundAccount = account(id.parse(req.params.id));
  clearTickets(boundAccount.id, workspaceId());
  transaction(() => {
    cancelReplies(boundAccount.id);
    write('DELETE FROM dm_connections WHERE accountId = ?', boundAccount.id);
  });
  res.json({ ok: true });
});

dmConnector.post('/pair', (req, res) => {
  const { ticket, xUserId } = z.object({
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    xUserId: z.string().regex(/^[1-9][0-9]{0,29}$/).optional(),
  }).parse(req.body);
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry || entry.expires <= Date.now() || !entry.authorize() || !workspaceAuthorized(entry.workspace)) {
    throw new InputError('连接凭证已失效，请回到工作台重新生成。', 401);
  }
  const token = `${entry.workspace ?? 'owner'}.${randomBytes(32).toString('base64url')}`;
  const boundAccount = runInWorkspace(entry.workspace, () => transaction(() => {
    const current = account(entry.accountId);
    const last = row<{ xUserId: string | null }>('SELECT xUserId FROM dm_connections WHERE accountId = ?', current.id);
    const expected = current.xUserId ?? last?.xUserId;
    if (expected && xUserId && expected !== xUserId) {
      throw new InputError('私信桥接的 X 账号与所选账号不一致。', 409);
    }
    cancelReplies(entry.accountId);
    write(`
      INSERT INTO dm_connections (accountId, tokenHash, xUserId, lastSeenAt)
      VALUES (?, ?, ?, ?) ON CONFLICT(accountId) DO UPDATE SET
      tokenHash = excluded.tokenHash, xUserId = excluded.xUserId, lastSeenAt = excluded.lastSeenAt
    `, current.id, tokenHash(token), expected ?? xUserId ?? null, now());
    return { ...current, xUserId: expected ?? xUserId ?? null };
  }));
  res.json({ token, account: boundAccount });
});

dmConnector.post('/events', (req, res) => {
  const input = eventsInput.parse(req.body);
  const received = device(req, connection => transaction(() => {
    let count = 0;
    for (const item of input.conversations) {
      const messages = [...item.messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      if (!messages.length) {
        write('UPDATE dm_conversations SET title = ? WHERE accountId = ? AND remoteId = ?',
          seal(item.title), connection.accountId, item.id);
        continue;
      }
      write(`
        INSERT INTO dm_conversations (id, accountId, remoteId, title, preview, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(accountId, remoteId) DO UPDATE SET title = excluded.title
      `, randomUUID(), connection.accountId, item.id, seal(item.title), seal(''), messages[0].createdAt);
      const current = requireFound(row<{ id: string }>(
        'SELECT id FROM dm_conversations WHERE accountId = ? AND remoteId = ?', connection.accountId, item.id,
      ));
      for (const message of messages) {
        const inserted = write(`
          INSERT INTO dm_messages (id, conversationId, remoteId, text, sender, createdAt, direction)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversationId, remoteId) DO NOTHING
        `, randomUUID(), current.id, message.id, seal(message.text), seal(message.sender), message.createdAt, message.direction);
        if (inserted) updatePreview(current.id, message.text, message.createdAt, message.direction === 'in');
        count += inserted;
      }
    }
    const time = now();
    write('UPDATE dm_connections SET lastSeenAt = ?, lastSyncAt = ? WHERE tokenHash = ?', time, time, connection.tokenHash);
    return count;
  }));
  res.json({ received });
});

dmConnector.post('/jobs/claim', (req, res) => {
  const jobs = device(req, connection => transaction(() => {
    expireClaims();
    const current = row<{ id: string; conversationId: string; text: string }>(`
      SELECT m.id, c.remoteId AS conversationId, m.text FROM dm_messages m
      JOIN dm_conversations c ON c.id = m.conversationId
      WHERE c.accountId = ? AND m.status = 'queued' ORDER BY m.createdAt, m.id LIMIT 1
    `, connection.accountId);
    const time = now();
    write('UPDATE dm_connections SET lastSeenAt = ? WHERE tokenHash = ?', time, connection.tokenHash);
    if (!current) return [];
    write("UPDATE dm_messages SET status = 'sending', claimedAt = ?, claimedBy = ? WHERE id = ?",
      time, connection.tokenHash, current.id);
    return [{ ...current, text: reveal(current.text) }];
  }));
  res.json({ jobs });
});

dmConnector.post('/jobs/:id/result', (req, res) => {
  const messageId = id.parse(req.params.id);
  const { status, remoteId } = resultInput.parse(req.body);
  device(req, connection => transaction(() => {
    const job = requireFound(row<Message>(`
      SELECT m.* FROM dm_messages m JOIN dm_conversations c ON c.id = m.conversationId
      WHERE m.id = ? AND m.claimedBy = ? AND c.accountId = ?
    `, messageId, connection.tokenHash, connection.accountId), '找不到这条发送任务。');
    if (job.status === status && job.remoteId === (remoteId ?? null)) return;
    if (job.status !== 'sending' && !(job.status === 'uncertain' && status === 'sent')) {
      throw new InputError('发送任务状态已变化。', 409);
    }
    if (remoteId) {
      const echo = row<{ id: string; direction: 'in' | 'out'; createdAt: string }>(`
        SELECT id, direction, createdAt FROM dm_messages WHERE conversationId = ? AND remoteId = ?
      `, job.conversationId, remoteId);
      if (echo) {
        if (echo.direction !== 'out') throw new InputError('远程消息与发送任务不一致。', 409);
        write('DELETE FROM dm_messages WHERE id = ? AND requestId IS NULL', echo.id);
        write('UPDATE dm_messages SET createdAt = ? WHERE id = ?', echo.createdAt, job.id);
        job.createdAt = echo.createdAt;
      }
    }
    write('UPDATE dm_messages SET status = ?, remoteId = ? WHERE id = ?', status, remoteId ?? null, job.id);
    if (status === 'sent') updatePreview(job.conversationId, reveal(job.text), job.createdAt, false);
  }));
  res.json({ ok: true });
});
