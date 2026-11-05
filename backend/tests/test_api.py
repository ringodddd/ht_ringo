from pathlib import Path

from fastapi.testclient import TestClient

from app import main

FIXTURES = Path(__file__).parent / "fixtures"


def test_import_and_mock_translate(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("MUYI_MOCK_TRANSLATE", "1")
    monkeypatch.delenv("APP_TOKEN", raising=False)
    main._cache = None
    client = TestClient(main.app)

    bad = client.post("/api/captions", json={"url": "https://example.com/watch?v=jNQXAC9IVRw"})
    assert bad.status_code == 400
    assert bad.json()["code"] == "bad_url"

    imported = client.post(
        "/api/import",
        json={
            "url": "https://youtu.be/jNQXAC9IVRw",
            "filename": "sample.srt",
            "content": (FIXTURES / "sample.srt").read_text(encoding="utf-8"),
        },
    )
    assert imported.status_code == 200
    body = imported.json()
    assert body["videoId"] == "jNQXAC9IVRw"
    assert body["cues"][1]["text"] == "Second & last."

    with client.stream(
        "POST",
        "/api/translate",
        json={"targetLang": "zh-Hans", "sourceLang": "en", "cues": body["cues"]},
    ) as response:
        payload = "".join(response.iter_text())
    assert response.status_code == 200
    assert "【译】First line." in payload
    assert "event: done" in payload


def test_cookies_must_mention_youtube(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    main._cache = None
    client = TestClient(main.app)
    rejected = client.post("/api/cookies", json={"content": "not a cookie"})
    assert rejected.status_code == 400
    accepted = client.post(
        "/api/cookies",
        json={"content": "# Netscape\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n"},
    )
    assert accepted.status_code == 200
    assert (tmp_path / "youtube-cookies.txt").is_file()
    assert client.get("/api/config").json()["hasCookies"] is True
    assert client.delete("/api/cookies").json()["ok"] is True
