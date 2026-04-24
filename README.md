# OpenAI image2 视觉实验

一个 GitHub Pages 静态图集，展示 image2 生成的传播向海报图片。所有图片都发布在同一个网站里，用可扩展的 `category` 组织和筛选。
本网站所有内容基于OpenAI Codex 和Image2.0 生成。

## 内容

- 当前已有 1 个批次、2 个 category
- 后续批次可以使用任意新 category，例如真实场景、产品概念、人物叙事、地域文化、风格实验等
- 图片位于 `assets/images/`
- 首页缩略图位于 `assets/thumbs/`
- 图集数据位于 `assets/gallery.json`
- 初始提示词位于 `image_prompts.json`

## GitHub Pages

仓库发布后，Pages 使用 `main` 分支根目录作为发布源。

## 追加新批次

准备一份批次 metadata JSON，然后运行：

```bash
node scripts/import-gallery-batch.mjs --metadata path/to/batch.json --images path/to/generated-images
```

metadata 结构：

```json
{
  "theme": "新主题",
  "batchId": "optional-batch-id",
  "items": [
    {
      "source": "image-01.png",
      "category": "real-scenes",
      "categoryLabel": "真实场景",
      "title": "图片标题",
      "description": "一句话描述",
      "prompt": "生成提示词"
    }
  ]
}
```

脚本会复制原图到 `assets/images/<batchId>/`，生成首页用 WebP 缩略图到 `assets/thumbs/<batchId>/`，追加 `assets/gallery.json`，并重建 `assets/contact_sheet_image2.jpg`。然后提交并推送即可更新同一个 GitHub Pages 网站。
