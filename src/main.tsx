import React, {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Fingerprint,
  Globe2,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  Monitor,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Unplug,
  Upload,
  Users,
  X,
} from "lucide-react";
import OperatorApp from "./operator";
import "./styles.css";

type Account = {
  id: string;
  label: string;
  username: string;
  xUsername: string | null;
  xConnected: boolean;
  notes: string;
  createdAt: string;
};
type Proxy = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  status: "unchecked" | "ok" | "error";
  lastIp: string | null;
  latency: number | null;
  checkedAt: string | null;
  checkError: string | null;
};
type Profile = {
  id: string;
  accountId: string;
  proxyId: string;
  label: string;
  locale: string;
  timezone: string;
  width: number;
  height: number;
  running: boolean;
  version: string | null;
};
type Draft = {
  id: string;
  accountId: string;
  prompt: string;
  text: string;
  status:
    "draft" | "scheduled" | "publishing" | "published" | "error" | "uncertain";
  scheduledAt: string | null;
  postId: string | null;
  error: string | null;
  createdAt: string;
};
type Workspace = {
  accounts: Account[];
  proxies: Proxy[];
  profiles: Profile[];
  drafts: Draft[];
  settings: { aiConfigured: boolean; xConfigured: boolean };
  chromium?: { installed: boolean; version: string | null };
  version: string;
};
type ImportFormat = "nodex" | "camoufox";
type ImportPreview = {
  rows: {
    row: number;
    username: string;
    accountLabel: string;
    profileLabel: string;
    proxyAddress: string;
    locale: string;
    timezone: string;
    status: "ready" | "skip" | "error";
    message: string;
  }[];
  ready: number;
  skipped: number;
  errors: number;
};
type CamoufoxData = {
  status: {
    configured: boolean;
    available: boolean;
    installed: boolean;
    version: string | null;
    minimumMajor: number;
    ready: boolean;
    message: string;
  };
  links: {
    accountId: string;
    profileId: string | null;
    name: string;
    running: boolean | null;
    proxyAddress: string | null;
  }[];
  catalog: {
    id: string;
    name: string;
    proxyAddress: string;
    running: boolean | null;
  }[];
};
type CamoufoxResult = {
  id: string;
  status: "ok" | "skipped" | "error";
  message: string;
};
type Page =
  "overview" | "accounts" | "proxies" | "profiles" | "drafts" | "settings";
type EntityModal =
  | { type: "account"; item?: Account }
  | { type: "proxy"; item?: Proxy }
  | { type: "profile"; item?: Profile }
  | { type: "draft"; item?: Draft };
type Confirmation = {
  title: string;
  description: string;
  label: string;
  destructive?: boolean;
  action: () => Promise<void>;
};
const blank: Workspace = {
  accounts: [],
  proxies: [],
  profiles: [],
  drafts: [],
  settings: { aiConfigured: false, xConfigured: false },
  version: "0.1.0",
};
const nav: { id: Page; title: string; icon: typeof Users }[] = [
  { id: "overview", title: "工作概览", icon: LayoutDashboard },
  { id: "accounts", title: "账号管理", icon: Users },
  { id: "proxies", title: "代理网络", icon: Network },
  { id: "profiles", title: "浏览器环境", icon: Fingerprint },
  { id: "drafts", title: "内容工作室", icon: FileText },
];
const statusText: Record<Draft["status"], string> = {
  draft: "草稿",
  scheduled: "已排程",
  publishing: "发布中",
  published: "已发布",
  error: "发布失败",
  uncertain: "结果待确认",
};

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.dispatchEvent(new Event("nodex:auth-expired"));
  }
  if (!response.ok)
    throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
