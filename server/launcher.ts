import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { launcherConfig, ticketPattern } from '../launcher/protocol.js';
import { sessionHasAccess } from './auth.js';
import { InputError } from './errors.js';
import { runInWorkspace, workspaceId } from './store.js';

type Ticket = {
  workspace: string | undefined;
  profile: string;
  authorized: () => boolean;
  expires: number;
};

export const clientLauncher = process.env.NODEX_CLIENT_LAUNCHER === '1';
export const launcherExtensionId = launcherConfig.extensionId;

const tickets = new Map<string, Ticket>();
const ticketMs = 60_000;

export function issueLauncherTicket(req: Request, res: Response, profile: string) {
  if (!clientLauncher) throw new InputError('本机启动器未启用。', 404);
  const now = Date.now();
  for (const [key, ticket] of tickets) {
    if (ticket.expires <= now) tickets.delete(key);
  }
  const workspace = workspaceId();
  const outstanding = [...tickets.values()].filter((ticket) => ticket.workspace === workspace).length;
  if (outstanding >= 12 || tickets.size >= 4096) throw new InputError('启动请求过多，请稍等再试。', 429);
  const token = randomBytes(32).toString('base64url');
  tickets.set(token, { profile, workspace, expires: now + ticketMs, authorized: sessionHasAccess(req) });
  res.json({ ticket: token });
}

export function redeemLauncherTicket(req: Request, res: Response, resolveProfile: (id: string) => unknown) {
  if (!clientLauncher) throw new InputError('本机启动器未启用。', 404);
  const { ticket } = req.body ?? {};
  if (typeof ticket !== 'string' || !ticketPattern.test(ticket)) throw new InputError('启动凭证无效。', 400);
  const issued = tickets.get(ticket);
  tickets.delete(ticket);
  if (!issued || issued.expires <= Date.now() || !issued.authorized()) {
    throw new InputError('启动凭证已失效，请回到工作台重新打开。', 401);
  }
  res.json(runInWorkspace(issued.workspace, () => resolveProfile(issued.profile)));
}
