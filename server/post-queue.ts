import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { MAX_POST_LINK, MAX_SOURCE_TEXT, MAX_VARIANTS } from '../src/post-queue.js';
import { addDraft } from './editor.js';
import { InputError, requireFound } from './errors.js';
import { postSource, readPostSource } from './post-source.js';
import { row, rows, workspaceDb, write } from './store.js';
import { accountById } from './workspace.js';

export const postQueue = Router();

const linkInput = z.string().trim().min(1).max(MAX_POST_LINK);
const batchInput = z.object({
  id: z.uuid(),
  text: z.string().max(MAX_SOURCE_TEXT).optional(),
  url: linkInput.optional(),
  count: z.number().int().min(0).max(MAX_VARIANTS),
});
const uniqueIds = z.array(z.uuid()).min(1).max(MAX_VARIANTS + 1)
  .refine(ids => new Set(ids).size === ids.length, '选择的记录存在重复。');
const distributionInput = z.object({
  mode: z.enum(['oneAccount', 'oneEach', 'samePost']),
  postIds: uniqueIds,
  accountIds: uniqueIds,
});
type QueuedPost = { id: string; sourceUrl: string | null; text: string };

const sampleHeadings = ['信息速览', '重点整理', '简明说明', '要点一览', '消息整理', '信息小结', '快速了解', '要点速记', '内容提要', '相关信息'];

function sampleText(source: string, index: number): string {
  const heading = sampleHeadings[index % sampleHeadings.length];
  const body = source.trim();
  const layouts = [
    `【${heading}】\n${body}`,
    `${heading}\n\n${body}`,
    `— ${heading} —\n${body}`,
    `▍${heading}\n\n${body}`,
    `〔${heading}〕\n\n${body}`,
  ];
  const candidate = layouts[Math.floor(index / sampleHeadings.length)];
  return candidate.length <= MAX_SOURCE_TEXT ? candidate
    : `【${heading} ${index + 1}】\n${body.slice(0, MAX_SOURCE_TEXT - heading.length - 9)}`;
}

function transaction<T>(action: () => T): T {
  const db = workspaceDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

postQueue.get('/pending-posts', (_req, res) => {
  const posts = rows(`
    SELECT p.id, p.sourceUrl, p.text, p.variant,
      (SELECT COUNT(*) FROM pending_post_assignments a WHERE a.pendingPostId = p.id) AS assignedCount
    FROM pending_posts p ORDER BY p.createdAt DESC, p.batchId, p.variant
  `);
  res.json({ posts });
});

postQueue.post('/pending-posts/source', async (req, res) => {
  const source = postSource(linkInput.parse(req.body?.url));
  res.json({ ...source, text: await readPostSource(source) });
});

postQueue.post('/pending-posts', async (req, res) => {
  const input = batchInput.parse(req.body);
  function existing() {
    return row<{ count: number }>('SELECT COUNT(*) AS count FROM pending_posts WHERE batchId = ?', input.id)?.count ?? 0;
  }
  const prior = existing();
  if (prior) {
    res.status(201).json({ count: prior });
    return;
  }
  const source = input.url ? postSource(input.url) : undefined;
  const sourceText = input.text?.trim() ? input.text : source ? await readPostSource(source) : '';
  if (!sourceText.trim()) throw new InputError('请输入原帖正文或帖子链接。');
  const createdAt = new Date().toISOString();
  const count = transaction(() => {
    const previous = existing();
    if (previous) return previous;
    for (let variant = 0; variant <= input.count; variant++) {
      const text = variant === 0 ? sourceText : sampleText(sourceText, variant - 1);
      write('INSERT INTO pending_posts (id, batchId, sourceUrl, text, variant, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        randomUUID(), input.id, source?.url ?? null, text, variant, createdAt);
    }
    return input.count + 1;
  });
  res.status(201).json({ count });
});

postQueue.post('/pending-posts/assign', (req, res) => {
  const { mode, postIds, accountIds } = distributionInput.parse(req.body);
  if (mode === 'oneAccount' && accountIds.length !== 1) throw new InputError('此方式需要选择一个账号。');
  if (mode === 'oneEach' && (postIds.length < 2 || postIds.length !== accountIds.length)) {
    throw new InputError('请为每条帖子分别选择一个不同的账号。');
  }
  if (mode === 'samePost' && (postIds.length !== 1 || accountIds.length < 2)) {
    throw new InputError('请选择一条帖子和至少两个账号。');
  }
  const result = transaction(() => {
    const posts = postIds.map(id => requireFound(row<QueuedPost>('SELECT id, sourceUrl, text FROM pending_posts WHERE id = ?', id), '找不到选中的帖子。'));
    const accounts = accountIds.map(accountById);
    const pairs = mode === 'samePost'
      ? accounts.map(account => [posts[0], account] as const)
      : posts.map((post, index) => [post, accounts[mode === 'oneEach' ? index : 0]] as const);
    let created = 0;
    for (const [post, account] of pairs) {
      if (row('SELECT 1 FROM pending_post_assignments WHERE pendingPostId = ? AND accountId = ?', post.id, account.id)) continue;
      const draft = addDraft(account.id, post.sourceUrl ?? '', post.text);
      write('INSERT INTO pending_post_assignments (pendingPostId, accountId, draftId) VALUES (?, ?, ?)', post.id, account.id, draft);
      created++;
    }
    return { created, existing: pairs.length - created };
  });
  res.status(201).json(result);
});
