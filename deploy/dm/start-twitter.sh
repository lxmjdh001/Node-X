#!/bin/sh
set -eu

config=/data/config.yaml
if ! proxy=$(yq -er '.network.proxy | select(tag == "!!str")' "$config" 2>/dev/null) ||
   ! dynamic_proxy=$(yq -r '.network.get_proxy_url // ""' "$config" 2>/dev/null); then
  echo 'The pilot SOCKS5 configuration could not be loaded.' >&2
  exit 1
fi
case "$proxy" in
  socks5://?*) ;;
  *) echo 'A dedicated SOCKS5 URL is required for this bridge.' >&2; exit 1 ;;
esac
if [ -n "$dynamic_proxy" ]; then
  echo 'This pilot requires its static account proxy.' >&2
  exit 1
fi
unset proxy dynamic_proxy
exec /usr/bin/mautrix-twitter --no-update -c "$config"
