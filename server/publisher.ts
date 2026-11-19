import { ContentError, contentStatus, publishX, type XToken } from './content.js';
import { row, write, reveal, seal } from './store.js';

export const publishable = "status IN ('draft', 'error')";

type PendingDraft = { id: string; text: string; accountId: string; token: string | null };
let active: Promise<void> | undefined;

export function recoverPublishQueue() {
  write(`UPDATE drafts SET status = 'uncertain', error = ? WHERE status = 'publishing'`,
    '上次运行在发布过程中中断。请先到 X 核对该帖子是否已经发出。');
}

async function publishNext(): Promise<void> {
  const draft = row<PendingDraft>(`
    SELECT drafts.id, drafts.text, drafts.accountId, accounts.token
    FROM drafts JOIN accounts ON accounts.id = drafts.accountId
    WHERE drafts.status = 'scheduled' AND scheduledAt <= ?
    ORDER BY scheduledAt LIMIT 1
  `, new Date().toISOString());
  if (!draft) return;
  if (!write("UPDATE drafts SET status = 'publishing', error = NULL WHERE id = ? AND status = 'scheduled'", draft.id)) return;

  let token: XToken;
  try {
    if (!draft.token) throw new Error('Missing token');
    token = JSON.parse(reveal(draft.token)) as XToken;
  } catch {
    write("UPDATE drafts SET status = 'error', error = ? WHERE id = ?",
      '账号授权不可用，请重新连接 X 后再发布。', draft.id);
    return;
  }

  try {
    const { postId } = await publishX(token, draft.text, (next) => {
      write('UPDATE accounts SET token = ? WHERE id = ?', seal(JSON.stringify(next)), draft.accountId);
    });
    write("UPDATE drafts SET status = 'published', postId = ? WHERE id = ?", postId, draft.id);
  } catch (error) {
    const failed = error instanceof ContentError && error.outcome === 'failed';
    write('UPDATE drafts SET status = ?, error = ? WHERE id = ?',
      failed ? 'error' : 'uncertain',
      failed ? error.message : '无法确认发布结果。请先到 X 核对该帖子是否已经发出。',
      draft.id);
  }
}

export function runPublishQueue() {
  if (active || !contentStatus().xConfigured) return;
  active = publishNext().catch(() => {
    console.error('发布队列暂时无法更新数据库。请检查磁盘，并在重启后核对处理中任务。');
  }).finally(() => { active = undefined; });
}

export async function waitForPublisher() {
  await active;
}
