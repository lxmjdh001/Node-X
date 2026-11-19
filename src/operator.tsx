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
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

type OperatorState = { enrolled: boolean; passwordConfigured: boolean };
type BrowserKey = { privateKey: CryptoKey; publicKey: JsonWebKey };
type LoginCode = { code: string; expiresAt: string };

async function operatorRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/operator/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(result.error || `请求失败（${response.status}）`);
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

export default function OperatorApp() {
  const [state, setState] = useState<OperatorState | null>(null);
  const [key, setKey] = useState<BrowserKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"" | "enroll" | "generate">("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState(15);
  const [code, setCode] = useState<LoginCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);
  const fail = (err: unknown) => {
    setError((err as Error).message);
    requestAnimationFrame(() => errorRef.current?.focus());
  };
  const expired = !!code && new Date(code.expiresAt).getTime() <= now;
  const canGenerate =
    !!state?.enrolled && !!state.passwordConfigured && !!key && !loading;
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
            <KeyRound size={26} strokeWidth={1.7} aria-hidden="true" />
          </span>
          <div>
            <h1>登录码生成器</h1>
            <p>在自己的 Mac Chrome 中生成工作空间登录码。</p>
          </div>
          <OperatorButton
            className="secondary"
            busy={loading}
            disabled={!!pending}
            onClick={() => void load()}
          >
            <RefreshCw size={15} aria-hidden="true" />
            刷新状态
          </OperatorButton>
        </div>
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
                {state && !state.enrolled ? "登记此浏览器" : "生成登录码"}
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
                    首次使用时，输入终端提供的一次性登记令牌。登记完成后，生成登录码需要使用此
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
                          "此浏览器已完成登记，可以使用固定密码生成登录码。",
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
              ) : (
                <>
                  <p className="operator-form-description">
                    输入固定密码并选择有效期。新登录码会显示在下方，可复制后提供给使用者。
                  </p>
                  {state && !state.passwordConfigured && (
                    <div className="form-note">
                      <CircleHelp size={17} aria-hidden="true" />
                      <p>
                        管理服务尚未配置固定密码。请先在终端完成初始化，再刷新此页面。
                      </p>
                    </div>
                  )}
                  <form
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (!canGenerate || pending || !key) return;
                      setPending("generate");
                      setError("");
                      setNotice("");
                      setCode(null);
                      setCopied(false);
                      try {
                        const challenge = await operatorRequest<{
                          challenge: string;
                          expiresAt: string;
                        }>("challenge", {});
                        const signature = await signChallenge(
                          key,
                          challenge.challenge,
                        );
                        const result = await operatorRequest<LoginCode>(
                          "codes",
                          {
                            password,
                            challenge: challenge.challenge,
                            signature,
                            ttlMinutes,
                          },
                        );
                        setCode(result);
                        setNow(Date.now());
                        requestAnimationFrame(() => resultRef.current?.focus());
                      } catch (err) {
                        fail(err);
                      } finally {
                        setPassword("");
                        setPending("");
                      }
                    }}
                  >
                    <label className="field">
                      <span>固定密码</span>
                      <input
                        autoFocus
                        type="password"
                        autoComplete="current-password"
                        required
                        value={password}
                        disabled={!canGenerate || !!pending}
                        placeholder="输入管理员固定密码"
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>登录码有效期</span>
                      <select
                        aria-label="登录码有效期"
                        value={ttlMinutes}
                        disabled={!canGenerate || !!pending}
                        onChange={(event) =>
                          setTtlMinutes(Number(event.target.value))
                        }
                      >
                        {[5, 15, 30, 60].map((minutes) => (
                          <option key={minutes} value={minutes}>
                            {minutes} 分钟
                          </option>
                        ))}
                      </select>
                    </label>
                    <OperatorButton
                      type="submit"
                      className="primary access-submit"
                      busy={pending === "generate"}
                      disabled={!canGenerate || !password}
                    >
                      生成登录码
                    </OperatorButton>
                  </form>
                </>
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
        {code && (
          <section
            className={`operator-code-card panel ${expired ? "expired" : ""}`}
            tabIndex={-1}
            ref={resultRef}
          >
            <div className="operator-code-heading">
              <div>
                <h2>{expired ? "登录码已到期" : "登录码已生成"}</h2>
                <p>
                  <Clock3 size={14} aria-hidden="true" />
                  有效至{" "}
                  {new Date(code.expiresAt).toLocaleString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <OperatorButton
                className="secondary"
                disabled={expired}
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
              {expired
                ? "请重新生成有效的登录码。"
                : "将登录码提供给需要访问工作空间的人。"}
            </p>
          </section>
        )}
        <p className="access-footer">
          Node X<span />
          登录码管理工具
        </p>
      </main>
    </div>
  );
}
