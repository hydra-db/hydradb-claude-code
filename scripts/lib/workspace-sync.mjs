import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_WORKSPACE_MEMORY_INSTRUCTIONS
} from "./hydra-client.mjs";
import { redactSecrets } from "./sanitize.mjs";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "target",
  "vendor"
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function globToRegExp(glob) {
  const escaped = toPosix(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "§§DOUBLE_STAR_DIR§§")
    .replace(/\*\*/g, "§§DOUBLE_STAR§§")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");

  return new RegExp(
    `^${escaped
      .replace(/§§DOUBLE_STAR_DIR§§/g, "(?:.*/)?")
      .replace(/§§DOUBLE_STAR§§/g, ".*")}$`
  );
}

function matchAny(relPath, patterns) {
  return patterns.some((pattern) => globToRegExp(toPosix(pattern)).test(relPath));
}

function likelySensitive(relPath) {
  const lowered = relPath.toLowerCase();
  return (
    lowered.includes("/secrets/") ||
    lowered.includes("/private/") ||
    lowered.endsWith(".pem") ||
    lowered.endsWith(".key") ||
    lowered.endsWith(".crt") ||
    lowered.endsWith(".cer") ||
    lowered.endsWith(".p12") ||
    lowered.endsWith(".pfx") ||
    lowered.includes(".env")
  );
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
    if (byte < 9 || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious > sample.length * 0.15;
}

async function walk(rootDir, collector, prefix = "") {
  const entries = await fs.readdir(path.join(rootDir, prefix), { withFileTypes: true });

  for (const entry of entries) {
    const relPath = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await walk(rootDir, collector, relPath);
      continue;
    }
    if (entry.isFile()) {
      collector.push(relPath);
    }
  }
}

function fileSourceId(projectRoot, relPath) {
  return `claude-file:${crypto
    .createHash("sha1")
    .update(`${projectRoot}:${relPath}`)
    .digest("hex")}`;
}

function normalizeText(value) {
  return value.replace(/\r\n/g, "\n").trim();
}

function isMarkdownPath(relPath) {
  return [".md", ".mdx"].includes(path.extname(relPath).toLowerCase());
}

