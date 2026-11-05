# 幕译

自己搭的 YouTube 沉浸式双语字幕。视频仍用油管播放器，只把字幕文本交给你自己的 OpenAI 兼容接口翻译。

两套界面，翻译协议是一样的：

- **浏览器扩展**：在 `youtube.com` 的播放器底部叠原文和译文。字幕从你当前这场浏览里拿，不经过机房 IP，所以不容易被 YouTube 的「确认你不是机器人」拦住。
- **本地网页**：贴链接，或导入 SRT / VTT。适合想要文稿、跳句、下载字幕的时候。服务器用 yt-dlp 读字幕，不下载视频。

## 本地网页

```bash
cd backend
pip install -r requirements.txt
cd ../frontend
npm install
```

开两个终端：

```bash
# 终端 1
cd backend
MUYI_MOCK_TRANSLATE=0 uvicorn app.main:app --reload --port 8787

# 终端 2
cd frontend
npm run dev
```

打开 http://127.0.0.1:5173 。

复制 `.env.example` 为 `.env`，填上你的接口：

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=你的密钥
LLM_MODEL=deepseek-chat
```

网页设置里勾着「使用服务器环境变量里的密钥」时，浏览器不会保存 Key。取消勾选后，可以临时改用另一把 Key，请求仍然先打到本机服务再转发出去。

`MUYI_MOCK_TRANSLATE=1` 时不调用模型，译文只是在原文前加上「【译】」，用来看界面。

Docker：

```bash
cp .env.example .env
docker compose up --build
```

然后打开 http://127.0.0.1:8787 。

## 浏览器扩展

1. 打开 `chrome://extensions`（Edge 用 `edge://extensions`）。
2. 打开开发者模式，选择「加载未打包的扩展程序」，选仓库里的 `extension` 目录。
3. 点扩展图标，填写 Base URL、API Key、模型，保存。浏览器会问你是否允许扩展访问这个接口。
4. 打开一个有字幕的 YouTube 视频。播放器左上角会出现「双语」，底部是原文小字、译文大字。

扩展把密钥存在 `chrome.storage.local`，直接请求你的接口，不经过幕译服务器。换源语言或模型后会重新取字幕或重新翻译。已经译过的句子按视频和模型缓存在本地。

## 字幕拉不到的时候

YouTube 经常拦截机房 IP。网页这条链路会按下面的顺序试：

1. yt-dlp。可以在设置里上传 Netscape 格式的 `cookies.txt`（用浏览器扩展导出，文件里要有 `youtube.com`），或设置环境变量 `YT_COOKIES`。
2. 可选的 Invidious 实例：`INVIDIOUS_INSTANCES=https://yewtu.be`。
3. 失败的话，导入 SRT / VTT，或改用浏览器扩展。

cookies 写在 `data/youtube-cookies.txt`，权限是 `600`。这是登录态，不要提交，也不要把服务暴露到公网。

如果一定要给别人用，设置 `APP_TOKEN`。除了 `/api/health` 和 `/api/config`，请求都要带 `Authorization: Bearer <口令>`。网页设置里有「访问口令」。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/config` | 服务器有没有配密钥、是不是预览翻译 |
| POST | `/api/captions` | `{ "url", "lang" }`，返回带时间轴的字幕 |
| POST | `/api/import` | `{ "url", "filename", "content" }`，解析 SRT / VTT / json3 |
| POST | `/api/translate` | 按句翻译，`text/event-stream` 往回推 |
| POST | `/api/cookies` | 保存 YouTube cookies |
| POST | `/api/export` | 导出 SRT |

翻译接口认 OpenAI 的 `POST {base}/chat/completions`。Base 可以写到 `/v1`，也可以直接写完整的 `/chat/completions`。每批大约 24 句，同一句原文、同一个模型、同一种目标语言会缓存在 `data/translations.sqlite3`。

## 开发

```bash
cd backend && python -m pytest
node extension/test/parse.test.js
node extension/test/llm.test.js
cd frontend && npm run build
```
