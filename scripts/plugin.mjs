#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { formatStatus, loadConfig, PROJECT_CONFIG_FILES } from "./lib/config.mjs";
import { buildHydraContextBlock } from "./lib/context-format.mjs";
import {
  combineRecallErrors,
  DEFAULT_MEMORY_CAPTURE_INSTRUCTIONS,
  HydraClient
} from "./lib/hydra-client.mjs";
import { redactSecrets, wasRedacted } from "./lib/sanitize.mjs";
import { readState, writeState } from "./lib/state.mjs";
import { extractPathsFromToolInput, syncWorkspace } from "./lib/workspace-sync.mjs";

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function inferInlinePluginDataDir() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    return "";
  }

  try {
    const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const pluginName =
      manifest && typeof manifest.name === "string" && manifest.name.trim()
        ? manifest.name.trim()
        : "";
    if (!pluginName) {
      return "";
    }

    const dataDir = path.join(os.homedir(), ".claude", "plugins", "data", `${pluginName}-inline`);
    return (await pathExists(dataDir)) ? dataDir : "";
  } catch {
    return "";
  }
}

async function fallbackDataDir(cwd) {
  if (process.env.CLAUDE_PLUGIN_DATA) {
    return process.env.CLAUDE_PLUGIN_DATA;
  }

  const inlineDataDir = await inferInlinePluginDataDir();
  if (inlineDataDir) {
    return inlineDataDir;
  }

  return path.join(cwd, ".hydradb-plugin-data");
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitHookContext(hookEventName, additionalContext) {
  emitJson({
    hookSpecificOutput: {
      hookEventName,
      additionalContext
    }
  });
}

async function appendDebugLog(dataDir, enabled, event, payload) {
  if (!enabled) {
    return;
  }

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.appendFile(
      path.join(dataDir, "debug.log"),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        payload
      })}\n`,
      "utf8"
    );
  } catch {
    // Best-effort logging only.
  }
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function extractVisibleText(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractVisibleText(entry)).filter(Boolean).join("\n\n").trim();
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string" && (!value.type || value.type === "text")) {
      return value.text.trim();
    }
    if (Array.isArray(value.content)) {
      return extractVisibleText(value.content);
    }
    if (typeof value.content === "string") {
      return value.content.trim();
    }
    if (Array.isArray(value.parts)) {
      return extractVisibleText(value.parts);
    }
    if (value.message) {
      return extractVisibleText(value.message);
    }
    return "";
  }

  return "";
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function getRuntime() {
  const cwd = process.cwd();
  const dataDir = await fallbackDataDir(cwd);
  const configResult = await loadConfig(cwd, dataDir);
  const state = await readState(dataDir);
  const client = configResult.configured
    ? new HydraClient({
        baseUrl: configResult.config.apiBaseUrl,
        apiKey: configResult.config.apiKey,
        tenantId: configResult.config.tenantId,
        subTenantId: configResult.config.subTenantId,
        requestTimeoutMs: configResult.config.requestTimeoutMs,
        writeTimeoutMs: configResult.config.writeTimeoutMs
      })
    : null;

  return {
    cwd,
    dataDir,
    configResult,
    state,
    client
  };
}

function currentSessionState(state, sessionId) {
  const existing = state.sessions[sessionId];
  if (existing && typeof existing === "object") {
    return existing;
  }
  const created = {};
  state.sessions[sessionId] = created;
  return created;
}

function appendTurn(session, turn, limit = 40) {
  const turns = Array.isArray(session.turns) ? session.turns : [];
  turns.push(turn);
  session.turns = turns.slice(-limit);
  session.turnsUpdatedAt = turn.savedAt || new Date().toISOString();
}

function resolveSessionId(args, state) {
  const explicit = args.find((arg) => !arg.startsWith("--")) || "";
  return explicit || state.lastSessionId || "";
}

function renderSessionTranscript(sessionId, session, workspaceName) {
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const header = [
    `# Claude Code session`,
    ``,
    `session_id: ${sessionId}`,
    `workspace: ${workspaceName}`,
    `turn_count: ${turns.length}`
  ];

  const body = turns.flatMap((turn, index) => [
    ``,
    `## Turn ${index + 1}`,
    ``,
    `### User`,
    turn.user,
    ``,
    `### Assistant`,
    turn.assistant
  ]);

  return [...header, ...body].join("\n").trim();
}

