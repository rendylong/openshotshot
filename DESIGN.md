# DESIGN.md — shotshot 设计系统速查

设计语言一句话：**暖中性纸感（stone 灰阶）× 白纸画布 × 扁平极简工具 × 单一强调黑 × 大圆角柔影浮层**。

权威源：CSS 变量以 `web/src/styles/globals.css` 为唯一权威；TS 侧常量在 `web/src/lib/design/`（`palette.ts` / `z-layers.ts` / `modal.ts`），由 `token-guard` 测试保证同值。本文只做速查，不抄全部 hex。完整规范见 `docs/superpowers/specs/2026-09-08-design-token-unification-design.md`。

## 表面谱系（L0–L3）

任何界面元素只落在以下表面之一，只允许向上借一层，禁止跨层混用底色：

| 层 | light | dark | 用途 |
|---|---|---|---|
| L0 页面底 | `--background`（白） | stone-900 | 页面、侧栏 |
| L1 卡片/弹层底 | `--card` / `--popover`（白） | stone-800 | 卡片、antd/shadcn 弹层、菜单 |
| L2 画布浮层底 | `--canvas-surface`（半透明 + blur 8px） | 同左（深色值） | 画布工具栏、设置气泡、mention |
| L3 画布绘制面 | 白（canvas.background） | `#181715`（刻意比页面底深半档） | 无限画布本身 |
| 强调 | 反色前景（`--foreground`） | 同左 | 主按钮、选中 pill、激活态 |

浮层判定：portal 到 body、悬浮于内容之上、外点/Esc 可关闭 = 浮层（配三档阴影 + 18px 圆角）；占布局槽位、随页面滚动 = chrome（无阴影，只有细边框或不加边框）。

## 语义变量速查

只列语义名，真值见 `globals.css` 的 `:root` / `.dark`：

- 基础：`background / foreground / card / popover / primary / secondary / muted / muted-foreground / accent / border / input / ring / sidebar-* / chart-1..5`
- 状态：`danger / warning / success / info`；`destructive` 与 `danger` 同值，仅限 shadcn 原语内部契约，新代码一律用 `danger`
- 画布桥：`canvas-surface / canvas-border / canvas-text / canvas-muted / canvas-dot / canvas-line / canvas-hover / canvas-active`（`data-scope="canvas"` 域内 IconButton hover/active 走 `canvas-hover/active`）
- 阴影三档：`shadow-menu`（轻菜单）/ `shadow-overlay`（常规浮层，CanvasFloatingPanel 内建）/ `shadow-modal`（全屏编辑器级）；chrome 一律无阴影
- 动效：`duration-fast`(120ms) / `base`(150ms) / `slow`(300ms)；位移/缩放强调曲线 `ease-emphasis`；颜色过渡用 `ease`

## 状态色四值（明暗各一套）

| 变量 | light | dark |
|---|---|---|
| `--danger` | `#dc2626` | `#f87171` |
| `--warning` | `#b45309` | `#fbbf24` |
| `--success` | `#15803d` | `#4ade80` |
| `--info` | `#2563eb` | `#60a5fa` |

规则：状态色是唯一的彩色（品牌位仅 home aurora 标题与 Agent shimmer/caret 两处）；状态色 hover/active = 本体色 `/10` 底 + 本体色文字，不派生深浅档。**链接/导航文字保持前景黑，不用 info 蓝**（v4 用户裁定，antd `colorLink` 系列为 primary 黑）。

## 圆角 / 字号 / z 阶梯 / 控件尺寸速查

- 圆角：`rounded-md`(8) 控件 · `rounded-lg`(10) 嵌套小区块 · `rounded-xl`(14) 卡片容器 · `rounded-2xl`(18) **一切浮层**（菜单/面板/弹窗不分型，antd `borderRadiusLG:18`）· `rounded-3xl`(22) 画布节点/项目卡 · `rounded-full` 胶囊
- 字号档：`micro`(10) / `meta`(11) / `xs`(12) / `sm`(14 正文) / `base`(16) / `xl`(20) / `2xl`(24 页面标题) / `3xl`(30 仅 home 品牌标题)；字重 400/500/600；连续阅读 ≥3 行的正文一律 14，单行元信息/菜单/tooltip 12
- z 阶梯（`web/src/lib/design/z-layers.ts`）：titlebar 40 / panelSlot 70 / surfaceMax 120（界面层上限）/ canvasTop 1100 / canvasOverlay 1200（画布浮层）/ dialog 1900 / antdPopup 2000 / dropdown 2100
- 控件高度三档：28（画布工具条）/ 32（表单标准，antd `controlHeight:32`）/ 36（OptionPill 胶囊）；40 仅作设置行容器；Modal 宽度 `MODAL_WIDTH = {sm:480, md:640, lg:860}`（`web/src/lib/design/modal.ts`）
- 动效：颜色 `duration-base ease`；位移/缩放 `ease-emphasis` + fast/slow；`transition-all` 禁用；主题切换瞬间由 `theme-transitioning` 类抑制过渡
- 图标：lucide-react 唯一；尺寸档 {14, 16, 18, 20}（默认 16）
- 滚动条：全站唯一 `thin-scrollbar` 家族（4px 圆角半透明 thumb、无轨道；`scrollbar-color/width` 标准属性与 `::-webkit-scrollbar` 必须同值成对维护——Chromium 中标准属性为非默认值时会禁用 webkit 自定义）。**滚动区只允许一条滚动层**：浮层/面板根元素不得产生自己的滚动条（根元素挂 `thin-scrollbar` 或不滚），长列表在内层滚动区滚动；弹层菜单类用 `thin-scrollbar-reveal` 变体（thumb 静止透明、悬停滚动区浮现）。禁止出现任何未样式化的系统滚动条

