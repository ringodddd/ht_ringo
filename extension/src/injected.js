/* 跑在 YouTube 页面自己的环境里，读取字幕地址，并把字幕写进 video 的字幕轨。
   iPhone 全屏时只有这条字幕轨还会显示。 */
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

  function playerResponse() {
    const nodes = [
      document.querySelector("#movie_player"),
      document.querySelector(".html5-video-player"),
      document.querySelector("ytm-player"),
    ];
    for (const node of nodes) {
      if (!node || typeof node.getPlayerResponse !== "function") continue;
      try {
        const response = node.getPlayerResponse();
        if (response && response.videoDetails) return response;
      } catch {
        /* 播放器还没准备好 */
      }
    }
    if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails) {
      return window.ytInitialPlayerResponse;
    }
    return null;
  }

  function collect() {
    const response = playerResponse();
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

  function pickVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;
    videos.sort((a, b) => (b.clientWidth || 0) - (a.clientWidth || 0));
    return videos[0];
  }

  let lastCues = [];
  let boundVideo = null;

  function hideNativeCaptions() {
    if (document.getElementById("muyi-hide-cc")) return;
    const style = document.createElement("style");
    style.id = "muyi-hide-cc";
    style.textContent =
      ".ytp-caption-window-container,.caption-window{opacity:0 !important;pointer-events:none !important;}";
    document.documentElement.appendChild(style);
  }

  function applyToVideo(video) {
    if (!video || !lastCues.length || typeof video.addTextTrack !== "function") return;
    let track = video.__muyiTrack;
    if (!track) {
      track = video.addTextTrack("subtitles", "幕译", "zh");
      video.__muyiTrack = track;
    }
    track.mode = "showing";
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const existing = track.cues ? Array.from(track.cues) : [];
    const same =
      existing.length === lastCues.length &&
      existing.every((cue, index) => cue.text === lastCues[index].text);
    if (same) return;
    while (track.cues && track.cues.length) track.removeCue(track.cues[0]);
    for (const cue of lastCues) {
      let end = Number(cue.end);
      const start = Math.max(0, Number(cue.start) || 0);
      if (!(end > start)) end = start + 1.6;
      if (duration > 0) end = Math.min(end, Math.max(start + 0.2, duration - 0.05));
      try {
        track.addCue(new VTTCue(start, end, cue.text || ""));
      } catch {
        /* 个别时间点会被播放器拒绝 */
      }
    }
    track.mode = "showing";
    boundVideo = video;
    hideNativeCaptions();
  }

  function trackIsLive(video, track) {
    if (!track || !video.textTracks) return false;
    return Array.from(video.textTracks).includes(track);
  }

  function applyLast() {
    const video = pickVideo();
    if (!video) return;
    if (video !== boundVideo || !trackIsLive(video, video.__muyiTrack)) video.__muyiTrack = null;
    applyToVideo(video);
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
    if (event.data.source === "muyi-apply") {
      lastCues = Array.isArray(event.data.cues) ? event.data.cues : [];
      applyLast();
      return;
    }
    if (event.data.source !== "muyi-req") return;
    const raw = String(event.data.url || "");
    const url = raw.startsWith("//") ? `https:${raw}` : raw;
    if (!/^https:\/\/((www|m)\.)?youtube\.com\/api\/timedtext\?/.test(url)) {
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
        {
          source: "muyi-res",
          id: event.data.id,
          ok: false,
          error: String(error && error.message ? error.message : error),
        },
        "*",
      );
    }
  });

  function arm() {
    lastKey = "";
    publish();
    setTimeout(publish, 600);
    setTimeout(publish, 1800);
  }

  publish();
  document.addEventListener("yt-navigate-finish", arm);
  document.addEventListener("yt-page-data-updated", arm);
  let tries = 0;
  const timer = setInterval(() => {
    publish();
    if (lastCues.length) applyLast();
    tries += 1;
    if (tries > 40) clearInterval(timer);
  }, 700);
  setInterval(() => {
    if (lastCues.length) applyLast();
  }, 1500);
})();
