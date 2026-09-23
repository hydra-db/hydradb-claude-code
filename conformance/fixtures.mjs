// Shared response fixtures for the wire and golden tests.
//
// Two shapes come back from POST /query and both stay live: a split database
// (and every stored log) keeps producing the v2 shape, a unified database
// (PRO-1618) answers with the four-key body. The parser must tell them apart by
// shape, so both fixtures live here and both goldens are cut from them.

// The v2 shape a SPLIT database returns. Exercises every branch of the legacy
// normalizer: chunk_content with and without the app-knowledge envelope,
// score vs relevance_score, detailed query paths (triplets) beside a bare
// string path, chunk relations reached through chunk_id_to_group_ids, and
// additional_context reached through extra_context_ids.
export const SPLIT_QUERY_RESPONSE = {
  chunks: [
    {
      chunk_uuid: "c1",
      chunk_content: "workspace overview: build with make smoke",
      source_title: "README.md",
      source_id: "s1",
      score: 0.5,
      extra_context_ids: ["x1"],
      graph_context: { chunk_relations: [{ relation: "depends_on" }] }
    },
    {
      chunk_uuid: "c2",
      chunk_content: JSON.stringify({
        id: "claude-file:abc",
        content: { text: "# Smoke\nBuild with `make smoke`.", html_base64: "", files: [] }
      }),
      source_title: "CLAUDE.md",
      source_id: "s2",
      relevance_score: 0.4
    }
  ],
  graph_context: {
    query_paths: [
      {
        triplets: [
          {
            source: { name: "plugin" },
            relation: { canonical_predicate: "syncs", context: "syncs markdown docs", temporal_details: "since v1" },
            target: { name: "HydraDB" }
          }
        ]
      },
      "a -> b"
    ],
    chunk_relations: [{ group_id: "g1", triplets: [{ source: "a", relation: "rel", target: "b" }] }],
    chunk_id_to_group_ids: { c1: ["g1"] }
  },
  additional_context: { x1: { source_title: "notes.md", chunk_content: "detail about smoke" } }
};

// The four-key body a UNIFIED database returns (CONTRACT.md, POST /query):
// chunks, graph, forceful_relations, llm_prompt and nothing else. Field names
// are the contract's exactly: enrichment is a plain string with its
// enrichment_kind beside it (the second chunk has a kind and no enrichment,
// the forceful chunk carries both), graph[] carries one path of each origin,
// and the llm_prompt is the server's markdown layout (`## Results`,
// `### R1.`, `[P1]`) that the plugin must surface verbatim.
export const UNIFIED_QUERY_RESPONSE = {
  chunks: [
    {
      chunk_id: "ck_9f2",
      context_id: "chat-2026-07-29#w2",
      score: 0.87,
      content: "user: Keep answers short please\nassistant: Got it.",
      enrichment: "User prefers short, bullet-point answers.",
      enrichment_kind: "user_preference"
    },
    {
      chunk_id: "ck_1a0",
      context_id: "policy-1",
      score: 0.61,
      content: "Refund policy: 30-day window.",
      enrichment_kind: "business_knowledge",
      temporal: [
        {
          content: "Refund window was 14 days. Start: 2025-01-01, End: 2026-06-30",
          start_date: "2025-01-01",
          end_date: "2026-06-30"
        }
      ]
    }
  ],
  graph: [
    {
      origin: "query_path",
      triplets: [
        {
          source: { entity_id: "ent_a3f", name: "John" },
          relation: {
            predicate: "subscribed to",
            context: "John subscribed to the Pro plan.",
            temporal_details: "since June",
            relationship_id: "rel_1",
            chunk_id: "ck_9f2"
          },
          target: { entity_id: "ent_9c1", name: "Pro plan" }
        }
      ],
      path_summary: "John is on the Pro plan since June 2026."
    },
    {
      origin: "chunk_relation",
      triplets: [
        {
          source: { entity_id: "ent_rp1", name: "Refund policy" },
          relation: {
            predicate: "allows refunds within",
            context: "Refund policy: 30-day window.",
            relationship_id: "rel_2",
            chunk_id: "ck_1a0"
          },
          target: { entity_id: "ent_30d", name: "30 days" }
        }
      ],
      path_summary: "The refund policy allows refunds within 30 days."
    }
  ],
  forceful_relations: [
    {
      via: { from: "linear-PRO-1169", to: "linear-PRO-1169-comment-4" },
      chunk: {
        chunk_id: "ck_7b3",
        context_id: "linear-PRO-1169-comment-4",
        score: 0.42,
        content: "Comment 4: shipped the fix in #1625.",
        enrichment: "The PRO-1169 fix shipped in #1625.",
        enrichment_kind: "decision_trace"
      }
    }
  ],
  llm_prompt: [
    "# Query results",
    "",
    "**Query:** what plan is John on",
    "**Found:** 2 results across 2 sources · 2 related facts · 1 temporal fact · 1 forceful relation",
    "Cite a result by its number in brackets, e.g. [1].",
    "",
    "## Results",
    "",
    "### 1. Support chat with John",
    "- **Relevance:** 0.87 · **Category:** user_preference",
    "- **Id:** chat-2026-07-29#w2",
    "",
    "user: Keep answers short please",
    "assistant: Got it.",
    "",
    "**Enrichment:** User prefers short, bullet-point answers.",
    "",
    "---",
    "",
    "### 2. Refund policy",
    "- **Relevance:** 0.61 · **Category:** business_knowledge",
    "- **Id:** policy-1",
    "",
    "Refund policy: 30-day window.",
    "",
    "## Forceful relations",
    "",
    "Linked to a result by the author at ingest time (forceful_relations), not by relevance to this query.",
    "",
    "### R1. PRO-1169 comment 4",
    "- **Linked from:** linear-PRO-1169 · **Category:** decision_trace",
    "- **Id:** linear-PRO-1169-comment-4",
    "",
    "Comment 4: shipped the fix in #1625.",
    "",
    "**Enrichment:** The PRO-1169 fix shipped in #1625.",
    "",
    "## Related facts",
    "",
    "- [P1] **John** -subscribed to→ **Pro plan** (query path, relevance 0.87) [1]",
    "  John is on the Pro plan since June 2026.",
    "- [P2] **Refund policy** -allows refunds within→ **30 days** (chunk relation, relevance 0.61) [2]",
    "  The refund policy allows refunds within 30 days.",
    "",
    "## Temporal facts",
    "",
    "- **Refund window** *was* → **14 days** (from 2025-01-01 to 2026-06-30) [2]",
    "",
    "## Sources",
    "",
    "1. **Support chat with John** (message, id: chat-2026-07-29#w2)",
    "2. **Refund policy** (file, id: policy-1)",
    "3. **PRO-1169 comment 4** (id: linear-PRO-1169-comment-4)"
  ].join("\n")
};

// The envelope `meta` of a unified /query (CONTRACT): request_id, api_version,
// latency_ms, database, collection. A unified meta has NO tenant_id,
// sub_tenant_id or source_type, and nothing on the unified path reads them.
export const UNIFIED_QUERY_META = {
  request_id: "req_7c1",
  api_version: "2",
  latency_ms: 42,
  database: "db_test",
  collection: "col_test"
};
