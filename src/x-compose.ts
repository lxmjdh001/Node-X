export function xComposeUrl(text: string): string {
  const url = new URL('https://x.com/intent/tweet');
  url.searchParams.set('text', text);
  return url.href;
}
