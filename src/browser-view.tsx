import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ArrowLeft, House, RefreshCw } from "lucide-react";

const controlKeys = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function BrowserView({
  id,
  draftText,
  onStop,
}: {
  id: string;
  draftText?: string;
  onStop: () => void;
}) {
  const endpoint = `/api/profiles/${id}`;
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [available, setAvailable] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const controller = useRef<AbortController | null>(null);
  const firstControl = useRef<HTMLButtonElement>(null);
  const actions = useRef(Promise.resolve());

  const send = (input: Record<string, unknown>) => {
    const signal = controller.current?.signal;
    if (!available || !signal || signal.aborted) return;
    actions.current = actions.current
      .then(async () => {
        if (signal.aborted) return;
        const response = await fetch(endpoint + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal,
        });
        if (response.status === 401)
          window.dispatchEvent(new Event("nodex:auth-expired"));
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || "浏览器操作未完成。");
        }
      })
      .catch((cause: Error) => {
        if (!signal.aborted) setError(cause.message);
      });
  };

  function position(event: Pick<MouseEvent, "clientX" | "clientY">) {
    const rect = image.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return undefined;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : undefined;
  }

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    let timer: number;
    let objectUrl = "";
    let scrollTimer: number | undefined;
    let delta = 0;
    const view = viewport.current;

    const update = async () => {
      try {
        if (document.visibilityState === "visible") {
          const response = await fetch(endpoint + "/frame", {
            cache: "no-store",
            signal: abort.signal,
          });
          if (response.status === 401) {
            window.dispatchEvent(new Event("nodex:auth-expired"));
            return;
          }
          if (response.status === 404 || response.status === 409) {
            setAvailable(false);
            setSrc("");
            setError("在线浏览器已关闭，请返回环境列表重新打开。");
            return;
          }
          if (!response.ok) throw new Error("正在重试连接浏览器画面…");
          const next = await response.blob();
          if (abort.signal.aborted) return;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(next);
          setSrc(objectUrl);
          setError((current) =>
            current === "正在重试连接浏览器画面…" ? "" : current,
          );
        }
      } catch (cause) {
        if (!abort.signal.aborted) setError((cause as Error).message);
      }
      if (!abort.signal.aborted)
        timer = window.setTimeout(() => void update(), 700);
    };
    const wheel = (event: WheelEvent) => {
      const point = position(event);
      if (!point) return;
      event.preventDefault();
      delta +=
        event.deltaY *
        (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 640 : 1);
      if (scrollTimer !== undefined) return;
      scrollTimer = window.setTimeout(() => {
        scrollTimer = undefined;
        send({
          type: "scroll",
          ...point,
          delta: Math.max(-1600, Math.min(1600, Math.round(delta))),
        });
        delta = 0;
      }, 100);
    };
    view?.addEventListener("wheel", wheel, { passive: false });
    void update();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
      window.clearTimeout(scrollTimer);
      view?.removeEventListener("wheel", wheel);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [endpoint]);

  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.altKey) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      send({ type: "key", key: "Control+a" });
      return;
    }
    if (event.metaKey || event.ctrlKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      send({ type: "key", key: "Escape" });
      firstControl.current?.focus();
      return;
    }
    if (controlKeys.has(event.key)) {
      event.preventDefault();
      send({
        type: "key",
        key: event.shiftKey && event.key === "Tab" ? "Shift+Tab" : event.key,
      });
    } else if (event.key === " ") {
      event.preventDefault();
      send({ type: "key", key: "Space" });
    } else if ([...event.key].length === 1) {
      event.preventDefault();
      send({ type: "text", text: event.key });
    }
  };
  return (
    <div className="remote-browser">
      <div className="remote-browser-toolbar" aria-label="浏览器导航">
        <button
          ref={firstControl}
          className="button secondary"
          disabled={!available}
          onClick={() => send({ type: "back" })}
        >
          <ArrowLeft size={16} aria-hidden="true" /> 后退
        </button>
        <button
          className="button secondary"
          disabled={!available}
          onClick={() => send({ type: "reload" })}
        >
          <RefreshCw size={16} aria-hidden="true" /> 刷新
        </button>
        <button
          className="button secondary"
          disabled={!available}
          onClick={() => send({ type: "home" })}
        >
          <House size={16} aria-hidden="true" /> X 首页
        </button>
        <button
          className="button secondary"
          disabled={!available}
          onClick={() => send({ type: "login" })}
        >
          X 登录
        </button>
        <button className="button secondary" onClick={onStop}>
          关闭浏览器
        </button>
        <a
          className="button secondary"
          href={`/?browser=${id}#profiles`}
          target="_blank"
          rel="noopener"
        >
          在新标签打开
        </a>
      </div>
      <div
        className="remote-browser-viewport"
        ref={viewport}
        role="region"
        aria-label="X 浏览器画面"
        tabIndex={available ? 0 : -1}
        onKeyDown={keyboard}
        onClick={(event) => {
          const point = position(event);
          if (point) {
            viewport.current?.focus();
            send({ type: "click", ...point });
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          const value = event.clipboardData
            .getData("text/plain")
            .slice(0, 8000);
          if (value) send({ type: "text", text: value });
        }}
      >
        {src ? (
          <img ref={image} src={src} alt="当前 X 页面" draggable={false} />
        ) : (
          <p role="status">
            {available ? "正在连接浏览器画面…" : "浏览器已关闭"}
          </p>
        )}
      </div>
      {draftText && available && (
        <section className="remote-browser-draft" aria-label="待发布草稿">
          <label htmlFor="remote-draft-preview">待发布草稿</label>
          <textarea
            id="remote-draft-preview"
            readOnly
            rows={3}
            value={draftText}
          />
          <p>先在 X 画面中选中发文框，再填入草稿。</p>
          <button
            className="button primary"
            disabled={!src}
            onClick={() => send({ type: "text", text: draftText })}
          >
            填入当前输入框
          </button>
        </section>
      )}
      {error && (
        <div className="remote-browser-error" role="status">
          <span>{error}</span>
          <button className="text-button" onClick={() => setError("")}>
            关闭提示
          </button>
        </div>
      )}
      {available && (
        <form
          className="remote-browser-input"
          onSubmit={(event) => {
            event.preventDefault();
            if (text) {
              send({ type: "text", text });
              setText("");
            }
          }}
        >
          <input
            aria-label="输入法文字"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="在画面中选中输入框，或在这里用输入法输入"
            maxLength={8000}
            autoComplete="off"
          />
          <button className="button secondary" type="submit" disabled={!text}>
            发送文字
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => send({ type: "scroll", x: 0.5, y: 0.5, delta: 480 })}
          >
            向下滚动
          </button>
        </form>
      )}
    </div>
  );
}
