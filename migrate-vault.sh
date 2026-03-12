#!/usr/bin/env bash
# migrate-vault.sh — Adds aliases + description fields to existing vault files
# Run once. Safe to re-run (skips files that already have aliases).
set -euo pipefail

VAULT="${VAULT_PATH:-/home/lukasvandee/obsidian-vault}"
LOGS_DIR="$VAULT/claude-logs"
COUNT=0
SKIPPED=0

echo "Migrating vault at: $LOGS_DIR"

# Ensure essentials directory exists
mkdir -p "$LOGS_DIR/essentials"

# --- Dev logs: add description + aliases from title and tags ---
while IFS= read -r file; do
    # Skip if already migrated
    if grep -q '^aliases:' "$file" 2>/dev/null; then
        ((SKIPPED++)) || true
        continue
    fi

    # Extract info from frontmatter
    title=$(grep '^# ' "$file" | head -1 | sed 's/^# //')
    tags_line=$(grep '^tags:' "$file" | head -1 | sed 's/^tags: \[//;s/\]$//')
    project=$(grep '^project:' "$file" | head -1 | awk '{print $2}')
    category=$(basename "$(dirname "$file")")

    # Build aliases from title words and tags
    aliases=()
    if [ -n "$title" ]; then
        aliases+=("$title")
        # Add individual significant words (>3 chars) as search terms
        for word in $title; do
            if [ ${#word} -gt 3 ]; then
                aliases+=("$word")
            fi
        done
    fi

    # Build description from title + category
    desc="${title:-untitled} (${category})"
    if [ -n "$project" ]; then
        desc="$desc for project ${project}"
    fi

    # Insert aliases and description after tags line
    if [ ${#aliases[@]} -gt 0 ]; then
        alias_str=$(printf ', "%s"' "${aliases[@]}")
        alias_str="aliases: [${alias_str:2}]"
        desc_str="description: \"${desc}\""

        # Insert after tags line
        sed -i "/^tags:/a\\
${alias_str}\\
${desc_str}" "$file"
        ((COUNT++)) || true
    fi
done < <(find "$LOGS_DIR/dev-logs" -name "*.md" -type f 2>/dev/null)

# --- KB entries: add aliases from problem/fix text ---
while IFS= read -r file; do
    if grep -q '^aliases:' "$file" 2>/dev/null; then
        ((SKIPPED++)) || true
        continue
    fi

    problem=$(grep '^\*\*Problem:\*\*' "$file" | head -1 | sed 's/\*\*Problem:\*\* //')
    fix=$(grep '^\*\*Fix:\*\*' "$file" | head -1 | sed 's/\*\*Fix:\*\* //')

    aliases=()
    [ -n "$problem" ] && aliases+=("$problem")
    # Extract key terms from problem (words >4 chars)
    if [ -n "$problem" ]; then
        for word in $problem; do
            clean=$(echo "$word" | tr -d '[:punct:]' | tr '[:upper:]' '[:lower:]')
            if [ ${#clean} -gt 4 ]; then
                aliases+=("$clean")
            fi
        done
    fi

    if [ ${#aliases[@]} -gt 0 ]; then
        alias_str=$(printf ', "%s"' "${aliases[@]}")
        alias_str="aliases: [${alias_str:2}]"
        sed -i "/^tags:/a\\
${alias_str}" "$file"
        ((COUNT++)) || true
    fi
done < <(find "$LOGS_DIR/knowledge-base" -name "*.md" -type f 2>/dev/null)

echo "Migrated: $COUNT files"
echo "Skipped (already migrated): $SKIPPED files"
echo "Done. Review changes with: cd $LOGS_DIR && git diff"