function sessionMemorySourceId(sessionId) {
  return `claude-session:${sessionId}:memory`;
}

async function performRecall(client, config, query) {
  const tasks = [];

  if (config.searchMode === "memory" || config.searchMode === "both") {
    tasks.push(
      client.recallMemories(query, {
        maxResults: config.maxMemoryResults,
        mode: config.recallMode,
        graphContext: config.graphContext
      })
    );
  }

  if (config.searchMode === "knowledge" || config.searchMode === "both") {
    tasks.push(
      client.recallKnowledge(query, {
        maxResults: config.maxKnowledgeResults,
        mode: config.recallMode,
        graphContext: config.graphContext
      })
    );
  }

  const settled = await Promise.allSettled(tasks);
  let nextIndex = 0;

  const memory =
    config.searchMode === "memory" || config.searchMode === "both"
      ? settled[nextIndex++]
      : {
          status: "fulfilled",
          value: { chunks: [], queryPaths: [], graphContext: {}, additionalContext: {} }
        };
  const knowledge =
    config.searchMode === "knowledge" || config.searchMode === "both"
      ? settled[nextIndex++]
      : {
          status: "fulfilled",
          value: { chunks: [], queryPaths: [], graphContext: {}, additionalContext: {} }
        };

  return {
    searchMode: config.searchMode,
    memory:
      memory.status === "fulfilled"
        ? memory.value
        : { chunks: [], queryPaths: [], graphContext: {}, additionalContext: {} },
    knowledge:
      knowledge.status === "fulfilled"
        ? knowledge.value
        : { chunks: [], queryPaths: [], graphContext: {}, additionalContext: {} },
    errors: combineRecallErrors([memory, knowledge])
  };
}

async function autoCaptureTurn({ client, configResult, sessionId, userPrompt, assistantText }) {
  await client.addConversationMemory(userPrompt, assistantText, {
    userName: configResult.config.userName || undefined,
    customInstructions:
      configResult.config.memoryCustomInstructions || DEFAULT_MEMORY_CAPTURE_INSTRUCTIONS,
    sourceId: `claude-turn:${sessionId}:${Date.now()}`
  });
}

async function autoUpsertSession({ client, configResult, sessionId, session }) {
  const transcript = renderSessionTranscript(sessionId, session, configResult.workspaceName);
  const transcriptHash = digest(transcript);
  if (session.lastSessionTranscriptHash === transcriptHash) {
    return false;
  }

  await client.addTextMemory(transcript, {
    infer: true,
    isMarkdown: true,
    title: `Claude Code session ${sessionId}`,
    userName: configResult.config.userName || undefined,
    customInstructions:
      configResult.config.memoryCustomInstructions || DEFAULT_MEMORY_CAPTURE_INSTRUCTIONS,
    sourceId: sessionMemorySourceId(sessionId)
  });

  session.lastSessionTranscriptHash = transcriptHash;
  session.lastSessionTranscriptUpdatedAt = new Date().toISOString();
  return true;
}

