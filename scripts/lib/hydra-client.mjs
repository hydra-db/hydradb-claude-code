import { createHydraWrapper } from "./hydra/index.mjs";
import { redactSecrets, unwrapAppKnowledgeEnvelope } from "./sanitize.mjs";

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
    return unwrapAppKnowledgeEnvelope(chunk.chunk_content);
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
            unwrapAppKnowledgeEnvelope(
              entry.chunk_content ||
                entry.chunk_text ||
                entry.text ||
                entry.content?.text ||
                entry.content ||
                ""
            )
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

// Reads the historical snake_case retrieval shape. Its input already arrives
// snake_cased: recall flows through the wrapper's single normalization seam
// (scripts/lib/hydra/), which unwraps and snake_cases every SDK response, and
// the check/golden fixtures are authored snake_case. The polymorphic normalizer
// is otherwise kept verbatim — it still tolerates the many v1 field spellings.
export function normalizeRetrievalResponse(response) {
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

// PRO-1618: the server's machine-readable code for a `type` the addressed
// database does not accept (hydradb-application #870, handler/errors.go). It
// names the FAMILY, not the member: the same code covers knowledge/memory on a
// unified database, `unified` on a split one, and `all` on an ingest. Only the
// first of those is ours to retry, so the code narrows and the message decides.
export const CORPUS_TYPE_UNSUPPORTED_CODE = "CORPUS_TYPE_UNSUPPORTED";

// The two siblings under that code, excluded first. Both name a unified
// database while telling you this one is SPLIT, or that the value is wrong
// whatever the layout; retrying either as unified turns a clear 400 into a
// second, more confusing one.
const OTHER_CORPUS_REFUSAL_RE = /only valid on a unified database|only supported on a unified database|invalid type ['"]all['"]/i;

// The wording of the refusal that IS ours, for a server that sends no code (an
// older build, a proxy that ate the envelope). Two validators answer it:
//
//   corpus type validator: `type "memory" is not valid on a unified database: …`
//   ingest body validator: `this database is unified: send the content as …`
//
// The server treats this text as a contract precisely because clients match on
// it, so it stays as the fallback rather than being deleted once the code ships.
const UNIFIED_LAYOUT_REFUSAL_RE = /is not valid on a unified database|this database is unified/i;

// Whether an error is the server refusing a split-era `type` on a unified
// database. Exported so the conformance tests pin every branch.
export function isUnifiedLayoutRefusal(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (OTHER_CORPUS_REFUSAL_RE.test(message)) {
    return false;
  }
  if (error?.errorCode === CORPUS_TYPE_UNSUPPORTED_CODE) {
    return true;
  }
  return UNIFIED_LAYOUT_REFUSAL_RE.test(message);
}

// PRO-1618: the unified item shape. One memory-shaped record becomes one item
// (text or a role/content conversation); the field names are the ones the
// redesign settled on. Exported so the check script can pin the mapping.
//
// `is_markdown` and `user_name` are carried, not dropped: `is_markdown` changes
// how the server chunks and renders the body and `user_name` is the
// attribution, so losing either would make the same file ingest differently
// depending on the database's layout with nothing in the output to say so.
// MemoryItem has always had both; items[] gained them in hydradb-application
// #870.
export function memoryToItem(memory) {
  const item = {};
  const conversation = Array.isArray(memory.user_assistant_pairs)
    ? memory.user_assistant_pairs
    : null;
  if (memory.text != null) {
    item.text = memory.text;
  }
  if (conversation) {
    // `name` is the per-turn speaker identity on IngestItem.conversation — the
    // one place the server accepts an attribution.
    item.conversation = conversation.flatMap((pair) => [
      { role: "user", content: pair.user, ...(memory.user_name ? { name: memory.user_name } : {}) },
      { role: "assistant", content: pair.assistant }
    ]);
  }
  if (memory.is_markdown != null) {
    item.is_markdown = memory.is_markdown;
  }
  // A conversation's attribution rides on the per-turn `name` above, which is
  // what the server reads first; only a text item needs the item-level field.
  if (!conversation && memory.user_name) {
    item.user_name = memory.user_name;
  }
  if (memory.source_id) {
    item.context_id = memory.source_id;
  }
  if (memory.title) {
    item.title = memory.title;
  }
  item.enrich = memory.infer ?? true;
  if (item.enrich && memory.custom_instructions) {
    item.custom_instructions = memory.custom_instructions;
  }
  if (memory.tenant_metadata != null) {
    item.attributes = parseMaybeJson(memory.tenant_metadata);
  }
  if (memory.document_metadata != null) {
    item.custom_attributes = parseMaybeJson(memory.document_metadata);
  }
  return item;
}

// A structured app-knowledge record (the workspace sync's knowledge target) as
// a unified item: the text is the body, the client-assigned id is kept.
//
// The field names here are the ones buildKnowledgeItem (workspace-sync.mjs)
// actually emits — `metadata`/`additional_metadata`, plus source/description/
// url/timestamp. `tenant_metadata`/`app_metadata` are kept only as aliases for
// a hand-built record; the producer has never emitted them, so reading only
// those is what stripped every workspace file down to bare text and a
// context_id on a unified database while the split lane kept the lot.
export function appKnowledgeToItem(record) {
  const item = {
    text: record?.content?.text ?? record?.text ?? "",
    enrich: record?.infer ?? true
  };
  if (record?.id) {
    item.context_id = record.id;
  }
  if (record?.title) {
    item.title = record.title;
  }
  if (record?.timestamp) {
    item.happened_at = record.timestamp;
  }
  const attributes = record?.metadata ?? record?.tenant_metadata;
  if (attributes != null) {
    item.attributes = parseMaybeJson(attributes);
  }
  // source/description/url have no field of their own on IngestItem, so they
  // ride in custom_attributes next to additional_metadata rather than being
  // dropped — losing the hydradb://workspace/<name>/<path> url is what made a
  // synced file unattributable on a unified database.
  const customAttributes = {
    ...(parseMaybeJson(record?.additional_metadata ?? record?.app_metadata) ?? {})
  };
  for (const field of ["source", "description", "url"]) {
    if (record?.[field] != null) {
      customAttributes[field] = record[field];
    }
  }
  if (Object.keys(customAttributes).length) {
    item.custom_attributes = customAttributes;
  }
  return item;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
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

  // PRO-1618: whether the configured database keeps one corpus. Resolved once
  // per process from GET /databases; a failed probe reads as split, so every
  // existing configuration behaves exactly as before.
  async isUnified() {
    if (!this._unifiedPromise) {
      this._unifiedPromise = this._hydra.databases
        .layout(this.tenantId)
        .then((layout) => layout === "unified")
        .catch(() => false);
    }
    return this._unifiedPromise;
  }

  // The server names the rule when a split kind reaches a unified database.
  // When the layout probe could not tell (it failed, or the database was not in
  // the list it saw), that answer IS the layout: run the unified form once and
  // pin the layout only once that retry has actually succeeded. Pinning first
  // meant a retry that failed for an unrelated reason (a timeout, a 500) left
  // the process sending unified for its whole lifetime against a database that
  // may well be split.
  async _retryAsUnified(error, retry) {
    if (isUnifiedLayoutRefusal(error) && !(await this.isUnified())) {
      const result = await retry();
      this._unifiedPromise = Promise.resolve(true);
      return result;
    }
    throw error;
  }

  // One ranked list over everything in a unified database (no corpus selector).
  async recallUnified(query, options = {}) {
    return normalizeRetrievalResponse(
      await this._hydra.context.query(
        {
          query,
          kind: "unified",
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

  async addItems(items, options = {}) {
    return this._hydra.context.ingest(
      { items, upsert: options.upsert ?? true },
      { timeoutMs: options.timeoutMs ?? this.writeTimeoutMs }
    );
  }

  async recallMemories(query, options = {}) {
    try {
      return await this._recallMemories(query, options);
    } catch (error) {
      return this._retryAsUnified(error, () => this.recallUnified(query, options));
    }
  }

  async _recallMemories(query, options = {}) {
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
    try {
      return await this._recallKnowledge(query, options);
    } catch (error) {
      return this._retryAsUnified(error, () => this.recallUnified(query, options));
    }
  }

  async _recallKnowledge(query, options = {}) {
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
    if (await this.isUnified()) {
      // A unified database refuses the split-era `memories` field; the same
      // records go as items[] and land in the one corpus.
      return this.addItems(memories.map(memoryToItem), options);
    }
    // The SDK carries memory items as a JSON string in the multipart `memories`
    // field; scope and type=memory are supplied by the wrapper.
    try {
      return await this._hydra.context.ingest(
        {
          kind: "memory",
          memories: JSON.stringify(memories),
          upsert: options.upsert ?? true
        },
        { timeoutMs: options.timeoutMs ?? this.writeTimeoutMs }
      );
    } catch (error) {
      return this._retryAsUnified(error, () => this.addItems(memories.map(memoryToItem), options));
    }
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
    if (await this.isUnified()) {
      return this._uploadKnowledgeUnified(appKnowledge);
    }
    // DX-G-002 fix: knowledge ingests via the SDK's multipart context.ingest,
    // carrying the structured items in `appKnowledge` (a JSON string). That is
    // multipart with a top-level tenant_id and preserves each item's
    // client-assigned `id` verbatim — never the old JSON `{app_knowledge:[…]}`
    // body, and never a v1 `app_sources` field.
    try {
      return await this._hydra.context.ingest(
        {
          kind: "knowledge",
          appKnowledge: JSON.stringify(appKnowledge)
        },
        { timeoutMs: this.writeTimeoutMs }
      );
    } catch (error) {
      // The knowledge lane needs the same recovery every other layout-sensitive
      // call has. Without it one flaky GET /databases pinned the process to
      // "split" and every knowledge write 400d for the rest of its life, while
      // the memory-lane files in the very same sync recovered.
      return this._retryAsUnified(error, () => this._uploadKnowledgeUnified(appKnowledge));
    }
  }

  async _uploadKnowledgeUnified(appKnowledge) {
    const items = [];
    for (const record of appKnowledge || []) {
      const item = appKnowledgeToItem(record);
      // Server validation is per item but all-or-nothing for the request, so a
      // single empty record would 400 the whole batch — where the split lane
      // simply stored it. Drop it here, loudly, and let the rest through.
      if (!item.text || !item.text.trim()) {
        process.stderr.write(
          `[hydradb] skipping empty knowledge record ${record?.id || "(no id)"}: a unified ` +
            "ingest rejects an item with no text, and one would fail the whole batch.\n"
        );
        continue;
      }
      items.push(item);
    }
    if (!items.length) {
      return { success_count: 0, failed_count: 0 };
    }
    return this.addItems(items, { upsert: true });
  }

  // Returns { deletedIds, failedIds, data }: which ids the server confirmed
  // deleted vs. which it did not. The caller reconciles per id — dropping tracked
  // state only for confirmed deletes and retaining the rest for retry — instead
  // of treating a batched delete as an all-or-nothing success (the second silent
  // bug, where a no-op/partial delete dropped state for context still stored).
  async deleteMemories(memoryIds, options = {}) {
    const ids = (memoryIds || []).filter(Boolean);
    if (!ids.length) {
      return { deletedIds: [], failedIds: [] };
    }
    const timeoutMs = options.timeoutMs ?? this.writeTimeoutMs;
    const kind = (await this.isUnified()) ? "unified" : "memory";
    try {
      return await this._hydra.context.delete({ ids, kind }, { timeoutMs });
    } catch (error) {
      return this._retryAsUnified(error, () => this._hydra.context.delete({ ids, kind: "unified" }, { timeoutMs }));
    }
  }

  async deleteMemory(memoryId, options = {}) {
    if (!memoryId) {
      return { deletedIds: [], failedIds: [] };
    }
    return this.deleteMemories([memoryId], options);
  }

  async deleteKnowledge(ids, options = {}) {
    const knowledgeIds = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!knowledgeIds.length) {
      return { deletedIds: [], failedIds: [] };
    }
    const timeoutMs = options.timeoutMs ?? this.writeTimeoutMs;
    const kind = (await this.isUnified()) ? "unified" : "knowledge";
    try {
      return await this._hydra.context.delete({ ids: knowledgeIds, kind }, { timeoutMs });
    } catch (error) {
      return this._retryAsUnified(error, () =>
        this._hydra.context.delete({ ids: knowledgeIds, kind: "unified" }, { timeoutMs })
      );
    }
  }
}

export function combineRecallErrors(results) {
  return results
    .filter((entry) => entry.status === "rejected")
    .map((entry) => coerceErrorMessage(entry.reason));
}
