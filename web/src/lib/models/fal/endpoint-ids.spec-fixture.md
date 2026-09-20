# 首期 fal 精确入口（vendored fixture）

本文件节选自渠道设计文档的公开附录，仅保留 endpoint ID 表格，供 `endpoint-ids.test.ts`
校验 `FAL_ENDPOINT_IDS` 固定清单使用。表格内为供应商官方公开 API 入口与模型 ID。

### 图片：12 个入口

| Endpoint ID | 用途 |
| --- | --- |
| [`fal-ai/flux-2-pro`](https://fal.ai/models/fal-ai/flux-2-pro/api) | FLUX.2 Pro 文生图 |
| [`fal-ai/flux-2-pro/edit`](https://fal.ai/models/fal-ai/flux-2-pro/edit/api) | FLUX.2 Pro 图片编辑 |
| [`fal-ai/nano-banana`](https://fal.ai/models/fal-ai/nano-banana/api) | Nano Banana 文生图 |
| [`fal-ai/nano-banana/edit`](https://fal.ai/models/fal-ai/nano-banana/edit/api) | Nano Banana 图片编辑 |
| [`fal-ai/nano-banana-pro`](https://fal.ai/models/fal-ai/nano-banana-pro/api) | Nano Banana Pro 文生图 |
| [`fal-ai/nano-banana-pro/edit`](https://fal.ai/models/fal-ai/nano-banana-pro/edit/api) | Nano Banana Pro 图片编辑 |
| [`fal-ai/nano-banana-2`](https://fal.ai/models/fal-ai/nano-banana-2/api) | Nano Banana 2 文生图 |
| [`fal-ai/nano-banana-2/edit`](https://fal.ai/models/fal-ai/nano-banana-2/edit/api) | Nano Banana 2 图片编辑 |
| [`openai/gpt-image-2`](https://fal.ai/models/openai/gpt-image-2) | GPT Image 2 文生图 |
| [`openai/gpt-image-2/edit`](https://fal.ai/models/openai/gpt-image-2/edit) | GPT Image 2 图片编辑 |
| [`bytedance/seedream/v5/pro/text-to-image`](https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image) | Seedream 5.0 Pro 文生图 |
| [`bytedance/seedream/v5/pro/edit`](https://fal.ai/models/bytedance/seedream/v5/pro/edit) | Seedream 5.0 Pro 图片编辑 |

### 视频：24 个入口

| Endpoint ID | 用途 |
| --- | --- |
| [`fal-ai/kling-video/v3/pro/text-to-video`](https://fal.ai/models/fal-ai/kling-video/v3/pro/text-to-video/api) | Kling 3.0 Pro 文生视频 |
| [`fal-ai/kling-video/v3/pro/image-to-video`](https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api) | Kling 3.0 Pro 图生视频 |
| [`fal-ai/kling-video/v3/standard/text-to-video`](https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video) | Kling 3.0 Standard 文生视频 |
| [`fal-ai/kling-video/v3/standard/image-to-video`](https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video) | Kling 3.0 Standard 图生视频 |
| [`fal-ai/veo3.1`](https://fal.ai/models/fal-ai/veo3.1) | Veo 3.1 文生视频 |
| [`fal-ai/veo3.1/image-to-video`](https://fal.ai/models/fal-ai/veo3.1/image-to-video) | Veo 3.1 图生视频 |
| [`fal-ai/veo3.1/first-last-frame-to-video`](https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video) | Veo 3.1 首尾帧 |
| [`fal-ai/veo3.1/fast`](https://fal.ai/models/fal-ai/veo3.1/fast) | Veo 3.1 Fast 文生视频 |
| [`fal-ai/veo3.1/fast/image-to-video`](https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video) | Veo 3.1 Fast 图生视频 |
| [`fal-ai/veo3.1/fast/first-last-frame-to-video`](https://fal.ai/models/fal-ai/veo3.1/fast/first-last-frame-to-video) | Veo 3.1 Fast 首尾帧 |
| [`bytedance/seedance-2.0/text-to-video`](https://fal.ai/models/bytedance/seedance-2.0/text-to-video/api) | Seedance 2.0 文生视频 |
| [`bytedance/seedance-2.0/image-to-video`](https://fal.ai/models/bytedance/seedance-2.0/image-to-video) | Seedance 2.0 图生视频 |
| [`bytedance/seedance-2.0/fast/text-to-video`](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video) | Seedance 2.0 Fast 文生视频 |
| [`bytedance/seedance-2.0/fast/image-to-video`](https://fal.ai/models/bytedance/seedance-2.0/fast/image-to-video) | Seedance 2.0 Fast 图生视频 |
| [`wan/v2.6/text-to-video`](https://fal.ai/wan-2.6) | Wan 2.6 文生视频 |
| [`wan/v2.6/image-to-video`](https://fal.ai/models/wan/v2.6/image-to-video/api) | Wan 2.6 图生视频 |
| [`fal-ai/minimax/hailuo-2.3/pro/text-to-video`](https://fal.ai/models/fal-ai/minimax/hailuo-2.3/pro/text-to-video/api) | Hailuo 2.3 Pro 文生视频 |
| [`fal-ai/minimax/hailuo-2.3/pro/image-to-video`](https://fal.ai/models/fal-ai/minimax/hailuo-2.3/pro/image-to-video/api) | Hailuo 2.3 Pro 图生视频 |
| [`fal-ai/minimax/hailuo-2.3/standard/text-to-video`](https://fal.ai/models/fal-ai/minimax/hailuo-2.3/standard/text-to-video) | Hailuo 2.3 Standard 文生视频 |
| [`fal-ai/minimax/hailuo-2.3/standard/image-to-video`](https://fal.ai/models/fal-ai/minimax/hailuo-2.3/standard/image-to-video) | Hailuo 2.3 Standard 图生视频 |
| [`fal-ai/ltx-2.3/text-to-video`](https://fal.ai/models/fal-ai/ltx-2.3/text-to-video) | LTX 2.3 Pro 文生视频 |
| [`fal-ai/ltx-2.3/text-to-video/fast`](https://fal.ai/models/fal-ai/ltx-2.3/text-to-video/fast/api) | LTX 2.3 Fast 文生视频 |
| [`fal-ai/ltx-2.3/image-to-video`](https://fal.ai/models/fal-ai/ltx-2.3/image-to-video/api) | LTX 2.3 Pro 图生视频 |
| [`fal-ai/ltx-2.3/image-to-video/fast`](https://fal.ai/models/fal-ai/ltx-2.3/image-to-video/fast) | LTX 2.3 Fast 图生视频 |
