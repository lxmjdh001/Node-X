import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const localhost = '127.0.0.1';
const matrixUserId = '@operator:fixture.test';
const hostedMatrixUserId = '@hosted:fixture.test';
const bridgeBotId = '@twitterbot:fixture.test';
const xUserId = '1234';
const otherXUserId = '9876';
const selfConfiguredXUserId = '4567';
const hostedXUserId = '7654';
const hostedUsername = 'hosted_user';
const publicMatrixOrigin = 'https://matrix.fixture.test';
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

async function waitFor(check, diagnostic, timeout = 8_000) {
  const deadline = Date.now() + timeout;
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

async function loopbackMatrixPreload(directory, matrixUrl) {
  const preload = join(directory, 'matrix-fixture.mjs');
  await writeFile(preload, `
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const origin = new URL(${JSON.stringify(publicMatrixOrigin)});
const lookup = dns.lookup.bind(dns);
const request = https.request.bind(https);
dns.lookup = (hostname, options) => hostname === origin.hostname
  ? Promise.resolve([{ address: '1.1.1.1', family: 4 }])
  : lookup(hostname, options);
https.request = (target, options, callback) => {
  if (!(target instanceof URL) || target.origin !== origin.origin) return request(target, options, callback);
  const loopback = new URL(target.pathname + target.search, ${JSON.stringify(matrixUrl)});
  return http.request(loopback, {
    ...options, lookup: undefined,
    headers: { ...options.headers, 'x-fixture-public-matrix': '1' },
  }, callback);
};
syncBuiltinESMExports();
`);
  return pathToFileURL(preload).href;
}

test('the workbench configures, connects, restores, and disconnects managed mautrix logins', {
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
  const databasePath = join(dataDirectory, 'nodex.sqlite');
  const configs = join(dataDirectory, 'dm-matrix');
  await Promise.all([mkdir(join(directory, 'dist')), mkdir(configs, { recursive: true, mode: 0o700 })]);
  await writeFile(join(directory, 'dist', 'index.html'), '<!doctype html><title>Node X fixture</title>');
  const matrixAccessToken = randomBytes(24).toString('base64url');
  const hostedMatrixToken = randomBytes(24).toString('base64url');
  const { promise: firstSync, resolve: releaseFirstSync } = Promise.withResolvers();
  const syncRequests = [];
  let bridgeChecks = 0;
  let selfLoginId = selfConfiguredXUserId;
  let hostedAuthorized = false;
  const violations = [];
  const matrix = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://matrix.fixture');
    res.setHeader('content-type', 'application/json');
    const reply = data => res.end(JSON.stringify(data));
    const hosted = req.headers.authorization === 'Bearer ' + hostedMatrixToken;
    if (!hosted && req.headers.authorization !== 'Bearer ' + matrixAccessToken) {
      violations.push('Matrix credential missing or incorrect');
      res.statusCode = 401;
      return reply({});
    }
    const user = hosted ? hostedMatrixUserId : matrixUserId;
    if (url.pathname === '/_matrix/client/v3/account/whoami') return reply({ user_id: user });
    if (url.pathname === '/_matrix/provision/v3/whoami') {
      bridgeChecks++;
      if (url.searchParams.get('user_id') !== user) violations.push('incorrect Matrix user for mautrix');
      const logins = hosted ? [] : [
        { id: xUserId, profile: { username: 'matched' }, state: { state_event: 'CONNECTED' } },
        { id: selfLoginId, profile: { username: 'selfmanaged' }, state: { state_event: 'CONNECTED' } },
      ];
      if (hosted && hostedAuthorized) {
        logins.push({ id: hostedXUserId, profile: { username: hostedUsername }, state: { state_event: 'CONNECTED' } });
      }
      return reply({
        bridge_bot: bridgeBotId,
        network: { network_id: 'twitter' },
        logins,
      });
    }
    if (url.pathname === '/_matrix/client/v3/sync') {
      const number = syncRequests.push(url.searchParams);
      await firstSync;
      const selfInitialSync = req.headers['x-fixture-public-matrix'] === '1' && !url.searchParams.has('since');
      return reply({
        next_batch: 'cursor-' + number,
        rooms: { join: {
          ...(number === 1 && {
            '!matched:fixture.test': bridgedRoom(xUserId, 'Fixture private message'),
            '!unrelated:fixture.test': bridgedRoom(otherXUserId, 'Unrelated private message'),
          }),
          ...(selfInitialSync && {
            '!selfmanaged:fixture.test': bridgedRoom(selfConfiguredXUserId, 'Self-managed private message'),
          }),
          ...(hosted && !url.searchParams.has('since') && {
            '!hosted:fixture.test': bridgedRoom(hostedXUserId, 'Hosted private message'),
          }),
        } },
      });
    }
    violations.push('unexpected Matrix route: ' + url.pathname);
    res.statusCode = 404;
    return reply({});
  });
  const matrixUrl = 'http://' + localhost + ':' + await listen(matrix);
  cleanUpServices = () => close(matrix);
  const preload = await loopbackMatrixPreload(directory, matrixUrl);
  const reserved = [createServer(), createServer()];
  const [port, operatorPort] = await Promise.all(reserved.map(listen));
  await Promise.all(reserved.map(close));
  const base = 'http://' + localhost + ':' + port;
  let nodeX;
  let logs = '';
  async function startNodeX() {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload, entry], {
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
  const db = new DatabaseSync(databasePath);
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

  async function api(path, body, expectedStatus) {
    const response = await fetch(base + '/api' + path, {
      headers: { cookie, 'content-type': 'application/json' },
      ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    const result = await response.text();
    assert.doesNotMatch(result, /"(?:ticket|pairTicket|token|tokenHash|matrixAccessToken|matrixUrl|bridgeProvisioningUrl|sealedConfig)"\s*:/i);
    assert.ok(!result.includes(matrixAccessToken), 'Matrix credential was returned to the workbench');
    assert.ok(!result.includes(hostedMatrixToken), 'Hosted Matrix credential was returned to the workbench');
    if (expectedStatus === undefined) assert.ok(response.ok, path + ': ' + response.status + ' ' + result);
    else assert.equal(response.status, expectedStatus, path + ': ' + result);
    return JSON.parse(result);
  }
  const inbox = () => api('/dm/inbox');
  await api('/accounts', { label: 'Matched', username: 'matched' });
  await api('/accounts', { label: 'Unmatched', username: 'unmatched' });
  await api('/accounts', { label: 'Self-managed', username: 'selfmanaged' });
  await api('/accounts', { label: 'Hosted', username: hostedUsername });
  const { accounts } = await inbox();
  const matched = accounts.find(account => account.username === 'matched').id;
  const unmatched = accounts.find(account => account.username === 'unmatched').id;
  const selfManaged = accounts.find(account => account.username === 'selfmanaged').id;
  const hosted = accounts.find(account => account.username === hostedUsername).id;
  const connectPath = id => '/dm/accounts/' + id + '/connect';
  const disconnectPath = id => '/dm/accounts/' + id + '/disconnect';
  const connect = (id, body) => api(connectPath(id), body);
  async function config(id, receiver) {
    await writeFile(join(configs, id + '.json'), JSON.stringify({
      matrixUrl, matrixAccessToken, bridgeBotId, xUserId: receiver,
      bridgeProvisioningUrl: matrixUrl + '/_matrix/provision',
    }), { mode: 0o600 });
  }
  async function waitForStatus(id, expected, paired, timeout) {
    let latest;
    await waitFor(async () => {
      latest = await connect(id);
      return latest.status === expected;
    }, () => 'Expected ' + expected + ', received ' + JSON.stringify(latest) + '\n' + logs, timeout);
    assert.equal(latest.paired, paired);
    return latest;
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

  const configPath = connectPath(selfManaged) + '-config';
  const publicConfig = {
    username: 'selfmanaged',
    matrixUrl: publicMatrixOrigin,
    bridgeProvisioningUrl: publicMatrixOrigin + '/_matrix/provision',
    matrixAccessToken,
  };
  function savedConfig() {
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return reader.prepare('SELECT xUserId, sealedConfig FROM dm_bridge_configs WHERE accountId = ?').get(selfManaged);
    } finally {
      reader.close();
    }
  }
  await waitForStatus(selfManaged, 'unconfigured', false);
  const unauthorized = await fetch(base + '/api' + configPath, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(publicConfig),
  });
  assert.equal(unauthorized.status, 401, await unauthorized.text());
  await api(configPath, { ...publicConfig, matrixUrl }, 422);
  assert.equal(savedConfig(), undefined);
  await api(configPath, publicConfig);
  await waitForStatus(selfManaged, 'online', true);
  const stored = savedConfig();
  assert.equal(stored.xUserId, selfConfiguredXUserId);
  assert.match(stored.sealedConfig, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.ok(!stored.sealedConfig.includes(matrixAccessToken), 'SQLite stored the cleartext Matrix credential');
  const selfInbox = await api('/dm/inbox?accountId=' + selfManaged);
  assert.deepEqual(selfInbox.conversations.map(({ preview }) => preview), ['Self-managed private message']);

  await api(disconnectPath(selfManaged), {});
  await waitForStatus(selfManaged, 'idle', false);
  await api(configPath, { ...publicConfig, username: 'otheruser' }, 409);
  assert.deepEqual(savedConfig(), stored);
  selfLoginId = otherXUserId;
  await api(configPath, publicConfig, 409);
  assert.deepEqual(savedConfig(), stored);

  const hostedPath = join(configs, hosted + '.hosted.json');
  await writeFile(hostedPath, JSON.stringify({
    matrixUrl, bridgeProvisioningUrl: matrixUrl + '/_matrix/provision', matrixAccessToken: hostedMatrixToken,
    bridgeBotId, expectedUsername: hostedUsername,
  }), { mode: 0o600 });
  const hostedStart = await connect(hosted, {});
  assert.equal(hostedStart.hosted, true);
  assert.equal(hostedStart.paired, false);
  const waiting = await waitForStatus(hosted, 'awaiting_authorization', false);
  assert.equal(waiting.hosted, true);
  assert.equal(waiting.expectedUsername, hostedUsername);
  assert.equal(JSON.parse(await readFile(hostedPath, 'utf8')).xUserId, undefined);

  hostedAuthorized = true;
  await waitForStatus(hosted, 'online', true, 12_000);
  assert.equal(JSON.parse(await readFile(hostedPath, 'utf8')).xUserId, hostedXUserId);
  const hostedInbox = await api('/dm/inbox?accountId=' + hosted);
  assert.deepEqual(hostedInbox.conversations.map(({ preview }) => preview), ['Hosted private message']);

  assert.ok(bridgeChecks >= 3);
  assert.deepEqual(violations, []);
  assert.ok(!logs.includes(matrixAccessToken), 'Matrix credential was written to server logs');
  assert.ok(!logs.includes(hostedMatrixToken), 'Hosted Matrix credential was written to server logs');
});
