#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appendProcessLog,
  buildBatchMetadataFromTopic,
  ensureWorkflowDirs,
  exists,
  expectedMetadataPathForBatchId,
  fail,
  nowIso,
  parseArgs,
  pickTopicPath,
  readJson,
  relativeToRoot,
  removeFile,
  replaceManifestAcrossStates,
  resolveFromRoot,
  slug,
  validateBatchMetadata,
  validateTopicManifest,
  workflowDirs,
  writeJson
} from "./lib/workflow-manifests.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

ensureWorkflowDirs();

const topicPath = pickTopicPath(args.topic);
if (!topicPath) fail("No pending topic found in workflow/topics/selected/", 2);

const topic = readJson(topicPath);
const topicIssues = validateTopicManifest(topic);
if (topicIssues.length) {
  fail(`Invalid topic manifest:\n- ${topicIssues.join("\n- ")}`, 2);
}

const batchId = topic?.generation?.batchId || args['batch-id'] || `${slug(topic.title)}-${String(topic.createdAt || nowIso()).slice(0, 10)}`;
const expectedMetadataPath = expectedMetadataPathForBatchId(batchId);
const metadataPath = path.resolve(resolveFromRoot(topic?.generation?.metadataPath || args.metadata || expectedMetadataPath));
const generatorScript = path.resolve(resolveFromRoot(args['generator-script'] || 'tmp/generate_batch_codex.py'));
const generatedImageDir = resolveFromRoot('tmp', batchId);
const fileName = `${batchId}.json`;
const pendingPath = path.join(workflowDirs.generationPending, fileName);
const runningPath = path.join(workflowDirs.generationRunning, fileName);
const failedPath = path.join(workflowDirs.generationFailed, fileName);
const donePath = path.join(workflowDirs.generationDone, fileName);
const publishPendingPath = path.join(workflowDirs.publishPending, fileName);
const startedAt = nowIso();

const bootstrapMetadata = !exists(metadataPath) && topic?.generation?.spec?.items?.length
  ? buildBatchMetadataFromTopic({
      ...topic,
      generation: {
        ...(topic.generation || {}),
        batchId,
        metadataPath: relativeToRoot(metadataPath)
      }
    })
  : null;
const metadata = bootstrapMetadata || (exists(metadataPath) ? readJson(metadataPath) : null);
const metadataIssues = [];
if (relativeToRoot(metadataPath) !== expectedMetadataPath) {
  metadataIssues.push(`Resolved metadata path must equal ${expectedMetadataPath}`);
}
metadataIssues.push(...(metadata ? validateBatchMetadata(metadata) : ['Missing metadata file and no topic.generation.spec items available']));
if (metadata?.batchId && metadata.batchId !== batchId) {
  metadataIssues.push(`Batch metadata.batchId must equal topic batchId ${batchId}`);
}
const canBootstrap = Boolean(bootstrapMetadata);
const artifact = {
  topicId: topic.id,
  batchId,
  theme: topic.title,
  topicPath: relativeToRoot(topicPath),
  metadataPath: relativeToRoot(metadataPath),
  generatedImageDir: relativeToRoot(generatedImageDir),
  count: metadata?.items?.length || 0,
  category: metadata?.items?.[0]?.category || topic?.generation?.category || null,
  categoryLabel: metadata?.items?.[0]?.categoryLabel || topic?.generation?.categoryLabel || null,
  generator: 'codex/openai',
  generatorScript: relativeToRoot(generatorScript),
  metadataSource: canBootstrap ? 'topic-spec-bootstrap' : 'existing-batch-metadata',
  status: 'preview',
  startedAt,
  completedAt: null,
  publish: {
    status: 'blocked_until_generated',
    github: { status: 'blocked' },
    xiaohongshu: { status: 'blocked' }
  },
  notes: []
};

if (metadataIssues.length) {
  artifact.status = 'blocked';
  artifact.notes.push(...metadataIssues);
  if (!args.execute) {
    fail(`Stage 2 blocked:\n- ${metadataIssues.join("\n- ")}`, 2);
  }
  clearPublishManifests(batchId);
  writeFinalArtifact(failedPath, artifact);
  const blockedTopic = {
    ...topic,
    generation: {
      ...(topic.generation || {}),
      status: 'blocked',
      batchId,
      metadataPath: relativeToRoot(metadataPath),
      generatedImageDir: relativeToRoot(generatedImageDir),
      itemCount: artifact.count,
      lastError: metadataIssues.join(' | '),
      artifactPath: relativeToRoot(failedPath),
      updatedAt: nowIso()
    }
  };
  writeJson(topicPath, blockedTopic);
  if (!args['no-log']) {
    appendProcessLog([
      `- ${nowIso()} Stage 2 阻塞：${topic.title}`,
      `  - batchId: \`${batchId}\``,
      `  - reason: ${metadataIssues.join(' / ')}`
    ]);
  }
  fail(`Stage 2 blocked:\n- ${metadataIssues.join("\n- ")}`, 2);
}

