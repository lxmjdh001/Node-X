import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright';
import { z } from 'zod';
import { workspaceAuthorized } from './auth.js';
import { chromiumInfo, macChromeLauncher, useBrowserComposer } from './browser.js';
import { ContentError } from './content.js';
import { InputError } from './errors.js';
import { clientLauncher } from './launcher.js';
import { requiredModel, runModel } from './models.js';
import { accountBrowserProfile, accountById, openProxy, proxyById, type Account } from './workspace.js';

const browserPublishingSupported = !macChromeLauncher && !clientLauncher;

export async function checkBrowserPublishing() {
  if (!browserPublishingSupported) throw new InputError('本机 Chrome 启动器仅支持手动打开发布页。', 409);
  requiredModel('publishing');
  if (!(await chromiumInfo()).installed) throw new InputError('请先安装工作台使用的 Chromium。', 409);
}

export function browserPublishingTarget(account: Account) {
  const handle = account.xUsername || account.username;
  const profile = accountBrowserProfile(account.id);
  if (!profile) throw new InputError(`「${account.label}」需要先创建浏览器环境。`, 409);
  if (!handle) throw new InputError(`请先为「${account.label}」填写 X 用户名。`, 409);
  return { profile, handle };
}

function composerControls(page: Page) {
  return {
    profile: page.getByTestId('AppTabBar_Profile_Link'),
    editor: page.getByTestId('tweetTextarea_0'),
    button: page.getByTestId('tweetButton').or(page.getByTestId('tweetButtonInline')).filter({ visible: true }),
  };
}

async function requireReady(page: Page, handle: string, text: string) {
  const { profile, editor, button } = composerControls(page);
  const url = new URL(page.url());
  if (url.origin !== 'https://x.com' || !['/compose/post', '/intent/tweet'].includes(url.pathname)) {
    throw new InputError('未进入 X 发帖页，请核对浏览器登录状态。');
  }
  const href = await profile.getAttribute('href', { timeout: 5000 }).catch(() => null);
  if (href?.toLowerCase() !== '/' + handle.toLowerCase()) {
    throw new InputError(`浏览器当前登录账号无法确认为 @${handle}。`);
  }
  const rendered = await editor.innerText({ timeout: 5000 }).catch(() => '');
  if (rendered.trim().replace(/\r\n?/g, '\n') !== text.trim().replace(/\r\n?/g, '\n')) {
    throw new InputError('X 发帖页的正文与草稿不一致，请打开页面核对。');
  }
  if (await button.count() !== 1 || !await button.isEnabled({ timeout: 5000 })) {
    throw new InputError('X 未提供可用的发布按钮，请打开页面核对。');
  }
  return button;
}

const choice = z.object({ tool: z.enum(['click_publish', 'stop']) });

export async function publishInBrowser(workspace: string | undefined, accountId: string, text: string) {
  let attempted = false;
  try {
    if (!browserPublishingSupported) throw new InputError('本机 Chrome 启动器仅支持手动打开发布页。');
    const model = requiredModel('publishing');
    const { profile, handle } = browserPublishingTarget(accountById(accountId));
    return await useBrowserComposer({ ...profile, proxy: openProxy(proxyById(profile.proxyId)) }, text, async page => {
      await composerControls(page).editor.waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => { throw new InputError('X 发帖框未就绪，请核对登录状态和代理。'); });
      await requireReady(page, handle, text);

      const server = new McpServer({ name: 'node-x-composer', version: '1.0.0' });
      const client = new Client({ name: 'node-x-publisher', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      let postId: string | undefined;
      let toolError: unknown;
      server.registerTool('click_publish', {
        description: '点击用户已确认的 X 发帖页的发布按钮。只能提交当前草稿一次。',
      }, async () => {
        try {
          const button = await requireReady(page, handle, text);
          if (!workspaceAuthorized(workspace)) throw new InputError('当前授权已失效，请重新登录。', 403);
          if (attempted) throw new InputError('发布按钮已提交，请先核对结果。');
          attempted = true;
          await button.click({ timeout: 5000 });
          const link = page.getByTestId('toast').locator('a[href*="/status/"]').filter({ visible: true }).first();
          const href = await link.getAttribute('href', { timeout: 15_000 });
          const published = new URL(href ?? '', 'https://x.com');
          const match = /^\/([a-z0-9_]+)\/status\/(\d+)\/?$/i.exec(published.pathname);
          if (published.origin !== 'https://x.com' || match?.[1].toLowerCase() !== handle.toLowerCase()) {
            throw new Error('X did not confirm a post for this account');
          }
          postId = match[2];
          return { content: [{ type: 'text', text: postId }] };
        } catch (error) {
          toolError = error;
          return { isError: true, content: [{ type: 'text', text: 'X 网页发布未确认。' }] };
        }
      });

      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const { tools } = await client.listTools();
        const raw = await runModel(model,
          '你负责执行用户已经确认的发布操作。仅当工具和已核对的发帖页都就绪时选择 click_publish，否则选择 stop。只返回 JSON，例如 {"tool":"click_publish"}。',
          JSON.stringify({ tools, account: handle, composerReady: true }), 512, 25_000);
        const json = /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i.exec(raw)?.[1] ?? raw;
        if (choice.parse(JSON.parse(json)).tool === 'stop') throw new InputError('发布模型选择停止。');
        await client.callTool({ name: 'click_publish' });
        if (!postId) throw toolError ?? new Error('MCP returned no post ID');
        return postId;
      } finally {
        await Promise.allSettled([client.close(), server.close()]);
      }
    });
  } catch (error) {
    if (attempted) throw new ContentError('BROWSER_UNCERTAIN', 'MCP 已尝试点击发布。请先在 X 核对该帖是否发出。', 502, 'uncertain');
    throw new ContentError('BROWSER_FAILED',
      error instanceof InputError ? error.message : 'MCP 未点击发布，请检查发布模型、浏览器和代理后重试。', 502);
  }
}
