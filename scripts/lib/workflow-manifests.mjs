#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const root = path.resolve(__dirname, "../..");
export const workflowRoot = path.join(root, "workflow");
export const processLogPath = path.join(root, "process.md");

export const workflowDirs = {
  topicsPending: path.join(workflowRoot, "topics/pending"),
  topicsSelected: path.join(workflowRoot, "topics/selected"),
  topicsCancelled: path.join(workflowRoot, "topics/cancelled"),
  generationPending: path.join(workflowRoot, "generation/pending"),
  generationRunning: path.join(workflowRoot, "generation/running"),
  generationDone: path.join(workflowRoot, "generation/done"),
  generationFailed: path.join(workflowRoot, "generation/failed"),
  publishPending: path.join(workflowRoot, "publish/pending"),
  publishRunning: path.join(workflowRoot, "publish/running"),
  publishDone: path.join(workflowRoot, "publish/done"),
  publishFailed: path.join(workflowRoot, "publish/failed")
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureWorkflowDirs() {
  for (const dir of Object.values(workflowDirs)) {
    ensureDir(dir);
  }
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    i += 1;
    if (key in args) {
      args[key] = Array.isArray(args[key]) ? [...args[key], next] : [args[key], next];
    } else {
      args[key] = next;
    }
  }
  return args;
}

export function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(dir, name));
}

export function nowIso() {
  return new Date().toISOString();
}

export function todayStamp() {
  return nowIso().slice(0, 10);
}

export function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `item-${Date.now()}`;
}

export function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function resolveFromRoot(...parts) {
  const candidate = path.resolve(root, ...parts);
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return candidate;
  }
  fail(`Path escapes repo root: ${candidate}`, 2);
}

export function relativeToRoot(file) {
  return toPosix(path.relative(root, file));
}

export function toPosix(value) {
  return String(value).split(path.sep).join("/");
}

export function exists(file) {
  return fs.existsSync(file);
}

export function removeFile(file) {
  if (fs.existsSync(file)) fs.rmSync(file);
}

export function replaceManifestAcrossStates(fileName, targetFile, stateDirs) {
  for (const dir of stateDirs) {
    const candidate = path.join(dir, fileName);
    if (candidate !== targetFile && fs.existsSync(candidate)) {
      fs.rmSync(candidate);
    }
  }
}

export function pickTopicPath(input) {
  if (input) {
    if (input.endsWith('.json') || input.includes('/')) {
      return resolveFromRoot(input);
    }
    return path.join(workflowDirs.topicsSelected, `${input}.json`);
  }

  for (const topicPath of listJson(workflowDirs.topicsSelected)) {
    const topic = readJson(topicPath, {});
    if ((topic?.generation?.status || 'pending') === 'pending') {
      return topicPath;
    }
  }
  return null;
}

export function topicFileName(topic) {
  return `${topic.id || slug(topic.title)}.json`;
}

export function publishStatusSkeleton() {
  return {
    status: 'blocked_until_generated',
    github: { status: 'blocked' },
    xiaohongshu: { status: 'blocked' }
  };
}

export function generationStatusSkeleton() {
  return {
    status: 'pending',
    batchId: null,
    metadataPath: null,
    generatedImageDir: null,
    artifactPath: null,
    itemCount: null,
    category: null,
    categoryLabel: null,
    spec: null,
    lastError: null,
    updatedAt: nowIso()
  };
}

export function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

export function normalizeBatchItem(raw, index, defaults = {}) {
  const number = index + 1;
  const title = String(raw?.title || '').trim();
  const prompt = String(raw?.prompt || '').trim();
  const source = String(raw?.source || `${String(number).padStart(2, '0')}_${slug(title || `item-${number}`)}.png`).trim();
  return {
    source,
    category: String(raw?.category || defaults.category || 'uncategorized').trim(),
    categoryLabel: String(raw?.categoryLabel || defaults.categoryLabel || raw?.category || defaults.category || '未分类').trim(),
    title,
    description: String(raw?.description || '').trim(),
    prompt,
    number: raw?.number || number
  };
}

export function validateBatchMetadata(metadata) {
  const issues = [];
  if (!metadata || typeof metadata !== 'object') {
    return ['Batch metadata must be an object'];
  }
  if (!String(metadata.theme || '').trim()) issues.push('Batch metadata.theme is required');
  if (!String(metadata.batchId || '').trim()) issues.push('Batch metadata.batchId is required');
  if (String(metadata.batchId || '').trim() && !isSafeBatchId(metadata.batchId)) {
    issues.push('Batch metadata.batchId must be a filename-safe id without path traversal or separators');
  }
  if (!Array.isArray(metadata.items) || metadata.items.length === 0) {
    issues.push('Batch metadata.items must be a non-empty array');
  }
  const seenSources = new Set();
  for (const [index, item] of (metadata.items || []).entries()) {
    const source = String(item?.source || '').trim();
    if (!source) issues.push(`items[${index}].source is required`);
    if (source && !isSafeBatchItemSource(source)) {
      issues.push(`items[${index}].source must stay within tmp/<batch-id>/ and cannot be absolute or contain .. segments`);
    }
    if (source && seenSources.has(source)) {
      issues.push(`items[${index}].source must be unique within the batch: ${source}`);
    }
    seenSources.add(source);
    if (!String(item?.category || '').trim()) issues.push(`items[${index}].category is required`);
    if (!String(item?.categoryLabel || '').trim()) issues.push(`items[${index}].categoryLabel is required`);
    if (!String(item?.title || '').trim()) issues.push(`items[${index}].title is required`);
    if (!String(item?.prompt || '').trim()) issues.push(`items[${index}].prompt is required`);
  }
  return issues;
}

