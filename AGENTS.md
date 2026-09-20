# AGENTS.md

本文档约束本项目中的 AI / 自动化开发行为。用户当前消息中的明确要求优先于本文；未明确之处按本文执行。

## 项目基线

- 对外品牌统一使用 **shotshot.ai**，产品名与技术命名空间统一使用 `shotshot`；不得新增其他品牌名、旧命名空间或兼容别名。
- 项目是本地优先的 AI 视觉创作工作台，包含可独立运行的 Web 渲染端和 Electron 桌面端。
- 当前主要技术栈：Vite、React、React Router、TypeScript、Tailwind CSS、shadcn/Radix、Ant Design、Zustand、TanStack Query、assistant-ui、aicss.dev、Electron、electron-vite 和 Pi Agent。
- `web/` 是渲染进程与独立 Web 应用；`electron/` 是桌面主进程、preload、Pi Agent 宿主、本地 Skill 与文件系统能力。不要再假设项目只有浏览器前端，也不要假设存在远程业务后端。

## shotshot 平台仓库与托管链路

本仓库（realicanvas）是 shotshot 桌面/渲染端；服务端拆分在独立仓库中（本机均在 `/Users/apple/` 下），职责边界以 `shotshot_cloud/docs/architecture.md` 为基线：

- `shotshot_cloud`（部署于 `https://api.shotshot.ai`）：终端用户与设备会话、Paddle 订阅、权益、credits、商业用量、网关授权协调；服务端托管模型目录与商业账本的唯一真值。
- `key-mgmt`（one-api fork，文档中偶写作 `key_mgmt`，同一项目；部署于 `https://key-mgmt.shotshot.ai`）：模型网关，负责 Provider Key、模型路由、硬配额、原始请求计量与可执行价格目录（`service/shotshot_catalog.go`）；每次请求独立校验模型 ∈ 目录 + 价格版本，客户端不是唯一防线。
- `op_shotshot`：仅管理员可见的控制面（管理员身份、运营界面、受控管理操作、审计）；套餐与托管模型目录配置（`/plans` → `plan_catalog.features->'managed_models'`）在这里维护。它不是桌面用户 API。
- `web_shotshot`（部署于 `https://shotshot.ai`）：网站登录、套餐与账户页面，兼作桌面授权在系统浏览器中的续接页。

- 账户链：桌面端发起 → 系统浏览器在 web_shotshot 完成 Google 登录 → shotshot_cloud 签发桌面会话与设备 token，并按服务端套餐推导模型白名单向 key-mgmt 配置设备级网关凭证；客户端上报的 `models[]` 会被拒绝。
- 生成链：`credentialMode=shotshot` 时 Electron main 持网关凭证直达 key-mgmt，响应不经 shotshot_cloud 代理；套餐权益与计费在 shotshot_cloud，配额与计量在 key-mgmt。
- 托管目录语义：云端 `GET /v1/models` = 套餐成员 ∩ key-mgmt 可执行价格目录，拉不到 key-mgmt 目录时 fail-closed 返回空；客户端 `managedModels` 只是用户偏好缓存，不是真值，为空或陈旧时必须走请求时解析层回退。
- 边界禁令：桌面不得调用 op_shotshot 的任何接口或其 `gen-gateway`；op_shotshot 宕机不得影响登录、账户展示或托管执行。不得把套餐表、价格或扣费算法复制进桌面。
- `credentialMode`（`byok` / `shotshot`，谁出凭据）与 `channelMode`（`local` / `remote`，怎么执行）是两个正交轴，不得合并或互相重解释。

## 基本原则

- 先读现有代码、测试和相邻实现，再修改；优先沿用当前结构和写法。
- 只实现当前需求，保持改动短小直接，不为假设场景增加复杂抽象、兼容分支或顺手重构。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先使用成熟库或项目已有实现。
- 不改无关文件，不回滚、不覆盖用户已有改动；提交或发布时只纳入本次明确范围。
- 修改前确认真实运行边界：浏览器、Electron renderer、preload 和 main process 的权限与 API 不同。
- 新增或调整超时、重试次数、大小限制、并发上限等行为边界前，先说明适用环节、默认值和失败处理，并取得用户确认。

## 验证原则

