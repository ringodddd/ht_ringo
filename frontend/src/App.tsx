import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteCookies,
  fetchCaptions,
  fetchConfig,
  importCaptions,
  streamTranslate,
  uploadCookies,
} from "./api";
import { defaultSettings, loadSettings, saveSettings } from "./settings";
import { activeCueIndex, DEMO_CUES, downloadText, formatTime, toSrt } from "./text";
import type { Cue, DisplayMode, ServerConfig, Session, Settings } from "./types";
import { LANGUAGES } from "./types";
import { useYouTube } from "./useYouTube";

const emptyConfig: ServerConfig = {
  mock: false,
  hasServerKey: false,
  serverModel: "",
  serverBaseHost: "",
  hasCookies: false,
  appTokenRequired: false,
};

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [config, setConfig] = useState<ServerConfig>(emptyConfig);
  const [url, setUrl] = useState(() => localStorage.getItem("muyi.lastUrl") || "");
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<"captions" | "translate" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const cookieRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const rowRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const translateAbort = useRef<AbortController | null>(null);
  const timeRef = useRef(0);

  const player = useYouTube(session?.videoId || "");
  const preview = !session?.videoId || !player.ready || player.failed;
  const clock = preview ? previewTime : player.time;
  timeRef.current = clock;

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => setError("连不上幕译服务。先在本机把后端跑起来。"));
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (settingsOpen && !dialog.open) dialog.showModal();
    if (!settingsOpen && dialog.open) dialog.close();
  }, [settingsOpen]);

  useEffect(() => {
    if (!preview || !previewPlaying || !session) return;
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      setPreviewTime((value) => {
        const next = value + delta;
        return next > Math.max(session.duration, 1) ? 0 : next;
      });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [preview, previewPlaying, session]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (!session) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (preview) setPreviewPlaying((value) => !value);
        else player.toggle();
      } else if (event.key === "ArrowRight") {
        nudge(5);
      } else if (event.key === "ArrowLeft") {
        nudge(-5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const active = session ? activeCueIndex(session.cues, clock) : -1;

  useEffect(() => {
    if (!follow || active < 0) return;
    rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, follow]);

  const visibleCues = useMemo(() => {
    if (!session) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return session.cues;
    return session.cues.filter((cue) =>
      `${cue.text} ${cue.translation || ""}`.toLowerCase().includes(needle),
    );
  }, [session, query]);

  function patchSettings(patch: Partial<Settings>) {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSettings(next);
      return next;
    });
  }

  function nudge(delta: number) {
    if (preview) setPreviewTime((value) => Math.max(0, value + delta));
    else player.seekTo(Math.max(0, timeRef.current + delta));
  }

  function seek(cue: Cue) {
    if (preview) {
      setPreviewTime(cue.start);
      setPreviewPlaying(true);
    } else {
      player.seekTo(cue.start);
    }
  }

  async function loadFromUrl(nextUrl: string, lang = "auto") {
    const trimmed = nextUrl.trim();
    if (!trimmed) {
      setError("先粘贴一个 YouTube 链接。");
      return;
    }
    translateAbort.current?.abort();
    setBusy("captions");
    setError("");
    setNotice("");
    setProgress(null);
    try {
      const next = await fetchCaptions(trimmed, lang, settings);
      setSession(next);
      setPreviewTime(0);
      setUrl(trimmed);
      localStorage.setItem("muyi.lastUrl", trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取字幕失败。");
    } finally {
      setBusy("");
    }
  }

  function loadDemo() {
    translateAbort.current?.abort();
    setError("");
    setNotice("这是一段产品说明时间轴，用来看双语字幕怎么跟着画面走，不是视频里的原话。");
    setProgress(null);
    setPreviewTime(0);
    setSession({
      videoId: "jNQXAC9IVRw",
      title: "幕译示例",
      author: "本地示例",
      duration: 19,
      track: { language: "en", name: "示例英语", auto: false },
      available: [{ language: "en", name: "示例英语", auto: false }],
      cues: DEMO_CUES,
      source: "demo",
    });
  }

  async function onImport(file: File) {
    const content = await file.text();
    setBusy("captions");
    setError("");
    try {
      const next = await importCaptions(url.trim(), file.name, content, settings);
      setSession(next);
      setPreviewTime(0);
      setNotice(next.videoId ? "已用导入的时间轴。" : "已导入字幕。补上 YouTube 链接后就能对着画面播放。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败。");
    } finally {
      setBusy("");
    }
  }

  async function translate() {
    if (!session) return;
    if (!settings.useServerKey && !settings.apiKey.trim()) {
      setSettingsOpen(true);
      setError("先在设置里填写 API Key，或改用服务器上的密钥。");
      return;
    }
    translateAbort.current?.abort();
    const controller = new AbortController();
    translateAbort.current = controller;
    setBusy("translate");
    setError("");
    setProgress({ done: 0, total: session.cues.length });
    try {
      await streamTranslate(
        session,
        settings,
        (event) => {
          if (event.event === "cue") {
            const { i, translation } = event.data;
            setSession((current) =>
              current
                ? {
                    ...current,
                    cues: current.cues.map((cue) => (cue.i === i ? { ...cue, translation } : cue)),
                  }
                : current,
            );
          } else if (event.event === "progress") {
            setProgress(event.data);
          } else if (event.event === "error") {
            setError(event.data.message);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "翻译失败。");
      }
    } finally {
      setBusy((value) => (value === "translate" ? "" : value));
    }
  }

  const cue = active >= 0 && session ? session.cues[active] : null;
  const translatedCount = session?.cues.filter((item) => item.translation).length || 0;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            幕
          </span>
          <div>
            <strong>幕译</strong>
            <em>沉浸式双语字幕，模型用你自己的接口</em>
          </div>
        </div>
        <form
          className="url-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadFromUrl(url);
          }}
        >
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="粘贴 YouTube 链接"
            aria-label="YouTube 链接"
            spellCheck={false}
          />
          <button className="primary" type="submit" disabled={busy === "captions"}>
            {busy === "captions" ? "读取中" : "读取字幕"}
          </button>
        </form>
        <button className="ghost" type="button" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
      </header>

      {(error || notice || config.mock) && (
        <div className="banners">
          {config.mock && <p className="banner mock">预览翻译已打开：译文只会加上「【译】」，不会调用模型。</p>}
          {notice && <p className="banner">{notice}</p>}
          {error && (
            <p className="banner danger" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {session ? (
        <main className="stage">
          <section className="screen">
            <div className="frame">
              <div className="yt-fallback" />
              {session.videoId ? (
                <div className={preview ? "yt-host is-quiet" : "yt-host"} ref={player.hostRef} />
              ) : null}
              <div className="caption" style={{ fontSize: `${settings.fontScale}rem` }}>
                <CaptionCard cue={cue} mode={settings.displayMode} translationBelow={settings.translationBelow} />
              </div>
              {preview && (
                <p className="preview-note">
                  {session.videoId
                    ? "播放器没加载成功，字幕按时间轴在走。空格可以暂停。"
                    : "还没有可播放的视频，字幕按时间轴预览。"}
                </p>
              )}
            </div>
            <div className="screen-meta">
              <div>
                <h1>{session.title}</h1>
                <p>
                  {session.author ? `${session.author} · ` : ""}
                  {session.track ? `${session.track.name}${session.track.auto ? " · 自动识别" : ""}` : "无字幕轨道"}
                  {` · ${session.cues.length} 句`}
                  {session.source === "demo" ? " · 示例" : ""}
                  {session.source === "import" ? " · 导入" : ""}
                </p>
              </div>
              <div className="actions">
                <label className="field slim">
                  <span>源字幕</span>
                  <select
                    value={session.track?.language || ""}
                    onChange={(event) => void loadFromUrl(url, event.target.value)}
                    disabled={session.source !== "youtube" && session.source !== "invidious"}
                  >
                    {session.available.map((track) => (
                      <option key={`${track.language}-${track.auto}`} value={track.language}>
                        {track.name} · {track.language}
                        {track.auto ? " · 自动" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="modes" role="group" aria-label="显示方式">
                  {(
                    [
                      ["bilingual", "双语"],
                      ["translation", "译文"],
                      ["original", "原文"],
                    ] as [DisplayMode, string][]
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={settings.displayMode === id ? "chip on" : "chip"}
                      onClick={() => patchSettings({ displayMode: id })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button className="primary" type="button" onClick={() => void translate()} disabled={busy === "translate"}>
                  {busy === "translate"
                    ? `翻译中 ${progress ? `${progress.done}/${progress.total}` : ""}`
                    : translatedCount
                      ? "重新翻译"
                      : "翻译字幕"}
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => downloadText(`${session.videoId || "subs"}.srt`, toSrt(session.cues, false))}
                >
                  下载译文
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => downloadText(`${session.videoId || "subs"}.bilingual.srt`, toSrt(session.cues, true))}
                >
                  下载双语
                </button>
              </div>
            </div>
            {progress && busy === "translate" && (
              <div className="meter" aria-hidden="true">
                <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
            )}
          </section>
          <aside className="transcript">
            <div className="transcript-head">
              <strong>文稿</strong>
              <button type="button" className={follow ? "chip on" : "chip"} onClick={() => setFollow((value) => !value)}>
                {follow ? "跟随播放" : "已暂停跟随"}
              </button>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索句子"
                aria-label="搜索字幕"
              />
            </div>
            <div className="rows">
              {visibleCues.map((item) => (
                <button
                  key={item.i}
                  type="button"
                  ref={(node) => {
                    rowRefs.current[item.i] = node;
                  }}
                  className={item.i === active ? "row is-active" : "row"}
                  onClick={() => seek(item)}
                >
                  <time>{formatTime(item.start)}</time>
                  <span>
                    <b>{item.text}</b>
                    {item.translation && <small>{item.translation}</small>}
                  </span>
                </button>
              ))}
            </div>
            <p className="hint">空格播放或暂停，左右方向键跳 5 秒。点一句就能跳过去。</p>
          </aside>
        </main>
      ) : (
        <Empty
          busy={busy === "captions"}
          onDemo={loadDemo}
          onImport={() => fileRef.current?.click()}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".srt,.vtt,.json,.json3,.xml,text/vtt,application/x-subrip"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onImport(file);
        }}
      />

      <dialog ref={dialogRef} className="sheet" onClose={() => setSettingsOpen(false)}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSettingsOpen(false);
          }}
        >
          <header>
            <h2>翻译接口</h2>
            <button type="button" className="ghost" onClick={() => setSettingsOpen(false)}>
              关闭
            </button>
          </header>
          <p className="lede">
            密钥从浏览器发到你自己的幕译服务，再由它去请求模型。不要把这个网站暴露到公网，除非设置了 APP_TOKEN。
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.useServerKey}
              onChange={(event) => patchSettings({ useServerKey: event.target.checked })}
            />
            使用服务器环境变量里的密钥
            {config.serverBaseHost ? `（${config.serverBaseHost}${config.serverModel ? " · " + config.serverModel : ""}）` : ""}
            {!config.hasServerKey && !config.mock ? "，服务器还没配密钥" : ""}
          </label>
          <label className="field">
            <span>API Base URL</span>
            <input
              value={settings.apiBase}
              disabled={settings.useServerKey}
              placeholder="https://api.deepseek.com/v1"
              onChange={(event) => patchSettings({ apiBase: event.target.value })}
            />
          </label>
          <label className="field">
            <span>API Key</span>
            <input
              type="password"
              value={settings.apiKey}
              disabled={settings.useServerKey}
              placeholder="sk-..."
              autoComplete="off"
              onChange={(event) => patchSettings({ apiKey: event.target.value })}
            />
          </label>
          <label className="field">
            <span>模型</span>
            <input
              value={settings.model}
              disabled={settings.useServerKey}
              placeholder="deepseek-chat"
              onChange={(event) => patchSettings({ model: event.target.value })}
            />
          </label>
          <div className="split">
            <label className="field">
              <span>译成</span>
              <select
                value={settings.targetLang}
                onChange={(event) => patchSettings({ targetLang: event.target.value })}
              >
                {LANGUAGES.map((language) => (
                  <option key={language.id} value={language.id}>
                    {language.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>字号 {settings.fontScale.toFixed(1)}</span>
              <input
                type="range"
                min={0.8}
                max={1.6}
                step={0.1}
                value={settings.fontScale}
                onChange={(event) => patchSettings({ fontScale: Number(event.target.value) })}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.translationBelow}
              onChange={(event) => patchSettings({ translationBelow: event.target.checked })}
            />
            译文放在原文下面，字号更大
          </label>
          <label className="field">
            <span>补充要求</span>
            <textarea
              rows={3}
              value={settings.extraPrompt}
              placeholder="例如：技术名词保留英文，语气随意一点。"
              onChange={(event) => patchSettings({ extraPrompt: event.target.value })}
            />
          </label>
          <label className="field">
            <span>访问口令{config.appTokenRequired ? "（服务器要求）" : "（可选）"}</span>
            <input
              type="password"
              value={settings.appToken}
              autoComplete="off"
              onChange={(event) => patchSettings({ appToken: event.target.value })}
            />
          </label>
          <div className="cookie-row">
            <div>
              <strong>YouTube cookies</strong>
              <p>{config.hasCookies ? "服务器上已经有 cookies。" : "机房 IP 被拦时，用浏览器导出的 Netscape cookies.txt。"}</p>
            </div>
            <button type="button" className="ghost" onClick={() => cookieRef.current?.click()}>
              上传
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() =>
                void deleteCookies(settings)
                  .then(() => setConfig((current) => ({ ...current, hasCookies: false })))
                  .catch((err: Error) => setError(err.message))
              }
            >
              清除
            </button>
          </div>
          <input
            ref={cookieRef}
            hidden
            type="file"
            accept=".txt,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void file
                .text()
                .then((content) => uploadCookies(content, settings))
                .then(() => setConfig((current) => ({ ...current, hasCookies: true })))
                .catch((err: Error) => setError(err.message));
            }}
          />
          <footer>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                saveSettings(defaultSettings);
                setSettings(defaultSettings);
              }}
            >
              恢复默认
            </button>
            <button className="primary" type="submit">
              完成
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

function CaptionCard({
  cue,
  mode,
  translationBelow,
}: {
  cue: Cue | null;
  mode: DisplayMode;
  translationBelow: boolean;
}) {
  if (!cue) return <div className="caption-card quiet">这一段没有字幕</div>;
  const original = mode !== "translation" ? <p className="original">{cue.text}</p> : null;
  const translation =
    mode !== "original" ? (
      <p className="translation">{cue.translation || (mode === "translation" ? cue.text : "等待翻译")}</p>
    ) : null;
  return (
    <div className="caption-card">
      {translationBelow ? (
        <>
          {original}
          {translation}
        </>
      ) : (
        <>
          {translation}
          {original}
        </>
      )}
    </div>
  );
}

function Empty({
  busy,
  onDemo,
  onImport,
  onOpenSettings,
}: {
  busy: boolean;
  onDemo: () => void;
  onImport: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <main className="empty">
      <p className="eyebrow">自建放映室</p>
      <h1>
        油管视频
        <br />
        底部压上双语字幕
      </h1>
      <p className="deck">
        不下载视频，只读字幕文本，再交给你自己的 token 接口。看的时候原文小字、译文大字，跟着播放往下走。
      </p>
      <div className="empty-actions">
        <button type="button" className="primary" onClick={onDemo} disabled={busy}>
          看 20 秒示例
        </button>
        <button type="button" className="ghost" onClick={onImport}>
          导入 SRT / VTT
        </button>
        <button type="button" className="ghost" onClick={onOpenSettings}>
          填写模型接口
        </button>
      </div>
      <ol className="steps">
        <li>
          <span>1</span>
          <div>
            <strong>网页放映</strong>
            <p>贴链接，服务器用 yt-dlp 取字幕。被 YouTube 拦住就上传 cookies，或改用扩展。</p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>油管页面里直接看</strong>
            <p>加载 extension 目录。扩展用你浏览器里已经打开的字幕轨道，不经过机房 IP。</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>翻译走你的接口</strong>
            <p>兼容 OpenAI 的 /v1/chat/completions。DeepSeek、硅基流动、本地模型都可以。</p>
          </div>
        </li>
      </ol>
    </main>
  );
}
