# 提示词编译（Prompt Compiler）

把「版式骨架 + 角色锁」编译成目标平台可用的 prompt。顺序固定，不得跳步。

---

## 1. 编译顺序

1. **取骨架**：templates.md 按用途映射取版式，骨架一字不改。
2. **填槽**：只从 intake.md 的锁逐字取词，不改写、不精简——锁是全项目共享的事实源，改写会造成同一项目角色间不一致。
3. **挂三重约束**：确认全局句 / 权威格 / 禁止项三者在位（骨架自带，检查是否被截断）。
4. **风格与画质**：风格槽按题材-风格映射取词；具体名词收尾（发丝、瞳孔、面料纹理），不堆空泛形容词。
5. **负面项**：中文平台独立成句放末尾；英文平台走 --no 或 negative 字段，不塞正文。
6. **出货自检**（§5）。

---

## 2. 中文出货规则（Seedance / 即梦 / 国内平台）

- 一句一义，标准术语：全身正面站姿 / 右侧 90° 侧面 / 背面 / 头部五官特写。
- anti-slop 禁用表（与 shotshot vocab.md §8 同表）：高清、超清、高品质、震撼、大片质感、极致、唯美、史诗级、电影级（空用）、充满张力——禁用；形容词换成物理事实（材质、光位、比例、色值）。
- 「细节锐利」这类收束词只放风格句，不散落全文。
- @图片N 职责逐份声明，一张图一个职责，不重复指派。
- 版式行（画幅/底色/比例）集中一处写，不与外观描述交叉。

---

## 3. 英文出货规则（MJ / GPT-image / 海外平台）

术语对照（措辞源自语料 en#2408 原文，勿自创）：

| 中文 | 英文 |
|---|---|
| 角色设定图 / 转面图 | character reference sheet / turnaround model sheet |
| 全身正面站姿 | full body front view, standing |
| 右侧 90° 侧面 | side profile view |
| 3/4 视图 | 3/4 view |
| 背面全身 | back view, full body |
| 头部五官特写 | headshot, facial close-up |
| 无头（颈部平整截断） | headless, cropped at the neck |
| 中性灰棚拍背景 | clean neutral gray studio background |
| 均匀柔光 | soft even studio lighting |
| 无缝背景 | seamless background |
| 全视角同一长相 | consistent facial features and proportions across all views |
| 单人 | single character only |
| 禁文字水印 | no text, no watermark |

- **Midjourney**：句尾接 `--ar 16:9 --no text,watermark,extra heads`；写实加 `--style raw`；参考图放句首 image prompt 位（角色参考参数以当前版本文档为准）。
- **GPT-image**：整段自然语言；参考图走图片输入；保留「do not carry over the reference's pose, background, or lighting」防复制句。
- 负面不写 "no ..." 长句塞正文，统一走平台负面机制。

---

## 4. 平台参数卡（纯 prompt 通道随三件套交付）

参数以各平台**当前**文档为准，不确定就明示；以下是稳定要点：

| 平台 | 要点 |
|---|---|
| 即梦 AI | 图片生成；比例选 16:9；模型选当前最高图片模型；有参考图则上传并选「主体/角色参考」；中文 prompt 直接粘贴 |
| 火山方舟 Seedream | 文生图 / 图生图接口；size 用 16:9 档；多参考图按接口参考图参数传入；模型 ID 与尺寸枚举以方舟当前文档为准 |
| Midjourney | 英文版 + --ar 16:9 + --no 负面；--style raw 保写实；角色一致性参考用当前版本的 omni-reference |
| GPT-image | 整段自然语言；参考图作为输入图；最适合 T4 照片转人设 |

---

## 5. 出货自检 6 条

- [ ] 版式骨架未改动，格序未调换；默认版式下格 1-3 的「无头」行在位（含头变体需显式换行）
- [ ] 槽位全部填满，无 {花括号} 残留，用词全部来自锁
- [ ] 三重约束在位（全局句 / 权威格 / 禁止项）
- [ ] 无 anti-slop 空泛词
- [ ] 平台语言正确（中文 / 英文），负面项走平台机制
- [ ] 模式 B：参考图职责句与防复制句都在位
