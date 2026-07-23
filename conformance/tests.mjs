// HTTP-level wire tests + golden --json shape snapshots.
//
// The repo shipped with ZERO real HTTP-level coverage — check.mjs stubbed
// `uploadKnowledge` at exactly the layer DX-G-002 lived, which is why the bug
// shipped and survived. These tests drive the real HydraClient adapter through
// the vendored SDK with a capturing fetch and assert the actual outgoing wire.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHydraWrapper } from "../scripts/lib/hydra/index.mjs";
import { HydraClient, normalizeRetrievalResponse } from "../scripts/lib/hydra-client.mjs";
import { syncWorkspace } from "../scripts/lib/workspace-sync.mjs";

function fakeResponse(payload) {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null),
      has: () => false,
      forEach: () => {}
    },
    text: async () => text,
    json: async () => JSON.parse(text),
    clone() {
      return fakeResponse(payload);
    },
    body: null
  };
}

// Capturing fetch: records each outgoing request in a wire-level view and
// answers with a canned envelope chosen by the responder.
function capturingFetch(sink, responder) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const httpMethod = (init.method || "GET").toUpperCase();
    const body = init.body;
    const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    const fields = {};
    if (isFormData) {
      for (const [k, v] of body.entries()) {
        fields[k] = v;
      }
    }
    const bodyString = typeof body === "string" ? body : undefined;
    const headerCt =
      init.headers && typeof init.headers.get === "function" ? init.headers.get("content-type") : undefined;
    const record = {
      path: parsed.pathname,
      httpMethod,
      isFormData,
      contentType: isFormData ? "multipart/form-data" : headerCt || (bodyString ? "application/json" : undefined),
      fields,
      bodyString
    };
    sink.push(record);
    return fakeResponse(responder ? responder(record) : { data: {}, success: true });
  };
}

const SCOPE = { apiKey: "test-key", tenantId: "db_test", subTenantId: "col_test" };