- 验证与改动风险相匹配：文档或纯文案变更不需要构建；逻辑变更运行相关测试；类型或跨模块改动补充 typecheck；打包、Electron 生命周期或资源路径变更执行对应构建或打包验证。
- 用户明确要求不运行测试或构建时遵从，并在交付时说明未验证项。
- `git diff --check` 只能证明空白格式，不代表功能、类型、构建或视觉效果正确。
- UI 变更不能只以源码或 className 存在作为完成依据；需要在实际加载的 Web/Electron 页面中检查渲染结果。Electron 改动应确认当前加载的是最新构建或开发服务。
- 不为了完成验证关闭用户已经打开的浏览器窗口或标签页；自动化验收使用独立测试页面。

## 前端结构

- 路由页面放在 `web/src/pages/`，布局放在 `web/src/layouts/`，路由配置放在 `web/src/router.tsx`。
- 画布页面、组件、状态和工具分别放在 `web/src/pages/canvas/`、`web/src/components/canvas/`、`web/src/stores/canvas/`、`web/src/lib/canvas/`。
- Agent、Skill 的组件和领域逻辑分别沿用 `web/src/components/agent/`、`web/src/lib/agent/`、`web/src/components/skills/`、`web/src/lib/skills/`。
- 浏览器直接调用的模型和媒体 API 放在 `web/src/services/api/`；桌面专属、跨域代理、文件系统、Pi Agent 和本地 Skill 能力通过 preload 暴露的窄 IPC bridge 调用，不在 renderer 中直接引入 Node.js 或 Electron API。
- 全局或跨页面状态放在 `web/src/stores/`；服务端状态和异步查询优先沿用 TanStack Query。已经属于全局 store/hook 的状态和动作直接从对应入口使用，不层层透传 props。
- 页面私有 hook、组件和工具留在页面目录；只有真实跨页面复用时才提升到全局目录。
- 不新增只改名或简单转发 props 的组件，也不为了“纯组件”制造多层参数传递。
- 浏览器业务数据默认使用 `localforage`；`localStorage` 只保存语言、主题等小型简单配置，不保存业务列表、生成记录、媒体、base64 或大 JSON。

## 组件、样式与国际化

- 全站 design token 以 `DESIGN.md` 为速查、`web/src/styles/globals.css` 为唯一权威；新 UI 先查 `DESIGN.md` 边界表。
- 优先复用当前功能区域已经使用的组件体系。通用轻量组件优先查看 `web/src/components/ui/` 中的 shadcn/Radix 实现；复杂表格、表单或现有 Ant Design 页面继续沿用 Ant Design。不要在同一个控件中无目的混搭两套组件系统。
- 新增 shadcn 组件时遵循 `web/components.json` 的别名和现有 Tailwind v4 配置，检查生成代码后再纳入项目，不引入未使用的模板文件。
- Ant Design 的全局主题和弹层 token 统一维护在 `web/src/lib/app-theme.ts` 与 `AppProviders`；业务组件不要为单个 Dropdown、Menu、Select 等重复覆盖主题。
- 全局基础 token、重置和跨页面样式放在 `web/src/styles/globals.css`；组件私有样式优先使用 Tailwind 或同目录 CSS，不把页面私有规则堆进全局文件。
- `aicss.dev` 当前只用于 Agent 对话视觉语言。相关 token 和动效保持在 `web/src/components/agent/agent-aicss.css` 的 `.aicss-*` 作用域，不把它当作全站主题，也不要在其他页面复制一套同名规则。
- 主题颜色优先使用 shadcn 语义变量、Tailwind 语义类、`canvasThemes`、`useThemeStore` 或 Ant Design token；除主题/token 定义外，避免硬编码颜色造成明暗主题不一致。
- UI 图标优先使用 `lucide-react` 或当前区域已经使用的图标库。
- 所有新增用户可见文案通过 `react-i18next` 管理，并同步更新 `web/src/i18n/locales/zh-CN.ts` 与 `en-US.ts`；不要只在组件中硬编码中文或英文。

## Electron、Pi Agent 与 Skills

- Electron 保持 `contextIsolation: true`、`nodeIntegration: false`。新增特权能力必须在 main process 实现，经 preload 暴露最小 API，并在共享类型中明确输入、输出和错误。
- IPC 通道、handler 与 listener 要成对管理；避免重复注册，并在生命周期结束时清理。不要把文件路径、任意命令或未校验对象直接交给特权层执行。
- Pi Agent 运行在 Electron 主进程，renderer 只负责配置、画布快照、事件展示和用户交互。模型配置变化、重置、中断和历史恢复沿用现有 controller 生命周期，不在组件中另建一套 Agent runtime。
- Agent 消息以现有 Zustand/history event 模型为权威；assistant-ui 使用 External Store 方式渲染，不接管或复制业务消息状态。
- Agent 对话消息必须同时按 `threadId`、`turnId` 和 `itemId` 归属。实时事件只补充尚未物化的 turn；历史快照成为权威后不得重复合并同一条消息。
- Pi Agent 工具事件必须保留开始、增量更新、结束和错误状态，不能只展示最终文本或把工具过程折叠成无归属消息。
- 本地 Skills 的发现、读取、写入和导入统一经过现有 Skill runtime 与 Electron bridge；保持路径边界、名称校验和显式错误，不在 renderer 直接访问文件系统。
- Agent 通信协议版本与消息存储版本独立管理。存储格式升级需要显式版本、备份和迁移；遇到未知版本、损坏清单或冲突备份时拒绝覆盖，不静默裁剪历史元数据。
- 不记录完整 API Key、访问令牌、Canvas Agent URL fragment 或含敏感内容的请求体；诊断日志只输出必要且脱敏的信息。