if (!args.execute) {
  console.log(JSON.stringify({
    mode: 'preview',
    topicId: topic.id,
    batchId,
    metadataPath: artifact.metadataPath,
    generatedImageDir: artifact.generatedImageDir,
    itemCount: artifact.count,
    metadataSource: artifact.metadataSource,
    willBootstrapMetadata: canBootstrap,
    nextCommand: `node scripts/run-generation-worker.mjs --topic ${topic.id} --execute`
  }, null, 2));
  process.exit(0);
}

if (!exists(generatorScript)) {
  artifact.status = 'blocked';
  artifact.notes.push(`Missing generator script: ${relativeToRoot(generatorScript)}`);
  clearPublishManifests(batchId);
  writeFinalArtifact(failedPath, artifact);
  const blockedTopic = {
    ...topic,
    generation: {
      ...(topic.generation || {}),
      status: 'blocked',
      batchId,
      metadataPath: relativeToRoot(metadataPath),
      generatedImageDir: relativeToRoot(generatedImageDir),
      itemCount: artifact.count,
      lastError: artifact.notes.at(-1),
      artifactPath: relativeToRoot(failedPath),
      updatedAt: nowIso()
    }
  };
  writeJson(topicPath, blockedTopic);
  fail(artifact.notes.at(-1), 2);
}

if (canBootstrap) {
  writeJson(metadataPath, metadata);
}

const unexpectedOutputs = findUnexpectedOutputs(metadata, generatedImageDir);
if (unexpectedOutputs.length) {
  artifact.status = 'blocked';
  artifact.notes.push(`Generated image dir contains unexpected files not referenced by metadata: ${unexpectedOutputs.join(', ')}`);
  clearPublishManifests(batchId);
  writeFinalArtifact(failedPath, artifact);
  const blockedTopic = {
    ...topic,
    generation: {
      ...(topic.generation || {}),
      status: 'blocked',
      batchId,
      metadataPath: relativeToRoot(metadataPath),
      generatedImageDir: relativeToRoot(generatedImageDir),
      itemCount: artifact.count,
      lastError: artifact.notes.at(-1),
      artifactPath: relativeToRoot(failedPath),
      updatedAt: nowIso()
    }
  };
  writeJson(topicPath, blockedTopic);
  fail(artifact.notes.at(-1), 2);
}

artifact.status = 'pending';
artifact.notes.push(canBootstrap ? 'Batch metadata bootstrapped from topic.generation.spec.' : 'Using existing batch metadata.');
writeFinalArtifact(pendingPath, artifact);

artifact.status = 'running';
writeFinalArtifact(runningPath, artifact);
const runningTopic = {
  ...topic,
  generation: {
    ...(topic.generation || {}),
    status: 'running',
    batchId,
    metadataPath: relativeToRoot(metadataPath),
    generatedImageDir: relativeToRoot(generatedImageDir),
    itemCount: artifact.count,
    category: artifact.category,
    categoryLabel: artifact.categoryLabel,
    lastError: null,
    artifactPath: relativeToRoot(runningPath),
    updatedAt: nowIso(),
    startedAt
  }
};
writeJson(topicPath, runningTopic);
if (!args['no-log']) {
  appendProcessLog([
    `- ${nowIso()} Stage 2 开始生图：${topic.title}`,
    `  - batchId: \`${batchId}\``,
    `  - metadataPath: \`${relativeToRoot(metadataPath)}\``,
    `  - itemCount: ${artifact.count}`,
    `  - metadataSource: ${artifact.metadataSource}`
  ]);
}

const command = [args.python || 'python3', generatorScript, metadataPath];
const result = spawnSync(command[0], command.slice(1), {
  cwd: resolveFromRoot('.'),
  encoding: 'utf8',
  stdio: 'inherit'
});

if (result.status !== 0) {
  artifact.status = 'failed';
  artifact.notes.push(`Generator exited with code ${result.status}`);
  clearPublishManifests(batchId);
  writeFinalArtifact(failedPath, artifact);
  const failedTopic = {
    ...runningTopic,
    generation: {
      ...(runningTopic.generation || {}),
      status: 'failed',
      lastError: artifact.notes.at(-1),
      artifactPath: relativeToRoot(failedPath),
      updatedAt: nowIso(),
      completedAt: nowIso()
    }
  };
  writeJson(topicPath, failedTopic);
  if (!args['no-log']) {
    appendProcessLog([
      `- ${nowIso()} Stage 2 生图失败：${topic.title}`,
      `  - batchId: \`${batchId}\``,
      `  - error: ${artifact.notes.at(-1)}`
    ]);
  }
  process.exit(result.status || 1);
}