export function isSafeBatchId(batchId) {
  const raw = String(batchId || '').trim();
  if (!raw || path.isAbsolute(raw)) return false;
  const normalizedSeparators = raw.replace(/\\/g, '/');
  if (normalizedSeparators.includes('/')) return false;
  if (normalizedSeparators.includes('..')) return false;
  if (normalizedSeparators === '.' || normalizedSeparators === '..') return false;
  return normalizedSeparators === path.posix.basename(normalizedSeparators);
}

export function isSafeBatchItemSource(source) {
  const raw = String(source || '').trim();
  if (!raw || path.isAbsolute(raw)) return false;
  const normalizedSeparators = raw.replace(/\\/g, '/');
  if (normalizedSeparators.includes('/')) return false;
  if (normalizedSeparators.includes('..')) return false;
  if (normalizedSeparators === '.' || normalizedSeparators === '..') return false;
  const normalized = path.posix.normalize(normalizedSeparators);
  return normalized === normalizedSeparators && normalized === path.posix.basename(normalized);
}

export function isSafeMetadataPath(metadataPath) {
  const raw = String(metadataPath || '').trim();
  if (!raw || path.isAbsolute(raw)) return false;
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (!normalized.startsWith('batches/')) return false;
  if (normalized.includes('/../') || normalized.endsWith('/..')) return false;
  const remainder = normalized.slice('batches/'.length);
  if (!remainder || remainder.includes('/')) return false;
  if (!remainder.endsWith('.json')) return false;
  return true;
}

export function expectedMetadataPathForBatchId(batchId) {
  return `batches/${String(batchId || '').trim()}.json`;
}

export function normalizeBatchSpec(rawSpec, defaults = {}) {
  const spec = Array.isArray(rawSpec) ? { items: rawSpec } : { ...(rawSpec || {}) };
  const items = Array.isArray(spec.items) ? spec.items : [];
  const category = String(spec.category || defaults.category || '').trim();
  const categoryLabel = String(spec.categoryLabel || defaults.categoryLabel || category || '').trim();
  return {
    theme: String(spec.theme || defaults.theme || '').trim(),
    batchId: String(spec.batchId || defaults.batchId || '').trim(),
    createdAt: String(spec.createdAt || defaults.createdAt || todayStamp()).trim(),
    category,
    categoryLabel,
    items: items.map((item, index) => normalizeBatchItem(item, index, { category, categoryLabel }))
  };
}

export function buildBatchMetadataFromTopic(topic) {
  const generation = topic?.generation || {};
  const spec = normalizeBatchSpec(generation.spec, {
    theme: topic.title,
    batchId: generation.batchId || `${slug(topic.title)}-${String(topic.createdAt || todayStamp()).slice(0, 10)}`,
    createdAt: String(topic.createdAt || todayStamp()).slice(0, 10),
    category: generation.category || slug(topic.title),
    categoryLabel: generation.categoryLabel || topic.title
  });
  return {
    theme: spec.theme || topic.title,
    batchId: spec.batchId,
    createdAt: spec.createdAt,
    items: spec.items
  };
}

export function validateTopicManifest(topic) {
  const issues = [];
  if (!topic || typeof topic !== 'object') return ['Topic manifest must be an object'];
  if (!String(topic.id || '').trim()) issues.push('topic.id is required');
  if (!String(topic.title || '').trim()) issues.push('topic.title is required');
  if (!String(topic.status || '').trim()) issues.push('topic.status is required');
  if (!topic.generation || typeof topic.generation !== 'object') issues.push('topic.generation is required');
  if (!topic.publish || typeof topic.publish !== 'object') issues.push('topic.publish is required');
  if (String(topic.generation?.batchId || '').trim() && !isSafeBatchId(topic.generation.batchId)) {
    issues.push('topic.generation.batchId must be a filename-safe id without path traversal or separators');
  }
  if (String(topic.generation?.metadataPath || '').trim() && !isSafeMetadataPath(topic.generation.metadataPath)) {
    issues.push('topic.generation.metadataPath must stay under batches/<batch-id>.json');
  }
  if (String(topic.generation?.batchId || '').trim() && String(topic.generation?.metadataPath || '').trim()) {
    const expectedMetadataPath = expectedMetadataPathForBatchId(topic.generation.batchId);
    if (topic.generation.metadataPath !== expectedMetadataPath) {
      issues.push(`topic.generation.metadataPath must equal ${expectedMetadataPath}`);
    }
  }
  if (topic.generation?.spec?.batchId && topic.generation?.batchId && topic.generation.spec.batchId !== topic.generation.batchId) {
    issues.push('topic.generation.spec.batchId must match topic.generation.batchId');
  }
  if (topic.generation?.spec) {
    const batchIssues = validateBatchMetadata(buildBatchMetadataFromTopic(topic));
    issues.push(...batchIssues.map((issue) => `topic.generation.spec: ${issue}`));
  }
  return issues;
}

export function appendProcessLog(lines, heading = '## Workflow pipeline updates') {
  const content = Array.isArray(lines) ? lines : [String(lines)];
  const body = [`${heading}`, '', ...content, ''].join('\n');
  if (!fs.existsSync(processLogPath)) {
    fs.writeFileSync(processLogPath, `${body}\n`);
    return;
  }
  fs.appendFileSync(processLogPath, `\n${body}\n`);
}
