import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { InputError } from './errors.js';
import type { ProxySettings } from './browser.js';

const blocked = new BlockList();
for (const [host, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(host, bits);
for (const [host, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(host, bits, 'ipv6');
}
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

function publicAddress(address: string, local: BlockList): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address) && !local.check(address);
  return family === 6 && globalIPv6.check(address, 'ipv6') &&
    !blocked.check(address, 'ipv6') && !local.check(address, 'ipv6');
}

/** Resolve once and connect to that literal IP, even if a customer's DNS later changes. */
export async function publicProxy(proxy: ProxySettings): Promise<ProxySettings> {
  const local = new BlockList();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const { address } of addresses ?? []) {
      const host = address.split('%')[0];
      local.addAddress(host, isIP(host) === 6 ? 'ipv6' : 'ipv4');
    }
  }
  let candidates: { address: string }[];
  try {
    candidates = isIP(proxy.host) ? [{ address: proxy.host }] : await lookup(proxy.host, { all: true });
  } catch {
    throw new InputError('未能解析 SOCKS5 代理地址。', 422);
  }
  if (!candidates.length || candidates.some(({ address }) => !publicAddress(address, local))) {
    throw new InputError('线上浏览器和代理检测需要公网 SOCKS5 地址。', 422);
  }
  const first = candidates.find(({ address }) => isIP(address) === 4) ?? candidates[0];
  return { ...proxy, host: first.address };
}

const X_HOSTS = ['x.com', 'twitter.com', 'twimg.com', 't.co', 'arkoselabs.com', 'funcaptcha.com',
  'accounts.google.com', 'gstatic.com', 'appleid.apple.com', 'cdn-apple.com'];

export function allowedBrowserTarget(host: string, port: number): boolean {
  host = host.toLowerCase().replace(/\.$/, '');
  return (port === 443 || port === 80) && X_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
