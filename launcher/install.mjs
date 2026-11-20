import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [target, chromeHosts] = process.argv.slice(2);
const source = fileURLToPath(new URL('.', import.meta.url));
const config = JSON.parse(readFileSync(join(source, 'install-config.json'), 'utf8'));
const bundle = join(target, config.preview ? 'preview-app' : 'app');
const extension = join(bundle, 'extension');
mkdirSync(extension, { recursive: true, mode: 0o700 });
const copy = (from, to) => replace(to, readFileSync(from));
function replace(path, contents, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode, flag: 'wx' });
  renameSync(temporary, path);
}
for (const file of readdirSync(join(source, 'extension'))) {
  copy(join(source, 'extension', file), join(extension, file));
}
const host = join(bundle, 'native-host.cjs');
copy(join(source, 'native-host.cjs'), host);
const shell = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const executable = join(bundle, 'native-host');
replace(executable, `#!/bin/sh\nexec ${shell(process.execPath)} ${shell(host)}${config.preview ? ' --preview' : ''} "$@"\n`, 0o700);
chmodSync(executable, 0o700);
replace(join(chromeHosts, `${config.hostName}.json`), JSON.stringify({
  name: config.hostName,
  description: 'Node X 本机启动器',
  path: executable,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${config.extensionId}/`],
}, null, 2));
console.log('启动器已安装。打开 chrome://extensions，开启「开发者模式」，点击「加载已解压的扩展程序」，选择以下文件夹。');
console.log(extension);
console.log(`安装扩展后，回到 ${config.origin}/#profiles，点击「打开 X」。`);
