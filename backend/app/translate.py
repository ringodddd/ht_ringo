"""把字幕分批送给 OpenAI 兼容接口，并按行缓存译文。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sqlite3
import time
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import urlparse

import httpx

LANG_NAMES = {
    "zh-Hans": "简体中文",
    "zh-Hant": "繁体中文",
    "en": "英语",
    "ja": "日语",
    "ko": "韩语",
    "es": "西班牙语",
    "fr": "法语",
    "de": "德语",
    "ru": "俄语",
    "pt": "葡萄牙语",
    "vi": "越南语",
    "th": "泰语",
    "id": "印尼语",
    "ar": "阿拉伯语",
}


class TranslateError(Exception):
    pass


class LineCache:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS lines (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts REAL NOT NULL)"
        )

    def get_many(self, keys: list[str]) -> dict[str, str]:
        if not keys:
            return {}
        found: dict[str, str] = {}
        for start in range(0, len(keys), 400):
            chunk = keys[start : start + 400]
            marks = ",".join("?" for _ in chunk)
            rows = self._conn.execute(
                f"SELECT k, v FROM lines WHERE k IN ({marks})", chunk
            ).fetchall()
            found.update(rows)
        return found

    def put_many(self, pairs: list[tuple[str, str]]) -> None:
        if not pairs:
            return
        now = time.time()
        with self._conn:
            self._conn.executemany(
                "INSERT INTO lines (k, v, ts) VALUES (?, ?, ?) "
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts",
                [(key, value, now) for key, value in pairs],
            )


def cache_key(model: str, target: str, host: str, extra: str, text: str) -> str:
    raw = "\0".join([model, target, host, extra, text])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def chat_completions_url(base: str) -> str:
    cleaned = (base or "").strip().rstrip("/")
    if not cleaned:
        raise TranslateError("还没有填写 API Base URL。")
    if not cleaned.startswith(("http://", "https://")):
        raise TranslateError("API Base URL 需要以 http:// 或 https:// 开头。")
    if cleaned.endswith("/chat/completions"):
        return cleaned
    return cleaned + "/chat/completions"


def endpoint_host(base: str) -> str:
    try:
        return urlparse(chat_completions_url(base)).netloc.lower()
    except TranslateError:
        return ""


def extract_json_object(content: str) -> dict | None:
    text = (content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def parse_translations(content: str, expected: int) -> list[str] | None:
    data = extract_json_object(content)
    if not data:
        return None
    rows = data.get("translations")
    if not isinstance(rows, list) or len(rows) != expected:
        return None
    parsed: list[str] = []
    for item in rows:
        if item is None:
            parsed.append("")
        elif isinstance(item, str):
            parsed.append(item.strip())
        else:
            parsed.append(str(item).strip())
    return parsed


def build_messages(
    lines: list[str],
    target_lang: str,
    source_lang: str,
    context_before: list[str],
    extra: str,
) -> list[dict]:
    target_name = LANG_NAMES.get(target_lang, target_lang or "简体中文")
    source_name = "自动判断" if not source_lang or source_lang == "auto" else LANG_NAMES.get(source_lang, source_lang)
    system = (
        "你是影视字幕翻译。把用户给出的字幕逐行翻译成目标语言。"
        "同一批里的前后句只作为语境，输出必须和 lines 逐行对应。\n"
        "规则：\n"
        "1. 只输出 JSON 对象，形如 {\"translations\":[\"...\"]}，数组长度必须与 lines 完全相同。\n"
        "2. 不要合并、拆分或漏掉任何一行。原文为空就输出空字符串。\n"
        "3. 口语自然、简短，适合压在画面底部阅读。保留语气和人称。\n"
        "4. 专有名词用通用译名；没有把握时保留原文。\n"
        "5. 不要加序号、引号、解释或 markdown。\n"
        "6. [Music]、[Applause] 这类音效标记译成简短目标语言标记。"
    )
    if extra.strip():
        system += "\n补充要求：\n" + extra.strip()[:800]
    payload = {
        "target": target_name,
        "source": source_name,
        "context_before": context_before[-2:],
        "lines": lines,
    }
    return [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": (
                "context_before 是上一两句原文，只供理解，不要翻译它们。"
                "请只翻译 lines。\n"
                + json.dumps(payload, ensure_ascii=False)
            ),
        },
    ]


def _max_tokens(lines: list[str]) -> int:
    chars = sum(len(line) for line in lines)
    return min(4096, max(256, chars * 3 + 128))


async def request_translations(
    client: httpx.AsyncClient,
    url: str,
    api_key: str,
    model: str,
    lines: list[str],
    target_lang: str,
    source_lang: str,
    context_before: list[str],
    extra: str,
) -> list[str]:
    if len(lines) == 1 and not lines[0].strip():
        return [""]
    messages = build_messages(lines, target_lang, source_lang, context_before, extra)
    body = {
        "model": model,
        "temperature": 0.2,
        "max_tokens": _max_tokens(lines),
        "messages": messages,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    delay = 1.0
    last_error = "翻译接口没有返回可用结果。"
    for attempt in range(3):
        try:
            response = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            last_error = f"连接翻译接口失败：{exc.__class__.__name__}"
            await asyncio.sleep(delay)
            delay *= 2
            continue
        if response.status_code == 429 or response.status_code >= 500:
            last_error = f"翻译接口暂时不可用（HTTP {response.status_code}）。"
            await asyncio.sleep(delay)
            delay *= 2
            continue
        if response.status_code >= 400:
            detail = _error_detail(response)
            raise TranslateError(f"翻译接口拒绝了请求（HTTP {response.status_code}）：{detail}")
        try:
            payload = response.json()
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise TranslateError("翻译接口的返回里没有 choices[0].message.content。") from exc
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part) for part in content
            )
        parsed = parse_translations(str(content), len(lines))
        if parsed is not None:
            return parsed
        if len(lines) == 1:
            plain = str(content).strip().strip('"')
            if plain and not plain.startswith("{"):
                return [plain]
        if len(lines) > 1:
            mid = max(1, len(lines) // 2)
            left_ctx = context_before
            right_ctx = context_before + lines[:mid]
            left = await request_translations(
                client, url, api_key, model, lines[:mid], target_lang, source_lang, left_ctx, extra
            )
            right = await request_translations(
                client, url, api_key, model, lines[mid:], target_lang, source_lang, right_ctx[-2:], extra
            )
            return left + right
        last_error = "模型没有按行返回译文。"
        break
    raise TranslateError(last_error)


def _error_detail(response: httpx.Response) -> str:
    try:
        data = response.json()
        err = data.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err)[:240]
        if isinstance(err, str):
            return err[:240]
    except ValueError:
        pass
    return response.text[:240].replace("\n", " ")


def _context_before(cue: dict, ordered: list[dict]) -> list[str]:
    first_i = cue.get("i")
    if isinstance(first_i, int):
        earlier = [
            item.get("text") or ""
            for item in ordered
            if isinstance(item.get("i"), int) and item["i"] < first_i
        ]
        return earlier[-2:]
    try:
        pos = next(index for index, item in enumerate(ordered) if item is cue)
    except StopIteration:
        return []
    return [item.get("text") or "" for item in ordered[max(0, pos - 2) : pos]]


def make_batches(items: list[dict], size: int = 24, max_chars: int = 1600) -> list[list[dict]]:
    batches: list[list[dict]] = []
    current: list[dict] = []
    chars = 0
    for item in items:
        text = item.get("text") or ""
        if current and (len(current) >= size or chars + len(text) > max_chars):
            batches.append(current)
            current = []
            chars = 0
        current.append(item)
        chars += len(text)
    if current:
        batches.append(current)
    return batches


async def translate_cues(
    cues: list[dict],
    *,
    target_lang: str,
    source_lang: str,
    base_url: str,
    api_key: str,
    model: str,
    extra: str,
    cache: LineCache | None,
    mock: bool,
    concurrency: int = 2,
) -> AsyncIterator[dict]:
    ordered = list(cues)
    host = "mock" if mock else endpoint_host(base_url)
    if not mock:
        chat_completions_url(base_url)
        if not api_key:
            raise TranslateError("缺少 API Key。填在页面设置里，或配置服务器的 LLM_API_KEY。")
        if not model:
            raise TranslateError("缺少模型名。")
    keys = [
        cache_key(model or "mock", target_lang, host, extra, cue.get("text") or "")
        for cue in ordered
    ]
    cached = cache.get_many(keys) if cache else {}
    yield {"event": "meta", "data": {"total": len(ordered), "cached": len(cached)}}

    pending: list[tuple[int, dict]] = []
    done = 0
    for index, cue in enumerate(ordered):
        hit = cached.get(keys[index])
        if hit is None:
            pending.append((index, cue))
            continue
        done += 1
        yield {"event": "cue", "data": {"i": cue.get("i", index), "translation": hit}}
    if done:
        yield {"event": "progress", "data": {"done": done, "total": len(ordered)}}
    if not pending:
        yield {"event": "done", "data": {"translated": 0, "cached": done}}
        return

    url = "" if mock else chat_completions_url(base_url)
    pending_batches = make_batches([cue for _, cue in pending])

    semaphore = asyncio.Semaphore(max(1, concurrency))
    timeout = httpx.Timeout(120.0, connect=15.0)

    async def run_batch(batch: list[dict], client: httpx.AsyncClient) -> list[tuple[dict, str, str]]:
        async with semaphore:
            lines = [cue.get("text") or "" for cue in batch]
            context = _context_before(batch[0], ordered)
            if mock:
                translated = [f"【译】{line}" if line.strip() else "" for line in lines]
            else:
                translated = await request_translations(
                    client,
                    url,
                    api_key,
                    model,
                    lines,
                    target_lang,
                    source_lang,
                    context,
                    extra,
                )
            pairs = []
            for cue, text in zip(batch, translated):
                key = cache_key(model or "mock", target_lang, host, extra, cue.get("text") or "")
                pairs.append((cue, text, key))
            return pairs

    async with httpx.AsyncClient(timeout=timeout) as client:
        tasks = [asyncio.create_task(run_batch(batch, client)) for batch in pending_batches]
        try:
            for finished in asyncio.as_completed(tasks):
                pairs = await finished
                if cache:
                    cache.put_many([(key, text) for _, text, key in pairs])
                for cue, text, _key in pairs:
                    done += 1
                    original_index = cue.get("i", 0)
                    yield {
                        "event": "cue",
                        "data": {"i": original_index, "translation": text},
                    }
                yield {"event": "progress", "data": {"done": done, "total": len(ordered)}}
        except Exception:
            for task in tasks:
                task.cancel()
            raise
    yield {"event": "done", "data": {"translated": len(pending), "cached": len(cached)}}