function date(value: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}
function Icon({
  icon: Component,
  size = 18,
  ...props
}: {
  icon: typeof Users;
  size?: number;
  className?: string;
}) {
  return (
    <Component size={size} strokeWidth={1.7} aria-hidden="true" {...props} />
  );
}
function Badge({
  tone = "neutral",
  children,
}: {
  tone?: string;
  children: ReactNode;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span />
      {children}
    </span>
  );
}
function Empty({
  icon = Users,
  title,
  description,
  action,
}: {
  icon?: typeof Users;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon icon={icon} size={25} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function Button({
  children,
  icon,
  variant = "secondary",
  className = "",
  busy = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: typeof Users;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      className={`button ${variant} ${className}`}
      {...props}
      disabled={props.disabled || busy}
    >
      {busy ? (
        <Icon icon={LoaderCircle} className="spin" />
      ) : icon ? (
        <Icon icon={icon} size={16} />
      ) : null}
      {children}
    </button>
  );
}
function IconButton({
  label,
  icon,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: typeof Users;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      {...props}
    >
      <Icon icon={icon} size={17} />
    </button>
  );
}
function Dialog({
  title,
  description,
  children,
  onClose,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => {
      requestAnimationFrame(() => previous?.focus());
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <IconButton icon={X} label="关闭" onClick={onClose} />
      </div>
      {children}
    </dialog>
  );
}
function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function App({ onLogout }: { onLogout: () => Promise<void> }) {
  const initialPage = window.location.hash.slice(1) as Page;
  const [page, setPage] = useState<Page>(
    [...nav.map((n) => n.id), "settings"].includes(initialPage)
      ? initialPage
      : "overview",
  );
  const [data, setData] = useState<Workspace>(blank);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [modal, setModal] = useState<EntityModal | null>(null);
  const [importing, setImporting] = useState(false);
  const [camoufoxOpen, setCamoufoxOpen] = useState(false);
  const [camoufox, setCamoufox] = useState<CamoufoxData | null>(null);
  const [camoufoxLoading, setCamoufoxLoading] = useState(false);
  const [camoufoxError, setCamoufoxError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [publishing, setPublishing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [draftFilter, setDraftFilter] = useState("all");
  const [mobileNav, setMobileNav] = useState(false);
  const refresh = async (visible = false) => {
    if (visible) setBusy("refresh");
    try {
      const next = await request("/api/workspace");
      setData(next);
      setFetchError("");
    } catch (error) {
      setFetchError((error as Error).message);
    } finally {
      setLoading(false);
      if (visible) setBusy("");
    }
  };
  const refreshCamoufox = async () => {
    setCamoufoxLoading(true);
    try {
      const result = (await request("/api/camoufox")) as CamoufoxData;
      setCamoufox(result);
      setCamoufoxError("");
    } catch (error) {
      setCamoufoxError((error as Error).message);
    } finally {
      setCamoufoxLoading(false);
    }
  };
  useEffect(() => {
    if (page === "profiles") void refreshCamoufox();
  }, [page]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 8000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const handle = () => {
      const next = window.location.hash.slice(1) as Page;
      if ([...nav.map((n) => n.id), "settings"].includes(next)) {
        setPage(next);
        setQuery("");
      }
    };
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 9000 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("x") === "connected") setToast({ text: "X 账号已授权连接" });
    if (params.get("x") === "error")
      setToast({
        text:
          params.get("reason") === "handle"
            ? "授权账号与填写的账号不一致，请选择正确的 X 账号。"
            : "X 授权未完成，请检查配置后重试。",
        error: true,
      });
    if (params.has("x"))
      history.replaceState(null, "", `${location.pathname}${location.hash}`);
  }, []);
  const go = (next: Page) => {
    setPage(next);
    location.hash = next;
    setQuery("");
    setMobileNav(false);
  };
  const mutate = async (
    key: string,
    path: string,
    method: string,
    body: unknown,
    success: string,
  ) => {
    setBusy(key);
    try {
      const result = await request(path, method, body);
      await refresh();
      setToast({ text: success });
      return result;
    } catch (error) {
      setToast({ text: (error as Error).message, error: true });
      throw error;
    } finally {
      setBusy("");
    }
  };
  const run = (key: string, path: string, success: string) => {
    void mutate(key, path, "POST", undefined, success).catch(() => {});
  };
  const accountName = (id: string) =>
    data.accounts.find((a) => a.id === id)?.label || "未关联账号";
  const remove = (
    type: "accounts" | "proxies" | "profiles" | "drafts",
    id: string,
    label: string,
  ) =>
    setConfirmation({
      title: `删除${label}？`,
      description:
        type === "accounts"
          ? "请先删除该账号关联的浏览器环境与内容，再删除账号记录。删除后无法恢复。"
          : "删除后无法恢复。正在使用的配置可能需要先解除关联。",
      label: "确认删除",
      destructive: true,
      action: async () => {
        await mutate(
          `delete-${id}`,
          `/api/${type}/${id}`,
          "DELETE",
          undefined,
          "已删除",
        );
        setConfirmation(null);
      },
    });
  const addButton = (
    type: EntityModal["type"],
    label: string,
    disabled = false,
  ) => (
    <Button
      variant="primary"
      icon={Plus}
      disabled={disabled}
      onClick={() => setModal({ type } as EntityModal)}
    >
      {label}
    </Button>
  );
  const readyProxy = data.proxies.filter((p) => p.status === "ok").length;
  const connected = data.accounts.filter((a) => a.xConnected).length;
  const working = data.profiles.filter((p) => p.running).length;
  const filteredAccounts = data.accounts.filter((a) =>
    `${a.label} ${a.username} ${a.xUsername || ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const pageInfo = {
    overview: ["工作概览", "每个账号，都有清晰的工作环境。"],
    accounts: ["账号管理", "管理你的 X 账号、授权状态与关联环境。"],
    proxies: ["代理网络", "配置 SOCKS5 出口，并检查连接状态。"],
    profiles: ["浏览器环境", "为每个账号绑定独立的浏览器数据与代理。"],
    drafts: ["内容工作室", "从想法到草稿，再由你确认发布。"],
    settings: ["系统设置", "查看本地服务、AI 模型与 X 接入状态。"],
  }[page];
  function AccountTable({ preview = false }: { preview?: boolean }) {
    const list = preview ? data.accounts.slice(0, 5) : filteredAccounts;
    if (!list.length)
      return (
        <Empty
          title={query ? "没有找到这个账号" : "添加第一个 X 账号"}
          description={
            query
              ? "试试账号名称或用户名。"
              : "先建立账号记录，再为它配置代理和浏览器环境。"
          }
          action={!query && addButton("account", "添加账号")}
        />
      );
    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>X 授权</th>
              <th>浏览器环境</th>
              <th>代理出口</th>
              <th className="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((account) => {
              const profile = data.profiles.find(
                (p) => p.accountId === account.id,
              );
              const proxy = data.proxies.find((p) => p.id === profile?.proxyId);
              return (
                <tr key={account.id}>
                  <td>
                    <div className="account-cell">
                      <span className="avatar">
                        {account.label.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <strong>{account.label}</strong>
                        <small>
                          {account.username
                            ? `@${account.username.replace(/^@/, "")}`
                            : "尚未填写用户名"}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Badge tone={account.xConnected ? "green" : "neutral"}>
                      {account.xConnected
                        ? `已连接${account.xUsername ? ` @${account.xUsername.replace(/^@/, "")}` : ""}`
                        : "未授权"}
                    </Badge>
                  </td>
                  <td>
                    {profile ? (
                      <div className="cell-stack">
                        <span>{profile.label}</span>
                        <small>{profile.running ? "正在运行" : "已配置"}</small>
                      </div>
                    ) : (
                      <button
                        className="text-button muted"
                        onClick={() => {
                          go("profiles");
                          setModal({ type: "profile" });
                        }}
                      >
                        待配置
                        <Icon icon={ArrowUpRight} size={13} />
                      </button>
                    )}
                  </td>
                  <td>
                    {proxy ? (
                      <span className="mono subtle">
                        {proxy.host}:{proxy.port}
                      </span>
                    ) : (
                      <span className="subtle">—</span>
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      {!account.xConnected ? (
                        <Button
                          variant="ghost"
                          icon={Link2}
                          disabled={!data.settings.xConfigured}
                          onClick={() => {
                            location.href = `/api/x/connect/${account.id}`;
                          }}
                        >
                          授权
                        </Button>
                      ) : (
                        !preview && (
                          <IconButton
                            icon={Unplug}
                            label="断开 X 授权"
                            onClick={() =>
                              setConfirmation({
                                title: "断开 X 授权？",
                                description:
                                  "该账号将无法发布内容，重新授权后可继续使用。",
                                label: "断开授权",
                                action: async () => {
                                  await mutate(
                                    account.id,
                                    `/api/accounts/${account.id}/disconnect`,
                                    "POST",
                                    undefined,
                                    "已断开 X 授权",
                                  );
                                  setConfirmation(null);
                                },
                              })
                            }
                          />
                        )
                      )}
                      {!preview && (
                        <>
                          <IconButton
                            icon={Pencil}
                            label={`编辑 ${account.label}`}
                            onClick={() =>
                              setModal({ type: "account", item: account })
                            }
                          />
                          <IconButton
                            icon={Trash2}
                            label={`删除 ${account.label}`}
                            onClick={() =>
                              remove("accounts", account.id, account.label)
                            }
                          />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <a
          className="brand"
          href="#overview"
          onClick={() => go("overview")}
          aria-label="Node X 工作概览"
        >
          <span className="brand-mark">
            n<span>×</span>
          </span>
          <span>
            Node X<span className="brand-meta">工作空间</span>
          </span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-dot">
            <Monitor size={16} />
          </span>
          <div>
            <strong>本地工作空间</strong>
            <small>个人控制台</small>
          </div>
        </div>
        <div className="nav-label">工作空间</div>
        <nav aria-label="主导航">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => go(item.id)}
            >
              <Icon icon={item.icon} />
              <span>{item.title}</span>
              {item.id === "accounts" && data.accounts.length > 0 && (
                <span className="nav-count">{data.accounts.length}</span>
              )}
              {page === item.id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => go("settings")}
          >
            <Icon icon={Settings2} />
            <span>系统设置</span>
          </button>
          <div className="local-status">
            <span
              className={
                fetchError ? "connection-dot error-dot" : "connection-dot"
              }
            />
            <div>
              <strong>
                {fetchError
                  ? "服务连接异常"
                  : loading
                    ? "正在连接服务"
                    : "本地服务运行中"}
              </strong>
              <small>v{data.version}</small>
            </div>
            <Monitor size={15} aria-hidden="true" />
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <IconButton
              icon={Menu}
              label="打开导航"
              className="mobile-toggle"
              onClick={() => setMobileNav(true)}
            />
            <span>工作空间</span>
            <Icon icon={ChevronRight} size={14} />
            <strong>{pageInfo[0]}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-pill">
              <span />
              本地部署
            </span>
            <IconButton
              icon={busy === "refresh" ? LoaderCircle : RefreshCw}
              label="刷新数据"
              className={busy === "refresh" ? "spin" : ""}
              onClick={() => void refresh(true)}
            />
            <span className="user-avatar" title="本地管理员">
              N
            </span>
            <Button
              variant="ghost"
              icon={LogOut}
              className="logout-control"
              busy={busy === "logout"}
              onClick={async () => {
                setBusy("logout");
                try {
                  await onLogout();
                } catch (error) {
                  setToast({ text: (error as Error).message, error: true });
                } finally {
                  setBusy("");
                }
              }}
            >
              退出
            </Button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>{pageInfo[0]}</h1>
              <p>{pageInfo[1]}</p>
            </div>
            <div className="heading-action">
              {page === "profiles" && (
                <Button
                  icon={Fingerprint}
                  onClick={() => {
                    setCamoufoxOpen(true);
                    void refreshCamoufox();
                  }}
                >
                  Camoufox 批量管理
                </Button>
              )}
              {(page === "accounts" || page === "profiles") && (
                <Button icon={Upload} onClick={() => setImporting(true)}>
                  批量导入
                </Button>
              )}
              {page === "overview" || page === "accounts"
                ? addButton("account", "添加账号")
                : page === "proxies"
                  ? addButton("proxy", "添加代理")
                  : page === "profiles"
                    ? addButton(
                        "profile",
                        "创建环境",
                        !data.accounts.length || !data.proxies.length,
                      )
                    : page === "drafts"
                      ? addButton("draft", "新建内容", !data.accounts.length)
                      : null}
            </div>
          </div>
          {fetchError && (
            <div className="alert error-alert" role="alert">
              <Icon icon={Activity} />
              <span>无法连接本地服务：{fetchError}</span>
              <button
                className="text-button"
                onClick={() => void refresh(true)}
              >
                重试
              </button>
            </div>
          )}
          {loading ? (
            <div className="loading-state">
              <Icon icon={LoaderCircle} className="spin" size={26} />
              <p>正在连接本地工作空间…</p>
            </div>
          ) : (
            <>
              {page === "overview" && (
                <>
                  <section className="metric-strip" aria-label="工作空间状态">
                    {[
                      {
                        name: "账号总数",
                        value: data.accounts.length,
                        icon: Users,
                        detail: `${connected} 个已授权 X`,
                      },
                      {
                        name: "可用代理",
                        value: readyProxy,
                        icon: Network,
                        detail: `共 ${data.proxies.length} 个 SOCKS5 代理`,
                      },
                      {
                        name: "浏览器环境",
                        value: data.profiles.length,
                        icon: Fingerprint,
                        detail: `${working} 个正在运行`,
                      },
                      {
                        name: "待发布内容",
                        value: data.drafts.filter(
                          (d) =>
                            d.status === "draft" || d.status === "scheduled",
                        ).length,
                        icon: FileText,
                        detail: `${data.drafts.filter((d) => d.status === "published").length} 篇已发布`,
                      },
                    ].map((stat) => (
                      <div className="metric" key={stat.name}>
                        <div className="metric-label">
                          {stat.name}
                          <Icon icon={stat.icon} size={17} />
                        </div>
                        <strong>
                          {stat.value.toString().padStart(2, "0")}
                        </strong>
                        <small>{stat.detail}</small>
                      </div>
                    ))}
                  </section>
                  <section className="setup-panel">
                    <div className="setup-intro">
                      <div className="setup-icon">
                        <Icon icon={Network} size={26} />
                      </div>
                      <h2>
                        {data.accounts.length &&
                        data.proxies.length &&
                        data.profiles.length
                          ? "基础配置已完成"
                          : "从一个独立环境开始"}
                      </h2>
                      <p>
                        账号、代理、浏览器数据一一关联，
                        <br className="desktop-break" />
                        让每次操作都有清晰的归属。
                      </p>
                      <span className="setup-progress">
                        {
                          [
                            data.accounts.length,
                            data.proxies.length,
                            data.profiles.length,
                          ].filter(Boolean).length
                        }{" "}
                        / 3 项基础配置完成
                      </span>
                    </div>
                    <div className="setup-steps">
                      {[
                        {
                          label: "添加 X 账号",
                          text: "记录账号信息，连接发文授权",
                          done: data.accounts.length > 0,
                          icon: Users,
                          target: "accounts" as Page,
                        },
                        {
                          label: "配置 SOCKS5 代理",
                          text: "添加独立出口，检查网络连通性",
                          done: data.proxies.length > 0,
                          icon: Network,
                          target: "proxies" as Page,
                        },
                        {
                          label: "创建浏览器环境",
                          text: "绑定账号、代理与独立浏览器数据",
                          done: data.profiles.length > 0,
                          icon: Fingerprint,
                          target: "profiles" as Page,
                        },
                      ].map((step, i) => (
                        <button
                          key={step.label}
                          className="setup-step"
                          onClick={() => go(step.target)}
                        >
                          <span
                            className={`step-number ${step.done ? "complete" : ""}`}
                          >
                            {step.done ? (
                              <Icon icon={Check} size={16} />
                            ) : (
                              i + 1
                            )}
                          </span>
                          <div>
                            <strong>{step.label}</strong>
                            <span>{step.text}</span>
                          </div>
                          <Icon
                            icon={step.done ? CheckCircle2 : ArrowRight}
                            size={18}
                          />
                        </button>
                      ))}
                    </div>
                  </section>
                  <div className="overview-grid">
                    <section className="panel account-overview">
                      <div className="panel-heading">
                        <h2>
                          账号与环境
                          <span className="count">{data.accounts.length}</span>
                        </h2>
                        <button
                          className="text-button"
                          onClick={() => go("accounts")}
                        >
                          查看全部
                          <Icon icon={ArrowRight} size={15} />
                        </button>
                      </div>
                      <AccountTable preview />
                    </section>
                    <section className="panel checklist">
                      <div className="panel-heading">
                        <h2>接入状态</h2>
                        <Icon icon={ShieldCheck} size={18} />
                      </div>
                      <div className="check-item">
                        <span className="check-icon">
                          <Icon icon={Sparkles} size={18} />
                        </span>
                        <div>
                          <strong>AI 内容模型</strong>
                          <small>
                            {data.settings.aiConfigured
                              ? "模型凭据已配置"
                              : "添加模型凭据后可生成内容"}
                          </small>
                        </div>
                        <span
                          className={`state-dot ${data.settings.aiConfigured ? "ok" : ""}`}
                        />
                      </div>
                      <div className="check-item">
                        <span className="check-icon">
                          <Icon icon={Link2} size={18} />
                        </span>
                        <div>
                          <strong>X 发布接口</strong>
                          <small>
                            {data.settings.xConfigured
                              ? `${connected} 个账号已完成授权`
                              : "配置开发者应用后连接账号"}
                          </small>
                        </div>
                        <span
                          className={`state-dot ${data.settings.xConfigured ? "ok" : ""}`}
                        />
                      </div>
                      <button
                        className="settings-link"
                        onClick={() => go("settings")}
                      >
                        管理接入配置
                        <Icon icon={ArrowUpRight} size={16} />
                      </button>
                      <div className="helper-note">
                        <Icon icon={CircleHelp} size={16} />
                        <p>
                          浏览器用于人工登录与管理。内容发布通过 X
                          授权接口执行。
                        </p>
                      </div>
                    </section>
                  </div>
                </>
              )}
              {page === "accounts" && (
                <section className="panel">
                  <div className="table-toolbar">
                    <div className="tabs">
                      <span className="tab active">
                        全部账号<span>{data.accounts.length}</span>
                      </span>
                    </div>
                    <SearchBox
                      value={query}
                      onChange={setQuery}
                      placeholder="搜索账号名称、用户名"
                    />
                  </div>
                  {!data.settings.xConfigured && data.accounts.length > 0 && (
                    <div className="inline-notice">
                      <Icon icon={Link2} size={16} />
                      <span>
                        配置 X 开发者应用后，即可连接账号授权并发布内容。
                      </span>
                      <button
                        className="text-button"
                        onClick={() => go("settings")}
                      >
                        前往设置
                      </button>
                    </div>
                  )}
                  <AccountTable />
                  <div className="table-footer">
                    共 {filteredAccounts.length} 个账号
                    <span>登录信息保存在各自的浏览器环境中</span>
                  </div>
                </section>
              )}
              {page === "proxies" && (
                <>
                  <div className="info-banner">
                    <span className="info-banner-icon">
                      <Icon icon={Network} size={22} />
                    </span>
                    <div>
                      <strong>独立出口，按环境绑定</strong>
                      <p>
                        支持 SOCKS5
                        用户名与密码认证。添加后请先检查连接，再关联浏览器环境。
                      </p>
                    </div>
                    <span className="protocol-tag">SOCKS5</span>
                  </div>
                  <section className="panel">
                    <div className="table-toolbar">
                      <div className="tabs">
                        <span className="tab active">
                          全部代理<span>{data.proxies.length}</span>
                        </span>
                      </div>
                      <SearchBox
                        value={query}
                        onChange={setQuery}
                        placeholder="搜索名称或主机地址"
                      />
                    </div>
                    {!data.proxies.length ? (
                      <Empty
                        icon={Network}
                        title="还没有代理网络"
                        description="添加一个 SOCKS5 代理，为浏览器环境指定网络出口。"
                        action={addButton("proxy", "添加代理")}
                      />
                    ) : (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>代理名称</th>
                              <th>主机地址</th>
                              <th>连接状态</th>
                              <th>出口 IP / 延迟</th>
                              <th>关联环境</th>
                              <th className="align-right">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.proxies
                              .filter((p) =>
                                `${p.label} ${p.host}`
                                  .toLowerCase()
                                  .includes(query.toLowerCase()),
                              )
                              .map((proxy) => (
                                <tr key={proxy.id}>
                                  <td>
                                    <div className="cell-stack">
                                      <strong>{proxy.label}</strong>
                                      <small>
                                        {proxy.username
                                          ? "已启用身份认证"
                                          : "无身份认证"}
                                      </small>
                                    </div>
                                  </td>
                                  <td>
                                    <span className="mono">
                                      {proxy.host}:{proxy.port}
                                    </span>
                                  </td>
                                  <td>
                                    <Badge
                                      tone={
                                        proxy.status === "ok"
                                          ? "green"
                                          : proxy.status === "error"
                                            ? "red"
                                            : "neutral"
                                      }
                                    >
                                      {proxy.status === "ok"
                                        ? "连接正常"
                                        : proxy.status === "error"
                                          ? "连接失败"
                                          : "尚未检查"}
                                    </Badge>
                                    {proxy.checkError && (
                                      <small
                                        className="cell-error"
                                        title={proxy.checkError}
                                      >
                                        {proxy.checkError}
                                      </small>
                                    )}
                                  </td>
                                  <td>
                                    <div className="cell-stack">
                                      <span className="mono">
                                        {proxy.lastIp || "—"}
                                      </span>
                                      <small>
                                        {proxy.latency != null
                                          ? `${proxy.latency} ms`
                                          : "等待连接检查"}
                                      </small>
                                    </div>
                                  </td>
                                  <td>
                                    <span className="subtle">
                                      {
                                        data.profiles.filter(
                                          (p) => p.proxyId === proxy.id,
                                        ).length
                                      }{" "}
                                      个环境
                                    </span>
                                  </td>
                                  <td>
                                    <div className="row-actions">
                                      <Button
                                        variant="ghost"
                                        icon={RefreshCw}
                                        busy={busy === `check-${proxy.id}`}
                                        onClick={() =>
                                          run(
                                            `check-${proxy.id}`,
                                            `/api/proxies/${proxy.id}/check`,
                                            "代理检查已完成",
                                          )
                                        }
                                      >
                                        检查
                                      </Button>
                                      <IconButton
                                        icon={Pencil}
                                        label={`编辑 ${proxy.label}`}
                                        onClick={() =>
                                          setModal({
                                            type: "proxy",
                                            item: proxy,
                                          })
                                        }
                                      />
                                      <IconButton
                                        icon={Trash2}
                                        label={`删除 ${proxy.label}`}
                                        onClick={() =>
                                          remove(
                                            "proxies",
                                            proxy.id,
                                            proxy.label,
                                          )
                                        }
                                      />
                                    </div>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="table-footer">
                      共 {data.proxies.length} 个代理
                      <span>出口 IP 与延迟来自实际连接检查</span>
                    </div>
                  </section>
                </>
              )}
              {page === "profiles" && (
                <>
                  <div className="engine-grid">
                    <section className="engine-panel">
                      <span className="info-banner-icon">
                        <Icon icon={Monitor} size={21} />
                      </span>
                      <div className="engine-copy">
                        <h2>
                          本地 Chromium
                          <Badge
                            tone={
                              data.chromium?.installed ? "green" : "neutral"
                            }
                          >
                            {data.chromium?.installed ? "已安装" : "未安装"}
                          </Badge>
                        </h2>
                        <p>
                          {data.chromium?.installed
                            ? `真实版本 ${data.chromium.version || "待读取"}。每个账号使用独立目录保存会话。`
                            : "安装 Playwright 浏览器后，即可打开下方配置的独立环境。"}
                        </p>
                        {!data.chromium?.installed && (
                          <code className="engine-command">
                            npm run browser:install
                          </code>
                        )}
                      </div>
                    </section>
                    <section className="engine-panel">
                      <span className="info-banner-icon">
                        <Icon icon={Fingerprint} size={21} />
                      </span>
                      <div className="engine-copy">
                        <h2>
                          Camoufox Profile Manager
                          <Badge
                            tone={
                              camoufoxError
                                ? "red"
                                : camoufox?.status.ready
                                  ? "green"
                                  : "neutral"
                            }
                          >
                            {camoufoxLoading
                              ? "检查中"
                              : camoufoxError
                                ? "连接异常"
                                : camoufox?.status.ready
                                  ? "已就绪"
                                  : camoufox?.status.configured
                                    ? "未就绪"
                                    : "未配置"}
                          </Badge>
                        </h2>
                        <p>
                          {camoufoxError ||
                            camoufox?.status.message ||
                            "配置 Manager 端口后，可批量创建环境或关联已有会话。"}
                        </p>
                        {camoufox?.status.version && (
                          <p>
                            已安装引擎 {camoufox.status.version} · 最低主版本{" "}
                            {camoufox.status.minimumMajor}
                          </p>
                        )}
                        <button
                          className="text-button"
                          disabled={camoufoxLoading}
                          onClick={() => void refreshCamoufox()}
                        >
                          <Icon
                            icon={camoufoxLoading ? LoaderCircle : RefreshCw}
                            size={13}
                            className={camoufoxLoading ? "spin" : ""}
                          />
                          刷新状态
                        </button>
                      </div>
                    </section>
                  </div>
                  {(!data.accounts.length || !data.proxies.length) && (
                    <div className="inline-notice standalone">
                      <Icon icon={CircleHelp} size={16} />
                      <span>
                        创建环境前，请先添加
                        {!data.accounts.length ? "账号" : ""}
                        {!data.accounts.length && !data.proxies.length
                          ? "和"
                          : ""}
                        {!data.proxies.length ? " SOCKS5 代理" : ""}。
                      </span>
                      <button
                        className="text-button"
                        onClick={() =>
                          go(!data.accounts.length ? "accounts" : "proxies")
                        }
                      >
                        前往配置
                        <Icon icon={ArrowRight} size={14} />
                      </button>
                    </div>
                  )}
                  <section className="panel">
                    <div className="table-toolbar">
                      <div className="tabs">
                        <span className="tab active">
                          本地 Chromium 环境<span>{data.profiles.length}</span>
                        </span>
                      </div>
                      <SearchBox
                        value={query}
                        onChange={setQuery}
                        placeholder="搜索环境或账号"
                      />
                    </div>
                    {!data.profiles.length ? (
                      <Empty
                        icon={Fingerprint}
                        title="为账号创建独立环境"
                        description="关联账号和代理后，即可打开浏览器并人工登录 X。"
                        action={addButton(
                          "profile",
                          "创建环境",
                          !data.accounts.length || !data.proxies.length,
                        )}
                      />
                    ) : (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>环境名称</th>
                              <th>关联账号</th>
                              <th>代理网络</th>
                              <th>配置</th>
                              <th>运行状态</th>
                              <th className="align-right">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.profiles
                              .filter((p) =>
                                `${p.label} ${accountName(p.accountId)}`
                                  .toLowerCase()
                                  .includes(query.toLowerCase()),
                              )
                              .map((profile) => (
                                <tr key={profile.id}>
                                  <td>
                                    <div className="cell-stack">
                                      <strong>{profile.label}</strong>
                                      <small>
                                        {profile.version ||
                                          "启动后读取浏览器版本"}
                                      </small>
                                    </div>
                                  </td>
                                  <td>{accountName(profile.accountId)}</td>
                                  <td>
                                    <div className="cell-stack">
                                      <span>
                                        {data.proxies.find(
                                          (p) => p.id === profile.proxyId,
                                        )?.label || "代理已移除"}
                                      </span>
                                      <small>SOCKS5</small>
                                    </div>
                                  </td>
                                  <td>
                                    <div className="cell-stack">
                                      <span>
                                        {profile.locale} / {profile.width} ×{" "}
                                        {profile.height}
                                      </span>
                                      <small>{profile.timezone}</small>
                                    </div>
                                  </td>
                                  <td>
                                    <Badge
                                      tone={
                                        profile.running ? "green" : "neutral"
                                      }
                                    >
                                      {profile.running ? "运行中" : "未启动"}
                                    </Badge>
                                  </td>
                                  <td>
                                    <div className="row-actions">
                                      <Button
                                        icon={profile.running ? Square : Play}
                                        variant={
                                          profile.running
                                            ? "secondary"
                                            : "primary"
                                        }
                                        busy={busy === profile.id}
                                        onClick={() =>
                                          run(
                                            profile.id,
                                            `/api/profiles/${profile.id}/${profile.running ? "stop" : "start"}`,
                                            profile.running
                                              ? "环境已关闭"
                                              : "浏览器环境已打开",
                                          )
                                        }
                                      >
                                        {profile.running ? "关闭" : "打开"}
                                      </Button>
                                      <IconButton
                                        icon={Pencil}
                                        label={`编辑 ${profile.label}`}
                                        disabled={profile.running}
                                        onClick={() =>
                                          setModal({
                                            type: "profile",
                                            item: profile,
                                          })
                                        }
                                      />
                                      <IconButton
                                        icon={Trash2}
                                        label={`删除 ${profile.label}`}
                                        disabled={profile.running}
                                        onClick={() =>
                                          remove(
                                            "profiles",
                                            profile.id,
                                            profile.label,
                                          )
                                        }
                                      />
                                    </div>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="table-footer">
                      共 {data.profiles.length} 个环境
                      <span>{working} 个环境运行中</span>
                    </div>
                  </section>
                </>
              )}
              {page === "drafts" && (
                <>
                  <section className="studio-intro">
                    <div>
                      <span className="studio-icon">
                        <Icon icon={Sparkles} size={22} />
                      </span>
                      <div>
                        <h2>写下想法，保留你的判断。</h2>
                        <p>AI 协助起草，你来编辑并确认发布。</p>
                      </div>
                    </div>
                    <div className="studio-connection">
                      <span
                        className={`state-dot ${data.settings.aiConfigured ? "ok" : ""}`}
                      />
                      {data.settings.aiConfigured
                        ? "AI 模型已配置"
                        : "AI 模型尚未配置"}
                      <button
                        className="text-button"
                        onClick={() => go("settings")}
                      >
                        <Icon icon={ArrowUpRight} size={15} />
                        <span className="sr-only">查看模型配置</span>
                      </button>
                    </div>
                  </section>
                  <section className="panel">
                    <div className="table-toolbar">
                      <div
                        className="tabs"
                        role="tablist"
                        aria-label="内容状态"
                      >
                        {[
                          ["all", "全部内容"],
                          ["draft", "草稿"],
                          ["scheduled", "已排程"],
                          ["published", "已发布"],
                        ].map(([value, label]) => (
                          <button
                            role="tab"
                            aria-selected={draftFilter === value}
                            className={`tab ${draftFilter === value ? "active" : ""}`}
                            key={value}
                            onClick={() => setDraftFilter(value)}
                          >
                            {label}
                            {value === "all" && (
                              <span>{data.drafts.length}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                    {data.drafts.filter(
                      (d) => draftFilter === "all" || d.status === draftFilter,
                    ).length === 0 ? (
                      <Empty
                        icon={FileText}
                        title={
                          draftFilter === "all"
                            ? "你的下一篇内容，从这里开始"
                            : "这里还没有内容"
                        }
                        description={
                          data.accounts.length
                            ? "选择账号，手动编写或让 AI 帮你起草。"
                            : "先添加一个账号，再开始创建内容。"
                        }
                        action={
                          draftFilter === "all" &&
                          addButton("draft", "新建内容", !data.accounts.length)
                        }
                      />
                    ) : (
                      <div className="draft-list">
                        {data.drafts
                          .filter(
                            (d) =>
                              draftFilter === "all" || d.status === draftFilter,
                          )
                          .map((draft) => (
                            <article className="draft-card" key={draft.id}>
                              <div className="draft-top">
                                <div className="account-cell">
                                  <span className="avatar small">
                                    {accountName(draft.accountId).slice(0, 1)}
                                  </span>
                                  <strong>
                                    {accountName(draft.accountId)}
                                  </strong>
                                </div>
                                <Badge
                                  tone={
                                    draft.status === "published"
                                      ? "green"
                                      : draft.status === "error" ||
                                          draft.status === "uncertain"
                                        ? "red"
                                        : draft.status === "scheduled"
                                          ? "blue"
                                          : "neutral"
                                  }
                                >
                                  {statusText[draft.status]}
                                </Badge>
                              </div>
                              <p
                                className={`draft-text ${!draft.text ? "subtle" : ""}`}
                              >
                                {draft.text || "空白草稿，点击编辑添加正文。"}
                              </p>
                              {draft.error && (
                                <p className="draft-error">
                                  <Icon icon={CircleHelp} size={15} />
                                  {draft.error}
                                </p>
                              )}
                              <div className="draft-bottom">
                                <span className="draft-date">
                                  <Icon
                                    icon={draft.scheduledAt ? Clock3 : FileText}
                                    size={14}
                                  />
                                  {draft.scheduledAt
                                    ? `计划 ${date(draft.scheduledAt)}`
                                    : `创建于 ${date(draft.createdAt)}`}
                                </span>
                                <div className="row-actions">
                                  {draft.status === "published" &&
                                  draft.postId ? (
                                    <a
                                      className="button ghost"
                                      href={`https://x.com/i/web/status/${draft.postId}`}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      查看推文
                                      <Icon icon={ExternalLink} size={15} />
                                    </a>
                                  ) : draft.status === "scheduled" ? (
                                    <Button
                                      variant="ghost"
                                      icon={Square}
                                      busy={busy === draft.id}
                                      onClick={() =>
                                        run(
                                          draft.id,
                                          `/api/drafts/${draft.id}/cancel`,
                                          "已取消排程，内容保留为草稿",
                                        )
                                      }
                                    >
                                      取消排程
                                    </Button>
                                  ) : draft.status !== "publishing" &&
                                    draft.status !== "uncertain" ? (
                                    <>
                                      <Button
                                        variant="ghost"
                                        icon={Pencil}
                                        onClick={() =>
                                          setModal({
                                            type: "draft",
                                            item: draft,
                                          })
                                        }
                                      >
                                        编辑
                                      </Button>
                                      <Button
                                        icon={Send}
                                        disabled={
                                          !draft.text.trim() ||
                                          !data.accounts.find(
                                            (a) => a.id === draft.accountId,
                                          )?.xConnected
                                        }
                                        onClick={() => setPublishing(draft)}
                                      >
                                        发布
                                      </Button>
                                    </>
                                  ) : null}
                                  {draft.status !== "publishing" &&
                                    draft.status !== "scheduled" && (
                                      <IconButton
                                        icon={Trash2}
                                        label="删除内容"
                                        onClick={() =>
                                          remove("drafts", draft.id, "这篇内容")
                                        }
                                      />
                                    )}
                                </div>
                              </div>
                            </article>
                          ))}
                      </div>
                    )}
                  </section>
                  <p className="page-footnote">
                    <Icon icon={ShieldCheck} size={14} />
                    发布前需要你确认目标账号与正文。排程依赖本地服务持续运行。
                  </p>
                </>
              )}
              {page === "settings" && (
                <div className="settings-grid">
                  <section className="panel settings-section">
                    <div className="settings-section-heading">
                      <span className="settings-symbol">
                        <Icon icon={Sparkles} size={23} />
                      </span>
                      <div>
                        <h2>AI 内容模型</h2>
                        <p>使用兼容 OpenAI 格式的模型接口生成草稿。</p>
                      </div>
                      <Badge
                        tone={data.settings.aiConfigured ? "green" : "neutral"}
                      >
                        {data.settings.aiConfigured ? "已配置" : "未配置"}
                      </Badge>
                    </div>
                    <div className="settings-content">
                      <p>
                        在项目根目录的 <code>.env</code>{" "}
                        中配置以下变量，然后重启本地服务。
                      </p>
                      <CodeBlock
                        text={
                          "AI_BASE_URL=https://api.example.com/v1\nAI_API_KEY=你的模型密钥\nAI_MODEL=你的模型名称"
                        }
                      />
                      <div className="helper-note">
                        <Icon icon={ShieldCheck} size={16} />
                        <p>
                          密钥仅由本地服务读取。此页面不会显示或传输已保存的密钥。
                        </p>
                      </div>
                    </div>
                  </section>
                  <section className="panel settings-section">
                    <div className="settings-section-heading">
                      <span className="settings-symbol">
                        <Icon icon={Link2} size={23} />
                      </span>
                      <div>
                        <h2>X 发布授权</h2>
                        <p>通过 X 官方接口为已授权账号发布内容。</p>
                      </div>
                      <Badge
                        tone={data.settings.xConfigured ? "green" : "neutral"}
                      >
                        {data.settings.xConfigured ? "已配置" : "未配置"}
                      </Badge>
                    </div>
                    <div className="settings-content">
                      <p>
                        在 X 开发者平台创建应用，配置读写权限，并将凭据填入{" "}
                        <code>.env</code>。
                      </p>
                      <CodeBlock
                        text={
                          "X_CLIENT_ID=你的应用客户端ID\nX_CLIENT_SECRET=你的应用客户端密钥\nX_REDIRECT_URI=http://127.0.0.1:4173/api/x/callback"
                        }
                      />
                      <p className="settings-hint">
                        回调地址需要与 X
                        开发者平台的设置完全一致。配置完成后，前往账号管理连接各个账号。
                      </p>
                      <Button icon={Users} onClick={() => go("accounts")}>
                        前往账号管理
                      </Button>
                    </div>
                  </section>
                  <section className="panel settings-section wide">
                    <div className="settings-section-heading">
                      <span className="settings-symbol">
                        <Icon icon={Monitor} size={23} />
                      </span>
                      <div>
                        <h2>本地工作空间</h2>
                        <p>数据存储在当前设备，浏览器会话按账号独立保存。</p>
                      </div>
                      <Badge tone={fetchError ? "red" : "green"}>
                        {fetchError ? "连接异常" : "运行中"}
                      </Badge>
                    </div>
                    <div className="system-facts">
                      <div>
                        <span>应用版本</span>
                        <strong>Node X {data.version}</strong>
                      </div>
                      <div>
                        <span>浏览器版本</span>
                        <strong>Playwright 安装的 Chromium</strong>
                      </div>
                      <div>
                        <span>网络协议</span>
                        <strong>SOCKS5</strong>
                      </div>
                      <div>
                        <span>内容发布</span>
                        <strong>X OAuth 授权接口</strong>
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </>
          )}
          <footer className="workspace-footer">
            <span>
              Node X<span className="footer-divider" />
              你的本地账号工作空间
            </span>
            <span>所有状态均来自本地服务</span>
          </footer>
        </main>
      </div>
      {modal && (
        <EntityForm
          key={`${modal.type}-${modal.item?.id || "new"}`}
          modal={modal}
          data={data}
          onClose={() => setModal(null)}
          onSubmit={async (path, method, body) => {
            await mutate(
              "form",
              path,
              method,
              body,
              modal.item
                ? "修改已保存"
                : modal.type === "draft"
                  ? "内容已创建"
                  : "配置已添加",
            );
            setModal(null);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={async (result) => {
            await refresh();
            setImporting(false);
            setToast({
              text: `已导入 ${result.imported} 条配置${result.skipped ? `，跳过 ${result.skipped} 条` : ""}`,
            });
          }}
        />
      )}
      {camoufoxOpen && (
        <CamoufoxDialog
          workspace={data}
          data={camoufox}
          loading={camoufoxLoading}
          loadError={camoufoxError}
          onRefresh={refreshCamoufox}
          onWorkspaceChanged={() => refresh()}
          onClose={() => setCamoufoxOpen(false)}
        />
      )}
      {confirmation && (
        <Dialog
          title={confirmation.title}
          onClose={() => !busy && setConfirmation(null)}
        >
          <div className="dialog-body">
            <p className="confirm-description">{confirmation.description}</p>
          </div>
          <div className="dialog-footer">
            <Button disabled={!!busy} onClick={() => setConfirmation(null)}>
              取消
            </Button>
            <Button
              variant={confirmation.destructive ? "danger" : "primary"}
              busy={!!busy}
              onClick={() => void confirmation.action().catch(() => {})}
            >
              {confirmation.label}
            </Button>
          </div>
        </Dialog>
      )}
      {publishing && (
        <PublishDialog
          draft={publishing}
          account={data.accounts.find((a) => a.id === publishing.accountId)}
          onClose={() => setPublishing(null)}
          onSubmit={async (scheduledAt) => {
            await mutate(
              "publish",
              `/api/drafts/${publishing.id}/publish`,
              "POST",
              scheduledAt ? { scheduledAt } : {},
              scheduledAt ? "内容已加入排程" : "内容发布请求已完成",
            );
            setPublishing(null);
          }}
        />
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          <Icon icon={toast.error ? CircleHelp : CheckCircle2} size={19} />
          <span>{toast.text}</span>
          <IconButton
            icon={X}
            label="关闭提示"
            onClick={() => setToast(null)}
          />
        </div>
      )}
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-box">
      <Icon icon={Search} size={17} />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button
          type="button"
          aria-label="清除搜索"
          onClick={() => onChange("")}
        >
          <Icon icon={X} size={14} />
        </button>
      )}
    </label>
  );
}
function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <pre>{text}</pre>
      <button
        type="button"
        aria-label="复制配置示例"
        title={copied ? "已复制" : "复制配置示例"}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        <Icon icon={copied ? Check : Copy} size={16} />
      </button>
    </div>
  );
}

