#!/usr/bin/env bash
# session-start.sh — called via 'cc' alias
# Fetches KB context and launches claude with injected knowledge

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
KB_FILE="/tmp/claude-kb-cache.md"
LOG="/tmp/claude-kb-reader.log"

# Fetch KB with 10-second timeout (5s was too aggressive for tier2 selection)
timeout 10 node "$HOOKS_DIR/obsidian-kb-reader.mjs" > "$KB_FILE" 2>"$LOG" || true

# Log result for debugging
if [ -s "$KB_FILE" ]; then
    KB_SIZE=$(wc -c < "$KB_FILE")
    TIER1_COUNT=$(grep -c '^<!-- tier1-entry -->' "$KB_FILE" 2>/dev/null || echo 0)
    TIER2_COUNT=$(grep -c '^<!-- tier2-entry -->' "$KB_FILE" 2>/dev/null || echo 0)
    ESSENTIALS_COUNT=$(grep -c '^<!-- essentials-entry -->' "$KB_FILE" 2>/dev/null || echo 0)
    echo "📚 KB loaded: ${TIER1_COUNT} general + ${TIER2_COUNT} project + ${ESSENTIALS_COUNT} essentials (${KB_SIZE}B)" >&2

    # Write context to a temp file to avoid arg length limits on large KBs
    PROMPT_FILE="/tmp/claude-system-append.md"
    {
        cat <<'KBEOF'
The following is your own knowledge base from past sessions across all machines.
Use it directly without asking for permission to read it.
Apply known solutions immediately. Avoid known failure patterns.
The "Essentials" section contains credentials, API keys, URLs, and configs — reference these when relevant.

KBEOF
        cat "$KB_FILE"
    } > "$PROMPT_FILE"

    exec claude --append-system-prompt-file "$PROMPT_FILE" "$@"
else
    echo "⚠ KB empty (check $LOG for errors)" >&2
    exec claude "$@"
fi
