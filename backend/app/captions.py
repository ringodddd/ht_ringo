"""把 YouTube 字幕轨道整理成带时间轴的句子。"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse
import xml.etree.ElementTree as ET


class CaptionError(Exception):
    def __init__(self, message: str, code: str = "caption_error"):
        super().__init__(message)
        self.code = code


@dataclass
class Cue:
    start: float
    end: float
    text: str

    def as_dict(self, index: int) -> dict:
        return {
            "i": index,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "text": self.text,
        }


_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}


def parse_video_id(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        raise CaptionError("请先粘贴 YouTube 链接。", "bad_url")
    if re.fullmatch(r"[\w-]{11}", raw):
        return raw
    if "://" not in raw:
        raw = "https://" + raw
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if host not in _YOUTUBE_HOSTS:
        raise CaptionError("只接受 YouTube 链接。", "bad_url")
    if host.endswith("youtu.be"):
        video_id = parsed.path.strip("/").split("/")[0]
    else:
        qs = parse_qs(parsed.query)
        video_id = (qs.get("v") or [""])[0]
        if not video_id:
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) >= 2 and parts[0] in {"shorts", "embed", "live", "v"}:
                video_id = parts[1]
    if not re.fullmatch(r"[\w-]{11}", video_id or ""):
        raise CaptionError("这个链接里没有视频 ID。", "bad_url")
    return video_id


def _clean_text(value: str) -> str:
    text = html.unescape(value or "")
    text = text.replace("\u200b", "")
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def tidy_cues(cues: list[Cue]) -> list[Cue]:
    """去掉空行、滚动字幕的重复，并把重叠的结束时间收到下一句。"""
    cleaned: list[Cue] = []
    for cue in cues:
        text = _clean_text(cue.text)
        if not text:
            continue
        start = max(0.0, float(cue.start))
        end = float(cue.end)
        if end <= start:
            end = start + 1.6
        current = Cue(start, end, text)
        if cleaned:
            prev = cleaned[-1]
            same_window = current.start < prev.end + 0.35
            if current.text == prev.text:
                prev.end = max(prev.end, current.end)
                continue
            if same_window and (
                current.text.startswith(prev.text) or prev.text.startswith(current.text)
            ):
                if len(current.text) >= len(prev.text):
                    prev.text = current.text
                prev.start = min(prev.start, current.start)
                prev.end = max(prev.end, current.end)
                continue
        cleaned.append(current)
    for index, cue in enumerate(cleaned[:-1]):
        nxt = cleaned[index + 1]
        if cue.end > nxt.start:
            cue.end = max(cue.start + 0.2, nxt.start)
    return cleaned


def parse_json3(payload: dict | str) -> list[Cue]:
    data = json.loads(payload) if isinstance(payload, str) else payload
    cues: list[Cue] = []
    for event in data.get("events") or []:
        segs = event.get("segs") or []
        text = "".join(seg.get("utf8", "") for seg in segs)
        start_ms = event.get("tStartMs")
        if start_ms is None:
            continue
        dur_ms = event.get("dDurationMs", event.get("dDurMs", 0)) or 0
        cues.append(Cue(start_ms / 1000, (start_ms + dur_ms) / 1000, text))
    return tidy_cues(cues)


_VTT_TIME = re.compile(
    r"(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})"
)


def _stamp(hours: str | None, minutes: str, seconds: str, millis: str) -> float:
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def parse_vtt(text: str) -> list[Cue]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cues: list[Cue] = []
    index = 0
    while index < len(lines):
        match = _VTT_TIME.search(lines[index])
        if not match:
            index += 1
            continue
        start = _stamp(*match.group(1, 2, 3, 4))
        end = _stamp(*match.group(5, 6, 7, 8))
        index += 1
        buf: list[str] = []
        while index < len(lines) and lines[index].strip():
            buf.append(lines[index])
            index += 1
        cues.append(Cue(start, end, " ".join(buf)))
    return tidy_cues(cues)


_SRT_TIME = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[,.](\d{3})"
)


def parse_srt(text: str) -> list[Cue]:
    blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n").strip())
    cues: list[Cue] = []
    for block in blocks:
        lines = block.split("\n")
        time_index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if time_index is None:
            continue
        match = _SRT_TIME.search(lines[time_index])
        if not match:
            continue
        start = _stamp(match.group(1), match.group(2), match.group(3), match.group(4))
        end = _stamp(match.group(5), match.group(6), match.group(7), match.group(8))
        cues.append(Cue(start, end, " ".join(lines[time_index + 1 :])))
    return tidy_cues(cues)


def parse_timedtext_xml(text: str) -> list[Cue]:
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise CaptionError("字幕文件不是有效的 XML。", "bad_subs") from exc
    cues: list[Cue] = []
    if root.tag == "transcript":
        for node in root.findall("text"):
            start = float(node.attrib.get("start", "0"))
            dur = float(node.attrib.get("dur", "0"))
            cues.append(Cue(start, start + dur, "".join(node.itertext())))
        return tidy_cues(cues)
    # srv3: <p t="毫秒" d="毫秒">
    for node in root.iter("p"):
        if "t" not in node.attrib:
            continue
        start = int(node.attrib.get("t", "0")) / 1000
        dur = int(node.attrib.get("d", "0")) / 1000
        cues.append(Cue(start, start + dur, "".join(node.itertext())))
    return tidy_cues(cues)


def parse_caption_payload(text: str, ext: str) -> list[Cue]:
    kind = (ext or "").lower().split("?")[0]
    body = text.lstrip("\ufeff").strip()
    if not body:
        raise CaptionError("字幕是空的。", "empty_subs")
    if kind in {"json3", "json"} or body.startswith("{") or body.startswith("["):
        try:
            return parse_json3(body)
        except json.JSONDecodeError:
            if kind in {"json3", "json"}:
                raise CaptionError("json3 字幕解析失败。", "bad_subs")
    if kind == "srt" or (body[:3].strip().startswith("1") and "-->" in body[:200]):
        srt = parse_srt(body)
        if srt:
            return srt
    if kind in {"vtt", "webvtt"} or body.startswith("WEBVTT"):
        return parse_vtt(body)
    if body.startswith("<"):
        return parse_timedtext_xml(body)
    vtt = parse_vtt(body)
    if vtt:
        return vtt
    raise CaptionError("认不出这个字幕格式。支持 json3、vtt、srt。", "bad_subs")


def cues_to_srt(cues: list[dict], bilingual: bool = False) -> str:
    blocks: list[str] = []
    number = 1
    for cue in cues:
        text = (cue.get("text") or "").strip()
        translation = (cue.get("translation") or "").strip()
        if bilingual:
            line = "\n".join(part for part in (text, translation) if part)
        else:
            line = translation or text
        if not line:
            continue
        blocks.append(
            f"{number}\n{_srt_time(cue['start'])} --> {_srt_time(cue['end'])}\n{line}\n"
        )
        number += 1
    return "\n".join(blocks)


def _srt_time(seconds: float) -> str:
    millis = max(0, int(round(float(seconds) * 1000)))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"
