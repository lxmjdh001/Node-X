#!/bin/sh
set -eu
umask 077

if [ "$(id -u)" != 0 ] || [ "$#" != 1 ]; then
  echo 'Run as root with a path to the root-owned mode 600 SOCKS5 URL file.' >&2
  exit 1
fi
proxy_file=$(realpath "$1")
if [ ! -f "$proxy_file" ] || [ "$(stat -c '%u:%a' "$proxy_file")" != '0:600' ]; then
  echo 'The SOCKS5 file must be a root-owned regular file with mode 600.' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export NODEX_DM_DATA_DIR=${NODEX_DM_DATA_DIR:-/var/lib/nodex-dm}
case "$NODEX_DM_DATA_DIR" in /*) ;; *) echo 'Use an absolute data directory.' >&2; exit 1 ;; esac
if command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose -p nodex-dm-pilot -f "$script_dir/docker-compose.yml" "$@"; }
else
  compose() { docker compose -p nodex-dm-pilot -f "$script_dir/docker-compose.yml" "$@"; }
fi

install -d -m 0700 "$NODEX_DM_DATA_DIR" "$NODEX_DM_DATA_DIR/secrets" "$NODEX_DM_DATA_DIR/postgres"
install -d -o 991 -g 991 -m 0700 "$NODEX_DM_DATA_DIR/synapse" "$NODEX_DM_DATA_DIR/synapse/appservices"
install -d -o 1337 -g 1337 -m 0700 "$NODEX_DM_DATA_DIR/twitter"
exec 9>"$NODEX_DM_DATA_DIR/bootstrap.lock"
flock -n 9

database_secret="$NODEX_DM_DATA_DIR/secrets/postgres-password"
if [ ! -f "$database_secret" ]; then
  openssl rand -hex 32 >"$database_secret.tmp"
  mv "$database_secret.tmp" "$database_secret"
fi
if [ ! -f "$NODEX_DM_DATA_DIR/twitter/config.yaml" ] || [ ! -f "$NODEX_DM_DATA_DIR/twitter/registration.yaml" ]; then
  compose run --rm -T --no-deps --user 0:0 -v "$proxy_file:/run/pilot-socks5:ro" --entrypoint /bin/sh twitter -ec '
    umask 077
    if [ -e /data/config.yaml ] || [ -e /data/registration.yaml ]; then
      echo "Incomplete bridge configuration. Inspect the existing files before retrying." >&2
      exit 1
    fi
    PILOT_PROXY=$(cat /run/pilot-socks5)
    case "$PILOT_PROXY" in
      socks5://?*) ;;
      *) echo "A dedicated SOCKS5 URL is required for this bridge." >&2; exit 1 ;;
    esac
    export PILOT_PROXY
    staging=$(mktemp -d /data/.bootstrap.XXXXXXXX)
    trap '"'"'rm -f "$staging/config.yaml" "$staging/registration.yaml"; rmdir "$staging"'"'"' EXIT
    mautrix-twitter -e -c "$staging/config.yaml"
    yq -i '"'"'
      .network.proxy = strenv(PILOT_PROXY) |
      .network.get_proxy_url = null |
      .network.log_redacted_login_responses = false |
      .homeserver.address = "http://synapse:8008" |
      .homeserver.domain = "matrix.nodex.internal" |
      .appservice.address = "http://twitter:29327" |
      .appservice.public_address = "" |
      .appservice.hostname = "0.0.0.0" |
      .appservice.port = 29327 |
      .bridge.permissions = {"*": "block", "@pilot222:matrix.nodex.internal": "user"} |
      .bridge.split_portals = true |
      .matrix.federate_rooms = false |
      .matrix.message_status_events = true |
      .encryption.allow = false |
      .encryption.default = false |
      .encryption.require = false |
      .double_puppet.servers = {} |
      .double_puppet.allow_discovery = false |
      .double_puppet.secrets = {} |
      .provisioning.shared_secret = "generate" |
      .provisioning.allow_matrix_auth = true |
      .provisioning.debug_endpoints = false |
      .provisioning.enable_session_transfers = false |
      .public_media.enabled = false |
      .database.type = "sqlite3-fk-wal" |
      .database.uri = "file:/data/twitter.sqlite?_txlock=immediate" |
      .logging.min_level = "warn"
    '"'"' "$staging/config.yaml"
    unset PILOT_PROXY
    mautrix-twitter -g -c "$staging/config.yaml" -r "$staging/registration.yaml"
    chown 1337:1337 "$staging/config.yaml"
    chmod 600 "$staging/config.yaml" "$staging/registration.yaml"
    mv "$staging/config.yaml" "$staging/registration.yaml" /data/
  '
fi

install -o 991 -g 991 -m 0600 "$NODEX_DM_DATA_DIR/twitter/registration.yaml" \
  "$NODEX_DM_DATA_DIR/synapse/appservices/twitter.yaml"
if [ ! -f "$NODEX_DM_DATA_DIR/synapse/homeserver.yaml" ]; then
  compose run --rm -T --no-deps -e SYNAPSE_SERVER_NAME=matrix.nodex.internal -e SYNAPSE_REPORT_STATS=no \
    synapse generate
fi
compose run --rm -T --no-deps --user 0:0 -v "$database_secret:/run/postgres-password:ro" \
  --entrypoint python synapse - <<'PY'
from os import chown
from pathlib import Path
from secrets import token_hex

import yaml

path = Path("/data/homeserver.yaml")
config = yaml.safe_load(path.read_text())
if config["server_name"] != "matrix.nodex.internal":
    raise SystemExit("Refusing to change the existing Matrix homeserver identity")
config.setdefault("registration_shared_secret", token_hex(32))
config.setdefault("macaroon_secret_key", token_hex(32))
config.setdefault("form_secret", token_hex(32))
config.update(
    listeners=[dict(port=8008, tls=False, type="http", x_forwarded=False,
                    bind_addresses=["0.0.0.0"], resources=[dict(names=["client"], compress=False)])],
    database=dict(name="psycopg2", args=dict(
        user="synapse", password=Path("/run/postgres-password").read_text().strip(),
        database="synapse", host="postgres", cp_min=1, cp_max=5,
    )),
    app_service_config_files=["/data/appservices/twitter.yaml"],
    enable_registration=False,
    allow_guest_access=False,
    allow_public_rooms_without_auth=False,
    allow_public_rooms_over_federation=False,
    federation_domain_whitelist=[],
    url_preview_enabled=False,
    report_stats=False,
)
staged = path.with_suffix(".tmp")
staged.write_text(yaml.safe_dump(config, sort_keys=False))
staged.chmod(0o600)
chown(staged, 991, 991)
staged.replace(path)
for key in Path("/data").glob("*.signing.key"):
    key.chmod(0o600)
PY
printf '%s\n' 'Private DM configuration prepared. Follow deploy/dm/README.md to start services.'