const missingOutputs = findMissingOutputs(metadata, generatedImageDir);
if (missingOutputs.length) {
  artifact.status = 'failed';
  artifact.notes.push(`Generator finished but missing outputs: ${missingOutputs.join(', ')}`);
  clearPublishManifests(batchId);
  writeFinalArtifact(failedPath, artifact);
  const failedTopic = {
    ...runningTopic,
    generation: {
      ...(runningTopic.generation || {}),
      status: 'failed',
      lastError: artifact.notes.at(-1),
      artifactPath: relativeToRoot(failedPath),
      updatedAt: nowIso(),
      completedAt: nowIso()
    }
  };
  writeJson(topicPath, failedTopic);
  if (!args['no-log']) {
    appendProcessLog([
      `- ${nowIso()} Stage 2 生图失败：${topic.title}`,
      `  - batchId: \`${batchId}\``,
      `  - error: ${artifact.notes.at(-1)}`
    ]);
  }
  fail(artifact.notes.at(-1), 1);
}

artifact.status = 'done';
artifact.completedAt = nowIso();
artifact.publish = {
  status: 'pending',
  github: { status: 'pending' },
  xiaohongshu: { status: 'pending' }
};
artifact.notes.push('Images generated to tmp/<batch-id>. Stage 3 can now import and publish this batch.');
writeFinalArtifact(donePath, artifact);

const publishManifest = {
  batchId,
  topicId: topic.id,
  status: 'pending',
  metadataPath: artifact.metadataPath,
  generatedImageDir: artifact.generatedImageDir,
  sourceGenerationArtifact: relativeToRoot(donePath),
  github: { status: 'pending' },
  xiaohongshu: { status: 'pending' },
  createdAt: nowIso(),
  updatedAt: nowIso(),
  notes: []
};
replaceManifestAcrossStates(path.basename(publishPendingPath), publishPendingPath, [
  workflowDirs.publishPending,
  workflowDirs.publishRunning,
  workflowDirs.publishDone,
  workflowDirs.publishFailed
]);
writeJson(publishPendingPath, publishManifest);

const doneTopic = {
  ...runningTopic,
  generation: {
    ...(runningTopic.generation || {}),
    status: 'done',
    lastError: null,
    artifactPath: relativeToRoot(donePath),
    updatedAt: nowIso(),
    completedAt: artifact.completedAt
  },
  publish: {
    status: 'pending',
    github: { status: 'pending' },
    xiaohongshu: { status: 'pending' }
  }
};
writeJson(topicPath, doneTopic);
if (!args['no-log']) {
  appendProcessLog([
    `- ${nowIso()} Stage 2 生图完成：${topic.title}`,
    `  - batchId: \`${batchId}\``,
    `  - outputDir: \`${artifact.generatedImageDir}\``,
    `  - itemCount: ${artifact.count}`,
    `  - next: Stage 3 publish pending`
  ]);
}

console.log(`Generation complete for ${batchId}`);

function findMissingOutputs(batchMetadata, outputDir) {
  return (batchMetadata.items || [])
    .filter((item) => {
      const target = path.join(outputDir, item.source);
      return !exists(target) || fs.statSync(target).size <= 0;
    })
    .map((item) => item.source);
}

function findUnexpectedOutputs(batchMetadata, outputDir) {
  if (!exists(outputDir)) return [];
  const expected = new Set((batchMetadata.items || []).map((item) => item.source));
  return fs.readdirSync(outputDir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => !expected.has(name));
}

function clearPublishManifests(batchIdValue) {
  const fileName = `${batchIdValue}.json`;
  for (const directory of [
    workflowDirs.publishPending,
    workflowDirs.publishRunning,
    workflowDirs.publishDone,
    workflowDirs.publishFailed
  ]) {
    const filePath = path.join(directory, fileName);
    if (exists(filePath)) {
      fs.rmSync(filePath);
    }
  }
}

function writeFinalArtifact(targetPath, artifactValue) {
  replaceManifestAcrossStates(path.basename(targetPath), targetPath, [
    workflowDirs.generationPending,
    workflowDirs.generationRunning,
    workflowDirs.generationDone,
    workflowDirs.generationFailed
  ]);
  removeFile(targetPath);
  writeJson(targetPath, artifactValue);
}

function printHelp() {
  console.log(`Usage: node scripts/run-generation-worker.mjs [options]

Options:
  --topic <topic-id|path>       Pick one topic manifest from workflow/topics/selected/
  --metadata <path>             Override batch metadata path
  --batch-id <id>               Override batch id
  --generator-script <path>     Override generator driver, default tmp/generate_batch_codex.py
  --python <command>            Python executable, default python3
  --execute                     Materialize metadata if needed and run the generator
  --no-log                      Skip process.md log writes

Stage 2 behavior:
  - If batches/<batch-id>.json already exists, use it.
  - Otherwise, if topic.generation.spec.items exists, bootstrap batches/<batch-id>.json from it.
  - Dry-run is read-only and prints the plan.
`);
}
