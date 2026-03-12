#!/usr/bin/env bash
# migrate-v3.sh — Reorganize vault from v2 to v3 structure
# - Flatten knowledge-base/tier1 + tier2 → knowledge/ (tier in frontmatter)
# - Convert per-session dev-logs → daily session roll-ups in sessions/
# - Create project + machine hub notes
# - Create Dashboard.md
# Safe to re-run. Moves files, doesn't delete originals until confirmed.
set -uo pipefail

VAULT="${VAULT_PATH:-/home/lukasvandee/obsidian-vault}"
CL="$VAULT/claude-logs"

echo "Migrating vault at: $CL"

# Create new directories
mkdir -p "$CL"/{knowledge,sessions,projects,machines,essentials}

# --- 1. Flatten knowledge-base → knowledge ---
MOVED_KB=0

# tier1 files
if [ -d "$CL/knowledge-base/tier1" ]; then
    for f in "$CL/knowledge-base/tier1"/*.md; do
        [ -f "$f" ] || continue
        bn=$(basename "$f")
        [ "$bn" = ".gitkeep" ] && continue
        # Ensure tier: tier1 is in frontmatter
        if ! grep -q '^tier: tier1' "$f"; then
            sed -i '/^tags:/a tier: tier1' "$f"
        fi
        cp "$f" "$CL/knowledge/$bn"
        MOVED_KB=$((MOVED_KB + 1))
    done
fi

# tier2 files (project subdirs)
if [ -d "$CL/knowledge-base/tier2" ]; then
    for projdir in "$CL/knowledge-base/tier2"/*/; do
        [ -d "$projdir" ] || continue
        proj=$(basename "$projdir")
        for f in "$projdir"*.md; do
            [ -f "$f" ] || continue
            bn=$(basename "$f")
            [ "$bn" = ".gitkeep" ] && continue
            # Ensure tier: tier2 and project field
            if ! grep -q '^tier: tier2' "$f"; then
                sed -i '/^tags:/a tier: tier2' "$f"
            fi
            if ! grep -q "^project:" "$f"; then
                sed -i "/^tier:/a project: $proj" "$f"
            fi
            cp "$f" "$CL/knowledge/$bn"
            MOVED_KB=$((MOVED_KB + 1))
        done
    done
fi
echo "Knowledge: moved $MOVED_KB entries to knowledge/"

# --- 2. Convert dev-logs → daily session roll-ups ---
CONVERTED=0
declare -A SESSION_FILES

for f in $(find "$CL/dev-logs" -name "*.md" -type f 2>/dev/null | sort); do
    [ -f "$f" ] || continue

    # Extract date, machine, project from frontmatter
    date_val=$(grep '^date:' "$f" | head -1 | awk '{print $2}')
    machine_val=$(grep '^machine:' "$f" | head -1 | sed 's/^machine: //')
    project_val=$(grep '^project:' "$f" | head -1 | awk '{print $2}')
    category_val=$(basename "$(dirname "$f")")
    title_val=$(grep '^# ' "$f" | head -1 | sed 's/^# //')
    duration_val=$(grep '^duration:' "$f" | head -1 | sed 's/^duration: //')
    tags_line=$(grep '^tags:' "$f" | head -1 | sed 's/^tags: \[//;s/\]$//')

    [ -z "$date_val" ] && continue
    [ -z "$machine_val" ] && machine_val="unknown"

    # Safe machine name for filename
    safe_machine=$(echo "$machine_val" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9.-]/-/g')
    session_file="$CL/sessions/${date_val}-${safe_machine}.md"

    # Create session file if new
    if [ ! -f "$session_file" ]; then
        cat > "$session_file" <<EOF
---
date: ${date_val}
machine: ${machine_val}
tags: [session, ${safe_machine}]
---

# Sessions — ${date_val} on [[${safe_machine}]]

EOF
        SESSION_FILES["$session_file"]=1
    fi

    # Extract the body (after frontmatter)
    body=$(awk '/^---$/{c++; next} c>=2{print}' "$f")
    asked=$(echo "$body" | grep '^\*\*Asked:\*\*' | sed 's/\*\*Asked:\*\* //')
    done_items=$(echo "$body" | sed -n '/^\*\*Done:\*\*/,/^$/p' | grep '^- ')
    files_items=$(echo "$body" | sed -n '/^\*\*Files:\*\*/,/^$/p' | grep '^- ')

    # Append entry to session file
    cat >> "$session_file" <<EOF
