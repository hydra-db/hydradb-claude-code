# HydraDB Claude Code Plugin

Secure HydraDB automation for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with markdown-first workspace sync, prompt-time recall, and configurable memory capture modes.

The plugin gives Claude Code persistent, cross-session memory powered by [HydraDB](https://hydradb.com). It hooks into the Claude Code lifecycle to automatically recall relevant context at prompt time, sync workspace documentation into HydraDB, and capture conversation content as durable memories.

## Features

- **Automatic recall** — injects relevant memories and knowledge into Claude's context on every prompt
- **Workspace sync** — syncs markdown-first documentation (`*.md`, `*.mdx`, `CLAUDE.md`) into HydraDB
- **Session capture** — saves conversation content as evolving session memories or isolated turn memories
- **Graph context** — surfaces entity path chains and chunk-level relations from HydraDB's knowledge graph
- **Secret redaction** — heuristic filtering strips common secret patterns before any data leaves the workspace
- **Configurable modes** — fine-grained control over capture, search, and ingestion behavior

## Prerequisites

- **Node.js** >= 18
- **npm**
- A **HydraDB** account with an API key and tenant ID — sign up at [hydradb.com](https://hydradb.com)
- **Claude Code** installed

## Quick Start

```bash
git clone https://github.com/usecortex/hydradb-claude-code.git
cd hydradb-claude-code
make bootstrap
```

The bootstrap script will:
1. Verify Node.js >= 18 and npm are installed
2. Run `npm install`
3. Create `config.json` from `config.example.json` (if it doesn't already exist)
4. Run a syntax check
5. Print next steps

Then set your credentials:

```bash
export HYDRADB_API_KEY="your-api-key"
export HYDRADB_TENANT_ID="your-tenant-id"
```

Install the plugin in Claude Code:

```
/plugin marketplace add /path/to/hydradb-claude-code
/plugin install hydradb@hydradb
```

Or, once the repo is public:

```
/plugin marketplace add usecortex/hydradb-claude-code
/plugin install hydradb@hydradb
```

Reload Claude Code and run `/hydradb:status` to verify.

## Configuration

The plugin resolves configuration from multiple layers (later layers override earlier ones):

1. Built-in defaults
2. `HYDRADB_PLUGIN_CONFIG` environment variable
3. `${CLAUDE_PLUGIN_DATA}/config.json`
4. `./.hydradb-plugin-data/config.json`
5. `.hydradb-plugin.json`
6. `.hydradb-plugin.local.json`
7. Environment variable overrides

### Minimal config

```json
{
  "apiBaseUrl": "https://api.hydradb.com",
  "apiKey": "${HYDRADB_API_KEY}",
  "tenantId": "${HYDRADB_TENANT_ID}",
  "subTenantId": "",
  "autoRecall": true,
  "autoIngest": true,
  "captureMode": "session-upsert",
  "searchMode": "memory",
  "ingestionMode": "memory"
}
```

### Config reference

| Field | Default | Description |
|---|---|---|
| `apiBaseUrl` | `https://api.hydradb.com` | HydraDB API endpoint |
| `apiKey` | — | HydraDB API key (use `${HYDRADB_API_KEY}` to reference env var) |
| `tenantId` | — | HydraDB tenant ID (use `${HYDRADB_TENANT_ID}` to reference env var) |
| `subTenantId` | — | Sub-tenant scope; set to `""` for HydraDB's default sub-tenant |
| `userName` | — | Display name attached to captured memories |
| `autoRecall` | `true` | Automatically recall HydraDB context on each user prompt |
| `autoIngest` | `true` | Automatically sync workspace docs on session start |
| `captureMode` | `session-upsert` | `turn`, `session-upsert`, `both`, or `off` |
| `searchMode` | `memory` | `memory`, `knowledge`, `both`, `unified`, or `auto`. On a database created with `type: "unified"` the plugin detects the layout and always recalls one ranked list (see `hydradb-api-info/unified-databases.md`) |
| `ingestionMode` | `memory` | `memory`, `knowledge`, or `auto` |
| `recallMode` | `thinking` | Recall strategy passed to HydraDB |
| `graphContext` | `true` | Include graph entity paths and relations in recall |
| `maxContextChars` | `7000` | Max characters injected into Claude's context per prompt |
| `maxMemoryResults` | `6` | Max memory chunks returned per recall |
| `maxKnowledgeResults` | `4` | Max knowledge chunks returned per recall |
| `requestTimeoutMs` | `15000` | Timeout for HydraDB read requests |
| `writeTimeoutMs` | `15000` | Timeout for HydraDB write requests |
| `maxFileSizeBytes` | `52428800` | Max file size for workspace sync (50 MB) |
| `maxFilesPerSync` | `25` | Max files synced per workspace sync run |
| `includeGlobs` | `["CLAUDE.md", ".claude/**/*.md", "**/*.md", "**/*.mdx"]` | File patterns to include in workspace sync |
| `excludeGlobs` | *(see config.example.json)* | File patterns to exclude from workspace sync |
| `ignoreMarker` | `hydra-ignore` | Marker string to skip capture/sync for specific files or prompts |
| `memoryCustomInstructions` | *(see config.example.json)* | Instructions for memory extraction from conversations |
| `workspaceMemoryCustomInstructions` | *(see config.example.json)* | Instructions for memory extraction from workspace docs |
| `debug` | `false` | Enable JSONL debug logging |

### Environment variable overrides

| Variable | Overrides |
|---|---|
| `HYDRADB_API_KEY` | `apiKey` |
| `HYDRADB_TENANT_ID` | `tenantId` |
| `HYDRADB_SUB_TENANT_ID` | `subTenantId` |
| `HYDRADB_BASE_URL` | `apiBaseUrl` |
| `HYDRADB_USER_NAME` | `userName` |
| `HYDRADB_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` |
| `HYDRADB_WRITE_TIMEOUT_MS` | `writeTimeoutMs` |
| `HYDRADB_DEBUG` | `debug` |

## Usage

### Slash commands

| Command | Description |
|---|---|
| `/hydradb:setup` | Configure the plugin for the current workspace |
| `/hydradb:status` | Inspect plugin configuration and sync state |
| `/hydradb:search <query>` | Manually query HydraDB using the configured search mode |
| `/hydradb:remember <text>` | Store a durable note, preference, or decision in HydraDB |
| `/hydradb:save-session` | Save the current session as an evolving memory in HydraDB |
| `/hydradb:sync-workspace [--force]` | Force an immediate workspace doc sync |
| `/hydradb:last-recall` | Inspect the most recent auto-recall payload for debugging |

### How it works

The plugin registers [hooks](hooks/hooks.json) into the Claude Code lifecycle:

- **SessionStart** — prints HydraDB status and triggers async workspace sync
- **UserPromptSubmit** — recalls relevant context from HydraDB and injects it as a `<hydradb-context>` block
- **PostToolUse** — captures file-write activity for incremental sync
- **Stop** — captures the completed turn (user prompt + assistant response) into HydraDB

### Capture modes

| Mode | Behavior |
|---|---|
| `turn` | Save isolated user/assistant pairs as individual memories |
| `session-upsert` | Keep one evolving session transcript that gets upserted after each response |
| `both` | Do both |
| `off` | No automatic conversation capture (use `/hydradb:remember` or `/hydradb:save-session` manually) |

### Search modes

| Mode | Behavior |
|---|---|
| `memory` | Recall memories only |
| `knowledge` | Recall knowledge only |
| `both` | Recall memories and knowledge in parallel |

### Ingestion modes

| Mode | Behavior |
|---|---|
| `memory` | Sync workspace docs into memory using `infer` |
| `knowledge` | Sync workspace docs as knowledge |
| `auto` | Prefer memory, fall back to knowledge for larger files |

> **Tip:** If you use `ingestionMode: "auto"`, pair it with `searchMode: "both"` so recall can see both storage paths.

### Ignore marker

Add `hydra-ignore` (or your custom `ignoreMarker`) to:
- A file — to exclude it from workspace sync
- A prompt — to skip saving that prompt and its reply

> Note: The ignore marker skips capture and sync. It does **not** disable recall for that prompt.

### Debugging

- Run `/hydradb:last-recall` to inspect whether prompt-time recall fired and what was returned
- Start Claude Code with `HYDRADB_DEBUG=true` for a JSONL trace in `${CLAUDE_PLUGIN_DATA}/debug.log`
- Run `/hydradb:status` to check configuration and tracked state

## Project Structure

```
├── .claude-plugin/        # Claude Code plugin manifest
│   ├── plugin.json
│   └── marketplace.json
├── docs/                  # Documentation
│   ├── usage.md           # Detailed usage guide
│   └── security.md        # Security and reliability notes
├── hooks/                 # Claude Code lifecycle hooks
│   └── hooks.json
├── hydradb-api-info/      # HydraDB API reference docs
├── scripts/               # Plugin runtime scripts
│   ├── bootstrap.sh       # Zero-to-running setup script
│   ├── run-plugin.sh      # Hook runner (finds node, invokes plugin.mjs)
│   ├── plugin.mjs         # Main plugin entry point
│   ├── check.mjs          # Syntax and integration checks
│   └── lib/               # Core modules
│       ├── config.mjs
│       ├── context-format.mjs
│       ├── hydra-client.mjs
│       ├── sanitize.mjs
│       ├── state.mjs
│       └── workspace-sync.mjs
├── skills/                # Slash command definitions
│   ├── auto-recall/       # Proactive context recall (model-invoked)
│   ├── hydradb-context/   # Background guidance for injected context
│   ├── last-recall/       # /hydradb:last-recall
│   ├── recall/            # Deprecated alias → /hydradb:search
│   ├── reindex/           # Deprecated alias → /hydradb:sync-workspace
│   ├── remember/          # /hydradb:remember
│   ├── save-session/      # /hydradb:save-session
│   ├── search/            # /hydradb:search
│   ├── setup/             # /hydradb:setup
│   ├── status/            # /hydradb:status
│   └── sync-workspace/    # /hydradb:sync-workspace
├── config.example.json    # Full config template
├── .hydradb-plugin.json.example  # Workspace config template
├── Makefile               # Build and development targets
├── package.json
├── LICENSE                # Apache 2.0
└── README.md
```

## Make Targets

| Target | Description |
|---|---|
| `make help` | Show available targets (default) |
| `make bootstrap` | Zero-to-running setup: install deps, create config, run checks |
| `make install` | Install npm dependencies |
| `make check` | Run syntax and integration checks |
| `make clean` | Remove `node_modules/` |

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes
4. Run checks: `make check`
5. Commit with a descriptive message
6. Open a pull request

Please keep changes focused and include relevant context in your PR description.

## Further Reading

- [HydraDB Documentation](https://docs.hydradb.com/)
- [Plugin Usage Guide](docs/usage.md)
- [Security & Reliability Notes](docs/security.md)

## License

[Apache 2.0](LICENSE) — Copyright (c) 2026 HydraDB
