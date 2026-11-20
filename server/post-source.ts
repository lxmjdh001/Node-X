import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { InputError } from './errors.js';
import { MAX_SOURCE_TEXT } from '../src/post-queue.js';

type Node = DefaultTreeAdapterTypes.Node;

export function postSource(input: string): { url: string; platform: 'x' | 'facebook' } {
  let url: URL;
  try {
    url = new URL(input.startsWith('https://') ? input : `https://${input}`);
  } catch {
    throw new InputError('请输入有效的 X 或 Facebook 帖子链接。');
  }
  const host = url.hostname.replace(/^www\./, '');
  if (url.username || url.password || url.port || url.protocol !== 'https:') {
    throw new InputError('请输入有效的 HTTPS 帖子链接。');
  }
  if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') {
    const match = /^\/(i\/web|[A-Za-z0-9_]{1,15})\/status\/(\d{1,20})(?:\/|$)/.exec(url.pathname);
    if (!match) throw new InputError('请粘贴单条 X 帖子的链接。');
    return { platform: 'x', url: `https://x.com/${match[1]}/status/${match[2]}` };
  }
  if (host === 'facebook.com' || host === 'm.facebook.com') {
    const source = new URL('https://www.facebook.com');
    if (/^\/(permalink|story)\.php$/.test(url.pathname)) {
      const id = url.searchParams.get('id');
      const post = url.searchParams.get('story_fbid');
      if (!id || !/^\d+$/.test(id) || !post || !/^[a-z0-9]+$/i.test(post)) throw new InputError('Facebook 帖子链接缺少帖子标识。');
      source.pathname = url.pathname;
      source.searchParams.set('id', id);
      source.searchParams.set('story_fbid', post);
    } else {
      const match = /^\/(?:[\w.-]+\/(?:posts|permalink)|groups\/[\w.-]+\/(?:posts|permalink)|share\/p)\/([a-z0-9_]+)\/?$/i.exec(url.pathname);
      if (!match) throw new InputError('请粘贴单条 Facebook 帖子的链接。');
      source.pathname = url.pathname;
    }
    return { platform: 'facebook', url: source.href };
  }
  throw new InputError('目前支持 X 和 Facebook 帖子链接。');
}

function nodesWithTag(node: Node, tag: string): DefaultTreeAdapterTypes.Element[] {
  if ('tagName' in node && node.tagName === tag) return [node];
  return 'childNodes' in node ? node.childNodes.flatMap(child => nodesWithTag(child, tag)) : [];
}

function plainText(node: Node): string {
  if ('value' in node) return node.value;
  if ('tagName' in node && (node.tagName === 'script' || node.tagName === 'style')) return '';
  if ('tagName' in node && node.tagName === 'br') return '\n';
  return 'childNodes' in node ? node.childNodes.map(plainText).join('') : '';
}

export async function readPostSource(source: ReturnType<typeof postSource>): Promise<string> {
  const isX = source.platform === 'x';
  const endpoint = new URL(isX ? 'https://publish.x.com/oembed' : 'https://graph.facebook.com/v27.0/oembed_post');
  endpoint.searchParams.set('url', source.url);
  endpoint.searchParams.set(isX ? 'omit_script' : 'omitscript', 'true');
  try {
    const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(7000) });
    if (response.ok) {
      const body = await response.json() as { html?: unknown };
      if (typeof body.html === 'string' && body.html.length <= 128_000) {
        const quote = nodesWithTag(parseFragment(body.html), 'blockquote')[0];
        const text = quote && nodesWithTag(quote, 'p').map(plainText).join('\n\n').trim();
        if (text && text.length <= MAX_SOURCE_TEXT) return text;
      }
    }
  } catch {
    // A failed or unavailable public embed can still be imported with pasted text.
  }
  throw new InputError('平台没有返回可读取的正文。请打开原帖并粘贴正文，链接仍会保留。', 422);
}
