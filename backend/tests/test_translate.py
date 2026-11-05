import asyncio
import json

import httpx

from app.translate import (
    chat_completions_url,
    extract_json_object,
    make_batches,
    parse_translations,
    translate_cues,
)


def test_chat_url_accepts_base_or_full_path():
    assert chat_completions_url("https://api.deepseek.com/v1") == "https://api.deepseek.com/v1/chat/completions"
    assert (
        chat_completions_url("https://example.com/v1/chat/completions")
        == "https://example.com/v1/chat/completions"
    )


def test_parse_translations_from_fence():
    raw = '```json\n{"translations":["甲", "乙"]}\n```'
    assert parse_translations(raw, 2) == ["甲", "乙"]
    assert parse_translations('{"translations":["only"]}', 2) is None
    wrapped = '好的\n{"translations":["一行"]}\n谢谢'
    assert extract_json_object(wrapped)["translations"] == ["一行"]


def test_batches_respect_char_budget():
    cues = [{"i": i, "text": "字" * 50} for i in range(5)]
    groups = make_batches(cues, size=10, max_chars=120)
    assert [len(group) for group in groups] == [2, 2, 1]


def test_mock_translate_uses_cache(tmp_path, monkeypatch):
    asyncio.run(_mock_translate_uses_cache(tmp_path, monkeypatch))


async def _mock_translate_uses_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("MUYI_MOCK_TRANSLATE", "1")
    from app.translate import LineCache

    cache = LineCache(tmp_path / "lines.sqlite3")
    cues = [{"i": 0, "text": "Hello"}, {"i": 1, "text": "Again"}]
    events = []
    async for event in translate_cues(
        cues,
        target_lang="zh-Hans",
        source_lang="en",
        base_url="http://mock.local/v1",
        api_key="mock",
        model="mock",
        extra="",
        cache=cache,
        mock=True,
    ):
        events.append(event)
    translations = [event["data"]["translation"] for event in events if event["event"] == "cue"]
    assert translations == ["【译】Hello", "【译】Again"]

    second = []
    async for event in translate_cues(
        cues,
        target_lang="zh-Hans",
        source_lang="en",
        base_url="http://mock.local/v1",
        api_key="mock",
        model="mock",
        extra="",
        cache=cache,
        mock=True,
    ):
        second.append(event)
    assert second[0]["data"]["cached"] == 2
    assert all(event["event"] != "error" for event in second)
    assert [event["data"]["translation"] for event in second if event["event"] == "cue"] == translations


def test_request_repairs_mismatched_json(monkeypatch):
    asyncio.run(_request_repairs_mismatched_json(monkeypatch))


async def _request_repairs_mismatched_json(monkeypatch):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        body = json.loads(request.content)
        lines = json.loads(body["messages"][1]["content"].split("\n", 1)[1])["lines"]
        if len(lines) > 1:
            content = json.dumps({"translations": ["只有一行"]}, ensure_ascii=False)
        else:
            content = json.dumps({"translations": [f"译:{lines[0]}"]}, ensure_ascii=False)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    class Client(original):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    events = []
    async for event in translate_cues(
        [{"i": 0, "text": "one"}, {"i": 1, "text": "two"}],
        target_lang="zh-Hans",
        source_lang="en",
        base_url="https://llm.example/v1",
        api_key="sk-test",
        model="demo",
        extra="",
        cache=None,
        mock=False,
        concurrency=1,
    ):
        events.append(event)
    translations = [event["data"]["translation"] for event in events if event["event"] == "cue"]
    assert translations == ["译:one", "译:two"]
    assert calls["n"] >= 3
