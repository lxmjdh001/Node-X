import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Archive, ArrowLeft, Check, Inbox, Link2, RefreshCw, Search, Send, Tag, Users } from "lucide-react";
import { Button, Dialog, Field, Icon, IconButton } from "./ui";
import "./dm-workspace.css";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Account = { id: string; label: string; username: string; connected: boolean; lastSyncAt: string | null };
type ConnectAccount = Pick<Account, "id" | "label" | "username"> & Partial<Pick<Account, "connected">>;
type ConnectionStatus = {
  status: "unconfigured" | "awaiting_authorization" | "idle" | "starting" | "syncing" | "online" | "offline" | "failed";
  message?: string;
  paired: boolean;
  selfConfigured?: boolean;
  hosted?: boolean;
  expectedUsername?: string;
};
type BridgeConfiguration = {
  matrixUrl: string;
  bridgeProvisioningUrl: string;
  matrixAccessToken: string;
  username: string;
};
type Conversation = {
  id: string;
  accountId: string;
  title: string;
  preview: string;
  updatedAt: string;
  status: "open" | "resolved";
  unread: boolean;
  labels: string[];
};
type Message = {
  id: string;
  text: string;
  sender: string;
  createdAt: string;
  direction: "in" | "out";
  status?: "queued" | "sent" | "failed" | "uncertain";
};
type InboxData = { accounts: Account[]; conversations: Conversation[]; before?: string | null };
type MessagePage = { messages: Message[]; before: string | null };
type BulkAction = "resolve" | "reopen" | "read" | "label" | "unlabel";

const emptyInbox: InboxData = { accounts: [], conversations: [] };
const shortDate = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const sendStatus = { queued: "等待连接器发送", sent: "已发送", failed: "发送失败", uncertain: "结果待确认" };
const connectionMessages: Record<ConnectionStatus["status"], string> = {
  unconfigured: "此账号还未配置私信桥接。",
  awaiting_authorization: "请在 mautrix-manager 中完成此账号的 X 授权，Node X 会自动检查。",
  idle: "已找到此账号的私信桥接。连接后可在私信工作室查看消息。",
  starting: "正在启动私信连接。",
  syncing: "已连接桥接，正在等待首次同步。",
  online: "已连接，可在私信工作室查看和回复消息。",
  offline: "私信连接已离线，可尝试重新连接。",
  failed: "连接失败，请重试。",
};

function connecting(status?: ConnectionStatus["status"]) {
  return status === "starting" || status === "syncing";
}

function shouldCheckConnection(status: ConnectionStatus["status"]) {
  return connecting(status) || status === "awaiting_authorization";
}

const usernamePattern = "@?[A-Za-z0-9_]{1,15}";
const validUsername = new RegExp(`^${usernamePattern}$`);

function normalizedUsername(username: string) {
  return username.trim().replace(/^@/, "");
}

function time(value: string, format = shortDate) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : format.format(date);
}

function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return <span className={`dm-avatar${large ? " dm-avatar-large" : ""}`} aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase() || "X"}</span>;
}

