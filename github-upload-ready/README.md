=美团晴岚Agent：本地生活一键安排与智能履约助手

面向美团赛道 6 的本地生活 Agent Demo。用户输入一句自然语言想法后，系统会自动理解场景、召回附近 POI、规划短时路线，并生成可转发给同行人的安排文案。点击路线中的地点后，右侧会打开独立的“智能下单/预订”侧边栏，演示订座、排队、预约、套餐等商业化动作闭环。

## 核心能力

- 智能规划：默认进入规划模式，支持“回龙观 2 小时”“中关村 4 个地方”“望京轻松路线”等自然语言输入。
- 地图路线：基于高德地图展示地点、路线顺序和地点详情，并可打开高德路线。
- 商业动作：针对餐饮、景区展览、休闲娱乐等地点，生成订座、排队、预约、购票提醒、套餐等演示动作。
- 兜底方案：当地图搜索或大模型接口失败时，会使用城市/省份默认点生成可执行路线，避免演示卡住。
- 转发与日程：可复制日程提醒和同行人转发文案。

## 本地运行

复制 `.env.example` 为 `.env`，填入密钥后启动：

```bash
start-tool.cmd
```

浏览器打开：

```text
http://localhost:4173
```

启动窗口不要关闭，关闭后本地服务会停止。

## 环境变量

- `AMAP_WEB_SERVICE_KEY`：高德 Web 服务 Key，用于地理编码和周边 POI 搜索。
- `AMAP_JS_API_KEY`：高德 Web端(JS API) Key，用于浏览器里的可拖动地图。
- `AMAP_JS_SECURITY_KEY`：高德 Web端(JS API) 安全密钥。
- `DASHSCOPE_API_KEY`：阿里云百炼 API Key，用于意图理解和方案生成。
- `DASHSCOPE_MODEL`：百炼模型名，当前使用 `qwen-flash`。
- `PORT`：本地端口，默认 `4173`。部署到 Render 时不需要手动设置。

## Render 部署

创建 Render Web Service：

- Runtime：`Node`
- Build Command：`npm install`
- Start Command：`npm start`
- Environment Variables：填入上述高德和百炼密钥，并设置 `NODE_VERSION=20`

如果 GitHub 仓库中代码位于 `github-upload-ready` 子目录，需要在 Render 的 `Root Directory` 填：

```text
github-upload-ready
```

部署完成后，需要到高德控制台把 Render 域名加入 `AMAP_JS_API_KEY` 的 Web 端域名白名单。

## 安全

`.env` 已被 `.gitignore` 忽略。不要把真实密钥提交到代码仓库，也不要把密钥写进 README。

##用于参加美团黑客松的参赛作品
