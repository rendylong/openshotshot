# ShotShot 工具链契约

写画布前必读一次。工具名与参数以 ShotShot Canvas Agent 实际暴露为准；本文按当前版本（脚本节点 v0.6）整理。若工具调用报错，先 `canvas_get_state` 核实再重试，不要盲目重发。

## 1. 脚本节点专用工具

### canvas_generate_script
创建或复用脚本节点，返回节点 id 与创作任务书确认。

```text
nodeId?           传入已有脚本节点 id = 复用
instruction       创作任务书：题材/核心诉求/约束条件（多行文本）
shotCount?        目标镜头数（hint）
globalStyle?      风格总纲（合成 finalPrompt 时统一拼入）
storyboardFirst?  true = 分镜图先行模式：每镜双提示词——storyboardPrompt
                  （静态关键帧）与 finalPrompt（运动优先），新镜时长默认 5s
referenceNodeIds?  相关参考节点（图片等）
```

### canvas_script_asset
创建实体资产并自动出参考图（经画布生图节点生成后自动回写实体槽位）。

```text
scriptNodeId      所属脚本节点
group             "character" | "scene" | "item"
name              全局唯一锚点名（分镜 entityRefs 按此名称解析，重名会解析错）
role?             定位：主角/配角/群演；主要/过场；关键/装饰
appearance?       定义：外貌性格 / 环境空间 / 形态材质
consistency?      一致性提示词（16 项锁 / 空间快照写这里）
imagePrompt?      出图提示词（角色填四视图 sheet 模板，见 asset-first.md §3.1）
```

### canvas_script_replace_shots
整体替换全部分镜（最多 50 条）。**首次写入用这个**；用户手动改过后禁止 replace 覆盖，改用逐条 update。

```text
nodeId
shots[]           每条：description, shotSize, angle, movement, duration,
                  mood, sfx?, dialogue?, entityRefs?（资产名称数组）, shotId?
```

### canvas_script_compile_prompts（一键合成的落库通道）

把 Agent 编译好的 finalPrompt **批量回写**脚本节点：

```text
nodeId            脚本节点 id
prompts[]         逐条 {shotId, finalPrompt, storyboardPrompt?}（≤50 条）
```

- 双写（分镜图先行）：只改 finalPrompt 与可选的 storyboardPrompt，composed 重置为草稿（等用户逐镜确认）；绝不修改分镜其他字段。storyboardPrompt 编译规范见 prompt-compiler.md §12。
- 未找到的 shotId / 空 finalPrompt 会逐条跳过并在结果中列出。
- 入口：用户在 Studio 第 3 步点「优化提示词」按钮（**可选操作**，自动派发优化指令），或对话中明确要求模型定制编译时主动调用。调用前先 `canvas_get_state` 读取分镜与实体，按 prompt-compiler.md §9 出货规范逐镜打磨。拼好的 finalPrompt 本身即最终出货——本工具只是可选的二次优化，不是质量的主责路径。

### canvas_script_generate_storyboards

生成脚本镜头的分镜关键帧。省略 `shotIds` 时只处理既未 ready、也未生成中的镜头；传入时重新生成指定镜头。模型必须支持图片参考。

```text
scriptNodeId            脚本节点 id
shotIds?                指定镜头 id 数组
reference3dSelections?  每个被引用 3D 节点恰好一项 [{ nodeId, view }]，如
                        [{"nodeId":"3d-node-id","view":"all"}]；引用 3D 时必填。
                        view 是单个枚举字符串（primary | left | right | top | all，
                        all 即四视角），禁止数组或 item 键
model?                  models_list 返回的参考图生图模型
size?/quality?/background?/count?  可选图片参数覆盖
```

参考节点不由 Agent 传入。工具按每镜 `entityRefs` 解析 ready 的资产槽位，由 renderer 创建 Image 节点、脚本从属边、资产参考边，并回写 `storyboardNodes`。若包含 3D 资产，先用 `view_image` 的 `imageId=primary|left|right|top` 检查视图，再通过 `reference3dSelections` 为每个 3D 节点传一项 `{ nodeId, view }`（单一视角或 `all`）。禁止创建 Config 节点或用 `canvas_generate_node` 代替。

### canvas_script_add_shot / canvas_script_update_shot / canvas_script_delete_shot / canvas_script_reorder_shots

```text
add_shot          追加一镜（全字段同上，含可选 storyboardPrompt）
update_shot       按 shotId 更新任意字段（含 entityRefs、finalPrompt、storyboardPrompt）
delete_shot       按 shotId 删除
reorder_shots     按 shotIds[] 重排
```

storyboardPrompt（可选，分镜图先行用）：静态关键帧提示词——进行中瞬间、无运镜/时长/声音（编译规范 prompt-compiler.md §12）；空/缺省 = 未设置。replace_shots 的每条 shot 同样支持该可选字段。

