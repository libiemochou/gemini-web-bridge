# Gemini Web Bridge · Gemini 网页桥接

**把 Gemini 网页版变成你的本地 API —— 免费使用 Gemini 的生图能力，接入支持 MCP 的 AI 客户端。**

![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![python](https://img.shields.io/badge/python-3.8%2B-green)

> **English TL;DR** — A browser-extension bridge that turns your own logged-in Gemini web session into a local API (`/v1/messages`, Anthropic-compatible) plus an **MCP image-generation tool** for Claude Code. No API key needed. Generates images on the free web version and downloads the **full-size original** automatically. Use a burner Google account. Windows-first. See [How it works](#工作原理) for details.

> [!WARNING]
> **请务必使用小号！** 本工具通过自动化操作网页实现，**违反 Google 服务条款**，存在账号被限制的风险。请不要使用主力账号，并保持与真人一致的低频使用节奏（别挂机批量刷、别多开并发）。详见下方「账号安全（必读）」。

---

## 它解决什么问题

想让 AI 帮忙画图，但：

| 方案 | 问题 |
|---|---|
| Gemini 官方 API | **生图收费**（免费层不能生图，约 ¥0.2~0.9/张） |
| 服务器端 Cookie 反代 | Cookie 老过期，**海外 IP 极易被风控** |
| 无头浏览器（Playwright） | 又重又慢，特征明显，容易被识别 |
| **本方案：真浏览器 + 插件** | 用你日常的浏览器、真实 IP、真实登录状态，操作节奏与真人一致——目前最稳的免费方案 |

## 功能特性

- 🎨 **生图 MCP 工具**：对模型说"帮我生成一张 ___ 的图片"，自动调用 Gemini 网页画图
- 🖼 **原图自动下载**：自动点击"下载完整尺寸"，拿到的是**原图**（实测 2752×1536 PNG ≈4.9MB），不是对话里的压缩预览（1024×572、几十 KB）
- 📎 **图片上传通道**：把本地图片自动"贴"进 Gemini 输入框（只上传不发送），为**图生图 / 参考图**玩法打底
- 💬 **本地 API**：`http://127.0.0.1:8080/v1/messages`（Anthropic 兼容、支持流式），可以把 Gemini 网页版当作 Claude Code 的一条备用模型线路
- 🪄 **按需启停**：Gemini 页面平时不用开——需要时自动打开、干完自动关闭；桥接程序由工具自动拉起，平时零维护
- 🔒 **全程本地**：所有请求只在你电脑内打转，不经过任何第三方服务器

**谁适合用**：日常使用 Claude Code（或其他支持 MCP 的客户端）的朋友。不装 Claude Code 也能用——桥接程序对外就是一条本地 API（见下方「本地 API 一览」）。

## 工作原理

```
┌──────────────────────── 你的电脑 ────────────────────────┐
│                                                          │
│  Claude Code（或兼容客户端）                              │
│      │ ① 你说："帮我生成一张柴犬戴墨镜的图片"              │
│      ▼                                                   │
│  generate_image（MCP 工具 · mcp_server.py）              │
│      │ ② HTTP → 127.0.0.1:8080                          │
│      ▼                                                   │
│  桥接程序 server.py ──► 任务队列（一次一个，串行排队）      │
│      ▲                          │                        │
│      │ ⑤ 回报文件路径            │ ③ 派活（插件长轮询）     │
│      │                          ▼                        │
│  Chrome + 「Gemini 网页桥接」插件（真浏览器、真登录态）      │
│      │ ④ 自动打字 → 发送 → 等回答 → 点"下载完整尺寸"        │
│      ▼                                                   │
│  Gemini 网页版 ──► 原图直接落到「下载」文件夹               │
└──────────────────────────────────────────────────────────┘
```

## 快速开始（Windows）

**环境要求**

- Windows 10 / 11（macOS / Linux 暂未适配——欢迎 PR）
- [Python 3.8+](https://www.python.org/downloads/)（安装时勾选 *Add python.exe to PATH*）
- Chrome 或 Edge
- 一个能正常访问 Gemini 的 Google 账号 —— **强烈建议用小号**

**安装（4 步）**

1. **下载**：点页面右上角绿色的 `Code` 按钮 → `Download ZIP` → 解压到一个**你想长期保留的位置**（比如 `D:\gemini-web-bridge`）。不用会 git，ZIP 就够。注意：以后别随意挪这个文件夹——挪了要按 FAQ 里「把文件夹挪了位置后失灵」那条处理
2. **装插件**：Chrome 打开 `chrome://extensions`（Edge 用 `edge://extensions`）→ 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选择解压出来的 `extension` 文件夹
3. **注册生图工具**：打开解压出来的文件夹，在**地址栏里输入 `cmd` 回车**（弹出黑窗口），粘贴运行：

   ```bash
   python install_mcp.py
   ```

4. **重启** Claude Code（或你的客户端）

**验收**：随便找个会话说一句 —— *"帮我生成一张柴犬戴墨镜的图片"*。第一次会慢一点（要打开页面 + 画图），30~90 秒属于正常。

## 使用

**使用前提（就三件事）**

- **Chrome / Edge 开着** —— 关掉浏览器 = 工具联系不上 Gemini（后台要靠它接活）
- **网络能访问 Gemini** —— 国内需要梯子挂着
- **小号登录过一次**就行 —— 浏览器会记住登录状态；哪天掉登录了重新登一下

其他什么都不用管：**Gemini 网页不用开着**（需要时自动开、干完自动关），桥接程序也不用启动（自动拉起）。生图时浏览器可能会自己跳到前台干活——别慌，那就是它在工作。

**生图**：直接说人话就行（"画一只…""生成一张…"）。画完的原图会躺在电脑的「下载」文件夹里，对话里会告诉你完整路径。

**可选——把网页版当聊天线路**（慢，仅备用）：在客户端（Claude Code 等）的供应商设置里新增一条：

- Base URL：`http://127.0.0.1:8080`（**不要加 /v1**）
- 格式：Anthropic
- 模型名：随便填（如 `gemini-web`）
- API Key：随便填

## 常见问题

| 问题 | 说明 |
|---|---|
| 第一次为什么慢？ | 要开 Gemini 页面 + 网页版画图 + 下载原图，30~90 秒正常 |
| 能同时画多张吗？ | 不能，一次只跑一个任务（网页版的物理限制，也是保号的关键） |
| 提示"任务超时（插件没响应）" | Chrome 是不是关了？梯子是不是断了？ |
| 提示"页面加载不出来" | 检查网络；去 Gemini 页面看登录状态掉没掉 |
| 一直失败 / 行为异常 | `chrome://extensions` 把插件刷新一下；还不行就重新说一次 |
| Claude Code 更新后工具消失 | 重跑一次 `python install_mcp.py` |
| 怎么彻底停掉？ | 平时没有常驻程序；关掉 Chrome，或者把插件禁用即可 |
| 把文件夹挪了位置后失灵 | 插件引用的是旧路径：`chrome://extensions` 里删掉插件、从**新位置**重新「加载已解压的扩展程序」，再重跑一次 `python install_mcp.py` |

遇到其他问题：欢迎到 [Issues](https://github.com/libiemochou/gemini-web-bridge/issues) 反馈（附上错误提示截图更佳）。

**⚠️ 账号安全（必读）**

- 本方案通过插件自动化操作网页，**违反 Google 服务条款**，请自行评估风险
- **用小号！用小号！用小号！** 别拿主力账号冒险
- 像真人一样低频使用（一天几张到十几张没问题）；不要挂机批量刷、不要多开并发、不要频繁切换 IP
- 免费账号的生图额度有限，且用且珍惜

## 文件说明

| 文件 | 作用 |
|---|---|
| `server.py` | 桥接程序：任务队列（串行）、本地 API、生图接口 |
| `mcp_server.py` | 生图 MCP 工具（会被自动拉起桥接程序） |
| `install_mcp.py` | 一键注册/修复工具（幂等，随时可重跑） |
| `extension/` | 浏览器插件（操控 Gemini 网页的那只手） |
| `start-bridge.bat` | 手动启动桥接（排障用，平时用不到） |
| `start-bridge-background.bat` | 后台无窗口启动桥接 |
| `bridge.log` | 运行日志（排障时看它；注意日志里会记录你发过的提示词，分享前先看一眼） |

## 本地 API 一览

| 接口 | 说明 |
|---|---|
| `POST /v1/messages` | Anthropic 兼容聊天接口（支持 `stream: true`） |
| `POST /x/gen-image` | 生图：`{"prompt": "..."}` → 原图下载到下载文件夹 |
| `POST /x/grab-last` | 把当前页面上最后一张生成图按原图下载（不消耗额度） |
| `POST /x/attach` | 把本地图片贴进 Gemini 输入框（只上传不发送）：`{"path": "C:/图片.png"}` |
| `GET /x/status` | 运行状态 / 插件连接 / 页面自检数据 |

## 免责声明

本项目仅供学习与技术交流。使用者需自行承担因使用本工具产生的一切风险与责任，包括但不限于账号被限制、服务条款纠纷等。请务必将风险控制在可接受范围内（例如使用小号）。

## License

[MIT](LICENSE)

---

如果这个项目帮到了你，欢迎点个 Star 支持一下。

---

### English

Gemini Web Bridge turns your own logged-in Gemini web session into:

1. an **MCP tool** (`generate_image`) for Claude Code — ask for an image, it generates on the free web version and downloads the **full-size original** to your Downloads folder;
2. a local **Anthropic-compatible API** at `http://127.0.0.1:8080/v1/messages`.

A browser extension (real browser, real IP, real session — the lowest-risk approach for automation) drives the Gemini web UI on demand: it opens a tab when needed, types, sends, waits, clicks "Download full size", and reports the file path back.

**Requirements**: Windows, Python 3.8+, Chrome/Edge, a Google account that can access Gemini. **Use a burner account** — automating the web UI violates Google's ToS. Use it at a human pace. At use time, Chrome must be running with the account logged in — the Gemini tab itself is opened and closed automatically.

Install: load `extension/` as an unpacked extension, run `python install_mcp.py`, restart your CLI. Then just ask: *"generate an image of ..."*
