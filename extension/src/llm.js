/* 扩展后台用来调用 OpenAI 兼容接口。 */
(function (root) {
  const LANG_NAMES = {
    "zh-Hans": "简体中文",
    "zh-Hant": "繁体中文",
    en: "英语",
    ja: "日语",
    ko: "韩语",
    es: "西班牙语",
    fr: "法语",
    de: "德语",
    ru: "俄语",
    pt: "葡萄牙语",
    vi: "越南语",
    th: "泰语",
    id: "印尼语",
    ar: "阿拉伯语",
  };

  function chatUrl(base) {
    const cleaned = String(base || "").trim().replace(/\/+$/, "");
    if (!cleaned) throw new Error("还没有填写 API Base URL。");
    if (!/^https?:\/\//.test(cleaned)) throw new Error("API Base URL 需要以 http:// 或 https:// 开头。");
    if (cleaned.endsWith("/chat/completions")) return cleaned;
    return `${cleaned}/chat/completions`;
  }

  function extractJson(content) {
    let text = String(content || "").trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }
    try {
      const direct = JSON.parse(text);
      if (direct && typeof direct === "object") return direct;
    } catch {
      /* 继续从正文里抠 JSON */
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function parseTranslations(content, expected) {
    const data = extractJson(content);
    const rows = data && data.translations;
    if (!Array.isArray(rows) || rows.length !== expected) return null;
    return rows.map((item) => (item == null ? "" : String(item).trim()));
  }

  function messages(lines, targetLang, sourceLang, contextBefore, extra) {
    const target = LANG_NAMES[targetLang] || targetLang || "简体中文";
    const source = !sourceLang || sourceLang === "auto" ? "自动判断" : LANG_NAMES[sourceLang] || sourceLang;
    let system =
      "你是影视字幕翻译。把用户给出的字幕逐行翻译成目标语言。" +
      "同一批里的前后句只作为语境，输出必须和 lines 逐行对应。\n" +
      "规则：\n" +
      '1. 只输出 JSON 对象，形如 {"translations":["..."]}，数组长度必须与 lines 完全相同。\n' +
      "2. 不要合并、拆分或漏掉任何一行。原文为空就输出空字符串。\n" +
      "3. 口语自然、简短，适合压在画面底部阅读。保留语气和人称。\n" +
      "4. 专有名词用通用译名；没有把握时保留原文。\n" +
      "5. 不要加序号、引号、解释或 markdown。\n" +
      "6. [Music]、[Applause] 这类音效标记译成简短目标语言标记。";
    if (extra && extra.trim()) system += `\n补充要求：\n${extra.trim().slice(0, 800)}`;
    const payload = {
      target,
      source,
      context_before: (contextBefore || []).slice(-2),
      lines,
    };
    return [
      { role: "system", content: system },
      {
        role: "user",
        content: `context_before 是上一两句原文，只供理解，不要翻译它们。请只翻译 lines。\n${JSON.stringify(payload)}`,
      },
    ];
  }

  async function once(url, apiKey, model, lines, targetLang, sourceLang, contextBefore, extra) {
    const chars = lines.reduce((sum, line) => sum + line.length, 0);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: Math.min(4096, Math.max(256, chars * 3 + 128)),
        messages: messages(lines, targetLang, sourceLang, contextBefore, extra),
      }),
    });
    if (response.status === 429 || response.status >= 500) {
      const error = new Error(`翻译接口暂时不可用（HTTP ${response.status}）。`);
      error.retry = true;
      throw error;
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.error?.message || body.error || "";
      } catch {
        detail = "";
      }
      throw new Error(`翻译接口拒绝了请求（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
    }
    const payload = await response.json();
    let content = payload.choices?.[0]?.message?.content;
    if (Array.isArray(content)) {
      content = content.map((part) => (typeof part === "string" ? part : part.text || "")).join("");
    }
    if (typeof content !== "string") throw new Error("翻译接口的返回里没有文本。");
    const parsed = parseTranslations(content, lines.length);
    if (parsed) return parsed;
    if (lines.length === 1) {
      const plain = content.trim().replace(/^"|"$/g, "");
      if (plain && !plain.startsWith("{")) return [plain];
    }
    if (lines.length > 1) {
      const mid = Math.max(1, Math.floor(lines.length / 2));
      const left = await translateBatch({
        baseUrl: url,
        apiKey,
        model,
        lines: lines.slice(0, mid),
        targetLang,
        sourceLang,
        contextBefore,
        extra,
        alreadyUrl: true,
      });
      const right = await translateBatch({
        baseUrl: url,
        apiKey,
        model,
        lines: lines.slice(mid),
        targetLang,
        sourceLang,
        contextBefore: contextBefore.concat(lines.slice(0, mid)).slice(-2),
        extra,
        alreadyUrl: true,
      });
      return left.concat(right);
    }
    throw new Error("模型没有按行返回译文。");
  }

  async function translateBatch(options) {
    const url = options.alreadyUrl ? options.baseUrl : chatUrl(options.baseUrl);
    if (!options.apiKey) throw new Error("先在扩展里填写 API Key。");
    if (!options.model) throw new Error("先在扩展里填写模型名。");
    let last = "翻译失败。";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await once(
          url,
          options.apiKey,
          options.model,
          options.lines,
          options.targetLang,
          options.sourceLang,
          options.contextBefore || [],
          options.extra || "",
        );
      } catch (error) {
        last = error.message || String(error);
        if (!error.retry) throw error;
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
    throw new Error(last);
  }

  root.MuyiLlm = { translateBatch, chatUrl, parseTranslations };
})(typeof globalThis !== "undefined" ? globalThis : this);
