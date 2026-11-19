import {
  createHash, createPublicKey, randomBytes, randomUUID, scrypt, timingSafeEqual, verify,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';
import { Router, type CookieOptions, type Request, type RequestHandler, type Response } from 'express';
import { InputError } from './errors.js';
import { db, reveal, runInWorkspace, seal } from './store.js';
import { licenseExpiry, type LicenseUnit } from './license-duration.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const OPERATOR_SESSION_MS = 8 * 60 * 60 * 1000;
const CHALLENGE_MS = 2 * 60 * 1000;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const SESSION_COOKIE = 'nodex_session';
const OPERATOR_COOKIE = 'nodex_operator';

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_operator (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    publicKey TEXT NOT NULL,
    enrolledAt INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS auth_challenges (
    hash TEXT PRIMARY KEY,
    expiresAt INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS auth_operator_sessions (
    hash TEXT PRIMARY KEY,
    credentialHash TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS auth_operator_session_expiry ON auth_operator_sessions (expiresAt);
  CREATE TABLE IF NOT EXISTS auth_login_codes (
    hash TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    usedAt INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS auth_sessions (
    hash TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS auth_licenses (
    id TEXT PRIMARY KEY,
    codeHash TEXT NOT NULL UNIQUE,
    encryptedCode TEXT NOT NULL,
    suffix TEXT NOT NULL,
    label TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('owner', 'customer')),
    unit TEXT NOT NULL CHECK (unit IN ('days', 'months')),
    quantity INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    activatedAt INTEGER,
    expiresAt INTEGER,
    revokedAt INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS auth_license_creation ON auth_licenses (createdAt DESC, id DESC);
  CREATE TABLE IF NOT EXISTS auth_license_renewals (
    requestId TEXT PRIMARY KEY,
    licenseId TEXT NOT NULL REFERENCES auth_licenses(id),
    unit TEXT NOT NULL CHECK (unit IN ('days', 'months')),
    quantity INTEGER NOT NULL,
    renewedAt INTEGER NOT NULL,
    previousExpiresAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucket TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    resetsAt INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS auth_code_expiry ON auth_login_codes (expiresAt);
  CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_sessions (expiresAt);
`);

if (!db.prepare('PRAGMA table_info(auth_sessions)').all().some((column) => column.name === 'licenseId')) {
  db.exec('ALTER TABLE auth_sessions ADD COLUMN licenseId TEXT REFERENCES auth_licenses(id)');
}
db.exec('CREATE INDEX IF NOT EXISTS auth_session_license ON auth_sessions (licenseId)');

type Scope = 'owner' | 'customer';
type Session = { expiresAt: number; licenseId: string | null; scope: Scope | null; licenseExpiresAt: number | null };
type License = {
  id: string; suffix: string; label: string; scope: Scope; unit: LicenseUnit;
  quantity: number; createdAt: number; activatedAt: number | null;
  expiresAt: number | null; revokedAt: number | null;
};
type PasswordHash = { salt: Buffer; key: Buffer };

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODEX_PUBLIC_HTTPS === '1',
  };
}

function sessionToken(req: Request, name = SESSION_COOKIE): string | undefined {
  const entries = req.headers.cookie?.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)) ?? [];
  if (entries.length !== 1) return undefined;
  const value = entries[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function sessionFor(req: Request): Session | undefined {
  const token = sessionToken(req);
  if (!token) return undefined;
  const now = Date.now();
  return db.prepare(`
    SELECT s.expiresAt, s.licenseId, l.scope, l.expiresAt AS licenseExpiresAt
    FROM auth_sessions s LEFT JOIN auth_licenses l ON l.id = s.licenseId
    WHERE s.hash = ? AND s.expiresAt > ? AND
      (s.licenseId IS NULL OR (l.expiresAt > ? AND l.revokedAt IS NULL))
  `).get(hash(`session:${token}`), now, now) as Session | undefined;
}

function cleanup(now = Date.now()): void {
  db.prepare('DELETE FROM auth_challenges WHERE expiresAt <= ?').run(now);
  db.prepare('DELETE FROM auth_operator_sessions WHERE expiresAt <= ?').run(now);
  db.prepare('DELETE FROM auth_sessions WHERE expiresAt <= ?').run(now);
  db.prepare('DELETE FROM auth_login_codes WHERE expiresAt <= ?').run(now);
  db.prepare('DELETE FROM auth_rate_limits WHERE resetsAt <= ?').run(now);
}

function bucket(req: Request, scope: string): string {
  // Both listeners trust only their loopback reverse proxy, which overwrites XFF.
  const address = req.ip ?? req.socket.remoteAddress;
  return hash(`${scope}:${address ?? 'unknown'}`);
}

function assertRate(req: Request, res: Response, scope: string, limit: number): void {
  const state = db.prepare('SELECT attempts, resetsAt FROM auth_rate_limits WHERE bucket = ?')
    .get(bucket(req, scope)) as { attempts: number; resetsAt: number } | undefined;
  if (state && state.resetsAt > Date.now() && state.attempts >= limit) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((state.resetsAt - Date.now()) / 1000))));
    throw new InputError('尝试次数过多，请稍后再试。', 429);
  }
}

function countAttempt(req: Request, scope: string, windowMs = FAILURE_WINDOW_MS): void {
  const now = Date.now();
  db.prepare(`INSERT INTO auth_rate_limits (bucket, attempts, resetsAt) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      attempts = CASE WHEN resetsAt <= ? THEN 1 ELSE attempts + 1 END,
      resetsAt = CASE WHEN resetsAt <= ? THEN excluded.resetsAt ELSE resetsAt END`)
    .run(bucket(req, scope), now + windowMs, now, now);
}

function operatorFailure(req: Request, message = '授权验证失败，请重新操作。'): never {
  countAttempt(req, 'operator-failures');
  throw new InputError(message, 401);
}

function configuredPassword(): PasswordHash | undefined {
  // scrypt$<32-byte random salt, hex>$<64-byte derived key, hex>.
  // Salt is decoded to bytes, not passed as its hexadecimal text.
  const match = /^scrypt\$([a-f\d]{64})\$([a-f\d]{128})$/i.exec(process.env.NODEX_ADMIN_PASSWORD_HASH?.trim() ?? '');
  return match ? { salt: Buffer.from(match[1], 'hex'), key: Buffer.from(match[2], 'hex') } : undefined;
}

async function passwordMatches(password: string, expected: PasswordHash): Promise<boolean> {
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, expected.salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  return timingSafeEqual(derived, expected.key);
}

type OperatorRecord = { publicKey: string; enrolledAt: number };

function operatorRecord(): OperatorRecord | undefined {
  return db.prepare('SELECT publicKey, enrolledAt FROM auth_operator WHERE id = 1').get() as OperatorRecord | undefined;
}

function operatorCredentialHash(enrolled: OperatorRecord, password: PasswordHash): string {
  return hash(JSON.stringify([enrolled.publicKey, enrolled.enrolledAt, password.salt.toString('hex'), password.key.toString('hex')]));
}

function operatorCookieOptions(req: Request): CookieOptions {
  return { path: '/operator/api', httpOnly: true, secure: req.secure, sameSite: 'strict' };
}

function operatorSessionExpiry(req: Request, enrolled: OperatorRecord | undefined, password: PasswordHash | undefined): number | null {
  const token = sessionToken(req, OPERATOR_COOKIE);
  if (!token || !enrolled || !password) return null;
  const session = db.prepare('SELECT expiresAt FROM auth_operator_sessions WHERE hash = ? AND credentialHash = ? AND expiresAt > ?')
    .get(hash(`operator-session:${token}`), operatorCredentialHash(enrolled, password), Date.now()) as { expiresAt: number } | undefined;
  return session?.expiresAt ?? null;
}

function publicKeyFrom(value: unknown): { key: KeyObject; json: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('仅接受 ECDSA P-256 公钥。');
  const input = value as Record<string, unknown>;
  if (input.kty !== 'EC' || input.crv !== 'P-256' || 'd' in input ||
      typeof input.x !== 'string' || typeof input.y !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.x) || !/^[A-Za-z0-9_-]{43}$/.test(input.y) ||
      Buffer.from(input.x, 'base64url').toString('base64url') !== input.x ||
      Buffer.from(input.y, 'base64url').toString('base64url') !== input.y) {
    throw new InputError('仅接受 ECDSA P-256 公钥。');
  }
  const jwk = { kty: 'EC', crv: 'P-256', x: input.x, y: input.y };
  try {
    return { key: createPublicKey({ key: jwk, format: 'jwk' }), json: JSON.stringify(jwk) };
  } catch {
    throw new InputError('公钥无效，请在当前浏览器重新建立设备密钥。');
  }
}

function loopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return address === '::1' || (isIP(ipv4) === 4 && ipv4.startsWith('127.'));
}

/** Mount only on the dedicated loopback operator application, never the public app. */
export const operatorAuth = Router();
operatorAuth.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!loopback(req)) throw new InputError('该操作只允许在本机管理入口进行。', 403);
  cleanup();
  next();
});

operatorAuth.get('/operator/api/state', (req, res) => {
  const enrolled = operatorRecord();
  const password = configuredPassword();
  res.json({
    enrolled: Boolean(enrolled), passwordConfigured: Boolean(password),
    sessionExpiresAt: operatorSessionExpiry(req, enrolled, password),
  });
});

operatorAuth.post('/operator/api/enroll', (req, res) => {
  assertRate(req, res, 'operator-failures', 5);
  if (operatorRecord()) throw new InputError('设备已绑定，不能通过网页重新绑定。', 409);
  const expected = process.env.NODEX_ENROLLMENT_HASH?.trim() ?? '';
  if (!/^[a-f\d]{64}$/i.test(expected)) throw new InputError('本机设备绑定尚未配置。', 503);
  const token: unknown = req.body?.token;
  if (typeof token !== 'string' || token.length < 1 || token.length > 512 ||
      !timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(expected, 'hex'))) {
    operatorFailure(req);
  }
  let publicKey: { key: KeyObject; json: string };
  try {
    publicKey = publicKeyFrom(req.body?.publicKey);
  } catch {
    operatorFailure(req, '设备公钥无效，请重新建立浏览器设备密钥。');
  }
  // Conditional insertion also refuses two simultaneous enrolments from two
  // processes sharing this database. An env token change cannot replace a key.
  const inserted = db.prepare('INSERT OR IGNORE INTO auth_operator (id, publicKey, enrolledAt) VALUES (1, ?, ?)')
    .run(publicKey.json, Date.now());
  if (Number(inserted.changes) !== 1) throw new InputError('设备已绑定，不能通过网页重新绑定。', 409);
  res.status(201).json({ ok: true, enrolled: true });
});

operatorAuth.post('/operator/api/challenge', (req, res) => {
  assertRate(req, res, 'operator-failures', 5);
  assertRate(req, res, 'operator-challenges', 30);
  if (!operatorRecord()) throw new InputError('请先完成本机浏览器绑定。', 409);
  countAttempt(req, 'operator-challenges', 60_000);
  const count = db.prepare('SELECT COUNT(*) AS total FROM auth_challenges').get() as { total: number };
  if (count.total >= 64) throw new InputError('待验证请求过多，请稍后重试。', 429);
  const challenge = `nodex-operator-v1.${randomBytes(32).toString('base64url')}`;
  const expiresAt = Date.now() + CHALLENGE_MS;
  db.prepare('INSERT INTO auth_challenges (hash, expiresAt) VALUES (?, ?)').run(hash(challenge), expiresAt);
  res.json({ challenge, expiresAt: new Date(expiresAt).toISOString() });
});

operatorAuth.post('/operator/api/login', async (req, res) => {
  assertRate(req, res, 'operator-failures', 5);
  const expectedPassword = configuredPassword();
  if (!expectedPassword) throw new InputError('管理员密码尚未配置。', 503);
  const enrolled = operatorRecord();
  if (!enrolled) throw new InputError('请先完成本机浏览器绑定。', 409);
  const { password, challenge, signature } = req.body ?? {};
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024 ||
      typeof challenge !== 'string' || !/^nodex-operator-v1\.[A-Za-z0-9_-]{43}$/.test(challenge) ||
      typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
    operatorFailure(req);
  }
  // Delete before any async password work. A challenge can be submitted once,
  // even when its signature/password is wrong or requests arrive concurrently.
  const claimed = db.prepare('DELETE FROM auth_challenges WHERE hash = ? AND expiresAt > ? RETURNING hash')
    .get(hash(challenge), Date.now());
  if (!claimed) operatorFailure(req, '验证请求已失效或已使用，请重新生成挑战。');
  let validSignature = false;
  try {
    const bytes = Buffer.from(signature, 'base64url');
    validSignature = bytes.length === 64 && bytes.toString('base64url') === signature && verify(
      'sha256', Buffer.from(challenge, 'utf8'),
      { key: publicKeyFrom(JSON.parse(enrolled.publicKey)).key, dsaEncoding: 'ieee-p1363' }, bytes,
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) operatorFailure(req);
  let validPassword = false;
  try {
    validPassword = await passwordMatches(password, expectedPassword);
  } catch {
    throw new InputError('管理员验证暂时不可用，请稍后重试。', 503);
  }
  if (!validPassword) operatorFailure(req);

  const token = randomBytes(32).toString('base64url');
  const sessionExpiresAt = Date.now() + OPERATOR_SESSION_MS;
  db.prepare('INSERT INTO auth_operator_sessions (hash, credentialHash, expiresAt) VALUES (?, ?, ?)')
    .run(hash(`operator-session:${token}`), operatorCredentialHash(enrolled, expectedPassword), sessionExpiresAt);
  const previous = sessionToken(req, OPERATOR_COOKIE);
  if (previous) db.prepare('DELETE FROM auth_operator_sessions WHERE hash = ?').run(hash(`operator-session:${previous}`));
  res.cookie(OPERATOR_COOKIE, token, { ...operatorCookieOptions(req), maxAge: OPERATOR_SESSION_MS });
  res.json({ enrolled: true, passwordConfigured: true, sessionExpiresAt });
});

operatorAuth.post('/operator/api/logout', (req, res) => {
  const token = sessionToken(req, OPERATOR_COOKIE);
  if (token) db.prepare('DELETE FROM auth_operator_sessions WHERE hash = ?').run(hash(`operator-session:${token}`));
  res.clearCookie(OPERATOR_COOKIE, operatorCookieOptions(req)).json({ ok: true });
});

operatorAuth.use('/operator/api', (req, _res, next) => {
  if (operatorSessionExpiry(req, operatorRecord(), configuredPassword()) === null) {
    throw new InputError('请先登录管理后台。', 401);
  }
  next();
});

function summarizeLicense(license: License, now = Date.now()) {
  const status = license.revokedAt !== null ? 'revoked'
    : license.activatedAt === null ? 'pending'
    : license.expiresAt !== null && license.expiresAt <= now ? 'expired' : 'active';
  return { ...license, status };
}

function requestedDuration(unit: unknown, quantity: unknown): { unit: LicenseUnit; quantity: number } {
  if ((unit !== 'days' && unit !== 'months') || typeof quantity !== 'number' || !Number.isInteger(quantity) ||
      quantity < 1 || quantity > (unit === 'days' ? 366 : 24)) {
    throw new InputError('请输入有效的授权期：1–366 天或 1–24 个自然月。');
  }
  return { unit, quantity };
}

operatorAuth.post('/operator/api/codes', (req, res) => {
  const { scope = 'customer', label = '' } = req.body ?? {};
  const { unit, quantity } = requestedDuration(req.body?.unit, req.body?.quantity);
  if (scope !== 'customer' && scope !== 'owner') throw new InputError('请选择有效的工作空间类型。');
  if (typeof label !== 'string' || label.trim().length > 80) throw new InputError('备注不能超过 80 个字符。');
  const id = randomUUID();
  const createdAt = Date.now();
  const code = `NX-${randomBytes(20).toString('base64url')}`;
  const suffix = code.slice(-4);
  db.prepare(`
    INSERT INTO auth_licenses (id, codeHash, encryptedCode, suffix, label, scope, unit, quantity, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, hash(`code:${code}`), seal(code), suffix, label.trim(), scope, unit, quantity, createdAt);
  res.status(201).json({
    code,
    license: summarizeLicense({
      id, suffix, createdAt, label: label.trim(), scope, unit, quantity,
      activatedAt: null, expiresAt: null, revokedAt: null,
    }),
  });
});

operatorAuth.post('/operator/api/licenses/list', (req, res) => {
  const page = req.body?.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new InputError('页码无效。');
  const pageSize = 20;
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM auth_licenses').get() as { total: number };
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pages);
  const licenses = db.prepare(`
    SELECT id, suffix, label, scope, unit, quantity, createdAt, activatedAt, expiresAt, revokedAt
    FROM auth_licenses ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?
  `).all(pageSize, (currentPage - 1) * pageSize) as License[];
  const now = Date.now();
  res.json({ rows: licenses.map((license) => summarizeLicense(license, now)), page: currentPage, pages, total });
});

function requestedUuid(value: unknown, error: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) {
    throw new InputError(error);
  }
  return value;
}

operatorAuth.post('/operator/api/licenses/reveal', (req, res) => {
  const id = requestedUuid(req.body?.id, '登录码标识无效。');
  const license = db.prepare(`
    SELECT encryptedCode FROM auth_licenses WHERE id = ? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?)
  `).get(id, Date.now()) as { encryptedCode: string } | undefined;
  if (!license) throw new InputError('登录码已到期或已停用。', 404);
  res.json({ code: reveal(license.encryptedCode) });
});

operatorAuth.post('/operator/api/licenses/renew', (req, res) => {
  const id = requestedUuid(req.body?.id, '登录码标识无效。');
  const requestId = requestedUuid(req.body?.requestId, '续期请求标识无效。');
  const { unit, quantity } = requestedDuration(req.body?.unit, req.body?.quantity);
  db.exec('BEGIN IMMEDIATE');
  let result: ReturnType<typeof summarizeLicense>;
  try {
    const license = db.prepare(`
      SELECT id, suffix, label, scope, unit, quantity, createdAt, activatedAt, expiresAt, revokedAt
      FROM auth_licenses WHERE id = ?
    `).get(id) as License | undefined;
    if (!license) throw new InputError('找不到此登录码。', 404);
    const existing = db.prepare('SELECT licenseId, unit, quantity FROM auth_license_renewals WHERE requestId = ?')
      .get(requestId) as { licenseId: string; unit: LicenseUnit; quantity: number } | undefined;
    const now = Date.now();
    if (existing) {
      if (existing.licenseId !== id || existing.unit !== unit || existing.quantity !== quantity) {
        throw new InputError('此续期请求已提交，请刷新列表后再操作。', 409);
      }
      result = summarizeLicense(license, now);
    } else {
      if (license.revokedAt !== null) throw new InputError('停用的登录码无法续期。', 409);
      if (license.activatedAt === null || license.expiresAt === null) {
        throw new InputError('登录码首次登录后才可续期。', 409);
      }
      const expiresAt = licenseExpiry(Math.max(now, license.expiresAt), unit, quantity);
      db.prepare('UPDATE auth_licenses SET expiresAt = ? WHERE id = ?').run(expiresAt, id);
      db.prepare(`
        INSERT INTO auth_license_renewals (requestId, licenseId, unit, quantity, renewedAt, previousExpiresAt, expiresAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(requestId, id, unit, quantity, now, license.expiresAt, expiresAt);
      db.prepare('UPDATE auth_sessions SET expiresAt = ? WHERE licenseId = ? AND expiresAt > ?').run(expiresAt, id, now);
      result = summarizeLicense({ ...license, expiresAt }, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  res.json({ license: result });
});

operatorAuth.post('/operator/api/licenses/revoke', (req, res) => {
  const id = requestedUuid(req.body?.id, '登录码标识无效。');
  const updated = db.prepare('UPDATE auth_licenses SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL')
    .run(Date.now(), id);
  if (!Number(updated.changes)) throw new InputError('登录码不存在或已停用。', 404);
  db.prepare('DELETE FROM auth_sessions WHERE licenseId = ?').run(id);
  res.json({ ok: true });
});

/** Mount under /api before requireAuth. Only these three routes are public. */
export const auth = Router();
auth.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

auth.get('/auth/status', (req, res) => {
  const session = sessionFor(req);
  res.json(session ? {
    authenticated: true,
    expiresAt: new Date(session.expiresAt).toISOString(),
    licenseExpiresAt: session.licenseExpiresAt === null ? null : new Date(session.licenseExpiresAt).toISOString(),
  } : { authenticated: false });
});

auth.post('/auth/login', (req, res) => {
  cleanup();
  assertRate(req, res, 'login-failures', 10);
  const submitted: unknown = req.body?.code;
  const code = typeof submitted === 'string' ? submitted.trim() : '';
  if (!/^NX-[A-Za-z0-9_-]{27}$/.test(code)) {
    countAttempt(req, 'login-failures');
    throw new InputError('登录码无效、已使用、已停用或已过期。', 401);
  }
  const now = Date.now();
  const token = randomBytes(32).toString('base64url');
  const remember = req.body?.remember === true;
  const duration = remember ? REMEMBERED_SESSION_MS : SESSION_MS;
  let expiresAt = now + duration;
  let licenseId: string | null = null;
  let accepted = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const codeHash = hash(`code:${code}`);
    const license = db.prepare(`
      SELECT id, unit, quantity, activatedAt, expiresAt, revokedAt FROM auth_licenses WHERE codeHash = ?
    `).get(codeHash) as Pick<License, 'id' | 'unit' | 'quantity' | 'activatedAt' | 'expiresAt' | 'revokedAt'> | undefined;
    if (license && license.revokedAt === null) {
      if (license.activatedAt === null) {
        expiresAt = licenseExpiry(now, license.unit, license.quantity);
        db.prepare('UPDATE auth_licenses SET activatedAt = ?, expiresAt = ? WHERE id = ?').run(now, expiresAt, license.id);
        licenseId = license.id;
      } else if (license.expiresAt !== null && license.expiresAt > now) {
        expiresAt = license.expiresAt;
        licenseId = license.id;
      }
      accepted = licenseId !== null;
    } else if (!license) {
      accepted = Boolean(db.prepare(`UPDATE auth_login_codes SET usedAt = ?
        WHERE hash = ? AND usedAt IS NULL AND expiresAt > ? RETURNING hash`).get(now, codeHash, now));
    }
    if (accepted) {
      db.prepare('INSERT INTO auth_sessions (hash, createdAt, expiresAt, licenseId) VALUES (?, ?, ?, ?)')
        .run(hash(`session:${token}`), now, expiresAt, licenseId);
      const previous = sessionToken(req);
      if (previous) db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(hash(`session:${previous}`));
    }
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    throw new InputError('登录暂时不可用，请稍后重试。', 503);
  }
  if (!accepted) {
    countAttempt(req, 'login-failures');
    throw new InputError('登录码无效、已使用、已停用或已过期。', 401);
  }
  res.cookie(SESSION_COOKIE, token, {
    ...cookieOptions(),
    ...(remember ? { maxAge: expiresAt - now } : {}),
  });
  res.json({ ok: true, authenticated: true, expiresAt: new Date(expiresAt).toISOString() });
});

auth.post('/auth/logout', (req, res) => {
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(hash(`session:${token}`));
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.json({ ok: true, authenticated: false });
});

/** Fail closed: every business API route needs a valid, unexpired session. */
export const requireAuth: RequestHandler = (req, res, next) => {
  const session = sessionFor(req);
  if (!session) {
    res.set('Cache-Control', 'no-store').status(401).json({ error: '请先使用登录码登录。', code: 'AUTH_REQUIRED' });
    return;
  }
  if (session.scope === 'customer' && !session.licenseId) {
    res.set('Cache-Control', 'no-store').status(401).json({ error: '客户空间授权无效。', code: 'AUTH_REQUIRED' });
    return;
  }
  runInWorkspace(session.scope === 'customer' ? session.licenseId! : undefined, next);
};
