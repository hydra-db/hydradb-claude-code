// PRO-2193: wire tests for the unified fixes found against staging (unified
// switch on, strict ingest decoder from hydradb-application#1653, caps from
// #1657). Each block pins one fix; most fail on the pre-fix client.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fitUnifiedPrompt, buildHydraContextBlock } from "../scripts/lib/context-format.mjs";
import {
  HydraClient,
  normalizeRetrievalResponse,
  planUnifiedRequests,
  UNIFIED_MAX_ITEM_TEXT_BYTES
} from "../scripts/lib/hydra-client.mjs";
import { syncWorkspace, UNIFIED_MAX_CHUNK_CHARS } from "../scripts/lib/workspace-sync.mjs";
import { UNIFIED_QUERY_META, UNIFIED_QUERY_RESPONSE } from "./fixtures.mjs";
import { capturingFetch, SCOPE } from "./tests.mjs";

// The keys the strict decoder accepts (unified_ingest.go acceptedFieldNames).
const REQUEST_KEYS = new Set(["database", "collection", "context", "upsert", "enrich", "instructions", "graph_payload"]);
const ITEM_KEYS = new Set([
  "context_id", "title", "text", "conversation", "enrich", "upsert", "instructions", "happened_at",
  "attributes", "custom_attributes", "context_category", "forceful_relations", "acl", "user_name"
]);
const TURN_KEYS = new Set(["role", "content"]);

function assertStrictBody(bodyString) {
  const body = JSON.parse(bodyString);
  for (const key of Object.keys(body)) assert.ok(REQUEST_KEYS.has(key), `request key ${key} is refused by the strict decoder`);
  for (const item of body.context) {
    for (const key of Object.keys(item)) assert.ok(ITEM_KEYS.has(key), `item key ${key} is refused by the strict decoder`);
    for (const turn of item.conversation ?? []) {
      for (const key of Object.keys(turn)) assert.ok(TURN_KEYS.has(key), `turn key ${key} is refused by the strict decoder`);
    }
  }
  return body;
}

const unifiedProbe = { data: { databases: ["db_test"], details: [{ database: "db_test", type: "unified" }] }, success: true };
const splitProbe = { data: { databases: ["db_test"], details: [{ database: "db_test", type: "split" }] }, success: true };
const ingest202 = (items) => ({
  data: {
    success: true,
    message: "queued",
    results: items.map((item, i) => ({ id: item.context_id || `gen-${i}`, status: "queued", infer: true })),
    success_count: items.length,
    failed_count: 0
  },
  success: true
});

