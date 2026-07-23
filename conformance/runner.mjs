// Conformance runner (CONTRACT §4). Drives conformance/vectors.json through the
// canonical wrapper against the REAL vendored SDK with a capturing fetch, and
// asserts the wire call each vector expects. This is the anti-drift gate: if an
// SDK bump renames a method or moves a field, or if the wrapper diverges from the
// shared vocabulary, a vector fails here.
//
// The vectors are shared and identical across all four client repos; this runner
// is the plugin's own. Its repo tag is "plugin" — vectors whose `optional_for`
// names "plugin" are skipped (none do today).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHydraWrapper } from "../scripts/lib/hydra/index.mjs";

const REPO_TAG = "plugin";
const here = path.dirname(fileURLToPath(import.meta.url));

// (HTTP method + pathname) → the SDK method name the vector names.
const PATH_TO_METHOD = {
  "POST /query": "query",
  "POST /context/ingest": "ingest",
  "DELETE /context": "delete",
  "POST /context/list": "list",
  "GET /context/inspect": "inspect",
  "GET /context/status": "status",
  "GET /context/relations": "relations",
  "POST /databases": "create",
  "GET /databases": "list",
  "DELETE /databases": "delete",
  "GET /databases/collections": "collections",
  "GET /databases/stats": "stats",
  "GET /databases/status": "status"
};

// A minimal ok Response the SDK's fetcher can consume; we only assert on the
// request, so the body just has to unwrap cleanly.
function fakeResponse() {
  const payload = JSON.stringify({ data: {}, success: true, meta: {} });
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null),
      has: () => false,
      forEach: () => {}
    },
    text: async () => payload,
    json: async () => JSON.parse(payload),
    clone() {
      return fakeResponse();
    },
    body: null
  };
}

// Extract a single captured request into a normalized, wire-level view.
async function captureToWire(url, init) {
  const parsed = new URL(url);
  const httpMethod = (init.method || "GET").toUpperCase();
  const key = `${httpMethod} ${parsed.pathname}`;

  const body = init.body;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;

  let contentType;
  const headerCt =
    init.headers && typeof init.headers.get === "function"
      ? init.headers.get("content-type")
      : init.headers && (init.headers["content-type"] || init.headers["Content-Type"]);

  const fields = {};
  // Query-string args (GET requests carry their args here).
  for (const [k, v] of parsed.searchParams.entries()) {
    if (k in fields) {
      fields[k] = [].concat(fields[k], v);
    } else {
      fields[k] = v;
    }
  }

  if (isFormData) {
    contentType = "multipart/form-data";
    for (const [k, v] of body.entries()) {
      fields[k] = v;
    }
  } else if (typeof body === "string" && body.length) {
    contentType = headerCt || "application/json";
    try {
      Object.assign(fields, JSON.parse(body));
    } catch {
      // non-JSON body; leave query-string fields only
    }
  } else {
    contentType = headerCt || undefined;
  }

  return { method: PATH_TO_METHOD[key], httpMethod, pathname: parsed.pathname, contentType, fields };
}

// The plugin's own translation from a client-neutral vector call to a wrapper
// invocation. Mirrors how the plugin actually builds ingest payloads.
function invokeWrapper(wrapper, op, args) {
  switch (op) {
    case "query":
      return wrapper.context.query({
        query: args.query,
        kind: args.kind,
        operator: args.operator
      });
    case "ingest":
      if (args.kind === "knowledge") {
        // Structured item carrying the client-assigned id (preserved verbatim).
        const item = { title: args.title, content: { text: args.text } };
        if (args.id != null) {
          item.id = args.id;
        }
        return wrapper.context.ingest({ kind: "knowledge", appKnowledge: JSON.stringify([item]) });
      }
      return wrapper.context.ingest({
        kind: "memory",
        memories: JSON.stringify([{ text: args.text }])
      });
    case "list":
      return wrapper.context.list({ kind: args.kind });
    case "inspect":
      return wrapper.context.inspect({ id: args.id, mode: args.mode });
    case "delete":
      return wrapper.context.delete({ ids: args.ids, kind: args.kind });
    case "relations":
      return wrapper.context.relations({ id: args.id });
    case "context.ingestionStatus":
      return wrapper.context.ingestionStatus({ ids: args.ids });
    case "database.create":
      return wrapper.databases.create({ database: args.database });
    case "database.delete":
      return wrapper.databases.delete({ database: args.database });
    case "database.collections":
      return wrapper.databases.collections({ database: args.database });
    case "database.readiness":
      return wrapper.databases.readiness({ database: args.database });
    default:
      throw new Error(`conformance: unmapped op "${op}"`);
  }
}

