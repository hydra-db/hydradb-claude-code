import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE = {
  version: 1,
  files: {},
  sessions: {},
  lastSessionId: "",
  lastRecall: null
};

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function toEpoch(value) {
  if (typeof value !== "string" || !value) {
    return -Infinity;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

function chooseVersionedField(previous, next, field, timestampField) {
  const previousTime = toEpoch(previous?.[timestampField]);
  const nextTime = toEpoch(next?.[timestampField]);

  if (nextTime > previousTime) {
    return {
      value: next?.[field],
      timestamp: next?.[timestampField]
    };
  }

  if (previousTime > nextTime) {
    return {
      value: previous?.[field],
      timestamp: previous?.[timestampField]
    };
  }

  if (next?.[field] !== undefined) {
    return {
      value: next[field],
      timestamp: next?.[timestampField]
    };
  }

  return {
    value: previous?.[field],
    timestamp: previous?.[timestampField]
  };
}

function mergeSession(previous, next) {
  const merged = {
    ...previous,
    ...next
  };

  const pendingPrompt = chooseVersionedField(previous, next, "pendingPrompt", "pendingPromptUpdatedAt");
  if (pendingPrompt.value !== undefined || pendingPrompt.timestamp) {
    merged.pendingPrompt = pendingPrompt.value ?? "";
    merged.pendingPromptUpdatedAt = pendingPrompt.timestamp || "";
  }

  const turns = chooseVersionedField(previous, next, "turns", "turnsUpdatedAt");
  if (Array.isArray(turns.value)) {
    merged.turns = turns.value;
    merged.turnsUpdatedAt = turns.timestamp || "";
  }

  const lastCapture = chooseVersionedField(
    previous,
    next,
    "lastCaptureHash",
    "lastCaptureUpdatedAt"
  );
  if (lastCapture.value !== undefined || lastCapture.timestamp) {
    merged.lastCaptureHash = lastCapture.value ?? "";
    merged.lastCaptureUpdatedAt = lastCapture.timestamp || "";
  }

  const lastTranscript = chooseVersionedField(
    previous,
    next,
    "lastSessionTranscriptHash",
    "lastSessionTranscriptUpdatedAt"
  );
  if (lastTranscript.value !== undefined || lastTranscript.timestamp) {
    merged.lastSessionTranscriptHash = lastTranscript.value ?? "";
    merged.lastSessionTranscriptUpdatedAt = lastTranscript.timestamp || "";
  }

  const updatedAt = toEpoch(next?.updatedAt) > toEpoch(previous?.updatedAt)
    ? next?.updatedAt
    : previous?.updatedAt || next?.updatedAt || "";
  if (updatedAt) {
    merged.updatedAt = updatedAt;
  }

  return merged;
}

export async function ensureDataDir(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
}

export async function readState(dataDir) {
  await ensureDataDir(dataDir);
  const statePath = path.join(dataDir, "state.json");

  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...cloneDefaultState(),
      ...parsed,
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      lastSessionId: typeof parsed.lastSessionId === "string" ? parsed.lastSessionId : "",
      lastRecall: parsed.lastRecall && typeof parsed.lastRecall === "object" ? parsed.lastRecall : null
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return cloneDefaultState();
    }
    return cloneDefaultState();
  }
}

// `removedFilePaths` carries the tracked files this write intends to FORGET.
// The `files` merge below re-reads what is on disk so a concurrent single-file
// sync does not lose its addition, but a spread can only add or overwrite keys —
// never drop one. Without an explicit removal list, a file deleted from the
// in-memory state is resurrected from `current` on every write, so a deleted
// source stays tracked forever and every full sync re-attempts its delete.
export async function writeState(dataDir, state, { removedFilePaths = [] } = {}) {
  await ensureDataDir(dataDir);
  const statePath = path.join(dataDir, "state.json");
  const current = await readState(dataDir);
  const sessionIds = new Set([
    ...Object.keys(current.sessions || {}),
    ...Object.keys(state.sessions || {})
  ]);
  const sessions = Object.fromEntries(
    [...sessionIds].map((sessionId) => {
      const previous = current.sessions?.[sessionId] || {};
      const next = state.sessions?.[sessionId] || {};
      return [sessionId, mergeSession(previous, next)];
    })
  );

  const files = {
    ...(current.files || {}),
    ...(state.files || {})
  };
  for (const filePath of removedFilePaths) {
    delete files[filePath];
  }

  const next = {
    ...cloneDefaultState(),
    ...current,
    ...state,
    files,
    sessions,
    lastSessionId: state.lastSessionId || current.lastSessionId || ""
  };

  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, statePath);
}
