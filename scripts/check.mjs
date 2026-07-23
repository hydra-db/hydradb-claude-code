#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runConformance } from "../conformance/runner.mjs";
import { runGoldenTests, runHttpTests } from "../conformance/tests.mjs";
import { normalizeRetrievalResponse } from "./lib/hydra-client.mjs";
import { syncWorkspace } from "./lib/workspace-sync.mjs";

const root = process.cwd();

const scriptFiles = [
  "scripts/plugin.mjs",
  "scripts/lib/config.mjs",
  "scripts/lib/context-format.mjs",
  "scripts/lib/hydra-client.mjs",
  "scripts/lib/sanitize.mjs",
  "scripts/lib/state.mjs",
  "scripts/lib/workspace-sync.mjs"
];

const jsonFiles = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "hooks/hooks.json",
  ".hydradb-plugin.json.example",
  "config.example.json",
  "package.json"
];

for (const relativePath of scriptFiles) {
  execFileSync(process.execPath, ["--check", path.join(root, relativePath)], {
    stdio: "inherit"
  });
}

execFileSync("bash", ["-n", path.join(root, "scripts/run-plugin.sh")], {
  stdio: "inherit"
});

for (const relativePath of jsonFiles) {
  const raw = await fs.readFile(path.join(root, relativePath), "utf8");
  JSON.parse(raw);
}

const hookConfig = JSON.parse(await fs.readFile(path.join(root, "hooks/hooks.json"), "utf8"));
for (const hookName of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
  const entries = hookConfig.hooks?.[hookName] || [];
  assert.ok(entries.length > 0, `${hookName} should be configured`);
  const commands = entries.flatMap((entry) => entry.hooks || []).map((hook) => hook.command || "");
  assert.ok(
    commands.some((command) => command.includes("scripts/run-plugin.sh")),
    `${hookName} should use the hook runner wrapper`
  );
}

const normalizedRecall = normalizeRetrievalResponse({
  chunks: [
    {
      chunk_uuid: "chunk-1",
      chunk_content: "HydraDB plugin overview",
      source_title: "README.md"
    }
  ]
});

assert.equal(normalizedRecall.chunks.length, 1);
assert.equal(normalizedRecall.chunks[0].text, "HydraDB plugin overview");
assert.equal(normalizedRecall.chunks[0].sourceTitle, "README.md");

const tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-plugin-check-"));
const baseEnv = {
  ...process.env,
  CLAUDE_PLUGIN_DATA: tempDataDir
};

const sessionStartRaw = execFileSync(process.execPath, [path.join(root, "scripts/plugin.mjs"), "session-start"], {
  env: baseEnv,
  encoding: "utf8"
}).trim();
const sessionStartOutput = JSON.parse(sessionStartRaw);
assert.equal(sessionStartOutput.hookSpecificOutput?.hookEventName, "SessionStart");
assert.match(sessionStartOutput.hookSpecificOutput?.additionalContext || "", /<hydradb-status>/);

execFileSync(process.execPath, [path.join(root, "scripts/plugin.mjs"), "user-prompt-submit"], {
  env: baseEnv,
  input: JSON.stringify({
    session_id: "check-session",
    prompt: "what is hydradb plugin"
  }),
  encoding: "utf8"
});

const lastRecallRaw = execFileSync(
  process.execPath,
  [path.join(root, "scripts/plugin.mjs"), "last-recall", "--json"],
  {
    env: baseEnv,
    encoding: "utf8"
  }
).trim();
const lastRecall = JSON.parse(lastRecallRaw);
assert.equal(lastRecall.sessionId, "check-session");
assert.equal(lastRecall.skipped, true);
assert.equal(lastRecall.reason, "not-configured");

await fs.writeFile(
  path.join(tempDataDir, "config.json"),
  JSON.stringify(
    {
      apiKey: "test-key",
      tenantId: "tenant-123",
      subTenantId: ""
    },
    null,
    2
  ),
  "utf8"
);

const statusRaw = execFileSync(process.execPath, [path.join(root, "scripts/plugin.mjs"), "doctor", "--json"], {
  env: baseEnv,
  encoding: "utf8"
}).trim();
const status = JSON.parse(statusRaw);
assert.equal(status.configured, true);
assert.equal(status.resolvedConfig.subTenantId, "");
assert.equal(status.resolvedConfig.captureMode, "session-upsert");
assert.equal(status.resolvedConfig.maxFileSizeBytes, 50 * 1024 * 1024);
assert.equal(status.resolvedConfig.maxMemoryCharsPerChunk, 50 * 1024 * 1024);
assert.equal(status.resolvedConfig.maxMemoryChunksPerFile, 1);

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-plugin-home-"));
const inlineDataDir = path.join(tempHome, ".claude", "plugins", "data", "hydradb-inline");
await fs.mkdir(inlineDataDir, { recursive: true });
await fs.writeFile(
  path.join(inlineDataDir, "config.json"),
  JSON.stringify(
    {
      apiKey: "inline-key",
      tenantId: "inline-tenant",
      subTenantId: ""
    },
    null,
    2
  ),
  "utf8"
);

const inlineStatusRaw = execFileSync(
  process.execPath,
  [path.join(root, "scripts/plugin.mjs"), "doctor", "--json"],
  {
    env: {
      ...process.env,
      HOME: tempHome,
      CLAUDE_PLUGIN_ROOT: root
    },
    encoding: "utf8"
  }
).trim();
const inlineStatus = JSON.parse(inlineStatusRaw);
assert.equal(inlineStatus.configured, true);
assert.equal(inlineStatus.dataDir, inlineDataDir);

const preservedRecallDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-plugin-last-recall-"));
await fs.writeFile(
  path.join(preservedRecallDir, "state.json"),
  JSON.stringify(
    {
      version: 1,
      files: {},
      sessions: {},
      lastSessionId: "existing-session",
      lastRecall: {
        sessionId: "existing-session",
        query: "persisted query",
        searchMode: "memory",
        skipped: false,
        emitted: true,
        memoryCount: 2,
        knowledgeCount: 0,
        updatedAt: "2026-03-23T00:00:00.000Z"
      }
    },
    null,
    2
  ),
  "utf8"
);
execFileSync(process.execPath, [path.join(root, "scripts/plugin.mjs"), "user-prompt-submit"], {
  env: {
    ...process.env,
    CLAUDE_PLUGIN_DATA: preservedRecallDir
  },
  input: JSON.stringify({
    session_id: "existing-session",
    prompt: "/hydradb:last-recall"
  }),
  encoding: "utf8"
});
const preservedLastRecall = JSON.parse(
  await fs.readFile(path.join(preservedRecallDir, "state.json"), "utf8")
).lastRecall;
assert.equal(preservedLastRecall.query, "persisted query");

const syncProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-plugin-sync-"));
const syncDocPath = path.join(syncProjectDir, "CLAUDE.md");
await fs.writeFile(syncDocPath, "# HydraDB\n", "utf8");
const unchangedState = {
  files: {
    [syncDocPath]: {
      digest: "unused-digest",
      relPath: "CLAUDE.md",
      syncedAt: "2026-03-23T00:00:00.000Z",
      target: "memory",
      chunkCount: 1
    }
  },
  sessions: {},
  lastSessionId: "",
  lastRecall: null
};
const syncCalls = [];
await syncWorkspace({
  client: {
    tenantId: "tenant-123",
    subTenantId: "",
    addMemories: async () => {},
    uploadKnowledge: async () => {},
    deleteKnowledge: async (ids) => {
      syncCalls.push({ type: "knowledge", ids });
    },
    deleteMemories: async (ids) => {
      syncCalls.push({ type: "memory", ids });
    }
  },
  config: {
    includeGlobs: ["CLAUDE.md"],
    excludeGlobs: [],
    maxFileSizeBytes: 50 * 1024 * 1024,
    maxFilesPerSync: 25,
    maxMemoryCharsPerChunk: 50 * 1024 * 1024,
    maxMemoryChunksPerFile: 1,
    ingestionMode: "memory",
    writeTimeoutMs: 15000,
    userName: "",
    workspaceMemoryCustomInstructions: ""
  },
  projectRoot: syncProjectDir,
  workspaceName: "sync-check",
  state: unchangedState
});
assert.equal(syncCalls.length, 0);

// ── Vendored SDK bundle: drift guard + bare-node load test ──────────────────
// The plugin marketplace-installs via `git clone` with NO `npm install`, so the
// SDK cannot be a runtime node_modules dependency; it is esbuild-bundled into a
// committed self-contained file. These two checks are the whole reason that is safe.
const vendoredBundlePath = path.join(root, "scripts/vendor/hydradb-sdk.mjs");
await fs.access(vendoredBundlePath);

// 1) Drift guard: a fresh build from the pinned SDK must be byte-identical to the
//    committed bundle, so an SDK bump without a re-vendor fails CI.
const freshBundlePath = path.join(
  await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-vendor-drift-")),
  "hydradb-sdk.mjs"
);
execFileSync(
  process.execPath,
  [path.join(root, "scripts/build-vendor.mjs"), "--out", freshBundlePath],
  { stdio: "inherit" }
);
const [committedBundle, freshBundle] = await Promise.all([
  fs.readFile(vendoredBundlePath),
  fs.readFile(freshBundlePath)
]);
assert.ok(
  committedBundle.equals(freshBundle),
  "scripts/vendor/hydradb-sdk.mjs is stale — run `npm run build:vendor` after the SDK bump and commit the result."
);

// 2) Bare-node load test: the committed bundle must import and construct on bare
//    `node` from a directory with NO node_modules (the exact marketplace runtime).
const bareNodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-bare-node-"));
await fs.copyFile(vendoredBundlePath, path.join(bareNodeDir, "hydradb-sdk.mjs"));
await fs.writeFile(
  path.join(bareNodeDir, "load-test.mjs"),
  [
    'import { HydraDBClient } from "./hydradb-sdk.mjs";',
    'if (typeof HydraDBClient !== "function") { console.error("HydraDBClient missing"); process.exit(1); }',
    'const c = new HydraDBClient({ token: "t", environment: "https://api.hydradb.com" });',
    'if (typeof c.query !== "function" || typeof c.context?.ingest !== "function" || typeof c.context?.delete !== "function") {',
    '  console.error("expected SDK surface missing"); process.exit(1);',
    "}",
    'process.stdout.write("BARE_NODE_OK");'
  ].join("\n"),
  "utf8"
);
const bareNodeOut = execFileSync(process.execPath, ["load-test.mjs"], {
  cwd: bareNodeDir,
  encoding: "utf8"
}).trim();
assert.equal(bareNodeOut, "BARE_NODE_OK", "vendored bundle failed to load on bare node");

// ── Wrapper conformance + HTTP-level wire tests + golden --json shapes ───────
const conformanceResult = await runConformance();
const httpResult = await runHttpTests();
const goldenResult = await runGoldenTests(root);

process.stdout.write(
  `Validated ${scriptFiles.length} core scripts, ${jsonFiles.length} JSON files, recall normalization, ` +
    `hook output, last-recall state, config defaults, the vendored SDK bundle (drift + bare-node load), ` +
    `${conformanceResult.ran} conformance vectors, ${httpResult.tests} HTTP-level wire tests, and ` +
    `${goldenResult.golden} golden --json shapes.\n`
);
