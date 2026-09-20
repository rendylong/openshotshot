# character-four-view · 角色四视图工坊

把一句话角色概念、人物照片或已有角色资产，变成**模型就绪的四视图/三视图设定图**（character sheet / turnaround）：无头正/侧/背全身 + 头部五官特写并排成图——小图不带脸（脸部是漂移源），面部唯一事实源是特写格。自带防漂移约束、生成后质检（QC）与下游模型句式。

**通道无依赖**：有 ShotShot 画布或生图工具时直接生成并自检；都没有时交付三件套（prompt + 平台参数卡 + QC 清单），拿去即梦 / Seedream / MJ / GPT-image 出图。

## 快速上手

| 你说 | 得到 |
|---|---|
| 「给我出一个 35 岁女法医的四视图，写实风」 | 一轮澄清（4 问）→ 扩锁 → T1 prompt → 生成/交付 + QC |
| 「把这张照片转成角色设定图」+ 照片 | T4 参考图四视图（职责声明 + 防复制参考图版式） |
| 「主角要进短剧管线，逐项锁脸」 | 精细档 16 项锁 + T1 sheet + Seedance 2.5 下游句式 |
| 「要 3D 建模用的三视图」 | T3 英文 turnaround + 平台参数卡 |

## 文件结构

```
character-four-view/
├── SKILL.md                    # 路由器：通道感知 / 输入模式 / 档位 / 五步流程 / 硬约束
├── README.md                   # 本文件
└── references/
    ├── intake.md               # 采集：快速档 4 问 / 16 项锁 + 发型 5 项 / 缺省表 / 用途-版式映射
    ├── templates.md            # 核心：T1-T4 版式骨架 + 防漂移三重约束 + 变体参数 + 出处
    ├── prompt-compiler.md      # 编译：填槽顺序 / 中英术语对照 / anti-slop / 四平台参数卡
    ├── qc.md                   # 质检：8 项核对 / 归因修复 / 重试上限 2 次 / 无视觉能力降级
    └── usage.md                # 下游：2.5 多视图句式 / 2.0 替代句式 / 版式防泄漏 / 3D 用途
```

## 四个版式

| 版式 | 内容 | 用途 |
|---|---|---|
| **T1 标准四视图**（默认） | 无头正/侧/背全身 + 头部特写权威格，16:9 浅灰底 | 短剧管线 sheet 槽、视频参考、通用人设 |
| **T2 紧凑三栏无头** | 无头正/背全身 + 头部特写，白底 | 无侧面视图需求的紧凑场景 |
| **T3 经典 turnaround** | 正/侧/3⁄4 全身，英文 | 3D 建模、游戏资产 |
| **T4 参考图四视图** | 照片/旧图 → 标准四视图（同 T1 无头格序） | 真人转人设、旧角色重制 |

含头版（各视角展示发型/头饰）保留为 §6 显式变体，不再是默认。

## 与 shotshot-director 的关系

- T1 骨架源自 asset-first.md §3.1，但 **2026-09-12 起默认改为无头版式**（小图脸部是漂移源），与 asset-first §3.1 的含头骨架已分叉；短剧管线如需对齐，把 asset-first §3.1 同步为无头版，或在 canvas 侧走本 skill 的含头变体。
- 画布项目内 sheet 仍走 `canvas_script_asset` 自动生成；本 skill 服务于**独立出图需求与非画布环境**。
- portrait 槽（胸上近景肖像）不在本 skill 范围，见 asset-first.md §3.2。

## 安装

复制到技能目录即可（如 `~/.zcode/skills/` 或项目 `skills/`）；无任何外部依赖，纯 prompt 工作流。

## 语料出处

| 内容 | 来源 |
|---|---|
| T1 骨架与三重约束 | asset-first §3.1 含头骨架 + 老李无头三栏 + Seedance 官方 FAQ（ID 漂移/双胞胎）；2026-09-12 按用户实测改为无头默认 |
| T2 无头三视图、16 项锁 | 老李短剧管线（workflow-repos-research.md） |
| T3 turnaround | seedance-prompts-en.md #2408 |
| T4 职责句式与版式防泄漏 | seedance-prompts-cn.md 附录 B #213/#214 + seedance-prompts-en.md #2511 |
| 2.5 多视图句式 / 2.0 反模式 | seedance-prompts-cn.md #215 + seedance-official.md 官方 FAQ 与 2.0/2.5 差异表 |
