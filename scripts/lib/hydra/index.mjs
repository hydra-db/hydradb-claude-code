// The canonical HydraDB wrapper (CONTRACT §2). It owns the exact-pinned SDK —
// imported from the committed, self-contained vendored bundle so the plugin
// runtime needs no node_modules — and exposes the canonical vocabulary, mapping
// each method to whatever the current SDK calls it. This layer is the firewall
// between the SDK's summary-text-derived method names and the plugin.
//
// Responsibilities (CONTRACT §2 rules): exact pin (the bundle is built from a
// pinned devDependency), unwrap the HandlerEnvelope by checking its shape,
// supply token/base_url/database/collection from config, translate SDK errors
// into plain Errors the plugin already understands, cap retries under the hook
// budgets, and send API-Version: 2 (the SDK does this).

import { HydraDBClient, HydraDBError, HydraDBTimeoutError } from "../../vendor/hydradb-sdk.mjs";

const DEFAULT_API_BASE = "https://api.hydradb.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_WRITE_TIMEOUT_MS = 15000;

// Recall failures must degrade, never hang a hook. A retrying SDK inside a 20s
// UserPromptSubmit/Stop budget turns a fast failure into a hook timeout, so we
// cap retries at zero and let a single attempt run under the per-call timeout.
const MAX_RETRIES = 0;

// A plain Error type so nothing downstream has to know about SDK exception
// classes (CONTRACT §2 rule 4).
export class HydraWrapperError extends Error {
  constructor(message) {
    super(message);
    this.name = "HydraWrapperError";
  }
}

