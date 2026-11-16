#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { printf "${GREEN}✔${NC}  %s\n" "$1"; }
warn()  { printf "${YELLOW}⚠${NC}  %s\n" "$1"; }
error() { printf "${RED}✖${NC}  %s\n" "$1"; }

cd "$PROJECT_ROOT"

# ── Prerequisites ──────────────────────────────────────────────────────────────

printf "\n%s\n" "── Checking prerequisites ──"

if ! command -v node >/dev/null 2>&1; then
  error "node is not installed. Install Node.js >= 18: https://nodejs.org/"
  exit 1
fi

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js >= 18 is required (found v${NODE_VERSION})."
  exit 1
fi
info "node v${NODE_VERSION}"

if ! command -v npm >/dev/null 2>&1; then
  error "npm is not installed. It usually ships with Node.js."
  exit 1
fi
info "npm $(npm -v)"

# ── Install dependencies ───────────────────────────────────────────────────────

printf "\n%s\n" "── Installing dependencies ──"

npm install
info "npm install complete"

# ── Config file ────────────────────────────────────────────────────────────────

printf "\n%s\n" "── Configuration ──"

# The loader reads <dataDir>/config.json for every workspace, so write the
# template there when we can resolve the data directory; a config in the plugin
# checkout is only read when the plugin folder itself is the open workspace.
PLUGIN_NAME="$(node -e 'try{process.stdout.write((require("./.claude-plugin/plugin.json").name||"").trim())}catch(e){}' 2>/dev/null || true)"
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  DATA_DIR="$CLAUDE_PLUGIN_DATA"
elif [ -n "$PLUGIN_NAME" ]; then
  DATA_DIR="$HOME/.claude/plugins/data/${PLUGIN_NAME}-inline"
else
  DATA_DIR=""
fi

if [ -n "$DATA_DIR" ]; then
  CONFIG_PATH="$DATA_DIR/config.json"
  if [ ! -f "$CONFIG_PATH" ]; then
    mkdir -p "$DATA_DIR"
    cp config.example.json "$CONFIG_PATH"
    info "Created $CONFIG_PATH (read for every workspace)"
    warn "Set HYDRADB_API_KEY, HYDRADB_TENANT_ID, and HYDRADB_COLLECTION in your environment, or edit $CONFIG_PATH."
  else
    info "$CONFIG_PATH already exists - skipping"
  fi
else
  CONFIG_PATH=".hydradb-plugin.json"
  if [ ! -f .hydradb-plugin.json ]; then
    cp config.example.json .hydradb-plugin.json
    info "Created .hydradb-plugin.json from config.example.json"
    warn "Set HYDRADB_API_KEY, HYDRADB_TENANT_ID, and HYDRADB_COLLECTION in your environment, or copy .hydradb-plugin.json into each workspace you open."
  else
    info ".hydradb-plugin.json already exists - skipping"
  fi
fi

# ── Syntax check ───────────────────────────────────────────────────────────────

printf "\n%s\n" "── Running syntax check ──"

if npm run check; then
  info "Syntax check passed"
else
  warn "Syntax check had issues - review errors above"
fi

# ── Next steps ─────────────────────────────────────────────────────────────────

printf "\n%s\n" "── Next steps ──"
echo ""
echo "  1. Set your HydraDB credentials:"
echo "       export HYDRADB_API_KEY=\"your-api-key\""
echo "       export HYDRADB_TENANT_ID=\"your-tenant-id\""
echo "       export HYDRADB_COLLECTION=\"\"   # empty uses the default sub-tenant"
echo ""
echo "  2. Or edit the config file created above with your values:"
echo "       ${CONFIG_PATH}"
echo ""
echo "  3. Install the plugin in Claude Code:"
echo "       /plugin marketplace add /absolute/path/to/hydradb-claude-code"
echo "       /plugin install hydradb@hydradb"
echo ""
echo "  4. Reload Claude Code and run /hydradb:status to verify."
echo ""
info "Bootstrap complete!"