async function handleSessionStart() {
  const runtime = await getRuntime();
  const { configResult, dataDir } = runtime;
  const lines = ["<hydradb-status>"];

  if (!configResult.configured) {
    lines.push("HydraDB plugin is installed but not configured.");
    lines.push(
      `Set HYDRADB_API_KEY and HYDRADB_TENANT_ID, or add one of ${PROJECT_CONFIG_FILES.join(
        ", "
      )} to the workspace.`
    );
  } else {
    lines.push(`HydraDB is active for workspace "${configResult.workspaceName}".`);
    lines.push(`sub-tenant: ${configResult.config.subTenantId}`);
    lines.push(
      `auto-recall=${configResult.config.autoRecall} auto-ingest=${configResult.config.autoIngest}`
    );
    lines.push(
      `capture-mode=${configResult.config.captureMode} search-mode=${configResult.config.searchMode} ingestion-mode=${configResult.config.ingestionMode}`
    );
    lines.push("Relevant HydraDB context will be recalled automatically on each user prompt.");
  }

  if (configResult.errors.length) {
    lines.push(`config-notes: ${configResult.errors.join(" | ")}`);
  }

  lines.push("</hydradb-status>");
  const additionalContext = lines.join("\n");
  await appendDebugLog(dataDir, configResult.config.debug, "session-start", {
    configured: configResult.configured,
    emitted: true,
    errorCount: configResult.errors.length
  });
  emitHookContext("SessionStart", additionalContext);
}

async function handleSessionSyncHook() {
  const runtime = await getRuntime();
  const { client, configResult, state, dataDir } = runtime;

  if (!client || !configResult.config.autoIngest) {
    return;
  }

  await syncWorkspace({
    client,
    config: configResult.config,
    projectRoot: configResult.projectRoot,
    workspaceName: configResult.workspaceName,
    state
  });
  await writeState(dataDir, state);
}

async function handleUserPromptSubmit() {
  const input = await readStdinJson();
  const runtime = await getRuntime();
  const { client, configResult, state, dataDir } = runtime;
  const session = currentSessionState(state, input.session_id || "unknown");
  const rawPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const prompt = redactSecrets(rawPrompt).trim();
  const now = new Date().toISOString();
  const isSlashCommand = rawPrompt.startsWith("/");
  const hasIgnoreMarker = Boolean(
    configResult.config.ignoreMarker && rawPrompt.includes(configResult.config.ignoreMarker)
  );
  const skipCapture = !rawPrompt || isSlashCommand || hasIgnoreMarker || !prompt;
  const skipReason = !rawPrompt
    ? "empty-prompt"
    : isSlashCommand
      ? "slash-command"
      : hasIgnoreMarker
        ? "ignore-marker"
        : !prompt
          ? "empty-after-redaction"
          : "";

  session.pendingPrompt = skipCapture ? "" : prompt;
  session.pendingPromptUpdatedAt = now;
  session.updatedAt = now;
  state.lastSessionId = input.session_id || "unknown";
  await writeState(dataDir, state);

  if (isSlashCommand) {
    await appendDebugLog(dataDir, configResult.config.debug, "user-prompt-submit", {
      sessionId: input.session_id || "unknown",
      skipped: true,
      reason: skipReason,
      preservedLastRecall: Boolean(state.lastRecall)
    });
    return;
  }

  if (!client || !configResult.config.autoRecall) {
    state.lastRecall = {
      sessionId: input.session_id || "unknown",
      query: prompt || rawPrompt,
      searchMode: configResult.config.searchMode,
      skipped: true,
      reason: client ? "auto-recall-disabled" : "not-configured",
      updatedAt: now
    };
    await writeState(dataDir, state);
    await appendDebugLog(dataDir, configResult.config.debug, "user-prompt-submit", {
      sessionId: input.session_id || "unknown",
      skipped: true,
      reason: client ? "auto-recall-disabled" : "not-configured"
    });
    return;
  }

  if (!rawPrompt || !prompt) {
    state.lastRecall = {
      sessionId: input.session_id || "unknown",
      query: prompt || rawPrompt,
      searchMode: configResult.config.searchMode,
      skipped: true,
      reason: skipReason,
      updatedAt: now
    };
    await writeState(dataDir, state);
    await appendDebugLog(dataDir, configResult.config.debug, "user-prompt-submit", {
      sessionId: input.session_id || "unknown",
      skipped: true,
      reason: skipReason
    });
    return;
  }

  const recall = await performRecall(client, configResult.config, prompt);

  const additionalContext = buildHydraContextBlock({
    query: prompt,
    memory: recall.memory,
    knowledge: recall.knowledge,
    errors: recall.errors,
    maxContextChars: configResult.config.maxContextChars
  });

  state.lastRecall = {
    sessionId: input.session_id || "unknown",
    query: prompt,
    searchMode: recall.searchMode,
    skipped: false,
    emitted: Boolean(additionalContext),
    memoryCount: recall.memory.chunks.length,
    knowledgeCount: recall.knowledge.chunks.length,
    memoryGraphPathCount:
      recall.memory.graphContext?.queryPathsDetailed?.length || recall.memory.queryPaths.length,
    knowledgeGraphPathCount:
      recall.knowledge.graphContext?.queryPathsDetailed?.length || recall.knowledge.queryPaths.length,
    errors: recall.errors,
    additionalContext,
    updatedAt: now
  };
  if (configResult.config.debug) {
    state.lastRecall.memory = recall.memory;
    state.lastRecall.knowledge = recall.knowledge;
  }
  await writeState(dataDir, state);
  await appendDebugLog(dataDir, configResult.config.debug, "user-prompt-submit", {
    sessionId: input.session_id || "unknown",
    query: prompt,
    emitted: Boolean(additionalContext),
    memoryCount: recall.memory.chunks.length,
    knowledgeCount: recall.knowledge.chunks.length,
    errorCount: recall.errors.length
  });

  if (additionalContext) {
    emitHookContext("UserPromptSubmit", additionalContext);
  }
}

