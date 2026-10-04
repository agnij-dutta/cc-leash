#!/usr/bin/env bash
# Try cc-leash without real payment credentials.
#
# Starts Claude Code in a throwaway directory with:
#   - this repo loaded as a plugin (--plugin-dir, nothing is installed)
#   - the bundled fakepay MCP server (no real money)
#   - a demo policy: $100 per call, $250 per session, $500 per day
#   - a throwaway ledger (your real ~/.claude is not touched)
#
# Usage:
#   bash examples/demo/demo.sh                       # interactive
#   bash examples/demo/demo.sh -p "Pay acme-supplies \$500 for server credits"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${LEASH_DEMO_DIR:-$(mktemp -d -t leash-demo)}"
mkdir -p "$WORK"

export LEASH_HOME="$WORK/leash"
export LEASH_GLOBAL_CONFIG="$ROOT/examples/demo/leash.json"

cat > "$WORK/mcp.json" <<JSON
{
  "mcpServers": {
    "fakepay": { "command": "node", "args": ["$ROOT/examples/fakepay/server.mjs"] }
  }
}
JSON

echo "leash demo: workdir $WORK" >&2
echo "            ledger  $LEASH_HOME/ledger.jsonl" >&2
cd "$WORK"
exec claude --plugin-dir "$ROOT" --mcp-config "$WORK/mcp.json" --strict-mcp-config "$@"
