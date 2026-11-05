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
    fontScale: 1,
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
    active: -1,
  };
  const pendingFetches = new Map();
  let fetchSeq = 0;
  let shadow = null;
  let playerEl = null;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/injected.js");
  document.documentElement.appendChild(script);
  script.remove();

  chrome.storage.local.get("muyi-settings").then((stored) => {
    state.settings = { ...DEFAULTS, ...(stored["muyi-settings"] || {}) };
    applyChrome();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes["muyi-settings"]) return;
    const previous = state.settings;
    state.settings = { ...DEFAULTS, ...(changes["muyi-settings"].newValue || {}) };
    applyChrome();
    paint();
    if (previous.sourceLang !== state.settings.sourceLang && state.videoId) {
      state.videoId = "";
      window.postMessage({ source: "muyi-republish" }, "*");
      return;
    }
    const keys = ["apiKey", "apiBase", "model", "targetLang", "extraPrompt"];
    const changed = keys.some((key) => previous[key] !== state.settings[key]);
    if (changed && state.cues.length && state.settings.apiKey) {
      state.generation += 1;
      void translateAll(state.generation, state.cues).catch((error) => setStatus(error.message));
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

  setInterval(tick, 80);

  async function onPlayer(data) {
    if (!data || !data.videoId || data.videoId === state.videoId) return;
    state.generation += 1;
    const generation = state.generation;
    state.videoId = data.videoId;
    state.cues = [];
    state.active = -1;
    ensureOverlay();
    setStatus("正在读取字幕…");
    paint();
    const track = globalThis.MuyiParse.chooseTrack(data.tracks || [], state.settings.sourceLang || "auto");
    if (!track || !track.baseUrl) {
      setStatus("这个视频没有字幕轨道");
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
        setStatus("字幕是空的");
        return;
      }
      setStatus(`${track.name}${track.auto ? " · 自动" : ""} · ${state.cues.length} 句`);
      paint();
      if (state.settings.apiKey && state.settings.model && state.settings.apiBase) {
        await translateAll(generation, state.cues);
      } else {
        setStatus("先点扩展图标，填上你的 API");
      }
    } catch (error) {
      if (generation !== state.generation) return;
      setStatus(error.message || "读取字幕失败");
    }
  }

  function requestCaption(url) {
    const id = ++fetchSeq;
    return new Promise((resolve, reject) => {
      pendingFetches.set(id, { resolve, reject });
      window.postMessage({ source: "muyi-req", id, url }, "*");
      setTimeout(() => {
        if (!pendingFetches.has(id)) return;
        pendingFetches.delete(id);
        reject(new Error("读取字幕超时。"));
      }, 20000);
    });
  }

  async function translateAll(generation, cues) {
    const settings = state.settings;
    const stamp = hashText([settings.model, settings.targetLang, settings.sourceLang, settings.extraPrompt || ""].join("\0"));
    const storageKey = `muyi-cache:${state.videoId}:${stamp}`;
    const stored = await chrome.storage.local.get(storageKey);
    const map = stored[storageKey] || {};
    const pending = [];
    for (const cue of cues) {
      const hit = map[hashText(cue.text)];
      if (typeof hit === "string") cue.translation = hit;
      else pending.push(cue);
    }
    paint();
    if (!pending.length) {
      setStatus("译文已缓存");
      return;
    }
    for (let offset = 0; offset < pending.length; offset += 20) {
      if (generation !== state.generation) return;
      const batch = pending.slice(offset, offset + 20);
      const before = cues.filter((cue) => cue.i < batch[0].i).slice(-2).map((cue) => cue.text);
      setStatus(`翻译中 ${Math.min(offset + batch.length, pending.length)}/${pending.length}`);
      const response = await sendMessage({
        type: "translate-batch",
        payload: {
          baseUrl: settings.apiBase,
          apiKey: settings.apiKey,
          model: settings.model,
          targetLang: settings.targetLang,
          sourceLang: state.sourceLang,
          extra: settings.extraPrompt || "",
          lines: batch.map((cue) => cue.text),
          contextBefore: before,
        },
      });
      if (generation !== state.generation) return;
      if (!response || response.error) throw new Error(response?.error || "翻译没有返回。");
      response.translations.forEach((text, index) => {
        batch[index].translation = text;
        map[hashText(batch[index].text)] = text;
      });
      paint();
      try {
        await chrome.storage.local.set({ [storageKey]: map });
      } catch {
        /* 缓存写失败不影响这一次观看 */
      }
    }
    if (generation === state.generation) setStatus("翻译完成");
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function tick() {
    const player = findPlayer();
    if (!player) return;
    if (player !== playerEl) ensureOverlay(player);
    const hidden = player.classList.contains("ytp-autohide");
    player.querySelector("#muyi-root")?.style.setProperty("--muyi-bottom", hidden ? "8%" : "72px");
    const video = player.querySelector("video");
    if (!video || !state.cues.length) return;
    const index = globalThis.MuyiParse.activeCueIndex(state.cues, video.currentTime || 0);
    if (index !== state.active) {
      state.active = index;
      paint();
    }
  }

  function findPlayer() {
    return document.querySelector("#movie_player") || document.querySelector("#shorts-player .html5-video-player");
  }

  function ensureOverlay(player) {
    const hostPlayer = player || findPlayer();
    if (!hostPlayer) return;
    playerEl = hostPlayer;
    let host = hostPlayer.querySelector("#muyi-root");
    if (host && host.shadowRoot) {
      shadow = host.shadowRoot;
      return;
    }
    host = document.createElement("div");
    host.id = "muyi-root";
    host.style.cssText = "position:absolute;inset:0;z-index:58;pointer-events:none;";
    hostPlayer.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("src/overlay.css");
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML =
      '<div class="status"><button type="button" id="mode">双语</button><span id="status"></span></div>' +
      '<div class="card"><div class="bubble"><p class="original"></p><p class="translation"></p></div></div>';
    shadow.append(link, wrap);
    shadow.getElementById("mode").addEventListener("click", () => {
      const index = MODES.findIndex(([id]) => id === state.settings.displayMode);
      const next = MODES[(index + 1) % MODES.length][0];
      state.settings.displayMode = next;
      chrome.storage.local.set({ "muyi-settings": state.settings });
      paint();
    });
    applyChrome();
    paint();
  }

  function applyChrome() {
    const host = playerEl?.querySelector("#muyi-root");
    host?.style.setProperty("--muyi-scale", String(state.settings.fontScale || 1));
    const button = shadow?.getElementById("mode");
    if (button) button.textContent = MODES.find(([id]) => id === state.settings.displayMode)?.[1] || "双语";
  }

  function paint() {
    if (!shadow) return;
    const original = shadow.querySelector(".original");
    const translation = shadow.querySelector(".translation");
    const cue = state.active >= 0 ? state.cues[state.active] : null;
    const mode = state.settings.displayMode;
    const bubble = shadow.querySelector(".bubble");
    if (!cue) {
      original.textContent = "";
      translation.textContent = "";
      bubble.classList.add("hidden");
      return;
    }
    bubble.classList.remove("hidden");
    const showOriginal = mode !== "translation";
    const showTranslation = mode !== "original";
    original.textContent = cue.text;
    translation.textContent = cue.translation || (showTranslation ? "…" : "");
    original.classList.toggle("hidden", !showOriginal);
    translation.classList.toggle("hidden", !showTranslation);
    if (state.settings.translationBelow) bubble.append(original, translation);
    else bubble.append(translation, original);
    applyChrome();
  }

  function setStatus(text) {
    if (!shadow) ensureOverlay();
    const node = shadow?.getElementById("status");
    if (node) node.textContent = text;
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