function splitIntoChunks(text, maxChars) {
  if (!text) {
    return [];
  }

  if (text.length <= maxChars) {
    return [text];
  }

  const blocks = text.split(/\n{2,}/g);
  const chunks = [];
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current.trim());
      current = "";
    }

    if (block.length <= maxChars) {
      current = block;
      continue;
    }

    for (let offset = 0; offset < block.length; offset += maxChars) {
      const slice = block.slice(offset, offset + maxChars).trim();
      if (slice) {
        chunks.push(slice);
      }
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

function chooseIngestionTarget(config, chunkCount) {
  if (config.ingestionMode === "memory" || config.ingestionMode === "unified") {
    // `unified` is the memory-shaped path; on a unified database the client
    // sends it as items[] regardless of which target is chosen here.
    return "memory";
  }

  if (config.ingestionMode === "knowledge") {
    return "knowledge";
  }

  return chunkCount <= config.maxMemoryChunksPerFile ? "memory" : "knowledge";
}

function buildMemoryItems(file, projectRoot, config) {
  const chunks = splitIntoChunks(file.content, config.maxMemoryCharsPerChunk);
  const baseSourceId = fileSourceId(projectRoot, file.relPath);
  const customInstructions =
    config.workspaceMemoryCustomInstructions || DEFAULT_WORKSPACE_MEMORY_INSTRUCTIONS;

  return chunks.map((chunk, index) => ({
    text: chunk,
    infer: true,
    is_markdown: file.isMarkdown,
    title:
      chunks.length === 1
        ? file.relPath
        : `${file.relPath} (part ${index + 1}/${chunks.length})`,
    user_name: config.userName || undefined,
    custom_instructions: customInstructions,
    source_id:
      chunks.length === 1 ? baseSourceId : `${baseSourceId}:chunk:${index + 1}`
  }));
}

function memorySourceIds(projectRoot, relPath, chunkCount) {
  const baseSourceId = fileSourceId(projectRoot, relPath);
  if (chunkCount <= 1) {
    return [baseSourceId];
  }

  return Array.from({ length: chunkCount }, (_, index) => `${baseSourceId}:chunk:${index + 1}`);
}

function estimateMemoryItemBytes(item) {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

function batchMemoryItems(items, maxRequestBytes) {
  if (!items.length) {
    return [];
  }

  const batches = [];
  let current = [];
  let currentBytes = 256;

  for (const item of items) {
    const itemBytes = estimateMemoryItemBytes(item) + 2;
    const batchLimit = Math.max(maxRequestBytes, itemBytes + 1024);

    if (!current.length) {
      current = [item];
      currentBytes = 256 + itemBytes;
      continue;
    }

    if (currentBytes + itemBytes > batchLimit) {
      batches.push(current);
      current = [item];
      currentBytes = 256 + itemBytes;
      continue;
    }

    current.push(item);
    currentBytes += itemBytes;
  }

  if (current.length) {
    batches.push(current);
  }

  return batches;
}

function buildKnowledgeItem(file, projectRoot, workspaceName) {
  return {
    id: fileSourceId(projectRoot, file.relPath),
    tenant_id: file.tenantId,
    sub_tenant_id: file.subTenantId,
    title: file.relPath,
    source: "claude-code-plugin",
    description: `Workspace context synced from ${workspaceName}`,
    url: `hydradb://workspace/${encodeURIComponent(workspaceName)}/${file.relPath}`,
    timestamp: new Date(file.stats.mtimeMs).toISOString(),
    content: {
      text: file.content
    },
    metadata: {
      workspace: workspaceName,
      relative_path: file.relPath,
      extension: path.extname(file.relPath) || "none"
    },
    additional_metadata: {
      size_bytes: file.stats.size,
      plugin: "hydradb"
    }
  };
}

export function extractPathsFromToolInput(toolInput, cwd) {
  if (!toolInput || typeof toolInput !== "object") {
    return [];
  }

  const candidates = [];
  for (const key of ["file_path", "path", "notebook_path", "target_file"]) {
    if (typeof toolInput[key] === "string" && toolInput[key]) {
      candidates.push(toolInput[key]);
    }
  }

  if (Array.isArray(toolInput.paths)) {
    candidates.push(...toolInput.paths.filter((entry) => typeof entry === "string"));
  }

  return [...new Set(candidates)]
    .map((entry) => (path.isAbsolute(entry) ? entry : path.join(cwd, entry)))
    .filter(Boolean);
}

async function candidateSummary(filePath, projectRoot, config) {
  const stats = await fs.stat(filePath);
  const relPath = toPosix(path.relative(projectRoot, filePath));

  if (!relPath || relPath.startsWith("../")) {
    return { eligible: false, relPath, reason: "outside-project-root" };
  }

  if (stats.size > config.maxFileSizeBytes) {
    return { eligible: false, relPath, reason: "too-large" };
  }

  if (likelySensitive(relPath)) {
    return { eligible: false, relPath, reason: "sensitive-path" };
  }

  if (!matchAny(relPath, config.includeGlobs)) {
    return { eligible: false, relPath, reason: "not-included" };
  }

  if (matchAny(relPath, config.excludeGlobs)) {
    return { eligible: false, relPath, reason: "excluded" };
  }

  const buffer = await fs.readFile(filePath);
  if (looksBinary(buffer)) {
    return { eligible: false, relPath, reason: "binary" };
  }

  const content = normalizeText(buffer.toString("utf8"));
  if (!content) {
    return { eligible: false, relPath, reason: "empty" };
  }

  if (config.ignoreMarker && content.includes(config.ignoreMarker)) {
    return { eligible: false, relPath, reason: "ignore-marker" };
  }

  const redactedContent = redactSecrets(content).trim();
  if (!redactedContent) {
    return { eligible: false, relPath, reason: "empty-after-redaction" };
  }

  const digest = crypto.createHash("sha256").update(content).digest("hex");
  return {
    eligible: true,
    filePath,
    relPath,
    content: redactedContent,
    digest,
    stats,
    isMarkdown: isMarkdownPath(relPath)
  };
}

async function gatherFiles(projectRoot) {
  const relPaths = [];
  await walk(projectRoot, relPaths);
  return relPaths.map((relPath) => path.join(projectRoot, relPath));
}

// PRO-2193: the largest file piece sent to a unified database. The server
// refuses an item over 1 MiB of text (and with it the whole request); 250k
// characters stays under that even when every character is four UTF-8 bytes.
export const UNIFIED_MAX_CHUNK_CHARS = 250_000;

export async function syncWorkspace({
  client,
  config: baseConfig,
  projectRoot,
  workspaceName,
  state,
  candidatePaths = null,
  force = false
}) {
  // On a unified database, files are cut to pieces the server accepts, and a
  // file too large to go whole takes the chunked (memory-shaped) path. Both
  // lanes land in the same one corpus there. A split database keeps its
  // configured sizes exactly.
  // Sync runs in the background (120s), so a probe that timed out is asked
  // again patiently before files are cut: a unified database must never be
  // synced with split-sized pieces the server refuses.
  const unified =
    typeof client?.resolveLayoutPatiently === "function"
      ? (await client.resolveLayoutPatiently()) === "unified"
      : typeof client?.isUnified === "function"
        ? await client.isUnified()
        : false;
  const config = unified
    ? { ...baseConfig, maxMemoryCharsPerChunk: Math.min(baseConfig.maxMemoryCharsPerChunk, UNIFIED_MAX_CHUNK_CHARS) }
    : baseConfig;
  const filesToCheck = candidatePaths ?? (await gatherFiles(projectRoot));
  const summary = {
    scanned: 0,
    synced: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
    syncedFiles: [],
    deletedFiles: [],
    skippedFiles: [],
    syncedAs: {
      memory: 0,
      knowledge: 0
    }
  };

  const staged = [];
  const scannedPaths = new Set();
  const ineligibleByPath = new Map();
  const stagedByPath = new Map();

  for (const filePath of filesToCheck) {
    summary.scanned += 1;
    scannedPaths.add(filePath);

    try {
      const details = await candidateSummary(filePath, projectRoot, config);
      if (!details.eligible) {
        summary.skipped += 1;
        if (details.relPath) {
          summary.skippedFiles.push({ path: details.relPath, reason: details.reason });
        }
        ineligibleByPath.set(filePath, details);
        continue;
      }

      const previous = state.files[filePath];
      if (!force && previous && previous.digest === details.digest) {
        summary.skipped += 1;
        summary.skippedFiles.push({ path: details.relPath, reason: "unchanged" });
        continue;
      }

      const chunkCount = splitIntoChunks(details.content, config.maxMemoryCharsPerChunk).length;
      let target = chooseIngestionTarget(config, chunkCount);
      if (unified && target === "knowledge" && details.content.length > config.maxMemoryCharsPerChunk) {
        target = "memory";
      }

      staged.push({
        ...details,
        chunkCount,
        target,
        tenantId: client.tenantId,
        subTenantId: client.subTenantId
      });
      stagedByPath.set(filePath, {
        relPath: details.relPath,
        target,
        chunkCount
      });
    } catch (error) {
      summary.errors.push(`${filePath}: ${error.message}`);
    }

    if (staged.length >= config.maxFilesPerSync) {
      break;
    }
  }

  const memoryFiles = staged.filter((file) => file.target === "memory");
  const knowledgeFiles = staged.filter((file) => file.target === "knowledge");

  // A batch that fails is reported and its files are left unsynced (so the
  // next sync retries exactly them); the other batches still go. One refused
  // file used to abort the whole sync with nothing recorded.
  const failedPaths = new Set();
  const fileOfSourceId = new Map();
  const memoryItems = memoryFiles.flatMap((file) => {
    const items = buildMemoryItems(file, projectRoot, config);
    for (const item of items) {
      fileOfSourceId.set(item.source_id, file.filePath);
    }
    return items;
  });
  for (const batch of batchMemoryItems(memoryItems, config.maxFileSizeBytes)) {
    try {
      await client.addMemories(batch, {
        upsert: true,
        timeoutMs: config.writeTimeoutMs
      });
    } catch (error) {
      summary.errors.push(`memory ingest failed: ${error.message}`);
      for (const item of batch) {
        failedPaths.add(fileOfSourceId.get(item.source_id));
      }
    }
  }

  for (let index = 0; index < knowledgeFiles.length; index += 5) {
    const files = knowledgeFiles.slice(index, index + 5);
    const batch = files.map((file) => buildKnowledgeItem(file, projectRoot, workspaceName));
    try {
      await client.uploadKnowledge(batch);
    } catch (error) {
      summary.errors.push(`knowledge ingest failed: ${error.message}`);
      for (const file of files) {
        failedPaths.add(file.filePath);
      }
    }
  }

  if (candidatePaths == null) {
    const memoryIdsToDelete = new Set();
    const knowledgeIdsToDelete = [];
    const deletedMemoryPaths = [];
    const deletedKnowledgePaths = [];

    for (const [filePath, previous] of Object.entries(state.files || {})) {
      // A file whose new version failed to upload keeps its old context until
      // the retry succeeds; deleting its stale ids now would leave nothing.
      if (failedPaths.has(filePath)) {
        continue;
      }
      const wasDeleted = !scannedPaths.has(filePath);
      const ineligible = ineligibleByPath.get(filePath);
      const stagedEntry = stagedByPath.get(filePath);

      if (previous?.target === "memory") {
        const movedAwayFromMemory = stagedEntry && stagedEntry.target !== "memory";
        const isUnchangedMemory =
          !wasDeleted && !ineligible && (!stagedEntry || stagedEntry.target === "memory");
        if (isUnchangedMemory && !stagedEntry) {
          continue;
        }

        const currentMemoryIds =
          stagedEntry?.target === "memory"
            ? new Set(memorySourceIds(projectRoot, previous.relPath, stagedEntry.chunkCount))
            : new Set();
        const previousMemoryIds = memorySourceIds(
          projectRoot,
          previous.relPath,
          previous.chunkCount || 1
        );

        const shouldDeleteWholeMemory =
          wasDeleted || ineligible || movedAwayFromMemory;

        const staleMemoryIds = shouldDeleteWholeMemory
          ? previousMemoryIds
          : previousMemoryIds.filter((id) => !currentMemoryIds.has(id));

        for (const id of staleMemoryIds) {
          memoryIdsToDelete.add(id);
        }

        if (shouldDeleteWholeMemory && staleMemoryIds.length) {
          deletedMemoryPaths.push({
            filePath,
            relPath: previous.relPath,
            ids: staleMemoryIds,
            reason: wasDeleted
              ? "deleted"
              : movedAwayFromMemory
                ? "ingestion-target-changed"
                : ineligible.reason
          });
        }
      }

      if (previous?.target === "knowledge") {
        const movedAwayFromKnowledge = stagedEntry && stagedEntry.target !== "knowledge";

        if (!wasDeleted && !ineligible && !movedAwayFromKnowledge) {
          continue;
        }

        const knowledgeId = fileSourceId(projectRoot, previous.relPath);
        knowledgeIdsToDelete.push(knowledgeId);
        deletedKnowledgePaths.push({
          filePath,
          relPath: previous.relPath,
          id: knowledgeId,
          reason: wasDeleted
            ? "deleted"
            : movedAwayFromKnowledge
              ? "ingestion-target-changed"
              : ineligible.reason
        });
      }
    }

    // Reconcile deletions PER ID. The client returns which ids the server
    // confirmed deleted; drop tracked state ONLY for a file whose every id was
    // confirmed, and RETAIN (and surface) any file with an unconfirmed id so the
    // next sync retries it. A partial, no-op, or failed delete therefore never
    // drops tracking for context still stored remotely (the second silent bug).
    if (memoryIdsToDelete.size) {
      let deletedSet = new Set();
      try {
        const result = await client.deleteMemories([...memoryIdsToDelete], {
          timeoutMs: config.writeTimeoutMs
        });
        deletedSet = new Set(result?.deletedIds || []);
      } catch (error) {
        summary.errors.push(`memory delete failed: ${error.message}`);
      }

      for (const entry of deletedMemoryPaths) {
        const confirmed = entry.ids.length > 0 && entry.ids.every((id) => deletedSet.has(id));
        if (confirmed) {
          delete state.files[entry.filePath];
          summary.deleted += 1;
          summary.deletedFiles.push({ path: entry.relPath, filePath: entry.filePath, target: "memory", reason: entry.reason });
        } else {
          summary.errors.push(`memory delete incomplete for ${entry.relPath}; retained for retry`);
        }
      }
    }

    if (knowledgeIdsToDelete.length) {
      let deletedSet = new Set();
      try {
        const result = await client.deleteKnowledge(knowledgeIdsToDelete, {
          timeoutMs: config.writeTimeoutMs
        });
        deletedSet = new Set(result?.deletedIds || []);
      } catch (error) {
        summary.errors.push(`knowledge delete failed: ${error.message}`);
      }

      for (const entry of deletedKnowledgePaths) {
        if (deletedSet.has(entry.id)) {
          delete state.files[entry.filePath];
          summary.deleted += 1;
          summary.deletedFiles.push({ path: entry.relPath, filePath: entry.filePath, target: "knowledge", reason: entry.reason });
        } else {
          summary.errors.push(`knowledge delete incomplete for ${entry.relPath}; retained for retry`);
        }
      }
    }
  }

  for (const file of staged) {
    if (failedPaths.has(file.filePath)) {
      summary.failedFiles = [...(summary.failedFiles || []), { path: file.relPath, target: file.target }];
      continue;
    }
    state.files[file.filePath] = {
      digest: file.digest,
      relPath: file.relPath,
      syncedAt: new Date().toISOString(),
      target: file.target,
      chunkCount: file.chunkCount
    };
    summary.synced += 1;
    summary.syncedFiles.push({ path: file.relPath, target: file.target });
    summary.syncedAs[file.target] += 1;
  }

  return summary;
}
