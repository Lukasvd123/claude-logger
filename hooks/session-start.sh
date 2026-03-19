#!/usr/bin/env bash
# session-start.sh — called via 'cc' alias
# Fetches KB context and launches claude with injected knowledge
# Supports: cc search "query", cc --update, cc [normal args]

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Phase 7: Search mode ---
if [ "${1:-}" = "search" ]; then
    shift
    exec "$HOOKS_DIR/cc-search.sh" "$@"
fi

# --- Phase 5: Auto-updater (once per day, 3s timeout) ---
UPDATE_MARKER="/tmp/claudelogs-last-update-check"
VERSION_FILE="$HOOKS_DIR/VERSION"
REPO_RAW="https://raw.githubusercontent.com/Lukasvd123/claude-logger/main"

should_check_update() {
    [ ! -f "$UPDATE_MARKER" ] && return 0
    local last_check
    last_check=$(cat "$UPDATE_MARKER" 2>/dev/null || echo 0)
    local now
    now=$(date +%s)
    [ $((now - last_check)) -ge 86400 ]
}

if should_check_update; then
    date +%s > "$UPDATE_MARKER"
    LOCAL_VERSION=""
    [ -f "$VERSION_FILE" ] && LOCAL_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')

    REMOTE_VERSION=$(curl -sfL --max-time 3 "${REPO_RAW}/hooks/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "")

    if [ -n "$REMOTE_VERSION" ] && [ "$REMOTE_VERSION" != "$LOCAL_VERSION" ]; then
        echo "Updating claude-logger hooks ($LOCAL_VERSION -> $REMOTE_VERSION)..." >&2
        HOOK_FILES=(
            "hooks/buffer-action.sh"
            "hooks/session-end.sh"
            "hooks/session-start.sh"
            "hooks/obsidian-logger.mjs"
            "hooks/obsidian-kb-reader.mjs"
            "hooks/maintenance.mjs"
            "hooks/cc-search.sh"
            "hooks/VERSION"
        )
        UPDATE_OK=true
        for f in "${HOOK_FILES[@]}"; do
            BASENAME=$(basename "$f")
            if ! curl -sfL --max-time 3 "${REPO_RAW}/${f}" -o "${HOOKS_DIR}/${BASENAME}.tmp" 2>/dev/null; then
                UPDATE_OK=false
                break
            fi
        done

        if [ "$UPDATE_OK" = true ]; then
            for f in "${HOOK_FILES[@]}"; do
                BASENAME=$(basename "$f")
                mv "${HOOKS_DIR}/${BASENAME}.tmp" "${HOOKS_DIR}/${BASENAME}"
            done
            chmod +x "$HOOKS_DIR/buffer-action.sh" "$HOOKS_DIR/session-end.sh" "$HOOKS_DIR/session-start.sh" "$HOOKS_DIR/cc-search.sh"
            echo "Hooks updated to $REMOTE_VERSION" >&2
            # Re-exec with updated session-start.sh
            exec "$HOOKS_DIR/session-start.sh" "$@"
        else
            # Clean up failed download temps
            rm -f "$HOOKS_DIR"/*.tmp 2>/dev/null || true
            echo "Update failed — continuing with current version" >&2
        fi
    fi
fi

# --- KB injection ---
KB_FILE="/tmp/claude-kb-cache.md"
LOG="/tmp/claude-kb-reader.log"

# Fetch KB with 20-second timeout
timeout 20 node "$HOOKS_DIR/obsidian-kb-reader.mjs" > "$KB_FILE" 2>"$LOG" || true

if [ -s "$KB_FILE" ]; then
    KB_SIZE=$(wc -c < "$KB_FILE")
    TIER1_COUNT=$(grep -c '^<!-- tier1-entry -->' "$KB_FILE" 2>/dev/null || echo 0)
    TIER2_COUNT=$(grep -c '^<!-- tier2-entry -->' "$KB_FILE" 2>/dev/null || echo 0)
    ESSENTIALS_COUNT=$(grep -c '^<!-- essentials-entry -->' "$KB_FILE" 2>/dev/null || echo 0)

    # Sanity check
    if [ "$KB_SIZE" -lt 100 ]; then
        echo "KB suspiciously small (${KB_SIZE}B) — check $LOG" >&2
    else
        echo "KB loaded: ${TIER1_COUNT} general + ${TIER2_COUNT} project + ${ESSENTIALS_COUNT} essentials (${KB_SIZE}B)" >&2
    fi

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
    echo "KB empty (check $LOG for errors)" >&2
    # Show diagnostic info on failure
    if [ -s "$LOG" ]; then
        echo "Last error: $(tail -1 "$LOG")" >&2
    fi
    exec claude "$@"
fi
