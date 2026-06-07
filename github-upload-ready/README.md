# 周边推荐 AI 助手

这是一个本地运行的小工具：打开页面后先展示可拖动、可缩放的高德地图，并尝试定位到当前位置。它不会自动推荐；你确认地图区域后，可以主动搜索周边，或输入一句自然语言生成智能规划。

## 密钥用途

- `AMAP_WEB_SERVICE_KEY`：高德 Web 服务 Key，用于地理编码和周边 POI 搜索。
- `AMAP_JS_API_KEY`：高德 Web端(JS API) Key，用于浏览器里的可拖动地图。
- `AMAP_JS_SECURITY_KEY`：高德 Web端(JS API) 安全密钥。
- `DASHSCOPE_API_KEY`：阿里云百炼 API Key，用于生成推荐理由。
- `DASHSCOPE_MODEL`：当前默认使用 `qwen-flash`。

## 使用

启动：

```bash
start-tool.cmd
```

打开：

```text
http://localhost:4173
```

启动窗口不要关闭，关闭后本地服务会停止。

## 安全

`.env` 已被 `.gitignore` 忽略。不要把真实密钥提交到代码仓库。
