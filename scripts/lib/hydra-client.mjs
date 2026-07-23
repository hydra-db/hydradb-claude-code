import { createHydraWrapper, snakeCaseKeys } from "./hydra/index.mjs";
import { redactSecrets } from "./sanitize.mjs";

const DEFAULT_API_BASE = "https://api.hydradb.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_WRITE_TIMEOUT_MS = 15000;

export const DEFAULT_MEMORY_CAPTURE_INSTRUCTIONS =
  "Extract durable user preferences, working style, project decisions, recurring constraints, " +
  "team conventions, and follow-up commitments. Ignore credentials, transient tool noise, " +
  "and low-value chit-chat.";

export const DEFAULT_WORKSPACE_MEMORY_INSTRUCTIONS =
  "Extract durable repository knowledge from documentation, specs, notes, architecture decisions, " +
  "runbooks, and reference content. Prefer stable facts, conventions, requirements, workflows, " +
  "and decisions. Ignore transient chatter, secrets, and code-only implementation details.";

function coerceErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function trimText(value, maxLength = 1200) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function extractChunkText(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return "";
  }

  if (typeof chunk.chunk_content === "string") {
    return chunk.chunk_content;
  }

  if (typeof chunk.text === "string") {
    return chunk.text;
  }

  if (typeof chunk.chunk_text === "string") {
    return chunk.chunk_text;
  }

  if (typeof chunk.content === "string") {
    return chunk.content;
  }

  if (chunk.content && typeof chunk.content.text === "string") {
    return chunk.content.text;
  }

  if (typeof chunk.snippet === "string") {
    return chunk.snippet;
  }

  return "";
}

function extractChunkTitle(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return "";
  }

  return (
    chunk.title ||
    chunk.source_title ||
    chunk.document_title ||
    chunk.source_id ||
    chunk.id ||
    chunk.metadata?.title ||
    ""
  );
}

function extractChunkUuid(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return "";
  }

  return chunk.chunk_uuid || chunk.chunk_id || chunk.id || chunk.source_id || "";
}

function extractExtraContextIds(chunk) {
  if (!chunk || typeof chunk !== "object" || !Array.isArray(chunk.extra_context_ids)) {
    return [];
  }

  return chunk.extra_context_ids.filter((entry) => typeof entry === "string").slice(0, 8);
}

function extractChunkRelations(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return [];
  }

  const relations =
    chunk.graph_context?.chunk_relations ||
    chunk.chunk_relations ||
    chunk.relations ||
    [];

  if (!Array.isArray(relations)) {
    return [];
  }

  return relations
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object") {
        return entry.relation || entry.label || JSON.stringify(entry);
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 3);
}

function sanitizeNode(node) {
  if (typeof node === "string") {
    return { name: trimText(redactSecrets(node), 120) };
  }

  if (!node || typeof node !== "object") {
    return { name: "" };
  }

  return {
    name: trimText(redactSecrets(node.name || node.label || node.id || ""), 120)
  };
}

function sanitizeRelation(relation) {
  if (typeof relation === "string") {
    return { canonical_predicate: trimText(redactSecrets(relation), 80) };
  }

  if (!relation || typeof relation !== "object") {
    return {};
  }

  return {
    canonical_predicate: trimText(
      redactSecrets(
        relation.canonical_predicate || relation.predicate || relation.label || relation.type || ""
      ),
      80
    ),
    context: trimText(redactSecrets(relation.context || relation.description || ""), 180),
    temporal_details: trimText(
      redactSecrets(relation.temporal_details || relation.time || ""),
      80
    )
  };
}

function sanitizeTriplet(triplet) {
  if (!triplet || typeof triplet !== "object") {
    return null;
  }

  return {
    source: sanitizeNode(triplet.source),
    relation: sanitizeRelation(triplet.relation),
    target: sanitizeNode(triplet.target)
  };
}

function sanitizePath(path) {
  if (typeof path === "string") {
    return trimText(redactSecrets(path), 160);
  }

  if (!path || typeof path !== "object") {
    return null;
  }

  const triplets = Array.isArray(path.triplets)
    ? path.triplets.map((triplet) => sanitizeTriplet(triplet)).filter(Boolean)
    : [];

  if (!triplets.length) {
    const label = trimText(redactSecrets(path.path || path.label || ""), 160);
    return label || null;
  }

  return { triplets };
}

function sanitizeChunkRelation(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const triplets = Array.isArray(entry.triplets)
    ? entry.triplets.map((triplet) => sanitizeTriplet(triplet)).filter(Boolean)
    : [];

  if (!triplets.length) {
    return null;
  }

  return {
    groupId: trimText(redactSecrets(entry.group_id || entry.groupId || ""), 80),
    triplets
  };
}

