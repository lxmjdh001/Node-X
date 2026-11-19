import { isIP } from 'node:net';
import { parse } from 'csv-parse/sync';
import { InputError } from './errors.js';

export type ImportFormat = 'nodex' | 'camoufox';

export type ImportCandidate = {
  row: number;
  username: string;
  accountLabel: string;
  notes: string;
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
  profileLabel: string;
  locale: string;
  timezone: string;
  width: number;
  height: number;
};

type ImportResult = { row: number; candidate: ImportCandidate } | { row: number; error: string };
type ReadCell = (header: string) => string;

const MAX_BYTES = 192 * 1024;
const MAX_ROWS = 100;
const NODEX_COLUMNS = new Set([
  'username', 'account_label', 'notes', 'proxy_host', 'proxy_port',
  'proxy_username', 'proxy_password', 'profile_label', 'locale', 'timezone', 'width', 'height',
]);
const CAMOUFOX_COLUMNS = new Set([
  'X username', 'Profile name', 'Proxy type', 'Proxy server', 'Proxy username',
  'Proxy password', 'Window width', 'Window height', 'Browser languages', 'Timezone', 'Locale', 'Notes',
]);

// This error is deliberately separate from parser/library exceptions. Only these
// fixed messages may reach a per-row error; neither raw cells nor parser errors do.
class RowError extends Error {}

function username(value: string): string {
  const result = value.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(result)) {
    throw new RowError('请填写有效的 X 用户名：1–15 位英文字母、数字或下划线。');
  }
  return result;
}

function label(value: string, fallback: string): string {
  const result = value.trim() || fallback;
  if (!result || result.length > 80) throw new RowError('账号名称和环境名称必须为 1–80 个字符。');
  return result;
}

function integer(value: string, fallback: number | undefined, min: number, max: number, message: string): number {
  const text = value.trim();
  if (!text && fallback !== undefined) return fallback;
  if (!/^\d+$/.test(text)) throw new RowError(message);
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new RowError(message);
  return result;
}

function proxyHost(value: string): string {
  const result = value.trim().replace(/^\[(.+)\]$/, '$1');
  if (!result || result.length > 253 || (isIP(result) === 0 &&
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(result))) {
    throw new RowError('代理地址必须为有效的主机名或 IP，不包含协议和认证信息。');
  }
  return result;
}

function camoufoxProxy(value: string): { host: string; port: number } {
  const text = value.trim();
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(text);
  const simple = /^([^:\s]+):(\d+)$/.exec(text);
  const match = ipv6 || simple;
  if (!match || (ipv6 && isIP(match[1]) !== 6)) {
    throw new RowError('Proxy server 必须为 host:port；IPv6 请使用 [IPv6]:port。');
  }
  return {
    host: proxyHost(match[1]),
    port: integer(match[2], undefined, 1, 65535, '代理端口必须为 1–65535 的整数。'),
  };
}

function locale(value: string): string {
  try {
    const result = Intl.getCanonicalLocales((value.trim() || 'zh-CN').replaceAll('_', '-'));
    if (result.length !== 1 || result[0].length > 30) throw new Error();
    return result[0];
  } catch {
    throw new RowError('语言代码无效，请使用 zh-CN、en-US 等语言代码。');
  }
}

function candidateFor(format: ImportFormat, read: ReadCell, row: number): ImportCandidate {
  const camoufox = format === 'camoufox';
  const handle = username(read(camoufox ? 'X username' : 'username'));
  if (camoufox && read('Proxy type').trim().toLowerCase() !== 'socks5') {
    throw new RowError('仅支持导入使用 SOCKS5 代理的环境。');
  }
  const proxy = camoufox ? camoufoxProxy(read('Proxy server')) : {
    host: proxyHost(read('proxy_host')),
    port: integer(read('proxy_port'), undefined, 1, 65535, '代理端口必须为 1–65535 的整数。'),
  };
  const proxyUsername = read(camoufox ? 'Proxy username' : 'proxy_username').trim();
  // Passwords are intentionally not trimmed: spaces can be part of a credential.
  const proxyPassword = read(camoufox ? 'Proxy password' : 'proxy_password');
  if (Boolean(proxyUsername) !== Boolean(proxyPassword)) {
    throw new RowError('代理用户名和密码必须同时填写，或同时留空。');
  }
  if (Buffer.byteLength(proxyUsername, 'utf8') > 255 || Buffer.byteLength(proxyPassword, 'utf8') > 255) {
    throw new RowError('代理用户名和密码分别不能超过 255 字节。');
  }
  const profileName = camoufox ? read('Profile name') : read('profile_label');
  if (camoufox && !profileName.trim()) throw new RowError('Profile name 不能为空。');
  const notes = read(camoufox ? 'Notes' : 'notes').trim();
  if (notes.length > 2000) throw new RowError('备注最多 2000 个字符。');
  const timezone = read(camoufox ? 'Timezone' : 'timezone').trim() || 'Asia/Shanghai';
  try {
    if (timezone.length > 80) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new RowError('时区无效，请使用 Asia/Shanghai 等有效时区。');
  }
  const language = camoufox
    ? read('Locale').trim() || read('Browser languages').split(',')[0]?.trim() || ''
    : read('locale');
  return {
    row,
    username: handle,
    accountLabel: label(camoufox ? profileName : read('account_label'), handle),
    notes,
    proxyHost: proxy.host,
    proxyPort: proxy.port,
    proxyUsername,
    proxyPassword,
    profileLabel: label(profileName, handle),
    locale: locale(language),
    timezone,
    width: integer(read(camoufox ? 'Window width' : 'width'), 1440, 320, 3840, '窗口宽度必须为 320–3840 的整数。'),
    height: integer(read(camoufox ? 'Window height' : 'height'), 900, 320, 2160, '窗口高度必须为 320–2160 的整数。'),
  };
}

