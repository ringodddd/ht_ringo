"""用 yt-dlp（以及可选的 Invidious）读取 YouTube 字幕，不下载视频。"""

from __future__ import annotations

import os
from typing import Any

import httpx

from .captions import CaptionError, parse_caption_payload, parse_video_id

_FORMAT_PREF = ("json3", "vtt", "srv3", "srv2", "srv1", "ttml", "srt")
_ZH_HANS = {"zh", "zh-cn", "zh-hans", "zh-sg"}
_ZH_HANT = {"zh-tw", "zh-hk", "zh-hant", "zh-mo"}


def _norm(code: str) -> str:
    return (code or "").lower().replace("_", "-")


def language_rank(requested: str, code: str) -> int:
    """分数越高越接近用户想要的语言。-1 表示不匹配。"""
    req = _norm(requested)
    got = _norm(code)
    if not req or req == "auto":
        return 0
    if got == req:
        return 100
    if req in _ZH_HANS and got in _ZH_HANS:
        return 95
    if req in _ZH_HANT and got in _ZH_HANT:
        return 95
    if got.split("-")[0] == req.split("-")[0]:
        return 70
    return -1


def _auto_preference(code: str) -> int:
    got = _norm(code)
    order = ["zh-hans", "zh-cn", "zh", "en", "en-us", "ja", "ko"]
    if got in order:
        return len(order) - order.index(got)
    if got in _ZH_HANS:
        return 20
    return 0


def choose_track(tracks: list[dict], requested: str) -> dict | None:
    """tracks 项包含 language、name、auto、formats。人工字幕优先于同语言的自动字幕。"""
    ranked: list[tuple[int, int, int, dict]] = []
    for track in tracks:
        rank = language_rank(requested, track["language"])
        if rank < 0:
            continue
        if not requested or requested == "auto":
            rank = _auto_preference(track["language"]) + (30 if not track["auto"] else 0)
            if rank <= 0 and track["auto"]:
                rank = 1
        manual_bias = 0 if track["auto"] else 5
        ranked.append((rank, manual_bias, 0 if track["auto"] else 1, track))
    if not ranked and requested and requested != "auto":
        return None
    if not ranked:
        return None
    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return ranked[0][3]


def best_format(formats: list[dict]) -> dict | None:
    by_ext: dict[str, dict] = {}
    for fmt in formats or []:
        ext = (fmt.get("ext") or "").lower()
        if fmt.get("url") and ext not in by_ext:
            by_ext[ext] = fmt
    for ext in _FORMAT_PREF:
        if ext in by_ext:
            return by_ext[ext]
    for fmt in formats or []:
        if fmt.get("url"):
            return fmt
    return None


def _track_name(code: str, formats: list[dict]) -> str:
    for fmt in formats or []:
        name = fmt.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return code


def tracks_from_info(info: dict) -> list[dict]:
    found: list[dict] = []
    for auto, key in ((False, "subtitles"), (True, "automatic_captions")):
        bucket = info.get(key) or {}
        for code, formats in bucket.items():
            if code == "live_chat" or not formats:
                continue
            found.append(
                {
                    "language": code,
                    "name": _track_name(code, formats),
                    "auto": auto,
                    "formats": formats,
                }
            )
    return found


def _public_track(track: dict) -> dict:
    return {
        "language": track["language"],
        "name": track["name"],
        "auto": bool(track["auto"]),
    }


async def _download_caption(url: str, ext: str) -> list[dict]:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (compatible; Muyi/0.1; +https://github.com/yt-dlp/yt-dlp)"
        )
    }
    async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers=headers) as client:
        response = await client.get(url)
    if response.status_code >= 400:
        raise CaptionError(f"字幕地址返回了 {response.status_code}。", "subtitle_http")
    body = response.text
    lowered = body[:400].lower()
    if "<html" in lowered and "timedtext" not in lowered and not body.lstrip().startswith("<transcript"):
        raise CaptionError("字幕地址返回了网页而不是字幕。", "subtitle_http")
    cues = parse_caption_payload(body, ext)
    if not cues:
        raise CaptionError("这条字幕轨道是空的。", "empty_subs")
    return [cue.as_dict(index) for index, cue in enumerate(cues)]


def _ydl_error_message(exc: Exception) -> CaptionError:
    text = str(exc)
    lowered = text.lower()
    if "sign in to confirm" in lowered or "not a bot" in lowered or "login_required" in lowered:
        return CaptionError(
            "YouTube 把这次请求当成了机器人，没有返回字幕。可以改用浏览器扩展（在你自己的油管页面里取字幕），"
            "或在设置里上传 cookies.txt，也可以直接导入 SRT / VTT。",
            "bot_check",
        )
    if "private video" in lowered:
        return CaptionError("这个视频是私密的。", "private")
    if "video unavailable" in lowered or "not available" in lowered:
        return CaptionError("这个视频不可用，或在当前地区被挡住了。", "unavailable")
    if "age" in lowered and "confirm" in lowered:
        return CaptionError("这个视频有年龄限制。上传已登录的 cookies 后再试。", "age_restricted")
    return CaptionError(f"读取视频信息失败：{text.splitlines()[0][:240]}", "yt_dlp")


