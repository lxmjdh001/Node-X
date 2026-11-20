import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const workspace = new AsyncLocalStorage<string | null>();
const customers = new Map<string, DatabaseSync>();
const MAX_OPEN_DATABASES = 32;
const CUSTOMER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function isCustomerWorkspace(): boolean {
  return workspaceId() !== undefined;
}

export function workspaceId(): string | undefined {
  return workspace.getStore() ?? undefined;
}

export function runInWorkspace<T>(customerId: string | undefined, action: () => T): T {
  return workspace.run(customerId ?? null, action);
}

export function customerWorkspaceIds(): string[] {
  const directory = resolve(dataDirectory, 'customers');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && CUSTOMER_ID.test(entry.name))
    .map((entry) => entry.name);
}

export function workspaceDirectory(): string {
  const id = workspace.getStore();
  if (!id) return dataDirectory;
  if (!CUSTOMER_ID.test(id)) throw new Error('Invalid workspace ID');
  return resolve(dataDirectory, 'customers', id);
}

function openDatabase(directory: string): DatabaseSync {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = resolve(directory, 'nodex.sqlite');
  const db = new DatabaseSync(databasePath);
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
    height INTEGER NOT NULL,
    deviceScaleFactor REAL NOT NULL DEFAULT 1,
    colorScheme TEXT NOT NULL DEFAULT 'light',
    reducedMotion TEXT NOT NULL DEFAULT 'no-preference'
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
  CREATE TABLE IF NOT EXISTS pending_posts (
    id TEXT PRIMARY KEY,
    batchId TEXT NOT NULL,
    sourceUrl TEXT,
    text TEXT NOT NULL,
    variant INTEGER NOT NULL,
    generatedBy TEXT,
    createdAt TEXT NOT NULL,
    UNIQUE (batchId, variant)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS pending_post_assignments (
    pendingPostId TEXT NOT NULL REFERENCES pending_posts(id) ON DELETE CASCADE,
    accountId TEXT NOT NULL REFERENCES accounts(id),
    draftId TEXT NOT NULL UNIQUE REFERENCES drafts(id) ON DELETE CASCADE,
    PRIMARY KEY (pendingPostId, accountId)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS ai_models (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    encryptedKey TEXT NOT NULL,
    UNIQUE (provider, model)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS ai_defaults (
    purpose TEXT PRIMARY KEY CHECK (purpose IN ('writing', 'publishing')),
    modelId TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE
  ) STRICT;
`);
  const migrations = [
    { table: 'profiles', column: 'deviceScaleFactor', definition: 'REAL NOT NULL DEFAULT 1' },
    { table: 'profiles', column: 'colorScheme', definition: "TEXT NOT NULL DEFAULT 'light'" },
    { table: 'profiles', column: 'reducedMotion', definition: "TEXT NOT NULL DEFAULT 'no-preference'" },
    { table: 'pending_posts', column: 'generatedBy', definition: 'TEXT' },
  ];
  const missingColumns = () => migrations.filter(({ table, column }) =>
    !db.prepare(`PRAGMA table_info(${table})`).all().some(info => info.name === column));
  if (missingColumns().length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { table, column, definition } of missingColumns()) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  return db;
}

export const db = openDatabase(dataDirectory);

export function workspaceDb(): DatabaseSync {
  const id = workspace.getStore();
  if (!id) return db;
  const cached = customers.get(id);
  if (cached) {
    customers.delete(id);
    customers.set(id, cached);
    return cached;
  }
  if (customers.size >= MAX_OPEN_DATABASES) {
    const oldest = customers.keys().next().value;
    if (oldest) {
      customers.get(oldest)?.close();
      customers.delete(oldest);
    }
  }
  const database = openDatabase(workspaceDirectory());
  customers.set(id, database);
  return database;
}

export function closeDatabases(): void {
  for (const database of customers.values()) database.close();
  customers.clear();
  db.close();
}

export function row<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
  return workspaceDb().prepare(sql).get(...args) as T | undefined;
}

export function rows<T>(sql: string, ...args: SQLInputValue[]): T[] {
  return workspaceDb().prepare(sql).all(...args) as T[];
}

export function write(sql: string, ...args: SQLInputValue[]): number {
  return Number(workspaceDb().prepare(sql).run(...args).changes);
}
