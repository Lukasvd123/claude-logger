#!/usr/bin/env bash
# cc-search.sh — Phase 7: Quick KB search from terminal
# Usage: cc search "nordvpn" or cc search "mysql password"

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

VAULT="${VAULT_PATH:-$HOME/obsidian-vault}"
BASE="$VAULT/claude-logs"

if [ $# -eq 0 ]; then
    echo -e "${YELLOW}Usage:${NC} cc search \"query\""
    echo -e "  Searches knowledge/ and essentials/ in your vault"
    exit 1
fi

QUERY="$*"
FOUND=0

search_dir() {
    local dir="$1"
    local label="$2"
    [ -d "$dir" ] || return

    while IFS= read -r file; do
        [ -f "$file" ] || continue
        local matches
        matches=$(grep -in "$QUERY" "$file" 2>/dev/null) || continue
        [ -z "$matches" ] && continue

        FOUND=$((FOUND + 1))
        local fname
        fname=$(basename "$file" .md)
        echo -e "\n${BOLD}${CYAN}[$label]${NC} ${BOLD}$fname${NC}"
        echo -e "${DIM}$file${NC}"

        # Show matches with context
        while IFS= read -r line; do
            local linenum="${line%%:*}"
            local content="${line#*:}"
            # Highlight the query in the match
            local highlighted
            highlighted=$(echo "$content" | grep -i --color=always "$QUERY" 2>/dev/null || echo "$content")
            echo -e "  ${DIM}L${linenum}:${NC} $highlighted"
        done <<< "$matches"
    done < <(find "$dir" -maxdepth 1 -name '*.md' -type f 2>/dev/null)
}

echo -e "${BOLD}Searching for:${NC} $QUERY"
echo -e "${DIM}─────────────────────────────────${NC}"

search_dir "$BASE/knowledge" "KB"
search_dir "$BASE/essentials" "ESS"

if [ "$FOUND" -eq 0 ]; then
    echo -e "\n${YELLOW}No results found.${NC}"
    echo -e "Try broader terms or check: $BASE/knowledge/ and $BASE/essentials/"
else
    echo -e "\n${DIM}─────────────────────────────────${NC}"
    echo -e "${GREEN}$FOUND file(s) matched.${NC}"
fi