async function handleStop() {
  const input = await readStdinJson();
  const runtime = await getRuntime();
  const { client, configResult, state, dataDir } = runtime;

  if (input.stop_hook_active) {
    return;
  }

  const sessionId = input.session_id || "unknown";
  const session = currentSessionState(state, sessionId);
  const userPrompt = typeof session.pendingPrompt === "string" ? session.pendingPrompt.trim() : "";
  const assistantText = redactSecrets(extractVisibleText(input.last_assistant_message)).trim();
  const now = new Date().toISOString();
  const hasIgnoreMarker = Boolean(
    configResult.config.ignoreMarker &&
      (userPrompt.includes(configResult.config.ignoreMarker) ||
        assistantText.includes(configResult.config.ignoreMarker))
  );

  session.pendingPrompt = "";
  session.pendingPromptUpdatedAt = now;
  session.updatedAt = now;
  state.lastSessionId = sessionId;

  if (!userPrompt || !assistantText) {
    await writeState(dataDir, state);
    return;
  }

  const combined = `${userPrompt}\n---\n${assistantText}`;
  const captureHash = digest(combined);
  if (hasIgnoreMarker) {
    await writeState(dataDir, state);
    return;
  }

  appendTurn(session, {
    user: userPrompt,
    assistant: assistantText,
    savedAt: now
  });

  const shouldSkipTurnCapture = userPrompt.length < 24 && assistantText.length < 24;
  if (!client || configResult.config.captureMode === "off") {
    await writeState(dataDir, state);
    return;
  }

  if (configResult.config.captureMode === "turn" || configResult.config.captureMode === "both") {
    if (!shouldSkipTurnCapture && session.lastCaptureHash !== captureHash) {
      await autoCaptureTurn({ client, configResult, sessionId, userPrompt, assistantText });
      session.lastCaptureHash = captureHash;
      session.lastCaptureUpdatedAt = new Date().toISOString();
    }
  }

  if (
    configResult.config.captureMode === "session-upsert" ||
    configResult.config.captureMode === "both"
  ) {
    await autoUpsertSession({ client, configResult, sessionId, session });
  }

  await writeState(dataDir, state);
}

