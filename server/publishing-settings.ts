import { Router } from 'express';
import { z } from 'zod';
import type { PublishingMethod, PublishingSettings } from '../src/publishing.js';
import { db, reveal, seal } from './store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS x_publishing_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    method TEXT NOT NULL CHECK (method IN ('official', 'mcp')),
    clientId TEXT NOT NULL,
    encryptedSecret TEXT
  ) STRICT;
`);

type SavedSettings = { method: PublishingMethod; clientId: string; encryptedSecret: string | null };
export type XAuthSettings = { clientId: string; clientSecret: string; redirectUri: string };

function savedSettings() {
  return db.prepare('SELECT method, clientId, encryptedSecret FROM x_publishing_settings WHERE id = 1').get() as SavedSettings | undefined;
}

function env(name: string) {
  return process.env[name]?.trim() ?? '';
}

function currentSettings(saved = savedSettings()) {
  const method = saved?.method ?? 'official';
  const clientId = saved?.clientId ?? env('X_CLIENT_ID');
  const redirectUri = env('X_REDIRECT_URI') || `${env('NODEX_PUBLIC_ORIGIN') || `http://127.0.0.1:${env('PORT') || '4173'}`}/api/x/callback`;
  let validRedirect = false;
  try {
    const url = new URL(redirectUri);
    validRedirect = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    // The operator can read the configured value without enabling a bad callback.
  }
  const xConfigured = method === 'official' && Boolean(clientId && validRedirect) &&
    (Boolean(saved) || env('NODEX_X_PUBLISH_MODE') !== 'browser');
  return { method, clientId, redirectUri, xConfigured };
}

export function publishingStatus() {
  const { method, xConfigured } = currentSettings();
  return { publishingMethod: method, xConfigured };
}

export function xAuthSettings(): XAuthSettings | undefined {
  const saved = savedSettings();
  const { clientId, redirectUri, xConfigured } = currentSettings(saved);
  if (!xConfigured) return;
  const clientSecret = saved ? saved.encryptedSecret ? reveal(saved.encryptedSecret) : '' : env('X_CLIENT_SECRET');
  return { clientId, clientSecret, redirectUri };
}

function operatorSettings(): PublishingSettings {
  const saved = savedSettings();
  return {
    ...currentSettings(saved),
    hasClientSecret: Boolean(saved ? saved.encryptedSecret : env('X_CLIENT_SECRET')),
  };
}

const settingsInput = z.object({
  method: z.enum(['official', 'mcp']),
  clientId: z.string().trim().max(250).regex(/^[a-z0-9_-]*$/i, 'Client ID 格式无效。').optional(),
  clientSecret: z.string().trim().min(1).max(1024).regex(/^[!-~]+$/, 'Client Secret 格式无效。').nullable().optional(),
});

export const publishingOperator = Router();
publishingOperator.get('/publishing', (_req, res) => { res.json(operatorSettings()); });
publishingOperator.patch('/publishing', (req, res) => {
  const input = settingsInput.parse(req.body);
  const saved = savedSettings();
  const current = currentSettings(saved);
  const clientId = input.clientId ?? current.clientId;
  const envSecret = saved ? '' : env('X_CLIENT_SECRET');
  const priorSecret = clientId === current.clientId ? saved?.encryptedSecret ?? (envSecret ? seal(envSecret) : null) : null;
  const encryptedSecret = input.clientSecret === undefined ? priorSecret : input.clientSecret === null ? null : seal(input.clientSecret);
  db.prepare(`
    INSERT INTO x_publishing_settings (id, method, clientId, encryptedSecret) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET method = excluded.method, clientId = excluded.clientId, encryptedSecret = excluded.encryptedSecret
  `).run(input.method, clientId, encryptedSecret);
  res.json(operatorSettings());
});