export function DmWorkspace({ request, initialAccountId = "", onManageAccounts }: {
  request: Request;
  initialAccountId?: string;
  onManageAccounts: () => void;
}) {
  const [data, setData] = useState<InboxData>(emptyInbox);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accountId, setAccountId] = useState(initialAccountId);
  const [cursors, setCursors] = useState<string[]>([]);
  const [activeId, setActiveId] = useState("");
  const [mobileThread, setMobileThread] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [checked, setChecked] = useState<string[]>([]);
  const [editingLabel, setEditingLabel] = useState(false);
  const [label, setLabel] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [pair, setPair] = useState(false);
  const listRevision = useRef(0);
  const drafts = useRef(new Map<string, { text: string; requestId?: string }>());
  const threadTrigger = useRef<HTMLButtonElement | null>(null);
  const cursor = cursors.at(-1);

  const reload = useCallback(async (manual = false) => {
    const revision = ++listRevision.current;
    if (manual) setRefreshing(true);
    try {
      const query = new URLSearchParams();
      if (accountId) query.set("accountId", accountId);
      if (cursor) query.set("before", cursor);
      const next = await request<InboxData>(`/api/dm/inbox${query.size ? `?${query}` : ""}`);
      if (listRevision.current !== revision) return;
      setData(next);
      setError("");
    } catch (cause) {
      if (listRevision.current === revision) setError((cause as Error).message);
    } finally {
      if (listRevision.current === revision) {
        setLoaded(true);
        setRefreshing(false);
      }
    }
  }, [request, accountId, cursor]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 6000);
    return () => {
      window.clearInterval(timer);
      listRevision.current++;
    };
  }, [reload]);

  const accounts = new Map(data.accounts.map(account => [account.id, account]));
  const scopingAccount = accounts.get(accountId);
  const active = data.conversations.find(conversation => conversation.id === activeId);
  const activeAccount = active && accounts.get(active.accountId);
  const needle = query.trim().toLowerCase();
  const conversations = data.conversations.filter(conversation => {
    if (accountId && conversation.accountId !== accountId) return false;
    if (filter === "unread" ? !conversation.unread : filter !== "all" && conversation.status !== filter) return false;
    return !needle || [
      conversation.title, conversation.preview, accounts.get(conversation.accountId)?.label, ...conversation.labels,
    ].some(value => value?.toLowerCase().includes(needle));
  });
  const selected = checked.filter(id => conversations.some(conversation => conversation.id === id));
  const clearSelection = () => setChecked([]);
  const online = data.accounts.filter(account => account.connected).length;
  const unread = data.conversations.filter(conversation => (!accountId || conversation.accountId === accountId) && conversation.unread).length;

  function showAccount(id: string) {
    if (id === accountId && !cursors.length) return;
    changePage([]);
    setAccountId(id);
  }

  function changePage(next: string[]) {
    listRevision.current++;
    setCursors(next);
    setData(current => ({ accounts: current.accounts, conversations: [] }));
    setLoaded(false);
    setActiveId("");
    setMobileThread(false);
    clearSelection();
  }

  async function apply(action: BulkAction, ids = selected, value?: string) {
    if (!ids.length || bulkBusy) return;
    setBulkBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await request<{ updated?: number }>("/api/dm/conversations/bulk-update", "POST",
        { ids, action, ...(value ? { label: value } : {}) });
      setNotice(`已处理 ${result.updated ?? ids.length} 个会话。`);
      setEditingLabel(false);
      setLabel("");
      clearSelection();
      await reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  function returnToList() {
    setMobileThread(false);
    requestAnimationFrame(() => threadTrigger.current?.focus());
  }

  return (
    <section className="dm-page-content" aria-label="X 私信工作台">
      {(error || notice) && <div className={`dm-feedback${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</div>}
      <div className={`dm-workspace${mobileThread && active ? " dm-show-thread" : ""}`}>
        <aside className="dm-accounts" aria-label="X 账号列表">
          <header className="dm-pane-heading">
            <h2>X 账号</h2>
            <IconButton label="连接私信账号" icon={Link2} disabled={!data.accounts.length} onClick={() => setPair(true)} />
          </header>
          <div className="dm-account-scroll">
            <button type="button" className="dm-account-row" aria-pressed={!accountId} onClick={() => showAccount("")}>
              <span className="dm-avatar dm-avatar-all"><Icon icon={Users} size={17} /></span>
              <span className="dm-row-copy"><strong>全部账号</strong><small>{online} 个已连接</small></span>
            </button>
            {data.accounts.map(account => (
              <button key={account.id} type="button" className="dm-account-row" aria-pressed={accountId === account.id}
                onClick={() => showAccount(account.id)}>
                <Avatar name={account.label} />
                <span className="dm-row-copy">
                  <strong>{account.label}</strong>
                  <small>{account.username ? `@${account.username}` : account.connected ? "已连接" : "未连接"}</small>
                </span>
                <span className={`dm-presence${account.connected ? " is-online" : ""}`} title={account.connected ? "已连接" : "未连接"}>
                  <span className="sr-only">{account.connected ? "已连接" : "未连接"}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="dm-account-actions">
            <Button type="button" variant="ghost" icon={Link2} onClick={() => data.accounts.length ? setPair(true) : onManageAccounts()}>
              {data.accounts.length ? "连接账号" : "前往窗口管理"}
            </Button>
          </div>
        </aside>

        <section className="dm-conversations" aria-label="私信会话列表">
          <header className="dm-pane-heading">
            <h2>会话{unread > 0 && <span className="dm-count" aria-label={`${unread} 个未读会话`}>{unread}</span>}</h2>
            <div className="dm-heading-actions">
              <IconButton className="dm-mobile-connect" label="连接私信账号" icon={Link2}
                disabled={!data.accounts.length} onClick={() => setPair(true)} />
              <IconButton label="刷新私信" icon={RefreshCw} disabled={refreshing} onClick={() => void reload(true)} />
            </div>
          </header>
          <div className="dm-list-controls">
            <label className="dm-mobile-account">
              <span className="sr-only">选择 X 账号</span>
              <select value={accountId} onChange={event => showAccount(event.target.value)}>
                <option value="">全部账号</option>
                {data.accounts.map(account => <option value={account.id} key={account.id}>{account.label}</option>)}
              </select>
            </label>
            <label className="dm-search">
              <Icon icon={Search} size={16} />
              <input aria-label="搜索私信会话" value={query} placeholder="搜索会话、消息或标签" onChange={event => { setQuery(event.target.value); clearSelection(); }} />
            </label>
            <div className="dm-filters" aria-label="筛选会话">
              {[["all", "全部"], ["unread", "未读"], ["open", "待处理"], ["resolved", "已处理"]].map(([value, labelText]) => (
                <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); clearSelection(); }}>{labelText}</button>
              ))}
            </div>
          </div>
          {conversations.length > 0 && (
            <div className="dm-selection">
              <label>
                <input type="checkbox" checked={selected.length === conversations.length}
                  onChange={event => setChecked(event.target.checked ? conversations.map(item => item.id) : [])} />
                {selected.length ? `已选 ${selected.length} 项` : "全选本页"}
              </label>
              {selected.length > 0 && (
                <div className="dm-bulk-actions">
                  <IconButton label="批量标为已读" icon={Check} disabled={bulkBusy} onClick={() => void apply("read")} />
                  <IconButton label="批量标记已处理" icon={Archive} disabled={bulkBusy} onClick={() => void apply("resolve")} />
                  <IconButton label="批量重新打开" icon={RefreshCw} disabled={bulkBusy} onClick={() => void apply("reopen")} />
                  <IconButton label="批量添加标签" icon={Tag} disabled={bulkBusy} onClick={() => setEditingLabel(true)} />
                </div>
              )}
            </div>
          )}
          <div className="dm-conversation-scroll">
            {!loaded ? <p className="dm-list-empty" role="status">正在读取会话…</p> : conversations.length ? conversations.map(conversation => {
              const source = accounts.get(conversation.accountId);
              return (
                <article key={conversation.id} className={`dm-conversation-row${activeId === conversation.id ? " is-active" : ""}`}>
                  <label className="dm-check">
                    <input type="checkbox" aria-label={`选择 ${conversation.title}`} checked={selected.includes(conversation.id)}
                      onChange={event => setChecked(event.target.checked ? [...selected, conversation.id] : selected.filter(id => id !== conversation.id))} />
                  </label>
                  <button type="button" className="dm-conversation-open" aria-current={activeId === conversation.id ? "true" : undefined}
                    onClick={event => { threadTrigger.current = event.currentTarget; setActiveId(conversation.id); setMobileThread(true); }}>
                    <Avatar name={conversation.title} />
                    <span className="dm-row-copy">
                      <span className="dm-conversation-summary"><strong>{conversation.title}</strong><small>{time(conversation.updatedAt)}</small></span>
                      <small className="dm-preview">{conversation.preview || "暂无消息"}</small>
                      <span className="dm-conversation-meta">
                        {source && <span>{source.username ? `@${source.username}` : source.label}</span>}
                        {conversation.labels.slice(0, 2).map(tag => <span key={tag}>{tag}</span>)}
                        {conversation.unread && <span className="dm-unread-dot"><span className="sr-only">未读</span></span>}
                      </span>
                    </span>
                  </button>
                </article>
              );
            }) : <p className="dm-list-empty">
              {query || filter !== "all" ? "没有匹配的会话" : "暂无会话"}
            </p>}
          </div>
          {(data.before || cursors.length > 0) && (
            <nav className="dm-page-nav" aria-label="会话分页">
              <Button type="button" variant="ghost" disabled={!cursors.length} onClick={() => changePage(cursors.slice(0, -1))}>上一页</Button>
              <Button type="button" variant="ghost" disabled={!data.before} onClick={() => {
                if (data.before) changePage([...cursors, data.before]);
              }}>下一页</Button>
            </nav>
          )}
        </section>

        {active ? (
          <DmThread key={active.id} conversation={active} account={activeAccount} request={request}
            savedDraft={drafts.current} back={returnToList} reload={reload}
            changeStatus={action => void apply(action, [active.id])} bulkBusy={bulkBusy} />
        ) : (
          <section className="dm-thread dm-thread-empty" aria-label="会话详情">
            <div className="dm-empty-content">
              <span className="dm-empty-icon"><Icon icon={Inbox} size={31} /></span>
              <h2>{online || data.conversations.length ? "选择一个会话" : "连接 X 私信"}</h2>
              <p>{online || data.conversations.length ? "在左侧选择会话，查看消息并回复。" : "连接账号后，同步的 X 私信会出现在这里。"}</p>
              {!online && <Button variant="primary" icon={Link2} onClick={() => data.accounts.length ? setPair(true) : onManageAccounts()}>
                {data.accounts.length ? "连接账号" : "前往窗口管理"}
              </Button>}
            </div>
          </section>
        )}
      </div>
      {editingLabel && (
        <Dialog title="批量添加标签" description={`应用到 ${selected.length} 个会话。`} onClose={() => !bulkBusy && setEditingLabel(false)}>
          <form onSubmit={event => { event.preventDefault(); void apply("label", selected, label.trim()); }}>
            <div className="dialog-body"><Field label="标签名称"><input autoFocus maxLength={32} required value={label} onChange={event => setLabel(event.target.value)} /></Field></div>
            <div className="dialog-footer">
              <Button type="button" onClick={() => setEditingLabel(false)} disabled={bulkBusy}>取消</Button>
              <Button type="submit" variant="primary" disabled={!label.trim() || !selected.length} busy={bulkBusy}>添加标签</Button>
            </div>
          </form>
        </Dialog>
      )}
      {pair && <DmConnect accounts={data.accounts} initialAccount={scopingAccount?.id} request={request} close={() => { setPair(false); void reload(); }} />}
    </section>
  );
}

function DmThread({ conversation, account, request, savedDraft, back, reload, changeStatus, bulkBusy }: {
  conversation: Conversation;
  account?: Account;
  request: Request;
  savedDraft: Map<string, { text: string; requestId?: string }>;
  back: () => void;
  reload: () => Promise<void>;
  changeStatus: (action: "resolve" | "reopen") => void;
  bulkBusy: boolean;
}) {
  const { id } = conversation;
  const [recent, setRecent] = useState<Message[]>([]);
  const [earlier, setEarlier] = useState<Message[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>();
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState(savedDraft.get(id)?.text || "");
  const [sending, setSending] = useState(false);
  const revision = useRef(0);
  const messagePane = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const recentIds = new Set(recent.map(message => message.id));
  const messages = [...earlier.filter(message => !recentIds.has(message.id)), ...recent];
  const tail = messages.at(-1)?.id;

  const load = useCallback(async () => {
    const current = ++revision.current;
    try {
      const result = await request<MessagePage>(`/api/dm/conversations/${id}/messages`);
      if (revision.current === current) {
        setRecent(result.messages);
        setNextBefore(result.before);
        setLoadError("");
        setLoaded(true);
      }
    } catch (cause) {
      if (revision.current === current) {
        setLoadError((cause as Error).message);
        setLoaded(true);
      }
    }
  }, [id, request]);
  useEffect(() => {
    void load();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 3500);
    return () => { window.clearInterval(poll); revision.current++; };
  }, [load]);

  useEffect(() => {
    const pane = messagePane.current;
    if (pane && nearBottom.current) pane.scrollTop = pane.scrollHeight;
  }, [tail]);

  const before = olderCursor === undefined ? nextBefore : olderCursor;
  async function loadOlder() {
    if (!before || loadingOlder) return;
    setLoadingOlder(true);
    setError("");
    try {
      const result = await request<MessagePage>(`/api/dm/conversations/${id}/messages?before=${encodeURIComponent(before)}`);
      const pane = messagePane.current;
      const previousHeight = pane?.scrollHeight ?? 0;
      const previousTop = pane?.scrollTop ?? 0;
      setEarlier(previous => [...result.messages, ...previous]);
      setOlderCursor(result.before);
      requestAnimationFrame(() => {
        if (pane) pane.scrollTop = previousTop + pane.scrollHeight - previousHeight;
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim() || sending || !account?.connected) return;
    const text = draft.trim();
    const current = savedDraft.get(id);
    const requestId = current?.text.trim() === text && current.requestId ? current.requestId : crypto.randomUUID();
    savedDraft.set(id, { text: draft, requestId });
    setError("");
    setSending(true);
    try {
      await request(`/api/dm/conversations/${id}/replies`, "POST", { text, requestId });
      if (savedDraft.get(id)?.requestId === requestId) savedDraft.delete(id);
      setDraft("");
      nearBottom.current = true;
      await Promise.all([load(), reload()]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="dm-thread" aria-label="会话详情">
      <header className="dm-thread-heading">
        <IconButton label="返回会话列表" icon={ArrowLeft} className="dm-back" onClick={back} />
        <Avatar name={conversation.title} large />
        <div className="dm-row-copy">
          <h2>{conversation.title}</h2>
          <small>{account?.username ? `@${account.username}` : account?.label || "X 私信"}{conversation.status === "resolved" ? " · 已处理" : ""}</small>
        </div>
        <IconButton label={conversation.status === "resolved" ? "重新打开会话" : "标记已处理"}
          icon={conversation.status === "resolved" ? RefreshCw : Archive} disabled={bulkBusy}
          onClick={() => changeStatus(conversation.status === "resolved" ? "reopen" : "resolve")} />
      </header>
      <div className="dm-messages" ref={messagePane} aria-label="消息记录" onScroll={event => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        nearBottom.current = scrollHeight - scrollTop - clientHeight < 80;
      }}>
        {before && <Button type="button" className="dm-history-button" variant="ghost" busy={loadingOlder}
          onClick={() => void loadOlder()}>加载更早的消息</Button>}
        {!loaded && <p className="dm-list-empty">正在读取消息…</p>}
        {loaded && !messages.length && <p className="dm-list-empty">暂无已同步的消息</p>}
        {messages.map(message => (
          <article key={message.id} className={`dm-message dm-message-${message.direction}`}>
            {message.direction === "in" && <Avatar name={message.sender || conversation.title} />}
            <div>
              {message.direction === "in" && message.sender && <small className="dm-message-sender">{message.sender}</small>}
              <p className="dm-bubble">{message.text}</p>
              <small className="dm-message-time">
                <time dateTime={message.createdAt} title={time(message.createdAt)}>{time(message.createdAt, clock)}</time>
                {message.status && <span>{sendStatus[message.status]}</span>}
              </small>
            </div>
          </article>
        ))}
      </div>
      {(error || loadError) && <p className="dm-thread-error" role="alert">{error || loadError}</p>}
      <form className="dm-composer" onSubmit={send}>
        <textarea aria-label="回复内容" placeholder={account?.connected ? "输入回复…" : "连接该账号后可发送回复"}
          rows={2} maxLength={4000} value={draft} disabled={sending} onChange={event => {
            setDraft(event.target.value);
            savedDraft.set(id, { text: event.target.value });
          }} />
        <div>
          <span>{account?.connected ? "回复将从当前会话所属账号发送" : "私信连接器离线"}</span>
          <Button variant="primary" icon={Send} type="submit" busy={sending} disabled={!draft.trim() || !account?.connected}>发送</Button>
        </div>
      </form>
    </section>
  );
}

export function DmConnect({ accounts, initialAccount, request, close, openInbox, autoStart = false }: {
  accounts: ConnectAccount[];
  initialAccount?: string;
  request: Request;
  close: () => void;
  openInbox?: (accountId: string) => void;
  autoStart?: boolean;
}) {
  const [accountId, setAccountId] = useState(initialAccount ?? accounts.find(account => !account.connected)?.id ?? accounts[0]?.id ?? "");
  const [connection, setConnection] = useState<ConnectionStatus>();
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [checkPaused, setCheckPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [editingConfiguration, setEditingConfiguration] = useState(false);
  const [error, setError] = useState("");
  const startOnFirstCheck = useRef(autoStart && accounts.length === 1);
  const account = accounts.find(item => item.id === accountId);
  const status = connection?.status;
  const awaitingAuthorization = status === "awaiting_authorization";
  const pending = connecting(status);
  const canConfigure = Boolean(account && status && !connection?.hosted && !connection?.paired &&
    !pending && !awaitingAuthorization && status !== "online");
  const canEditConfiguration = canConfigure && connection?.selfConfigured;
  const showConfiguration = canConfigure && (status === "unconfigured" || (editingConfiguration && canEditConfiguration));
  const path = `/api/dm/accounts/${accountId}/connect`;

  const startConnection = useCallback(async (configuration?: BridgeConfiguration) => {
    setBusy(true);
    setError("");
    try {
      const next = await request<ConnectionStatus>(configuration ? `${path}-config` : path, "POST", configuration ?? {});
      setConnection(next);
      setEditingConfiguration(false);
      if (shouldCheckConnection(next.status)) setCheckAttempt(attempt => attempt + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, [path, request]);

  useEffect(() => {
    if (!accountId || disconnecting) return;
    let active = true;
    let timeout: number | undefined;
    let remainingChecks = 15;
    setCheckPaused(false);
    setError("");

    async function checkStatus() {
      try {
        const next = await request<ConnectionStatus>(path);
        if (!active) return;
        setConnection(next);
        if (startOnFirstCheck.current && next.status !== "awaiting_authorization") {
          startOnFirstCheck.current = false;
          if (next.status === "idle") {
            await startConnection();
            return;
          }
        }
        if (!shouldCheckConnection(next.status)) return;
        if (remainingChecks-- > 0) {
          timeout = window.setTimeout(() => void checkStatus(), next.status === "awaiting_authorization" ? 6000 : 3000);
        } else {
          setCheckPaused(true);
        }
      } catch (cause) {
        if (!active) return;
        setError((cause as Error).message);
        setCheckPaused(true);
      }
    }

    void checkStatus();
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [accountId, checkAttempt, disconnecting, path, request, startConnection]);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || !status || busy || disconnecting || pending || awaitingAuthorization || checkPaused || status === "online") return;
    if (showConfiguration) {
      const fields = new FormData(event.currentTarget);
      void startConnection({
        matrixUrl: String(fields.get("matrixUrl") ?? "").trim(),
        bridgeProvisioningUrl: String(fields.get("bridgeProvisioningUrl") ?? "").trim(),
        matrixAccessToken: String(fields.get("matrixAccessToken") ?? "").trim(),
        username: normalizedUsername(String(fields.get("username") ?? "")),
      });
      return;
    }
    if (status === "unconfigured") return;
    void startConnection();
  }

  async function disconnect() {
    if (!account || busy) return;
    setBusy(true);
    setError("");
    try {
      await request(`/api/dm/accounts/${accountId}/disconnect`, "POST", {});
      if (connection?.selfConfigured && !connection.hosted) {
        setConnection(undefined);
        setDisconnecting(false);
      } else {
        close();
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const username = account?.username.trim() ?? "";
  const expectedUsername = connection?.expectedUsername?.trim() || username;
  const statusMessage = !account ? "请选择要连接的 X 账号。" : connection?.message ||
    (awaitingAuthorization && validUsername.test(expectedUsername)
      ? `请在 mautrix-manager 中完成 @${normalizedUsername(expectedUsername)} 的 X 授权，Node X 会自动检查。`
      : status ? connectionMessages[status] : "正在检查私信连接状态…");

  return (
    <Dialog title={disconnecting ? "断开私信连接" : "连接 X 私信"}
      description={disconnecting ? `停止「${account?.label}」的私信同步和发送，保留已同步的记录。` : undefined}
      onClose={() => !busy && close()}>
      <form onSubmit={connect} autoComplete="off">
        <div className="dialog-body dm-connect-body" hidden={disconnecting}>
          {accounts.length === 1 && account ? (
            <Field label="X 账号"><input readOnly value={account.label} /></Field>
          ) : (
            <Field label="X 账号">
              <select value={account ? accountId : ""} disabled={busy} onChange={event => {
                setAccountId(event.target.value);
                setConnection(undefined);
                setEditingConfiguration(false);
                setCheckPaused(false);
                setError("");
              }}>
                {!account && <option value="">选择 X 账号</option>}
                {accounts.map(account => <option value={account.id} key={account.id}>{account.label}{account.connected ? "（已连接）" : ""}</option>)}
              </select>
            </Field>
          )}
          {showConfiguration && (
            <fieldset className="dm-connect-config" key={accountId} disabled={busy || disconnecting}>
              <p className="subtle">先在 mautrix 桥接中登录当前 X 账号，再填写以下信息。</p>
              <Field label="Matrix HTTPS 地址">
                <input type="url" name="matrixUrl" placeholder="https://matrix.example.com" pattern="https://.+" required />
              </Field>
              <Field label="mautrix 配置接口 HTTPS 地址">
                <input type="url" name="bridgeProvisioningUrl" placeholder="https://bridge.example.com/_matrix/provision" pattern="https://.+" required />
              </Field>
              <Field label="Matrix 访问令牌">
                <input type="password" name="matrixAccessToken" autoComplete="new-password" required />
              </Field>
              <Field label="X 用户名">
                <input name="username" defaultValue={validUsername.test(username) ? normalizedUsername(username) : ""}
                  pattern={usernamePattern} maxLength={16} autoCapitalize="none" spellCheck={false} required />
              </Field>
            </fieldset>
          )}
          {error || (!showConfiguration && status === "failed")
            ? <p className="form-error" role="alert">{error || statusMessage}</p>
            : !showConfiguration && <p className="subtle" role="status">{statusMessage}</p>}
          {checkPaused && pending && !error && <p className="subtle">后台仍在连接。可以关闭弹窗，稍后回来查看，或立即刷新状态。</p>}
          {checkPaused && awaitingAuthorization && !error && <p className="subtle">已暂停自动检查。完成授权后可手动刷新状态。</p>}
        </div>
        {disconnecting && error && <p className="form-error dialog-body" role="alert">{error}</p>}
        <div className="dialog-footer">
          <Button type="button" disabled={busy} onClick={() => {
            if (disconnecting) setDisconnecting(false);
            else if (editingConfiguration) {
              setEditingConfiguration(false);
              setError("");
            } else close();
          }}>{disconnecting || editingConfiguration ? "取消" : "关闭"}</Button>
          {disconnecting ? <Button type="button" variant="danger" busy={busy} onClick={() => void disconnect()}>断开连接</Button> : (
            <div>
              {account && connection?.paired && <Button type="button" variant="ghost" disabled={busy}
                onClick={() => { setError(""); setDisconnecting(true); }}>断开连接</Button>}
              {canEditConfiguration && !showConfiguration && <Button type="button" variant="ghost" disabled={busy}
                onClick={() => { setError(""); setEditingConfiguration(true); }}>更新配置</Button>}
              {account && (checkPaused || awaitingAuthorization) ? (
                <Button type="button" variant="primary" icon={RefreshCw} disabled={busy} onClick={() => setCheckAttempt(attempt => attempt + 1)}>刷新状态</Button>
              ) : showConfiguration ? (
                <Button type="submit" variant="primary" icon={Link2} busy={busy}>保存并连接</Button>
              ) : account && status === "online" && openInbox ? (
                <Button type="button" variant="primary" icon={Inbox} onClick={() => openInbox(accountId)}>打开私信</Button>
              ) : account && status !== "unconfigured" && status !== "online" ? (
                <Button type="submit" variant="primary" icon={Link2} busy={busy || pending || !status}>
                  {!status ? "检查连接" : pending || busy ? "正在连接" : status === "failed" || status === "offline" ? "重新连接" : "连接私信"}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </form>
    </Dialog>
  );
}
