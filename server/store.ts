import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export const dataDirectory = resolve(process.env.NODEX_DATA_DIR || './data');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

const keyPath = resolve(dataDirectory, 'secrets.key');
let secretKey: Buffer;
try {
  secretKey = readFileSync(keyPath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  try {
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (writeError) {
    if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
  }
  secretKey = readFileSync(keyPath);
}
if (secretKey.length !== 32) throw new Error('本地数据密钥无效。请从备份中恢复 data/secrets.key。');

export function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function reveal(value: string): string {
  const data = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', secretKey, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

const databasePath = resolve(dataDirectory, 'nodex.sqlite');
export const db = new DatabaseSync(databasePath);
chmodSync(databasePath, 0o600);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    username TEXT NOT NULL,
    notes TEXT NOT NULL,
    xUserId TEXT UNIQUE,
    xUsername TEXT,
    token TEXT,
    createdAt TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS unique_account_handle ON accounts (username COLLATE NOCASE) WHERE username != '';
  CREATE TABLE IF NOT EXISTS proxies (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    password TEXT,
    status TEXT NOT NULL DEFAULT 'unchecked',
    lastIp TEXT,
    latency INTEGER,
    checkedAt TEXT,
    checkError TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL UNIQUE REFERENCES accounts(id),
    proxyId TEXT NOT NULL REFERENCES proxies(id),
    label TEXT NOT NULL,
    locale TEXT NOT NULL,
    timezone TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS camoufox_links (
    managerPort INTEGER NOT NULL,
    accountId TEXT NOT NULL REFERENCES accounts(id),
    profileId TEXT,
    name TEXT NOT NULL,
    PRIMARY KEY (managerPort, accountId),
    UNIQUE (managerPort, profileId)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL REFERENCES accounts(id),
    prompt TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'scheduled', 'publishing', 'published', 'error', 'uncertain')),
    scheduledAt TEXT,
    postId TEXT,
    error TEXT,
    createdAt TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS due_drafts ON drafts (status, scheduledAt);
`);

export function row<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined;
}

export function rows<T>(sql: string, ...args: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...args) as T[];
}

export function write(sql: string, ...args: SQLInputValue[]): number {
  return Number(db.prepare(sql).run(...args).changes);
}