function sanitizeChunkIdToGroupIds(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([chunkId, groupIds]) => [
        trimText(redactSecrets(chunkId), 120),
        Array.isArray(groupIds)
          ? groupIds
              .filter((entry) => typeof entry === "string")
              .map((entry) => trimText(redactSecrets(entry), 80))
              .filter(Boolean)
              .slice(0, 12)
          : []
      ])
      .filter(([chunkId, groupIds]) => chunkId && groupIds.length)
  );
}

function sanitizeAdditionalContextMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([id, entry]) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const sourceTitle = trimText(
          redactSecrets(entry.source_title || entry.title || entry.document_title || ""),
          120
        );
        const chunkContent = trimText(
          redactSecrets(
            entry.chunk_content ||
              entry.chunk_text ||
              entry.text ||
              entry.content?.text ||
              entry.content ||
              ""
          )
        );

        if (!sourceTitle && !chunkContent) {
          return null;
        }

        return [
          trimText(redactSecrets(id), 120),
          {
            source_title: sourceTitle,
            chunk_content: chunkContent
          }
        ];
      })
      .filter(Boolean)
  );
}

function extractQueryPaths(response) {
  const paths =
    response?.graph_context?.query_paths ||
    response?.query_paths ||
    response?.graph_context?.paths ||
    [];

  if (!Array.isArray(paths)) {
    return [];
  }

  return paths
    .map((entry) => {
      if (typeof entry === "string") {
        return trimText(redactSecrets(entry), 160);
      }
      if (entry && typeof entry === "object") {
        return trimText(redactSecrets(entry.path || entry.label || JSON.stringify(entry)), 160);
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 4);
}

function extractDetailedQueryPaths(response) {
  const paths =
    response?.graph_context?.query_paths ||
    response?.query_paths ||
    response?.graph_context?.paths ||
    [];

  if (!Array.isArray(paths)) {
    return [];
  }

  return paths.map((entry) => sanitizePath(entry)).filter(Boolean).slice(0, 4);
}

// The SDK deserializes the v2 wire response into camelCase (chunkContent,
// sourceTitle, graphContext, queryPaths, chunkIdToGroupIds, …) while the
// normalizer below reads the historical snake_case wire names. Rather than
// touch the polymorphic normalizer (kept verbatim — it still tolerates the many
// v1 field spellings), snake_case the input keys once at the door via the
// shared helper. Idempotent on already-snake_case input, so direct/legacy
// callers and the conformance golden fixtures are unaffected.
export function normalizeRetrievalResponse(rawResponse) {
  const response = snakeCaseKeys(rawResponse);
  const rawChunks = response?.chunks || response?.results || response?.context || [];
  const chunks = Array.isArray(rawChunks)
    ? rawChunks
        .map((chunk) => ({
          title: trimText(redactSecrets(extractChunkTitle(chunk)), 120),
          sourceTitle: trimText(redactSecrets(extractChunkTitle(chunk)), 120),
          text: trimText(redactSecrets(extractChunkText(chunk))),
          score:
            typeof chunk?.score === "number"
              ? chunk.score
              : typeof chunk?.relevance_score === "number"
                ? chunk.relevance_score
                : undefined,
          sourceId: chunk?.source_id || chunk?.id || "",
          chunkUuid: trimText(redactSecrets(extractChunkUuid(chunk)), 120),
          extraContextIds: extractExtraContextIds(chunk).map((entry) =>
            trimText(redactSecrets(entry), 120)
          ),
          relations: extractChunkRelations(chunk).map((entry) =>
            trimText(redactSecrets(entry), 120)
          )
        }))
        .filter((chunk) => chunk.text)
    : [];

  const graphContext = {
    queryPathsDetailed: extractDetailedQueryPaths(response),
    chunkRelations: Array.isArray(response?.graph_context?.chunk_relations)
      ? response.graph_context.chunk_relations
          .map((entry) => sanitizeChunkRelation(entry))
          .filter(Boolean)
          .slice(0, 12)
      : [],
    chunkIdToGroupIds: sanitizeChunkIdToGroupIds(response?.graph_context?.chunk_id_to_group_ids)
  };

  return {
    chunks,
    queryPaths: extractQueryPaths(response),
    graphContext,
    additionalContext: sanitizeAdditionalContextMap(
      response?.additional_context || response?.additionalContext
    )
  };
}

export class HydraClient {
  constructor({
    apiKey,
    tenantId,
    subTenantId,
    baseUrl = DEFAULT_API_BASE,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
    // Test seams only (never set in production): inject a capturing fetch or a
    // spy SDK client so wire-level tests need no network. Forwarded verbatim.
    fetch: fetchImpl,
    sdkClient
  } = {}) {
    // Kept as public fields: plugin code duck-types tenantId/subTenantId
    // (workspace-sync.mjs) and other call sites read them directly.
    this.tenantId = tenantId;
    this.subTenantId = subTenantId;
    this.requestTimeoutMs = requestTimeoutMs;
    this.writeTimeoutMs = writeTimeoutMs;
    // All wire I/O now flows through the canonical wrapper over the vendored SDK.
    this._hydra = createHydraWrapper({
      apiKey,
      tenantId,
      subTenantId,
      baseUrl,
      requestTimeoutMs,
      writeTimeoutMs,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(sdkClient ? { sdkClient } : {})
    });
  }

  async recallMemories(query, options = {}) {
    return normalizeRetrievalResponse(
      await this._hydra.context.query(
        {
          query,
          kind: "memory",
          mode: options.mode || "fast",
          maxResults: options.maxResults || 6,
          alpha: 0.8,
          recencyBias: options.recencyBias ?? 0,
          graphContext: options.graphContext ?? true
        },
        { timeoutMs: options.timeoutMs ?? this.requestTimeoutMs }
      )
    );
  }

  async recallKnowledge(query, options = {}) {
    return normalizeRetrievalResponse(
      await this._hydra.context.query(
        {
          query,
          kind: "knowledge",
          mode: options.mode || "fast",
          maxResults: options.maxResults || 6,
          alpha: 0.8,
          recencyBias: options.recencyBias ?? 0,
          graphContext: options.graphContext ?? true
        },
        { timeoutMs: options.timeoutMs ?? this.requestTimeoutMs }
      )
    );
  }

  async addMemories(memories, options = {}) {
    // The SDK carries memory items as a JSON string in the multipart `memories`
    // field; scope and type=memory are supplied by the wrapper.
    return this._hydra.context.ingest(
      {
        kind: "memory",
        memories: JSON.stringify(memories),
        upsert: options.upsert ?? true
      },
      { timeoutMs: options.timeoutMs ?? this.writeTimeoutMs }
    );
  }

  async addTextMemory(text, options = {}) {
    const infer = options.infer ?? true;
    return this.addMemories(
      [
        {
          text,
          infer,
          is_markdown: options.isMarkdown ?? false,
          title: options.title || undefined,
          user_name: options.userName || undefined,
          custom_instructions:
            infer ? options.customInstructions || DEFAULT_MEMORY_CAPTURE_INSTRUCTIONS : undefined,
          source_id: options.sourceId || undefined
        }
      ],
      { upsert: options.upsert ?? true }
    );
  }

  async addConversationMemory(userText, assistantText, options = {}) {
    return this.addMemories(
      [
        {
          user_assistant_pairs: [
            {
              user: userText,
              assistant: assistantText
            }
          ],
          infer: true,
          user_name: options.userName || undefined,
          custom_instructions:
            options.customInstructions || DEFAULT_MEMORY_CAPTURE_INSTRUCTIONS,
          source_id: options.sourceId || undefined
        }
      ],
      { upsert: options.upsert ?? true }
    );
  }

  async uploadKnowledge(appKnowledge) {
    // DX-G-002 fix: knowledge ingests via the SDK's multipart context.ingest,
    // carrying the structured items in `appKnowledge` (a JSON string). That is
    // multipart with a top-level tenant_id and preserves each item's
    // client-assigned `id` verbatim — never the old JSON `{app_knowledge:[…]}`
    // body, and never a v1 `app_sources` field.
    return this._hydra.context.ingest(
      {
        kind: "knowledge",
        appKnowledge: JSON.stringify(appKnowledge)
      },
      { timeoutMs: this.writeTimeoutMs }
    );
  }

  async deleteMemories(memoryIds, options = {}) {
    const ids = (memoryIds || []).filter(Boolean);
    if (!ids.length) {
      return { success: true, user_memory_deleted: false };
    }
    // One batched delete on the canonical path. The wrapper raises on a
    // {success:false}/user_memory_deleted:false body instead of letting the old
    // silent 200 be counted as a successful delete (the second silent bug).
    return this._hydra.context.delete(
      { ids, kind: "memory" },
      { timeoutMs: options.timeoutMs ?? this.writeTimeoutMs }
    );
  }

  async deleteMemory(memoryId, options = {}) {
    if (!memoryId) {
      return { success: true, user_memory_deleted: false };
    }
    return this.deleteMemories([memoryId], options);
  }

  async deleteKnowledge(ids, options = {}) {
    const knowledgeIds = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!knowledgeIds.length) {
      return { success: true, deleted_count: 0, results: [] };
    }
    return this._hydra.context.delete(
      { ids: knowledgeIds, kind: "knowledge" },
      { timeoutMs: options.timeoutMs ?? this.writeTimeoutMs }
    );
  }
}

export function combineRecallErrors(results) {
  return results
    .filter((entry) => entry.status === "rejected")
    .map((entry) => coerceErrorMessage(entry.reason));
}