def extract_info(url: str, cookies: str | None, clients: list[str]) -> dict[str, Any]:
    try:
        import yt_dlp
        from yt_dlp.utils import DownloadError
    except ImportError as exc:
        raise CaptionError("服务器没装 yt-dlp，无法拉取字幕。", "missing_ytdlp") from exc

    opts: dict[str, Any] = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "extractor_args": {"youtube": {"player_client": clients or ["web", "android"]}},
    }
    if cookies:
        opts["cookiefile"] = cookies
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as exc:
        raise _ydl_error_message(exc) from exc
    except Exception as exc:
        raise _ydl_error_message(exc) from exc
    if not info:
        raise CaptionError("没有拿到视频信息。", "yt_dlp")
    return info


async def _from_invidious(video_id: str, instances: list[str], requested: str) -> dict | None:
    headers = {"User-Agent": "Muyi/0.1", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=18, follow_redirects=True, headers=headers) as client:
        for instance in instances:
            base = instance.rstrip("/")
            try:
                listed = await client.get(f"{base}/api/v1/captions/{video_id}")
            except httpx.HTTPError:
                continue
            if listed.status_code != 200:
                continue
            try:
                payload = listed.json()
            except ValueError:
                continue
            rows = payload.get("captions") if isinstance(payload, dict) else payload
            if not isinstance(rows, list) or not rows:
                continue
            tracks = []
            for row in rows:
                code = row.get("language_code") or row.get("languageCode") or ""
                label = row.get("label") or code
                url = row.get("url") or ""
                if url.startswith("/"):
                    url = base + url
                if not code or not url:
                    continue
                tracks.append(
                    {
                        "language": code,
                        "name": label,
                        "auto": False,
                        "formats": [{"ext": "vtt", "url": url, "name": label}],
                    }
                )
            chosen = choose_track(tracks, requested)
            if not chosen:
                continue
            fmt = best_format(chosen["formats"])
            if not fmt:
                continue
            try:
                cues = await _download_caption(fmt["url"], "vtt")
            except CaptionError:
                continue
            meta = await _invidious_meta(client, base, video_id)
            return {
                "videoId": video_id,
                "title": meta.get("title") or video_id,
                "author": meta.get("author") or "",
                "duration": meta.get("duration") or _duration_from_cues(cues),
                "track": _public_track(chosen),
                "available": [_public_track(track) for track in tracks],
                "cues": cues,
                "source": "invidious",
            }
    return None


async def _invidious_meta(client: httpx.AsyncClient, base: str, video_id: str) -> dict:
    try:
        response = await client.get(f"{base}/api/v1/videos/{video_id}")
        if response.status_code == 200:
            data = response.json()
            return {
                "title": data.get("title") or "",
                "author": data.get("author") or "",
                "duration": data.get("lengthSeconds") or 0,
            }
    except (httpx.HTTPError, ValueError):
        pass
    return {}


def _duration_from_cues(cues: list[dict]) -> float:
    if not cues:
        return 0
    return float(cues[-1]["end"])


def _session_from_info(info: dict, video_id: str, requested: str) -> dict:
    tracks = tracks_from_info(info)
    if not tracks:
        raise CaptionError("这个视频没有字幕轨道。可以改用扩展，或自己导入 SRT / VTT。", "no_captions")
    chosen = choose_track(tracks, requested)
    if not chosen:
        languages = "、".join(track["language"] for track in tracks[:12])
        raise CaptionError(f"没有找到 {requested} 字幕。可用语言：{languages}", "lang_missing")
    fmt = best_format(chosen["formats"])
    if not fmt:
        raise CaptionError("找到了字幕语言，但没有可下载的地址。", "no_caption_url")
    return {
        "videoId": info.get("id") or video_id,
        "title": info.get("title") or video_id,
        "author": info.get("uploader") or info.get("channel") or "",
        "duration": info.get("duration") or 0,
        "track": _public_track(chosen),
        "available": [_public_track(track) for track in tracks],
        "format": fmt,
        "source": "youtube",
    }


async def load_captions(
    url: str,
    lang: str = "auto",
    cookies: str | None = None,
    invidious_instances: list[str] | None = None,
    player_clients: list[str] | None = None,
) -> dict:
    video_id = parse_video_id(url)
    watch = f"https://www.youtube.com/watch?v={video_id}"
    clients = player_clients or ["web", "android", "ios"]
    info_error: CaptionError | None = None
    try:
        info = extract_info(watch, cookies, clients)
        session = _session_from_info(info, video_id, lang or "auto")
        fmt = session.pop("format")
        session["cues"] = await _download_caption(fmt["url"], fmt.get("ext") or "vtt")
        if not session["duration"]:
            session["duration"] = _duration_from_cues(session["cues"])
        return session
    except CaptionError as exc:
        info_error = exc
        if exc.code not in {"bot_check", "yt_dlp", "unavailable", "no_captions", "no_caption_url"}:
            raise

    instances = [item.strip() for item in (invidious_instances or []) if item.strip()]
    if not instances:
        raw = os.environ.get("INVIDIOUS_INSTANCES", "")
        instances = [item.strip() for item in raw.split(",") if item.strip()]
    if instances:
        fallback = await _from_invidious(video_id, instances, lang or "auto")
        if fallback:
            return fallback
    if info_error:
        raise info_error
    raise CaptionError("没有拿到字幕。", "caption_error")
