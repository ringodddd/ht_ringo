# 幕译

iPhone 上的 Safari 插件。用 Safari 打开 YouTube，双语字幕写进视频自己的字幕轨，横过来全屏也还在。翻译走你自己的 OpenAI 兼容接口，密钥只留在这台手机里。

油管 App 里的播放器插件进不去。请留在 Safari。

字幕样式跟系统走，两行字：上面原文，下面译文。字号和底色在 iPhone 上改：

设置 → 辅助功能 → 字幕与隐藏式字幕

## 装到 iPhone

需要一台 Mac、Xcode，以及 iPhone。用日常的 Apple ID 就能装，免费账号大约 7 天后要重新装一次。

在 Mac 上，仓库根目录执行：

```bash
xcrun safari-web-extension-converter extension \
  --project-location safari-ios \
  --app-name "幕译" \
  --bundle-identifier com.ringo.muyi \
  --swift \
  --ios-only \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force
open safari-ios/*.xcodeproj
```

在 Xcode 里：

1. 选中 App 和扩展两个 target，Signing 里选你的 Team。Bundle ID 如果被占用，改成你自己的。
2. 把 iPhone 连上并信任这台电脑，选中这台手机，按 Run。
3. 手机上如果问「未受信任的开发者」，到 设置 → 通用 → VPN 与设备管理 里信任你的 Apple ID。

装完之后打开扩展：

1. 设置 → Safari → 扩展 → 幕译，打开开关。
2. 网站权限里允许 YouTube，以及其他网站（模型接口的域名不固定，选允许全部网站）。
3. 用 Safari 打开 `youtube.com`。如果弹出「在 YouTube 中打开」，点取消，留在 Safari。
4. 点地址栏的扩展图标，填 API Base URL、API Key、模型，保存。
5. 打开一个有字幕的视频。画面底部会先出原文，译完一批就换成两行。按钮可以在「双语 / 译文 / 原文」之间换。

改了 `extension/` 里的代码之后，重新跑上面的 converter 命令，再在 Xcode 里 Run 一次。

## 接口

Base URL 写到 `/v1`，例如 `https://api.deepseek.com/v1`。幕译请求 `{base}/chat/completions`。DeepSeek、硅基流动、自己的中转都可以。

这一期需要 iOS 16 或更新的系统。

## 开发检查

这台环境没有 Safari，也没有 Xcode，不能在这里装到真机上。扩展里的字幕解析可以在本机跑：

```bash
node extension/test/parse.test.js
node extension/test/llm.test.js
```

仓库里还有一套本地网页播放器（`frontend/` 和 `backend/`），用来在电脑上试字幕时间轴。iPhone 上的使用路径是上面的 Safari 扩展。
