#!/usr/bin/env node
// obsidian-logger.mjs — Write-time processor for Claude Code session logs
// v3.1: Sonnet analysis, semantic dedup, merge-based git, lock files, content previews
// Uses `claude -p` (local CLI) — works with OAuth subscriptions, no API key needed.

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmSync, statSync } from 'fs';
import { join, basename } from 'path';

const GITHUB_PAT = process.env.GITHUB_PAT;
const VAULT_PATH = process.env.VAULT_PATH;
const MODE = VAULT_PATH ? 'personal' : 'server';
const REPO_OWNER = 'Lukasvd123';
const REPO_NAME = 'Claudelogs';
const BASE = 'claude-logs';

function getArg(name) {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    const eq = process.argv.find(a => a.startsWith(`--${name}=`));
    if (eq) return eq.split('=').slice(1).join('=');
    return null;
}

const TRIGGER = getArg('trigger') || 'unknown';
const SESSION_ID = getArg('session-id') || 'unknown';

// --- Helpers ---

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function logError(msg) {
    try { writeFileSync('/tmp/claudelogs-errors.log', `[${ts()}] ${msg}\n`, { flag: 'a' }); } catch {}
}
function ensureDir(dir) { mkdirSync(dir, { recursive: true }); }

function getProjectSlug() {
    try {
        const remote = execSync('git remote get-url origin', {
            encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const match = remote.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
        if (match) return `${match[1]}-${match[2]}`.toLowerCase();
    } catch {}
    return basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function readBuffer() {
    const bufferFile = `/tmp/claude-session-${SESSION_ID}.jsonl`;
    const lines = [];
    try {
        const content = readFileSync(bufferFile, 'utf8').trim();
        if (content) {
            for (const line of content.split('\n')) {
                try { lines.push(JSON.parse(line)); } catch {}
            }
        }
    } catch {}
    return lines;
}

function clearBuffer() {
    try { unlinkSync(`/tmp/claude-session-${SESSION_ID}.jsonl`); } catch {}
}

// --- Lock file for concurrent flush prevention ---

const LOCK_FILE = `/tmp/claudelogs-flush-${SESSION_ID}.lock`;

function acquireLock() {
    try {
        writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
        return true;
    } catch {
        // Check if stale (>3 min old)
        try {
            const stat = statSync(LOCK_FILE);
            if (Date.now() - stat.mtimeMs > 180000) {
                unlinkSync(LOCK_FILE);
                writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
                return true;
            }
        } catch {}
        return false;
    }
}

function releaseLock() {
    try { unlinkSync(LOCK_FILE); } catch {}
}

// --- Claude CLI call ---

function claudeCall(prompt, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, CLAUDELOGS_INTERNAL: '1' };
        for (const key of Object.keys(env)) {
            if (key.startsWith('CLAUDE') && key !== 'CLAUDELOGS_INTERNAL') delete env[key];
        }
        const proc = spawn('claude', ['-p', '--model', 'sonnet'], {
            env, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.stdin.write(prompt);
        proc.stdin.end();
        const timer = setTimeout(() => { proc.kill(); reject(new Error('claude -p timed out')); }, timeoutMs);
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
        });
        proc.on('error', err => { clearTimeout(timer); reject(err); });
    });
}

function parseJSON(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const toParse = fenced ? fenced[1].trim() : text.trim();
    try { return JSON.parse(toParse); } catch { return null; }
}

// --- Git operations ---

function getWriteDir() {
    if (MODE === 'personal') return VAULT_PATH;
    return `/tmp/claudelogs-staging-${SESSION_ID}`;
}

