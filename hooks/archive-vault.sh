#!/usr/bin/env bash
# archive-vault.sh — Phase 0: Fix & archive vault, create clean v3 structure
# One-time script. Safe to re-run (idempotent checks).

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!!]${NC} $1"; }
error() { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

VAULT="${VAULT_PATH:-$HOME/obsidian-vault}"
[ -d "$VAULT" ] || error "Vault not found at $VAULT"
cd "$VAULT"

DATE=$(date +%Y-%m-%d)
ARCHIVE_DIR="claude-logs/archive/v2-${DATE}"

# 1. Abort stuck rebase/merge
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    warn "Stuck rebase detected — aborting"
    git rebase --abort 2>/dev/null || true
    info "Rebase aborted"
fi
if [ -f .git/MERGE_HEAD ]; then
    warn "Stuck merge detected — aborting"
    git merge --abort 2>/dev/null || true
    info "Merge aborted"
fi

# 2. Delete empty orphan files in vault root (markdown files with 0 bytes)
ORPHANS=0
for f in *.md; do
    [ -f "$f" ] || continue
    if [ ! -s "$f" ]; then
        rm -f "$f"
        ((ORPHANS++)) || true
    fi
done
[ "$ORPHANS" -gt 0 ] && info "Deleted $ORPHANS empty orphan files" || info "No empty orphan files found"

# 3. Archive existing claude-logs content
if [ -d "claude-logs" ] && [ ! -d "$ARCHIVE_DIR" ]; then
    mkdir -p "$ARCHIVE_DIR"
    # Move everything except archive/ itself
    for item in claude-logs/*; do
        [ -e "$item" ] || continue
        base=$(basename "$item")
        [ "$base" = "archive" ] && continue
        mv "$item" "$ARCHIVE_DIR/" 2>/dev/null || true
    done
    info "Archived existing claude-logs content to $ARCHIVE_DIR"
else
    info "Archive already exists or no claude-logs dir — skipping"
fi

# 4. Remove old knowledge-base structure
if [ -d "claude-logs/knowledge-base" ]; then
    rm -rf "claude-logs/knowledge-base"
    info "Removed legacy knowledge-base/ structure"
fi
# Also check archive for lingering refs
if [ -d "knowledge-base" ]; then
    mv "knowledge-base" "$ARCHIVE_DIR/knowledge-base-root" 2>/dev/null || true
    info "Moved root-level knowledge-base/ to archive"
fi

# 5. Create clean directory structure
for dir in knowledge sessions essentials time-log projects machines; do
    mkdir -p "claude-logs/$dir"
done
info "Created fresh v3 directory structure"

# 6. Commit and push
git add -A
if git status --porcelain | grep -q .; then
    git -c commit.gpgsign=false commit -m "archive: migrate to v3 structure (${DATE})"
    git push || warn "Push failed — run 'git push' manually"
    info "Committed and pushed archive migration"
else
    info "Nothing to commit — vault already clean"
fi

echo ""
info "Vault migration complete!"
echo "  Archive: $ARCHIVE_DIR"
echo "  Structure:"
echo "    claude-logs/knowledge/    - Flat KB entries"
echo "    claude-logs/sessions/     - Daily roll-ups"
echo "    claude-logs/essentials/   - Credentials & configs"
echo "    claude-logs/time-log/     - Monthly tables"
echo "    claude-logs/projects/     - Project hub notes"
echo "    claude-logs/machines/     - Machine hub notes"
