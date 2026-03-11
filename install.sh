#!/usr/bin/env bash
set -euo pipefail

# install.sh — Claude Code session logger installer
# Usage:
#   GITHUB_PAT=xxx VAULT_PATH=~/obsidian-vault bash install.sh --mode=personal
#   GITHUB_PAT=xxx bash install.sh --mode=server

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# --- Parse args ---
MODE=""
for arg in "$@"; do
    case "$arg" in
        --mode=personal) MODE="personal" ;;
        --mode=server)   MODE="server" ;;
        GITHUB_PAT=*)    export GITHUB_PAT="${arg#GITHUB_PAT=}" ;;
        VAULT_PATH=*)    export VAULT_PATH="${arg#VAULT_PATH=}" ;;
    esac
done
[ -z "$MODE" ] && error "Usage: install.sh --mode=personal|server"

# --- Validate env vars ---
[ -z "${GITHUB_PAT:-}" ] && error "GITHUB_PAT is required. Use: export GITHUB_PAT=xxx before running, or pass as arg."
if [ "$MODE" = "personal" ]; then
    [ -z "${VAULT_PATH:-}" ] && error "VAULT_PATH is required for personal mode"
fi

# --- Check dependencies ---
check_dep() {
    if ! command -v "$1" &>/dev/null; then
        warn "$1 not found."
        if command -v dnf &>/dev/null; then
            echo "  Install with: sudo dnf install $2"
        elif command -v apt-get &>/dev/null; then
            echo "  Install with: sudo apt-get install $2"
        elif command -v brew &>/dev/null; then
            echo "  Install with: brew install $2"
        else
            echo "  Please install $1 manually"
        fi
        return 1
    fi
    return 0
}

MISSING=0
check_dep node nodejs || MISSING=1
check_dep jq jq || MISSING=1
check_dep git git || MISSING=1
[ "$MISSING" -eq 1 ] && error "Install missing dependencies and re-run"

# Check Node version (need 18+ for native fetch)
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
    error "Node.js 18+ required for native fetch (found v${NODE_MAJOR})"
fi

info "Dependencies OK (node $(node -v), jq $(jq --version 2>&1), git $(git --version | awk '{print $3}'))"

# --- Setup directories ---
HOOKS_DIR="$HOME/.claude/hooks"
mkdir -p "$HOOKS_DIR"
info "Hooks directory: $HOOKS_DIR"

# --- Download hook files ---
REPO_RAW="https://raw.githubusercontent.com/Lukasvd123/claude-logger/main"
HOOK_FILES=(
    "hooks/buffer-action.sh"
    "hooks/session-end.sh"
    "hooks/session-start.sh"
    "hooks/obsidian-logger.mjs"
    "hooks/obsidian-kb-reader.mjs"
)

for f in "${HOOK_FILES[@]}"; do
    BASENAME=$(basename "$f")
    curl -sfL "${REPO_RAW}/${f}" -o "${HOOKS_DIR}/${BASENAME}" || error "Failed to download ${f}"
    info "Downloaded ${BASENAME}"
done

# Make shell scripts executable
chmod +x "$HOOKS_DIR/buffer-action.sh"
chmod +x "$HOOKS_DIR/session-end.sh"
chmod +x "$HOOKS_DIR/session-start.sh"
info "Shell scripts marked executable"

# --- Personal mode: clone Claudelogs repo ---
if [ "$MODE" = "personal" ]; then
    VAULT_PATH_EXPANDED=$(eval echo "$VAULT_PATH")
    if [ ! -d "$VAULT_PATH_EXPANDED/.git" ]; then
        CLONE_URL="https://Lukasvd123:${GITHUB_PAT}@github.com/Lukasvd123/Claudelogs.git"
        git clone "$CLONE_URL" "$VAULT_PATH_EXPANDED" 2>/dev/null
        info "Cloned Claudelogs to $VAULT_PATH_EXPANDED"
    else
        info "Claudelogs already cloned at $VAULT_PATH_EXPANDED"
    fi
    # Ensure directory structure exists
    mkdir -p "$VAULT_PATH_EXPANDED/claude-logs"/{dev-logs,knowledge-base/tier1,knowledge-base/tier2,time-log,diff-summaries}
fi

# --- Detect shell profile ---
SHELL_NAME=$(basename "$SHELL")
case "$SHELL_NAME" in
    zsh)  PROFILE="$HOME/.zshrc" ;;
    bash) PROFILE="$HOME/.bashrc" ;;
    *)    PROFILE="$HOME/.profile" ;;
esac

# --- Write env vars + cc alias ---
MARKER="# claude-logger"
if ! grep -q "$MARKER" "$PROFILE" 2>/dev/null; then
    {
        echo ""
        echo "$MARKER"
        echo "export GITHUB_PAT=\"${GITHUB_PAT}\""
        if [ "$MODE" = "personal" ]; then
            echo "export VAULT_PATH=\"${VAULT_PATH}\""
        fi
        echo "export CLAUDELOGS_MODE=\"${MODE}\""
        echo "cc() { \"\$HOME/.claude/hooks/session-start.sh\" \"\$@\"; }"
    } >> "$PROFILE"
    info "Added env vars + cc alias to $PROFILE"
else
    warn "claude-logger block already exists in $PROFILE — skipping"
fi

# --- Merge settings.json ---
SETTINGS_FILE="$HOME/.claude/settings.json"
SETTINGS_URL="${REPO_RAW}/settings.json"
NEW_SETTINGS=$(curl -sfL "$SETTINGS_URL") || error "Failed to download settings.json"

if [ -f "$SETTINGS_FILE" ]; then
    # Merge hooks into existing settings
    EXISTING=$(cat "$SETTINGS_FILE")
    MERGED=$(echo "$EXISTING" | jq --argjson new "$NEW_SETTINGS" '
        .hooks.PostToolUse = ((.hooks.PostToolUse // []) + $new.hooks.PostToolUse | unique_by(.hooks[0].command)) |
        .hooks.Stop = ((.hooks.Stop // []) + $new.hooks.Stop | unique_by(.hooks[0].command))
    ')
    echo "$MERGED" > "$SETTINGS_FILE"
    warn "Merged hook settings into existing $SETTINGS_FILE"
else
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    echo "$NEW_SETTINGS" > "$SETTINGS_FILE"
    info "Created $SETTINGS_FILE"
fi

# --- Done ---
echo ""
info "Installation complete! (mode: $MODE)"
echo ""
echo "  Reload your shell:  source $PROFILE"
echo "  Start a session:    cc"
echo "  Or:                 cc \"fix the login bug\""
echo ""
if [ "$MODE" = "personal" ]; then
    echo "  Vault path:  $VAULT_PATH"
fi
echo "  Hooks dir:   $HOOKS_DIR"
echo "  Errors log:  /tmp/claudelogs-errors.log"
