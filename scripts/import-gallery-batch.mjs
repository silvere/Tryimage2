#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(args.root || ".");
const dataPath = resolve(repoRoot, args.data || "assets/gallery.json");
const metadataPath = args.metadata ? resolve(args.metadata) : null;
const imageDir = args.images ? resolve(args.images) : null;

if (!metadataPath) fail("Missing --metadata <batch.json>");
if (!existsSync(metadataPath)) fail(`Metadata file not found: ${metadataPath}`);
if (!existsSync(dataPath)) fail(`Gallery data file not found: ${dataPath}`);

const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const gallery = JSON.parse(readFileSync(dataPath, "utf8"));
const batchId = slug(metadata.batchId || metadata.theme || `batch-${Date.now()}`);
const createdAt = metadata.createdAt || new Date().toISOString().slice(0, 10);
const sourceItems = metadata.items || [];

if (!metadata.theme) fail("Metadata must include a theme");
if (!sourceItems.length) fail("Metadata must include items[]");

const categories = new Map((gallery.categories || []).map((item) => [item.id, item]));
for (const item of sourceItems) {
  const categoryId = slug(item.category || "uncategorized");
  if (!categories.has(categoryId)) {
    categories.set(categoryId, { id: categoryId, label: item.categoryLabel || item.category || "未分类" });
  }
}
gallery.categories = Array.from(categories.values());

const imageOutputDir = resolve(repoRoot, "assets/images", batchId);
const thumbOutputDir = resolve(repoRoot, "assets/thumbs", batchId);
mkdirSync(imageOutputDir, { recursive: true });
mkdirSync(thumbOutputDir, { recursive: true });

const existingIds = new Set((gallery.items || []).map((item) => item.id));
const added = [];
sourceItems.forEach((item, index) => {
  const source = resolveSource(item.source || item.image, imageDir, metadataPath);
  if (!existsSync(source)) fail(`Image not found for item ${index + 1}: ${source}`);

  const number = String(item.number || index + 1).padStart(2, "0");
  const itemSlug = slug(item.slug || item.title || `${batchId}-${number}`);
  const outputName = `${number}_${itemSlug}${extname(source) || ".png"}`;
  const outputPath = join(imageOutputDir, outputName);
  const thumbBase = join(thumbOutputDir, `${number}_${itemSlug}`);
  copyFileSync(source, outputPath);
  const thumbPath = createThumbnail(outputPath, thumbBase);

  let id = `${batchId}_${number}_${itemSlug}`;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${batchId}_${number}_${itemSlug}_${suffix++}`;
  }
  existingIds.add(id);

  const category = slug(item.category || "uncategorized");
  added.push({
    id,
    batch: batchId,
    category,
    number,
    title: item.title || itemSlug,
    image: toPosix(relative(repoRoot, outputPath)),
    thumb: toPosix(relative(repoRoot, thumbPath)),
    description: item.description || "",
    prompt: item.prompt || ""
  });
});

gallery.batches = gallery.batches || [];
gallery.batches.push({
  id: batchId,
  theme: metadata.theme,
  createdAt,
  count: added.length
});
gallery.items = [...(gallery.items || []), ...added];
gallery.site = gallery.site || {};
gallery.site.subtitle = `${gallery.items.length} 张传播向 AI 海报`;

writeFileSync(dataPath, `${JSON.stringify(gallery, null, 2)}\n`);
rebuildContactSheet(repoRoot);

console.log(`Imported ${added.length} images into ${toPosix(relative(repoRoot, imageOutputDir))}`);
console.log(`Updated ${toPosix(relative(repoRoot, dataPath))}`);

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) continue;
    out[value.slice(2)] = values[i + 1] && !values[i + 1].startsWith("--") ? values[++i] : true;
  }
  return out;
}

function resolveSource(source, dir, metadata) {
  if (!source) fail("Each item needs source or image");
  if (isAbsolute(source)) return source;
  if (dir) return resolve(dir, source);
  return resolve(dirname(metadata), source);
}

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function toPosix(value) {
  return value.split("\\").join("/");
}

function rebuildContactSheet(root) {
  const images = JSON.parse(readFileSync(resolve(root, "assets/gallery.json"), "utf8")).items
    .map((item) => resolve(root, item.image))
    .filter((image) => existsSync(image));
  if (!images.length) return;

  const magick = spawnSync("magick", [
    "montage",
    ...images,
    "-thumbnail",
    "360x203",
    "-geometry",
    "360x203+10+10",
    "-tile",
    "3x",
    resolve(root, "assets/contact_sheet_image2.jpg")
  ], { encoding: "utf8" });

  if (magick.status !== 0) {
    console.warn("ImageMagick montage failed; contact sheet was not rebuilt.");
    if (magick.stderr) console.warn(magick.stderr.trim());
  }
}

function createThumbnail(source, targetBase) {
  const webpTarget = `${targetBase}.webp`;
  const magick = spawnSync("magick", [
    source,
    "-resize",
    "720x405^",
    "-gravity",
    "center",
    "-extent",
    "720x405",
    "-quality",
    "78",
    webpTarget
  ], { encoding: "utf8" });

  if (magick.status === 0 && existsSync(webpTarget)) {
    return webpTarget;
  }

  console.warn(`ImageMagick thumbnail failed for ${source}; trying sips PNG fallback.`);
  if (magick.stderr) console.warn(magick.stderr.trim());

  const pngTarget = `${targetBase}.png`;
  const sips = spawnSync("sips", [
    "-Z",
    "720",
    source,
    "--out",
    pngTarget
  ], { encoding: "utf8" });

  if (sips.status === 0 && existsSync(pngTarget)) {
    return pngTarget;
  }

  console.warn(`Thumbnail generation failed for ${source}; cards will use the original image.`);
  if (sips.stderr) console.warn(sips.stderr.trim());
  return source;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
