#!/bin/bash
set -euo pipefail
umask 077
if [[ "$(uname -s)" != Darwin ]]; then
  printf '%s\n' '此安装包适用于 macOS。' >&2
  exit 1
fi
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
  printf '%s\n' '请先从 https://nodejs.org/ 安装 Node.js 22 或更新版本，再运行此脚本。' >&2
  exit 1
fi
if [[ ! -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ]]; then
  printf '%s\n' '请先将 Google Chrome 安装到「应用程序」文件夹。' >&2
  exit 1
fi

cd "$(dirname "$0")"
source_dir="$(pwd -P)"
target="$HOME/Library/Application Support/Node X Launcher"
chrome_hosts="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$target" "$chrome_hosts"
node "$source_dir/install.mjs" "$target" "$chrome_hosts"
