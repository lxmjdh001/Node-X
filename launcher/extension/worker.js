import { origin, hostName } from './config.js';

let native;
const pending = new Map();

function nativePort() {
  if (native) return native;
  const port = chrome.runtime.connectNative(hostName);
  native = port;
  port.onMessage.addListener((reply) => {
    const callback = pending.get(reply?.id);
    if (!callback) return;
    callback({ success: reply.success === true, message: reply.message });
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    if (native !== port) return;
    native = undefined;
    const message = error?.message?.includes('not found')
      ? 'Chrome 扩展已安装。请先运行安装包里的安装脚本。'
      : '本机启动器已断开，请重试。';
    for (const callback of pending.values()) callback({ success: false, message });
  });
  return port;
}

chrome.runtime.onMessageExternal.addListener((request, sender, reply) => {
  if (sender.origin !== origin || sender.frameId > 0 || (request?.type !== 'open' && request?.type !== 'open-composer' && request?.type !== 'open-messages') ||
      typeof request.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.ticket)) return false;

  const id = crypto.randomUUID();
  const timeout = setTimeout(() => respond({ success: false, message: '本机启动器响应超时，请重试。' }), 24_000);
  function respond(result) {
    clearTimeout(timeout);
    pending.delete(id);
    reply(result);
  }
  pending.set(id, respond);
  try {
    nativePort().postMessage({ id, type: request.type, ticket: request.ticket });
  } catch {
    respond({ success: false, message: '无法连接本机启动器，请检查安装后重试。' });
  }
  return true;
});