⚠ finalPrompt 回写纪律（增强路径，见 prompt-compiler.md §8/§9）：用户在 Studio 点「↻ 重新合成」会按默认模板**覆盖** finalPrompt。回写前告知用户，回写后在交付说明里注明「模型定制稿，重新合成会还原」。

## 2. ScriptShot 字段映射（专业字段 → Schema）

| 分镜专业字段 | ScriptShot 落点 |
|---|---|
| 景别 / 角度 / 运镜 / 时长 / 氛围 | shotSize / angle / movement / duration / mood（用词库标准词） |
| 动作 + 构图 + 转场 + 接续状态 | description（文本承载，末尾【接续】行） |
| 角色/场景/道具引用 | entityRefs（名称数组，画布自动解析成内联胶囊） |
| 台词（含角色+情绪标注） | dialogue |
| 音效（具体名词） | sfx |
| 音频素材挂载 | sfxAudioNodeId / dialogueAudioNodeId |
| 内联引用（描述中 @某人） | 画布自动生成，按名称解析 |
| 16 项锁 / 空间快照 | 资产的 consistency 字段（不在镜头层重复） |
| 编译后最终提示词 | finalPrompt（update_shot 回写） |
| 静态关键帧提示词（分镜图先行） | storyboardPrompt（可选；每镜进行中瞬间，见 prompt-compiler.md §12） |
| 是否已确认 | composed（用户在 Studio 第 3 步操作，agent 不直接翻转） |

**原则：schema 里有的字段填 schema，没有的专业字段全部落 description 文本**——保证 Studio 表格下拉可读、可手动编辑。

## 2.5 描述内联规范（资产引用写法）

画布按资产名称在 description 文本中的**原样位置**注入内联引用胶囊（`script_resolve_shot_refs`）。所以名称必须以自然语义出现在句子的正确位置：

- ✅ 内联：「镜头缓缓下推，落向一扇亮着冷蓝光的窗——那是陆远的公寓的窗。」
- ❌ 句尾堆放：「……画面结束于窗外夜景填满整个画面。陆远的公寓」——名字悬在句尾不成句，解析出的胶囊位置也是错的。

规则：

1. 资产在句中承担什么句法角色（主语/领属/宾语），名字就写在那个位置；同一资产提多次没问题，entityRefs 去重填一次。
2. **禁止把引用资产追加到句尾或另起一行罗列**——entityRefs 不是附件清单，它只是「本镜引用了哪些资产」的索引。
3. 写完自检：entityRefs 每一项都能在 description 里**原样找到**；description 里提到的每个已锁资产都已在 entityRefs 里。
4. 未锁资产不许出现在描述或 entityRefs（先回资产阶段）。

## 3. 画布通用工具（高频）

```text
canvas_get_state            读画布快照（节点/连线/选区）——每次会话开头 & 写前核对
canvas_get_selection        读选中节点
canvas_create_text_node     建文本节点（节拍表/情绪曲线/圣经存档用）
canvas_list_projects        找项目
generation_get_status       查生成任务（nodeIds 批量）
assets_add / assets_list    「我的素材」存取（QC 卡/take review/剧本存档）
canvas_run_generation       重跑指定生成结果节点（不支持 Config）
```

Config 节点只供用户在画布中手动创建和运行，不作为 Agent 工具暴露。

## 4. 生成等待与轮询纪律

- 生成提交是异步的：工具返回成功 ≠ 生成完成。
- 图片：提交后 ≥30s 才查；视频：≥60s 才查。
- 用 `generation_get_status(nodeIds=[...])` 批量查；终态（success/error）即停。
- 禁止无间隔连续查询同一任务；任务暂未出现在缓存里**不要重复提交**。
- 资产参考图没 ready → 不能进分镜；视频没出 → 不做 take review。

## 5. 画布连线语义（写入后画布自动维护，agent 无需手动连）

```text
从属边（灰虚线）：script → 资产图节点 / 视频节点（产物归属）
消费边（派生渲染）：资产图 → 引用它的镜头视频节点
                    角色=金色 / 场景=青色 / 道具=绿色
```

「完成脚本编辑」时按 shotId 幂等展开：已有节点复用更新、不重复创建。展开后默认**不**自动排队生成——由用户单节点点「生成」或编组右键「批量生成视频」。

## 6. 常见错误对照

| 报错/现象 | 原因 | 处理 |
|---|---|---|
| entityRefs 没变成内联胶囊 | 名称与资产不匹配 | canvas_get_state 核对资产名后 update_shot |
| 脚本节点 generating 卡住 | 旧版节点生成模式已移除 | 提示用户重开画布会话；用 agent 工具写分镜 |
| replace 后用户手动改动丢失 | 误用 replace 覆盖 | 改用 update_shot 逐条恢复；写前先 get_state |
| 资产槽一直 queued | 生图任务失败/排队 | generation_get_status 查具体节点，错误节点单独重跑 |
| finalPrompt 里引用编号错位 | 展开后挂载顺序变化 | 按公共素材固定编号规则修正后 update_shot |
