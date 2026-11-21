# Private X messaging pilot

This stack serves one X account, labeled **222** in Node X. Synapse and mautrix share a private Docker network and publish host ports on 127.0.0.1. PostgreSQL uses a separate internal network and has no host port. Public Matrix registration, room federation and bridge media exposure are disabled. Runtime data lives outside the repository at /var/lib/nodex-dm.

- Synapse v1.165.0 and PostgreSQL 16 Bookworm are pinned by registry digest. [Synapse Docker instructions](https://github.com/element-hq/synapse/blob/v1.165.0/docker/README.md)
- The amd64 bridge image is pinned to mautrix-twitter commit 2efd3a5da34d459f2a75b5140f96b99f41582766 and its registry digest. It includes static proxy enforcement for X HTTP and X Chat WebSockets. The startup script refuses to launch without the dedicated static SOCKS5 URL. [Pinned upstream revision](https://github.com/mautrix/twitter/commit/2efd3a5da34d459f2a75b5140f96b99f41582766) · [Proxy implementation](https://github.com/mautrix/twitter/blob/2efd3a5da34d459f2a75b5140f96b99f41582766/pkg/connector/proxy.go)
- Portal rooms are private to the pilot Matrix user. Matrix end-to-bridge encryption is disabled so the Node X connector can read those rooms. Keep the private Matrix data, database and backups protected on the host. [Bridge configuration](https://docs.mau.fi/configs/mautrix-twitter/latest)

## Prepare the server

1. On the Debian amd64 Docker host, create a root-owned mode 600 file at /etc/nodex-dm/pilot-socks5.url with one SOCKS5 URL. Use the same upstream host, port and authentication configured for the account's X browser window. URI-encode the username and password if they contain URL delimiters.
2. Run bootstrap as root. It generates the database password and the Matrix and bridge service secrets locally. Keep this Compose project name for future use.

       sh deploy/dm/bootstrap.sh /etc/nodex-dm/pilot-socks5.url
       docker-compose -p nodex-dm-pilot -f deploy/dm/docker-compose.yml up -d
       docker-compose -p nodex-dm-pilot -f deploy/dm/docker-compose.yml ps
       curl -fsS http://127.0.0.1:18008/_matrix/client/versions >/dev/null
       curl -fsS http://127.0.0.1:19327/_matrix/mau/ready >/dev/null

   For Compose V2, use the same commands with docker compose. Keep ports 18008 and 19327 private. On Docker versions before 28, the host firewall must also prevent access to these endpoints from other machines on the same L2 network. [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)
3. Create the dedicated non-admin Matrix user. Enter a unique password at the prompt.

       docker-compose -p nodex-dm-pilot -f deploy/dm/docker-compose.yml exec synapse \
         register_new_matrix_user -c /data/homeserver.yaml -u pilot222 --no-admin http://127.0.0.1:8008

   The shared registration secret stays in Synapse's private configuration. The bridge accepts the dedicated user's Matrix token for provisioning. [Synapse registration](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#registration_shared_secret) · [Mautrix appservice registration](https://docs.mau.fi/bridges/general/registering-appservices.html)

## Sign in and connect the inbox

1. On the VPS, prepare the Node X account as the Node X service user. Supply the Node X account UUID and expected X username. For a customer workspace, add --workspace LICENSE_UUID. The script verifies the dedicated Matrix login and bridge identity and writes a mode 600 file.

       runuser -u nodex -- python3 deploy/dm/configure-nodex.py ACCOUNT_UUID X_USERNAME --await-authorization

2. Open an SSH tunnel from the operator's computer using an authorized SSH account.

       ssh -NT -o ExitOnForwardFailure=yes \
         -L 127.0.0.1:18008:127.0.0.1:18008 \
         -L 127.0.0.1:19327:127.0.0.1:19327 \
         USER@VPS

3. In mautrix-manager, sign in to the Matrix homeserver at http://127.0.0.1:18008 as pilot222. Add a same-homeserver bridge with base address http://127.0.0.1:19327. Use the bridge's **Password** flow in mautrix-manager and follow any X sign-in and X Chat verification prompts. Confirm that the bridge shows the expected X username connected. [mautrix-manager](https://github.com/mautrix/manager) · [Bridge login flows at the pinned revision](https://github.com/mautrix/twitter/blob/2efd3a5da34d459f2a75b5140f96b99f41582766/pkg/connector/login.go)
4. In **窗口管理**, click **连接私信** for account 222. Node X verifies the expected X username against the connected bridge and pins its numeric account ID. Open **私信工作室** and verify receipt of a message addressed to the pilot account. Leave the Docker project running for automatic synchronization.

For an account already authorized in mautrix, omit --await-authorization to verify and pin its connected numeric account ID during configuration.

Each additional account needs its own bridge instance and proxy assignment. Preserve the data directories and their configuration secrets together in protected backups. To change the pilot's SOCKS5, update /var/lib/nodex-dm/twitter/config.yaml and restart its twitter service.
