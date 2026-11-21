#!/usr/bin/env python3
import argparse
import getpass
import http.client
import json
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from urllib.parse import urlencode
from uuid import UUID


MATRIX_PORT = 18008
BRIDGE_PORT = 19327
MATRIX_USER = "@pilot222:matrix.nodex.internal"
BRIDGE_BOT = "@twitterbot:matrix.nodex.internal"
PROVISION = "/_matrix/provision"


def request(port, method, path, token=None, body=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        headers = {}
        if token:
            headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, None if body is None else json.dumps(body), headers)
        response = connection.getresponse()
        if not 200 <= response.status < 300:
            raise SystemExit(f"Private service on port {port} returned HTTP {response.status}.")
        data = response.read(256 * 1024 + 1)
        if len(data) > 256 * 1024:
            raise SystemExit("Unexpected response size from the private service.")
        return json.loads(data)
    except (OSError, http.client.HTTPException, ValueError):
        raise SystemExit(f"Could not read the private service on port {port}.") from None
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description="Bind one Node X account to the private pilot Matrix login.")
    parser.add_argument("account_id", type=UUID)
    parser.add_argument("x_username")
    parser.add_argument("--workspace", type=UUID, help="Customer license ID, if this is a customer workspace")
    parser.add_argument("--data-dir", type=Path, default=Path("/var/lib/nodex"))
    parser.add_argument("--await-authorization", action="store_true", help="Wait for this X username to authorize in mautrix")
    args = parser.parse_args()
    username = args.x_username.lstrip("@").lower()
    if not re.fullmatch(r"[a-z0-9_]{1,15}", username):
        parser.error("Supply the expected X @username.")
    if os.getuid() == 0:
        parser.error("Run as the Node X service user so the config has the correct owner.")

    directory = args.data_dir
    if args.workspace:
        directory = directory / "customers" / str(args.workspace)
    if not (directory / "nodex.sqlite").is_file():
        parser.error("Workspace database not found.")
    directory = directory / "dm-matrix"
    directory.mkdir(mode=0o700, exist_ok=True)
    filename = str(args.account_id) + (".hosted.json" if args.await_authorization else ".json")
    destination = directory / filename
    if destination.exists():
        parser.error("This Node X account already has a managed bridge file.")

    password = getpass.getpass(f"Matrix password for {MATRIX_USER}: ")
    session = request(MATRIX_PORT, "POST", "/_matrix/client/v3/login", body={
        "type": "m.login.password",
        "identifier": {"type": "m.id.user", "user": MATRIX_USER},
        "password": password,
        "initial_device_display_name": "Node X DM pilot",
    })
    token = session["access_token"]
    saved = False
    try:
        if session["user_id"] != MATRIX_USER:
            raise SystemExit("Synapse returned an unexpected Matrix user.")
        query = urlencode({"user_id": MATRIX_USER})
        bridge = request(BRIDGE_PORT, "GET", f"{PROVISION}/v3/whoami?{query}", token)
        if bridge.get("bridge_bot") != BRIDGE_BOT or bridge.get("network", {}).get("network_id") != "twitter":
            raise SystemExit("Unexpected mautrix bridge identity.")
        config = {
            "matrixUrl": f"http://127.0.0.1:{MATRIX_PORT}",
            "matrixAccessToken": token,
            "bridgeProvisioningUrl": f"http://127.0.0.1:{BRIDGE_PORT}{PROVISION}",
            "bridgeBotId": BRIDGE_BOT,
        }
        if args.await_authorization:
            config["expectedUsername"] = username
        else:
            matches = [
                login for login in bridge.get("logins", [])
                if (login.get("profile", {}).get("username") or login.get("name", "")).lstrip("@").lower() == username
            ]
            if len(matches) != 1 or matches[0].get("state", {}).get("state_event") != "CONNECTED":
                raise SystemExit("The expected X username must have exactly one connected mautrix login.")
            x_user_id = matches[0].get("id")
            if not isinstance(x_user_id, str) or not re.fullmatch(r"[1-9][0-9]{0,29}", x_user_id):
                raise SystemExit("The bridge did not return a valid X account ID.")
            config["xUserId"] = x_user_id
        with NamedTemporaryFile(mode="w", dir=directory) as staging:
            json.dump(config, staging)
            staging.flush()
            os.fsync(staging.fileno())
            try:
                os.link(staging.name, destination)
            except FileExistsError:
                raise SystemExit("A managed bridge file already exists for this account.") from None
        saved = True
    finally:
        if not saved:
            try:
                request(MATRIX_PORT, "POST", "/_matrix/client/v3/logout", token, {})
            except SystemExit:
                pass
    print("Saved the private Matrix connection for this Node X account.")


if __name__ == "__main__":
    main()