function setupServerRepo() {
    const staging = `/tmp/claudelogs-staging-${SESSION_ID}`;
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    const url = `https://${REPO_OWNER}:${GITHUB_PAT}@github.com/${REPO_OWNER}/${REPO_NAME}.git`;
    execSync(`git -c "credential.https://github.com.helper=" clone --depth 1 "${url}" "${staging}"`, {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return staging;
}

// --- Vault health check ---

function vaultHealthCheck(writeDir) {
    const gitDir = join(writeDir, '.git');
    if (!existsSync(gitDir)) return;

    // Detect stuck rebase
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
        logError('Vault health: stuck rebase detected, aborting');
        try { execSync('git rebase --abort', { cwd: writeDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }); } catch {}
    }

    // Detect stuck merge
    if (existsSync(join(gitDir, 'MERGE_HEAD'))) {
        logError('Vault health: stuck merge detected, aborting');
        try { execSync('git merge --abort', { cwd: writeDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }); } catch {}
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function commitAndPush(writeDir, message) {
    const g = 'git -c "credential.https://github.com.helper=" -c commit.gpgsign=false';
    const opts = { cwd: writeDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, encoding: 'utf8' };

    // Health check before any git ops
    vaultHealthCheck(writeDir);

    // Pull latest with merge (not rebase) — append-only files are safe with "theirs"
    try { execSync(`${g} pull --no-rebase -X theirs`, opts); } catch {}

    execSync('git add .', opts);
    try {
        if (!execSync('git status --porcelain', opts).trim()) return;
    } catch {}
    execSync(`${g} commit -m "${message.replace(/"/g, '\\"')}"`, opts);

    // Retry with random jitter to handle concurrent pushes from different machines
    for (let attempt = 1; attempt <= 5; attempt++) {
        try { execSync(`${g} push`, opts); return; } catch (err) {
            if (attempt === 5) throw new Error(`git push failed after 5 attempts: ${err.message}`);
            await sleep(1000 + Math.random() * 2000);
            // Health check before re-pull
            vaultHealthCheck(writeDir);
            try { execSync(`${g} pull --no-rebase -X theirs`, opts); } catch {}
        }
    }
}

function cleanupServer() {
    if (MODE === 'server') {
        try { rmSync(`/tmp/claudelogs-staging-${SESSION_ID}`, { recursive: true, force: true }); } catch {}
    }
}

// --- Semantic dedup ---

function existingKBEntries(writeDir) {
    const entries = [];
    const dir = join(writeDir, BASE, 'knowledge');
    try {
        for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
            const content = readFileSync(join(dir, f), 'utf8');
            const titleMatch = content.match(/^# (.+)$/m);
            const problemMatch = content.match(/\*\*Problem:\*\*\s*(.+)/);
            entries.push({
                file: f,
                title: titleMatch?.[1] || f,
                problem: problemMatch?.[1] || '',
            });
        }
    } catch {}
    return entries;
}

async function semanticDedup(newEntries, existingEntries) {
    if (newEntries.length === 0) return newEntries;

    const allEntries = [
        ...existingEntries.map((e, i) => `[E${i}] "${e.title}" — ${e.problem.slice(0, 100)}`),
        ...newEntries.map((e, i) => `[N${i}] "${e.title}" — ${(e.problem || '').slice(0, 100)}`),
    ];

    if (allEntries.length < 2) return newEntries;

    try {
        const result = await claudeCall(
            `Compare these KB entries. Identify NEW entries (N-prefixed) that are TRUE duplicates of EXISTING entries (E-prefixed). Same problem AND same solution = duplicate. Similar topic but different solution = NOT duplicate. Return JSON: {"duplicates": [0, 2]} — array of N-indices to REMOVE. Return {"duplicates": []} if no duplicates.\n\n${allEntries.join('\n')}`,
            30000,
        );
        const parsed = JSON.parse(result.match(/\{[\s\S]*?\}/)?.[0] || '{"duplicates":[]}');
        const dupes = new Set(parsed.duplicates || []);
        return newEntries.filter((_, i) => !dupes.has(i));
    } catch (err) {
        logError(`Semantic dedup failed, falling back to slug match: ${err.message}`);
        // Fallback: slug-based dedup
        const existingNames = new Set(existingEntries.map(e => e.file.toLowerCase()));
        return newEntries.filter(entry => {
            const slug = (entry.title || entry.problem || 'untitled')
                .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
            for (const name of existingNames) {
                const stripped = name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
                if (stripped.includes(slug) || slug.includes(stripped)) return false;
            }
            return true;
        });
    }
}

// --- Analysis prompt ---

async function analyzeSession(buffer, projectSlug) {
    const hasGitOps = buffer.some(b => b.action_type === 'git_op');
    const hasMeaningfulWork = buffer.some(b =>
        ['file_write', 'git_op', 'fs_op', 'permission_change'].includes(b.action_type)
    );

    const bufferSummary = buffer.map(b => {
        let line = `[${b.timestamp}] ${b.tool_name} (${b.action_type}): ${b.extra || b.tool_input_preview}`;
        if (b.content_preview) {
            line += `\n  CONTENT: ${b.content_preview.slice(0, 500)}`;
        }
        return line;
    }).join('\n');

    const prompt = `You are a structured log analyzer. Analyze this Claude Code session and return a single JSON object. No explanation, no fences, just valid JSON.

{
  "should_log": true,
  "session": {
    "title": "Short human-readable title",
    "category": "feature|bugfix|refactor|config|devops|research|docs|setup|other",
    "what_was_done": ["bullet 1", "bullet 2"],
    "files_touched": ["/path/to/file"],
    "duration_minutes": 0,
    "tags": ["specific-tech", "tool-name", "error-type"]
  },
  "kb_entries": [
    {
      "title": "Short searchable title — include the key tech/tool name",
      "problem": "Detailed description with error messages — what went wrong or what needed solving",
      "root_cause": "Why it happened — the underlying cause",
      "solution": "Step-by-step with actual commands or code changes",
      "gotchas": ["Edge case or caveat 1", "Edge case or caveat 2"],
      "type": "solution|failure|pattern",
      "tier": "tier1|tier2",
      "tags": ["specific", "searchable"],
      "related_to": ["project-slug", "machine-name", "technology"]
    }
  ],
  "essentials": [
    {
      "key": "short-kebab-key",
      "category": "credential|url|config|path|key",
      "value": "the actual value",
      "context": "what this is for",
      "scope": "project-slug or global"
    }
  ]
}

QUALITY GATE for kb_entries: "Would this entry let me solve this exact problem in <2 minutes if I encounter it again in 3 months?" If not, make it more specific or skip it.

CRITICAL tier rules — most entries should be tier2:
- tier1: ONLY if a random developer on a random project would benefit. Universal patterns like "git signing breaks automated commits" or "SELinux blocks service access". Ask yourself: "Would this matter if I was working on a completely different project?" If no → tier2.
- tier2: EVERYTHING ELSE. Project-specific, context-specific, tool-specific workflows, niche tool issues. When in doubt → tier2.

KB entry format requirements:
- title: Specific tech names, not generic ("nginx proxy_pass drops websocket upgrade headers" not "config issue")
- problem: Include actual error messages from the session
- root_cause: Explain WHY, not just WHAT
- solution: Actual commands, code, or config — not vague descriptions
- gotchas: Edge cases, things that almost worked but didn't

Other rules:
- should_log: false if trivial (only reads, browsing, no real work).${!hasMeaningfulWork ? ' No file writes or git ops in this session — strongly consider false.' : ''}
- kb_entries: only genuinely reusable insights. Empty array is fine.
- essentials: capture ALL passwords, API keys, tokens, URLs, connection strings, credential paths, env vars. This is a secure personal log.
- tags: specific, kebab-case. Include technology names, commands, error types.
- related_to: list project slugs, machine names, or technologies this entry relates to.
- Respond with ONLY the JSON object.

Session buffer (project: ${projectSlug}):
${bufferSummary}`;

    const raw = await claudeCall(prompt, 120000);
    return parseJSON(raw);
}

// --- Writers ---

// Session log: daily roll-up per machine
function writeSession(analysis, buffer, writeDir, projectSlug) {
    const s = analysis.session;
    if (!s) return null;

    const hostname = buffer[0]?.hostname || 'unknown';
    const firstTs = buffer[0]?.timestamp || new Date().toISOString();
    const dateStr = firstTs.slice(0, 10);
    const startTime = firstTs.slice(11, 16);
    const title = s.title || 'untitled session';
    const category = s.category || 'other';

    const dir = join(writeDir, BASE, 'sessions');
    ensureDir(dir);
    const filename = `${dateStr}-${hostname}.md`;
    const filepath = join(dir, filename);

    if (!existsSync(filepath)) {
        const frontmatter = [
            '---',
            `date: ${dateStr}`,
            `machine: ${hostname}`,
            `tags: [session, ${hostname}]`,
            '---',
            '',
            `# Sessions — ${dateStr} on [[${hostname}]]`,
            '',
        ].join('\n');
        writeFileSync(filepath, frontmatter);
    }

    const tags = (s.tags || []).map(t => `#${t.replace(/\s+/g, '-')}`).join(' ');
    const entry = [
        `## ${startTime} — ${title}`,
        '',
        `**Category:** ${category} | **Duration:** ~${s.duration_minutes || '?'}min | **Project:** [[${projectSlug}]]`,
        '',
        ...(s.what_was_done || []).map(x => `- ${x}`),
        '',
        ...(s.files_touched || []).length ? ['**Files:**', ...(s.files_touched || []).map(f => `- \`${f}\``), ''] : [],
        `${tags} #${category}`,
        '',
        '---',
        '',
    ].join('\n');

    writeFileSync(filepath, readFileSync(filepath, 'utf8') + entry);

    return { title, category, duration: s.duration_minutes, startTime, hostname };
}

// Time log
function writeTimeLog(buffer, writeDir, projectSlug, sessionResult) {
    const firstTs = buffer[0]?.timestamp || new Date().toISOString();
    const hostname = buffer[0]?.hostname || 'unknown';
    const dateStr = firstTs.slice(0, 10);
    const monthStr = dateStr.slice(0, 7);
    const startTime = firstTs.slice(11, 16);
    const topic = sessionResult?.title || 'session';
    const duration = sessionResult?.duration || '?';

    const dir = join(writeDir, BASE, 'time-log');
    ensureDir(dir);
    const file = join(dir, `${monthStr}.md`);

    let content = '';
    if (existsSync(file)) {
        content = readFileSync(file, 'utf8');
    } else {
        content = `# Time Log — ${monthStr}\n\n| Date | Time | Machine | Duration | Topic | Project |\n|------|------|---------|----------|-------|---------|\n`;
    }
    content += `| ${dateStr} | ${startTime} | [[${hostname}]] | ~${duration}min | ${topic} | [[${projectSlug}]] |\n`;
    writeFileSync(file, content);
}

// Knowledge: flat directory, tier in frontmatter, structured format
async function writeKnowledge(analysis, writeDir, projectSlug) {
    let entries = analysis.kb_entries || [];
    if (entries.length === 0) return;

    const dateStr = new Date().toISOString().slice(0, 10);
    const existing = existingKBEntries(writeDir);

    // Semantic dedup: check new entries against existing
    entries = await semanticDedup(entries, existing);
    if (entries.length === 0) return;

    const dir = join(writeDir, BASE, 'knowledge');
    ensureDir(dir);

    for (const entry of entries) {
        const slug = (entry.title || entry.problem || 'untitled')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

        const tier = entry.tier === 'tier1' ? 'tier1' : 'tier2';
        const tags = [...new Set([tier, entry.type, ...(entry.tags || [])])];
        const relatedLinks = (entry.related_to || [projectSlug])
            .map(r => `[[${r}]]`).join(' ');

        const gotchasSection = (entry.gotchas && entry.gotchas.length > 0)
            ? ['**Gotchas:**', ...entry.gotchas.map(g => `- ${g}`), '']
            : [];

        const content = [
            '---',
            `date: ${dateStr}`,
            `last_verified: ${dateStr}`,
            `type: ${entry.type || 'solution'}`,
            `tier: ${tier}`,
            tier === 'tier2' ? `project: ${projectSlug}` : null,
            `tags: [${tags.join(', ')}]`,
            '---',
            '',
            `# ${entry.title || slug}`,
            '',
            `**Problem:** ${entry.problem || 'N/A'}`,
            '',
            `**Root cause:** ${entry.root_cause || 'N/A'}`,
            '',
            `**Solution:** ${entry.solution || 'N/A'}`,
            '',
            ...gotchasSection,
            `**Related:** ${relatedLinks}`,
            '',
            tags.map(t => `#${t.replace(/\s+/g, '-')}`).join(' '),
            '',
        ].filter(x => x !== null).join('\n');

        const filename = `${dateStr}-${slug}.md`;
        writeFileSync(join(dir, filename), content);
    }
}

// Essentials: per-project living docs
function writeEssentials(analysis, writeDir, projectSlug) {
    const essentials = analysis.essentials || [];
    if (essentials.length === 0) return;

    const dir = join(writeDir, BASE, 'essentials');
    ensureDir(dir);

    const byScope = {};
    for (const e of essentials) {
        const scope = e.scope || projectSlug;
        if (!byScope[scope]) byScope[scope] = [];
        byScope[scope].push(e);
    }

    for (const [scope, entries] of Object.entries(byScope)) {
        const filename = `${scope}.md`;
        const filepath = join(dir, filename);
        const dateStr = new Date().toISOString().slice(0, 10);

        let existing = {};
        if (existsSync(filepath)) {
            const content = readFileSync(filepath, 'utf8');
            const rows = content.match(/^\| .+ \| .+ \| .+ \| .+ \|$/gm) || [];
            for (const row of rows) {
                const cols = row.split('|').map(c => c.trim()).filter(Boolean);
                if (cols.length >= 4 && cols[0] !== 'Key') {
                    existing[cols[0]] = { category: cols[1], value: cols[2], context: cols[3] };
                }
            }
        }

        for (const e of entries) {
            existing[e.key] = { category: e.category, value: e.value, context: e.context };
        }

        const categories = [...new Set(Object.values(existing).map(e => e.category))];

        const content = [
            '---',
            `date: ${dateStr}`,
            `last_verified: ${dateStr}`,
            `tags: [essentials, ${scope}, ${categories.join(', ')}]`,
            '---',
            '',
            `# Essentials — [[${scope}]]`,
            '',
            `> Last updated: ${dateStr}`,
            '',
            '| Key | Type | Value | Context |',
            '|-----|------|-------|---------|',
            ...Object.entries(existing).map(([key, e]) =>
                `| ${key} | ${e.category} | \`${e.value}\` | ${e.context} |`
            ),
            '',
            `#essentials #${scope}`,
            '',
        ].join('\n');

        writeFileSync(filepath, content);
    }
}

// --- Hub notes ---

function ensureProjectHub(writeDir, projectSlug) {
    const dir = join(writeDir, BASE, 'projects');
    ensureDir(dir);
    const filepath = join(dir, `${projectSlug}.md`);

    if (existsSync(filepath)) return;

    const content = [
        '---',
        `tags: [project, ${projectSlug}]`,
        '---',
        '',
        `# ${projectSlug}`,
        '',
        'Auto-generated project hub. All linked notes appear in the **backlinks panel**.',
        '',
        '## Quick Links',
        '',
        `- [[${projectSlug}|Essentials & Credentials]]`,
        '',
        `#project #${projectSlug}`,
        '',
    ].join('\n');

    writeFileSync(filepath, content);
}

function ensureMachineHub(writeDir, hostname) {
    const dir = join(writeDir, BASE, 'machines');
    ensureDir(dir);
    const safe = hostname.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
    const filepath = join(dir, `${safe}.md`);

    if (existsSync(filepath)) return;

    const content = [
        '---',
        `tags: [machine, ${safe}]`,
        '---',
        '',
        `# ${hostname}`,
        '',
        'Auto-generated machine hub. All sessions and knowledge linked to this machine appear in **backlinks**.',
        '',
        `#machine #${safe}`,
        '',
    ].join('\n');

    writeFileSync(filepath, content);
}

// --- Dashboard ---

function ensureDashboard(writeDir) {
    const filepath = join(writeDir, BASE, 'Dashboard.md');
    if (existsSync(filepath)) return;

    const content = [
        '---',
        'tags: [dashboard]',
        'pinned: true',
        '---',
        '',
        '# Claude Logs Dashboard',
        '',
        '## Essentials & Credentials',
        'Browse [[essentials/]] or search for "essentials" to find all stored credentials, API keys, and configs.',
        '',
        '## Knowledge Base',
        'Browse [[knowledge/]] — all reusable solutions and patterns.',
        '- **Tier 1** = universal patterns (tagged #tier1)',
        '- **Tier 2** = project/context-specific (tagged #tier2)',
        '',
        '## Sessions',
        'Browse [[sessions/]] — daily logs grouped by machine.',
        '',
        '## Navigation Tips',
        '- **Search** (Ctrl+Shift+F): search across all notes',
        '- **Backlinks** (right sidebar): click any project/machine hub to see connections',
        '- **Graph view** (Ctrl+G): visual map of all connections',
        '',
    ].join('\n');

    writeFileSync(filepath, content);
}

// --- KB Cleanup (once per day) ---

async function cleanupKB(writeDir) {
    const markerFile = '/tmp/claudelogs-last-cleanup';
    const now = Date.now();
    try {
        const lastRun = parseInt(readFileSync(markerFile, 'utf8').trim(), 10);
        if (now - lastRun < 86400000) return;
    } catch {}
    writeFileSync(markerFile, String(now));

    const dir = join(writeDir, BASE, 'knowledge');
    if (!existsSync(dir)) return;

    const entries = [];
    try {
        for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
            const content = readFileSync(join(dir, f), 'utf8');
            entries.push({ file: join(dir, f), name: f, content: content.slice(0, 300) });
        }
    } catch {}

    if (entries.length < 5) return;

    const summaries = entries.map((e, i) =>
        `[${i}] ${e.name}: ${e.content.replace(/---[\s\S]*?---/, '').trim().slice(0, 150)}`
    ).join('\n');

    try {
        const result = await claudeCall(
            `Review these KB entries. Return ONLY a JSON array of indices for entries that are CLEARLY outdated, superseded by another entry, or duplicates. Be conservative. Return [] if nothing should be removed.\n\nToday: ${new Date().toISOString().slice(0, 10)}\n\n${summaries}`,
            30000,
        );
        const indices = JSON.parse(result.match(/\[[\d,\s]*\]/)?.[0] || '[]');
        let removed = 0;
        for (const idx of indices) {
            if (idx >= 0 && idx < entries.length) {
                try { unlinkSync(entries[idx].file); removed++; } catch {}
            }
        }
        if (removed > 0) logError(`KB cleanup: removed ${removed} stale entries`);
    } catch (err) {
        logError(`KB cleanup failed: ${err.message}`);
    }
}

// --- Main ---

async function main() {
    if (!acquireLock()) {
        logError('Lock file exists — another flush in progress, skipping');
        return;
    }

    try {
        const buffer = readBuffer();
        if (buffer.length === 0) { releaseLock(); return; }

        const projectSlug = getProjectSlug();
        const hostname = buffer[0]?.hostname || 'unknown';
        const writeDir = getWriteDir();

        if (MODE === 'server') setupServerRepo();

        // Vault health check before writing
        if (MODE === 'personal') vaultHealthCheck(writeDir);

        const analysis = await analyzeSession(buffer, projectSlug);
        if (!analysis) throw new Error('Failed to parse analysis from claude');

        // Skip trivial sessions (but always write essentials)
        if (analysis.should_log === false && (!analysis.essentials || analysis.essentials.length === 0)) {
            logError(`Session skipped (should_log=false, no essentials)`);
            clearBuffer();
            return;
        }

        // Always write essentials
        writeEssentials(analysis, writeDir, projectSlug);

        if (analysis.should_log !== false) {
            const sessionResult = writeSession(analysis, buffer, writeDir, projectSlug);
            writeTimeLog(buffer, writeDir, projectSlug, sessionResult);
            await writeKnowledge(analysis, writeDir, projectSlug);
        }

        // Ensure hub notes exist
        ensureProjectHub(writeDir, projectSlug);
        ensureMachineHub(writeDir, hostname);
        ensureDashboard(writeDir);

        // KB cleanup (once per day, end-of-session only)
        if (TRIGGER === 'end-of-session' && MODE === 'personal') {
            await cleanupKB(writeDir);
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        await commitAndPush(writeDir, `log: ${dateStr} session (${TRIGGER})`);
        clearBuffer();

        // Run maintenance (end-of-session, personal machine, 7-day cooldown)
        if (TRIGGER === 'end-of-session' && MODE === 'personal') {
            try {
                const { fileURLToPath } = await import('url');
                const { dirname } = await import('path');
                const hooksDir = dirname(fileURLToPath(import.meta.url));
                const maintenancePath = join(hooksDir, 'maintenance.mjs');
                if (existsSync(maintenancePath)) {
                    // Import and run maintenance inline (shares the same vault state)
                    await import(maintenancePath);
                }
            } catch (err) {
                logError(`Maintenance trigger failed: ${err.message}`);
            }
        }
    } catch (err) {
        logError(`Logger failed: ${err.message}`);
    } finally {
        releaseLock();
        cleanupServer();
    }
}

main().catch(err => {
    logError(`Logger fatal: ${err.message}`);
    releaseLock();
    process.exit(0);
});
