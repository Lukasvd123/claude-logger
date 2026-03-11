#!/usr/bin/env bash
# session-end.sh — Stop hook
# Flushes buffer via obsidian-logger.mjs and cleans up

{
    INPUT=$(cat)
    HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

    # Extract session_id for per-session isolation
    SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

    # Run the logger with end-of-session trigger
    node "$HOOKS_DIR/obsidian-logger.mjs" --trigger end-of-session --session-id "$SESSION_ID" 2>> /tmp/claudelogs-errors.log

    # Clean up per-session files
    rm -f "/tmp/claude-last-cwd-${SESSION_ID}"

} 2>> /tmp/claudelogs-errors.log || true
