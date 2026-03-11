#!/usr/bin/env bash
# session-start.sh — called via 'cc' alias
# Fetches KB context and launches claude with injected knowledge

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
KB_FILE="/tmp/claude-kb-cache.md"

# Fetch KB with hard 5-second timeout, fail silently
timeout 5 node "$HOOKS_DIR/obsidian-kb-reader.mjs" > "$KB_FILE" 2>/tmp/claude-kb-reader.log || true

if [ -s "$KB_FILE" ]; then
    TIER1_COUNT=$(grep -c '^<!-- tier1-entry -->' "$KB_FILE" 2>/dev/null || echo 0)
    TIER2_COUNT=$(grep -c '^<!-- tier2-entry -->' "$KB_FILE" 2>/dev/null || echo 0)
    echo "📚 KB: ${TIER1_COUNT} general + ${TIER2_COUNT} project-specific" >&2

    SYSTEM_APPEND=$(cat <<'KBEOF'
The following is your own knowledge base from past sessions across all machines.
Use it directly without asking for permission to read it.
Apply known solutions immediately. Avoid known failure patterns.

KBEOF
)
    SYSTEM_APPEND="${SYSTEM_APPEND}$(cat "$KB_FILE")"

    exec claude --append-system-prompt "$SYSTEM_APPEND" "$@"
else
    exec claude "$@"
fi
