/* 字幕解析。网页脚本和 node 测试共用这一份。 */
(function (root) {
  function unescapeHtml(value) {
    return String(value || "")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function cleanText(value) {
    return unescapeHtml(value)
      .replace(/\u200b/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tidyCues(cues) {
    const cleaned = [];
    for (const cue of cues) {
      const text = cleanText(cue.text);
      if (!text) continue;
      const start = Math.max(0, Number(cue.start) || 0);
      let end = Number(cue.end);
      if (!(end > start)) end = start + 1.6;
      const current = { start, end, text };
      const prev = cleaned[cleaned.length - 1];
      if (prev) {
        if (current.text === prev.text && current.start <= prev.end + 0.4) {
          prev.end = Math.max(prev.end, current.end);
          continue;
        }
        if (
          current.start < prev.end + 0.35 &&
          (current.text.startsWith(prev.text) || prev.text.startsWith(current.text))
        ) {
          if (current.text.length >= prev.text.length) prev.text = current.text;
          prev.start = Math.min(prev.start, current.start);
          prev.end = Math.max(prev.end, current.end);
          continue;
        }
      }
      cleaned.push(current);
    }
    for (let i = 0; i < cleaned.length - 1; i += 1) {
      const cue = cleaned[i];
      const next = cleaned[i + 1];
      if (cue.end > next.start) cue.end = Math.max(cue.start + 0.2, next.start);
    }
    return cleaned.map((cue, index) => ({ i: index, ...cue }));
  }

  function parseJson3(payload) {
    const data = typeof payload === "string" ? JSON.parse(payload) : payload;
    const cues = [];
    for (const event of data.events || []) {
      if (event.tStartMs == null) continue;
      const text = (event.segs || []).map((seg) => seg.utf8 || "").join("");
      const dur = event.dDurationMs || event.dDurMs || 0;
      cues.push({ start: event.tStartMs / 1000, end: (event.tStartMs + dur) / 1000, text });
    }
    return tidyCues(cues);
  }

  function stamp(hours, minutes, seconds, millis) {
    return Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
  }

  function parseVtt(text) {
    const lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const time = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;
    const cues = [];
    for (let i = 0; i < lines.length; i += 1) {
      const match = time.exec(lines[i]);
      if (!match) continue;
      const start = stamp(match[1], match[2], match[3], match[4]);
      const end = stamp(match[5], match[6], match[7], match[8]);
      const buf = [];
      i += 1;
      while (i < lines.length && lines[i].trim()) {
        buf.push(lines[i]);
        i += 1;
      }
      cues.push({ start, end, text: buf.join(" ") });
    }
    return tidyCues(cues);
  }

  function parseSrt(text) {
    const blocks = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split(/\n\s*\n/);
    const time = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;
    const cues = [];
    for (const block of blocks) {
      const lines = block.split("\n");
      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeIndex < 0) continue;
      const match = time.exec(lines[timeIndex]);
      if (!match) continue;
      cues.push({
        start: stamp(match[1], match[2], match[3], match[4]),
        end: stamp(match[5], match[6], match[7], match[8]),
        text: lines.slice(timeIndex + 1).join(" "),
      });
    }
    return tidyCues(cues);
  }

  const ZH_HANS = new Set(["zh", "zh-cn", "zh-hans", "zh-sg"]);
  const ZH_HANT = new Set(["zh-tw", "zh-hk", "zh-hant", "zh-mo"]);

  function norm(code) {
    return String(code || "").toLowerCase().replaceAll("_", "-");
  }

  function languageRank(requested, code) {
    const req = norm(requested);
    const got = norm(code);
    if (!req || req === "auto") return 0;
    if (got === req) return 100;
    if (ZH_HANS.has(req) && ZH_HANS.has(got)) return 95;
    if (ZH_HANT.has(req) && ZH_HANT.has(got)) return 95;
    if (got.split("-")[0] === req.split("-")[0]) return 70;
    return -1;
  }

  function autoPreference(code) {
    const got = norm(code);
    const order = ["zh-hans", "zh-cn", "zh", "en", "en-us", "ja", "ko"];
    const index = order.indexOf(got);
    if (index >= 0) return order.length - index;
    if (ZH_HANS.has(got)) return 20;
    return 0;
  }

  function chooseTrack(tracks, requested) {
    const ranked = [];
    for (const track of tracks) {
      let rank = languageRank(requested, track.language);
      if (rank < 0) continue;
      if (!requested || requested === "auto") {
        rank = autoPreference(track.language) + (track.auto ? 0 : 30);
        if (rank <= 0 && track.auto) rank = 1;
      }
      ranked.push([rank, track.auto ? 0 : 5, track]);
    }
    ranked.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    return ranked.length ? ranked[0][2] : null;
  }

  function activeCueIndex(cues, time) {
    let lo = 0;
    let hi = cues.length - 1;
    let answer = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= time + 0.05) {
        answer = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (answer < 0) return -1;
    if (time <= cues[answer].end + 0.25) return answer;
    return -1;
  }

  root.MuyiParse = {
    parseJson3,
    parseVtt,
    parseSrt,
    tidyCues,
    chooseTrack,
    languageRank,
    activeCueIndex,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
