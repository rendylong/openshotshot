<p align="center">
  <img src="assets/shotshot-logo-text.png" alt="OpenShotShot" width="420" />
</p>

<h1 align="center">OpenShotShot</h1>

<p align="center">OpenShotShot — 一个开源的 AIGC 创作工作台：无限画布，内置 Agent。</p>

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a></p>

---

## 核心功能

- **无限画布**：图片、文本、视频、音频、3D 模型等多类型节点自由摆放、缩放与连线，把单次生成变成连续推演。
- **内置画布 Agent**：本地运行的智能体能读懂画布上下文，直接生成节点、整理布局、串联工作流。
- **BYOK 多模态生成**：使用自己的 API Key，通过 OpenAI 兼容渠道或内置预设（DeepSeek、Moonshot、MiniMax、智谱、OpenRouter、fal.ai 等）生成图片、视频、音频与 3D 内容。
- **ChatGPT 订阅连接**：桌面端可用 ChatGPT 订阅账号直接登录调用模型，无需单独申请 API Key。
- **Skills 与节点插件**：本地 Skills 扩展 Agent 能力，画布节点插件扩展画布节点类型。
- **本地优先**：画布与素材默认保存在本机，可选 WebDAV 同步；素材库与提示词库帮你沉淀每一次好结果。

## 快速开始

要求：Node.js 22+。

```bash
git clone https://github.com/rendylong/openshotshot.git
cd openshotshot
```

### Web

```bash
cd web
npm install
npm run dev
```

浏览器打开 <http://localhost:3000>。

### 桌面端（Electron）

需要两个终端，先启动 Web 渲染端，再启动桌面端：

```bash
# 终端 1：Web 渲染端
cd web
npm install
npm run dev
```

```bash
# 终端 2：桌面端（仓库根目录）
npm install
npm run dev
```

### Docker

```bash
docker compose up --build
```

构建本地镜像并启动，打开 <http://localhost:3000>。容器只提供静态页面，AI 请求由浏览器直连你配置的服务商接口。

## BYOK 说明

打开「模型与 API 配置」，添加一个 OpenAI 兼容渠道（Base URL + API Key），或从预设列表选择服务商。API Key 只保存在你的设备本地：浏览器直连你所配置的接口，Electron 桌面端在需要时由主进程代理跨域请求。本项目没有经手你的 Key 或生成数据的远程服务器。

## 重要提示

- 本地数据格式仍在快速演进，暂不保证向后兼容，请勿把唯一一份重要数据存放在应用内。
- API Key 仅保存在本地浏览器或桌面端存储中，请注意设备安全。

## 开源与致谢

OpenShotShot 基于 [infinite-canvas](https://github.com/basketikun/infinite-canvas) 二次开发，并在其基础上持续演进产品体验、桌面端、本地 Agent、Skills 与插件能力。感谢原项目及所有开源依赖的贡献者。

本项目遵循 [MIT License](LICENSE)。使用、修改或分发时请保留许可证中的版权与许可声明。
