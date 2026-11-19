import {
  createHash, createPublicKey, randomBytes, scrypt, timingSafeEqual, verify,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';
import { Router, type CookieOptions, type Request, type RequestHandler, type Response } from 'express';
import { InputError } from './errors.js';
import { db } from './store.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_MS = 2 * 60 * 1000;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const SESSION_COOKIE = 'nodex_session';

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
  CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucket TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    resetsAt INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS auth_code_expiry ON auth_login_codes (expiresAt);
  CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_sessions (expiresAt);
`);

type Session = { expiresAt: number };
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

function sessionToken(req: Request): string | undefined {
  const entries = req.headers.cookie?.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE}=`)) ?? [];
  if (entries.length !== 1) return undefined;
  const value = entries[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function sessionFor(req: Request): Session | undefined {
  const token = sessionToken(req);
  if (!token) return undefined;
  return db.prepare('SELECT expiresAt FROM auth_sessions WHERE hash = ? AND expiresAt > ?')
    .get(hash(`session:${token}`), Date.now()) as Session | undefined;
}

function cleanup(now = Date.now()): void {
  db.prepare('DELETE FROM auth_challenges WHERE expiresAt <= ?').run(now);
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

function operatorRecord(): { publicKey: string } | undefined {
  return db.prepare('SELECT publicKey FROM auth_operator WHERE id = 1').get() as { publicKey: string } | undefined;
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

operatorAuth.get('/operator/api/state', (_req, res) => {
  res.json({ enrolled: Boolean(operatorRecord()), passwordConfigured: Boolean(configuredPassword()) });
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

operatorAuth.post('/operator/api/codes', async (req, res) => {
  assertRate(req, res, 'operator-failures', 5);
  const expectedPassword = configuredPassword();
  if (!expectedPassword) throw new InputError('管理员密码尚未配置，请在本机配置后再生成登录码。', 503);
  const enrolled = operatorRecord();
  if (!enrolled) throw new InputError('请先完成本机浏览器绑定。', 409);
  const { password, challenge, signature, ttlMinutes = 15 } = req.body ?? {};
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 60) {
    throw new InputError('登录码有效期必须为 1–60 分钟的整数。');
  }
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
  const now = Date.now();
  const expiresAt = now + ttlMinutes * 60_000;
  const code = `NX-${randomBytes(20).toString('base64url')}`;
  db.prepare('INSERT INTO auth_login_codes (hash, createdAt, expiresAt) VALUES (?, ?, ?)')
    .run(hash(`code:${code}`), now, expiresAt);
  // This is the only response containing the newly generated code. It is never
  // stored plaintext, logged, or included in list/status endpoints.
  res.status(201).json({ code, expiresAt: new Date(expiresAt).toISOString() });
});

/** Mount under /api before requireAuth. Only these three routes are public. */
export const auth = Router();
auth.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

auth.get('/auth/status', (req, res) => {
  const session = sessionFor(req);
  res.json(session ? { authenticated: true, expiresAt: new Date(session.expiresAt).toISOString() } : { authenticated: false });
});

auth.post('/auth/login', (req, res) => {
  cleanup();
  assertRate(req, res, 'login-failures', 10);
  const submitted: unknown = req.body?.code;
  const code = typeof submitted === 'string' ? submitted.trim() : '';
  if (!/^NX-[A-Za-z0-9_-]{27}$/.test(code)) {
    countAttempt(req, 'login-failures');
    throw new InputError('登录码无效、已使用或已过期。', 401);
  }
  const now = Date.now();
  const token = randomBytes(32).toString('base64url');
  const remember = req.body?.remember === true;
  const duration = remember ? REMEMBERED_SESSION_MS : SESSION_MS;
  const expiresAt = now + duration;
  let accepted = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const consumed = db.prepare(`UPDATE auth_login_codes SET usedAt = ?
      WHERE hash = ? AND usedAt IS NULL AND expiresAt > ? RETURNING hash`)
      .get(now, hash(`code:${code}`), now);
    if (consumed) {
      db.prepare('INSERT INTO auth_sessions (hash, createdAt, expiresAt) VALUES (?, ?, ?)')
        .run(hash(`session:${token}`), now, expiresAt);
      const previous = sessionToken(req);
      if (previous) db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(hash(`session:${previous}`));
      accepted = true;
    }
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    throw new InputError('登录暂时不可用，请稍后重试。', 503);
  }
  if (!accepted) {
    countAttempt(req, 'login-failures');
    throw new InputError('登录码无效、已使用或已过期。', 401);
  }
  res.cookie(SESSION_COOKIE, token, {
    ...cookieOptions(),
    ...(remember ? { maxAge: duration } : {}),
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
  if (!sessionFor(req)) {
    res.set('Cache-Control', 'no-store').status(401).json({ error: '请先使用单次登录码登录。', code: 'AUTH_REQUIRED' });
    return;
  }
  next();
};
