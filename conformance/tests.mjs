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
import {
  appKnowledgeToItem,
  HydraClient,
  isUnifiedLayoutRefusal,
  memoryToItem,
  normalizeRetrievalResponse
} from "../scripts/lib/hydra-client.mjs";
import { syncWorkspace } from "../scripts/lib/workspace-sync.mjs";

function fakeResponse(payload) {
  // A responder may name the HTTP status through `__status` (default 200),
  // so a wire test can make the server refuse a request the way it really does.
  const { __status: status = 200, ...body } = payload && typeof payload === "object" ? payload : {};
  const text = JSON.stringify(payload && typeof payload === "object" ? body : payload);
  return {
    ok: status < 400,
    status,
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

  // 5) Second silent bug, reconciled per id: a no-op response (nothing matched)
  //    confirms zero deletions, so the id is reported failed (retain + retry),
  //    never swallowed as success.
  {
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch([], () => ({ data: { deleted_count: 0 }, success: false }))
    });
    const res = await client.deleteKnowledge(["missing"]);
    assert.deepEqual(res.deletedIds, [], "a zero-match delete confirms no deletions");
    assert.deepEqual(res.failedIds, ["missing"], "the unmatched id must be reported failed for retry");
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

  // 7) Per-id delete classification matrix. The wrapper returns exactly which
  //    requested ids the server confirmed deleted vs. failed, derived from the
  //    SDK's camelCase response. ONE design subsumes every axis Greptile walked:
  //    success flag, integer counts (0 = none), per-item results incl. MIXED,
  //    empty results, and missing fields.
  {
    const wrap = (envelope) =>
      createHydraWrapper({
        apiKey: "k",
        tenantId: "db_test",
        subTenantId: "col_test",
        sdkClient: { context: { delete: async () => envelope } }
      });
    const cases = [
      ["all via count", { success: true, data: { deletedCount: 2 } }, ["a", "b"], ["a", "b"], []],
      ["none via count 0", { success: true, data: { deletedCount: 0 } }, ["a"], [], ["a"]],
      ["none via success:false", { success: false, data: { deletedCount: 2 } }, ["a"], [], ["a"]],
      ["numeric userMemoryDeleted:0", { success: true, data: { userMemoryDeleted: 0 } }, ["m"], [], ["m"]],
      ["numeric userMemoryDeleted:1", { success: true, data: { userMemoryDeleted: 1 } }, ["m"], ["m"], []],
      [
        "MIXED results (partial batch)",
        { success: true, data: { results: [{ id: "a", deleted: true }, { id: "b", deleted: false, error: "x" }] } },
        ["a", "b"],
        ["a"],
        ["b"]
      ],
      ["empty results", { success: true, data: { results: [] } }, ["a"], [], ["a"]],
      [
        "all results true",
        { success: true, data: { results: [{ id: "a", deleted: true }, { id: "b", deleted: true }] } },
        ["a", "b"],
        ["a", "b"],
        []
      ],
      ["minimal success (no counts/results)", { success: true, data: {} }, ["a"], ["a"], []],
      // An id the server has already removed reports deleted:false with a
      // not-found error, under a success:false batch rollup. The postcondition
      // ("id no longer stored") holds, so it is confirmed, not retried — without
      // this a deleted file is retried on every full sync forever and its
      // tracked state never clears. This is the exact prod response shape.
      [
        "already absent is terminal, not retryable",
        {
          success: false,
          data: {
            success: false,
            message: "No sources were deleted",
            results: [{ id: "gone", deleted: false, error: "Source not found" }],
            deletedCount: 0
          }
        },
        ["gone"],
        ["gone"],
        []
      ],
      // Per-item detail outranks the batch rollup: a real failure alongside an
      // already-absent id must still be retained, even though both sit under the
      // same success:false envelope.
      [
        "already absent + real failure under one rollup",
        {
          success: false,
          data: {
            success: false,
            results: [
              { id: "gone", deleted: false, error: "Source not found" },
              { id: "boom", deleted: false, error: "internal error" }
            ]
          }
        },
        ["gone", "boom"],
        ["gone"],
        ["boom"]
      ]
    ];
    for (const [label, envelope, ids, expDeleted, expFailed] of cases) {
      const res = await wrap(envelope).context.delete({ ids, kind: "knowledge" });
      assert.deepEqual(res.deletedIds, expDeleted, `deletedIds for "${label}"`);
      assert.deepEqual(res.failedIds, expFailed, `failedIds for "${label}"`);
    }
  }

  // 8) End-to-end PER-ID reconciliation. Two tracked knowledge files map to two
  //    ids; the client confirms only one deleted. workspace-sync must drop
  //    tracking for the confirmed file, RETAIN it for the unconfirmed one (so the
  //    next sync retries), and surface the incomplete delete — never
  //    all-or-nothing, which is how a partial/no-op delete silently lost state.
  {
    const crypto = await import("node:crypto");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-del-perid-"));
    // Source ids exactly as workspace-sync derives them: claude-file:<sha1(root:rel)>.
    const idFor = (rel) => `claude-file:${crypto.createHash("sha1").update(`${dir}:${rel}`).digest("hex")}`;
    const [relDrop, relKeep] = ["DROP.md", "KEEP.md"];
    const pDrop = path.join(dir, relDrop);
    const pKeep = path.join(dir, relKeep);
    const state = {
      files: {
        [pDrop]: { digest: "d", relPath: relDrop, syncedAt: "2026-01-01T00:00:00.000Z", target: "knowledge", chunkCount: 1 },
        [pKeep]: { digest: "d", relPath: relKeep, syncedAt: "2026-01-01T00:00:00.000Z", target: "knowledge", chunkCount: 1 }
      },
      sessions: {},
      lastSessionId: "",
      lastRecall: null
    };
    const mixedClient = {
      tenantId: "db_test",
      subTenantId: "col_test",
      addMemories: async () => {},
      uploadKnowledge: async () => {},
      deleteMemories: async () => ({ deletedIds: [], failedIds: [] }),
      // Confirms only DROP.md; KEEP.md is reported failed.
      deleteKnowledge: async (ids) => ({
        deletedIds: [idFor(relDrop)],
        failedIds: ids.filter((id) => id !== idFor(relDrop))
      })
    };
    const summary = await syncWorkspace({
      client: mixedClient,
      config: {
        includeGlobs: ["*.md"],
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
    assert.ok(!state.files[pDrop], "confirmed-deleted file must have tracking dropped");
    assert.ok(state.files[pKeep], "UNCONFIRMED file must RETAIN tracking for retry");
    assert.equal(summary.deleted, 1, "only the confirmed delete counts");
    assert.ok(summary.errors.some((e) => /incomplete/.test(e)), "the unconfirmed delete must be surfaced");
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

  // 10) PRO-1618: unified recall is a hand-built POST /query with type=unified
  //     (the vendored SDK's request serializer rejects the value), and the
  //     result goes through the same snake_case seam.
  {
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, () => ({
        data: { chunks: [{ chunk_uuid: "c1", chunk_content: "body", source_title: "T" }] },
        success: true
      }))
    });
    const res = await client.recallUnified("acme");
    const req = sink.at(-1);
    assert.equal(req.path, "/query");
    assert.equal(req.httpMethod, "POST");
    assert.equal(req.contentType, "application/json");
    const body = JSON.parse(req.bodyString);
    assert.equal(body.type, "unified");
    assert.equal(body.database, "db_test");
    assert.equal(body.collection, "col_test");
    assert.equal(res.chunks[0].text, "body");
  }

  // 11) Unified delete is a hand-built DELETE /context with type=unified, and
  //     the per-id classification still sees the envelope.
  {
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, () => ({ data: { deleted_count: 1 }, success: true }))
    });
    const result = await client._hydra.context.delete({ ids: ["item-1"], kind: "unified" });
    const req = sink.at(-1);
    assert.equal(req.path, "/context");
    assert.equal(req.httpMethod, "DELETE");
    const body = JSON.parse(req.bodyString);
    assert.equal(body.type, "unified");
    assert.deepEqual(body.ids, ["item-1"]);
    assert.deepEqual(result.deletedIds, ["item-1"]);
  }

  // 12) On a unified database every memory write becomes the items[] JSON
  //     body after one layout probe; the split-era `memories` field is never sent.
  {
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, (req) =>
        req.path === "/databases"
          ? { data: { databases: ["db_test"], details: [{ database: "db_test", type: "unified" }] }, success: true }
          : { data: { success_count: 1, failed_count: 0 }, success: true }
      )
    });
    await client.addMemories([{ text: "the user prefers dark mode", infer: true, source_id: "m1" }]);
    assert.equal(sink[0].path, "/databases", "the layout is probed once, first");
    const req = sink.at(-1);
    assert.equal(req.path, "/context/ingest");
    assert.equal(req.contentType, "application/json", "unified ingest is the JSON items[] body");
    const body = JSON.parse(req.bodyString);
    assert.deepEqual(body.items, [{ text: "the user prefers dark mode", context_id: "m1", enrich: true }]);
    assert.ok(!("memories" in body));
  }

  // 13) A probe that fails reads as split, and when the server then names the
  //     rule the client pins unified and retries once.
  {
    const sink = [];
    let calls = 0;
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, (req) => {
        calls += 1;
        if (req.path === "/databases") return { __status: 500, success: false, error: { message: "boom" } };
        if (req.path === "/context/ingest" && req.contentType === "multipart/form-data") {
          return {
            __status: 400,
            success: false,
            error: { code: "VALIDATION_ERROR", message: "type 'memory' is not valid on a unified database" }
          };
        }
        return { data: { success_count: 1, failed_count: 0 }, success: true };
      })
    });
    await client.addMemories([{ text: "note" }]);
    assert.equal(sink.at(-1).contentType, "application/json", "retried as the unified items[] body");
    assert.equal(await client.isUnified(), true, "the refusal pins the layout for later calls");
  }

  // 13b) The SAME recovery for the knowledge lane. uploadKnowledge was the one
  //      layout-sensitive write with no try/catch, so a flaky layout probe left
  //      every workspace file in the knowledge lane 400ing for the life of the
  //      process while the memory lane in the same sync recovered.
  {
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, (req) => {
        if (req.path === "/databases") return { __status: 500, success: false, error: { message: "boom" } };
        if (req.path === "/context/ingest" && req.contentType === "multipart/form-data") {
          return {
            __status: 400,
            success: false,
            error: { code: "VALIDATION_ERROR", message: "type 'knowledge' is not valid on a unified database" }
          };
        }
        return { data: { success_count: 1, failed_count: 0 }, success: true };
      })
    });
    await client.uploadKnowledge([
      { id: "claude-file:a", title: "CLAUDE.md", content: { text: "# Smoke" } }
    ]);
    const req = sink.at(-1);
    assert.equal(req.contentType, "application/json", "knowledge retries as the unified items[] body too");
    assert.deepEqual(JSON.parse(req.bodyString).items, [
      { text: "# Smoke", enrich: true, context_id: "claude-file:a", title: "CLAUDE.md" }
    ]);
    assert.equal(await client.isUnified(), true, "the knowledge refusal pins the layout too");
  }

  // 13c) The ingest-body wording of the same refusal ("this database is
  //      unified: send the content as `items`") is the one the old
  //      /unified database/i pattern missed entirely, and the retry is pinned
  //      only once it has actually succeeded.
  {
    const sink = [];
    let ingests = 0;
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, (req) => {
        if (req.path === "/databases") return { __status: 500, success: false, error: { message: "boom" } };
        ingests += 1;
        if (ingests === 1) {
          return {
            __status: 400,
            success: false,
            error: {
              code: "CORPUS_TYPE_UNSUPPORTED",
              message:
                "this database is unified: send the content as `items` (a JSON array of text or conversation items)"
            }
          };
        }
        if (ingests === 2) {
          return { __status: 503, success: false, error: { message: "upstream unavailable" } };
        }
        return { data: { success_count: 1, failed_count: 0 }, success: true };
      })
    });
    await assert.rejects(
      () => client.addMemories([{ text: "note" }]),
      /503/,
      "a retry that fails for an unrelated reason propagates that failure"
    );
    assert.equal(
      await client.isUnified(),
      false,
      "and must NOT pin the layout: the retry never proved the database is unified"
    );
  }

  // 13d) A knowledge record with no text is dropped rather than sent: server
  //      validation is per item but all-or-nothing per request, so one empty
  //      record would 400 the whole batch where the split lane stored it.
  {
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, (req) =>
        req.path === "/databases"
          ? { data: { databases: ["db_test"], details: [{ database: "db_test", type: "unified" }] }, success: true }
          : { data: { success_count: 1, failed_count: 0 }, success: true }
      )
    });
    await client.uploadKnowledge([
      { id: "claude-file:empty", title: "EMPTY.md", content: { text: "   " } },
      { id: "claude-file:real", title: "CLAUDE.md", content: { text: "# Smoke" } }
    ]);
    const items = JSON.parse(sink.at(-1).bodyString).items;
    assert.equal(items.length, 1, "the empty record is skipped, not sent");
    assert.equal(items[0].context_id, "claude-file:real");
  }

  // 13e) The workspace-sync knowledge record keeps everything its producer set.
  //      appKnowledgeToItem used to read tenant_metadata/app_metadata, which
  //      buildKnowledgeItem never emits, so a synced file arrived on a unified
  //      database as bare text plus a context_id.
  {
    const item = appKnowledgeToItem({
      id: "claude-file:abc",
      title: "CLAUDE.md",
      source: "claude-code-plugin",
      description: "Workspace context synced from t",
      url: "hydradb://workspace/t/CLAUDE.md",
      timestamp: "2026-09-05T10:00:00.000Z",
      content: { text: "# Smoke" },
      metadata: { workspace: "t", relative_path: "CLAUDE.md", extension: ".md" },
      additional_metadata: { size_bytes: 7, plugin: "hydradb" }
    });
    assert.deepEqual(item, {
      text: "# Smoke",
      enrich: true,
      context_id: "claude-file:abc",
      title: "CLAUDE.md",
      happened_at: "2026-09-05T10:00:00.000Z",
      attributes: { workspace: "t", relative_path: "CLAUDE.md", extension: ".md" },
      custom_attributes: {
        size_bytes: 7,
        plugin: "hydradb",
        source: "claude-code-plugin",
        description: "Workspace context synced from t",
        url: "hydradb://workspace/t/CLAUDE.md"
      }
    });
  }

  // 13f) is_markdown and user_name are CARRIED, not dropped: the first changes
  //      how the server chunks and renders, the second is the attribution, and
  //      buildMemoryItems sets both on every workspace memory chunk.
  {
    assert.deepEqual(memoryToItem({ text: "# Title", is_markdown: true, user_name: "Ada" }), {
      text: "# Title",
      is_markdown: true,
      user_name: "Ada",
      enrich: true
    });
    assert.equal(
      memoryToItem({ text: "note", is_markdown: false }).is_markdown,
      false,
      "an explicit false is still the caller's answer, not an absent field"
    );
    // A conversation's attribution rides on the per-turn speaker name instead.
    const conversationItem = memoryToItem({
      user_assistant_pairs: [{ user: "hi", assistant: "yo" }],
      user_name: "Ada"
    });
    assert.deepEqual(conversationItem.conversation, [
      { role: "user", content: "hi", name: "Ada" },
      { role: "assistant", content: "yo" }
    ]);
    assert.ok(!("user_name" in conversationItem), "a conversation does not repeat it at item level");
  }

  // 13g) CORPUS_TYPE_UNSUPPORTED covers three refusals and only one is ours.
  //      `unified` sent to a SPLIT database carries the same code; retrying it
  //      as unified would turn a clear 400 into a second, more confusing one.
  {
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, (req) =>
        req.path === "/databases"
          ? { data: { databases: ["db_test"], details: [{ database: "db_test", type: "split" }] }, success: true }
          : {
              __status: 400,
              success: false,
              error: {
                code: "CORPUS_TYPE_UNSUPPORTED",
                message:
                  'type "unified" is only valid on a unified database; this database stores knowledge and memory separately'
              }
            }
      )
    });
    await assert.rejects(
      () => client.recallUnified("acme"),
      /only valid on a unified database/,
      "the sibling refusal propagates rather than being retried"
    );
    const queries = sink.filter((req) => req.path === "/query");
    assert.equal(queries.length, 1, "no retry: this refusal is not ours");
    // And the other two siblings. `all` on an ingest and a `type` outside the
    // vocabulary both carry CORPUS_TYPE_UNSUPPORTED too, so the code alone
    // would have retried a typo as unified.
    const allOnIngest = new Error("unified ingest failed with 400: invalid type 'all': it selects both corpora");
    allOnIngest.errorCode = "CORPUS_TYPE_UNSUPPORTED";
    assert.equal(isUnifiedLayoutRefusal(allOnIngest), false);
    const badType = new Error(
      `query failed with 400: invalid type "momory": must be 'knowledge', 'memory', 'unified' or 'all'`
    );
    badType.errorCode = "CORPUS_TYPE_UNSUPPORTED";
    assert.equal(isUnifiedLayoutRefusal(badType), false, "a typo'd type is not a layout answer");
    // The `all`-on-ingest advice is layout-aware and now says "This database is
    // unified, so send 'unified'…" inside a refusal that is NOT ours. Excluding
    // on `invalid type` BEFORE reading the code is what keeps that sentence
    // from being read as a layout answer — this pins that ordering.
    const allOnUnified = new Error(
      "unified ingest failed with 400: invalid type 'all': it selects both corpora for reads and " +
        "deletes, but an ingest must name the one it writes to. This database is unified, so send " +
        "'unified' or omit `type` entirely."
    );
    allOnUnified.errorCode = "CORPUS_TYPE_UNSUPPORTED";
    assert.equal(
      isUnifiedLayoutRefusal(allOnUnified),
      false,
      "the advice clause names a unified database but the refusal is still not ours"
    );
    // items[] with type=knowledge is a caller error, not a layout answer, and a
    // retry that pinned unified would strand a SPLIT database on it.
    const itemsWithKnowledge = new Error(
      "unified ingest failed with 400: items cannot be combined with type=knowledge: items are " +
        "memory-shaped (text or a conversation); omit type or use the unified default."
    );
    itemsWithKnowledge.errorCode = "CORPUS_TYPE_UNSUPPORTED";
    assert.equal(isUnifiedLayoutRefusal(itemsWithKnowledge), false);
    // The code is read from `detail.error_code` as well as `error.code`.
    const viaDetail = new Error("ingest failed with 400: the corpus refused this request");
    viaDetail.errorCode = "CORPUS_TYPE_UNSUPPORTED";
    assert.equal(isUnifiedLayoutRefusal(viaDetail), true, "the code carries a refusal the regex cannot see");
  }

  return { tests: 19 };
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