## ${title_val:-untitled}

**Category:** ${category_val} | **Duration:** ${duration_val:-?} | **Project:** [[${project_val:-unknown}]]

${done_items:-No details recorded.}

$([ -n "$files_items" ] && echo "**Files:**" && echo "$files_items")

$(echo "$tags_line" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' | sed 's/^/#/' | tr '\n' ' ')#${category_val}

---

EOF
    CONVERTED=$((CONVERTED + 1))
done
echo "Sessions: converted $CONVERTED dev-log entries to daily roll-ups"

# --- 3. Create machine hub notes ---
MACHINES=0
for session_file in "$CL/sessions"/*.md; do
    [ -f "$session_file" ] || continue
    machine=$(grep '^machine:' "$session_file" | head -1 | sed 's/^machine: //')
    [ -z "$machine" ] && continue
    safe=$(echo "$machine" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9.-]/-/g')
    hub="$CL/machines/${safe}.md"
    [ -f "$hub" ] && continue

    cat > "$hub" <<EOF
---
tags: [machine, ${safe}]
---

# ${machine}

Auto-generated machine hub. All sessions and knowledge linked to this machine appear in **backlinks** (right sidebar).

#machine #${safe}
EOF
    MACHINES=$((MACHINES + 1))
done
echo "Machines: created $MACHINES hub notes"

# --- 4. Create project hub notes ---
PROJECTS=0
for f in $(find "$CL" -name "*.md" -type f); do
    proj=$(grep '^project:' "$f" 2>/dev/null | head -1 | awk '{print $2}')
    [ -z "$proj" ] && continue
    hub="$CL/projects/${proj}.md"
    [ -f "$hub" ] && continue

    cat > "$hub" <<EOF
---
tags: [project, ${proj}]
---

# ${proj}

Auto-generated project hub. All linked notes appear in the **backlinks panel** (right sidebar).

## How to use

- **Backlinks panel**: shows all sessions, knowledge, and essentials for this project
- **Graph view**: shows connections to machines, other projects, and knowledge
- **Search**: use the project name or tags

#project #${proj}
EOF
    PROJECTS=$((PROJECTS + 1))
done
echo "Projects: created $PROJECTS hub notes"

# --- 5. Create Dashboard ---
DASH="$CL/Dashboard.md"
if [ ! -f "$DASH" ]; then
    cat > "$DASH" <<'EOF'
---
tags: [dashboard]
pinned: true
---

# Claude Logs Dashboard

## Essentials & Credentials
Browse the `essentials/` folder to find all stored credentials, API keys, URLs, and configs.
Each project has its own essentials file — search for "essentials" to find them all.

## Knowledge Base
Browse `knowledge/` — all reusable solutions and patterns in one flat folder.
- **#tier1** = universal patterns (useful across all projects)
- **#tier2** = project/context-specific knowledge

## Sessions
Browse `sessions/` — daily logs grouped by machine. One file per day per machine.
All the mini-sessions from a conversation are grouped together.

## Navigation

| Action | How |
|--------|-----|
| Find everything about a server | Search the machine name, or open its hub in `machines/` |
| Find a password | Search "essentials" or browse `essentials/` |
| See what happened on a day | Open `sessions/YYYY-MM-DD-machine.md` |
| See all work on a project | Open its hub in `projects/` → check backlinks |
| Visual overview | Graph view (Ctrl+G) shows all connections |
| Filter by type | Click any tag (#tier1, #credential, #project-name) |

## Folders

- `essentials/` — Credentials, API keys, URLs, configs (living docs, auto-updated)
- `knowledge/` — Reusable solutions and patterns (flat, tier in tags)
- `sessions/` — Daily session logs per machine (grouped conversations)
- `projects/` — Project hub pages (backlinks show everything related)
- `machines/` — Machine hub pages (backlinks show all activity)
- `diff-summaries/` — Git operation changelogs
- `time-log/` — Monthly time tracking tables
EOF
    echo "Dashboard: created"
else
    echo "Dashboard: already exists, skipping"
fi

echo ""
echo "Migration complete!"
echo ""
echo "The old dev-logs/ and knowledge-base/ directories are preserved."
echo "Once you've verified everything looks good in Obsidian, you can remove them:"
echo "  rm -rf $CL/dev-logs $CL/knowledge-base"
echo ""
echo "Review: cd $CL && git diff --stat"
