type ProxyAddress = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};

const invalidAddress =
  "请填写有效的 SOCKS5 地址。支持主机:端口、主机:端口:用户名:密码或 SOCKS5 链接。";
const hostPattern =
  /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;

function ipv6Host(input: string): string | undefined {
  if (!input.includes(":") || !/^[\da-f:.]+$/i.test(input)) return undefined;
  try {
    return new URL(`http://[${input}]`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

function connection(
  rawHost: string,
  port: string,
  username = "",
  password = "",
): ProxyAddress {
  const host = rawHost.startsWith("[")
    ? ipv6Host(rawHost.slice(1, -1))
    : rawHost;
  const number = Number(port);
  const encoder = new TextEncoder();
  if (
    !host ||
    host.length > 253 ||
    (!hostPattern.test(host) && !ipv6Host(host)) ||
    !/^\d+$/.test(port) ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > 65535 ||
    Boolean(username.trim()) !== Boolean(password) ||
    encoder.encode(username.trim()).length > 255 ||
    encoder.encode(password).length > 255
  ) {
    throw new Error(invalidAddress);
  }
  return username
    ? { host, port: number, username: username.trim(), password }
    : { host, port: number };
}

/** Returns null for hosts entered separately from the port. */
export function parseProxyAddress(value: string): ProxyAddress | null {
  const input = value.trim();
  if (
    !input ||
    hostPattern.test(input) ||
    ipv6Host(input.replace(/^\[(.*)\]$/, "$1"))
  )
    return null;

  const parts =
    /^(\[[\da-f:.]+\]|[^\s:/@?#]+):(\d+)(?::([^:\r\n]+):([^\r\n]+))?$/i.exec(
      input,
    );
  if (parts) return connection(parts[1], parts[2], parts[3], parts[4]);

  if (
    /^socks5h?:\/\//i.test(input) ||
    (!input.includes("://") && input.includes("@"))
  ) {
    try {
      const url = new URL(input.includes("://") ? input : `socks5://${input}`);
      if (
        (url.pathname && url.pathname !== "/") ||
        url.search ||
        url.hash ||
        /\s/.test(input)
      ) {
        throw new Error(invalidAddress);
      }
      return connection(
        url.hostname,
        url.port,
        decodeURIComponent(url.username),
        decodeURIComponent(url.password),
      );
    } catch {
      throw new Error(invalidAddress);
    }
  }
  throw new Error(invalidAddress);
}