export async function runHttpTests() {
  // 1) DX-G-002: knowledge ingest MUST be multipart with a top-level tenant_id
  //    and the sources in `app_knowledge` (preserving the client id) — never
  //    application/json, never `app_sources`, never `app_knowledge`-as-JSON-body.
  {
    const sink = [];
    const client = new HydraClient({ ...SCOPE, fetch: capturingFetch(sink) });
    await client.uploadKnowledge([
      { id: "claude-file:abc123", title: "CLAUDE.md", content: { text: "workspace body" } }
    ]);
    const req = sink.at(-1);
    assert.equal(req.path, "/context/ingest", "knowledge ingest must hit /context/ingest");
    assert.equal(req.httpMethod, "POST");
    assert.equal(req.contentType, "multipart/form-data", "ingest must be multipart/form-data");
    assert.notEqual(req.contentType, "application/json", "ingest must NOT be application/json");
    assert.equal(req.fields.tenant_id, "db_test", "ingest must carry a top-level tenant_id");
    assert.equal(req.fields.database, "db_test");
    assert.equal(req.fields.type, "knowledge");
    assert.ok("app_knowledge" in req.fields, "knowledge source must be in app_knowledge");
    assert.ok(!("app_sources" in req.fields), "app_sources is v1-only and must not be sent");
    const items = JSON.parse(req.fields.app_knowledge);
    assert.equal(items[0].id, "claude-file:abc123", "client-assigned id must be preserved verbatim");
  }

  // 2) Memory ingest is multipart with the items in `memories` and type=memory.
  {
    const sink = [];
    const client = new HydraClient({ ...SCOPE, fetch: capturingFetch(sink) });
    await client.addMemories([{ text: "the user prefers dark mode", infer: true }]);
    const req = sink.at(-1);
    assert.equal(req.path, "/context/ingest");
    assert.equal(req.contentType, "multipart/form-data");
    assert.equal(req.fields.type, "memory");
    assert.equal(req.fields.tenant_id, "db_test");
    assert.ok("memories" in req.fields);
  }

  // 3) Delete-by-kind: knowledge sources route to type=knowledge on DELETE
  //    /context, carrying the SAME collection used at ingest (scope must match).
  {
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, () => ({ data: { deleted_count: 1 }, success: true }))
    });
    await client.deleteKnowledge(["claude-file:abc123"]);
    const req = sink.at(-1);
    assert.equal(req.path, "/context");
    assert.equal(req.httpMethod, "DELETE");
    const body = JSON.parse(req.bodyString);
    assert.equal(body.type, "knowledge", "knowledge delete must use type=knowledge");
    assert.deepEqual(body.ids, ["claude-file:abc123"]);
    assert.equal(body.collection, "col_test", "delete scope must match the ingest collection");
  }

  // 4) Delete-by-kind: memory sources route to type=memory.
  {
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, () => ({ data: { user_memory_deleted: true }, success: true }))
    });
    await client.deleteMemories(["mem_1"]);
    const body = JSON.parse(sink.at(-1).bodyString);
    assert.equal(body.type, "memory");
    assert.deepEqual(body.ids, ["mem_1"]);
  }

  // 5) Second silent bug: a 200 with {success:false, deleted_count:0} (nothing
  //    matched) must surface as an error, not be swallowed as a success.
  {
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch([], () => ({ data: { deleted_count: 0 }, success: false }))
    });
    await assert.rejects(
      () => client.deleteKnowledge(["missing"]),
      /deleted nothing/,
      "a zero-match delete must reject instead of silently succeeding"
    );
  }

  // 6) Recall round-trip: the SDK deserializes the v2 wire response to
  //    camelCase; the normalizer must still find the chunk (guards the silent
  //    empty-recall regression the camelCase→snake step fixes).
  {
    const wireEnvelope = {
      success: true,
      data: {
        chunks: [
          { chunk_uuid: "c1", chunk_content: "the user prefers dark mode", source_title: "prefs.md", source_id: "s1", score: 0.9 }
        ],
        graph_context: { query_paths: [] },
        additional_context: {}
      }
    };
    const client = new HydraClient({ ...SCOPE, fetch: capturingFetch([], () => wireEnvelope) });
    const recall = await client.recallMemories("what does the user prefer");
    assert.equal(recall.chunks.length, 1, "recall must surface the chunk from a v2 (camelCase) response");
    assert.equal(recall.chunks[0].text, "the user prefers dark mode");
    assert.equal(recall.chunks[0].sourceId, "s1");
  }

  // 7) camelCase delete no-op detection. The SDK deserializes the delete
  //    envelope to camelCase (deletedCount / userMemoryDeleted); a snake_case-only
  //    check would MISS the zero-match no-op and silently "succeed". Inject a spy
  //    SDK returning the exact camelCase shapes the real SDK produces.
  {
    const wrap = (envelope) =>
      createHydraWrapper({
        apiKey: "k",
        tenantId: "db_test",
        subTenantId: "col_test",
        sdkClient: { context: { delete: async () => envelope } }
      });
    await assert.rejects(
      () => wrap({ success: true, data: { deletedCount: 0 } }).context.delete({ ids: ["x"], kind: "knowledge" }),
      /deleted nothing/,
      "camelCase deletedCount:0 must surface as a no-op failure"
    );
    await assert.rejects(
      () => wrap({ success: true, data: { userMemoryDeleted: false } }).context.delete({ ids: ["m"], kind: "memory" }),
      /deleted nothing/,
      "camelCase userMemoryDeleted:false must surface as a no-op failure"
    );
    await assert.rejects(
      () => wrap({ success: true, data: { userMemoryDeleted: 0 } }).context.delete({ ids: ["m"], kind: "memory" }),
      /deleted nothing/,
      "NUMERIC userMemoryDeleted:0 must surface as a no-op failure (not just boolean false)"
    );
    // Genuine deletions must NOT throw (numeric truthy + boolean true).
    await wrap({ success: true, data: { deletedCount: 2 } }).context.delete({ ids: ["a", "b"], kind: "knowledge" });
    await wrap({ success: true, data: { userMemoryDeleted: 1 } }).context.delete({ ids: ["m"], kind: "memory" });
  }

  // 8) End-to-end: a failed workspace delete must surface into summary.errors AND
  //    RETAIN tracked state (so the next sync retries) — never silently drop the
  //    entry, which is how the second silent bug hid.
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-del-retain-"));
    const filePath = path.join(dir, "CLAUDE.md"); // absent on disk → triggers a delete
    const state = {
      files: {
        [filePath]: { digest: "d", relPath: "CLAUDE.md", syncedAt: "2026-01-01T00:00:00.000Z", target: "knowledge", chunkCount: 1 }
      },
      sessions: {},
      lastSessionId: "",
      lastRecall: null
    };
    const throwingClient = {
      tenantId: "db_test",
      subTenantId: "col_test",
      addMemories: async () => {},
      uploadKnowledge: async () => {},
      deleteMemories: async () => {},
      deleteKnowledge: async () => {
        throw new Error("/context (delete) deleted nothing for [\"…\"]");
      }
    };
    const summary = await syncWorkspace({
      client: throwingClient,
      config: {
        includeGlobs: ["CLAUDE.md"],
        excludeGlobs: [],
        maxFileSizeBytes: 50 * 1024 * 1024,
        maxFilesPerSync: 25,
        maxMemoryCharsPerChunk: 50 * 1024 * 1024,
        maxMemoryChunksPerFile: 1,
        ingestionMode: "knowledge",
        writeTimeoutMs: 15000,
        userName: "",
        workspaceMemoryCustomInstructions: ""
      },
      projectRoot: dir,
      workspaceName: "t",
      state
    });
    assert.ok(
      summary.errors.some((e) => /knowledge delete failed/.test(e)),
      "a failed delete must surface into summary.errors"
    );
    assert.ok(state.files[filePath], "tracked state must be RETAINED after a failed delete, for retry");
  }

  // 9) The single normalization seam: EVERY wrapper method returns snake_cased
  //    data regardless of the SDK's camelCase, so all downstream readers are
  //    insulated in one place. Guards the whole camelCase class, not one site.
  {
    const spy = {
      query: async () => ({ success: true, data: { chunks: [{ chunkContent: "c", sourceTitle: "T" }] } }),
      context: {
        list: async () => ({ success: true, data: { sources: [{ sourceId: "s1", sourceTitle: "T", isMemory: true }] } }),
        inspect: async () => ({ success: true, data: { sourceId: "s1", chunkContent: "body" } })
      }
    };
    const w = createHydraWrapper({ apiKey: "k", tenantId: "db_test", subTenantId: "col_test", sdkClient: spy });
    const q = await w.context.query({ query: "x", kind: "memory" });
    assert.equal(q.chunks[0].chunk_content, "c", "query result must be snake_cased at the seam");
    assert.equal(q.chunks[0].source_title, "T");
    const list = await w.context.list({ kind: "knowledge" });
    assert.equal(list.sources[0].source_id, "s1", "list result must be snake_cased at the seam");
    assert.equal(list.sources[0].is_memory, true);
    const inspect = await w.context.inspect({ id: "s1" });
    assert.equal(inspect.source_id, "s1", "inspect result must be snake_cased at the seam");
    assert.equal(inspect.chunk_content, "body");
  }

  return { tests: 9 };
}