const importByteLimit = 192 * 1024;
const importColumns = [
  "username",
  "account_label",
  "notes",
  "proxy_host",
  "proxy_port",
  "proxy_username",
  "proxy_password",
  "profile_label",
  "locale",
  "timezone",
  "width",
  "height",
];

function CamoufoxDialog({
  workspace,
  data,
  loading,
  loadError,
  onRefresh,
  onWorkspaceChanged,
  onClose,
}: {
  workspace: Workspace;
  data: CamoufoxData | null;
  loading: boolean;
  loadError: string;
  onRefresh: () => Promise<void>;
  onWorkspaceChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"create" | "linked" | "link">("create");
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [accountId, setAccountId] = useState("");
  const [remoteId, setRemoteId] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<CamoufoxResult[]>([]);
  const [lastAction, setLastAction] = useState("");
  const [unlinkId, setUnlinkId] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const links = data?.links || [];
  const ready = !!data?.status.ready && !loadError && !loading;
  const available = !!data?.status.available && !loadError && !loading;
  const occupiedAccounts = new Set(links.map((link) => link.accountId));
  const occupiedRemoteIds = new Set(
    links.map((link) => link.profileId).filter(Boolean),
  );
  const profilesToCreate = workspace.profiles.filter(
    (profile) =>
      !occupiedAccounts.has(profile.accountId) &&
      workspace.proxies.some((proxy) => proxy.id === profile.proxyId),
  );
  const selectableLinks = links.filter((link) => !!link.profileId);
  const unlinkedAccounts = workspace.accounts.filter(
    (account) => !occupiedAccounts.has(account.id),
  );
  const catalog = (data?.catalog || []).filter(
    (profile) => !occupiedRemoteIds.has(profile.id),
  );
  const remote = catalog.find((profile) => profile.id === remoteId);
  const labelForAccount = (id: string) =>
    workspace.accounts.find((account) => account.id === id)?.label ||
    "账号记录已移除";
  const showError = (message: string) => {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  };
  const toggle = (
    id: string,
    selected: string[],
    change: (value: string[]) => void,
    limit?: number,
  ) => {
    setError("");
    if (selected.includes(id)) change(selected.filter((value) => value !== id));
    else if (limit && selected.length >= limit)
      showError(`每次最多选择 ${limit} 个环境，请分批操作。`);
    else change([...selected, id]);
  };
  const updateTab = (next: typeof tab) => {
    setTab(next);
    setError("");
    setResults([]);
    setUnlinkId("");
  };
  const showResults = (next: CamoufoxResult[], action: string) => {
    setResults(next);
    setLastAction(action);
    requestAnimationFrame(() => resultRef.current?.focus());
  };
  const bulk = async (action: "create" | "open" | "close") => {
    const ids = action === "create" ? selectedProfiles : selectedAccounts;
    const limit = action === "create" ? 20 : action === "open" ? 5 : undefined;
    if (!ids.length || pending || (action === "open" ? !ready : !available))
      return;
    if (limit && ids.length > limit)
      return showError(`每次最多选择 ${limit} 个环境，请分批操作。`);
    setPending(action);
    setError("");
    setResults([]);
    try {
      const result = await request(
        `/api/camoufox/${action}`,
        "POST",
        action === "create" ? { profileIds: ids } : { accountIds: ids },
      );
      showResults(result.results, action);
      if (action === "create") setSelectedProfiles([]);
      else setSelectedAccounts([]);
      await Promise.all([onRefresh(), onWorkspaceChanged()]);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setPending("");
    }
  };
  const link = async () => {
    if (!accountId || !remoteId || !available || pending) return;
    setPending("link");
    setError("");
    setResults([]);
    try {
      await request("/api/camoufox/link", "POST", {
        accountId,
        profileId: remoteId,
      });
      showResults(
        [
          {
            id: accountId,
            status: "ok",
            message: "已关联现有 Camoufox 环境。原环境和已保存的会话保持不变。",
          },
        ],
        "link",
      );
      setAccountId("");
      setRemoteId("");
      await Promise.all([onRefresh(), onWorkspaceChanged()]);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setPending("");
    }
  };
  const unlink = async () => {
    if (!unlinkId || pending) return;
    setPending("unlink");
    setError("");
    try {
      await request(
        `/api/camoufox/link/${encodeURIComponent(unlinkId)}`,
        "DELETE",
      );
      showResults(
        [
          {
            id: unlinkId,
            status: "ok",
            message: "已解除本地映射。Camoufox 原环境和会话未删除。",
          },
        ],
        "unlink",
      );
      setSelectedAccounts((selected) =>
        selected.filter((id) => id !== unlinkId),
      );
      setUnlinkId("");
      await onRefresh();
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setPending("");
    }
  };
  return (
    <Dialog
      title="Camoufox 批量管理"
      description="首次打开后手动登录 X，之后重复打开同一个环境以保留会话。"
      onClose={() => !pending && onClose()}
      className="manager-dialog"
    >
      <div className="dialog-body">
        <div
          className="manager-tabs"
          role="tablist"
          aria-label="Camoufox 管理方式"
        >
          {(
            [
              ["create", "批量创建"],
              ["linked", "已关联环境"],
              ["link", "关联现有环境"],
            ] as const
          ).map(([value, title]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={`tab ${tab === value ? "active" : ""}`}
              disabled={!!pending}
              onClick={() => updateTab(value)}
            >
              {title}
              {value === "linked" && <span>{links.length}</span>}
            </button>
          ))}
        </div>
        <div className="manager-connection">
          <Icon icon={Fingerprint} size={21} />
          <div>
            <strong>
              Camoufox Profile Manager{" "}
              <Badge
                tone={
                  loadError ? "red" : data?.status.ready ? "green" : "neutral"
                }
              >
                {loading
                  ? "正在检查"
                  : loadError
                    ? "连接异常"
                    : data?.status.ready
                      ? "已就绪"
                      : "未就绪"}
              </Badge>
            </strong>
            <p>
              {loadError || data?.status.message || "正在读取 Manager 状态…"}
              {data?.status.version
                ? ` 引擎 ${data.status.version}，最低主版本 ${data.status.minimumMajor}。`
                : ""}
            </p>
          </div>
          <Button
            icon={RefreshCw}
            busy={loading}
            disabled={!!pending}
            onClick={() => void onRefresh()}
          >
            刷新状态
          </Button>
        </div>
        {data && !data.status.configured && (
          <div className="form-note">
            <Icon icon={Settings2} size={17} />
            <p>
              请在项目 <code>.env</code> 中填写 Manager 的{" "}
              <code>CAMOUFOX_PORT</code>，如 Manager 启用认证，再填写{" "}
              <code>CAMOUFOX_API_KEY</code>，重启本地服务后刷新。端口需与实际
              Manager 设置一致。
            </p>
          </div>
        )}
        {tab === "create" && (
          <>
            <div className="manager-selection-toolbar">
              <p>
                已选 <strong>{selectedProfiles.length}</strong> 个 ·
                每次最多创建 20 个
              </p>
              <div>
                <button
                  className="text-button"
                  disabled={!!pending || !available || !profilesToCreate.length}
                  onClick={() =>
                    setSelectedProfiles(
                      profilesToCreate
                        .slice(0, 20)
                        .map((profile) => profile.id),
                    )
                  }
                >
                  选择前 20 个可创建环境
                </button>
                <button
                  className="text-button"
                  disabled={!!pending || !selectedProfiles.length}
                  onClick={() => setSelectedProfiles([])}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="manager-table-frame">
              {!workspace.profiles.length ? (
                <Empty
                  icon={Fingerprint}
                  title="先准备本地环境配置"
                  description="关闭此窗口，添加账号、SOCKS5 代理并创建本地环境配置，再批量复制到 Camoufox。"
                />
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <span className="sr-only">选择环境</span>
                        </th>
                        <th>本地环境 / 账号</th>
                        <th>SOCKS5 代理</th>
                        <th>Camoufox 关联</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workspace.profiles.map((profile) => {
                        const proxy = workspace.proxies.find(
                          (item) => item.id === profile.proxyId,
                        );
                        const linked = links.find(
                          (item) => item.accountId === profile.accountId,
                        );
                        const selected = selectedProfiles.includes(profile.id);
                        return (
                          <tr
                            key={profile.id}
                            className={selected ? "selected" : ""}
                          >
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`选择创建 ${profile.label}`}
                                checked={selected}
                                disabled={
                                  !!pending || !available || !!linked || !proxy
                                }
                                onChange={() =>
                                  toggle(
                                    profile.id,
                                    selectedProfiles,
                                    setSelectedProfiles,
                                    20,
                                  )
                                }
                              />
                            </td>
                            <td>
                              <div className="cell-stack">
                                <strong>{profile.label}</strong>
                                <small>
                                  {labelForAccount(profile.accountId)}
                                </small>
                              </div>
                            </td>
                            <td>
                              <div className="cell-stack">
                                <span>{proxy?.label || "缺少代理配置"}</span>
                                <small className="mono">
                                  {proxy
                                    ? `${proxy.host}:${proxy.port}`
                                    : "请先绑定 SOCKS5"}
                                </small>
                              </div>
                            </td>
                            <td>
                              <Badge
                                tone={
                                  linked?.profileId
                                    ? "green"
                                    : linked
                                      ? "red"
                                      : "neutral"
                                }
                              >
                                {linked?.profileId
                                  ? "已关联"
                                  : linked
                                    ? "创建结果待确认"
                                    : "未关联"}
                              </Badge>
                              {linked && !linked.profileId && (
                                <small className="cell-error">
                                  请先在 Manager 中核对创建结果
                                </small>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <p className="manager-hint">
              <Icon icon={CircleHelp} size={15} />
              使用所选环境的账号、SOCKS5
              代理、语言、时区与尺寸创建新环境。创建完成会关联账号，不会自动登录或打开浏览器。创建配置不依赖浏览器引擎，批量打开前需安装符合版本要求的引擎。
            </p>
          </>
        )}
        {tab === "linked" && (
          <>
            <div className="manager-selection-toolbar">
              <p>
                已选 <strong>{selectedAccounts.length}</strong> 个 ·
                每次最多打开 5 个
              </p>
              <div>
                <button
                  className="text-button"
                  disabled={!!pending || !available || !selectableLinks.length}
                  onClick={() =>
                    setSelectedAccounts(
                      selectableLinks.slice(0, 5).map((item) => item.accountId),
                    )
                  }
                >
                  选择前 5 个可用环境
                </button>
                <button
                  className="text-button"
                  disabled={!!pending || !selectedAccounts.length}
                  onClick={() => setSelectedAccounts([])}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="manager-table-frame">
              {!links.length ? (
                <Empty
                  icon={Link2}
                  title="还没有关联的 Camoufox 环境"
                  description="先批量创建环境，或关联 Manager 中已有的 SOCKS5 环境。"
                />
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <span className="sr-only">选择账号</span>
                        </th>
                        <th>账号 / Camoufox 环境</th>
                        <th>代理出口</th>
                        <th>运行状态</th>
                        <th className="align-right">本地映射</th>
                      </tr>
                    </thead>
                    <tbody>
                      {links.map((item) => (
                        <tr
                          key={item.accountId}
                          className={
                            selectedAccounts.includes(item.accountId)
                              ? "selected"
                              : ""
                          }
                        >
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`选择打开 ${labelForAccount(item.accountId)}`}
                              checked={selectedAccounts.includes(
                                item.accountId,
                              )}
                              disabled={
                                !!pending || !available || !item.profileId
                              }
                              onChange={() =>
                                toggle(
                                  item.accountId,
                                  selectedAccounts,
                                  setSelectedAccounts,
                                  5,
                                )
                              }
                            />
                          </td>
                          <td>
                            <div className="cell-stack">
                              <strong>{labelForAccount(item.accountId)}</strong>
                              <small>
                                {item.name}
                                {!item.profileId ? " · 创建结果待确认" : ""}
                              </small>
                            </div>
                          </td>
                          <td>
                            <span className="mono">
                              {item.proxyAddress || "待读取"}
                            </span>
                          </td>
                          <td>
                            <Badge
                              tone={
                                !item.profileId
                                  ? "red"
                                  : item.running === true
                                    ? "green"
                                    : "neutral"
                              }
                            >
                              {!item.profileId
                                ? "待核对"
                                : item.running === true
                                  ? "运行中"
                                  : item.running === false
                                    ? "未启动"
                                    : "状态未知"}
                            </Badge>
                          </td>
                          <td className="align-right">
                            <button
                              className="text-button"
                              disabled={!!pending || !item.profileId}
                              onClick={() => {
                                setUnlinkId(item.accountId);
                                setError("");
                              }}
                            >
                              解除关联
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {unlinkId && (
              <div className="manager-unlink-confirm">
                <p>
                  解除“{labelForAccount(unlinkId)}”的本地映射？Camoufox
                  环境和会话会保留。
                </p>
                <div>
                  <Button disabled={!!pending} onClick={() => setUnlinkId("")}>
                    保留关联
                  </Button>
                  <Button
                    variant="danger"
                    busy={pending === "unlink"}
                    disabled={!!pending}
                    onClick={() => void unlink()}
                  >
                    确认解除
                  </Button>
                </div>
              </div>
            )}
            <p className="manager-hint">
              <Icon icon={ShieldCheck} size={15} />
              浏览器窗口会出现在运行 Manager
              的主机上。首次登录请手动完成；之后使用“批量打开”复用同一环境。解除关联仅删除
              Node X 的映射，不修改或删除远程环境。
            </p>
            {links.some((item) => !item.profileId) && (
              <p className="manager-hint">
                <Icon icon={CircleHelp} size={15} />
                存在创建结果待确认的记录。请先到 Manager
                核对，核对前无法打开、解除关联或再次创建，以避免重复环境。
              </p>
            )}
          </>
        )}
        {tab === "link" && (
          <div className="manager-link-form">
            <div className="form-grid">
              <Field label="Node X 账号">
                <select
                  aria-label="要关联的 Node X 账号"
                  value={accountId}
                  disabled={!!pending || !available}
                  onChange={(event) => {
                    setAccountId(event.target.value);
                    setResults([]);
                    setError("");
                  }}
                >
                  <option value="">选择尚未关联的账号</option>
                  {unlinkedAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                      {account.username
                        ? ` (@${account.username.replace(/^@/, "")})`
                        : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="已有 Camoufox 环境">
                <select
                  aria-label="已有 Camoufox 环境"
                  value={remoteId}
                  disabled={!!pending || !available}
                  onChange={(event) => {
                    setRemoteId(event.target.value);
                    setResults([]);
                    setError("");
                  }}
                >
                  <option value="">选择未关联的 SOCKS5 环境</option>
                  {catalog.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {remote && (
              <div className="manager-link-summary">
                <Icon icon={Fingerprint} size={23} />
                <div>
                  <strong>{remote.name}</strong>
                  <small>SOCKS5 {remote.proxyAddress}</small>
                </div>
                <Badge tone={remote.running ? "green" : "neutral"}>
                  {remote.running === true
                    ? "运行中"
                    : remote.running === false
                      ? "未启动"
                      : "状态未知"}
                </Badge>
              </div>
            )}
            <div className="form-note">
              <Icon icon={ShieldCheck} size={17} />
              <p>
                仅建立账号与现有环境的映射，不复制文件、不修改环境设置或登录会话。已登录的环境将继续使用原会话，登录是否有效以
                X 页面为准。
              </p>
            </div>
            {data?.status.available &&
              (!catalog.length || !unlinkedAccounts.length) && (
                <p className="manager-hint">
                  <Icon icon={CircleHelp} size={15} />
                  {!unlinkedAccounts.length
                    ? "所有账号均已关联，或尚未添加 Node X 账号。"
                    : "没有可关联的 SOCKS5 环境。请在 Manager 中配置环境后刷新。"}
                </p>
              )}
          </div>
        )}
        {error && (
          <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
            <Icon icon={CircleHelp} size={16} />
            {error}
          </p>
        )}
        {results.length > 0 && (
          <div className="manager-results" tabIndex={-1} ref={resultRef}>
            <div className="manager-results-heading">
              <span>
                {lastAction === "create"
                  ? "批量创建"
                  : lastAction === "open"
                    ? "批量打开"
                    : lastAction === "close"
                      ? "批量关闭"
                      : lastAction === "unlink"
                        ? "解除关联"
                        : "关联环境"}
                结果
              </span>
              <span>
                {results.filter((item) => item.status === "ok").length} 成功 ·{" "}
                {results.filter((item) => item.status === "skipped").length}{" "}
                跳过 ·{" "}
                {results.filter((item) => item.status === "error").length} 失败
              </span>
            </div>
            {results.map((item, index) => (
              <div
                className={`manager-result ${item.status === "error" ? "is-error" : ""}`}
                key={`${item.id}-${index}`}
              >
                <Icon
                  icon={
                    item.status === "ok"
                      ? CheckCircle2
                      : item.status === "error"
                        ? CircleHelp
                        : Clock3
                  }
                  size={17}
                />
                <div>
                  <strong>
                    {lastAction === "create"
                      ? workspace.profiles.find(
                          (profile) => profile.id === item.id,
                        )?.label || "环境配置"
                      : labelForAccount(item.id)}
                  </strong>
                  <p>{item.message}</p>
                </div>
                <Badge
                  tone={
                    item.status === "ok"
                      ? "green"
                      : item.status === "error"
                        ? "red"
                        : "neutral"
                  }
                >
                  {item.status === "ok"
                    ? "成功"
                    : item.status === "error"
                      ? "失败"
                      : "跳过"}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="dialog-footer">
        <Button disabled={!!pending} onClick={onClose}>
          完成
        </Button>
        <div>
          {tab === "create" ? (
            <Button
              variant="primary"
              icon={Plus}
              busy={pending === "create"}
              disabled={
                !!pending ||
                !available ||
                !selectedProfiles.length ||
                selectedProfiles.length > 20
              }
              onClick={() => void bulk("create")}
            >
              创建所选环境
              {selectedProfiles.length ? ` (${selectedProfiles.length})` : ""}
            </Button>
          ) : tab === "linked" ? (
            <>
              <Button
                icon={Square}
                busy={pending === "close"}
                disabled={!!pending || !available || !selectedAccounts.length}
                onClick={() => void bulk("close")}
              >
                批量关闭
              </Button>
              <Button
                variant="primary"
                icon={Play}
                busy={pending === "open"}
                disabled={
                  !!pending ||
                  !ready ||
                  !selectedAccounts.length ||
                  selectedAccounts.length > 5
                }
                onClick={() => void bulk("open")}
              >
                批量打开
                {selectedAccounts.length ? ` (${selectedAccounts.length})` : ""}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon={Link2}
              busy={pending === "link"}
              disabled={!!pending || !available || !accountId || !remoteId}
              onClick={() => void link()}
            >
              关联现有环境
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (result: { imported: number; skipped: number }) => Promise<void>;
}) {
  const [format, setFormat] = useState<ImportFormat>("nodex");
  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"" | "preview" | "commit" | "file">(
    "",
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const bytes = new TextEncoder().encode(csv).byteLength;
  const canCommit = !!preview && preview.ready > 0 && preview.errors === 0;
  const invalidate = () => {
    setPreview(null);
    setError("");
  };
  const showError = (message: string) => {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  };
  const downloadTemplate = () => {
    const blob = new Blob(["\uFEFF", importColumns.join(","), "\r\n"], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "node-x-import-template.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const checkInput = () => {
    if (!csv.trim())
      throw new Error("请粘贴 CSV 内容，或选择一个 UTF-8 CSV 文件。");
    if (bytes > importByteLimit)
      throw new Error("CSV 超过 192 KiB，请缩小文件后重试。");
  };
  const inspect = async () => {
    setError("");
    setPreview(null);
    try {
      checkInput();
      setPending("preview");
      const result = (await request("/api/import/preview", "POST", {
        format,
        csv,
      })) as ImportPreview;
      setPreview(result);
      requestAnimationFrame(() => previewRef.current?.focus());
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setPending("");
    }
  };
  const commit = async () => {
    if (!canCommit || pending) return;
    setError("");
    setPending("commit");
    try {
      checkInput();
      const result = await request("/api/import/commit", "POST", {
        format,
        csv,
      });
      setCsv("");
      setPreview(null);
      await onImported(result);
    } catch (err) {
      showError((err as Error).message);
      setPreview(null);
    } finally {
      setPending("");
    }
  };
  return (
    <Dialog
      title="批量导入配置"
      description="一次添加账号、SOCKS5 代理和浏览器环境，先检查，再导入。"
      onClose={() => !pending && onClose()}
      className="import-dialog"
    >
      <div className="dialog-body">
        <Field label="CSV 来源格式">
          <select
            autoFocus
            aria-label="CSV 来源格式"
            value={format}
            disabled={!!pending}
            onChange={(event) => {
              setFormat(event.target.value as ImportFormat);
              invalidate();
            }}
          >
            <option value="nodex">Node X 导入模板</option>
            <option value="camoufox">Camoufox Profile Manager 导出表</option>
          </select>
        </Field>
        {format === "nodex" ? (
          <div className="import-format-note">
            <div>
              <strong>使用统一的 CSV 表头</strong>
              <p>
                下载模板，在表头下填写 X
                用户名、代理和环境设置。代理密码列可留空。
              </p>
            </div>
            <Button
              icon={Download}
              onClick={downloadTemplate}
              disabled={!!pending}
            >
              下载模板
            </Button>
            <details className="import-columns">
              <summary>查看模板字段</summary>
              <code>{importColumns.join(", ")}</code>
            </details>
          </div>
        ) : (
          <div className="import-format-note camoufox-note">
            <strong>迁移环境设置</strong>
            <p>
              将 Camoufox Profile Manager 导出的工作簿另存为 UTF-8 CSV，新增
              <code>X username</code> 列，并为每一行填写对应的 X 用户名。
            </p>
            <p>
              仅导入账号标识、环境名称、SOCKS5 代理、语言、时区和窗口尺寸。
              不导入登录密码、Cookie、令牌或浏览器会话，也不会连接或启动
              Camoufox。
            </p>
            <details className="import-columns">
              <summary>查看迁移字段与重复处理</summary>
              <dl className="import-mapping">
                <div>
                  <dt>X username</dt>
                  <dd>账号用户名（需手动新增）</dd>
                </div>
                <div>
                  <dt>Profile name / Notes</dt>
                  <dd>环境名称 / 备注</dd>
                </div>
                <div>
                  <dt>Proxy type / Proxy server</dt>
                  <dd>SOCKS5 类型 / 代理主机与端口</dd>
                </div>
                <div>
                  <dt>Proxy username / Proxy password</dt>
                  <dd>代理认证信息，仅导入后端配置</dd>
                </div>
                <div>
                  <dt>Browser languages / Locale</dt>
                  <dd>浏览器语言 / 地区设置</dd>
                </div>
                <div>
                  <dt>Timezone</dt>
                  <dd>时区</dd>
                </div>
                <div>
                  <dt>Window width / Window height</dt>
                  <dd>窗口宽度 / 高度</dd>
                </div>
              </dl>
              <p>
                其他列忽略。已有环境的用户名会跳过并保留原绑定；已有账号没有环境时会补齐配置。CSV
                内重复用户名需要修正。
              </p>
            </details>
          </div>
        )}
        <div className="import-input-heading">
          <span id="import-csv-label">CSV 内容</span>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              tabIndex={-1}
              aria-label="选择 UTF-8 CSV 文件"
              disabled={!!pending}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                invalidate();
                if (file.size > importByteLimit) {
                  showError("CSV 文件超过 192 KiB，请缩小文件后重试。");
                  return;
                }
                setPending("file");
                try {
                  const content = new TextDecoder("utf-8", {
                    fatal: true,
                  }).decode(await file.arrayBuffer());
                  setCsv(content);
                  setFilename(file.name);
                } catch {
                  showError(
                    "无法读取这个 UTF-8 CSV 文件，请重新保存为 UTF-8 编码后上传。",
                  );
                } finally {
                  setPending("");
                }
              }}
            />
            {filename && (
              <span className="import-filename" title={filename}>
                {filename}
              </span>
            )}
            <Button
              icon={Upload}
              busy={pending === "file"}
              disabled={!!pending}
              onClick={() => fileRef.current?.click()}
            >
              选择 CSV 文件
            </Button>
          </div>
        </div>
        <textarea
          className="import-textarea"
          aria-labelledby="import-csv-label"
          aria-describedby="import-csv-hint"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          rows={7}
          placeholder={
            format === "nodex"
              ? `${importColumns.join(",")}\n在表头下填写数据，或上传 CSV 文件`
              : "在这里粘贴另存为 CSV 后的表头和数据，包含 X username 列"
          }
          value={csv}
          disabled={!!pending}
          onChange={(event) => {
            setCsv(event.target.value);
            setFilename("");
            invalidate();
          }}
        />
        <div className="import-input-meta" id="import-csv-hint">
          <span>UTF-8 编码 · 最多 100 条 · 上限 192 KiB</span>
          <span className={bytes > importByteLimit ? "import-over-limit" : ""}>
            {(bytes / 1024).toFixed(1)} / 192 KiB
          </span>
        </div>
        <p className="import-privacy">
          <Icon icon={ShieldCheck} size={14} />
          原始 CSV
          仅用于本次检查与导入，不保存在浏览器存储中。预览不显示代理密码。
        </p>
        {error && (
          <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
            <Icon icon={CircleHelp} size={16} />
            {error}
          </p>
        )}
        {preview && (
          <div className="import-preview" ref={previewRef} tabIndex={-1}>
            <div className="import-preview-heading">
              <h3>导入预览</h3>
              <div aria-live="polite">
                <Badge tone="green">可导入 {preview.ready}</Badge>
                <Badge>跳过 {preview.skipped}</Badge>
                <Badge tone={preview.errors ? "red" : "neutral"}>
                  错误 {preview.errors}
                </Badge>
              </div>
            </div>
            <div className="table-scroll">
              <table className="import-preview-table">
                <thead>
                  <tr>
                    <th>CSV 行</th>
                    <th>账号</th>
                    <th>环境 / 代理</th>
                    <th>语言 / 时区</th>
                    <th>检查结果</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => (
                    <tr key={`${row.row}-${index}`}>
                      <td>{row.row}</td>
                      <td>
                        <div className="cell-stack">
                          <strong>{row.accountLabel || "—"}</strong>
                          <small>
                            {row.username
                              ? `@${row.username.replace(/^@/, "")}`
                              : "未填写用户名"}
                          </small>
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span>{row.profileLabel || "—"}</span>
                          <small className="mono">
                            {row.proxyAddress || "未填写代理"}
                          </small>
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span>{row.locale || "—"}</span>
                          <small>{row.timezone || "—"}</small>
                        </div>
                      </td>
                      <td>
                        <Badge
                          tone={
                            row.status === "ready"
                              ? "green"
                              : row.status === "error"
                                ? "red"
                                : "neutral"
                          }
                        >
                          {row.status === "ready"
                            ? "可导入"
                            : row.status === "error"
                              ? "需要修正"
                              : "跳过"}
                        </Badge>
                        {row.message && (
                          <p
                            className={`import-row-message ${row.status === "error" ? "is-error" : ""}`}
                          >
                            {row.message}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="import-result-hint">
              {preview.errors
                ? "请根据行号修正 CSV 中的问题，再重新检查。存在错误时无法导入。"
                : preview.ready
                  ? `确认后将导入 ${preview.ready} 条配置${preview.skipped ? `，跳过 ${preview.skipped} 条` : ""}。导入后可逐个检查代理并打开环境。`
                  : "没有可导入的新配置。请调整 CSV 后重新检查。"}
            </p>
          </div>
        )}
      </div>
      <div className="dialog-footer">
        <Button disabled={!!pending} onClick={onClose}>
          取消
        </Button>
        <div>
          <Button
            icon={Search}
            busy={pending === "preview"}
            disabled={!!pending || !csv.trim() || bytes > importByteLimit}
            onClick={() => void inspect()}
          >
            {preview ? "重新检查" : "检查并预览"}
          </Button>
          <Button
            variant="primary"
            icon={Upload}
            busy={pending === "commit"}
            disabled={!!pending || !canCommit}
            onClick={() => void commit()}
          >
            确认导入{preview?.ready ? ` ${preview.ready} 条` : ""}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function EntityForm({
  modal,
  data,
  onClose,
  onSubmit,
}: {
  modal: EntityModal;
  data: Workspace;
  onClose: () => void;
  onSubmit: (path: string, method: string, body: unknown) => Promise<void>;
}) {
  const item = modal.item;
  const defaults =
    modal.type === "account"
      ? { label: "", username: "", notes: "", ...item }
      : modal.type === "proxy"
        ? {
            label: "",
            host: "",
            port: 1080,
            username: "",
            password: "",
            ...item,
          }
        : modal.type === "profile"
          ? {
              label: "",
              accountId:
                data.accounts.find(
                  (a) => !data.profiles.some((p) => p.accountId === a.id),
                )?.id || "",
              proxyId: data.proxies[0]?.id || "",
              locale: "zh-CN",
              timezone: "Asia/Shanghai",
              width: 1440,
              height: 900,
              ...item,
            }
          : {
              accountId: data.accounts[0]?.id || "",
              prompt: "",
              text: "",
              ...item,
            };
  const [values, setValues] = useState<Record<string, any>>(defaults);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const update = (key: string, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const edit = !!item;
  const titles = {
    account: "账号",
    proxy: "代理",
    profile: "浏览器环境",
    draft: "内容",
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const action =
      ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement)
        ?.value || "save";
    setError("");
    setPending(action);
    try {
      let body: Record<string, unknown>;
      let path = `/api/${{ account: "accounts", proxy: "proxies", profile: "profiles", draft: "drafts" }[modal.type]}${item ? `/${item.id}` : ""}`;
      if (modal.type === "account")
        body = {
          label: values.label.trim(),
          username: values.username.trim(),
          notes: values.notes.trim(),
        };
      else if (modal.type === "proxy") {
        body = {
          label: values.label.trim(),
          host: values.host.trim(),
          port: Number(values.port),
          username: values.username.trim(),
        };
        if (!edit || values.password || clearPassword)
          body.password = clearPassword ? "" : values.password;
      } else if (modal.type === "profile")
        body = {
          label: values.label.trim(),
          accountId: values.accountId,
          proxyId: values.proxyId,
          locale: values.locale.trim(),
          timezone: values.timezone.trim(),
          width: Number(values.width),
          height: Number(values.height),
        };
      else {
        body = edit
          ? { text: values.text }
          : {
              accountId: values.accountId,
              prompt: values.prompt.trim(),
              text: values.text,
            };
        if (action === "generate") path = "/api/drafts/generate";
      }
      await onSubmit(path, edit ? "PATCH" : "POST", body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending("");
    }
  };
  return (
    <Dialog
      title={`${edit ? "编辑" : "新建"}${titles[modal.type]}`}
      description={
        modal.type === "draft"
          ? "为账号准备一篇内容，保存后可继续编辑。"
          : "配置将保存在当前设备的本地工作空间。"
      }
      onClose={() => !pending && onClose()}
      className={modal.type === "draft" ? "dialog-wide" : ""}
    >
      <form onSubmit={submit}>
        <div className="dialog-body">
          {modal.type === "account" && (
            <>
              <Field label="账号名称">
                <input
                  autoFocus
                  required
                  maxLength={80}
                  placeholder="例如：产品官方账号"
                  value={values.label}
                  onChange={(e) => update("label", e.target.value)}
                />
              </Field>
              <Field
                label="X 用户名"
                hint="可留空。授权时会核对已填写的用户名。"
              >
                <div className="input-prefix">
                  <span>@</span>
                  <input
                    autoComplete="off"
                    placeholder="username"
                    value={values.username}
                    onChange={(e) =>
                      update("username", e.target.value.replace(/^@/, ""))
                    }
                  />
                </div>
              </Field>
              <Field label="备注">
                <textarea
                  rows={3}
                  placeholder="账号用途、内容方向或其他说明"
                  value={values.notes}
                  onChange={(e) => update("notes", e.target.value)}
                />
              </Field>
              <div className="form-note">
                <Icon icon={ShieldCheck} size={17} />
                <p>
                  此处记录账号信息。登录请在独立浏览器环境中完成，发布权限通过 X
                  授权连接。
                </p>
              </div>
            </>
          )}
          {modal.type === "proxy" && (
            <>
              <Field label="代理名称">
                <input
                  autoFocus
                  required
                  placeholder="例如：工作出口 01"
                  maxLength={80}
                  value={values.label}
                  onChange={(e) => update("label", e.target.value)}
                />
              </Field>
              <div className="form-grid host-grid">
                <Field
                  label="SOCKS5 主机"
                  hint="填写主机或 IP，不包含 socks5://。"
                >
                  <input
                    required
                    placeholder="127.0.0.1"
                    value={values.host}
                    onChange={(e) => update("host", e.target.value)}
                  />
                </Field>
                <Field label="端口">
                  <input
                    required
                    type="number"
                    min="1"
                    max="65535"
                    value={values.port}
                    onChange={(e) => update("port", e.target.value)}
                  />
                </Field>
              </div>
              <div className="form-divider">
                身份认证<span>可选</span>
              </div>
              <div className="form-grid">
                <Field label="用户名">
                  <input
                    autoComplete="off"
                    placeholder="代理用户名"
                    value={values.username}
                    onChange={(e) => update("username", e.target.value)}
                  />
                </Field>
                <Field
                  label="密码"
                  hint={
                    edit && (item as Proxy).hasPassword
                      ? "留空保留现有密码"
                      : undefined
                  }
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      edit && (item as Proxy).hasPassword
                        ? "已设置密码"
                        : "代理密码"
                    }
                    value={values.password}
                    disabled={clearPassword}
                    onChange={(e) => update("password", e.target.value)}
                  />
                </Field>
              </div>
              {edit && (item as Proxy).hasPassword && (
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={clearPassword}
                    onChange={(e) => setClearPassword(e.target.checked)}
                  />
                  清除已保存的密码
                </label>
              )}
              <div className="form-note">
                <Icon icon={Network} size={17} />
                <p>保存后可进行连接检查，验证实际出口 IP 和延迟。</p>
              </div>
            </>
          )}
          {modal.type === "profile" && (
            <>
              <Field label="环境名称">
                <input
                  autoFocus
                  required
                  placeholder="例如：产品账号工作环境"
                  maxLength={80}
                  value={values.label}
                  onChange={(e) => update("label", e.target.value)}
                />
              </Field>
              <Field label="关联账号" hint="每个账号使用一个独立的浏览器环境。">
                <select
                  required
                  value={values.accountId}
                  onChange={(e) => update("accountId", e.target.value)}
                >
                  <option value="">选择账号</option>
                  {data.accounts
                    .filter(
                      (a) =>
                        a.id === (item as Profile)?.accountId ||
                        !data.profiles.some((p) => p.accountId === a.id),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                        {a.username
                          ? ` (@${a.username.replace(/^@/, "")})`
                          : ""}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="SOCKS5 代理">
                <select
                  required
                  value={values.proxyId}
                  onChange={(e) => update("proxyId", e.target.value)}
                >
                  <option value="">选择代理</option>
                  {data.proxies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} · {p.host}:{p.port}
                      {p.status === "ok" ? "（已检查）" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="form-grid">
                <Field label="语言">
                  <input
                    required
                    list="profile-locale-options"
                    value={values.locale}
                    onChange={(e) => update("locale", e.target.value)}
                  />
                </Field>
                <datalist id="profile-locale-options">
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">英语（美国）</option>
                  <option value="en-GB">英语（英国）</option>
                  <option value="zh-TW">繁体中文</option>
                  <option value="ja-JP">日语</option>
                </datalist>
                <Field label="时区">
                  <input
                    required
                    list="profile-timezone-options"
                    value={values.timezone}
                    onChange={(e) => update("timezone", e.target.value)}
                  />
                </Field>
                <datalist id="profile-timezone-options">
                  {[
                    "Asia/Shanghai",
                    "Asia/Hong_Kong",
                    "Asia/Tokyo",
                    "Asia/Singapore",
                    "America/New_York",
                    "America/Los_Angeles",
                    "Europe/London",
                    "UTC",
                  ].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </datalist>
              </div>
              <div className="form-grid">
                <Field label="窗口宽度">
                  <input
                    required
                    type="number"
                    min="320"
                    max="3840"
                    value={values.width}
                    onChange={(e) => update("width", e.target.value)}
                  />
                </Field>
                <Field label="窗口高度">
                  <input
                    required
                    type="number"
                    min="320"
                    max="2160"
                    value={values.height}
                    onChange={(e) => update("height", e.target.value)}
                  />
                </Field>
              </div>
              <div className="form-note">
                <Icon icon={Monitor} size={17} />
                <p>
                  使用 Playwright 安装的 Chromium
                  及其真实浏览器信息。语言、时区和窗口设置会在下次启动时生效。
                </p>
              </div>
            </>
          )}
          {modal.type === "draft" && (
            <>
              <Field label="目标账号">
                <select
                  required
                  disabled={edit}
                  value={values.accountId}
                  onChange={(e) => update("accountId", e.target.value)}
                >
                  {data.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                      {a.xConnected ? "（已授权）" : "（未授权）"}
                    </option>
                  ))}
                </select>
              </Field>
              {!edit && (
                <Field
                  label="给 AI 的创作要求"
                  hint="描述话题、语气和关键信息；也可以直接在下方手写正文。"
                >
                  <textarea
                    rows={3}
                    placeholder="例如：为新上线的项目写一篇简洁的介绍，语气自然，面向开发者。"
                    value={values.prompt}
                    onChange={(e) => update("prompt", e.target.value)}
                  />
                </Field>
              )}
              <Field label="正文">
                <textarea
                  autoFocus={edit}
                  className="composer-textarea"
                  rows={edit ? 10 : 6}
                  placeholder="在这里写下你的内容…"
                  value={values.text}
                  onChange={(e) => update("text", e.target.value)}
                />
                <span className="character-count">
                  {Array.from(values.text || "").length} 字符
                </span>
              </Field>
              {!edit && !data.settings.aiConfigured && (
                <div className="form-note">
                  <Icon icon={Sparkles} size={17} />
                  <p>当前未配置 AI 模型，你可以先手动编写并保存草稿。</p>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              <Icon icon={CircleHelp} size={16} />
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={!!pending} onClick={onClose}>
            取消
          </Button>
          <div>
            {modal.type === "draft" && !edit && (
              <Button
                type="submit"
                name="action"
                value="generate"
                icon={Sparkles}
                busy={pending === "generate"}
                disabled={
                  !!pending ||
                  !data.settings.aiConfigured ||
                  !values.prompt.trim()
                }
              >
                AI 生成草稿
              </Button>
            )}
            <Button
              type="submit"
              value="save"
              variant="primary"
              busy={pending === "save"}
              disabled={!!pending}
            >
              {modal.type === "draft" ? "保存草稿" : edit ? "保存修改" : "添加"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function PublishDialog({
  draft,
  account,
  onClose,
  onSubmit,
}: {
  draft: Draft;
  account?: Account;
  onClose: () => void;
  onSubmit: (scheduledAt?: string) => Promise<void>;
}) {
  const [mode, setMode] = useState("now");
  const [time, setTime] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      title="确认发布内容"
      description="请核对目标账号与正文，确认后将通过 X 接口发布。"
      onClose={() => !pending && onClose()}
      className="dialog-wide"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (mode === "later" && new Date(time).getTime() <= Date.now()) {
            setError("请选择未来的发布时间。");
            return;
          }
          setPending(true);
          setError("");
          try {
            await onSubmit(
              mode === "later" ? new Date(time).toISOString() : undefined,
            );
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="dialog-body">
          <div className="publish-account">
            <span className="avatar">{account?.label.slice(0, 1)}</span>
            <div>
              <strong>{account?.label}</strong>
              <span>
                @
                {(account?.xUsername || account?.username || "").replace(
                  /^@/,
                  "",
                )}
              </span>
            </div>
            <Badge tone="green">已授权 X</Badge>
          </div>
          <div className="publish-preview">{draft.text}</div>
          <div className="publish-mode">
            <label>
              <input
                type="radio"
                name="publish-mode"
                checked={mode === "now"}
                onChange={() => setMode("now")}
              />
              立即发布
            </label>
            <label>
              <input
                type="radio"
                name="publish-mode"
                checked={mode === "later"}
                onChange={() => setMode("later")}
              />
              定时发布
            </label>
          </div>
          {mode === "later" && (
            <Field
              label="发布时间"
              hint="使用当前设备时区。排程期间需要保持本地服务运行。"
            >
              <input
                type="datetime-local"
                required
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </Field>
          )}
          <label className="checkbox-field confirmation-check">
            <input
              type="checkbox"
              required
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              我已核对目标账号和正文，确认{mode === "later" ? "按计划" : "立即"}
              发布这篇内容。
            </span>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onClose} disabled={pending}>
            返回编辑
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon={mode === "later" ? Clock3 : Send}
            disabled={!confirmed}
            busy={pending}
          >
            {mode === "later" ? "确认排程" : "确认发布"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type LoginHistoryEntry = { suffix: string; usedAt: number };

const loginHistoryKey = "nodex:login-history";
const loginHistoryLimit = 8;
const loginHistoryDate = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "short",
});

function loadLoginHistory(): LoginHistoryEntry[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(loginHistoryKey) || "[]");
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (entry): entry is LoginHistoryEntry =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.suffix === "string" &&
          /^[A-Za-z0-9_-]{4}$/.test(entry.suffix) &&
          Number.isSafeInteger(entry.usedAt) &&
          entry.usedAt > 0 &&
          entry.usedAt <= Date.now() + 60_000,
      )
      .slice(0, loginHistoryLimit)
      .map(({ suffix, usedAt }) => ({ suffix, usedAt }));
  } catch {
    return [];
  }
}

function saveLoginHistory(history: LoginHistoryEntry[]): void {
  try {
    if (history.length) localStorage.setItem(loginHistoryKey, JSON.stringify(history));
    else localStorage.removeItem(loginHistoryKey);
  } catch {
    // Browsers can block local storage. The sign-in session still works.
  }
}

function AuthGate() {
  const [state, setState] = useState<
    "checking" | "authenticated" | "anonymous" | "error"
  >("checking");
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(false);
  const [loginHistory, setLoginHistory] = useState(loadLoginHistory);
  const [historyIndex, setHistoryIndex] = useState("");
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const sequence = useRef(0);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const check = async () => {
    const current = ++sequence.current;
    setChecking(true);
    try {
      const response = await fetch("/api/auth/status", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "无法检查登录状态，请重试。");
      if (current === sequence.current) {
        setState(result.authenticated ? "authenticated" : "anonymous");
        setError("");
      }
    } catch (err) {
      if (current === sequence.current) {
        setState((previous) =>
          previous === "authenticated" ? previous : "error",
        );
        setError((err as Error).message);
      }
    } finally {
      if (current === sequence.current) setChecking(false);
    }
  };
  useEffect(() => {
    void check();
    const expired = () => {
      sequence.current++;
      setState("anonymous");
      setCode("");
      setError("登录已过期，请输入新的登录码。");
      setChecking(false);
    };
    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, 20000);
    window.addEventListener("nodex:auth-expired", expired);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      sequence.current++;
      window.removeEventListener("nodex:auth-expired", expired);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const logout = async () => {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
    });
    if (!response.ok && response.status !== 401) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "退出失败，请重试。");
    }
    sequence.current++;
    setState("anonymous");
    setCode("");
    setError("");
  };
  if (state === "authenticated") return <App onLogout={logout} />;
  return (
    <div className="access-shell">
      <header className="access-header">
        <a href="/" className="access-brand">
          Node X<span>工作空间</span>
        </a>
        <span className="access-header-note">登录入口</span>
      </header>
      <main className="access-main">
        <section className="access-card">
          <div className="access-symbol">
            <Icon icon={ShieldCheck} size={27} />
          </div>
          <h1>登录工作空间</h1>
          <p className="access-description">
            输入管理员提供的登录码，继续使用 Node X。
          </p>
          {state === "checking" ? (
            <div className="access-loading" role="status">
              <Icon icon={LoaderCircle} className="spin" size={22} />
              <span>正在检查登录状态…</span>
            </div>
          ) : state === "error" ? (
            <>
              <p className="form-error" role="alert">
                {error}
              </p>
              <Button
                variant="primary"
                icon={RefreshCw}
                busy={checking}
                className="access-submit"
                onClick={() => void check()}
              >
                重新连接
              </Button>
            </>
          ) : (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (!code.trim() || pending) return;
                setPending(true);
                setError("");
                try {
                  const response = await fetch("/api/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: JSON.stringify({ code: code.trim(), remember }),
                  });
                  const result = await response.json().catch(() => ({}));
                  if (!response.ok)
                    throw new Error(
                      result.error || "登录失败，请检查登录码后重试。",
                    );
                  if (remember) {
                    const history = [
                      { suffix: code.trim().slice(-4), usedAt: Date.now() },
                      ...loadLoginHistory(),
                    ].slice(0, loginHistoryLimit);
                    saveLoginHistory(history);
                    setLoginHistory(history);
                    setHistoryIndex("");
                  }
                  setCode("");
                  await check();
                } catch (err) {
                  setError((err as Error).message);
                  requestAnimationFrame(() => errorRef.current?.focus());
                } finally {
                  setPending(false);
                }
              }}
            >
              <Field label="登录码">
                <input
                  autoFocus
                  required
                  type="password"
                  autoComplete="one-time-code"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="粘贴登录码"
                  value={code}
                  disabled={pending}
                  aria-invalid={!!error}
                  aria-describedby={error ? "access-error" : undefined}
                  onChange={(event) => {
                    setCode(event.target.value);
                    setError("");
                  }}
                />
              </Field>
              <label className="checkbox-field access-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={pending}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span>在此浏览器记住登录（7 天）</span>
              </label>
              {error && (
                <p
                  id="access-error"
                  ref={errorRef}
                  tabIndex={-1}
                  className="form-error"
                  role="alert"
                >
                  <Icon icon={CircleHelp} size={16} />
                  {error}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                icon={ArrowRight}
                className="access-submit"
                disabled={!code.trim()}
                busy={pending}
              >
                进入工作空间
              </Button>
              <div className="access-history">
                <Field label="历史登录码">
                  <select
                    value={historyIndex}
                    disabled={!loginHistory.length || pending}
                    onChange={(event) => setHistoryIndex(event.target.value)}
                  >
                    <option value="">
                      {loginHistory.length ? "选择一条历史记录" : "暂无历史记录"}
                    </option>
                    {loginHistory.map(({ suffix, usedAt }, index) => (
                      <option key={`${usedAt}-${suffix}-${index}`} value={index}>
                        NX-••••{suffix} · {loginHistoryDate.format(usedAt)}
                      </option>
                    ))}
                  </select>
                </Field>
                {loginHistory.length > 0 && (
                  <div className="access-history-actions">
                    <span aria-live="polite">
                      {historyIndex === ""
                        ? "仅保留已使用登录码的末四位。"
                        : "这枚登录码已使用，请输入新码。"}
                    </span>
                    <button
                      className="text-button"
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        saveLoginHistory([]);
                        setLoginHistory([]);
                        setHistoryIndex("");
                      }}
                    >
                      清除历史
                    </button>
                  </div>
                )}
              </div>
            </form>
          )}
        </section>
        <p className="access-footer">
          Node X<span />
          账号与浏览器环境管理
        </p>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.pathname.replace(/\/+$/, "") === "/operator" ? (
      <OperatorApp />
    ) : (
      <AuthGate />
    )}
  </React.StrictMode>,
);