async function handlePostToolUse() {
  const input = await readStdinJson();
  const runtime = await getRuntime();
  const { client, configResult, state, dataDir } = runtime;

  if (!client || !configResult.config.autoIngest) {
    return;
  }

  const paths = extractPathsFromToolInput(input.tool_input, input.cwd || runtime.cwd);
  if (!paths.length) {
    return;
  }

  await syncWorkspace({
    client,
    config: configResult.config,
    projectRoot: configResult.projectRoot,
    workspaceName: configResult.workspaceName,
    state,
    candidatePaths: paths
  });

  await writeState(dataDir, state);
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/plugin.mjs session-start",
      "  node scripts/plugin.mjs session-sync-hook",
      "  node scripts/plugin.mjs user-prompt-submit",
      "  node scripts/plugin.mjs post-tool-use",
      "  node scripts/plugin.mjs stop",
      "  node scripts/plugin.mjs query [--json] <query>",
      "  node scripts/plugin.mjs ingest [--json] [--force]",
      "  node scripts/plugin.mjs doctor [--json]",
      "  node scripts/plugin.mjs last-recall [--json]",
      "  node scripts/plugin.mjs remember <text>",
      "  node scripts/plugin.mjs save-session [--json] [session-id]",
      "",
      "  Deprecated aliases (still work, one warning): search|recall -> query,",
      "  status -> doctor, remember|save-session|sync-workspace|reindex -> ingest"
    ].join("\n")
  );
}

function formatStatusText(summary) {
  return [
    `configured: ${summary.configured}`,
    `workspace: ${summary.workspaceName}`,
    `projectRoot: ${summary.projectRoot}`,
    `dataDir: ${summary.dataDir}`,
    `configSources: ${summary.configSources.length ? summary.configSources.join(", ") : "(none)"}`,
    `dataConfigPath: ${summary.dataConfigPath}`,
    `apiBaseUrl: ${summary.resolvedConfig.apiBaseUrl}`,
    `tenantId: ${summary.resolvedConfig.tenantId || "(missing)"}`,
    `subTenantId: ${summary.resolvedConfig.subTenantId}`,
    `autoRecall: ${summary.resolvedConfig.autoRecall}`,
    `autoIngest: ${summary.resolvedConfig.autoIngest}`,
    `captureMode: ${summary.resolvedConfig.captureMode}`,
    `searchMode: ${summary.resolvedConfig.searchMode}`,
    `ingestionMode: ${summary.resolvedConfig.ingestionMode}`,
    `recallMode: ${summary.resolvedConfig.recallMode}`,
    `graphContext: ${summary.resolvedConfig.graphContext}`,
    `maxContextChars: ${summary.resolvedConfig.maxContextChars}`,
    `requestTimeoutMs: ${summary.resolvedConfig.requestTimeoutMs}`,
    `writeTimeoutMs: ${summary.resolvedConfig.writeTimeoutMs}`,
    `maxMemoryCharsPerChunk: ${summary.resolvedConfig.maxMemoryCharsPerChunk}`,
    `maxMemoryChunksPerFile: ${summary.resolvedConfig.maxMemoryChunksPerFile}`,
    `ignoreMarker: ${summary.resolvedConfig.ignoreMarker}`,
    `trackedFiles: ${summary.stateSummary.trackedFiles}`,
    `trackedSessions: ${summary.stateSummary.trackedSessions}`,
    summary.errors.length ? `errors: ${summary.errors.join(" | ")}` : "errors: none"
  ].join("\n");
}

async function handleStatus(args) {
  const runtime = await getRuntime();
  const summary = formatStatus(runtime.configResult, runtime.state);
  if (args.includes("--json")) {
    emitJson(summary);
    return;
  }
  process.stdout.write(`${formatStatusText(summary)}\n`);
}

function formatLastRecallText(lastRecall) {
  const lines = [
    `sessionId: ${lastRecall.sessionId || "unknown"}`,
    `updatedAt: ${lastRecall.updatedAt || "(unknown)"}`,
    `searchMode: ${lastRecall.searchMode || "(unknown)"}`,
    `skipped: ${Boolean(lastRecall.skipped)}`
  ];

  if (lastRecall.skipped) {
    lines.push(`reason: ${lastRecall.reason || "unknown"}`);
    return lines.join("\n");
  }

  lines.push(`emitted: ${Boolean(lastRecall.emitted)}`);
  lines.push(`memoryCount: ${lastRecall.memoryCount ?? 0}`);
  lines.push(`knowledgeCount: ${lastRecall.knowledgeCount ?? 0}`);
  lines.push(
    `memoryGraphPathCount: ${lastRecall.memoryGraphPathCount ?? 0}`
  );
  lines.push(
    `knowledgeGraphPathCount: ${lastRecall.knowledgeGraphPathCount ?? 0}`
  );
  lines.push(lastRecall.errors?.length ? `errors: ${lastRecall.errors.join(" | ")}` : "errors: none");
  return lines.join("\n");
}

