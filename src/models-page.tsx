import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { isQwenProvider, modelProviders, type ModelProviderId, type ModelPurpose, type ModelSettings, type WorkspaceModel } from "./model-catalog";
import { Button, Dialog, Field, IconButton } from "./ui";

type ModelRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

export function ModelPage({ requestModel, global = false, onChange }: {
  requestModel: ModelRequest;
  global?: boolean;
  onChange?: () => Promise<void>;
}) {
  const [data, setData] = useState<ModelSettings | null>(null);
  const [open, setOpen] = useState<WorkspaceModel | "new" | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceModel | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  async function load() {
    setMessage(null);
    try {
      setData(await requestModel<ModelSettings>("/models"));
    } catch (error) {
      setMessage({ text: (error as Error).message, error: true });
    }
  }

  useEffect(() => { void load(); }, []);

  async function update(path: string, method: string, body: unknown, success: string) {
    setBusy(path);
    setMessage(null);
    try {
      const next = await requestModel<ModelSettings>(path, method, body);
      if (path.endsWith("/test")) {
        setMessage({ text: success });
        return;
      }
      setData(next);
      setDeleting(null);
      setMessage({ text: success });
      await onChange?.();
    } catch (error) {
      setMessage({ text: (error as Error).message, error: true });
    } finally {
      setBusy("");
    }
  }

  function defaultField(purpose: ModelPurpose, label: string, hint: string) {
    const shared = data?.shared;
    const inherited = shared?.models.find(model => model.id === shared.defaults[purpose]);
    const emptyLabel = inherited ? `跟随全局默认 · ${inherited.model}`
      : purpose === "writing" && data?.legacyWriting ? "服务器默认模型"
      : global ? "未设置" : "跟随全局默认（未设置）";
    return (
      <Field label={label} hint={hint}>
        <select value={data?.defaults[purpose] ?? ""} disabled={(!data?.models.length && !shared?.models.length) || !!busy}
          onChange={(event) => void update("/models-defaults", "PATCH", {
            purpose, modelId: event.target.value || null,
          }, "默认模型已更新。")}>
          <option value="">{emptyLabel}</option>
          {data?.models.length ? (
            <optgroup label={global ? "全局模型" : "当前工作空间的模型"}>
              {data.models.map(model => <option value={model.id} key={model.id}>{modelProviders[model.provider].name} · {model.model}</option>)}
            </optgroup>
          ) : null}
          {shared?.models.length ? (
            <optgroup label="管理员提供的全局模型">
              {shared.models.map(model => <option value={model.id} key={model.id}>{modelProviders[model.provider].name} · {model.model}</option>)}
            </optgroup>
          ) : null}
        </select>
      </Field>
    );
  }

  return (
    <div className="model-page">
      <section className="panel model-panel">
        <h2>{global ? "全局默认模型" : "默认模型"}</h2>
        {global && <p className="subtle model-description">所有登录码都可使用这些模型。工作空间可自行选择模型，未单独选择时使用全局默认。</p>}
        <div className="model-defaults">
          {defaultField("writing", "写作模型", "用于生成草稿和相似稿。")}
          {defaultField("publishing", "发布审核模型", "在草稿里点击「AI 审核」时检查正文并给出建议。")}
        </div>
      </section>
      <section className="panel model-panel">
        <div className="model-list-heading">
          <h2>{global ? "全局模型" : "当前工作空间添加的模型"}</h2>
          <Button icon={Plus} variant="primary" disabled={!data || !!busy} onClick={() => setOpen("new")}>添加模型</Button>
        </div>
        {message && <p role={message.error ? "alert" : "status"}
          className={message.error ? "form-error" : "model-feedback"}>{message.text}</p>}
        {!data ? (message?.error ? <Button onClick={() => void load()}>重试</Button> : <p role="status">正在读取模型配置…</p>) :
          data.models.length === 0 ? <p className="subtle">{global
            ? "添加全局模型后，可将它设为全站默认。"
            : "可以添加自己的 API Key，也可以直接选择管理员提供的模型。"}</p> : (
            <ul className="model-list">
              {data.models.map(model => {
                const testPath = `/models/${model.id}/test`;
                return (
                  <li key={model.id}>
                    <div className="model-name">
                      <strong>{modelProviders[model.provider].name}</strong>
                      <code>{model.model}</code>
                    </div>
                    <div className="row-actions">
                      <Button busy={busy === testPath} disabled={!!busy}
                        onClick={() => void update(testPath, "POST", {}, `${model.model} 连接成功。`)}>测试连接</Button>
                      <Button icon={Pencil} variant="ghost" disabled={!!busy} onClick={() => setOpen(model)}>编辑</Button>
                      <IconButton icon={Trash2} label={`删除 ${model.model}`} disabled={!!busy} onClick={() => setDeleting(model)} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
      </section>
      {open && <ModelForm requestModel={requestModel} global={global} item={open === "new" ? undefined : open} onClose={() => setOpen(null)} onSaved={async next => {
        setData(next);
        setOpen(null);
        setMessage({ text: "模型已保存。" });
        await onChange?.();
      }} />}
      {deleting && (
        <Dialog title="删除模型" description={`删除 ${deleting.model} 及其 API Key。使用此模型的默认项也会清除。`}
          onClose={() => { if (!busy) setDeleting(null); }}>
          <div className="dialog-footer">
            <Button disabled={!!busy} onClick={() => setDeleting(null)}>取消</Button>
            <Button variant="danger" busy={!!busy} disabled={!!busy}
              onClick={() => void update(`/models/${deleting.id}`, "DELETE", undefined, "模型已删除。")}>删除模型</Button>
          </div>
          {message?.error && <p className="form-error" role="alert">{message.text}</p>}
        </Dialog>
      )}
    </div>
  );
}

function ModelForm({ item, global, requestModel, onClose, onSaved }: {
  item?: WorkspaceModel;
  global: boolean;
  requestModel: ModelRequest;
  onClose: () => void;
  onSaved: (data: ModelSettings) => Promise<void>;
}) {
  const [provider, setProvider] = useState<ModelProviderId>(item?.provider ?? "openai");
  const [model, setModel] = useState(item?.model ?? modelProviders.openai.models[0]);
  const [key, setKey] = useState("");
  const [providerWorkspace, setProviderWorkspace] = useState(item?.providerWorkspace ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const entry = modelProviders[provider];
  const needsKey = !item || item.provider !== provider;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await requestModel<ModelSettings>(item ? `/models/${item.id}` : "/models", item ? "PATCH" : "POST", {
        provider, model, apiKey: key.trim() || undefined,
        providerWorkspace: isQwenProvider(provider) ? providerWorkspace.trim() || (item ? null : undefined) : undefined,
      });
      await onSaved(next);
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={item ? "编辑模型" : "添加模型"} onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={save}>
        <div className="dialog-body">
          <Field label="服务商">
            <select autoFocus={!item} disabled={busy} value={provider} onChange={event => {
              const next = event.target.value as ModelProviderId;
              setProvider(next);
              const presets = modelProviders[next].models;
              if (!presets.includes(model)) setModel(presets[0] ?? "");
              setKey("");
              setProviderWorkspace(item?.provider === next ? item.providerWorkspace ?? "" : "");
            }}>
              {Object.entries(modelProviders).map(([id, value]) => <option key={id} value={id}>{value.name}</option>)}
            </select>
          </Field>
          {entry.models.length > 0 && (
            <Field label="预设模型">
              <select disabled={busy} value={entry.models.includes(model) ? model : ""} onChange={event => setModel(event.target.value)}>
                <option value="">手动填写</option>
                {entry.models.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </Field>
          )}
          <Field label="模型 ID" hint={provider === "doubao" ? "可填写火山方舟控制台中的模型 ID 或推理接入点 ID（ep-…）。" : undefined}>
            <input required maxLength={180} disabled={busy} value={model} spellCheck={false} onChange={event => setModel(event.target.value)} />
          </Field>
          {isQwenProvider(provider) && (
            <Field label="百炼工作空间 ID（选填）" hint="使用工作空间专用 API 地址的百炼账号请填写此项。">
              <input maxLength={63} disabled={busy} value={providerWorkspace} spellCheck={false}
                onChange={event => setProviderWorkspace(event.target.value)} />
            </Field>
          )}
          <Field label="API Key" hint={item && needsKey ? "请填写新服务商签发的 API Key。" : !needsKey
            ? "留空可保留已保存的 API Key。"
            : provider === "fnewapi" ? "填写顺奥第三方平台签发的 API Key。"
            : global ? "密钥由服务端加密保存。全局调用使用这个 API Key 的额度。"
            : "API Key 加密保存在当前工作空间。"}>
            <input type="password" autoComplete="new-password" autoFocus={!!item} required={needsKey}
              maxLength={2048} disabled={busy} value={key} onChange={event => setKey(event.target.value)} />
          </Field>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-footer">
          <Button type="button" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={busy || !model.trim() || (needsKey && !key.trim())}>保存模型</Button>
        </div>
      </form>
    </Dialog>
  );
}
