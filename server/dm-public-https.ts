import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { InputError } from './errors.js';
import { isPublicAddress, resolvePublicAddress } from './public-proxy.js';

const requestTimeout = 30_000;
const networkError = '私信服务请求失败。';
const invalidUrl = '请填写使用 HTTPS 443 端口的公网私信服务地址。';
const methods = new Set(['GET', 'POST', 'PUT']);

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function ownHostname(value: string | undefined): string | undefined {
  return value && URL.canParse(value) ? hostname(new URL(value)).replace(/\.$/, '') : undefined;
}

function endpoint(input: string): URL {
  const url = new URL(input);
  const host = hostname(url).replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      host === ownHostname(process.env.NODEX_PUBLIC_ORIGIN) ||
      host === ownHostname(process.env.NODEX_OPERATOR_PUBLIC_ORIGIN) ||
      (isIP(host) ? !isPublicAddress(host) :
        !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host))) {
    throw new Error(invalidUrl);
  }
  return url;
}

export function dmPublicUrl(input: string, kind: 'matrix' | 'bridge'): string {
  try {
    const url = endpoint(input);
    const path = url.pathname.replace(/\/+$/, '');
    if (url.search || (kind === 'matrix' && path) || (kind === 'bridge' && !path)) throw new Error(invalidUrl);
    return url.origin + path;
  } catch {
    throw new InputError(invalidUrl, 422);
  }
}

function streamedBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  const chunks = incoming[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await chunks.next();
        if (chunk.done) controller.close();
        else controller.enqueue(Uint8Array.from(chunk.value));
      } catch {
        controller.error(new Error(networkError));
      }
    },
    cancel() {
      incoming.destroy();
    },
  }, { highWaterMark: 0 });
}

export async function publicDmFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    const url = endpoint(input);
    const deadline = AbortSignal.timeout(requestTimeout);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body;
    if (!methods.has(method) || (body != null && typeof body !== 'string')) throw new Error(networkError);
    const headers = new Headers(init.headers);
    const authorization = headers.get('authorization');
    const contentType = headers.get('content-type');
    const forwardedHeaders = {
      accept: 'application/json',
      'accept-encoding': 'identity',
      ...(authorization ? { authorization } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const destination = await resolvePublicAddress(hostname(url), signal);
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = request(url, {
        method, headers: forwardedHeaders, signal, agent: false, rejectUnauthorized: true,
        family: destination.family,
        lookup: (_host, options, callback) => {
          // Keep the URL hostname for SNI and certificate verification. Only the socket lookup is pinned.
          if (options.all) callback(null, [destination]);
          else callback(null, destination.address, destination.family);
        },
      }, incoming => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || (status >= 300 && status < 400) || status > 599) {
          incoming.destroy();
          reject(new Error(networkError));
          return;
        }
        if (status === 204 || status === 205) {
          incoming.destroy();
          resolve(new Response(null, { status }));
          return;
        }
        resolve(new Response(streamedBody(incoming), { status }));
      });
      outgoing.on('error', () => reject(new Error(networkError)));
      outgoing.end(body ?? undefined);
    });
  } catch {
    throw new Error(networkError);
  }
}
