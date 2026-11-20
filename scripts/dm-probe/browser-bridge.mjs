import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createBridge } from '../../server/browser-proxy.ts';

const proxy = new URL(process.argv[2]);
const target = process.argv[3];
assert.equal(proxy.protocol, 'socks5:');
assert.equal(proxy.hostname, '127.0.0.1');
assert.match(target, /^127\.0\.0\.1:\d+$/);

const bridge = await createBridge({
  host: proxy.hostname,
  port: Number(proxy.port),
  username: decodeURIComponent(proxy.username),
  password: decodeURIComponent(proxy.password),
}, null, false);

try {
  const socket = await new Promise((resolve, reject) => {
    const connect = request({ host: '127.0.0.1', port: bridge.port, method: 'CONNECT', path: target });
    connect.on('connect', (response, tunnel) => {
      if (response.statusCode === 200) resolve(tunnel);
      else {
        tunnel.destroy();
        reject(new Error(`Browser bridge rejected CONNECT with status ${response.statusCode}`));
      }
    });
    connect.on('error', reject);
    connect.setTimeout(3000, () => connect.destroy(new Error('CONNECT timed out')));
    connect.end();
  });
  socket.setTimeout(3000, () => socket.destroy(new Error('Fixture HTTP response timed out')));
  socket.write(`GET / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
  let response = '';
  for await (const chunk of socket) response += chunk.toString('ascii');
  assert.match(response, /^HTTP\/1\.1 204 /);
} finally {
  await bridge.close();
}