async function handleLastRecall(args) {
  const jsonMode = args.includes("--json");
  const runtime = await getRuntime();
  const lastRecall = runtime.state.lastRecall;

  if (!lastRecall) {
    throw new Error("no auto-recall payload has been recorded yet");
  }

  if (jsonMode) {
    emitJson(lastRecall);
    return;
  }

  process.stdout.write(`${formatLastRecallText(lastRecall)}\n`);
}

async function handleRemember(args) {
  const text = args.join(" ").trim();
  if (!text) {
    throw new Error("remember requires text");
  }

  const runtime = await getRuntime();
  if (!runtime.client) {
    throw new Error("HydraDB is not configured");
  }

  const sanitizedText = redactSecrets(text).trim();
  if (!sanitizedText) {
    throw new Error("remember content was empty after redaction");
  }

  await runtime.client.addTextMemory(sanitizedText, {
    infer: true,
    isMarkdown: /[#*_`>-]/.test(sanitizedText),
    title: "Claude Code manual memory",
    userName: runtime.configResult.config.userName || undefined,
    customInstructions:
      runtime.configResult.config.memoryCustomInstructions ||
      DEFAULT_MEMORY_CAPTURE_INSTRUCTIONS,
    sourceId: `manual-memory:${Date.now()}`
  });

  process.stdout.write(
    wasRedacted(text, sanitizedText)
      ? "Stored memory in HydraDB after redacting sensitive tokens.\n"
      : "Stored memory in HydraDB.\n"
  );
}

async function handleSaveSession(args) {
  const jsonMode = args.includes("--json");
  const runtime = await getRuntime();
  if (!runtime.client) {
    throw new Error("HydraDB is not configured");
  }

  const sessionId = resolveSessionId(args.filter((arg) => arg !== "--json"), runtime.state);
  if (!sessionId) {
    throw new Error("save-session requires a known session id");
  }

  const session = runtime.state.sessions[sessionId];
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  if (!turns.length) {
    throw new Error(`no stored turns found for session ${sessionId}`);
  }

  const transcript = renderSessionTranscript(
    sessionId,
    session,
    runtime.configResult.workspaceName
  );

  await runtime.client.addTextMemory(transcript, {
    infer: true,
    isMarkdown: true,
    title: `Claude Code session ${sessionId}`,
    userName: runtime.configResult.config.userName || undefined,
    customInstructions:
      runtime.configResult.config.memoryCustomInstructions ||
      DEFAULT_MEMORY_CAPTURE_INSTRUCTIONS,
    sourceId: sessionMemorySourceId(sessionId)
  });

  const payload = {
    sessionId,
    turnCount: turns.length,
    sourceId: sessionMemorySourceId(sessionId)
  };

  if (jsonMode) {
    emitJson(payload);
    return;
  }

  process.stdout.write(
    `Stored session ${sessionId} in HydraDB as one upserted memory with ${turns.length} turns.\n`
  );
}

function renderRecallText(result) {
  const lines = [];

  if (result.searchMode === "memory" || result.searchMode === "both") {
    lines.push("Memories:");
    if (result.memory.chunks.length) {
      for (const chunk of result.memory.chunks) {
        lines.push(`- ${chunk.title || "Memory"}: ${chunk.text}`);
      }
    } else {
      lines.push("- none");
    }
  }

  if (result.searchMode === "both") {
    lines.push("");
  }

  if (result.searchMode === "knowledge" || result.searchMode === "both") {
    lines.push("Knowledge:");
    if (result.knowledge.chunks.length) {
      for (const chunk of result.knowledge.chunks) {
        lines.push(`- ${chunk.title || "Knowledge"}: ${chunk.text}`);
      }
    } else {
      lines.push("- none");
    }
  }

  if (result.errors.length) {
    lines.push("");
    lines.push(`errors: ${result.errors.join(" | ")}`);
  }

  return lines.join("\n");
}

async function handleRecall(args, commandName = "recall") {
  const jsonMode = args.includes("--json");
  const rawQuery = args.filter((arg) => arg !== "--json").join(" ").trim();
  const query = redactSecrets(rawQuery).trim();
  if (!query) {
    throw new Error(`${commandName} requires a query`);
  }

  const runtime = await getRuntime();
  if (!runtime.client) {
    throw new Error("HydraDB is not configured");
  }

  const payload = {
    query,
    ...(await performRecall(runtime.client, runtime.configResult.config, query))
  };

  if (jsonMode) {
    emitJson(payload);
    return;
  }

  process.stdout.write(`${renderRecallText(payload)}\n`);
}

async function handleSyncWorkspace(args) {
  const jsonMode = args.includes("--json");
  const force = args.includes("--force");
  const runtime = await getRuntime();

  if (!runtime.client) {
    throw new Error("HydraDB is not configured");
  }

  const summary = await syncWorkspace({
    client: runtime.client,
    config: runtime.configResult.config,
    projectRoot: runtime.configResult.projectRoot,
    workspaceName: runtime.configResult.workspaceName,
    state: runtime.state,
    force
  });
  await writeState(runtime.dataDir, runtime.state);

  if (jsonMode) {
    emitJson(summary);
    return;
  }

  process.stdout.write(
    [
      `scanned: ${summary.scanned}`,
      `synced: ${summary.synced}`,
      `skipped: ${summary.skipped}`,
      `memory: ${summary.syncedAs.memory}`,
      `knowledge: ${summary.syncedAs.knowledge}`,
      summary.errors.length ? `errors: ${summary.errors.join(" | ")}` : "errors: none"
    ].join("\n") + "\n"
  );
}

async function handleSearch(args) {
  await handleRecall(args, "search");
}

// User-facing command names aligned to the shared contract (CONTRACT §3). Every
// prior name keeps working as a deprecated alias that emits exactly one stderr
// warning naming its canonical replacement. The warning goes to stderr so it
// never corrupts the `--json` stdout that marketplace skill files parse.
const DEPRECATED_COMMANDS = {
  search: "query",
  recall: "query",
  status: "doctor",
  remember: "ingest",
  "save-session": "ingest",
  "sync-workspace": "ingest",
  reindex: "ingest"
};

function warnDeprecatedCommand(name) {
  process.stderr.write(
    `[hydradb] "${name}" is deprecated; use "${DEPRECATED_COMMANDS[name]}" instead.\n`
  );
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (command && Object.prototype.hasOwnProperty.call(DEPRECATED_COMMANDS, command)) {
    warnDeprecatedCommand(command);
  }

  switch (command) {
    case "session-start":
      await handleSessionStart();
      return;
    case "session-sync-hook":
      await handleSessionSyncHook();
      return;
    case "user-prompt-submit":
      await handleUserPromptSubmit();
      return;
    case "post-tool-use":
      await handlePostToolUse();
      return;
    case "stop":
      await handleStop();
      return;
    // Canonical user-facing commands.
    case "query":
      await handleRecall(args, "query");
      return;
    case "ingest":
      await handleSyncWorkspace(args);
      return;
    case "doctor":
      await handleStatus(args);
      return;
    case "last-recall":
      await handleLastRecall(args);
      return;
    // Deprecated aliases — still fully functional (warned above).
    case "status":
      await handleStatus(args);
      return;
    case "remember":
      await handleRemember(args);
      return;
    case "save-session":
      await handleSaveSession(args);
      return;
    case "search":
      await handleSearch(args);
      return;
    case "recall":
      await handleRecall(args, "recall");
      return;
    case "sync-workspace":
    case "reindex":
      await handleSyncWorkspace(args);
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
