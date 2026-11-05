"""幕译：给自己的 YouTube 字幕接上自己的翻译接口。"""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .captions import CaptionError, cues_to_srt, parse_caption_payload, parse_video_id
from .translate import LineCache, translate_cues
from .youtube import load_captions

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def load_dotenv() -> None:
    candidates = [
        Path.cwd() / ".env",
        BACKEND_ROOT / ".env",
        BACKEND_ROOT.parent / ".env",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        break


load_dotenv()


def data_dir() -> Path:
    configured = os.environ.get("DATA_DIR")
    if configured:
        path = Path(configured)
    else:
        repo = BACKEND_ROOT.parent
        if (repo / "frontend").exists() or (repo / ".git").exists():
            path = repo / "data"
        else:
            path = BACKEND_ROOT / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cookies_path() -> Path | None:
    uploaded = data_dir() / "youtube-cookies.txt"
    if uploaded.is_file() and uploaded.stat().st_size > 0:
        return uploaded
    configured = os.environ.get("YT_COOKIES", "").strip()
    if configured and Path(configured).is_file():
        return Path(configured)
    return None


def invidious_instances() -> list[str]:
    return [item.strip() for item in os.environ.get("INVIDIOUS_INSTANCES", "").split(",") if item.strip()]


def player_clients() -> list[str]:
    raw = os.environ.get("YT_PLAYER_CLIENTS", "web,android,ios")
    return [item.strip() for item in raw.split(",") if item.strip()]


def mock_enabled() -> bool:
    return os.environ.get("MUYI_MOCK_TRANSLATE", "").strip() in {"1", "true", "TRUE", "yes"}


class CaptionRequest(BaseModel):
    url: str
    lang: str = "auto"


class ImportRequest(BaseModel):
    url: str = ""
    content: str
    filename: str = ""
    lang: str = ""


class CueIn(BaseModel):
    i: int
    text: str = ""
    start: float | None = None
    end: float | None = None


class TranslateRequest(BaseModel):
    targetLang: str = "zh-Hans"
    sourceLang: str = ""
    cues: list[CueIn] = Field(default_factory=list)
    baseUrl: str = ""
    apiKey: str = ""
    model: str = ""
    extraPrompt: str = ""


class ExportRequest(BaseModel):
    bilingual: bool = False
    cues: list[dict] = Field(default_factory=list)


class CookieRequest(BaseModel):
    content: str


app = FastAPI(title="幕译", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8787",
        "http://localhost:8787",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_cache: LineCache | None = None


def line_cache() -> LineCache:
    global _cache
    if _cache is None:
        _cache = LineCache(data_dir() / "translations.sqlite3")
    return _cache


def _config() -> dict:
    base = os.environ.get("LLM_BASE_URL", "").strip()
    host = ""
    if base:
        from urllib.parse import urlparse

        host = urlparse(base).netloc
    return {
        "mock": mock_enabled(),
        "hasServerKey": bool(os.environ.get("LLM_API_KEY", "").strip()) or mock_enabled(),
        "serverModel": os.environ.get("LLM_MODEL", "").strip(),
        "serverBaseHost": host,
        "hasCookies": cookies_path() is not None,
        "appTokenRequired": bool(os.environ.get("APP_TOKEN", "").strip()),
    }


@app.middleware("http")
async def require_app_token(request: Request, call_next):
    token = os.environ.get("APP_TOKEN", "").strip()
    if not token or request.url.path in {"/api/health", "/api/config"} or not request.url.path.startswith("/api/"):
        return await call_next(request)
    header = request.headers.get("authorization", "")
    supplied = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if supplied != token:
        return JSONResponse({"detail": "访问口令不对。", "code": "app_token"}, status_code=401)
    return await call_next(request)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/config")
def config() -> dict:
    return _config()


@app.post("/api/captions")
async def captions(body: CaptionRequest):
    try:
        cookies = str(cookies_path()) if cookies_path() else None
        session = await load_captions(
            body.url,
            body.lang or "auto",
            cookies=cookies,
            invidious_instances=invidious_instances(),
            player_clients=player_clients(),
        )
        return session
    except CaptionError as exc:
        status = 400 if exc.code in {"bad_url", "lang_missing", "no_captions", "empty_subs"} else 502
        return JSONResponse({"detail": str(exc), "code": exc.code}, status_code=status)


@app.post("/api/import")
def import_captions(body: ImportRequest):
    if len(body.content) > 2_000_000:
        return JSONResponse({"detail": "字幕文件超过 2MB。", "code": "too_large"}, status_code=400)
    ext = Path(body.filename).suffix.lower().lstrip(".")
    try:
        cues = parse_caption_payload(body.content, ext)
    except CaptionError as exc:
        return JSONResponse({"detail": str(exc), "code": exc.code}, status_code=400)
    if not cues:
        return JSONResponse({"detail": "字幕是空的。", "code": "empty_subs"}, status_code=400)
    if len(cues) > 8000:
        return JSONResponse({"detail": "字幕行数太多。", "code": "too_many"}, status_code=400)
    video_id = ""
    if body.url.strip():
        try:
            video_id = parse_video_id(body.url)
        except CaptionError as exc:
            return JSONResponse({"detail": str(exc), "code": exc.code}, status_code=400)
    lang = body.lang.strip() or "und"
    return {
        "videoId": video_id,
        "title": Path(body.filename).stem or (video_id or "导入的字幕"),
        "author": "",
        "duration": cues[-1].end,
        "track": {"language": lang, "name": "导入的字幕", "auto": False},
        "available": [{"language": lang, "name": "导入的字幕", "auto": False}],
        "cues": [cue.as_dict(index) for index, cue in enumerate(cues)],
        "source": "import",
    }


@app.post("/api/translate")
async def translate(body: TranslateRequest):
    if not body.cues:
        return JSONResponse({"detail": "没有可翻译的字幕。", "code": "empty"}, status_code=400)
    if len(body.cues) > 8000:
        return JSONResponse({"detail": "字幕行数太多。", "code": "too_many"}, status_code=400)
    base = body.baseUrl.strip() or os.environ.get("LLM_BASE_URL", "").strip()
    key = body.apiKey.strip() or os.environ.get("LLM_API_KEY", "").strip()
    model = body.model.strip() or os.environ.get("LLM_MODEL", "").strip() or ("mock" if mock_enabled() else "")
    cues = [cue.model_dump() for cue in body.cues]

    async def events():
        try:
            async for event in translate_cues(
                cues,
                target_lang=body.targetLang or "zh-Hans",
                source_lang=body.sourceLang,
                base_url=base or "http://mock.local/v1",
                api_key=key or "mock",
                model=model or "mock",
                extra=body.extraPrompt or "",
                cache=line_cache(),
                mock=mock_enabled(),
            ):
                yield _sse(event)
        except Exception as exc:
            message = str(exc).strip() or "翻译中断了。"
            yield _sse({"event": "error", "data": {"message": message[:500]}})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/export")
def export_srt(body: ExportRequest):
    if len(body.cues) > 8000:
        return JSONResponse({"detail": "字幕行数太多。", "code": "too_many"}, status_code=400)
    text = cues_to_srt(body.cues, bilingual=body.bilingual)
    return PlainTextResponse(text, media_type="application/x-subrip; charset=utf-8")


@app.post("/api/cookies")
def upload_cookies(body: CookieRequest):
    content = body.content.strip()
    if len(content) > 512_000:
        return JSONResponse({"detail": "cookies 文件太大。", "code": "too_large"}, status_code=400)
    lowered = content.lower()
    if "youtube.com" not in lowered:
        return JSONResponse(
            {"detail": "这不像 YouTube 的 cookies 文件。请导出 Netscape 格式，里面要有 youtube.com。", "code": "bad_cookies"},
            status_code=400,
        )
    path = data_dir() / "youtube-cookies.txt"
    path.write_text(content + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return {"ok": True}


@app.delete("/api/cookies")
def delete_cookies():
    path = data_dir() / "youtube-cookies.txt"
    if path.is_file():
        path.unlink()
    return {"ok": True}


def _sse(event: dict) -> str:
    return f"event: {event['event']}\ndata: {json.dumps(event['data'], ensure_ascii=False)}\n\n"


def mount_frontend() -> None:
    static = os.environ.get("STATIC_DIR", "").strip()
    if not static:
        return
    root = Path(static)
    if not root.is_dir():
        return
    assets = root / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = (root / full_path).resolve()
        if full_path and candidate.is_file() and root.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(root / "index.html")


mount_frontend()
