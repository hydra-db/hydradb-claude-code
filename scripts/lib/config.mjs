import fs from "node:fs/promises";
import path from "node:path";

export const PROJECT_CONFIG_FILES = [
  ".hydradb-plugin.json",
  ".hydradb-plugin.local.json"
];

const DEFAULT_INCLUDE_GLOBS = [
  "CLAUDE.md",
  ".claude/**/*.md",
  "**/*.md",
  "**/*.mdx"
];

const DEFAULT_EXCLUDE_GLOBS = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".next/**",
  ".nuxt/**",
  ".turbo/**",
  ".cache/**",
  ".venv/**",
  "venv/**",
  "target/**",
  "vendor/**",
  "**/.env*",
  ".env*",
  "**/*.lock",
  "**/*.min.*",
  "**/*.map",
  "**/*.pem",
  "**/*.key",
  "**/*.crt",
  "**/*.cer"
];

const FIFTY_MB = 50 * 1024 * 1024;

export const DEFAULTS = {
  apiBaseUrl: "https://api.hydradb.com",
  autoRecall: true,
  autoIngest: true,
  captureMode: "session-upsert",
  searchMode: "memory",
  ingestionMode: "memory",
  recallMode: "fast",
  graphContext: true,
  maxContextChars: 7000,
  maxMemoryResults: 6,
  maxKnowledgeResults: 4,
  requestTimeoutMs: 15000,
  writeTimeoutMs: 15000,
  maxFileSizeBytes: FIFTY_MB,
  maxFilesPerSync: 25,
  maxMemoryCharsPerChunk: FIFTY_MB,
  maxMemoryChunksPerFile: 1,
  includeGlobs: DEFAULT_INCLUDE_GLOBS,
  excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
  ignoreMarker: "hydra-ignore",
  debug: false
};

const KNOWN_KEYS = new Set([
  "apiBaseUrl",
  "apiKey",
  "tenantId",
  "subTenantId",
  "userName",
  "autoRecall",
  "autoCapture",
  "autoIngest",
  "captureMode",
  "searchMode",
  "ingestionMode",
  "recallMode",
  "graphContext",
  "maxContextChars",
  "maxMemoryResults",
  "maxKnowledgeResults",
  "requestTimeoutMs",
  "writeTimeoutMs",
  "maxFileSizeBytes",
  "maxFilesPerSync",
  "maxMemoryCharsPerChunk",
  "maxMemoryChunksPerFile",
  "includeGlobs",
  "excludeGlobs",
  "ignoreMarker",
  "debug",
  "memoryCustomInstructions",
  "workspaceMemoryCustomInstructions"
]);

function envOrUndefined(name) {
  return process.env[name];
}

// Deprecated env-var aliases per the shared client contract (CONTRACT §1). The
// canonical `HYDRADB_*` name wins if both are set; otherwise the first set alias
// is honoured and its use is warned about exactly once per process.
//
// Per-client scoping (CONTRACT §1): a client reads the canonical name plus ONLY
// the legacy prefix(es) it itself historically shipped. This plugin ships
// `HYDRADB_*` and reads the `HYDRA_DB_*` spellings; it must NOT read another
// client's prefix, so `HYDRA_OPENCLAW_*` is deliberately absent here.
const ENV_ALIASES = {
  apiKey: { canonical: "HYDRADB_API_KEY", deprecated: ["HYDRA_DB_API_KEY"] },
  tenantId: {
    canonical: "HYDRADB_DATABASE",
    deprecated: ["HYDRADB_TENANT_ID", "HYDRA_DB_TENANT_ID"]
  },
  subTenantId: {
    canonical: "HYDRADB_COLLECTION",
    deprecated: ["HYDRADB_SUB_TENANT_ID", "HYDRA_DB_SUB_TENANT_ID"]
  },
  apiBaseUrl: { canonical: "HYDRADB_BASE_URL", deprecated: ["HYDRA_DB_BASE_URL", "HYDRADB_API_URL"] }
};