/**
 * row is a one-based CSV record number, with the header as record 1. Empty
 * records are ignored; a quoted multiline cell remains part of one record.
 * Camoufox metadata is mapped from its Excel export saved as UTF-8 CSV:
 * https://github.com/polyackiy/camoufox-profile-manager/blob/main/docs/excel.md
 */
export function parseImportCsv(format: ImportFormat, csv: string): ImportResult[] {
  if (format !== 'nodex' && format !== 'camoufox') throw new InputError('请选择支持的 CSV 导入格式。');
  if (typeof csv !== 'string' || !csv.trim()) throw new InputError('请选择含有表头和数据的 UTF-8 CSV 文件。');
  if (Buffer.byteLength(csv, 'utf8') > MAX_BYTES) throw new InputError('CSV 文件不能超过 192 KiB。', 413);
  if (csv.includes('\0')) throw new InputError('CSV 编码无效，请保存为 UTF-8 CSV 后重试。');

  let records: string[][];
  try {
    records = (parse(csv, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: MAX_BYTES,
    }) as string[][]).filter((record) => record.some((cell) => cell.trim() !== ''));
  } catch {
    // csv-parse exceptions can include the complete offending record, including
    // passwords. Never propagate their messages, causes, or diagnostic objects.
    throw new InputError('CSV 格式无效，请检查分隔符、引号和 UTF-8 编码。');
  }
  if (records.length < 2) throw new InputError('CSV 必须包含表头和至少一条数据。');
  if (records.length - 1 > MAX_ROWS) throw new InputError('一次最多导入 100 条数据，请拆分 CSV 文件。');
  const headers = records[0].map((header) => header.trim());
  const mappedHeaders = format === 'nodex' ? headers : headers.filter((header) => CAMOUFOX_COLUMNS.has(header));
  if ((format === 'nodex' && headers.some((header) => !header)) || new Set(mappedHeaders).size !== mappedHeaders.length) {
    throw new InputError('CSV 表头不能重复或为空。');
  }
  if (format === 'nodex' && headers.some((header) => !NODEX_COLUMNS.has(header))) {
    throw new InputError('Node X CSV 含有模板以外的列，请移除后重试。');
  }
  const required = format === 'nodex'
    ? ['username', 'proxy_host', 'proxy_port']
    : ['X username', 'Profile name', 'Proxy type', 'Proxy server'];
  if (required.some((header) => !headers.includes(header))) {
    throw new InputError(format === 'nodex'
      ? 'Node X CSV 缺少 username、proxy_host 或 proxy_port 表头。'
      : 'Camoufox CSV 需要 X username、Profile name、Proxy type 和 Proxy server 表头。');
  }
  const indexes = new Map(headers.map((header, index) => [header, index]));
  return records.slice(1).map((record, index): ImportResult => {
    const row = index + 2;
    if (record.length !== headers.length) return { row, error: '数据列数与表头不一致，请检查逗号和引号。' };
    const read: ReadCell = (header) => {
      const column = indexes.get(header);
      return column === undefined ? '' : record[column];
    };
    try {
      return { row, candidate: candidateFor(format, read, row) };
    } catch (error) {
      return { row, error: error instanceof RowError ? error.message : '这一条数据无法读取，请检查格式。' };
    }
  });
}
