#!/usr/bin/env bash
# session-end.sh — Stop hook
# Flushes buffer via obsidian-logger.mjs and cleans up

{
    HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

    # Run the logger with end-of-session trigger
    node "$HOOKS_DIR/obsidian-logger.mjs" --trigger end-of-session 2>> /tmp/claudelogs-errors.log

    # Clean up
    rm -f /tmp/claude-last-cwd

} 2>> /tmp/claudelogs-errors.log || true
