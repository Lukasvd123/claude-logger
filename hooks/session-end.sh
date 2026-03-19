#!/usr/bin/env bash
# session-end.sh — Stop hook
# Flushes buffer via obsidian-logger.mjs in background and cleans up
# ALL output suppressed — never leak to terminal

# Guard: skip if this is an internal claude call from the logger
[ "${CLAUDELOGS_INTERNAL:-}" = "1" ] && exit 0

{
    INPUT=$(cat)
    HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

    SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

    # Run logger in background with nohup so it survives terminal close
    nohup env CLAUDELOGS_INTERNAL=1 node "$HOOKS_DIR/obsidian-logger.mjs" \
        --trigger end-of-session --session-id "$SESSION_ID" \
        >> /tmp/claudelogs-errors.log 2>&1 &

    # Clean up temp files immediately (buffer is read by logger before we'd race)
    rm -f "/tmp/claude-last-cwd-${SESSION_ID}"
    rm -f "/tmp/claude-last-flush-${SESSION_ID}"

} >> /tmp/claudelogs-errors.log 2>&1 || true
