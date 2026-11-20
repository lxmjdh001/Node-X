import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import config from './config.json' with { type: 'json' };

const preview = process.argv.includes('--preview');
const origin = preview ? config.previewOrigin : config.origin;
const hostName = preview ? config.hostName + '_preview' : config.hostName;
const dist = resolve('dist');
const filename = preview ? 'node-x-mac-preview.zip' : 'node-x-mac.zip';
await mkdir(dist, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'nodex-launcher-'));
try {
  const root = join(scratch, 'Node X Mac 启动器');
  const extension = join(root, 'extension');
  await mkdir(extension, { recursive: true });
  await cp('launcher/extension/worker.js', join(extension, 'worker.js'));
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Node X 本机启动器' + (preview ? '（预览）' : ''),
    version: '0.1.0',
    key: config.extensionKey,
    minimum_chrome_version: '105',
    permissions: ['nativeMessaging'],
    externally_connectable: { matches: [new URL(origin).hostname === '127.0.0.1' ? 'http://127.0.0.1/*' : origin + '/*'] },
    background: { service_worker: 'worker.js', type: 'module' },
  }, null, 2));
  await writeFile(join(extension, 'config.js'), `export const origin = ${JSON.stringify(origin)};\nexport const hostName = ${JSON.stringify(hostName)};\n`);
  await writeFile(join(root, 'install-config.json'), JSON.stringify({
    preview, origin, hostName, extensionId: config.extensionId,
  }));
  await cp('launcher/install.mjs', join(root, 'install.mjs'));
  await cp('launcher/install-mac.command', join(root, 'install-mac.command'));
  await cp('launcher/安装说明.txt', join(root, '安装说明.txt'));
  const result = await build({
    entryPoints: ['launcher/native-host.ts'],
    outfile: join(root, 'native-host.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'eof',
    metafile: true,
  });
  const packages = new Set(Object.keys(result.metafile.inputs)
    .flatMap(path => [...path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)].slice(-1).map(m => m[1])));
  for (const name of packages) {
    const packageDir = join('node_modules', name);
    for (const filename of await readdir(packageDir)) {
      if (!/^(?:license|notice|copying)(?:[.\-_].*)?$/i.test(filename)) continue;
      const directory = join(root, 'licenses', name);
      await mkdir(directory, { recursive: true });
      await cp(join(packageDir, filename), join(directory, filename));
    }
  }
  execFileSync('zip', ['-qr', join(scratch, filename), 'Node X Mac 启动器'], { cwd: scratch });
  await cp(join(scratch, filename), join(dist, filename));
  console.log(join(dist, filename));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
