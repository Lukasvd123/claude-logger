#!/usr/bin/env bash
# buffer-action.sh — PostToolUse hook
# Appends structured JSON lines to a per-session buffer
# ALL output suppressed — never leak to terminal

# Guard: skip if this is an internal claude call from the logger
[ "${CLAUDELOGS_INTERNAL:-}" = "1" ] && exit 0

{
    INPUT=$(cat)

    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    HOSTNAME_VAL=$(hostname)
    CWD=$(pwd)

    # Extract session_id for per-session isolation
    SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
    BUFFER="/tmp/claude-session-${SESSION_ID}.jsonl"

    # Buffer size guard: stop appending if JSONL > 200KB
    if [ -f "$BUFFER" ]; then
        BUFFER_SIZE=$(stat -c%s "$BUFFER" 2>/dev/null || echo 0)
        if [ "$BUFFER_SIZE" -ge 204800 ]; then
            exit 0
        fi
    fi

    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
    TOOL_INPUT_RAW=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null | head -c 500)

    # Classify action type and capture content preview
    ACTION_TYPE="general"
    EXTRA=""
    CONTENT_PREVIEW=""

    if [ "$TOOL_NAME" = "Bash" ]; then
        CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
        EXTRA=$(echo "$CMD" | head -c 500)
        if echo "$CMD" | grep -qE '^\s*git\s+(commit|push|merge|pull|rebase|cherry-pick|tag)'; then
            ACTION_TYPE="git_op"
            # Capture git diff stat for commits
            if echo "$CMD" | grep -qE '^\s*git\s+commit'; then
                CONTENT_PREVIEW=$(git diff HEAD~1 HEAD --stat 2>/dev/null | head -c 1000 || echo "")
            fi
        elif echo "$CMD" | grep -qE '^\s*(chmod|chown)'; then
            ACTION_TYPE="permission_change"
        elif echo "$CMD" | grep -qE '^\s*(mkdir|cp|mv|rm|rmdir|ln)'; then
            ACTION_TYPE="fs_op"
        fi
    elif [ "$TOOL_NAME" = "Write" ]; then
        ACTION_TYPE="file_write"
        EXTRA=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
        # Capture first 1000 chars of file content
        CONTENT_PREVIEW=$(echo "$INPUT" | jq -r '.tool_input.content // ""' | head -c 1000)
    elif [ "$TOOL_NAME" = "Edit" ]; then
        ACTION_TYPE="file_write"
        EXTRA=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
        # Capture old_string -> new_string (300 chars each)
        OLD_STR=$(echo "$INPUT" | jq -r '.tool_input.old_string // ""' | head -c 300)
        NEW_STR=$(echo "$INPUT" | jq -r '.tool_input.new_string // ""' | head -c 300)
        CONTENT_PREVIEW="OLD: ${OLD_STR}
NEW: ${NEW_STR}"
    fi

    # Append to buffer
    jq -nc \
        --arg ts "$TIMESTAMP" \
        --arg host "$HOSTNAME_VAL" \
        --arg cwd "$CWD" \
        --arg tool "$TOOL_NAME" \
        --arg action "$ACTION_TYPE" \
        --arg extra "$EXTRA" \
        --arg input "$TOOL_INPUT_RAW" \
        --arg preview "$CONTENT_PREVIEW" \
        '{timestamp:$ts, hostname:$host, cwd:$cwd, tool_name:$tool, action_type:$action, extra:$extra, tool_input_preview:$input, content_preview:$preview}' \
        >> "$BUFFER"

    # Mid-session flush: only if meaningful work happened + cooldown
    LAST_CWD_FILE="/tmp/claude-last-cwd-${SESSION_ID}"
    LAST_FLUSH_FILE="/tmp/claude-last-flush-${SESSION_ID}"
    if [ -f "$LAST_CWD_FILE" ]; then
        LAST_CWD=$(cat "$LAST_CWD_FILE")
        BUFFER_LINES=$(wc -l < "$BUFFER" 2>/dev/null || echo 0)

        # Count meaningful actions (file writes + git ops), not just reads
        MEANINGFUL=$(grep -cE '"action_type":"(file_write|git_op|fs_op|permission_change)"' "$BUFFER" 2>/dev/null || echo 0)

        # 5-minute cooldown between mid-session flushes
        NOW=$(date +%s)
        LAST_FLUSH=0
        [ -f "$LAST_FLUSH_FILE" ] && LAST_FLUSH=$(cat "$LAST_FLUSH_FILE" 2>/dev/null || echo 0)
        ELAPSED=$(( NOW - LAST_FLUSH ))

        if [ "$CWD" != "$LAST_CWD" ] && [ "$BUFFER_LINES" -ge 8 ] && [ "$MEANINGFUL" -ge 3 ] && [ "$ELAPSED" -ge 300 ]; then
            HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
            echo "$NOW" > "$LAST_FLUSH_FILE"
            CLAUDELOGS_INTERNAL=1 node "$HOOKS_DIR/obsidian-logger.mjs" --trigger mid-session --session-id "$SESSION_ID" &
        fi
    fi
    echo "$CWD" > "$LAST_CWD_FILE"

} >> /tmp/claudelogs-errors.log 2>&1 || true
