import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const cli = fileURLToPath(new URL('connector.mjs', import.meta.url));
const bot = '@twitterbot:matrix.test';
const own = '@operator:matrix.test';
const peer = '@twitter_9:matrix.test';
const jobId = 'e906e40d-1e79-4873-b97c-6711f5b6340a';
const uncertainId = 'e906e40d-1e79-4873-b97c-6711f5b6340b';
const roomId = '!allowed:matrix.test';
const now = Date.now();
const bridge = (xId, sender = bot) => ({
  type: 'm.bridge', state_key: 'twitter', sender, content: {
    bridgebot: bot, protocol: { id: 'twitter' }, channel: { receiver: xId, displayname: 'X 私信' },
  },
});
const text = (eventId, sender, body) => ({
  type: 'm.room.message', event_id: eventId, sender, origin_server_ts: now, content: { msgtype: 'm.text', body },
});
const status = (sender, state) => ({
  type: 'com.beeper.message_send_status', sender,
  content: { status: state, 'm.relates_to': { event_id: '$matrix-send' } },
});
const room = (states, messages) => ({ state: { events: states }, timeline: { events: messages } });

async function waitFor(predicate, output) {
  const end = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Connector did not finish. Logs:\n' + output());
    await delay(25);
  }
}

test('syncs only a trusted X account and waits for mautrix to confirm replies', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nodex-matrix-test-'));
  const configPath = join(directory, 'connector.json');
  let syncs = 0;
  let pairs = 0;
  let claims = 0;
  let sawResume = false;
  let outbound = null;
  let unknownSubmissions = 0;
  let child;
  let logs = '';
  const conversations = [];
  const results = [];
  const violations = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const url = new URL(req.url, 'http://test.local');
    const path = decodeURIComponent(url.pathname);
    const token = req.headers.authorization;
    function reply(data) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); }
    if (path.startsWith('/_matrix/') && token !== 'Bearer fixture-matrix') violations.push('invalid Matrix authentication');
    if (path.startsWith('/api/dm/connector/') && !path.endsWith('/pair') && token !== 'Bearer fixture-nodex') {
      violations.push('invalid Node X authentication');
    }
    if (path.endsWith('/whoami')) return reply({ user_id: own });
    if (path.endsWith('/pair')) {
      pairs++;
      if (body.ticket !== 'fixture-ticket' || body.xUserId !== '1234') violations.push('invalid pair parameters');
      return reply({ token: 'fixture-nodex', account: { id: 'account', xUserId: '1234' } });
    }
    if (path.endsWith('/sync')) {
      syncs++;
      if (url.searchParams.get('since') && url.searchParams.get('full_state') === 'true') sawResume = true;
      const joinRooms = {};
      if (syncs === 1) {
        joinRooms[roomId] = room([bridge('1234')], [text('$incoming', peer, 'Fixture incoming')]);
        joinRooms['!wrong:matrix.test'] = room([bridge('9876')], [text('$wrong', peer, 'Wrong X account')]);
        joinRooms['!forged:matrix.test'] = room([bridge('1234', peer)], [text('$forged', peer, 'Forged metadata')]);
        joinRooms['!encrypted:matrix.test'] = room([bridge('1234'), { type: 'm.room.encryption', state_key: '' }],
          [text('$encrypted', peer, 'Must not import encrypted room')]);
      } else if (syncs === 2) {
        const echo = text('$matrix-send', own, 'Fixture reply');
        echo.content['org.nodex.reply_id'] = jobId;
        joinRooms[roomId] = room([], [echo, status(peer, 'SUCCESS')]);
      } else if (syncs === 3) {
        joinRooms[roomId] = room([], [status(bot, 'SUCCESS')]);
      }
      return reply({ next_batch: 'cursor-' + syncs, rooms: { join: joinRooms } });
    }
    if (path.endsWith('/events')) {
      conversations.push(...body.conversations);
      return reply({ received: body.conversations.length });
    }
    if (path.endsWith('/jobs/claim')) {
      claims++;
      const id = claims === 1 ? jobId : claims === 2 ? uncertainId : null;
      return reply({ jobs: id ? [{ id, conversationId: roomId, text: 'Fixture reply' }] : [] });
    }
    if (path.endsWith('/state')) return reply([bridge('1234')]);
    if (path.endsWith('/send/m.room.message/' + jobId)) {
      if (outbound || !path.includes(roomId) || req.method !== 'PUT') violations.push('invalid or duplicate send');
      outbound = body;
      return reply({ event_id: '$matrix-send' });
    }
    if (path.endsWith('/jobs/' + jobId + '/result')) {
      if (syncs !== 3) violations.push('sent before mautrix confirmed');
      results.push(body);
      return reply({ ok: true });
    }
    if (path.endsWith('/send/m.room.message/' + uncertainId)) {
      unknownSubmissions++;
      return res.destroy();
    }
    if (path.endsWith('/jobs/' + uncertainId + '/result')) {
      results.push(body);
      return reply({ ok: true });
    }
    violations.push('unexpected route');
    res.statusCode = 404;
    reply({});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'close');
    }
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const config = { nodeXUrl: base, matrixUrl: base, matrixAccessToken: 'fixture-matrix', bridgeBotId: bot,
    xUserId: '1234', pairTicket: 'fixture-ticket' };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  function start() {
    child = spawn(process.execPath, [cli, configPath]);
    child.stdout.on('data', value => { logs += value.toString(); });
    child.stderr.on('data', value => { logs += value.toString(); });
  }
  start();
  await waitFor(() => results.length === 2, () => logs);
  assert.deepEqual(violations, []);
  assert.deepEqual(outbound, { msgtype: 'm.text', body: 'Fixture reply', 'org.nodex.reply_id': jobId });
  assert.deepEqual(results[0], { status: 'sent', remoteId: '$matrix-send' });
  assert.equal(results[1].status, 'uncertain');
  assert.equal(unknownSubmissions, 1);
  assert.deepEqual(conversations.flatMap(item => item.messages).map(message => message.id), ['$incoming']);
  assert.ok(conversations.every(item => item.id === roomId));
  assert.match(logs, /Matrix 端到端加密/);
  assert.ok(!logs.includes('fixture-matrix') && !logs.includes('fixture-nodex'));

  child.kill('SIGTERM');
  await once(child, 'close');
  const saved = JSON.parse(await readFile(configPath + '.state.json', 'utf8'));
  assert.ok(saved.since);
  await writeFile(configPath, JSON.stringify({ ...config, pairTicket: undefined }), { mode: 0o600 });
  start();
  await waitFor(() => sawResume, () => logs);
  assert.equal(pairs, 1);
  assert.equal(results.length, 2);
  assert.equal(unknownSubmissions, 1);
});
