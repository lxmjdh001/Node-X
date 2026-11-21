import assert from 'node:assert/strict';
import dns, { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import https, { request } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { dmPublicUrl, publicDmFetch } = await tsImport('../../server/dm-public-https.ts', import.meta.url);
const endpoint = 'https://matrix.fixture.test/_matrix/client/v3/sync?timeout=2000';
const publicAnswer = { address: '1.1.1.1', family: 4 };

function fixtureTransport(t, answers, respond) {
  const dnsLookup = t.mock.method(dns, 'lookup', async (host, options) => {
    assert.equal(host, 'matrix.fixture.test');
    assert.equal(options.all, true);
    return answers;
  });
  const httpsRequest = t.mock.method(https, 'request', (url, options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.end = body => respond(url, options, callback, body, outgoing);
    return outgoing;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  // Keep the entire fixture offline.
  assert.equal(lookup, dnsLookup);
  assert.equal(request, httpsRequest);
  return { dnsLookup, httpsRequest };
}

test('customer DM endpoint configuration accepts only public HTTPS on port 443', t => {
  const previous = process.env.NODEX_PUBLIC_ORIGIN;
  process.env.NODEX_PUBLIC_ORIGIN = 'https://workbench.fixture.test';
  t.after(() => {
    if (previous === undefined) delete process.env.NODEX_PUBLIC_ORIGIN;
    else process.env.NODEX_PUBLIC_ORIGIN = previous;
  });
  assert.equal(dmPublicUrl('https://matrix.fixture.test:443/', 'matrix'), 'https://matrix.fixture.test');
  assert.equal(dmPublicUrl('https://matrix.fixture.test/_matrix/provision/', 'bridge'),
    'https://matrix.fixture.test/_matrix/provision');
  for (const input of [
    'http://matrix.fixture.test', 'https://matrix.fixture.test:8448',
    'https://user:password@matrix.fixture.test', 'https://matrix.fixture.test/path',
    'https://matrix.fixture.test?q=test', 'https://a.localhost',
    'https://workbench.fixture.test.', 'https://127.0.0.1', 'https://100.64.0.1',
    'https://192.0.2.1', 'https://[::1]', 'https://[fc00::1]', 'https://[::ffff:8.8.8.8]',
  ]) {
    assert.throws(() => dmPublicUrl(input, 'matrix'), { status: 422 });
  }
});

test('a mixed DNS answer never opens a connection', async t => {
  const { dnsLookup, httpsRequest } = fixtureTransport(t,
    [publicAnswer, { address: '10.0.0.1', family: 4 }], () => {});
  await assert.rejects(publicDmFetch(endpoint, {}), { message: '私信服务请求失败。' });
  assert.equal(dnsLookup.mock.callCount(), 1);
  assert.equal(httpsRequest.mock.callCount(), 0);
});

test('the caller can abort a pending DNS lookup', async t => {
  const abort = new AbortController();
  const { promise, resolve } = Promise.withResolvers();
  const { dnsLookup, httpsRequest } = fixtureTransport(t, promise, () => {});
  try {
    const response = publicDmFetch(endpoint, { signal: abort.signal });
    abort.abort();
    await assert.rejects(response, { message: '私信服务请求失败。' });
    assert.equal(dnsLookup.mock.callCount(), 1);
    assert.equal(httpsRequest.mock.callCount(), 0);
  } finally {
    resolve([publicAnswer]);
  }
});

test('verified DNS is pinned without replacing the TLS hostname, and body reads can be aborted', async t => {
  const abort = new AbortController();
  const { dnsLookup, httpsRequest } = fixtureTransport(t, [publicAnswer], (url, options, callback, _body, outgoing) => {
    assert.equal(url.hostname, 'matrix.fixture.test');
    assert.equal(url.pathname, '/_matrix/client/v3/sync');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    assert.equal(options.headers.authorization, 'Bearer fixture-credential');
    assert.equal(options.headers.host, undefined);
    options.lookup(url.hostname, { all: false }, (error, address, family) => {
      assert.equal(error, null);
      assert.deepEqual({ address, family }, publicAnswer);
    });
    const incoming = new PassThrough();
    incoming.statusCode = 200;
    options.signal.addEventListener('abort', () => {
      const error = new Error('Private fixture diagnostic');
      incoming.destroy(error);
      outgoing.emit('error', error);
    }, { once: true });
    callback(incoming);
    incoming.write('fixture bytes');
  });
  const response = await publicDmFetch(endpoint, {
    signal: abort.signal,
    headers: { authorization: 'Bearer fixture-credential', host: 'other.fixture.test' },
  });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'fixture bytes');
  const pendingRead = reader.read();
  abort.abort();
  await assert.rejects(pendingRead, { message: '私信服务请求失败。' });
  assert.equal(dnsLookup.mock.callCount(), 1);
  assert.equal(httpsRequest.mock.callCount(), 1);
});

test('HTTPS redirects are rejected without following their location', async t => {
  const { httpsRequest } = fixtureTransport(t, [publicAnswer], (_url, _options, callback) => {
    const incoming = new PassThrough();
    incoming.statusCode = 302;
    incoming.headers = { location: 'https://other.fixture.test/' };
    callback(incoming);
  });
  await assert.rejects(publicDmFetch(endpoint, {}), { message: '私信服务请求失败。' });
  assert.equal(httpsRequest.mock.callCount(), 1);
});
