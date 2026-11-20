#!/bin/sh
set -eu

revision=2efd3a5da34d459f2a75b5140f96b99f41582766
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
checkout=$(mktemp -d "${TMPDIR:-/tmp}/nodex-mautrix-probe.XXXXXXXX")
cleanup() {
  # Only remove the checkout created by this invocation.
  case "$checkout" in
    "${TMPDIR:-/tmp}"/nodex-mautrix-probe.*) find "$checkout" -depth -delete ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "$checkout" init --quiet
git -C "$checkout" fetch --quiet --depth=1 https://github.com/mautrix/twitter.git "$revision"
git -C "$checkout" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$checkout" rev-parse HEAD)" = "$revision"
cp "$script_dir/proxy_test.go" "$checkout/pkg/twittermeow/nodex_proxy_test.go"

cd "$checkout"
# Test against the upstream module, including its dependency replacements.
NODEX_PROBE_DIR="$script_dir" GOTOOLCHAIN=${GOTOOLCHAIN_OVERRIDE:-go1.26.0} \
  go test ./pkg/twittermeow -run '^TestNodeXSOCKS5$' -count=1 -v
