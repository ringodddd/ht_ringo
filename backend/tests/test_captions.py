import json
from pathlib import Path

from app.captions import (
    cues_to_srt,
    parse_json3,
    parse_srt,
    parse_video_id,
    parse_vtt,
)
from app.youtube import choose_track, language_rank

FIXTURES = Path(__file__).parent / "fixtures"


def test_video_id_from_common_urls():
    assert parse_video_id("jNQXAC9IVRw") == "jNQXAC9IVRw"
    assert parse_video_id("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=3s") == "jNQXAC9IVRw"
    assert parse_video_id("https://youtu.be/jNQXAC9IVRw") == "jNQXAC9IVRw"
    assert parse_video_id("https://www.youtube.com/shorts/jNQXAC9IVRw") == "jNQXAC9IVRw"
    assert parse_video_id("https://www.youtube.com/embed/jNQXAC9IVRw") == "jNQXAC9IVRw"


def test_reject_non_youtube():
    try:
        parse_video_id("https://example.com/watch?v=jNQXAC9IVRw")
    except Exception as exc:
        assert "YouTube" in str(exc)
    else:
        raise AssertionError("should reject")


def test_json3_drops_empty_and_merges_duplicate():
    cues = parse_json3(json.loads((FIXTURES / "sample.json3").read_text()))
    texts = [cue.text for cue in cues]
    assert texts == ["Hello there.", "General Kenobi.", "A surprise."]
    assert cues[0].start == 0.48
    assert cues[1].end == 7.6
    assert cues[2].end == 9.6


def test_rolling_vtt_collapses_growth():
    cues = parse_vtt((FIXTURES / "rolling.vtt").read_text())
    assert [cue.text for cue in cues] == ["hello there", "how are you"]
    assert cues[0].start == 0
    assert cues[1].end == 5.5


def test_srt_unescapes_and_keeps_two_cues():
    cues = parse_srt((FIXTURES / "sample.srt").read_text())
    assert [cue.text for cue in cues] == ["First line.", "Second & last."]
    assert cues[0].start == 1
    assert cues[1].end == 5


def test_language_rank_and_choice():
    assert language_rank("zh-Hans", "zh-CN") == 95
    assert language_rank("en", "en-US") == 70
    assert language_rank("en", "ja") == -1
    tracks = [
        {"language": "en", "name": "English", "auto": True, "formats": []},
        {"language": "zh-CN", "name": "中文", "auto": False, "formats": []},
        {"language": "fr", "name": "French", "auto": False, "formats": []},
    ]
    picked = choose_track(tracks, "auto")
    assert picked["language"] == "zh-CN"
    assert choose_track(tracks, "en")["auto"] is True
    assert choose_track(tracks, "ja") is None


def test_srt_export_bilingual():
    text = cues_to_srt(
        [
            {"start": 1, "end": 2.5, "text": "Hello", "translation": "你好"},
            {"start": 2.5, "end": 4, "text": "", "translation": ""},
        ],
        bilingual=True,
    )
    assert "00:00:01,000 --> 00:00:02,500" in text
    assert "Hello\n你好" in text
    assert text.strip().startswith("1")