// ── Golden --json shape snapshots ───────────────────────────────────────────
// These lock the KEY STRUCTURE (not volatile values) of the outputs that
// marketplace-shipped skill files parse, so the shape cannot silently move.

function keyShape(value, prefix = "") {
  if (Array.isArray(value)) {
    return value.length ? keyShape(value[0], `${prefix}[]`) : [`${prefix}[]`];
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .flatMap((k) => keyShape(value[k], prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

async function assertGolden(goldenDir, name, actualShape) {
  const goldenPath = path.join(goldenDir, `${name}.shape.json`);
  const serialized = `${JSON.stringify(actualShape, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    await fs.mkdir(goldenDir, { recursive: true });
    await fs.writeFile(goldenPath, serialized, "utf8");
    return;
  }
  let expected;
  try {
    expected = JSON.parse(await fs.readFile(goldenPath, "utf8"));
  } catch {
    throw new Error(`missing golden ${name}.shape.json — regenerate with UPDATE_GOLDEN=1`);
  }
  assert.deepEqual(
    actualShape,
    expected,
    `--json shape for "${name}" moved; if intended, regenerate with UPDATE_GOLDEN=1 and review the diff`
  );
}

// A representative v2 retrieval response exercising the normalizer's branches.
const SAMPLE_RETRIEVAL = {
  chunks: [
    {
      chunk_uuid: "c1",
      chunk_content: "workspace overview",
      source_title: "README.md",
      source_id: "s1",
      score: 0.5,
      extra_context_ids: ["e1"],
      graph_context: { chunk_relations: [{ relation: "depends_on" }] }
    }
  ],
  graph_context: {
    query_paths: ["a -> b"],
    chunk_relations: [
      { group_id: "g1", triplets: [{ source: "a", relation: "rel", target: "b" }] }
    ],
    chunk_id_to_group_ids: { c1: ["g1"] }
  },
  additional_context: { x1: { source_title: "notes.md", chunk_content: "detail" } }
};

export async function runGoldenTests(root) {
  const goldenDir = path.join(root, "conformance", "golden");

  // query/search --json payload shape: {query, searchMode, memory, knowledge, errors}
  const normalized = normalizeRetrievalResponse(SAMPLE_RETRIEVAL);
  const queryPayload = {
    query: "sample",
    searchMode: "both",
    memory: normalized,
    knowledge: normalized,
    errors: []
  };
  await assertGolden(goldenDir, "query", keyShape(queryPayload));

  // doctor/status --json shape, from a real CLI run against a seeded config.
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-golden-"));
  await fs.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apiKey: "k", tenantId: "db_test", subTenantId: "" }),
    "utf8"
  );
  const doctorRaw = execFileSync(
    process.execPath,
    [path.join(root, "scripts/plugin.mjs"), "doctor", "--json"],
    { env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }, encoding: "utf8" }
  ).trim();
  await assertGolden(goldenDir, "doctor", keyShape(JSON.parse(doctorRaw)));

  // last-recall --json shape: seed a representative full payload, confirm the
  // command echoes it unchanged (locks the shape skills read).
  const recallDir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-golden-lr-"));
  const fullLastRecall = {
    sessionId: "s",
    query: "q",
    searchMode: "both",
    skipped: false,
    emitted: true,
    memoryCount: 1,
    knowledgeCount: 0,
    memoryGraphPathCount: 1,
    knowledgeGraphPathCount: 0,
    errors: [],
    additionalContext: "<hydradb-context>…</hydradb-context>",
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
  await fs.writeFile(
    path.join(recallDir, "state.json"),
    JSON.stringify({ version: 1, files: {}, sessions: {}, lastSessionId: "s", lastRecall: fullLastRecall }),
    "utf8"
  );
  const lastRecallRaw = execFileSync(
    process.execPath,
    [path.join(root, "scripts/plugin.mjs"), "last-recall", "--json"],
    { env: { ...process.env, CLAUDE_PLUGIN_DATA: recallDir }, encoding: "utf8" }
  ).trim();
  await assertGolden(goldenDir, "last-recall", keyShape(JSON.parse(lastRecallRaw)));

  return { golden: 3 };
}
