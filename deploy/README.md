# Debian 12 deployment

Public workbench: `https://xai.chuhai7.com`. Nginx forwards the workbench to `127.0.0.1:4173` and the HTTPS `/operator` route to `127.0.0.1:4174`. Use Node 24 at `/usr/bin/node` and the existing Nginx installation. These files are templates; they do not change a server by themselves.

## Service and releases

Create the dedicated `nodex` system user/group if absent. Keep releases under `/opt/nodex/releases/`, with `/opt/nodex/current` pointing to the active release. The service needs read access to source, `dist/` and `node_modules/`; only `/var/lib/nodex` is writable. Keep `/etc/nodex/runtime.env` root-owned, mode `0600`, outside Git and release archives.

The unit supplies these non-secret defaults; values in `runtime.env` take precedence:

```dotenv
NODE_ENV=production
PORT=4173
NODEX_OPERATOR_PORT=4174
NODEX_OPERATOR_ACCESS_PORT=7414
NODEX_PUBLIC_ORIGIN=https://xai.chuhai7.com
NODEX_OPERATOR_PUBLIC_ORIGIN=https://xai.chuhai7.com
NODEX_DATA_DIR=/var/lib/nodex
PLAYWRIGHT_BROWSERS_PATH=/var/lib/nodex/ms-playwright
NODEX_X_PUBLISH_MODE=browser
```

Add the application's required secrets to that file on the server. Build each new release before switching traffic:

```sh
npm ci
npm run build
npm run launcher:build
npm prune --omit=dev
```

Set `NODEX_CLIENT_LAUNCHER=1` to enable the macOS launcher on the public workbench. Publish `dist/node-x-mac.zip` with the release. Customers install the launcher and its Chrome extension, then click “打开 X” to open their own Chrome with the assigned SOCKS5. X cookies stay in the customer's local Chrome profile.

For a deployment that uses the legacy online browser, install Chromium system libraries and fonts, then install the Chromium build matching the release's Playwright package into `PLAYWRIGHT_BROWSERS_PATH` as the `nodex` user. The online browser runs headless with the Chromium sandbox.

```sh
node node_modules/playwright/cli.js install-deps chromium
runuser -u nodex -- env PLAYWRIGHT_BROWSERS_PATH=/var/lib/nodex/ms-playwright \
  node node_modules/playwright/cli.js install chromium --no-shell
```

Administrators can configure shared credentials and global defaults in the operator console under 全局模型管理. Each workspace can inherit those defaults or choose a model under 模型列表. The owner workspace can use `AI_API_KEY`, `AI_MODEL`, and optionally `AI_BASE_URL` in `runtime.env` as a writing fallback. With `NODEX_X_PUBLISH_MODE=browser`, customers sign in and post manually in X. For an alternate API deployment, set `NODEX_X_PUBLISH_MODE=api`, configure `X_CLIENT_ID`, the app's `X_CLIENT_SECRET` if applicable, and `X_REDIRECT_URI=https://xai.chuhai7.com/api/x/callback`. Register that exact redirect URI and enable write access in the X Developer Console. Each workspace authorizes its own X accounts. The authenticated operator console also supports configuring the site-wide publishing mode and OAuth credentials under 发布流程管理. Saved settings take precedence over the environment credentials. MCP mode pauses the official API queue until an operator switches back.

For the optional customer Camoufox integration, create a separate trusted manager instance and data directory for each workspace, and set `NODEX_CUSTOMER_CAMOUFOX` to a JSON object keyed by license ID. Each value contains that instance's loopback `port` and `apiKey`. Keep manager ports unique, including the owner instance. The standard online Chromium runs without Camoufox.

Install `nodex.service` at `/etc/systemd/system/nodex.service`, run `systemctl daemon-reload`, and enable it with `systemctl enable --now nodex`. For later releases, first verify the new build and then replace the symlink atomically:

```sh
release_dir=/opt/nodex/releases/RELEASE_ID
test -f "$release_dir/dist/index.html"
ln -sfn "$release_dir" /opt/nodex/current.next
mv -Tf /opt/nodex/current.next /opt/nodex/current
systemctl restart nodex
```

Replace `RELEASE_ID` with the prepared release. Preserve `/var/lib/nodex` and `runtime.env` across deployments. Back up the SQLite database together with its encryption key and other data; stop the service before copying the entire data directory, or use a consistent SQLite backup. Retain the previous release for rollback; restore a matching data backup if a release changes the database schema.

## Nginx and certificate

The domain's A record points to the VPS through Cloudflare. Review `nginx -T` for duplicate `server_name xai.chuhai7.com` entries, then install this template as its own site. Preserve other virtual hosts and services.

For first issuance, create `/var/www/certbot` readable by Nginx and enable only the template's port-80 server block. Verify that a test file under `.well-known/acme-challenge/` is publicly readable through the domain. Cloudflare must allow that HTTP challenge path without a login, challenge page or cache rule. If first issuance cannot reach the origin through the proxy, temporarily use DNS-only for this record while obtaining the certificate.

Use the ordinary Certbot webroot flow; this is a domain certificate:

```sh
certbot certonly --webroot --webroot-path /var/www/certbot \
  --domain xai.chuhai7.com --cert-name xai.chuhai7.com
```

Use the existing ACME account or supply the actual contact email when prompted. Once the certificate exists, enable the complete template, run `nginx -t`, then `systemctl reload nginx`. Keep the challenge location on port 80 for renewals. Set Cloudflare SSL/TLS to **Full (strict)** once the origin certificate is active. See [Certbot webroot documentation](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot) and [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/).

Install a root-owned executable deploy hook at `/etc/letsencrypt/renewal-hooks/deploy/50-nodex-nginx` so Nginx loads renewed certificates:

```sh
#!/bin/sh
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
```

Check the renewal timer provided by the Certbot installation (`certbot.timer` for the Debian package); enable that existing timer and avoid adding a duplicate cron job. Verify renewal with:

```sh
certbot renew --cert-name xai.chuhai7.com --dry-run
systemctl list-timers --all certbot.timer
```

## Operator access and checks

Open `https://xai.chuhai7.com/operator` in Mac Chrome. Browser headers are an entry filter. Sign in with the registered browser key and administrator password to open an eight-hour operator session. Sign out from the operator page to end the session. Enroll on the HTTPS origin because IndexedDB storage is origin-specific.

After each release, check `systemctl is-active nodex`, confirm both application ports bind only to `127.0.0.1`, and verify:

```sh
curl --fail --silent --show-error https://xai.chuhai7.com/healthz
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://xai.chuhai7.com/operator
```

Expect `{"ok":true}` and `403` for curl without Mac Chrome headers. Check the operator page on HTTPS in Mac Chrome. Any planned Mailu shutdown happens only after the new workbench passes health checks; this template does not stop containers or alter `aimv`, `ipip2`, or other sites.
