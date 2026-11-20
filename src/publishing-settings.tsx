import { useEffect, useState, type FormEvent } from "react";
import { Copy } from "lucide-react";
import { publishingMethods, type PublishingMethod, type PublishingSettings } from "./publishing";
import { Button, Field } from "./ui";

export function PublishingSettingsPanel({ request }: {
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
}) {
  const [settings, setSettings] = useState<PublishingSettings | null>(null);
  const [method, setMethod] = useState<PublishingMethod>("official");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function apply(next: PublishingSettings) {
    setSettings(next);
    setMethod(next.method);
    setClientId(next.clientId);
    setSecret("");
    setClearSecret(false);
  }

  async function load() {
    setError("");
    try {
      apply(await request<PublishingSettings>("publishing"));
    } catch (error) {
      setError((error as Error).message);
    }
  }

  useEffect(() => { void load(); }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const details = method === "official"
        ? { method, clientId, clientSecret: clearSecret ? null : secret.trim() || undefined }
        : { method };
      apply(await request<PublishingSettings>("publishing", details, "PATCH"));
      setNotice("发布流程已保存。");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel model-panel">
      <h2>发布接口</h2>
      {!settings && (error ? <Button onClick={() => void load()}>重试</Button> : <p role="status">正在读取发布配置…</p>)}
      {settings && (
        <form className="publishing-settings-form" onSubmit={save}>
          <Field label="接口选择" hint={method === "official" && settings.xConfigured ? "官方 API 已启用，各账号可在窗口管理里连接 X。" : undefined}>
            <select value={method} disabled={saving} onChange={event => setMethod(event.target.value as PublishingMethod)}>
              {Object.entries(publishingMethods).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          {method === "mcp" ? (
            <p className="subtle">大模型 MCP 待接入。选择此模式会暂停官方 API 队列，切回官方 API 后继续处理。</p>
          ) : (
            <>
              <Field label="X OAuth Client ID">
                <input value={clientId} maxLength={250} disabled={saving}
                  autoComplete="off" spellCheck={false} onChange={event => setClientId(event.target.value)} />
              </Field>
              <Field label="X OAuth Client Secret（选填）" hint={settings.hasClientSecret && clientId.trim() === settings.clientId
                ? "留空会沿用已保存的 Secret。" : "公共客户端可留空。"}>
                <input value={secret} maxLength={1024} autoComplete="new-password" type="password"
                  disabled={saving || clearSecret} onChange={event => setSecret(event.target.value)} />
              </Field>
              {settings.hasClientSecret && (
                <label className="checkbox-field">
                  <input type="checkbox" checked={clearSecret} disabled={saving}
                    onChange={event => setClearSecret(event.target.checked)} />
                  清除已保存的 Client Secret
                </label>
              )}
              <div className="publishing-callback">
                <Field label="OAuth 回调地址" hint="在 X 开发者后台登记此地址。">
                  <input readOnly value={settings.redirectUri} />
                </Field>
                <Button type="button" icon={Copy} onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(settings.redirectUri);
                    setNotice("回调地址已复制。");
                    setError("");
                  } catch {
                    setError("无法复制，请选中回调地址后手动复制。");
                  }
                }}>复制地址</Button>
              </div>
            </>
          )}
          <div className="row-actions">
            <Button type="submit" variant="primary" busy={saving}>保存发布流程</Button>
          </div>
        </form>
      )}
      {notice && <p role="status" className="model-feedback">{notice}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </section>
  );
}