## 画布 UI

- 画布 UI 必须遵循当前主题和已有工具栏、节点面板、Modal 的视觉语言。
- 顶部工具栏和状态信息保持极简扁平：无多余边框、阴影和胶囊背景，只保留轻微 hover/active 反馈。
- 列表中的非图片节点缩略图直接展示图标，不使用 `theme.node.fill` 作为装饰底色。
- 画布操作按钮默认透明背景，使用图标和文字表达动作；`activeBg` 只用于明确的选中态，不作为普通按钮底色。
- 图片节点默认尊重原始比例；只有功能明确要求时才允许自由变形。
- 批量生成、多图展示和 Agent 面板尽量减少对画布空间的占用。

## 数据与安全说明

- 当前画布项目和“我的素材”主要保存在浏览器本地；WebDAV 是可选同步能力，不要描述为平台云存储或账号云同步。
- 普通 AI 生成所用 API Key 保存在浏览器本地，并由前端直接请求用户配置的兼容接口；Electron 场景可能通过主进程代理解决跨域，但不等于存在远程后端。
- 不再假设“项目未上线所以无需兼容数据”。任何已持久化的画布、Agent 历史、配置或 Skill 数据结构变更，都要先检查现有版本策略和数据风险，再决定是否需要迁移。
- Docker 静态资源路径仍需按实际部署验证；文档中不要把未验收的部署方式描述为生产可用。

## 文档规范

- README 保持简洁，只放项目介绍、核心功能、快速开始和文档入口；对外统一使用 shotshot.ai 品牌。
- `docs/index.md` 和 `docs/index.zh-CN.md` 是 AI 使用的文档索引，不放进 `docs/content/docs/`。
- 详细功能、待办和待测试内容分别维护在 `docs/content/docs/overview/features*.mdx`、`progress/todo*.mdx`、`progress/pending-test*.mdx`。
- 修改双语文档时同步维护英文与 `*.zh-CN.mdx` 版本；不要让导航、能力状态或安全说明只更新一个语言。
- 已实现但尚待用户确认的功能先进入 `pending-test`；确认后再更新正式功能说明。`CHANGELOG.md` 的 `Unreleased` 只保留版本级摘要，不复制实现清单。
- 用户可感知的功能、接口或工具变化在 `CHANGELOG.md` 的 `Unreleased` 中用 `[新增]`、`[调整]`、`[修复]` 或 `[优化]` 归纳；纯内部重构或文档整理不需要记录。
- 文档不写会快速过期的日期，除非用户明确要求。

## Git、发布与 PR

- 保留工作区中的用户改动。提交前检查 scoped diff，只暂存本次明确路径；不得用“发布需要全部提交”为理由夹带无关改动。
- 发版本时整理 `CHANGELOG.md` 的 `Unreleased`、更新 `VERSION` 与相关 package 版本，并为目标提交创建对应 `v*` tag。构建、签名、推送和发布按用户明确授权执行。
- 不执行 force-push、覆盖远端历史、合并 `main`、关闭 PR 或发布制品，除非用户明确确认目标和影响。
- PR 审查分别判断需求价值与实现质量。需求有价值不代表当前实现可合并；实现有问题也不代表需求应被放弃。
- 实现质量重点检查正确性、安全性、改动范围、现有结构复用、重复代码、测试、文档和与最新主分支的冲突。
- 对“需求有价值但实现不合格”的 PR，优先建议作者修改、提取思路后重做，或保留为 issue/todo；建议关闭前先向用户说明判断与可保留内容。

## 规则沉淀

- 只有当同一问题反复出现或用户多次强调时，才把它补充进本文。
- 新规则应明确、可执行，并放入最相关章节；新增前先检查是否与现有规则重复或冲突。
