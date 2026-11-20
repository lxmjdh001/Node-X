import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import {
  Check,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Copy,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Send,
} from "lucide-react";
import { ModelPage } from "./models-page";
import { PublishingSettingsPanel } from "./publishing-settings";

type OperatorState = {
  enrolled: boolean;
  passwordConfigured: boolean;
  sessionExpiresAt: number | null;
};
type BrowserKey = { privateKey: CryptoKey; publicKey: JsonWebKey };
type LicenseScope = "customer" | "owner";
type LicenseUnit = "days" | "months";
type LicenseRecord = {
  id: string;
  suffix: string;
  label: string;
  scope: LicenseScope;
  unit: LicenseUnit;
  quantity: number;
  createdAt: number;
  activatedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  status: "pending" | "active" | "expired" | "revoked";
};
type LoginCode = { code: string; license: LicenseRecord };
type LicensePage = {
  rows: LicenseRecord[];
  page: number;
  pages: number;
  total: number;
};

const licenseDate = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});
const durationLabel = (license: Pick<LicenseRecord, "quantity" | "unit">) =>
  `${license.quantity} ${license.unit === "days" ? "天" : "个月"}`;
const statusLabel = {
  pending: "未激活",
  active: "使用中",
  expired: "已到期",
  revoked: "已停用",
};

class OperatorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function operatorRequest<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(`/operator/api/${path}`, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new OperatorRequestError(
      result.error || `请求失败（${response.status}）`,
      response.status,
    );
  return result;
}

function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("node-x-operator", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("keys");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error("无法打开浏览器密钥存储，请检查 Chrome 的网站数据权限。"),
      );
    request.onblocked = () =>
      reject(
        new Error("浏览器密钥存储被其他页面占用，请关闭其他生成器页面后刷新。"),
      );
  });
}

async function readBrowserKey(): Promise<BrowserKey | null> {
  const database = await openKeyDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("keys", "readonly");
      const request = transaction.objectStore("keys").get("primary");
      request.onsuccess = () => {
        const value = request.result as BrowserKey | undefined;
        if (!value) return resolve(null);
        if (
          !(value.privateKey instanceof CryptoKey) ||
          value.privateKey.extractable ||
          value.privateKey.type !== "private" ||
          value.privateKey.algorithm.name !== "ECDSA" ||
          (value.privateKey.algorithm as EcKeyAlgorithm).namedCurve !==
            "P-256" ||
          !value.privateKey.usages.includes("sign") ||
          value.publicKey?.kty !== "EC" ||
          value.publicKey.crv !== "P-256" ||
          !value.publicKey.x ||
          !value.publicKey.y
        ) {
          reject(
            new Error(
              "已保存的浏览器密钥不可用，请使用原来登记的 Chrome 个人资料。",
            ),
          );
        } else resolve(value);
      };
      request.onerror = () =>
        reject(new Error("无法读取浏览器密钥，请检查 Chrome 的网站数据权限。"));
      transaction.onabort = () =>
        reject(new Error("浏览器密钥读取已中止，请刷新重试。"));
    });
  } finally {
    database.close();
  }
}

async function createBrowserKey(): Promise<BrowserKey> {
  const existing = await readBrowserKey();
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const key = {
    privateKey: pair.privateKey,
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
  const database = await openKeyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keys", "readwrite");
      transaction.objectStore("keys").put(key, "primary");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          new Error(
            "无法保存浏览器密钥，未完成登记。请检查 Chrome 的网站数据权限。",
          ),
        );
      transaction.onabort = () =>
        reject(new Error("浏览器密钥保存已中止，未完成登记。请重试。"));
    });
  } finally {
    database.close();
  }
  return key;
}