const warnedEnvAliases = new Set();

function warnEnvAliasOnce(deprecatedName, canonicalName) {
  if (warnedEnvAliases.has(deprecatedName)) {
    return;
  }
  warnedEnvAliases.add(deprecatedName);
  process.stderr.write(
    `[hydradb] ${deprecatedName} is deprecated; use ${canonicalName} instead.\n`
  );
}

// Returns the value of the canonical env var, or the first set deprecated alias
// (emitting one warning). "Set" means present in the environment even if empty,
// so an explicit empty collection/sub-tenant is preserved.
function resolveAliasedEnv({ canonical, deprecated }) {
  const canonicalValue = process.env[canonical];
  if (canonicalValue !== undefined) {
    return canonicalValue;
  }
  for (const name of deprecated) {
    const value = process.env[name];
    if (value !== undefined) {
      warnEnvAliasOnce(name, canonical);
      return value;
    }
  }
  return undefined;
}

function resolveEnvString(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const resolved = envOrUndefined(name);
    if (resolved == null || resolved === "") {
      throw new Error(`environment variable ${name} is not set`);
    }
    return resolved;
  });
}

function resolveEnvObject(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveEnvObject(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveEnvObject(entry)])
    );
  }

  return resolveEnvString(value);
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseBoolean(value, fallback, errors, label) {
  if (value == null) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  errors.push(`${label} must be a boolean`);
  return fallback;
}

function parseNumber(value, fallback, errors, label, options = {}) {
  if (value == null) {
    return fallback;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    errors.push(`${label} must be a number`);
    return fallback;
  }

  if (options.min != null && value < options.min) {
    errors.push(`${label} must be >= ${options.min}`);
    return fallback;
  }

  return value;
}

function parseStringArray(value, fallback, errors, label) {
  if (value == null) {
    return fallback;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    errors.push(`${label} must be an array of strings`);
    return fallback;
  }

  return value;
}

function parseMode(value, fallback, errors, label, allowed) {
  if (value == null) {
    return fallback;
  }

  if (typeof value !== "string") {
    errors.push(`${label} must be one of ${allowed.join(", ")}`);
    return fallback;
  }

  if (!allowed.includes(value)) {
    errors.push(`${label} must be one of ${allowed.join(", ")}`);
    return fallback;
  }

  return value;
}

