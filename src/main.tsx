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
  Shuffle,
  Sparkles,
  Square,
  Trash2,
  Unplug,
  Upload,
  Users,
  X,
} from "lucide-react";
import OperatorApp from "./operator";
import { BrowserView } from "./browser-view";
import {
  browserLanguages,
  browserRegions,
  browserTimezones,
  randomBrowserRegion,
} from "./browser-region";
import { parseProxyAddress } from "./proxy-address";
import { launchOnMac } from "./local-launcher";
import { assignmentModes, MAX_POST_LINK, MAX_SOURCE_TEXT, MAX_VARIANTS, type AssignmentMode, type PendingPost } from "./post-queue";
import { ModelPage } from "./models-page";
import { Icon, Button, IconButton, Dialog, Field } from "./ui";
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
  deviceScaleFactor: number;
  colorScheme: "light" | "dark";
  reducedMotion: "no-preference" | "reduce";
  running: boolean;
  version: string | null;
  localPresence?: { running: boolean; lastSeen: string } | null;
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
  settings: { aiConfigured: boolean; publishAiConfigured: boolean; xConfigured: boolean };
  chromium?: { installed: boolean; version: string | null };
  workspaceScope?: "owner" | "customer";
  remoteBrowser?: boolean;
  macChromeLauncher?: boolean;
  launcherExtensionId?: string;
  launcherDownload?: string;
  camoufoxConfigured?: boolean;
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
type Page = "overview" | "proxies" | "profiles" | "drafts" | "models" | "settings";
type EntityModal =
  | { type: "account"; item: Account }
  | { type: "proxy"; item?: Proxy }
  | { type: "profile"; item: Profile }
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
  settings: { aiConfigured: false, publishAiConfigured: false, xConfigured: false },
  version: "0.1.0",
};
const nav: { id: Page; title: string; icon: typeof Users }[] = [
  { id: "overview", title: "工作概览", icon: LayoutDashboard },
  { id: "profiles", title: "窗口管理", icon: Monitor },
  { id: "proxies", title: "代理网络", icon: Network },
  { id: "drafts", title: "内容工作室", icon: FileText },
  { id: "models", title: "模型列表", icon: Sparkles },
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
function workbenchPage(): Page {
  const requested = location.hash.slice(1);
  if (requested === "accounts") return "profiles";
  if (requested === "settings") return "settings";
  return nav.find((item) => item.id === requested)?.id ?? "overview";
}

function App({
  onLogout,
  accessExpiresAt,
}: {
  onLogout: () => Promise<void>;
  accessExpiresAt: string | null;
}) {
  const [page, setPage] = useState<Page>(workbenchPage);
  const [data, setData] = useState<Workspace>(blank);
  const clientLauncher = data.launcherExtensionId;
  const customer = data.workspaceScope === "customer";
  const showCamoufox =
    data.workspaceScope === "owner" || data.camoufoxConfigured;
  const [viewingBrowser, setViewingBrowser] = useState<{
    profile: Profile;
    draftText?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [modal, setModal] = useState<EntityModal | null>(null);
  const [windowCreator, setWindowCreator] = useState<{
    account?: Account;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [camoufoxOpen, setCamoufoxOpen] = useState(false);
  const [camoufox, setCamoufox] = useState<CamoufoxData | null>(null);
  const [camoufoxLoading, setCamoufoxLoading] = useState(false);
  const [camoufoxError, setCamoufoxError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [publishing, setPublishing] = useState<Draft | null>(null);
  const [reviewing, setReviewing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [draftFilter, setDraftFilter] = useState("pending");
  const [pendingPosts, setPendingPosts] = useState<PendingPost[]>([]);
  const [pendingPostsError, setPendingPostsError] = useState("");
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [selectedPostIds, setSelectedPostIds] = useState<string[]>([]);
  const [postImportOpen, setPostImportOpen] = useState(false);
  const [postDistribution, setPostDistribution] = useState<PendingPost[] | null>(null);
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
  const refreshPendingPosts = async () => {
    setLoadingPosts(true);
    try {
      const { posts } = await request("/api/pending-posts") as { posts: PendingPost[] };
      setPendingPosts(posts);
      setSelectedPostIds((ids) => ids.filter((id) => posts.some((post) => post.id === id)));
      setPendingPostsError("");
    } catch (error) {
      setPendingPostsError((error as Error).message);
    } finally {
      setLoadingPosts(false);
    }
  };
  useEffect(() => {
    if (page === "drafts") void refreshPendingPosts();
  }, [page]);
  useEffect(() => {
    if (page === "profiles" && showCamoufox) void refreshCamoufox();
  }, [page, showCamoufox]);
  useEffect(() => {
    if (loading || !data.remoteBrowser) return;
    const target = new URL(location.href);
    const profileId = target.searchParams.get("browser");
    if (!profileId) return;
    target.searchParams.delete("browser");
    history.replaceState(
      null,
      "",
      target.pathname + target.search + target.hash,
    );
    const profile = data.profiles.find(
      (item) => item.id === profileId && item.running,
    );
    if (profile) setViewingBrowser({ profile });
  }, [data, loading]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 8000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const handle = () => {
      setPage(workbenchPage());
      setQuery("");
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
  const openBrowser = async (profile: Profile, draftText?: string) => {
    if (clientLauncher) {
      setBusy(profile.id);
      try {
        const message = await launchOnMac(clientLauncher, () =>
          request(`/api/profiles/${profile.id}/launcher-ticket`, "POST", {}),
        );
        setToast({ text: message });
        void refresh();
        return true;
      } catch (error) {
        setToast({ text: (error as Error).message, error: true });
        return false;
      } finally {
        setBusy("");
      }
    }
    try {
      if (!profile.running)
        await mutate(
          profile.id,
          `/api/profiles/${profile.id}/start`,
          "POST",
          undefined,
          "浏览器环境已打开",
        );
      if (data.remoteBrowser) setViewingBrowser({ profile, draftText });
      return true;
    } catch {
      // mutate has already shown the error.
      return false;
    }
  };
  const openDraftInX = async (draft: Draft) => {
    const profile = data.profiles.find(
      (item) => item.accountId === draft.accountId,
    );
    if (!profile) {
      setToast({
        text: "请先为此账号绑定 SOCKS5 代理并创建浏览器环境。",
        error: true,
      });
      return;
    }
    if (data.remoteBrowser) {
      await openBrowser(profile, draft.text);
      return;
    }
    try {
      await navigator.clipboard.writeText(draft.text);
    } catch {
      setToast({
        text: "复制失败，请先在编辑页选中正文并手动复制。",
        error: true,
      });
      return;
    }
    if (await openBrowser(profile)) {
      setToast({ text: "正文已复制。请在 X 网页粘贴并确认发布。" });
    }
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
          : type === "profiles"
            ? "删除后会清除这个窗口的浏览器会话和指纹设置。关联的账号和草稿仍可在窗口管理中查看。"
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
    type: "proxy" | "draft",
    label: string,
    disabled = false,
  ) => (
    <Button
      variant="primary"
      icon={Plus}
      disabled={disabled}
      onClick={() => setModal({ type })}
    >
      {label}
    </Button>
  );
  const newWindowButton = (
    <Button icon={Plus} variant="primary" onClick={() => setWindowCreator({})}>
      新建窗口
    </Button>
  );
  const readyProxy = data.proxies.filter((p) => p.status === "ok").length;
  const connected = data.accounts.filter((a) => a.xConnected).length;
  const working = data.profiles.filter((p) => p.running).length;
  const windowRows = data.accounts.map((account) => {
    const profile = data.profiles.find((item) => item.accountId === account.id);
    const proxy = data.proxies.find((item) => item.id === profile?.proxyId);
    return { account, profile, proxy };
  });
  const visibleWindows = windowRows.filter(({ account, profile, proxy }) =>
    [
      account.label,
      account.username,
      account.xUsername,
      profile?.label,
      proxy?.label,
      proxy?.host,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const pageInfo = {
    overview: ["工作概览", "每个账号，都有清晰的工作环境。"],
    proxies: ["代理网络", "配置 SOCKS5 出口，并检查连接状态。"],
    profiles: ["窗口管理", "在同一个窗口管理 X 账号、SOCKS5 代理和显示设置。"],
    drafts: ["内容工作室", "导入 X 或 Facebook 帖子，生成文案，再分配到账号。"],
    models: ["模型列表", "添加服务商的 API Key，并分别选择写作和发布审核模型。"],
    settings: ["系统设置", "查看服务与 X 接入状态。"],
  }[page];
  function WindowTable({ preview = false }: { preview?: boolean }) {
    const list = preview
      ? windowRows.filter(({ profile }) => profile).slice(0, 5)
      : visibleWindows;
    if (!list.length)
      return (
        <Empty
          icon={Monitor}
          title={query ? "没有找到匹配的窗口" : "新建第一个 X 窗口"}
          description={
            query
              ? "试试窗口名称、X 用户名或代理地址。"
              : "设置代理和指纹后，在独立窗口里登录 X。"
          }
          action={!query && newWindowButton}
        />
      );
    return (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>窗口 / 账号</th>
              <th>SOCKS5 代理</th>
              {!preview && <th>窗口指纹</th>}
              <th>状态</th>
              {clientLauncher && !preview && (
                <th className="launcher-status" title="启动器报告的 Chrome 运行状态">本机在线</th>
              )}
              <th className="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map(({ account, profile, proxy }) => {
              const handle = account.xUsername || account.username;
              const presence = profile?.localPresence;
              return (
                <tr key={account.id}>
                  <td>
                    <div className="cell-stack">
                      <strong>{profile?.label || account.label}</strong>
                      {handle && <small>@{handle.replace(/^@/, "")}</small>}
                      {profile && profile.label !== account.label && (
                        <small>{account.label}</small>
                      )}
                    </div>
                  </td>
                  <td>
                    {proxy ? (
                      <div className="cell-stack">
                        <span>{proxy.label}</span>
                        <small className="mono">
                          {proxy.host}:{proxy.port}
                        </small>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  {!preview && (
                    <td>
                      {profile && clientLauncher ? (
                        <div className="cell-stack">
                          <span>{profile.width} × {profile.height}</span>
                          <small>语言、时区和显示偏好跟随本机 Chrome</small>
                        </div>
                      ) : profile ? (
                        <div className="cell-stack">
                          <span>
                            {profile.locale} · {profile.timezone}
                          </span>
                          <small>
                            {profile.width} × {profile.height} ·{" "}
                            {profile.deviceScaleFactor}× ·{" "}
                            {profile.colorScheme === "dark" ? "深色" : "浅色"}
                          </small>
                          <small>
                            {profile.reducedMotion === "reduce"
                              ? "减少动效"
                              : "标准动效"}
                            {(profile.version || data.chromium?.version) &&
                              ` · ${data.macChromeLauncher ? "Chrome" : "Chromium"} ${profile.version || data.chromium?.version}`}
                          </small>
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                  )}
                  <td>
                    <Badge tone={profile?.running ? "green" : "neutral"}>
                      {profile
                        ? clientLauncher
                          ? preview ? "在本机查看" : "已配置"
                          : profile.running
                          ? "运行中"
                          : "已关闭"
                        : "待建窗口"}
                    </Badge>
                    {!preview && data.settings.xConfigured && (
                      <small className="window-auth-status">
                        {account.xConnected ? "已授权发布" : "未授权发布"}
                      </small>
                    )}
                  </td>
                  {clientLauncher && !preview && (
                    <td className="launcher-status" title={presence ? `最近上报 ${date(presence.lastSeen)}` : undefined}>
                      {profile ? (
                        <Badge tone={presence?.running ? "green" : "neutral"}>
                          {presence ? (presence.running ? "运行中" : "已离线") : "未检测"}
                        </Badge>
                      ) : "—"}
                    </td>
                  )}
                  <td>
                    <div className="row-actions">
                      {profile ? (
                        <Button
                          icon={
                            profile.running && !data.remoteBrowser
                              ? Square
                              : Play
                          }
                          variant={profile.running ? "secondary" : "primary"}
                          busy={busy === profile.id}
                          onClick={() =>
                            profile.running && !data.remoteBrowser
                              ? run(
                                  profile.id,
                                  `/api/profiles/${profile.id}/stop`,
                                  "窗口已关闭",
                                )
                              : void openBrowser(profile)
                          }
                        >
                          {profile.running
                            ? data.remoteBrowser
                              ? "进入窗口"
                              : "关闭窗口"
                            : "打开 X"}
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          icon={Plus}
                          onClick={() => setWindowCreator({ account })}
                        >
                          新建窗口
                        </Button>
                      )}
                      {!preview && (
                        <>
                          {profile?.running && data.remoteBrowser && (
                            <IconButton
                              icon={Square}
                              label={`关闭窗口 ${profile.label}`}
                              disabled={busy === profile.id}
                              onClick={() =>
                                run(
                                  profile.id,
                                  `/api/profiles/${profile.id}/stop`,
                                  "窗口已关闭",
                                )
                              }
                            />
                          )}
                          {profile && (
                            <IconButton
                              icon={Fingerprint}
                              label={`配置窗口 ${profile.label}`}
                              disabled={profile.running || busy === profile.id}
                              onClick={() =>
                                setModal({ type: "profile", item: profile })
                              }
                            />
                          )}
                          <IconButton
                            icon={Pencil}
                            label={`编辑账号 ${account.label}`}
                            onClick={() =>
                              setModal({ type: "account", item: account })
                            }
                          />
                          {data.settings.xConfigured &&
                            (account.xConnected ? (
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
                            ) : (
                              <IconButton
                                icon={Link2}
                                label="授权发布"
                                onClick={() => {
                                  location.href = `/api/x/connect/${account.id}`;
                                }}
                              />
                            ))}
                          <IconButton
                            icon={Trash2}
                            label={
                              profile
                                ? `删除窗口 ${profile.label}`
                                : `删除账号 ${account.label}`
                            }
                            disabled={
                              profile?.running ||
                              (profile && busy === profile.id)
                            }
                            onClick={() =>
                              profile
                                ? remove("profiles", profile.id, profile.label)
                                : remove("accounts", account.id, account.label)
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
            <strong>{customer ? "独立客户空间" : "主工作空间"}</strong>
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
              {item.id === "profiles" && data.profiles.length > 0 && (
                <span className="nav-count">{data.profiles.length}</span>
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
              {accessExpiresAt
                ? `授权至 ${new Date(accessExpiresAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}`
                : "本地部署"}
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
              {page === "profiles" && showCamoufox && (
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
              {page === "profiles" && (
                <Button icon={Upload} onClick={() => setImporting(true)}>
                  批量导入
                </Button>
              )}
              {page === "overview" || page === "profiles"
                ? newWindowButton
                : page === "proxies"
                  ? addButton("proxy", "添加代理")
                  : null}
              {page === "drafts" && (
                <>
                  <Button icon={Pencil} variant="secondary" disabled={!data.accounts.length} onClick={() => setModal({ type: "draft" })}>
                    手写草稿
                  </Button>
                  <Button icon={Plus} variant="primary" onClick={() => setPostImportOpen(true)}>
                    从帖子生成
                  </Button>
                </>
              )}
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
                        name: "浏览器窗口",
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
                        {data.profiles.length} 个窗口已创建
                      </span>
                    </div>
                    <div className="setup-steps">
                      {[
                        {
                          label: "管理窗口",
                          text: "在窗口里登录 X，代理和显示设置随窗口保存",
                          done: data.profiles.length > 0,
                          icon: Monitor,
                          target: "profiles" as Page,
                        },
                        {
                          label: "管理 SOCKS5 代理",
                          text: "维护代理配置并检查网络连通性",
                          done: data.proxies.length > 0,
                          icon: Network,
                          target: "proxies" as Page,
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
                          最近窗口
                          <span className="count">{data.profiles.length}</span>
                        </h2>
                        <button
                          className="text-button"
                          onClick={() => go("profiles")}
                        >
                          查看全部
                          <Icon icon={ArrowRight} size={15} />
                        </button>
                      </div>
                      <WindowTable preview />
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
                          <strong>
                            {data.settings.xConfigured
                              ? "X 发布接口"
                              : "X 网页登录"}
                          </strong>
                          <small>
                            {data.settings.xConfigured
                              ? `${connected} 个账号已完成授权`
                              : "使用已绑定的独立浏览器"}
                          </small>
                        </div>
                        <span
                          className={`state-dot ${data.settings.xConfigured || data.chromium?.installed ? "ok" : ""}`}
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
                          {data.settings.xConfigured
                            ? "浏览器用于登录和管理。定时发布使用已开通的 X 接口。"
                            : "在窗口里登录 X，确认账号和正文后可在网页发布。"}
                        </p>
                      </div>
                    </section>
                  </div>
                </>
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
                      <span>{clientLauncher ? "连通性检测由工作台服务发起" : "出口 IP 与延迟来自实际连接检查"}</span>
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
                        {clientLauncher ? (
                          <>
                            <h2>本机 Chrome 启动器</h2>
                            <p>首次使用请下载安装包并加载 Chrome 扩展，之后点击「打开 X」。</p>
                            <a className="button secondary launcher-download" href={data.launcherDownload} download>
                              <Icon icon={Download} size={16} />
                              下载 macOS 启动器
                            </a>
                          </>
                        ) : (
                          <>
                            <h2>
                              {data.macChromeLauncher
                                ? "本机 Chrome · 临时版"
                                : data.remoteBrowser ? "在线 Chromium" : "本地 Chromium"}
                              <Badge tone={data.chromium?.installed ? "green" : "neutral"}>
                                {data.chromium?.installed ? "已安装" : "未安装"}
                              </Badge>
                            </h2>
                            <p>
                              {data.chromium?.installed
                                ? `真实版本 ${data.chromium.version || "待读取"}。每个账号使用独立目录保存会话。`
                                : data.macChromeLauncher
                                  ? "在这台 Mac 上安装 Google Chrome 后即可打开窗口。"
                                  : customer
                                    ? "服务器尚未安装浏览器，请联系管理员。"
                                    : "安装 Playwright 浏览器后，即可打开下方配置的独立环境。"}
                            </p>
                            {!data.chromium?.installed && !customer && !data.macChromeLauncher && (
                              <code className="engine-command">npm run browser:install</code>
                            )}
                          </>
                        )}
                      </div>
                    </section>
                    {showCamoufox && (
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
                    )}
                  </div>
                  <section className="panel">
                    <div className="table-toolbar">
                      <div className="tabs">
                        <span className="tab active">
                          窗口与账号<span>{data.accounts.length}</span>
                        </span>
                      </div>
                      <SearchBox
                        value={query}
                        onChange={setQuery}
                        placeholder="搜索窗口、账号或代理"
                      />
                    </div>
                    <WindowTable />
                    <div className="table-footer">
                      共 {visibleWindows.length} 项
                      {!clientLauncher && <span>{working} 个窗口运行中</span>}
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
                        <h2>原文与相似稿</h2>
                        <p>每批保留一条原文。生成的相似稿可分配给不同账号。</p>
                      </div>
                    </div>
                    <div className="studio-connection">
                      <span
                        className={`state-dot ${data.settings.aiConfigured ? "ok" : ""}`}
                      />
                      {data.settings.aiConfigured ? "已设置写作模型" : "示例模式"}
                      <button
                        className="text-button"
                        onClick={() => go("models")}
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
                          ["pending", "待发布"],
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
                            {value === "pending" && (
                              <span>{pendingPosts.length}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                    {draftFilter === "pending" ? (
                      <PendingPostsPanel
                        posts={pendingPosts}
                        selected={selectedPostIds}
                        accountsAvailable={data.accounts.length > 0}
                        loading={loadingPosts}
                        error={pendingPostsError}
                        onSelection={setSelectedPostIds}
                        onRetry={refreshPendingPosts}
                        onImport={() => setPostImportOpen(true)}
                        onAssign={(posts) => setPostDistribution(posts)}
                      />
                    ) : data.drafts.filter(
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
                                      {data.settings.publishAiConfigured && draft.text.trim() && (
                                        <Button variant="ghost" icon={Sparkles} onClick={() => setReviewing(draft)}>
                                          AI 审核
                                        </Button>
                                      )}
                                      {data.settings.xConfigured ? (
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
                                      ) : (
                                        <Button
                                          icon={Copy}
                                          disabled={
                                            !draft.text.trim() ||
                                            data.profiles.some(
                                              (item) =>
                                                item.accountId ===
                                                  draft.accountId &&
                                                busy === item.id,
                                            )
                                          }
                                          onClick={() =>
                                            void openDraftInX(draft)
                                          }
                                        >
                                          {data.remoteBrowser
                                            ? "打开 X 发文"
                                            : "复制并打开 X"}
                                        </Button>
                                      )}
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
                    {data.settings.xConfigured
                      ? "发布前请确认目标账号和正文。定时发布需要 Node X 服务持续运行。"
                      : "在 X 网页确认账号和正文后，手动点击发布。"}
                  </p>
                </>
              )}
              {page === "models" && <ModelPage requestModel={(path, method, body) => request("/api" + path, method, body)} onChange={() => refresh()} />}
              {page === "settings" && (
                <div className="settings-grid">
                  <section className="panel settings-section">
                    <div className="settings-section-heading">
                      <span className="settings-symbol"><Icon icon={Sparkles} size={23} /></span>
                      <div>
                        <h2>AI 模型</h2>
                        <p>配置当前工作空间的写作与发布审核模型。</p>
                      </div>
                    </div>
                    <div className="settings-content">
                      <Button icon={ArrowRight} onClick={() => go("models")}>打开模型列表</Button>
                    </div>
                  </section>
                  <section className="panel settings-section">
                    <div className="settings-section-heading">
                      <span className="settings-symbol">
                        <Icon icon={Link2} size={23} />
                      </span>
                      <div>
                        <h2>
                          {data.settings.xConfigured
                            ? "X 发布授权"
                            : "X 网页登录"}
                        </h2>
                        <p>
                          {data.settings.xConfigured
                            ? "通过 X 官方接口为已授权账号发布内容。"
                            : "使用每个账号绑定的独立 Chromium 浏览器。"}
                        </p>
                      </div>
                      <Badge
                        tone={data.settings.xConfigured ? "green" : "neutral"}
                      >
                        {data.settings.xConfigured ? "已配置" : "浏览器模式"}
                      </Badge>
                    </div>
                    <div className="settings-content">
                      <p>
                        {data.settings.xConfigured
                          ? "前往窗口管理，连接需要发文的 X 账号。"
                          : "在 X 网页完成登录。下次打开同一个环境时可继续使用已保存的会话。"}
                      </p>
                      {!customer && data.settings.xConfigured && (
                        <>
                          <CodeBlock
                            text={`X_CLIENT_ID=你的应用客户端ID\nX_CLIENT_SECRET=你的应用客户端密钥\nX_REDIRECT_URI=${location.origin}/api/x/callback`}
                          />
                          <p className="settings-hint">
                            回调地址需要与 X
                            开发者平台的设置完全一致。配置完成后，前往窗口管理连接各个账号。
                          </p>
                        </>
                      )}
                      <Button icon={Users} onClick={() => go("profiles")}>
                        前往窗口管理
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
                        <strong>{clientLauncher ? "客户本机 Google Chrome" : "Chromium"}</strong>
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
      {postImportOpen && (
        <PostImportDialog
          aiConfigured={data.settings.aiConfigured}
          onClose={() => setPostImportOpen(false)}
          onCreated={async (count) => {
            setPostImportOpen(false);
            setDraftFilter("pending");
            await refreshPendingPosts();
            setToast({ text: `已将 ${count} 条文案加入待发布列表。` });
          }}
        />
      )}
      {postDistribution && (
        <PostDistributionDialog
          posts={postDistribution}
          accounts={data.accounts}
          onClose={() => setPostDistribution(null)}
          onAssigned={async ({ created, existing }) => {
            setPostDistribution(null);
            setSelectedPostIds([]);
            setDraftFilter("draft");
            await Promise.all([refresh(), refreshPendingPosts()]);
            setToast({ text: `已创建 ${created} 条发布草稿${existing ? `，跳过 ${existing} 条已分配记录` : ""}。` });
          }}
        />
      )}
      {windowCreator && (
        <CreateWindowDialog
          account={windowCreator.account}
          proxies={data.proxies}
          chromiumVersion={data.chromium?.version}
          macChromeLauncher={data.macChromeLauncher || Boolean(clientLauncher)}
          onClose={() => setWindowCreator(null)}
          onCreated={async (profile) => {
            setWindowCreator(null);
            go("profiles");
            await refresh();
            await openBrowser(profile);
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
      {viewingBrowser && (
        <Dialog
          title={viewingBrowser.profile.label}
          description="点击画面操作 X。离开画面请按 Esc。"
          onClose={() => setViewingBrowser(null)}
          className="remote-browser-dialog"
        >
          <BrowserView
            id={viewingBrowser.profile.id}
            draftText={viewingBrowser.draftText}
            onStop={() => {
              const { id } = viewingBrowser.profile;
              void mutate(
                id,
                `/api/profiles/${id}/stop`,
                "POST",
                undefined,
                "环境已关闭",
              ).then(
                () => setViewingBrowser(null),
                () => {},
              );
            }}
          />
        </Dialog>
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
      {reviewing && (
        <DraftReviewDialog
          draft={reviewing}
          account={accountName(reviewing.accountId)}
          onClose={() => setReviewing(null)}
          onContinue={() => {
            if (data.settings.xConfigured) {
              setPublishing(reviewing);
            } else {
              void openDraftInX(reviewing);
            }
            setReviewing(null);
          }}
        />
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

function readWindowFingerprint(form: FormData) {
  return {
    locale: String(form.get("locale")).trim(),
    timezone: String(form.get("timezone")).trim(),
    width: Number(form.get("width")),
    height: Number(form.get("height")),
    deviceScaleFactor: Number(form.get("deviceScaleFactor")),
    colorScheme: String(form.get("colorScheme")),
    reducedMotion: String(form.get("reducedMotion")),
  };
}

const timezoneOptions = browserTimezones.map((value) => ({
  value,
  label: value,
}));
const customRegionValue = "__custom__";

function RegionalSettingField({
  label,
  name,
  value,
  options,
  custom,
  disabled,
  onChange,
  onCustom,
}: {
  label: string;
  name: "locale" | "timezone";
  value: string;
  options: readonly { value: string; label: string }[];
  custom: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onCustom: (enabled: boolean) => void;
}) {
  return (
    <div>
      <Field label={label}>
        <select
          name={custom ? undefined : name}
          aria-label={label}
          value={custom ? customRegionValue : value}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            onCustom(next === customRegionValue);
            if (next !== customRegionValue) onChange(next);
          }}
        >
          {!custom && !options.some((option) => option.value === value) && (
            <option value={value}>{value}</option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value={customRegionValue}>自定义…</option>
        </select>
      </Field>
      {custom && (
        <Field label={`自定义${label}`}>
          <input
            name={name}
            value={value}
            maxLength={name === "locale" ? 30 : 80}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            required
          />
        </Field>
      )}
    </div>
  );
}

function WindowFingerprintFields({
  profile,
  version,
  macChromeLauncher,
  disabled,
}: {
  profile?: Profile;
  version?: string | null;
  macChromeLauncher?: boolean;
  disabled: boolean;
}) {
  const [region, setRegion] = useState("");
  const [settings, setSettings] = useState({
    locale: profile?.locale || "zh-CN",
    timezone: profile?.timezone || "Asia/Shanghai",
  });
  const [custom, setCustom] = useState({ locale: false, timezone: false });
  const [announcement, setAnnouncement] = useState("");

  const updateRegionValue = (name: keyof typeof settings, value: string) =>
    setSettings((previous) => ({ ...previous, [name]: value }));

  return (
    <>
      <h3 className="form-divider">
        浏览器指纹{version && <span>{macChromeLauncher ? "Chrome" : "Chromium"} {version}</span>}
      </h3>
      {macChromeLauncher && (
        <p className="field-hint">本机启动器应用窗口宽高。语言、时区和显示偏好由本机 Chrome 决定。</p>
      )}
      <div className="window-region-control">
        <Field label="随机国家或地区">
          <select
            aria-label="随机国家或地区"
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            disabled={disabled}
          >
            <option value="">不限地区</option>
            {browserRegions.map(({ code, label }) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Button
          type="button"
          variant="secondary"
          icon={Shuffle}
          disabled={disabled}
          onClick={() => {
            const next = randomBrowserRegion(region, settings);
            setSettings(next);
            setCustom({ locale: false, timezone: false });
            setAnnouncement(`已随机填入 ${next.locale} 和 ${next.timezone}。`);
          }}
        >
          随机填入
        </Button>
      </div>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      <div className="form-grid">
        <RegionalSettingField
          label="浏览器语言"
          name="locale"
          value={settings.locale}
          options={browserLanguages}
          custom={custom.locale}
          disabled={disabled}
          onChange={(value) => updateRegionValue("locale", value)}
          onCustom={(enabled) =>
            setCustom((previous) => ({ ...previous, locale: enabled }))
          }
        />
        <RegionalSettingField
          label="时区"
          name="timezone"
          value={settings.timezone}
          options={timezoneOptions}
          custom={custom.timezone}
          disabled={disabled}
          onChange={(value) => updateRegionValue("timezone", value)}
          onCustom={(enabled) =>
            setCustom((previous) => ({ ...previous, timezone: enabled }))
          }
        />
        <Field label="窗口宽度">
          <input
            name="width"
            type="number"
            min={320}
            max={3840}
            defaultValue={profile?.width ?? 1440}
            required
            disabled={disabled}
          />
        </Field>
        <Field label="窗口高度">
          <input
            name="height"
            type="number"
            min={320}
            max={2160}
            defaultValue={profile?.height ?? 900}
            required
            disabled={disabled}
          />
        </Field>
        <Field label="显示比例" hint="设备像素比，1–3 倍。">
          <input
            name="deviceScaleFactor"
            type="number"
            min={1}
            max={3}
            step="any"
            defaultValue={profile?.deviceScaleFactor ?? 1}
            required
            disabled={disabled}
          />
        </Field>
        <Field label="网页颜色主题">
          <select
            name="colorScheme"
            aria-label="网页颜色主题"
            defaultValue={profile?.colorScheme ?? "light"}
            disabled={disabled}
          >
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </Field>
        <Field label="网页动态效果">
          <select
            name="reducedMotion"
            aria-label="网页动态效果"
            defaultValue={profile?.reducedMotion ?? "no-preference"}
            disabled={disabled}
          >
            <option value="no-preference">标准动效</option>
            <option value="reduce">减少动效</option>
          </select>
        </Field>
      </div>
      {profile && <p className="form-note">设置随窗口保存，下次打开时生效。</p>}
    </>
  );
}

function readProxyConnection(form: FormData) {
  const read = (name: string) => String(form.get(name) ?? "");
  const address = parseProxyAddress(read("host"));
  return {
    host: address?.host ?? read("host").trim(),
    port: address?.port ?? Number(read("port")),
    username: address?.username ?? read("username").trim(),
    password: address?.password ?? read("password"),
  };
}

function ProxyConnectionFields({
  initial,
  disabled,
}: {
  initial?: Proxy;
  disabled: boolean;
}) {
  const [fields, setFields] = useState({
    host: initial?.host ?? "",
    port: String(initial?.port ?? 1080),
    username: initial?.username ?? "",
    password: "",
  });
  const [clearPassword, setClearPassword] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const update = (key: keyof typeof fields, value: string) =>
    setFields((current) => ({ ...current, [key]: value }));

  function recognize(input: HTMLInputElement, text: string) {
    try {
      const address = parseProxyAddress(text);
      if (!address) return false;
      const { host, port, username, password } = address;
      setFields((current) => ({
        host,
        port: String(port),
        username: username ?? current.username,
        password: password ?? current.password,
      }));
      if (password) setClearPassword(false);
      input.setCustomValidity("");
      setNotice({
        text: password ? "已识别主机、端口和认证信息。" : "已识别主机和端口。",
      });
    } catch (error) {
      const text = (error as Error).message;
      input.setCustomValidity(text);
      setNotice({ text, error: true });
    }
    return true;
  }

  return (
    <>
      <div className="form-grid host-grid">
        <Field
          label="主机或 IP"
          hint="可直接粘贴主机:端口:用户名:密码，系统会自动分栏。"
        >
          <input
            name="host"
            placeholder="proxy.example.com:1080"
            autoComplete="off"
            spellCheck={false}
            value={fields.host}
            required
            disabled={disabled}
            aria-invalid={notice?.error || undefined}
            onPaste={(event) => {
              if (
                recognize(
                  event.currentTarget,
                  event.clipboardData.getData("text/plain"),
                )
              )
                event.preventDefault();
            }}
            onBlur={(event) =>
              recognize(event.currentTarget, event.currentTarget.value)
            }
            onChange={(event) => {
              event.currentTarget.setCustomValidity("");
              setNotice(null);
              update("host", event.currentTarget.value);
            }}
          />
        </Field>
        <Field label="端口">
          <input
            name="port"
            type="number"
            min={1}
            max={65535}
            value={fields.port}
            required
            disabled={disabled}
            onChange={(event) => update("port", event.target.value)}
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="代理用户名（选填）">
          <input
            name="username"
            autoComplete="off"
            disabled={disabled}
            value={fields.username}
            onChange={(event) => update("username", event.target.value)}
          />
        </Field>
        <Field
          label="代理密码（选填）"
          hint={initial?.hasPassword ? "留空保留现有密码。" : undefined}
        >
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            disabled={disabled || clearPassword}
            value={fields.password}
            onChange={(event) => update("password", event.target.value)}
          />
        </Field>
      </div>
      {initial?.hasPassword && (
        <label className="checkbox-field">
          <input
            name="clearProxyPassword"
            type="checkbox"
            disabled={disabled}
            checked={clearPassword}
            onChange={(event) => {
              setClearPassword(event.target.checked);
              if (event.target.checked) update("password", "");
            }}
          />
          清除已保存的密码
        </label>
      )}
      {notice && (
        <p
          className={notice.error ? "form-error" : "form-note"}
          role={notice.error ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
    </>
  );
}

function CreateWindowDialog({
  account,
  proxies,
  chromiumVersion,
  macChromeLauncher,
  onClose,
  onCreated,
}: {
  account?: Account;
  proxies: Proxy[];
  chromiumVersion?: string | null;
  macChromeLauncher?: boolean;
  onClose: () => void;
  onCreated: (profile: Profile) => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [proxyId, setProxyId] = useState(
    proxies.find((proxy) => proxy.status === "ok")?.id ?? proxies[0]?.id ?? "",
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const read = (name: string) => String(form.get(name) ?? "");
    setError("");
    setPending(true);
    try {
      const { profile } = (await request("/api/windows", "POST", {
        id,
        label: read("label"),
        accountId: account?.id,
        proxy: proxyId ? { id: proxyId } : readProxyConnection(form),
        ...readWindowFingerprint(form),
      })) as { profile: Profile };
      await onCreated(profile);
    } catch (error) {
      setError((error as Error).message);
      setPending(false);
    }
  }

  return (
    <Dialog
      title="新建窗口"
      description="设置代理和指纹后，直接打开 X 登录页。"
      className="create-window-dialog"
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <form className="create-window-form" onSubmit={submit}>
        <div className="dialog-body create-window-layout">
          <div className="create-window-network">
            <Field label="窗口名称（选填）">
              <input
                name="label"
                maxLength={80}
                defaultValue={account?.label}
                placeholder="自动命名"
                disabled={pending}
              />
            </Field>
            <h3 className="form-divider">SOCKS5 代理</h3>
            {proxies.length > 0 && (
              <Field label="选择代理">
                <select
                  aria-label="选择代理"
                  value={proxyId}
                  onChange={(event) => setProxyId(event.target.value)}
                  disabled={pending}
                >
                  {proxies.map((proxy) => (
                    <option key={proxy.id} value={proxy.id}>
                      {proxy.label} · {proxy.host}:{proxy.port}
                    </option>
                  ))}
                  <option value="">添加新代理</option>
                </select>
              </Field>
            )}
            {!proxyId && <ProxyConnectionFields disabled={pending} />}
          </div>
          <div className="create-window-fingerprint">
            <WindowFingerprintFields
              version={chromiumVersion}
              macChromeLauncher={macChromeLauncher}
              disabled={pending}
            />
          </div>
        </div>
        {error && (
          <p className="form-error create-window-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <Button type="button" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" busy={pending}>
            创建并打开
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PostImportDialog({
  aiConfigured,
  onClose,
  onCreated,
}: {
  aiConfigured: boolean;
  onClose: () => void;
  onCreated: (count: number) => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [count, setCount] = useState("3");
  const [busy, setBusy] = useState<"source" | "generate" | "">("");
  const [error, setError] = useState("");
  const number = Number(count);
  const countValid = Boolean(count) && Number.isInteger(number) && number >= 0 && number <= MAX_VARIANTS;

  async function readLink() {
    setError("");
    setBusy("source");
    try {
      const source = await request("/api/pending-posts/source", "POST", { url }) as { url: string; text: string };
      setUrl(source.url);
      setText(source.text);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!countValid || (!text.trim() && !url.trim())) return;
    setError("");
    setBusy("generate");
    try {
      const { count: created } = await request("/api/pending-posts", "POST", {
        id, text: text || undefined, url: url.trim() || undefined, count: number,
      }) as { count: number };
      await onCreated(created);
    } catch (error) {
      setError((error as Error).message);
      setBusy("");
    }
  }

  return (
    <Dialog
      title="从帖子生成"
      description="可粘贴 X 或 Facebook 帖子链接，也可直接粘贴正文。"
      className="dialog-wide"
      onClose={() => { if (!busy) onClose(); }}
    >
      <form onSubmit={submit}>
        <div className="dialog-body">
          <div className="post-source-fields">
            <Field label="帖子链接（可选）" hint="无法读取的帖子可粘贴正文，同时保留来源链接。">
              <input autoFocus type="text" inputMode="url" maxLength={MAX_POST_LINK} disabled={!!busy}
                value={url} placeholder="粘贴 X 或 Facebook 帖子链接" onChange={(event) => setUrl(event.target.value)} />
            </Field>
            <Button type="button" icon={Link2} disabled={!url.trim() || !!busy} busy={busy === "source"}
              onClick={() => void readLink()}>
              读取正文
            </Button>
          </div>
          <Field label="原帖正文">
            <textarea rows={7} value={text} placeholder="粘贴正文，或先从链接读取" maxLength={MAX_SOURCE_TEXT}
              disabled={!!busy} onChange={(event) => setText(event.target.value)} />
          </Field>
          <Field label="相似稿数量" hint={`可生成 0 到 ${MAX_VARIANTS} 条相似稿。每批另保留 1 条原文。`}>
            <input type="number" min={0} max={MAX_VARIANTS} step={1} value={count}
              disabled={!!busy} onChange={(event) => setCount(event.target.value)} required />
          </Field>
          <small className="field-hint">{aiConfigured
            ? "相似稿使用默认写作模型生成。"
            : "未设置写作模型时，示例模式仅调整标题和排版。"}</small>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onClose} disabled={!!busy}>取消</Button>
          <Button type="submit" variant="primary" icon={Sparkles} disabled={!!busy || !countValid || !text.trim() && !url.trim()}
            busy={busy === "generate"}>
            {countValid ? `生成 ${number + 1} 条并加入待发布` : "生成并加入待发布"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PendingPostsPanel({
  posts, selected, accountsAvailable, loading, error, onSelection, onRetry, onImport, onAssign,
}: {
  posts: PendingPost[];
  selected: string[];
  accountsAvailable: boolean;
  loading: boolean;
  error: string;
  onSelection: (ids: string[]) => void;
  onRetry: () => Promise<void>;
  onImport: () => void;
  onAssign: (posts: PendingPost[]) => void;
}) {
  if (loading && !posts.length) return <div className="loading-state">正在读取待发布内容…</div>;
  if (error) return <Empty title="待发布列表读取失败" description={error}
    action={<Button onClick={() => void onRetry()}>重试</Button>} />;
  if (!posts.length) return <Empty icon={FileText} title="待发布列表为空"
    description="导入帖子后，原文和相似稿会出现在这里。"
    action={<Button icon={Plus} variant="primary" onClick={onImport}>从帖子生成</Button>} />;

  const enabled = selected.length > 0 && accountsAvailable;
  const selectionLimit = MAX_VARIANTS + 1;
  return (
    <>
      <div className="post-queue-toolbar">
        <div className="row-actions">
          <Button type="button" variant="ghost" onClick={() => onSelection(selected.length ? [] : posts.slice(0, selectionLimit).map(post => post.id))}>
            {selected.length ? "取消选择" : posts.length > selectionLimit ? `选择前 ${selectionLimit} 条` : "全选"}
          </Button>
          <small className="subtle" aria-live="polite">已选 {selected.length} 条</small>
        </div>
        <div className="row-actions">
          {!accountsAvailable && <small className="subtle">先添加 X 账号即可分配。</small>}
          <Button type="button" icon={Send} variant="primary" disabled={!enabled}
            onClick={() => onAssign(selected.flatMap(id => posts.find(post => post.id === id) ?? []))}>
            分配发布
          </Button>
        </div>
      </div>
      <div className="post-queue-list">
        {posts.map((post, index) => (
          <article className="post-queue-row" key={post.id}>
            <input type="checkbox" aria-label={`选择第 ${index + 1} 条待发布内容`}
              checked={selected.includes(post.id)}
              disabled={!selected.includes(post.id) && selected.length >= selectionLimit}
              onChange={(event) => onSelection(event.target.checked ? [...selected, post.id] : selected.filter(id => id !== post.id))} />
            <div>
              <div className="post-queue-meta">
                <Badge tone={post.variant === 0 ? "blue" : "neutral"}>
                  {post.variant === 0 ? "原文" : `${post.generatedBy ? "AI 改写" : "示例改写"} ${post.variant}`}
                </Badge>
                {post.generatedBy && <small className="subtle">{post.generatedBy}</small>}
                {post.assignedCount > 0 && <small className="subtle">已分配 {post.assignedCount} 个账号</small>}
                {post.sourceUrl && <a href={post.sourceUrl} target="_blank" rel="noreferrer" className="text-button">
                  原帖 <Icon icon={ExternalLink} size={13} />
                </a>}
              </div>
              <p className="post-queue-text">{post.text}</p>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function PostDistributionDialog({
  posts, accounts, onClose, onAssigned,
}: {
  posts: PendingPost[];
  accounts: Account[];
  onClose: () => void;
  onAssigned: (result: { created: number; existing: number }) => Promise<void>;
}) {
  const [mode, setMode] = useState<AssignmentMode>("oneAccount");
  const [single, setSingle] = useState("");
  const [multi, setMulti] = useState<string[]>([]);
  const [paired, setPaired] = useState<string[]>(() => posts.map(() => ""));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const accountIds = mode === "oneAccount" ? (single ? [single] : []) : mode === "samePost" ? multi : paired;
  const valid = mode === "oneAccount" ? Boolean(single) : mode === "samePost" ? multi.length >= 2 : paired.every(Boolean);

  const accountLabel = (account: Account) => account.username ? `${account.label} · @${account.username}` : account.label;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setError("");
    setSaving(true);
    try {
      await onAssigned(await request("/api/pending-posts/assign", "POST", {
        mode, postIds: posts.map(post => post.id), accountIds,
      }));
    } catch (error) {
      setSaving(false);
      setError((error as Error).message);
    }
  }

  return (
    <Dialog title="分配发布" description={`已选 ${posts.length} 条文案。确认后会为目标账号创建发布草稿。`}
      className="dialog-wide" onClose={() => { if (!saving) onClose(); }}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          <fieldset className="post-distribution" disabled={saving}>
            <legend>分配方式</legend>
            <div className="post-distribution-options">
              {(Object.keys(assignmentModes) as AssignmentMode[]).map((value) => {
                const disabled = value === "samePost" ? posts.length !== 1 || accounts.length < 2
                  : value === "oneEach" ? posts.length < 2 || posts.length > accounts.length : false;
                return (
                  <label key={value}>
                    <input type="radio" name="assignment" value={value} disabled={disabled}
                      checked={mode === value} onChange={() => setMode(value)} />
                    {assignmentModes[value]}
                  </label>
                );
              })}
            </div>
          </fieldset>
          {mode === "oneAccount" && (
            <Field label="目标 X 账号">
              <select value={single} onChange={(event) => setSingle(event.target.value)} disabled={saving} required>
                <option value="">选择账号</option>
                {accounts.map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
              </select>
            </Field>
          )}
          {mode === "samePost" && (
            <fieldset className="post-distribution post-account-list" disabled={saving}>
              <legend>目标 X 账号（至少选两个）</legend>
              {accounts.map(account => (
                <label key={account.id}>
                  <input type="checkbox" checked={multi.includes(account.id)}
                    disabled={!multi.includes(account.id) && multi.length >= MAX_VARIANTS + 1}
                    onChange={(event) => setMulti(event.target.checked ? [...multi, account.id] : multi.filter(id => id !== account.id))} />
                  {accountLabel(account)}
                </label>
              ))}
            </fieldset>
          )}
          {mode === "oneEach" && (
            <div className="post-account-list">
              {posts.map((post, index) => (
                <Field key={post.id} label={`文案 ${index + 1}的目标账号`} hint={post.text.slice(0, 120)}>
                  <select value={paired[index]} required disabled={saving}
                    onChange={(event) => setPaired(paired.map((id, i) => i === index ? event.target.value : id))}>
                    <option value="">选择账号</option>
                    {accounts.map(account => <option key={account.id} value={account.id}
                      disabled={paired.some((id, i) => i !== index && id === account.id)}>{accountLabel(account)}</option>)}
                  </select>
                </Field>
              ))}
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-footer">
          <Button type="button" onClick={onClose} disabled={saving}>取消</Button>
          <Button type="submit" variant="primary" icon={Send} disabled={!valid || saving} busy={saving}>创建发布草稿</Button>
        </div>
      </form>
    </Dialog>
  );
}

function DraftReviewDialog({ draft, account, onClose, onContinue }: {
  draft: Draft;
  account: string;
  onClose: () => void;
  onContinue: () => void;
}) {
  const [result, setResult] = useState<{ model: string; advice: string; lengthIssue: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function review() {
    setBusy(true);
    setError("");
    try {
      setResult(await request(`/api/drafts/${draft.id}/review`, "POST", {}));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="AI 发布审核" description={`发布账号 ${account}`} onClose={onClose}>
      <div className="dialog-body">
        <p className="model-review-text">{draft.text}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {result && <section className="model-review-result" aria-live="polite">
          <strong>{result.model}</strong>
          {result.lengthIssue && <p className="form-error">{result.lengthIssue}</p>}
          <p className="model-review-text">{result.advice}</p>
        </section>}
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose}>关闭</Button>
        {result ? <Button variant="primary" icon={Send} onClick={onContinue}>继续发布</Button>
          : <Button variant="primary" icon={Sparkles} busy={busy} disabled={busy} onClick={() => void review()}>开始审核</Button>}
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
        ? { label: "", ...item }
        : modal.type === "profile"
          ? {
              label: "",
              accountId:
                data.accounts.find(
                  (a) => !data.profiles.some((p) => p.accountId === a.id),
                )?.id || "",
              proxyId: data.proxies[0]?.id || "",
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
  const update = (key: string, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const edit = !!item;
  const titles = {
    account: "账号",
    proxy: "代理",
    profile: "窗口",
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
        const form = new FormData(event.currentTarget);
        const { password, ...connection } = readProxyConnection(form);
        body = { label: values.label.trim(), ...connection };
        if (!edit || password || form.has("clearProxyPassword"))
          body.password = password;
      } else if (modal.type === "profile")
        body = {
          label: values.label.trim(),
          accountId: values.accountId,
          proxyId: values.proxyId,
          ...readWindowFingerprint(new FormData(event.currentTarget)),
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
                hint="可留空。账号登录在对应的 X 窗口中完成。"
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
                  {data.settings.xConfigured
                    ? "在对应窗口登录 X，接口发布需要账号授权。"
                    : "在对应窗口登录 X，账号名称和备注可在这里修改。"}
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
              <ProxyConnectionFields
                initial={modal.item}
                disabled={!!pending}
              />
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
              <WindowFingerprintFields
                profile={modal.item}
                version={data.chromium?.version}
                macChromeLauncher={data.macChromeLauncher || Boolean(data.launcherExtensionId)}
                disabled={!!pending}
              />
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
    const data: unknown = JSON.parse(
      localStorage.getItem(loginHistoryKey) || "[]",
    );
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
    if (history.length)
      localStorage.setItem(loginHistoryKey, JSON.stringify(history));
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
  const [accessExpiresAt, setAccessExpiresAt] = useState<string | null>(null);
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
        setAccessExpiresAt(
          typeof result.licenseExpiresAt === "string"
            ? result.licenseExpiresAt
            : null,
        );
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
      setError("登录已过期，请重新输入有效的登录码。");
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
  if (state === "authenticated")
    return <App onLogout={logout} accessExpiresAt={accessExpiresAt} />;
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
                <span>在此浏览器记住登录</span>
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
                      {loginHistory.length
                        ? "选择一条历史记录"
                        : "暂无历史记录"}
                    </option>
                    {loginHistory.map(({ suffix, usedAt }, index) => (
                      <option
                        key={`${usedAt}-${suffix}-${index}`}
                        value={index}
                      >
                        NX-••••{suffix} · {loginHistoryDate.format(usedAt)}
                      </option>
                    ))}
                  </select>
                </Field>
                {loginHistory.length > 0 && (
                  <div className="access-history-actions">
                    <span aria-live="polite">
                      {historyIndex === ""
                        ? "仅保留登录码末四位和登录时间。"
                        : "请输入完整登录码，授权期内可以重新登录。"}
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