async function signChallenge(key: BrowserKey, challenge: string) {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(challenge),
    ),
  );
  if (signature.byteLength !== 64)
    throw new Error(
      "当前浏览器的签名格式不受支持，请使用 Mac 上的常用 Chrome。",
    );
  return btoa(
    Array.from(signature, (byte) => String.fromCharCode(byte)).join(""),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function OperatorButton({
  children,
  className = "",
  busy,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      className={`button ${className}`}
      {...props}
      disabled={props.disabled || busy}
    >
      {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

function RenewLicenseDialog({
  license,
  onClose,
  onRenew,
  busy,
}: {
  license: LicenseRecord;
  onClose: () => void;
  onRenew: (unit: LicenseUnit, quantity: number) => Promise<void>;
  busy: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [unit, setUnit] = useState<LicenseUnit>(license.unit);
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    const returnFocus = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      element?.close();
      returnFocus?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="dialog operator-renew-dialog"
      aria-labelledby="license-renew-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-head">
        <div>
          <h2 id="license-renew-title">续期登录码</h2>
          <p>
            NX-••••{license.suffix}
            {license.label && ` · ${license.label}`}
          </p>
        </div>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setError("");
          try {
            await onRenew(unit, Number(quantity));
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <div className="dialog-body">
          <p className="operator-form-description">
            {license.expiresAt !== null && license.expiresAt > Date.now()
              ? `从原到期时间 ${licenseDate.format(license.expiresAt)}（北京时间）起顺延。`
              : "已到期，从确认续期时开始计算。"}
          </p>
          <div className="operator-license-period">
            <label className="field">
              <span>续期时长</span>
              <input
                type="number"
                min={1}
                max={unit === "days" ? 366 : 24}
                step={1}
                required
                autoFocus
                value={quantity}
                disabled={busy}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <label className="field">
              <span id="renew-unit-label">单位</span>
              <select
                aria-labelledby="renew-unit-label"
                value={unit}
                disabled={busy}
                onChange={(event) => setUnit(event.target.value as LicenseUnit)}
              >
                <option value="days">天</option>
                <option value="months">自然月</option>
              </select>
            </label>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <OperatorButton
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </OperatorButton>
          <OperatorButton type="submit" className="primary" busy={busy}>
            确认续期
          </OperatorButton>
        </div>
      </form>
    </dialog>
  );
}

export default function OperatorApp() {
  const [state, setState] = useState<OperatorState | null>(null);
  const [section, setSection] = useState<"codes" | "models" | "publishing">("codes");
  const [key, setKey] = useState<BrowserKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<
    | ""
    | "enroll"
    | "login"
    | "logout"
    | "generate"
    | "list"
    | "reveal"
    | "revoke"
    | "renew"
  >("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [unit, setUnit] = useState<LicenseUnit>("months");
  const [quantity, setQuantity] = useState("1");
  const [scope, setScope] = useState<LicenseScope>("customer");
  const [label, setLabel] = useState("");
  const [licenses, setLicenses] = useState<LicensePage | null>(null);
  const [code, setCode] = useState<LoginCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [listNotice, setListNotice] = useState("");
  const [renewal, setRenewal] = useState<{
    entry: LicenseRecord;
    requestId: string;
  } | null>(null);
  const [now, setNow] = useState(Date.now());
  const errorRef = useRef<HTMLParagraphElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      if (!window.isSecureContext || !crypto.subtle || !window.indexedDB)
        throw new Error(
          "浏览器密钥需要安全页面，请在 Mac Chrome 中通过 HTTPS 打开生成器。",
        );
      const [next, savedKey] = await Promise.all([
        operatorRequest<OperatorState>("state"),
        readBrowserKey(),
      ]);
      if (mounted.current) {
        setState(next);
        setKey(savedKey);
      }
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    document.title = "Node X · 登录码生成器";
    void load();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!code && !licenses) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code, licenses]);
  const fail = (err: unknown) => {
    setError((err as Error).message);
    requestAnimationFrame(() => errorRef.current?.focus());
  };
  const canSignIn =
    !!state?.enrolled && state.passwordConfigured && !!key && !loading;
  const sessionExpiresAt = state?.sessionExpiresAt ?? null;
  const authenticated = !!key && sessionExpiresAt !== null;
  const showModels = authenticated && section === "models";
  const showPublishing = authenticated && section === "publishing";
  const showCodes = authenticated && section === "codes";

  function endSession() {
    setState((current) => current && { ...current, sessionExpiresAt: null });
    setPassword("");
    setSection("codes");
    setLicenses(null);
    setCode(null);
    setRenewal(null);
    setListNotice("");
    setNotice("");
  }

  async function manage<T>(path: string, details?: unknown, method?: string) {
    try {
      return await operatorRequest<T>(path, details, method);
    } catch (err) {
      if (err instanceof OperatorRequestError && err.status === 401) {
        endSession();
        setError("后台会话已结束，请重新登录。");
      }
      throw err;
    }
  }

  const readList = async (page: number) => {
    const result = await manage<LicensePage>("licenses/list", { page });
    setLicenses(result);
    setCode((current) => {
      if (!current) return current;
      const license = result.rows.find((row) => row.id === current.license.id);
      if (!license) return current;
      return license.status === "revoked" ? null : { ...current, license };
    });
    setNow(Date.now());
  };
  const showList = async (page = 1) => {
    setPending("list");
    setError("");
    try {
      await readList(page);
    } catch (err) {
      fail(err);
    } finally {
      setPending("");
    }
  };
  useEffect(() => {
    if (authenticated) void showList();
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated || sessionExpiresAt === null) return;
    const timer = window.setTimeout(
      () => {
        endSession();
        setError("后台会话已到期，请重新登录。");
      },
      Math.max(0, sessionExpiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [authenticated, sessionExpiresAt]);

  const logout = async () => {
    setPending("logout");
    setError("");
    try {
      await operatorRequest("logout", {});
      endSession();
    } catch (err) {
      fail(err);
    } finally {
      setPending("");
    }
  };
  const showCode = (result: LoginCode) => {
    setCode(result);
    setCopied(false);
    setNow(Date.now());
    requestAnimationFrame(() => resultRef.current?.focus());
  };
  const statusFor = (entry: LicenseRecord) =>
    entry.status === "active" &&
    entry.expiresAt !== null &&
    entry.expiresAt <= now
      ? "expired"
      : entry.status;
  const codeStatus = code ? statusFor(code.license) : null;
  const showHistoryCode = async (entry: LicenseRecord) => {
    setPending("reveal");
    setError("");
    try {
      const { code: existing } = await manage<{ code: string }>(
        "licenses/reveal",
        { id: entry.id },
      );
      showCode({ code: existing, license: entry });
    } catch (err) {
      fail(err);
    } finally {
      setPending("");
    }
  };
  const renewLicense = async (unit: LicenseUnit, quantity: number) => {
    if (!renewal) return;
    setPending("renew");
    setListNotice("");
    try {
      const { license } = await manage<{ license: LicenseRecord }>(
        "licenses/renew",
        {
          id: renewal.entry.id,
          requestId: renewal.requestId,
          unit,
          quantity,
        },
      );
      setLicenses(
        (current) =>
          current && {
            ...current,
            rows: current.rows.map((row) =>
              row.id === license.id ? license : row,
            ),
          },
      );
      setCode((current) =>
        current?.license.id === license.id ? { ...current, license } : current,
      );
      setNow(Date.now());
      setRenewal(null);
      if (license.expiresAt !== null) {
        setListNotice(
          `已续期，有效至 ${licenseDate.format(license.expiresAt)}（北京时间）。`,
        );
      }
    } finally {
      setPending("");
    }
  };
  const revoke = async (entry: LicenseRecord) => {
    if (
      !window.confirm(
        `停用末四位为 ${entry.suffix} 的登录码？该码关联的所有会话会失效。`,
      )
    )
      return;
    setPending("revoke");
    setError("");
    try {
      await manage("licenses/revoke", { id: entry.id });
      if (code?.license.id === entry.id) setCode(null);
      setLicenses(
        (current) =>
          current && {
            ...current,
            rows: current.rows.map((row) =>
              row.id === entry.id
                ? { ...row, status: "revoked", revokedAt: Date.now() }
                : row,
            ),
          },
      );
      setListNotice("登录码已停用。");
    } catch (err) {
      fail(err);
    } finally {
      setPending("");
    }
  };

  return (
    <div className="access-shell operator-shell">
      <header className="access-header">
        <div className="access-brand">
          Node X<span>管理工具</span>
        </div>
        <span className="operator-local">
          <span />
          Mac Chrome 管理入口
        </span>
      </header>
      <main className="operator-main">
        <div className="operator-heading">
          <span className="access-symbol">
            {showPublishing ? <Send size={26} strokeWidth={1.7} aria-hidden="true" />
              : showModels ? <Sparkles size={26} strokeWidth={1.7} aria-hidden="true" /> : <KeyRound size={26} strokeWidth={1.7} aria-hidden="true" />}
          </span>
          <div>
            <h1>{showPublishing ? "发布流程管理" : showModels ? "全局模型管理" : authenticated ? "登录码管理" : "登录管理后台"}</h1>
          </div>
          {authenticated ? (
            <OperatorButton
              className="secondary"
              busy={pending === "logout"}
              disabled={!!pending}
              onClick={() => void logout()}
            >
              <LogOut size={15} aria-hidden="true" />
              退出后台
            </OperatorButton>
          ) : (
            <OperatorButton
              className="secondary"
              busy={loading}
              disabled={!!pending}
              onClick={() => void load()}
            >
              <RefreshCw size={15} aria-hidden="true" />
              刷新状态
            </OperatorButton>
          )}
        </div>
        {authenticated && (
          <nav className="operator-sections" aria-label="后台功能">
            <OperatorButton className={showCodes ? "primary" : "secondary"} aria-pressed={showCodes}
              onClick={() => setSection("codes")}>登录码管理</OperatorButton>
            <OperatorButton className={showModels ? "primary" : "secondary"} aria-pressed={showModels}
              onClick={() => setSection("models")}>全局模型管理</OperatorButton>
            <OperatorButton className={showPublishing ? "primary" : "secondary"} aria-pressed={showPublishing}
              onClick={() => setSection("publishing")}>发布流程管理</OperatorButton>
          </nav>
        )}
        {showPublishing ? (
          <PublishingSettingsPanel request={manage} />
        ) : showModels ? (
          <ModelPage global requestModel={(path, method, body) => manage(path.slice(1), body, method)} />
        ) : (
        <div className="operator-grid">
          <section className="operator-status-card panel">
            <div className="operator-section-heading">
              <Fingerprint size={20} aria-hidden="true" />
              <h2>当前浏览器</h2>
            </div>
            <div className="operator-status-list">
              <div>
                <span>服务端登记</span>
                <strong>
                  {loading
                    ? "检查中"
                    : state?.enrolled
                      ? "已完成登记"
                      : state
                        ? "尚未登记"
                        : "无法读取"}
                </strong>
              </div>
              <div>
                <span>浏览器密钥</span>
                <strong>
                  {loading
                    ? "检查中"
                    : key
                      ? "已保存在此 Chrome"
                      : "未找到密钥"}
                </strong>
              </div>
              <div>
                <span>固定密码</span>
                <strong>
                  {loading
                    ? "检查中"
                    : state?.passwordConfigured
                      ? "已配置"
                      : state
                        ? "尚未配置"
                        : "无法读取"}
                </strong>
              </div>
            </div>
            <div className="operator-device-note">
              <ShieldCheck size={16} aria-hidden="true" />
              <p>
                请使用自己 Mac 的常用 Chrome
                个人资料。完成登记后，请保留此浏览器的网站数据，以便继续生成登录码。
              </p>
            </div>
          </section>
          <section className="operator-form-card panel">
            <div className="operator-section-heading">
              <KeyRound size={20} aria-hidden="true" />
              <h2>
                {state && !state.enrolled
                  ? "登记此浏览器"
                  : authenticated
                    ? "生成登录码"
                    : "管理员密码"}
              </h2>
              {state?.enrolled && (
                <span className="badge green">
                  <span />
                  服务端已登记
                </span>
              )}
            </div>
            <div className="operator-form-body">
              {loading && !state ? (
                <div className="access-loading" role="status">
                  <LoaderCircle size={22} className="spin" aria-hidden="true" />
                  正在读取浏览器状态…
                </div>
              ) : state && !state.enrolled ? (
                <>
                  <p className="operator-form-description">
                    首次使用时，输入终端提供的一次性登记令牌。登记完成后，登录后台需要使用此
                    Chrome 和固定密码。
                  </p>
                  <form
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (!token.trim() || pending) return;
                      setPending("enroll");
                      setError("");
                      setNotice("");
                      try {
                        const browserKey = await createBrowserKey();
                        setKey(browserKey);
                        await operatorRequest("enroll", {
                          token: token.trim(),
                          publicKey: browserKey.publicKey,
                        });
                        setToken("");
                        await load();
                        setNotice(
                          "此浏览器已完成登记，可以使用管理员密码登录。",
                        );
                      } catch (err) {
                        fail(err);
                      } finally {
                        setPending("");
                      }
                    }}
                  >
                    <label className="field">
                      <span>一次性登记令牌</span>
                      <input
                        autoFocus
                        type="password"
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        required
                        value={token}
                        disabled={!!pending}
                        placeholder="粘贴终端提供的令牌"
                        onChange={(event) => setToken(event.target.value)}
                      />
                    </label>
                    <OperatorButton
                      type="submit"
                      className="primary access-submit"
                      busy={pending === "enroll"}
                      disabled={!token.trim() || loading}
                    >
                      登记此 Chrome
                    </OperatorButton>
                  </form>
                </>
              ) : state?.enrolled && !key ? (
                <div className="operator-missing-key">
                  <CircleHelp size={28} strokeWidth={1.6} aria-hidden="true" />
                  <h3>请使用原来登记的 Chrome</h3>
                  <p>
                    此浏览器没有找到已保存的密钥。请切换到完成登记时使用的
                    Chrome 个人资料；如果网站数据已清除，需要由管理员重新登记。
                  </p>
                </div>
              ) : !authenticated ? (
                <>
                  {state && !state.passwordConfigured && (
                    <div className="form-note">
                      <CircleHelp size={17} aria-hidden="true" />
                      <p>
                        管理服务尚未配置密码。请先在终端完成初始化，再刷新此页面。
                      </p>
                    </div>
                  )}
                  <form
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (!canSignIn || !password || pending || !key) return;
                      setPending("login");
                      setError("");
                      setNotice("");
                      try {
                        const { challenge } = await operatorRequest<{
                          challenge: string;
                        }>("challenge", {});
                        const signature = await signChallenge(key, challenge);
                        const result = await operatorRequest<OperatorState>(
                          "login",
                          {
                            password,
                            challenge,
                            signature,
                          },
                        );
                        setPassword("");
                        setState(result);
                      } catch (err) {
                        fail(err);
                      } finally {
                        setPending("");
                      }
                    }}
                  >
                    <label className="field">
                      <span>密码</span>
                      <input
                        autoFocus
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        disabled={!canSignIn || !!pending}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </label>
                    <OperatorButton
                      type="submit"
                      className="primary access-submit"
                      busy={pending === "login"}
                      disabled={!canSignIn || !password || !!pending}
                    >
                      登录后台
                    </OperatorButton>
                  </form>
                </>
              ) : (
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (pending) return;
                    setPending("generate");
                    setError("");
                    setNotice("");
                    try {
                      const result = await manage<LoginCode>("codes", {
                        unit,
                        quantity: Number(quantity),
                        scope,
                        label,
                      });
                      showCode(result);
                      await readList(1);
                    } catch (err) {
                      fail(err);
                    } finally {
                      setPending("");
                    }
                  }}
                >
                  <div className="operator-license-period">
                    <label className="field">
                      <span>授权期限</span>
                      <input
                        type="number"
                        min={1}
                        max={unit === "days" ? 366 : 24}
                        step={1}
                        value={quantity}
                        required
                        disabled={!!pending}
                        onChange={(event) => setQuantity(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span id="license-unit-label">单位</span>
                      <select
                        aria-labelledby="license-unit-label"
                        value={unit}
                        disabled={!!pending}
                        onChange={(event) => {
                          setUnit(event.target.value as LicenseUnit);
                          setQuantity("1");
                        }}
                      >
                        <option value="days">天</option>
                        <option value="months">自然月</option>
                      </select>
                    </label>
                  </div>
                  <label className="field">
                    <span id="license-scope-label">使用范围</span>
                    <select
                      aria-labelledby="license-scope-label"
                      value={scope}
                      disabled={!!pending}
                      onChange={(event) =>
                        setScope(event.target.value as LicenseScope)
                      }
                    >
                      <option value="customer">独立客户空间</option>
                      <option value="owner">现有主空间（仅限自己）</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>备注（选填）</span>
                    <input
                      maxLength={80}
                      value={label}
                      disabled={!!pending}
                      placeholder="例如：客户名称或订单号"
                      onChange={(event) => setLabel(event.target.value)}
                    />
                  </label>
                  <p className="operator-code-hint">
                    {scope === "customer"
                      ? "授权从首次登录开始。客户使用独立空间。"
                      : "此码可访问现有账号和草稿，仅发给拥有主空间权限的人。"}
                  </p>
                  <OperatorButton
                    type="submit"
                    className="primary access-submit"
                    busy={pending === "generate"}
                    disabled={!!pending}
                  >
                    生成登录码
                  </OperatorButton>
                </form>
              )}
              {notice && (
                <p className="operator-notice" role="status">
                  <CheckCircle2 size={16} aria-hidden="true" />
                  {notice}
                </p>
              )}
              {error && (
                <p
                  className="form-error"
                  role="alert"
                  tabIndex={-1}
                  ref={errorRef}
                >
                  <CircleHelp size={16} aria-hidden="true" />
                  {error}
                </p>
              )}
            </div>
          </section>
        </div>
        )}
        {showCodes && code && (
          <section
            className={`operator-code-card panel ${codeStatus === "expired" ? "expired" : ""}`}
            tabIndex={-1}
            ref={resultRef}
          >
            <div className="operator-code-heading">
              <div>
                <h2>登录码 · {statusLabel[codeStatus ?? "pending"]}</h2>
                <p>
                  <Clock3 size={14} aria-hidden="true" />
                  {code.license.expiresAt === null
                    ? `首次登录后有效 ${durationLabel(code.license)}`
                    : `有效至 ${licenseDate.format(code.license.expiresAt)}（北京时间）`}
                </p>
              </div>
              <OperatorButton
                className="secondary"
                disabled={
                  !!pending ||
                  codeStatus === "expired" ||
                  codeStatus === "revoked"
                }
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(code.code);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2500);
                  } catch {
                    fail(new Error("无法自动复制，请选中下方登录码手动复制。"));
                  }
                }}
              >
                {copied ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <Copy size={16} aria-hidden="true" />
                )}
                {copied ? "已复制" : "复制登录码"}
              </OperatorButton>
            </div>
            <output className="operator-code" aria-label="新生成的登录码">
              {code.code}
            </output>
            <p className="operator-code-hint">
              {code.license.scope === "customer"
                ? "此码进入独立客户空间。"
                : "此码进入现有主空间。"}{" "}
              授权期内可重新登录，到期时间不会重置。
            </p>
          </section>
        )}
        {showCodes && (
          <section
            className="operator-code-card operator-license-list panel"
            aria-labelledby="license-list-title"
          >
            <div className="operator-code-heading">
              <div>
                <h2 id="license-list-title">登录码列表</h2>
                {licenses && <p>{licenses.total} 条 · 北京时间</p>}
              </div>
              <OperatorButton
                type="button"
                className="secondary"
                busy={pending === "list"}
                disabled={!!pending}
                onClick={() => void showList(licenses?.page)}
              >
                <RefreshCw size={15} aria-hidden="true" />
                刷新列表
              </OperatorButton>
            </div>
            {listNotice && (
              <p className="operator-notice" role="status">
                <CheckCircle2 size={16} aria-hidden="true" />
                {listNotice}
              </p>
            )}
            {!licenses ? (
              <p className="operator-code-hint">
                {pending === "list"
                  ? "正在读取登录码…"
                  : "刷新列表以读取登录码。"}
              </p>
            ) : licenses.rows.length === 0 ? (
              <p className="operator-code-hint">暂无按期签发的登录码。</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>登录码 / 备注</th>
                      <th>范围</th>
                      <th>首期时长</th>
                      <th>状态</th>
                      <th>签发时间</th>
                      <th>首次登录</th>
                      <th>到期时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {licenses.rows.map((entry) => {
                      const status = statusFor(entry);
                      const usable =
                        status === "pending" || status === "active";
                      const renewable =
                        status === "active" || status === "expired";
                      return (
                        <tr key={entry.id}>
                          <td>
                            <strong>NX-••••{entry.suffix}</strong>
                            {entry.label && <small>{entry.label}</small>}
                          </td>
                          <td>
                            {entry.scope === "customer"
                              ? "独立客户空间"
                              : "现有主空间"}
                          </td>
                          <td>{durationLabel(entry)}</td>
                          <td>
                            <span
                              className={`operator-license-status ${status}`}
                            >
                              {statusLabel[status]}
                            </span>
                          </td>
                          <td>{licenseDate.format(entry.createdAt)}</td>
                          <td>
                            {entry.activatedAt === null
                              ? "—"
                              : licenseDate.format(entry.activatedAt)}
                          </td>
                          <td>
                            {entry.expiresAt === null
                              ? "—"
                              : licenseDate.format(entry.expiresAt)}
                          </td>
                          <td>
                            <div className="operator-license-actions">
                              <button
                                type="button"
                                className="text-button"
                                disabled={!usable || !!pending}
                                onClick={() => void showHistoryCode(entry)}
                              >
                                查看码
                              </button>
                              {renewable && (
                                <button
                                  type="button"
                                  className="text-button"
                                  disabled={!!pending}
                                  onClick={() =>
                                    setRenewal({
                                      entry,
                                      requestId: crypto.randomUUID(),
                                    })
                                  }
                                >
                                  续期
                                </button>
                              )}
                              <button
                                type="button"
                                className="text-button"
                                disabled={status === "revoked" || !!pending}
                                onClick={() => void revoke(entry)}
                              >
                                停用
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {licenses && licenses.pages > 1 && (
              <div className="operator-license-pager">
                <OperatorButton
                  type="button"
                  className="secondary"
                  disabled={licenses.page <= 1 || !!pending}
                  onClick={() => void showList(licenses.page - 1)}
                >
                  上一页
                </OperatorButton>
                <span>
                  第 {licenses.page} / {licenses.pages} 页
                </span>
                <OperatorButton
                  type="button"
                  className="secondary"
                  disabled={licenses.page >= licenses.pages || !!pending}
                  onClick={() => void showList(licenses.page + 1)}
                >
                  下一页
                </OperatorButton>
              </div>
            )}
          </section>
        )}
        {showCodes && renewal && (
          <RenewLicenseDialog
            license={renewal.entry}
            busy={pending === "renew"}
            onClose={() => setRenewal(null)}
            onRenew={renewLicense}
          />
        )}
        <p className="access-footer">
          Node X<span />
          登录码管理工具
        </p>
      </main>
    </div>
  );
}