function coerceBody(body) {
  if (body == null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function translateError(error, label, timeoutMs) {
  if (error instanceof HydraWrapperError) {
    return error;
  }
  if (error instanceof HydraDBTimeoutError) {
    return new HydraWrapperError(`${label} timed out after ${timeoutMs}ms`);
  }
  if (error instanceof HydraDBError) {
    const status = error.statusCode != null ? ` with ${error.statusCode}` : "";
    const body = coerceBody(error.body);
    return new HydraWrapperError(`${label} failed${status}${body ? `: ${body}` : ""}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new HydraWrapperError(`${label} failed: ${message}`);
}

// The SDK deserializes the v2 wire response into camelCase (deletedCount,
// userMemoryDeleted, chunkContent, …) while the plugin's historical logic reads
// snake_case wire names. Recursively snake_case object keys so both the delete
// no-op detection here and the retrieval normalizer (which imports this) can
// read one spelling. Idempotent on already-snake_case input; values untouched.
export function snakeCaseKeys(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => snakeCaseKeys(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
        snakeCaseKeys(entry)
      ])
    );
  }
  return value;
}

// THE single normalization seam. Every wrapper method funnels its result
// through here: unwrap HandlerEnvelope{data,success,meta} → data (by shape,
// CONTRACT §2 rule 2 — never assumed), then snake_case the keys. The SDK
// deserializes EVERY v2 response to camelCase; doing the camelCase→snake_case
// conversion once, here, means every downstream reader (the retrieval
// normalizer, the delete no-op check, and any future caller) sees the plugin's
// historical snake_case shape and needs no per-site handling.
function unwrapAndNormalize(value) {
  const data =
    value && typeof value === "object" && "data" in value && ("success" in value || "meta" in value)
      ? value.data
      : value;
  return snakeCaseKeys(data);
}

// Envelope-level success flag. `success` is spelled the same in camelCase and
// snake_case, so this reads the raw envelope directly.
function isEnvelopeSuccessFalse(value) {
  return Boolean(value && typeof value === "object" && "success" in value && value.success === false);
}

// Deletion is inherently PER ID: a batched delete can return a mix of deleted
// and not-deleted items, so a whole-batch success/no-op question is the wrong
// shape. Given the requested ids and the (seam-normalized) delete response,
// return exactly which ids the server CONFIRMS were deleted; every other
// requested id is a failure the caller must retain and retry. Derived from the
// SDK delete type (HandlerEnvelopeSourcesMemoryDeleteResponse):
//   envelope.success / data.success  → boolean (false ⇒ nothing deleted)
//   data.results[].deleted           → per-item boolean, AUTHORITATIVE whenever
//                                       the array is present (even when empty)
//   data.deleted_count / user_memory_deleted → integers, mapped all-or-none only
//                                       when there is no per-item results array
// Counts are integers (0 = no match), so they are compared with `=== 0` / `>=`,
// never `=== false`. This one classification subsumes all-success, all-fail,
// partial/mixed, numeric-zero, per-item-error, and missing-field responses.
// A per-item delete error meaning the id is already absent. Deletion is
// idempotent: the caller's postcondition ("this id is no longer stored") holds,
// so this is a terminal success, not a retryable failure. Without this, a source
// the server already removed is retried on every full sync forever, and its
// tracked state is never dropped.
const ALREADY_ABSENT_ERROR = /not\s*found|does\s*not\s*exist|no\s*such|already\s*deleted/i;

function isAlreadyAbsent(result) {
  return typeof result?.error === "string" && ALREADY_ABSENT_ERROR.test(result.error);
}

function classifyDeletion(requestedIds, envelope, data) {
  const all = { deletedIds: [...requestedIds], failedIds: [] };
  const none = { deletedIds: [], failedIds: [...requestedIds] };
  if (!requestedIds.length) {
    return { deletedIds: [], failedIds: [] };
  }
  // Per-item detail wins over the batch-level rollup. `success` is a rollup: the
  // server reports success:false when ANY id in the batch was not deleted, which
  // includes a batch whose ids were all already absent. Checking the rollup first
  // would discard the per-item reasons that distinguish "failed" from "already
  // gone", so the results array is classified before the rollup is consulted.
  if (Array.isArray(data.results)) {
    // Confirm ids explicitly deleted:true, plus ids the server reports as
    // already absent — both leave the id not stored, which is what was asked.
    const confirmed = new Set(
      data.results
        .filter((r) => r && r.id != null && (r.deleted === true || isAlreadyAbsent(r)))
        .map((r) => String(r.id))
    );
    return {
      deletedIds: requestedIds.filter((id) => confirmed.has(String(id))),
      failedIds: requestedIds.filter((id) => !confirmed.has(String(id)))
    };
  }
  if (isEnvelopeSuccessFalse(envelope) || data.success === false) {
    return none;
  }
  // No per-item detail: fall back to the integer counts, all-or-none. A count
  // that covers every requested id (or the absence of any negative signal on an
  // otherwise-successful response) confirms all; a zero or partial count that
  // cannot be attributed to specific ids confirms none (retain + retry).
  const count =
    data.deleted_count !== undefined
      ? Number(data.deleted_count)
      : data.user_memory_deleted !== undefined
        ? Number(data.user_memory_deleted)
        : undefined;
  if (count === undefined || count >= requestedIds.length) {
    return all;
  }
  return none;
}

export function createHydraWrapper({
  apiKey,
  tenantId,
  subTenantId,
  baseUrl = DEFAULT_API_BASE,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
  // Injectable for conformance/HTTP tests; production builds the real client.
  sdkClient,
  fetch: fetchImpl
} = {}) {
  const database = tenantId || "";
  const collection = subTenantId ?? "";

  // Construct the SDK client lazily and defensively: a throw at construction
  // must never propagate into a hook. If it fails, calls translate the failure
  // like any other SDK error (and recall's allSettled degrades gracefully).
  let client = sdkClient ?? null;
  let constructionError = null;
  if (!client) {
    try {
      client = new HydraDBClient({
        token: apiKey,
        baseUrl: baseUrl.replace(/\/+$/g, ""),
        maxRetries: MAX_RETRIES,
        ...(fetchImpl ? { fetch: fetchImpl } : {})
      });
    } catch (error) {
      constructionError = error;
    }
  }

  // PRO-1618: the vendored SDK predates `items` on ingest, `type` on database
  // create and `details[]` on the database list, and it drops fields it does
  // not know. Those three calls go over the wire by hand, through the same
  // envelope unwrap and error translation, until the SDK is regenerated.
  const rawFetch = fetchImpl ?? globalThis.fetch;
  const rawBase = baseUrl.replace(/\/+$/g, "");
  async function rawJson(label, method, path, body, timeoutMs) {
    let response;
    try {
      response = await rawFetch(`${rawBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // CONTRACT S2 rule 6: every v2 call names its version.
          "API-Version": "2"
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new HydraWrapperError(`${label} timed out after ${timeoutMs}ms`);
      }
      throw translateError(error, label, timeoutMs);
    }
    const text = await response.text().catch(() => "");
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      throw new HydraWrapperError(`${label} failed with ${response.status}${text ? `: ${text}` : ""}`);
    }
    return unwrapAndNormalize(parsed);
  }

  function requestOptions(timeoutMs) {
    return { timeoutInSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)), maxRetries: MAX_RETRIES };
  }

  async function call(label, timeoutMs, invoke) {
    if (constructionError) {
      throw translateError(constructionError, label, timeoutMs);
    }
    try {
      return await invoke();
    } catch (error) {
      throw translateError(error, label, timeoutMs);
    }
  }

  // Scope every context call to the configured database/collection (canonical).
  function contextScope() {
    const scope = { database };
    if (collection !== "") {
      scope.collection = collection;
    }
    return scope;
  }

  const context = {
    async query(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      const request = {
        ...contextScope(),
        query: args.query,
        ...(args.kind ? { type: args.kind } : {}),
        ...(args.operator ? { operator: args.operator } : {}),
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.maxResults != null ? { maxResults: args.maxResults } : {}),
        ...(args.alpha != null ? { alpha: args.alpha } : {}),
        ...(args.recencyBias != null ? { recencyBias: args.recencyBias } : {}),
        ...(args.graphContext != null ? { graphContext: args.graphContext } : {})
      };
      return unwrapAndNormalize(
        await call("/query", timeoutMs, () => client.query(request, requestOptions(timeoutMs)))
      );
    },

    async ingest(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? writeTimeoutMs;
      if (args.items != null) {
        // The unified shape (PRO-1618): items[], each text or a conversation,
        // no corpus selector. On a split database they land in the memory
        // corpus; on a unified database they are the only shape accepted.
        return rawJson("/context/ingest", "POST", "/context/ingest", {
          ...contextScope(),
          items: args.items,
          ...(args.upsert != null ? { upsert: Boolean(args.upsert) } : {})
        }, timeoutMs);
      }
      // Ingest carries a top-level tenant_id (one of the DX-G-002 defects) and
      // the SAME canonical `collection` that delete uses, so an ingest and a
      // later delete resolve to the identical scope (the server filters delete
      // on database + collection; a mismatched scope silently deletes nothing).
      // Knowledge sources travel in `appKnowledge` (a JSON string of structured
      // items) which preserves each item's client-assigned `id` verbatim;
      // `app_sources` is a v1-only field and is never sent.
      const request = {
        database,
        tenantId: database,
        ...(collection !== "" ? { collection } : {}),
        ...(args.kind ? { type: args.kind } : {}),
        ...(args.appKnowledge != null ? { appKnowledge: args.appKnowledge } : {}),
        ...(args.memories != null ? { memories: args.memories } : {}),
        ...(args.documents != null ? { documents: args.documents } : {}),
        ...(args.upsert != null ? { upsert: String(args.upsert) } : {})
      };
      return unwrapAndNormalize(
        await call("/context/ingest", timeoutMs, () => client.context.ingest(request, requestOptions(timeoutMs)))
      );
    },

    async list(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      const request = { ...contextScope(), ...(args.kind ? { type: args.kind } : {}) };
      return unwrapAndNormalize(
        await call("/context/list", timeoutMs, () => client.context.list(request, requestOptions(timeoutMs)))
      );
    },

    async inspect(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      const request = { ...contextScope(), id: args.id, ...(args.mode ? { mode: args.mode } : {}) };
      return unwrapAndNormalize(
        await call("/context/inspect", timeoutMs, () => client.context.inspect(request, requestOptions(timeoutMs)))
      );
    },

    // Per-source indexing progress — renamed away from the overloaded `status`.
    async ingestionStatus(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      const request = { ...contextScope(), ...(args.ids ? { ids: args.ids } : {}) };
      return unwrapAndNormalize(
        await call("/context/status", timeoutMs, () => client.context.status(request, requestOptions(timeoutMs)))
      );
    },

    async relations(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      const request = { ...contextScope(), ...(args.id ? { id: args.id } : {}) };
      return unwrapAndNormalize(
        await call("/context/relations", timeoutMs, () => client.context.relations(request, requestOptions(timeoutMs)))
      );
    },

    // One delete path for memory and knowledge. Deletion is reconciled PER ID:
    // this returns which requested ids the server confirms were deleted, plus
    // the ids it did NOT (failed, no-op, per-item error, or unattributable) —
    // which the caller must retain and retry rather than drop. A batched delete
    // that partially succeeds no longer resolves as an all-or-nothing success.
    // Transport/SDK errors still throw (via `call`); only the logical outcome is
    // returned. Returns { deletedIds, failedIds, data } (data = raw response).
    async delete(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? writeTimeoutMs;
      const requestedIds = Array.isArray(args.ids) ? args.ids : [];
      const request = {
        ...contextScope(),
        ids: args.ids,
        ...(args.kind ? { type: args.kind } : {})
      };
      const envelope = await call("/context (delete)", timeoutMs, () =>
        client.context.delete(request, requestOptions(timeoutMs))
      );
      const data = unwrapAndNormalize(envelope) ?? {};
      const { deletedIds, failedIds } = classifyDeletion(requestedIds, envelope, data);
      return { deletedIds, failedIds, data };
    }
  };

  // databases.* operate on an explicit target database, not the configured scope.
  let layoutsPromise = null;
  const databases = {
    async create(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? writeTimeoutMs;
      if (args.type != null) {
        // `type` (split|unified) is dropped by the vendored SDK's serializer,
        // which would provision a split database in silence.
        return rawJson("/databases (create)", "POST", "/databases", {
          database: args.database,
          type: args.type,
          ...(args.extra || {})
        }, timeoutMs);
      }
      const request = { database: args.database, ...(args.extra || {}) };
      return unwrapAndNormalize(
        await call("/databases (create)", timeoutMs, () => client.databases.create(request, requestOptions(timeoutMs)))
      );
    },
    async delete(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? writeTimeoutMs;
      return unwrapAndNormalize(
        await call("/databases (delete)", timeoutMs, () =>
          client.databases.delete({ database: args.database }, requestOptions(timeoutMs))
        )
      );
    },
    async list(opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      return unwrapAndNormalize(
        await call("/databases", timeoutMs, () => client.databases.list(requestOptions(timeoutMs)))
      );
    },
    // Every database this key can see, mapped to its storage layout (PRO-1618),
    // from GET /databases details[]. Memoised: a layout is fixed at creation.
    async layouts(opts = {}) {
      if (!layoutsPromise) {
        const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
        layoutsPromise = rawJson("/databases", "GET", "/databases", undefined, timeoutMs)
          .then((listed) => {
            const map = new Map();
            for (const row of Array.isArray(listed?.details) ? listed.details : []) {
              if (row && row.database) {
                map.set(String(row.database), row.type === "unified" ? "unified" : "split");
              }
            }
            return map;
          })
          .catch((error) => {
            layoutsPromise = null;
            throw error;
          });
      }
      return layoutsPromise;
    },
    // The layout of one database. Unknown, or a failed probe, reads as split:
    // the layout of every database created before PRO-1618, so the worst case
    // is the old default, never a wrong unified call.
    async layout(database, opts = {}) {
      try {
        return (await databases.layouts(opts)).get(database) ?? "split";
      } catch {
        return "split";
      }
    },
    async collections(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      return unwrapAndNormalize(
        await call("/databases/collections", timeoutMs, () =>
          client.databases.collections({ database: args.database }, requestOptions(timeoutMs))
        )
      );
    },
    async stats(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      return unwrapAndNormalize(
        await call("/databases/stats", timeoutMs, () =>
          client.databases.stats({ database: args.database }, requestOptions(timeoutMs))
        )
      );
    },
    // Infra provisioning readiness — renamed away from the overloaded `status`.
    async readiness(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      return unwrapAndNormalize(
        await call("/databases/status", timeoutMs, () =>
          client.databases.status({ database: args.database }, requestOptions(timeoutMs))
        )
      );
    }
  };

  return {
    // Exposed as PROPERTIES: plugin code duck-types these as fields.
    tenantId: database,
    subTenantId: collection,
    context,
    databases
  };
}