export async function runUnifiedFixTests() {
  let tests = 0;

  // 1) Every unified write the plugin makes passes the strict decoder: no
  //    per-turn `name`, no top-level `is_markdown`; the speaker is user_name.
  {
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, (req) =>
        req.path === "/databases" ? unifiedProbe : ingest202(JSON.parse(req.bodyString).context)
      )
    });
    await client.addConversationMemory("I prefer dark mode", "Noted", { userName: "Ada", sourceId: "t1" });
    await client.addTextMemory("# Note", { isMarkdown: true, userName: "Ada", sourceId: "n1", title: "T".repeat(3000) });
    const [conv, text] = sink.filter((r) => r.path === "/context/ingest").map((r) => assertStrictBody(r.bodyString));
    assert.deepEqual(conv.context[0].conversation, [
      { role: "user", content: "I prefer dark mode" },
      { role: "assistant", content: "Noted" }
    ]);
    assert.equal(conv.context[0].user_name, "Ada");
    assert.equal(text.context[0].user_name, "Ada");
    assert.ok(Buffer.byteLength(text.context[0].title) <= 1024, "title clipped to the server's 1024-byte limit");
    tests += 1;
  }

  // 2) The 202 names the context `id`; context ids are read from it.
  {
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch([], (req) =>
        req.path === "/databases" ? unifiedProbe : ingest202([{ context_id: "note-1" }])
      )
    });
    const stored = await client.addTextMemory("hello", { sourceId: "note-1" });
    assert.deepEqual(stored.contextIds, ["note-1"]);
    tests += 1;
  }

  // 3) Answers are read by SHAPE: a v2 body from a unified database (server's
  //    unified surface off) is readable, a four-key body without
  //    forceful_relations is unified, and only a body that is neither throws.
  {
    const v2Body = { chunks: [{ chunk_uuid: "c1", chunk_content: "dark mode please", source_id: "s1", source_title: "prefs" }] };
    const respond = (data) =>
      new HydraClient({
        ...SCOPE,
        fetch: capturingFetch([], (req) => (req.path === "/databases" ? unifiedProbe : { data, success: true, meta: UNIFIED_QUERY_META }))
      });

    const fromV2 = await respond(v2Body).recallUnified("dark");
    assert.deepEqual(fromV2, normalizeRetrievalResponse(v2Body), "a v2 answer is read as v2, not refused");

    const { forceful_relations: _dropped, ...noBucket } = UNIFIED_QUERY_RESPONSE;
    const fromUnified = await respond(noBucket).recallUnified("dark");
    assert.equal(typeof fromUnified.llmPrompt, "string");
    assert.deepEqual(fromUnified.forcefulRelations, [], "a missing forceful_relations reads as none");

    await assert.rejects(() => respond({ llm_prompt: "x", something: 1 }).recallUnified("dark"), /neither the unified body/);
    tests += 1;
  }

  // 4) The injected unified prompt is bounded without losing a citation:
  //    bodies are found by the recall's own chunk text (so Markdown inside a
  //    body is never read as structure), every heading and id is kept, and a
  //    body that cannot be located still cannot break the bound.
  {
    const md = Array.from({ length: 300 }, (_, i) => `# Chapter ${i}\n## Part\n### ${i}. looks like a result\n---\n${"word ".repeat(40)}`).join("\n");
    const prompt = [
      "# Query results", "", "## Results", "",
      "### 1. handbook", "- **Id:** md-1", "", md, "", "---", "",
      "### 2. short", "- **Id:** s-2", "", "short body kept whole", "", "## Related facts", "", "- [P1] a -rel-> b [1][2]"
    ].join("\n");
    const recall = {
      llmPrompt: prompt,
      chunks: [{ contextId: "md-1", content: md }, { contextId: "s-2", content: "short body kept whole" }],
      forcefulRelations: [],
      graph: []
    };
    const fitted = fitUnifiedPrompt(recall, 6000);
    assert.ok(prompt.length > 60_000);
    assert.ok(fitted.length <= 6000, `fitted to budget (${fitted.length})`);
    for (const kept of ["### 1. handbook", "- **Id:** md-1", "### 2. short", "- **Id:** s-2", "short body kept whole", "- [P1] a -rel-> b [1][2]"]) {
      assert.ok(fitted.includes(kept), `kept: ${kept}`);
    }
    assert.match(fitted, /shortened: \d+ of \d+ characters, id md-1/);

    const unlocatable = fitUnifiedPrompt({ ...recall, chunks: [{ contextId: "x", content: "not in the prompt" }] }, 6000);
    assert.ok(unlocatable.length <= 6000 && /recall cut to fit the context budget/.test(unlocatable));

    const small = { llmPrompt: "tiny", chunks: [], forcefulRelations: [], graph: [] };
    assert.equal(fitUnifiedPrompt(small, 6000), "tiny", "a prompt that fits is untouched");

    const empty = { chunks: [], queryPaths: [], graphContext: {}, additionalContext: {} };
    const block = buildHydraContextBlock({ query: "q", unified: recall, memory: empty, knowledge: empty, errors: [], maxContextChars: 7000 });
    assert.ok(block.length <= 7000, `the hook block stays within maxContextChars (${block.length})`);
    tests += 1;
  }

  // 5) Unified writes are split to the server's caps (100 items, 8 MiB of text
  //    per request); an item over 1 MiB is refused by name, not sent, and the
  //    rest still go.
  {
    const many = Array.from({ length: 150 }, (_, i) => ({ text: `n${i}`, context_id: `n${i}` }));
    assert.deepEqual(planUnifiedRequests(many).requests.map((r) => r.length), [100, 50]);
    const heavy = Array.from({ length: 10 }, (_, i) => ({ text: "x".repeat(900_000), context_id: `h${i}` }));
    assert.ok(planUnifiedRequests(heavy).requests.length >= 2, "text over the request cap is split");

    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, (req) =>
        req.path === "/databases" ? unifiedProbe : ingest202(JSON.parse(req.bodyString).context)
      )
    });
    const tooBig = { text: "y".repeat(UNIFIED_MAX_ITEM_TEXT_BYTES + 10), source_id: "big-1" };
    await assert.rejects(
      () => client.addMemories([{ text: "fine", source_id: "ok-1" }, tooBig]),
      (error) => {
        assert.match(error.message, /big-1: text is \d+ bytes; the maximum per item is/);
        assert.deepEqual(error.ingest.contextIds, ["ok-1"], "the other item was still sent");
        return true;
      }
    );
    const sent = sink.filter((r) => r.path === "/context/ingest").flatMap((r) => JSON.parse(r.bodyString).context);
    assert.deepEqual(sent.map((i) => i.context_id), ["ok-1"], "the oversized item was not sent");
    tests += 1;
  }

  // 6) The layout: cached on disk across processes, probed with a short
  //    timeout, a failed probe logged and read as "unknown", and a KNOWN split
  //    database never retried as unified.
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-layout-"));
    const cacheFile = path.join(dir, "layout-cache.json");
    const sink = [];
    const make = () => new HydraClient({ ...SCOPE, layoutCacheFile: cacheFile, fetch: capturingFetch(sink, () => unifiedProbe) });
    assert.equal(await make().isUnified(), true);
    assert.equal(await make().isUnified(), true, "a second hook process reads the cache");
    assert.equal(sink.filter((r) => r.path === "/databases").length, 1, "one probe for both processes");

    const events = [];
    const failing = new HydraClient({
      ...SCOPE,
      onDebug: (event, payload) => events.push({ event, payload }),
      fetch: capturingFetch([], () => ({ __status: 500, success: false, error: { message: "boom" } }))
    });
    assert.equal(await failing.layoutState(), "unknown");
    assert.equal(events[0]?.event, "layout-probe", "a failed probe is logged, not swallowed");

    const refusal = {
      __status: 400,
      success: false,
      error: { code: "CORPUS_TYPE_UNSUPPORTED", message: 'type "memory" is not valid on a unified database' }
    };
    const splitSink = [];
    const knownSplit = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(splitSink, (req) => (req.path === "/databases" ? splitProbe : refusal))
    });
    await assert.rejects(() => knownSplit.addMemories([{ text: "a", source_id: "a" }]));
    assert.equal(
      splitSink.filter((r) => r.path === "/context/ingest").length,
      1,
      "a known split database is not retried as unified"
    );
    tests += 1;
  }

  // 7) Workspace sync on a unified database cuts files to server-sized pieces
  //    (a knowledge-bound file too big to go whole takes the chunked path),
  //    and one refused batch no longer aborts the others.
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydradb-sync-unified-"));
    const big = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${"lorem ipsum ".repeat(2500)}`).join("\n\n");
    await fs.writeFile(path.join(dir, "BIG.md"), big, "utf8");
    await fs.writeFile(path.join(dir, "SMALL.md"), "# Small\nok\n", "utf8");
    const sink = [];
    const client = new HydraClient({
      ...SCOPE,
      fetch: capturingFetch(sink, (req) => (req.path === "/databases" ? unifiedProbe : ingest202(JSON.parse(req.bodyString).context)))
    });
    const state = { files: {}, sessions: {}, lastSessionId: "", lastRecall: null };
    const summary = await syncWorkspace({
      client,
      config: {
        includeGlobs: ["*.md"],
        excludeGlobs: [],
        maxFileSizeBytes: 50 * 1024 * 1024,
        maxFilesPerSync: 25,
        maxMemoryCharsPerChunk: 50 * 1024 * 1024,
        maxMemoryChunksPerFile: 1,
        ingestionMode: "auto",
        writeTimeoutMs: 15000,
        userName: "",
        workspaceMemoryCustomInstructions: ""
      },
      projectRoot: dir,
      workspaceName: "t",
      state
    });
    const items = sink.filter((r) => r.path === "/context/ingest").flatMap((r) => assertStrictBody(r.bodyString).context);
    assert.ok(big.length > UNIFIED_MAX_CHUNK_CHARS);
    assert.ok(items.length >= 3, `BIG.md was chunked (${items.length} items)`);
    assert.ok(items.every((i) => (i.text || "").length <= UNIFIED_MAX_CHUNK_CHARS), "every piece fits the unified cap");
    assert.equal(summary.errors.length, 0, summary.errors.join("; "));
    assert.equal(Object.keys(state.files).length, 2, "both files recorded as synced");
    tests += 1;
  }

  return { tests };
}
