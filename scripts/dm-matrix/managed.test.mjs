import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const localhost = '127.0.0.1';
const matrixUserId = '@operator:fixture.test';
const bridgeBotId = '@twitterbot:fixture.test';
const xUserId = '1234';
const otherXUserId = '9876';
const entry = fileURLToPath(new URL('../../server/index.ts', import.meta.url));

async function listen(server) {
  server.listen(0, localhost);
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

async function waitFor(check, diagnostic) {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(diagnostic());
    await delay(25);
  }
}

function bridgedRoom(receiver, body) {
  return {
    state: { events: [{
      type: 'm.bridge', state_key: 'twitter', sender: bridgeBotId,
      content: { bridgebot: bridgeBotId, protocol: { id: 'twitter' }, channel: { receiver, displayname: 'X 私信' } },
    }] },
    timeline: { events: [{
      type: 'm.room.message', event_id: '$incoming-' + receiver, sender: '@peer:fixture.test',
      origin_server_ts: Date.now(), content: { msgtype: 'm.text', body },
    }] },
  };
}

test('the workbench connects to the matching mautrix login, restores synchronization, and disconnects', {
  timeout: 35_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nodex-managed-dm-'));
  let cleanUpServices;
  t.after(async () => {
    try {
      await cleanUpServices?.();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const dataDirectory = join(directory, 'data');
  const configs = join(dataDirectory, 'dm-matrix');
  await Promise.all([mkdir(join(directory, 'dist')), mkdir(configs, { recursive: true, mode: 0o700 })]);
  await writeFile(join(directory, 'dist', 'index.html'), '<!doctype html><title>Node X fixture</title>');
  const matrixAccessToken = randomBytes(24).toString('base64url');
  const { promise: firstSync, resolve: releaseFirstSync } = Promise.withResolvers();
  const syncRequests = [];
  let bridgeChecks = 0;
  const violations = [];
  const matrix = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://matrix.fixture');
    res.setHeader('content-type', 'application/json');
    const reply = data => res.end(JSON.stringify(data));
    if (req.headers.authorization !== 'Bearer ' + matrixAccessToken) {
      violations.push('Matrix credential missing or incorrect');
      res.statusCode = 401;
      return reply({});
    }
    if (url.pathname === '/_matrix/client/v3/account/whoami') return reply({ user_id: matrixUserId });
    if (url.pathname === '/_matrix/provision/v3/whoami') {
      bridgeChecks++;
      if (url.searchParams.get('user_id') !== matrixUserId) violations.push('incorrect Matrix user for mautrix');
      return reply({ bridge_bot: bridgeBotId, logins: [{ id: xUserId, state: { state_event: 'CONNECTED' } }] });
    }
    if (url.pathname === '/_matrix/client/v3/sync') {
      const number = syncRequests.push(url.searchParams);
      await firstSync;
      return reply({
        next_batch: 'cursor-' + number,
        rooms: { join: number === 1 ? {
          '!matched:fixture.test': bridgedRoom(xUserId, 'Fixture private message'),
          '!unrelated:fixture.test': bridgedRoom(otherXUserId, 'Unrelated private message'),
        } : {} },
      });
    }
    violations.push('unexpected Matrix route: ' + url.pathname);
    res.statusCode = 404;
    return reply({});
  });
  const matrixUrl = 'http://' + localhost + ':' + await listen(matrix);
  cleanUpServices = () => close(matrix);
  const reserved = [createServer(), createServer()];
  const [port, operatorPort] = await Promise.all(reserved.map(listen));
  await Promise.all(reserved.map(close));
  const base = 'http://' + localhost + ':' + port;
  let nodeX;
  let logs = '';
  async function startNodeX() {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry], {
      cwd: directory,
      env: { NODEX_DATA_DIR: dataDirectory, PORT: String(port), NODEX_OPERATOR_PORT: String(operatorPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    nodeX = { child, exited: once(child, 'close') };
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error('Node X exited:\n' + logs);
      const response = await fetch(base + '/healthz').catch(() => null);
      await response?.text();
      return response?.ok;
    }, () => 'Node X did not start:\n' + logs);
  }
  async function stopNodeX() {
    if (!nodeX) return;
    const { child, exited } = nodeX;
    child.kill('SIGTERM');
    const forceStop = setTimeout(() => child.kill('SIGKILL'), 3_000);
    try {
      return await exited;
    } finally {
      clearTimeout(forceStop);
      nodeX = undefined;
    }
  }
  cleanUpServices = async () => {
    releaseFirstSync();
    await Promise.all([stopNodeX(), close(matrix)]);
  };
  await startNodeX();

  // Seed a test login code and authenticate through the same HTTP endpoints as the workbench.
  const code = 'NX-' + randomBytes(20).toString('base64url');
  const db = new DatabaseSync(join(dataDirectory, 'nodex.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    const now = Date.now();
    const hash = createHash('sha256').update('code:' + code).digest('hex');
    db.prepare('INSERT INTO auth_login_codes (hash, createdAt, expiresAt) VALUES (?, ?, ?)').run(hash, now, now + 60_000);
  } finally {
    db.close();
  }
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
  assert.match(cookie ?? '', /^nodex_session=/);

  async function api(path, body) {
    const response = await fetch(base + '/api' + path, {
      headers: { cookie, 'content-type': 'application/json' },
      ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    const result = await response.text();
    assert.doesNotMatch(result, /"(?:ticket|pairTicket|token|tokenHash|matrixAccessToken|bridgeProvisioningUrl)"\s*:/i);
    assert.ok(!result.includes(matrixAccessToken), 'Matrix credential was returned to the workbench');
    assert.ok(response.ok, path + ': ' + response.status + ' ' + result);
    return JSON.parse(result);
  }
  const inbox = () => api('/dm/inbox');
  await api('/accounts', { label: 'Matched', username: 'matched' });
  await api('/accounts', { label: 'Unmatched', username: 'unmatched' });
  const { accounts } = await inbox();
  const matched = accounts.find(account => account.username === 'matched').id;
  const unmatched = accounts.find(account => account.username === 'unmatched').id;
  const connectPath = id => '/dm/accounts/' + id + '/connect';
  const disconnectPath = id => '/dm/accounts/' + id + '/disconnect';
  const connect = (id, body) => api(connectPath(id), body);
  async function config(id, receiver) {
    await writeFile(join(configs, id + '.json'), JSON.stringify({
      matrixUrl, matrixAccessToken, bridgeBotId, xUserId: receiver,
      bridgeProvisioningUrl: matrixUrl + '/_matrix/provision',
    }), { mode: 0o600 });
  }
  async function waitForStatus(id, expected, paired) {
    let latest;
    await waitFor(async () => {
      latest = await connect(id);
      return latest.status === expected;
    }, () => 'Expected ' + expected + ', received ' + JSON.stringify(latest) + '\n' + logs);
    assert.equal(latest.paired, paired);
  }

  await waitForStatus(matched, 'unconfigured', false);
  await Promise.all([config(matched, xUserId), config(unmatched, otherXUserId)]);
  await waitForStatus(matched, 'idle', false);
  await connect(matched, {});
  await waitForStatus(matched, 'syncing', true);
  releaseFirstSync();
  await waitForStatus(matched, 'online', true);

  const online = await inbox();
  assert.equal(online.accounts.find(account => account.id === matched).connected, true);
  assert.deepEqual(online.conversations.map(({ accountId, preview }) => ({ accountId, preview })),
    [{ accountId: matched, preview: 'Fixture private message' }]);
  const conversation = online.conversations[0].id;
  const messages = await api('/dm/conversations/' + conversation + '/messages');
  assert.deepEqual(messages.messages.map(({ text, direction }) => ({ text, direction })),
    [{ text: 'Fixture private message', direction: 'in' }]);

  assert.deepEqual(await stopNodeX(), [0, null], logs);
  const firstRestoredSync = syncRequests.length;
  const bridgeChecksBeforeRestart = bridgeChecks;
  await startNodeX();
  await waitForStatus(matched, 'online', true);
  const restoredSync = syncRequests[firstRestoredSync];
  assert.match(restoredSync?.get('since') ?? '', /^cursor-[1-9][0-9]*$/);
  assert.equal(restoredSync?.get('full_state'), 'true');
  assert.ok(bridgeChecks > bridgeChecksBeforeRestart);
  const restored = await inbox();
  assert.equal(restored.accounts.find(account => account.id === matched).connected, true);
  assert.equal(restored.conversations[0].id, conversation);

  await api(disconnectPath(matched), {});
  await waitForStatus(matched, 'idle', false);
  const disconnected = await inbox();
  assert.equal(disconnected.accounts.find(account => account.id === matched).connected, false);
  assert.equal(disconnected.conversations[0].id, conversation);

  await connect(unmatched, {});
  await waitForStatus(unmatched, 'failed', false);
  assert.equal((await inbox()).accounts.find(account => account.id === unmatched).connected, false);
  await connect(matched, {});
  await waitForStatus(matched, 'online', true);
  assert.ok(bridgeChecks >= 3);
  assert.deepEqual(violations, []);
  assert.ok(!logs.includes(matrixAccessToken), 'Matrix credential was written to server logs');
});
