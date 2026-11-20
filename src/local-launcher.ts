type Reply = { success?: boolean; message?: string };
type ChromeRuntime = {
  lastError?: { message?: string };
  sendMessage: (extension: string, data: { type: 'open'; ticket: string }, callback: (reply?: Reply) => void) => void;
};

export async function launchOnMac(extension: string, issueTicket: () => Promise<{ ticket: string }>): Promise<string> {
  const runtime = (window as Window & { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
  const missing = '请用 Mac 上的 Google Chrome 打开工作台，并安装本机启动器扩展。';
  if (!runtime?.sendMessage) throw new Error(missing);
  const { ticket } = await issueTicket();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('等待本机启动器响应超时，请检查安装后重试。')), 26_000);
    try {
      runtime.sendMessage(extension, { type: 'open', ticket }, (reply) => {
        clearTimeout(timeout);
        if (runtime.lastError) {
          reject(new Error(missing));
        } else if (!reply?.success) {
          reject(new Error(reply?.message || '本机启动器未接收请求，请检查安装后重试。'));
        } else {
          resolve(reply.message || '已在本机打开 Chrome。');
        }
      });
    } catch {
      clearTimeout(timeout);
      reject(new Error(missing));
    }
  });
}
