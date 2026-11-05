/* 跑在 YouTube 页面自己的环境里，才能读到播放器对象和字幕地址。 */
(function () {
  function videoIdFromLocation() {
    const url = new URL(location.href);
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const shorts = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/);
    return shorts ? shorts[1] : null;
  }

  function trackName(track) {
    const name = track.name;
    if (!name) return track.languageCode || "";
    if (typeof name === "string") return name;
    if (name.simpleText) return name.simpleText;
    if (Array.isArray(name.runs)) return name.runs.map((run) => run.text || "").join("");
    return track.languageCode || "";
  }

  function collect() {
    const player = document.querySelector("#movie_player");
    const response =
      (player && typeof player.getPlayerResponse === "function" && player.getPlayerResponse()) ||
      window.ytInitialPlayerResponse;
    if (!response || !response.videoDetails) return null;
    const pageId = videoIdFromLocation();
    const videoId = response.videoDetails.videoId;
    if (!pageId || videoId !== pageId) return null;
    const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return {
      videoId,
      title: response.videoDetails.title || "",
      author: response.videoDetails.author || "",
      tracks: tracks.map((track) => ({
        baseUrl: track.baseUrl,
        language: track.languageCode,
        name: trackName(track),
        auto: track.kind === "asr",
      })),
    };
  }

  let lastKey = "";
  function publish() {
    const data = collect();
    if (!data) return;
    const key = `${data.videoId}:${data.tracks.map((track) => track.language + (track.auto ? "*" : "")).join(",")}`;
    if (key === lastKey) return;
    lastKey = key;
    window.postMessage({ source: "muyi", type: "player", data }, "*");
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source === "muyi-republish") {
      lastKey = "";
      publish();
      return;
    }
    if (event.data.source !== "muyi-req") return;
    const raw = String(event.data.url || "");
    const url = raw.startsWith("//") ? `https:${raw}` : raw;
    if (!/^https:\/\/(www\.)?youtube\.com\/api\/timedtext\?/.test(url)) {
      window.postMessage(
        { source: "muyi-res", id: event.data.id, ok: false, error: "只允许读取 YouTube 字幕地址。" },
        "*",
      );
      return;
    }
    try {
      const response = await fetch(url, { credentials: "include" });
      const text = await response.text();
      window.postMessage(
        { source: "muyi-res", id: event.data.id, ok: response.ok, status: response.status, text },
        "*",
      );
    } catch (error) {
      window.postMessage(
        { source: "muyi-res", id: event.data.id, ok: false, error: String(error && error.message ? error.message : error) },
        "*",
      );
    }
  });

  publish();
  document.addEventListener("yt-navigate-finish", () => {
    lastKey = "";
    setTimeout(publish, 500);
    setTimeout(publish, 1500);
  });
  let tries = 0;
  const timer = setInterval(() => {
    publish();
    tries += 1;
    if (tries > 15) clearInterval(timer);
  }, 700);
})();
