#!/usr/bin/env bash
# buffer-action.sh — PostToolUse hook
# Appends structured JSON lines to a per-session buffer

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

    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
    TOOL_INPUT_RAW=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null | head -c 150)

    # Classify action type
    ACTION_TYPE="general"
    EXTRA=""

    if [ "$TOOL_NAME" = "Bash" ]; then
        CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
        EXTRA=$(echo "$CMD" | head -c 150)
        if echo "$CMD" | grep -qE '^\s*git\s+(commit|push|merge|pull|rebase|cherry-pick|tag)'; then
            ACTION_TYPE="git_op"
        elif echo "$CMD" | grep -qE '^\s*(chmod|chown)'; then
            ACTION_TYPE="permission_change"
        elif echo "$CMD" | grep -qE '^\s*(mkdir|cp|mv|rm|rmdir|ln)'; then
            ACTION_TYPE="fs_op"
        fi
    elif [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ]; then
        ACTION_TYPE="file_write"
        EXTRA=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
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
        '{timestamp:$ts, hostname:$host, cwd:$cwd, tool_name:$tool, action_type:$action, extra:$extra, tool_input_preview:$input}' \
        >> "$BUFFER"

    # Mid-session flush: cwd changed AND buffer >= 3 lines
    LAST_CWD_FILE="/tmp/claude-last-cwd-${SESSION_ID}"
    if [ -f "$LAST_CWD_FILE" ]; then
        LAST_CWD=$(cat "$LAST_CWD_FILE")
        BUFFER_LINES=$(wc -l < "$BUFFER" 2>/dev/null || echo 0)
        if [ "$CWD" != "$LAST_CWD" ] && [ "$BUFFER_LINES" -ge 3 ]; then
            HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
            CLAUDELOGS_INTERNAL=1 node "$HOOKS_DIR/obsidian-logger.mjs" --trigger mid-session --session-id "$SESSION_ID" >> /tmp/claudelogs-errors.log 2>&1 &
        fi
    fi
    echo "$CWD" > "$LAST_CWD_FILE"

} 2>> /tmp/claudelogs-errors.log || true