## 消费边界表（30 秒决策树）

| 场景 | 用什么 | 禁止什么 |
|---|---|---|
| 页面/设置表单/通用 UI | Tailwind 语义类（`text-muted-foreground`、`bg-accent`、`border-border`）、`ui/*` 原语 | `text-stone-500` 裸调色板（新增）、hex/rgba 字面量 |
| antd 密集区（skills、表格、复杂表单、Drawer） | antd 组件 + 全局 token（不覆写） | 组件内再包 ConfigProvider / `!important` 强改 |

> 级联层架构：antd 样式位于 `antd` layer（`StyleProvider layer`，层序 `theme, base, antd, components, utilities`），Tailwind 工具类优先级高于一切 antd 样式——在锚点/antd 组件上写工具类可正常生效，**新代码不需要 `!` 修饰符**（存量 `!` 冗余但无害）。
| 画布 DOM 浮层（工具栏、菜单、设置气泡、mention） | `CanvasFloatingPanel`（吃 `--canvas-*`）或 antd Popover/Dropdown | 手写 portal + 手写定位 + 手写阴影圆角 |
| 画布 ctx 绘制（网格点、框选、连线、导出） | `canvasThemes` TS 对象 | 在 DOM 样式里用 canvasThemes 值 |
| Agent 对话视觉 | `.aicss-*`（仅对话域：气泡/过程折叠/shimmer/caret/composer） | 把 aicss 用于 home/设置等其他页面 |
| 状态色（错误/警告/成功/信息） | `text-danger`、`bg-warning/10` 等语义类或 antd token；`destructive` 仅限 shadcn 原语内部，新代码不新增引用；**链接/导航文字用前景色不用状态色（黑白基调，v4 裁定）** | `#dc2626`、`text-red-600`、`bg-emerald-500`、`text-destructive`（新增）等字面量 |
| 加载三态 | 首屏数据加载 = antd Skeleton；无数据 = EmptyState；操作进行中 = Spinner | 同一场景两种加载写法 |
| 下拉 | 表单 = shadcn Select；antd 密集区 = antd Select；可输入单元格 = ShotCellCombo；模型 = ModelPicker | 新写第 9 种下拉 |
| tooltip | 一律 antd `Tooltip` | 同屏多种 tooltip 视觉 |
| 破坏性确认 | 不可撤销/影响多对象 = antd Modal 确认；可撤销单对象 = Popconfirm | `message.warning` 假确认 |

skills 页与 skill-detail-modal 已随 v5 裁定解除纳入归一（PageHeader/EmptyState，同 projects 页规格）。

## 共享原语清单

- `web/src/components/ui/settings-controls.tsx` — `SettingGroup / SettingRow / OptionPill`，设置表单三件套
- `web/src/components/canvas/canvas-floating-panel.tsx` — 浮层骨架（锚点定位、外点/Esc 关闭、滚动重定位、Tab 圈定；canvas/page 双域皮肤）
- `web/src/components/ui/icon-button.tsx` — 图标按钮（size 24/28/32，ghost/solid/danger，`aria-label` 必填）
- `web/src/components/ui/empty-state.tsx` — 空状态（icon 40 + 标题 + 描述 + action）
- `web/src/components/ui/spinner.tsx` — 加载 spinner（含 canvas 主题色版）
- `web/src/components/ui/badge.tsx` — 徽章（default/outline/success/warning/danger/info）
- `web/src/components/ui/page-header.tsx` — 页面头（eyebrow + title 2xl/600 + description + actions；projects 页已归一，home 品牌首屏不套用）

## 新代码禁止

- 禁止 hex/rgb(a) 颜色字面量（stylelint 白名单：globals.css、agent-aicss.css 过渡期）
- 禁止任意值字号/圆角/颜色类（`text-[13px]`、`rounded-[18px]`、`bg-[#..]`）
- 禁止裸 z-index 数值，查 `z-layers.ts` 取值
- 禁止新增裸 stone 调色板类（`border-stone-*` 存量视觉等价保留，新增一律语义类）
- 禁止 aicss 用于 Agent 对话以外区域
- 禁止 JS state 手写 hover、`hover:bg-black/5 dark:hover:bg-white/10` 双写、硬编码 hover hex（画布域用 `toolbar.itemHover` / `data-scope="canvas"`；非画布用 `hover:bg-accent`）
- 禁止 `--<组件名>-<属性>` 式新 CSS 变量；DOM 内联样式禁止从 `palette.ts` 取值
- 禁止新增 `destructive` 引用、新写第 9 种下拉、`transition-all`、删除 focus-visible 轮廓
