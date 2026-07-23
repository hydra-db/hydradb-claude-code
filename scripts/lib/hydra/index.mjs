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

// Unwrap HandlerEnvelope{data,success,meta} → data, but only when the envelope
// shape is actually present (CONTRACT §2 rule 2 — never assume it).
function unwrapEnvelope(value) {
  if (
    value &&
    typeof value === "object" &&
    "data" in value &&
    ("success" in value || "meta" in value)
  ) {
    return value.data;
  }
  return value;
}

function isEnvelopeSuccessFalse(value) {
  return Boolean(value && typeof value === "object" && "success" in value && value.success === false);
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
      return unwrapEnvelope(
        await call("/query", timeoutMs, () => client.query(request, requestOptions(timeoutMs)))
      );
    },

    async ingest(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? writeTimeoutMs;
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
      return unwrapEnvelope(
        await call("/context/ingest", timeoutMs, () => client.context.ingest(request, requestOptions(timeoutMs)))
      );
    },

    async list(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      const request = { ...contextScope(), ...(args.kind ? { type: args.kind } : {}) };
      return unwrapEnvelope(
        await call("/context/list", timeoutMs, () => client.context.list(request, requestOptions(timeoutMs)))
      );
    },

    async inspect(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      const request = { ...contextScope(), id: args.id, ...(args.mode ? { mode: args.mode } : {}) };
      return unwrapEnvelope(
        await call("/context/inspect", timeoutMs, () => client.context.inspect(request, requestOptions(timeoutMs)))
      );
    },

    // Per-source indexing progress — renamed away from the overloaded `status`.
    async ingestionStatus(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      const request = { ...contextScope(), ...(args.ids ? { ids: args.ids } : {}) };
      return unwrapEnvelope(
        await call("/context/status", timeoutMs, () => client.context.status(request, requestOptions(timeoutMs)))
      );
    },

    async relations(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      const request = { ...contextScope(), ...(args.id ? { id: args.id } : {}) };
      return unwrapEnvelope(
        await call("/context/relations", timeoutMs, () => client.context.relations(request, requestOptions(timeoutMs)))
      );
    },

    // One delete path for memory and knowledge. The server answers a zero-match
    // delete with 200 `{success:false, deleted_count:0}` (and the memory path
    // with `user_memory_deleted:false`), which the plugin used to swallow as a
    // successful delete. Inspect the body — never the status code — and raise so
    // the caller can surface it and retry, for BOTH kinds.
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
      // Normalize keys before inspecting: the SDK returns camelCase
      // (deletedCount/userMemoryDeleted), and reading snake_case here would miss
      // the zero-match no-op and silently "succeed" — the very bug being fixed.
      const normalizedEnvelope = snakeCaseKeys(envelope);
      const checkData = unwrapEnvelope(normalizedEnvelope) ?? {};
      const failed =
        isEnvelopeSuccessFalse(normalizedEnvelope) ||
        (checkData && typeof checkData === "object" &&
          (checkData.success === false ||
            checkData.user_memory_deleted === false ||
            (requestedIds.length > 0 && checkData.deleted_count === 0)));
      if (failed) {
        throw new HydraWrapperError(
          `/context (delete) deleted nothing for ${JSON.stringify(requestedIds)} ` +
            `(success/deleted_count reported no match) — scope or ids may not match what was ingested`
        );
      }
      return unwrapEnvelope(envelope);
    }
  };

  // databases.* operate on an explicit target database, not the configured scope.
  const databases = {
    async create(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? writeTimeoutMs;
      const request = { database: args.database, ...(args.extra || {}) };
      return unwrapEnvelope(
        await call("/databases (create)", timeoutMs, () => client.databases.create(request, requestOptions(timeoutMs)))
      );
    },
    async delete(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? writeTimeoutMs;
      return unwrapEnvelope(
        await call("/databases (delete)", timeoutMs, () =>
          client.databases.delete({ database: args.database }, requestOptions(timeoutMs))
        )
      );
    },
    async list(opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      return unwrapEnvelope(
        await call("/databases", timeoutMs, () => client.databases.list(requestOptions(timeoutMs)))
      );
    },
    async collections(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      return unwrapEnvelope(
        await call("/databases/collections", timeoutMs, () =>
          client.databases.collections({ database: args.database }, requestOptions(timeoutMs))
        )
      );
    },
    async stats(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      return unwrapEnvelope(
        await call("/databases/stats", timeoutMs, () =>
          client.databases.stats({ database: args.database }, requestOptions(timeoutMs))
        )
      );
    },
    // Infra provisioning readiness — renamed away from the overloaded `status`.
    async readiness(args = {}, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
      return unwrapEnvelope(
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