function valuesMatch(actual, expected) {
  if (Array.isArray(expected)) {
    const actualArr = [].concat(actual);
    return (
      actualArr.length === expected.length &&
      expected.every((v, i) => String(actualArr[i]) === String(v))
    );
  }
  return String(actual) === String(expected);
}

function assertIncludes(fields, expected, label, vectorId) {
  for (const [k, v] of Object.entries(expected || {})) {
    assert.ok(k in fields, `[${vectorId}] ${label}: expected field "${k}" to be present`);
    assert.ok(
      valuesMatch(fields[k], v),
      `[${vectorId}] ${label}: field "${k}" = ${JSON.stringify(fields[k])}, expected ${JSON.stringify(v)}`
    );
  }
}

async function runVector(vector, scopeDefaults) {
  const { id, call, expect } = vector;
  if (Array.isArray(vector.optional_for) && vector.optional_for.includes(REPO_TAG)) {
    return { id, skipped: true };
  }

  const captured = [];
  const wrapper = createHydraWrapper({
    apiKey: "conformance-token",
    tenantId: scopeDefaults.database,
    subTenantId: scopeDefaults.collection,
    baseUrl: "https://api.hydradb.test",
    async fetch(url, init) {
      captured.push(await captureToWire(url, init));
      return fakeResponse();
    }
  });

  await invokeWrapper(wrapper, call.op, call.args || {});

  assert.equal(captured.length, 1, `[${id}] expected exactly one SDK call, saw ${captured.length}`);
  const wire = captured[0];
  const sdk = expect.sdk;

  assert.equal(wire.method, sdk.method, `[${id}] SDK method: got ${wire.method}, expected ${sdk.method}`);

  if (sdk.content_type) {
    assert.equal(
      wire.contentType,
      sdk.content_type,
      `[${id}] content-type: got ${wire.contentType}, expected ${sdk.content_type}`
    );
  }
  if (sdk.forbid_content_type) {
    assert.notEqual(
      wire.contentType,
      sdk.forbid_content_type,
      `[${id}] content-type must not be ${sdk.forbid_content_type}`
    );
  }
  assertIncludes(wire.fields, sdk.args_include, "args_include", id);
  assertIncludes(wire.fields, sdk.args_scope, "args_scope", id);

  if (sdk.forbid_field) {
    assert.ok(
      !(sdk.forbid_field in wire.fields),
      `[${id}] forbidden field "${sdk.forbid_field}" must not be sent`
    );
  }
  if (Array.isArray(sdk.source_field_in)) {
    assert.ok(
      sdk.source_field_in.some((f) => f in wire.fields),
      `[${id}] one of source fields ${JSON.stringify(sdk.source_field_in)} must be sent; saw ${JSON.stringify(Object.keys(wire.fields))}`
    );
  }
  if (sdk.item_id_preserved != null) {
    const raw = wire.fields.app_knowledge;
    assert.ok(typeof raw === "string", `[${id}] app_knowledge must be a JSON string to preserve ids`);
    const items = JSON.parse(raw);
    assert.ok(
      items.some((it) => it && it.id === sdk.item_id_preserved),
      `[${id}] client-assigned id "${sdk.item_id_preserved}" must be preserved in app_knowledge`
    );
  }

  return { id, skipped: false };
}

export async function runConformance() {
  const vectors = JSON.parse(await fs.readFile(path.join(here, "vectors.json"), "utf8"));
  const scopeDefaults = vectors.scope_defaults || { database: "db_test", collection: "col_test" };
  let ran = 0;
  let skipped = 0;
  for (const vector of vectors.vectors) {
    const result = await runVector(vector, scopeDefaults);
    if (result.skipped) {
      skipped += 1;
    } else {
      ran += 1;
    }
  }
  return { total: vectors.vectors.length, ran, skipped };
}
