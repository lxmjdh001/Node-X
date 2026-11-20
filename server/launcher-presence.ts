import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { launcherWorkspace } from '../launcher/protocol.js';
import { workspaceAuthorized } from './auth.js';
import { InputError } from './errors.js';
import { reveal, row, runInWorkspace, seal, workspaceId } from './store.js';

const reportCredentials = z.object({ workspace: launcherWorkspace, profile: z.uuid(), instance: z.uuid() });
const reportInput = z.object({ token: z.string().min(1).max(512), running: z.boolean() });
const purpose = 'launcher-presence:';
const timeout = 45_000;
const retention = 24 * 60 * 60_000;
const presence = new Map<string, { lastSeen: number; active: Map<string, number> }>();
let nextCleanup = 0;

export function createPresenceToken(workspace: string | undefined, profile: string): string {
  return seal(purpose + JSON.stringify({ workspace: workspace ?? 'owner', profile, instance: randomUUID() }));
}

function readCredentials(token: string) {
  try {
    const decoded = reveal(token);
    if (decoded.startsWith(purpose)) return reportCredentials.parse(JSON.parse(decoded.slice(purpose.length)));
  } catch {
    // Invalid or unrelated encrypted data cannot authorize a heartbeat.
  }
  throw new InputError('本机状态凭证无效。', 401);
}

export function reportLauncherPresence(req: Request, res: Response) {
  const { token, running } = reportInput.parse(req.body);
  const { workspace, profile, instance } = readCredentials(token);
  const customer = workspace === 'owner' ? undefined : workspace;
  if (!workspaceAuthorized(customer) || !runInWorkspace(customer, () => row('SELECT 1 FROM profiles WHERE id = ?', profile))) {
    throw new InputError('本机状态凭证已失效。', 401);
  }
  const key = `${workspace}:${profile}`;
  const current = presence.get(key) ?? { lastSeen: 0, active: new Map<string, number>() };
  current.lastSeen = Date.now();
  if (running) current.active.set(instance, current.lastSeen);
  else current.active.delete(instance);
  presence.set(key, current);
  res.status(204).end();
}

export function launcherPresence(profile: string) {
  const current = presence.get(`${workspaceId() ?? 'owner'}:${profile}`);
  if (!current) return null;
  const cutoff = Date.now() - timeout;
  return {
    running: [...current.active.values()].some((time) => time > cutoff),
    lastSeen: new Date(current.lastSeen).toISOString(),
  };
}

export function reapLauncherPresence(now = Date.now()) {
  if (now < nextCleanup) return;
  nextCleanup = now + 60_000;
  for (const [key, current] of presence) {
    if (current.lastSeen <= now - retention) {
      presence.delete(key);
      continue;
    }
    for (const [instance, seen] of current.active) {
      if (seen <= now - timeout) current.active.delete(instance);
    }
  }
}
