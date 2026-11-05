if (globalThis.__muyiLoaded) {
  /* 避免重复注入 */
} else {
  globalThis.__muyiLoaded = true;
  boot();
}

function boot() {
  const DEFAULTS = {
    apiBase: "",
    apiKey: "",
    model: "",
    targetLang: "zh-Hans",
    displayMode: "bilingual",
    translationBelow: true,
    extraPrompt: "",
    sourceLang: "auto",
  };
  const MODES = [
    ["bilingual", "双语"],
    ["translation", "译文"],
    ["original", "原文"],
  ];

  const state = {
    settings: { ...DEFAULTS },
    videoId: "",
    cues: [],
    sourceLang: "",
    generation: 0,
  };
  const pendingFetches = new Map();
  let fetchSeq = 0;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/injected.js");
  document.documentElement.appendChild(script);
  script.remove();

  chrome.storage.local.get("muyi-settings").then((stored) => {
    state.settings = { ...DEFAULTS, ...(stored["muyi-settings"] || {}) };
    paintStatus(state.cues.length ? "" : "幕译已打开");
    const scraped = scrapePlayer();
    if (scraped) void onPlayer(scraped);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes["muyi-settings"]) return;
    const previous = state.settings;
    state.settings = { ...DEFAULTS, ...(changes["muyi-settings"].newValue || {}) };
    if (previous.sourceLang !== state.settings.sourceLang && state.videoId) {
      state.videoId = "";
      window.postMessage({ source: "muyi-republish" }, "*");
      return;
    }
    pushCues();
    const keys = ["apiKey", "apiBase", "model", "targetLang", "extraPrompt"];
    const changed = keys.some((key) => previous[key] !== state.settings[key]);
    if (changed && state.cues.length && state.settings.apiKey) {
      state.generation += 1;
      void translateAll(state.generation, state.cues).catch((error) => paintStatus(error.message));
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source === "muyi" && event.data.type === "player") {
      void onPlayer(event.data.data);
    } else if (event.data.source === "muyi-res") {
      const waiter = pendingFetches.get(event.data.id);
      if (!waiter) return;
      pendingFetches.delete(event.data.id);
      if (event.data.ok) waiter.resolve(event.data.text || "");
      else waiter.reject(new Error(event.data.error || `字幕请求失败（${event.data.status || "网络"}）`));
    }
  });

  ensureStatus();
  setInterval(() => {
    if (state.cues.length) pushCues();
  }, 2000);

  async function onPlayer(data) {
    if (!data || !data.videoId || data.videoId === state.videoId) return;
    state.generation += 1;
    const generation = state.generation;
    state.videoId = data.videoId;
    state.cues = [];
    pushCues();
    paintStatus("正在读取字幕…");
    const track = globalThis.MuyiParse.chooseTrack(data.tracks || [], state.settings.sourceLang || "auto");
    if (!track || !track.baseUrl) {
      paintStatus("这个视频没有字幕");
      return;
    }
    state.sourceLang = track.language;
    try {
      const url = new URL(track.baseUrl, location.origin);
      url.searchParams.set("fmt", "json3");
      const body = await requestCaption(url.toString());
      if (generation !== state.generation) return;
      state.cues = globalThis.MuyiParse.parseJson3(body);
      if (!state.cues.length) {
        paintStatus("字幕是空的");
        return;
      }
      pushCues();
      paintStatus(`${track.name}${track.auto ? " · 自动" : ""} · ${state.cues.length} 句`);
      if (state.settings.apiKey && state.settings.model && state.settings.apiBase) {
        await translateAll(generation, state.cues);
      } else {
        paintStatus("先在插件里填 API，当前先显示原文");
      }
    } catch (error) {
      if (generation !== state.generation) return;
      paintStatus(error.message || "读取字幕失败");
    }
  }

  function requestCaption(url) {
    const id = ++fetchSeq;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!pendingFetches.has(id)) return;
        pendingFetches.delete(id);
        reject(new Error("读取字幕超时。"));
      }, 20000);
      pendingFetches.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      window.postMessage({ source: "muyi-req", id, url }, "*");
    });
  }

  async function translateAll(generation, cues) {
    const settings = state.settings;
    const stamp = hashText(
      [settings.model, settings.targetLang, settings.sourceLang, settings.extraPrompt || ""].join("\0"),
    );
    const storageKey = `muyi-cache:${state.videoId}:${stamp}`;
    const stored = await chrome.storage.local.get(storageKey);
    const map = stored[storageKey] || {};
    const pending = [];
    for (const cue of cues) {
      const hit = map[hashText(cue.text)];
      if (typeof hit === "string") cue.translation = hit;
      else pending.push(cue);
    }
    pushCues();
    if (!pending.length) {
      paintStatus("译文已在这台手机上");
      return;
    }
    for (let offset = 0; offset < pending.length; offset += 20) {
      if (generation !== state.generation) return;
      const batch = pending.slice(offset, offset + 20);
      const before = cues.filter((cue) => cue.i < batch[0].i).slice(-2).map((cue) => cue.text);
      paintStatus(`翻译中 ${Math.min(offset + batch.length, pending.length)}/${pending.length}`);
      let translations;
      try {
        translations = await globalThis.MuyiLlm.translateBatch({
          baseUrl: settings.apiBase,
          apiKey: settings.apiKey,
          model: settings.model,
          targetLang: settings.targetLang,
          sourceLang: state.sourceLang,
          extra: settings.extraPrompt || "",
          lines: batch.map((cue) => cue.text),
          contextBefore: before,
        });
      } catch (error) {
        const message = error && error.message ? error.message : "翻译失败。";
        if (/failed to fetch|load failed|network|不允许|permission/i.test(message)) {
          throw new Error("连不上模型接口。到设置 → Safari → 扩展 → 幕译，把网站权限设为允许。");
        }
        throw error instanceof Error ? error : new Error(message);
      }
      if (generation !== state.generation) return;
      translations.forEach((text, index) => {
        batch[index].translation = text;
        map[hashText(batch[index].text)] = text;
      });
      pushCues();
      try {
        await chrome.storage.local.set({ [storageKey]: map });
      } catch {
        /* 缓存写失败不影响这一次观看 */
      }
    }
    if (generation === state.generation) paintStatus("翻译完成");
  }

  function pushCues() {
    const cues = state.cues.map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: globalThis.MuyiParse.formatCueLine(cue, state.settings),
    }));
    window.postMessage({ source: "muyi-apply", cues }, "*");
  }

  function ensureStatus() {
    if (document.getElementById("muyi-status")) return;
    const bar = document.createElement("div");
    bar.id = "muyi-status";
    bar.style.cssText = [
      "position:fixed",
      "left:12px",
      "right:12px",
      "bottom:calc(14px + env(safe-area-inset-bottom))",
      "z-index:2147483646",
      "display:flex",
      "gap:8px",
      "align-items:center",
      "justify-content:center",
      "pointer-events:none",
      "font:15px/1.3 -apple-system,BlinkMacSystemFont,sans-serif",
    ].join(";");
    const button = document.createElement("button");
    button.type = "button";
    button.id = "muyi-mode";
    button.textContent = "双语";
    button.style.cssText = [
      "pointer-events:auto",
      "border:0",
      "border-radius:999px",
      "background:#e7c27a",
      "color:#24180a",
      "padding:10px 14px",
      "font:inherit",
      "font-weight:650",
    ].join(";");
    const text = document.createElement("span");
    text.id = "muyi-status-text";
    text.style.cssText = [
      "background:rgba(12,10,8,.86)",
      "color:#f3ecdf",
      "border-radius:999px",
      "padding:10px 14px",
      "max-width:72%",
    ].join(";");
    bar.append(button, text);
    document.documentElement.appendChild(bar);
    button.addEventListener("click", () => {
      const index = MODES.findIndex(([id]) => id === state.settings.displayMode);
      state.settings.displayMode = MODES[(index + 1) % MODES.length][0];
      chrome.storage.local.set({ "muyi-settings": state.settings });
      pushCues();
      paintStatus("");
    });
  }

  function paintStatus(message) {
    ensureStatus();
    const button = document.getElementById("muyi-mode");
    const text = document.getElementById("muyi-status-text");
    if (button) button.textContent = MODES.find(([id]) => id === state.settings.displayMode)?.[1] || "双语";
    if (text && message) text.textContent = message;
  }

  function scrapePlayer() {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const raw = script.textContent || "";
      const at = raw.indexOf("ytInitialPlayerResponse");
      if (at < 0) continue;
      const start = raw.indexOf("{", at);
      if (start < 0) continue;
      const json = extractObject(raw, start);
      if (!json) continue;
      try {
        const response = JSON.parse(json);
        if (!response.videoDetails) continue;
        const pageId = videoIdFromLocation();
        if (!pageId || response.videoDetails.videoId !== pageId) continue;
        const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        return {
          videoId: response.videoDetails.videoId,
          title: response.videoDetails.title || "",
          author: response.videoDetails.author || "",
          tracks: tracks.map((track) => ({
            baseUrl: track.baseUrl,
            language: track.languageCode,
            name: trackName(track),
            auto: track.kind === "asr",
          })),
        };
      } catch {
        /* 下一段脚本 */
      }
    }
    return null;
  }

  function trackName(track) {
    const name = track.name;
    if (!name) return track.languageCode || "";
    if (typeof name === "string") return name;
    if (name.simpleText) return name.simpleText;
    if (Array.isArray(name.runs)) return name.runs.map((run) => run.text || "").join("");
    return track.languageCode || "";
  }

  function videoIdFromLocation() {
    const url = new URL(location.href);
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const shorts = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/);
    return shorts ? shorts[1] : null;
  }

  function extractObject(text, start) {
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return "";
  }

  function hashText(text) {
    let a = 2166136261;
    let b = 5381;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      a ^= code;
      a = Math.imul(a, 16777619);
      b = Math.imul(b, 33) ^ code;
    }
    return (a >>> 0).toString(16) + (b >>> 0).toString(16);
  }
}