async function findProjectRoot(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    for (const candidate of [".git", "CLAUDE.md", ...PROJECT_CONFIG_FILES]) {
      if (await fileExists(path.join(current, candidate))) {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

function parseEnvBoolean(name, errors) {
  const value = envOrUndefined(name);
  if (value == null || value === "") {
    return undefined;
  }

  if (/^(1|true|yes|on)$/i.test(value)) {
    return true;
  }

  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }

  errors.push(`${name} must be a boolean-like value (true/false, 1/0, yes/no, on/off)`);
  return undefined;
}

function parseEnvNumber(name) {
  const value = envOrUndefined(name);
  if (value == null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function applyKnownKeys(baseConfig, incoming, sourceLabel, errors) {
  const next = { ...baseConfig };

  for (const key of Object.keys(incoming)) {
    if (!KNOWN_KEYS.has(key)) {
      errors.push(`${sourceLabel}: unknown config key "${key}" was ignored`);
      continue;
    }
    next[key] = incoming[key];
  }

  return next;
}

export async function loadConfig(cwd, dataDir) {
  const projectRoot = await findProjectRoot(cwd);
  const workspaceName = path.basename(projectRoot);
  const dataConfigPath = path.join(dataDir, "config.json");
  const explicitConfig = envOrUndefined("HYDRADB_PLUGIN_CONFIG");
  const candidateFiles = [];

  if (explicitConfig) {
    candidateFiles.push(path.isAbsolute(explicitConfig) ? explicitConfig : path.join(cwd, explicitConfig));
  }

  candidateFiles.push(dataConfigPath);
  for (const name of PROJECT_CONFIG_FILES) {
    candidateFiles.push(path.join(projectRoot, name));
  }

  let merged = { ...DEFAULTS };
  const sources = [];
  const errors = [];

  for (const filePath of candidateFiles) {
    if (!(await fileExists(filePath))) {
      continue;
    }

    try {
      const parsed = resolveEnvObject(await readJsonFile(filePath));
      merged = applyKnownKeys(merged, parsed, filePath, errors);
      sources.push(filePath);
    } catch (error) {
      errors.push(`${filePath}: ${error.message}`);
    }
  }

  const envOverrides = {
    apiBaseUrl: resolveAliasedEnv(ENV_ALIASES.apiBaseUrl),
    apiKey: resolveAliasedEnv(ENV_ALIASES.apiKey),
    tenantId: resolveAliasedEnv(ENV_ALIASES.tenantId),
    subTenantId: resolveAliasedEnv(ENV_ALIASES.subTenantId),
    userName: envOrUndefined("HYDRADB_USER_NAME"),
    captureMode: envOrUndefined("HYDRADB_CAPTURE_MODE"),
    searchMode: envOrUndefined("HYDRADB_SEARCH_MODE"),
    ingestionMode: envOrUndefined("HYDRADB_INGESTION_MODE"),
    recallMode: envOrUndefined("HYDRADB_RECALL_MODE"),
    ignoreMarker: envOrUndefined("HYDRADB_IGNORE_MARKER"),
    memoryCustomInstructions: envOrUndefined("HYDRADB_MEMORY_CUSTOM_INSTRUCTIONS"),
    autoCapture: parseEnvBoolean("HYDRADB_AUTO_CAPTURE", errors),
    autoRecall: parseEnvBoolean("HYDRADB_AUTO_RECALL", errors),
    autoIngest: parseEnvBoolean("HYDRADB_AUTO_INGEST", errors),
    graphContext: parseEnvBoolean("HYDRADB_GRAPH_CONTEXT", errors),
    debug: parseEnvBoolean("HYDRADB_DEBUG", errors),
    maxContextChars: parseEnvNumber("HYDRADB_MAX_CONTEXT_CHARS"),
    maxMemoryResults: parseEnvNumber("HYDRADB_MAX_MEMORY_RESULTS"),
    maxKnowledgeResults: parseEnvNumber("HYDRADB_MAX_KNOWLEDGE_RESULTS"),
    requestTimeoutMs: parseEnvNumber("HYDRADB_REQUEST_TIMEOUT_MS"),
    writeTimeoutMs: parseEnvNumber("HYDRADB_WRITE_TIMEOUT_MS"),
    maxFileSizeBytes: parseEnvNumber("HYDRADB_MAX_FILE_SIZE_BYTES"),
    maxFilesPerSync: parseEnvNumber("HYDRADB_MAX_FILES_PER_SYNC"),
    maxMemoryCharsPerChunk: parseEnvNumber("HYDRADB_MAX_MEMORY_CHARS_PER_CHUNK"),
    maxMemoryChunksPerFile: parseEnvNumber("HYDRADB_MAX_MEMORY_CHUNKS_PER_FILE"),
    workspaceMemoryCustomInstructions: envOrUndefined(
      "HYDRADB_WORKSPACE_MEMORY_CUSTOM_INSTRUCTIONS"
    )
  };

  const filteredEnvOverrides = Object.fromEntries(
    Object.entries(envOverrides).filter(([key, value]) => {
      if (value == null) {
        return false;
      }
      if (key === "subTenantId") {
        return true;
      }
      return value !== "";
    })
  );

  merged = applyKnownKeys(merged, filteredEnvOverrides, "environment", errors);

  const derivedCaptureMode =
    typeof merged.captureMode === "string"
      ? merged.captureMode
      : merged.autoCapture === false
        ? "off"
        : DEFAULTS.captureMode;
  const hasExplicitSubTenantId = typeof merged.subTenantId === "string";

  const config = {
    apiBaseUrl:
      typeof merged.apiBaseUrl === "string" && merged.apiBaseUrl
        ? merged.apiBaseUrl.replace(/\/+$/g, "")
        : DEFAULTS.apiBaseUrl,
    apiKey: typeof merged.apiKey === "string" && merged.apiKey ? merged.apiKey : "",
    tenantId: typeof merged.tenantId === "string" && merged.tenantId ? merged.tenantId : "",
    subTenantId: hasExplicitSubTenantId ? merged.subTenantId : "",
    userName: typeof merged.userName === "string" ? merged.userName : "",
    autoRecall: parseBoolean(merged.autoRecall, DEFAULTS.autoRecall, errors, "autoRecall"),
    autoIngest: parseBoolean(merged.autoIngest, DEFAULTS.autoIngest, errors, "autoIngest"),
    captureMode: parseMode(
      derivedCaptureMode,
      DEFAULTS.captureMode,
      errors,
      "captureMode",
      ["turn", "session-upsert", "both", "off"]
    ),
    searchMode: parseMode(
      merged.searchMode,
      DEFAULTS.searchMode,
      errors,
      "searchMode",
      ["memory", "both", "knowledge"]
    ),
    ingestionMode: parseMode(
      merged.ingestionMode,
      DEFAULTS.ingestionMode,
      errors,
      "ingestionMode",
      ["memory", "knowledge", "auto"]
    ),
    recallMode: merged.recallMode === "thinking" ? "thinking" : "fast",
    graphContext: parseBoolean(merged.graphContext, DEFAULTS.graphContext, errors, "graphContext"),
    maxContextChars: parseNumber(
      merged.maxContextChars,
      DEFAULTS.maxContextChars,
      errors,
      "maxContextChars",
      { min: 512 }
    ),
    maxMemoryResults: parseNumber(
      merged.maxMemoryResults,
      DEFAULTS.maxMemoryResults,
      errors,
      "maxMemoryResults",
      { min: 1 }
    ),
    maxKnowledgeResults: parseNumber(
      merged.maxKnowledgeResults,
      DEFAULTS.maxKnowledgeResults,
      errors,
      "maxKnowledgeResults",
      { min: 1 }
    ),
    requestTimeoutMs: parseNumber(
      merged.requestTimeoutMs,
      DEFAULTS.requestTimeoutMs,
      errors,
      "requestTimeoutMs",
      { min: 1000 }
    ),
    writeTimeoutMs: parseNumber(
      merged.writeTimeoutMs,
      DEFAULTS.writeTimeoutMs,
      errors,
      "writeTimeoutMs",
      { min: 1000 }
    ),
    maxFileSizeBytes: parseNumber(
      merged.maxFileSizeBytes,
      DEFAULTS.maxFileSizeBytes,
      errors,
      "maxFileSizeBytes",
      { min: 1024 }
    ),
    maxFilesPerSync: parseNumber(
      merged.maxFilesPerSync,
      DEFAULTS.maxFilesPerSync,
      errors,
      "maxFilesPerSync",
      { min: 1 }
    ),
    maxMemoryCharsPerChunk: parseNumber(
      merged.maxMemoryCharsPerChunk,
      DEFAULTS.maxMemoryCharsPerChunk,
      errors,
      "maxMemoryCharsPerChunk",
      { min: 512 }
    ),
    maxMemoryChunksPerFile: parseNumber(
      merged.maxMemoryChunksPerFile,
      DEFAULTS.maxMemoryChunksPerFile,
      errors,
      "maxMemoryChunksPerFile",
      { min: 1 }
    ),
    includeGlobs: parseStringArray(
      merged.includeGlobs,
      DEFAULTS.includeGlobs,
      errors,
      "includeGlobs"
    ),
    excludeGlobs: parseStringArray(
      merged.excludeGlobs,
      DEFAULTS.excludeGlobs,
      errors,
      "excludeGlobs"
    ),
    ignoreMarker:
      typeof merged.ignoreMarker === "string" && merged.ignoreMarker
        ? merged.ignoreMarker
        : DEFAULTS.ignoreMarker,
    debug: parseBoolean(merged.debug, DEFAULTS.debug, errors, "debug"),
    memoryCustomInstructions:
      typeof merged.memoryCustomInstructions === "string"
        ? merged.memoryCustomInstructions
        : "",
    workspaceMemoryCustomInstructions:
      typeof merged.workspaceMemoryCustomInstructions === "string"
        ? merged.workspaceMemoryCustomInstructions
        : ""
  };

  if (!hasExplicitSubTenantId) {
    errors.push('subTenantId must be set explicitly. Use "" if you want HydraDB\'s default sub-tenant.');
  }

  if (config.autoIngest) {
    if (config.ingestionMode === "memory" && config.searchMode === "knowledge") {
      errors.push(
        'searchMode=knowledge will not auto-recall workspace files synced with ingestionMode=memory. Use searchMode="both" or "memory" if you want synced workspace docs to appear automatically.'
      );
    }

    if (config.ingestionMode === "knowledge" && config.searchMode === "memory") {
      errors.push(
        'searchMode=memory will not auto-recall workspace files synced with ingestionMode=knowledge. Use searchMode="both" or "knowledge" if you want synced workspace docs to appear automatically.'
      );
    }

    if (config.ingestionMode === "auto" && config.searchMode !== "both") {
      errors.push(
        'ingestionMode=auto may sync smaller files to memory and larger files to knowledge. Use searchMode="both" if you want auto-recall to cover both paths consistently.'
      );
    }
  }

  return {
    configured: Boolean(config.apiKey && config.tenantId && hasExplicitSubTenantId),
    config,
    projectRoot,
    workspaceName,
    dataDir,
    dataConfigPath,
    sources,
    errors
  };
}

export function formatStatus(configResult, state) {
  const { configured, config, projectRoot, workspaceName, dataDir, dataConfigPath, sources, errors } = configResult;
  const trackedFiles = Object.keys(state.files ?? {}).length;
  const trackedSessions = Object.keys(state.sessions ?? {}).length;

  return {
    configured,
    workspaceName,
    projectRoot,
    dataDir,
    dataConfigPath,
    configSources: sources,
    errors,
    resolvedConfig: {
      apiBaseUrl: config.apiBaseUrl,
      tenantId: config.tenantId || "",
      subTenantId: config.subTenantId,
      userName: config.userName || "",
      autoRecall: config.autoRecall,
      autoIngest: config.autoIngest,
      captureMode: config.captureMode,
      searchMode: config.searchMode,
      ingestionMode: config.ingestionMode,
      recallMode: config.recallMode,
      graphContext: config.graphContext,
      maxContextChars: config.maxContextChars,
      maxMemoryResults: config.maxMemoryResults,
      maxKnowledgeResults: config.maxKnowledgeResults,
      requestTimeoutMs: config.requestTimeoutMs,
      writeTimeoutMs: config.writeTimeoutMs,
      maxFileSizeBytes: config.maxFileSizeBytes,
      maxFilesPerSync: config.maxFilesPerSync,
      maxMemoryCharsPerChunk: config.maxMemoryCharsPerChunk,
      maxMemoryChunksPerFile: config.maxMemoryChunksPerFile,
      ignoreMarker: config.ignoreMarker,
      includeGlobs: config.includeGlobs,
      excludeGlobs: config.excludeGlobs,
      debug: config.debug
    },
    stateSummary: {
      trackedFiles,
      trackedSessions
    }
  };
}
