import { ContentError, contentStatus, publishX, type XToken } from './content.js';
import { workspaceAuthorized } from './auth.js';
import { customerWorkspaceIds, row, runInWorkspace, write, reveal, seal } from './store.js';

export const publishable = "status IN ('draft', 'error')";

type PendingDraft = { id: string; text: string; accountId: string; token: string | null };
const workspaces = new Set<string | undefined>();
const active = new Map<string | undefined, Promise<void>>();
const MAX_CONCURRENT = 3;

function hasScheduled(): boolean {
  return Boolean(row("SELECT 1 FROM drafts WHERE status = 'scheduled' LIMIT 1"));
}

export function recoverPublishQueue() {
  for (const workspace of [undefined, ...customerWorkspaceIds()]) {
    runInWorkspace(workspace, () => {
      write(`UPDATE drafts SET status = 'uncertain', error = ? WHERE status = 'publishing'`,
        '上次运行在发布过程中中断。请先到 X 核对该帖子是否已经发出。');
      if (hasScheduled()) workspaces.add(workspace);
    });
  }
}

function nextDraft(): PendingDraft | undefined {
  return row<PendingDraft>(`
    SELECT drafts.id, drafts.text, drafts.accountId, accounts.token
    FROM drafts JOIN accounts ON accounts.id = drafts.accountId
    WHERE drafts.status = 'scheduled' AND scheduledAt <= ?
    ORDER BY scheduledAt LIMIT 1
  `, new Date().toISOString());
}

async function publishNext(workspace: string | undefined, draft: PendingDraft): Promise<void> {
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
    }, () => {
      if (!workspaceAuthorized(workspace)) throw new ContentError('WORKSPACE_EXPIRED', '客户授权已结束，帖文未发送，请续期后重新安排发布。', 403);
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

export function scheduleWorkspace(workspace: string | undefined) {
  workspaces.add(workspace);
  runPublishQueue();
}

export function runPublishQueue() {
  const configured = contentStatus().xConfigured;
  for (const workspace of [...workspaces]) {
    if (active.has(workspace)) continue;
    try {
      runInWorkspace(workspace, () => {
        if (!workspaceAuthorized(workspace)) {
          write("UPDATE drafts SET status = 'error', error = ?, scheduledAt = NULL WHERE status = 'scheduled'",
            '客户授权已结束，帖文未发送，请续期后重新安排发布。');
          workspaces.delete(workspace);
          return;
        }
        if (!configured || active.size >= MAX_CONCURRENT) return;
        const draft = nextDraft();
        if (!draft) {
          if (!hasScheduled()) workspaces.delete(workspace);
          return;
        }
        // Move this workspace to the back before the next scheduling pass.
        workspaces.delete(workspace);
        workspaces.add(workspace);
        active.set(workspace, publishNext(workspace, draft).catch(logQueueError).finally(() => {
          active.delete(workspace);
        }));
      });
    } catch {
      logQueueError();
    }
  }
}

function logQueueError() {
  console.error('发布队列暂时无法更新数据库。请检查磁盘，并在重启后核对处理中任务。');
}

export async function waitForPublisher() {
  await Promise.all(active.values());
}
