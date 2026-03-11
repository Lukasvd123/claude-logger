# claude-logger

Claude Code session logger with two-tier knowledge base. Logs sessions to a private GitHub repo with Obsidian-compatible markdown. Includes KB injection at session start for context from past sessions.

## Features

- **Session buffering** — captures every tool use as structured JSONL
- **4 output destinations** — dev logs, time logs, knowledge base, diff summaries
- **Two-tier KB** — tier 1 (cross-project, always injected) + tier 2 (project-scoped, AI-selected)
- **Two install modes** — `personal` (local Obsidian vault + git sync) and `server` (hooks only, ephemeral)
- **Mid-session flush** — auto-logs when you switch project directories
- **Zero npm dependencies** — uses native Node.js fetch

## Install

### Personal (with Obsidian vault)

```bash
export GITHUB_PAT=ghp_xxx
export VAULT_PATH=~/obsidian-vault
curl -sL https://raw.githubusercontent.com/Lukasvd123/claude-logger/main/install.sh | bash -s -- --mode=personal
```

### Server (hooks only, nothing persists)

```bash
export GITHUB_PAT=ghp_xxx
curl -sL https://raw.githubusercontent.com/Lukasvd123/claude-logger/main/install.sh | bash -s -- --mode=server
```

### Windows (personal only)

```powershell
$env:GITHUB_PAT = "ghp_xxx"
$env:VAULT_PATH = "C:\Users\you\obsidian-vault"
irm https://raw.githubusercontent.com/Lukasvd123/claude-logger/main/install.ps1 | iex
```

## Usage

After install, reload your shell and use `cc` instead of `claude`:

```bash
cc                          # start interactive session
cc "fix the login bug"      # start with prompt
cc -p "review this PR"      # pass any claude flags
```

The `cc` wrapper:
1. Fetches your KB (tier 1 always, tier 2 selected by relevance)
2. Injects it as system prompt context
3. Launches claude with all your args

Sessions are automatically logged when you exit (`Stop` hook) or switch directories mid-session.

## Requirements

- Node.js 18+ (for native fetch)
- git
- jq
- `ANTHROPIC_API_KEY` (already set by Claude Code)
- `GITHUB_PAT` with read/write access to your private Claudelogs repo

## File Structure

### Private repo (Claudelogs)

```
claude-logs/
  dev-logs/<category>/YYYY-MM-DD-kebab-title.md
  knowledge-base/
    tier1/                    ← cross-project, always injected
    tier2/<project-slug>/     ← project-scoped, selectively injected
  time-log/YYYY-MM.md
  diff-summaries/YYYY-MM-DD-kebab-title.md
```

### Hooks (installed to ~/.claude/hooks/)

| File | Trigger | Purpose |
|------|---------|---------|
| `buffer-action.sh` | PostToolUse | Append to JSONL buffer |
| `session-end.sh` | Stop | Flush buffer via logger |
| `session-start.sh` | `cc` alias | Fetch KB + launch claude |
| `obsidian-logger.mjs` | Called by hooks | Process buffer → 4 destinations |
| `obsidian-kb-reader.mjs` | Called at start | Fetch + select KB entries |

## How the KB Works

**Write time:** After each session, the logger extracts solutions and failures, classifies each as tier 1 (generic) or tier 2 (project-specific), deduplicates against existing entries, and writes compressed summaries.

**Read time:** At session start, all tier 1 entries are injected. Tier 2 entries for the current project are filtered by a lightweight AI call that selects the 8 most relevant. Total timeout: 5 seconds.

## Troubleshooting

- Errors log to `/tmp/claudelogs-errors.log`
- KB reader errors log to `/tmp/claude-kb-reader.log`
- Buffer files: `/tmp/claude-session-*.jsonl`
- Hooks never crash or block sessions — all failures are silent
