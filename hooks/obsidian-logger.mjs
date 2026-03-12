#!/usr/bin/env node
// obsidian-logger.mjs — Write-time processor for Claude Code session logs
// Uses `claude -p` (local CLI) instead of direct API calls — works with OAuth subscriptions.
// Single batched call for all processing. Buffer cleared only after all writes + push succeed.

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { join, basename } from 'path';

const GITHUB_PAT = process.env.GITHUB_PAT;
const VAULT_PATH = process.env.VAULT_PATH;
const MODE = VAULT_PATH ? 'personal' : 'server';
const REPO_OWNER = 'Lukasvd123';
const REPO_NAME = 'Claudelogs';
const LOGS_BASE = 'claude-logs';

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

function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function logError(msg) {
    try { writeFileSync('/tmp/claudelogs-errors.log', `[${ts()}] ${msg}\n`, { flag: 'a' }); } catch {}
}

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

// --- Claude CLI call (uses OAuth subscription, no API key needed) ---

function claudeCall(prompt, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        // Build clean env: remove Claude Code nesting guards, keep auth via config/keyring
        const env = { ...process.env, CLAUDELOGS_INTERNAL: '1' };
        for (const key of Object.keys(env)) {
            if (key.startsWith('CLAUDE') && key !== 'CLAUDELOGS_INTERNAL') delete env[key];
        }
        const proc = spawn('claude', ['-p', '--model', 'haiku'], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.stdin.write(prompt);
        proc.stdin.end();
        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error('claude -p timed out'));
        }, timeoutMs);
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
        });
        proc.on('error', err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function parseJSON(text) {
    // Try to extract JSON from markdown code blocks or raw text
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

function commitAndPush(writeDir, message) {
    // Use -c credential.helper= to bypass gh auth and use the PAT in the remote URL
    const g = 'git -c "credential.https://github.com.helper=" -c commit.gpgsign=false';
    const opts = { cwd: writeDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, encoding: 'utf8' };
    const maxRetries = 3;

    execSync('git add .', opts);

    try {
        const status = execSync('git status --porcelain', opts).trim();
        if (!status) return;
    } catch {}

    execSync(`${g} commit -m "${message.replace(/"/g, '\\"')}"`, opts);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            execSync(`${g} push`, opts);
            return;
        } catch (err) {
            if (attempt === maxRetries) {
                throw new Error(`git push failed after ${maxRetries} attempts: ${err.message}`);
            }
            try { execSync(`${g} pull --rebase`, opts); } catch {
                try { execSync('git rebase --abort', opts); } catch {}
                execSync(`${g} pull --rebase`, opts);
            }
        }
    }
}

function cleanupServer() {
    if (MODE === 'server') {
        try { rmSync(`/tmp/claudelogs-staging-${SESSION_ID}`, { recursive: true, force: true }); } catch {}
    }
}

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
}

// --- Dedup KB ---

async function existingKBFiles(tier, slug) {
    const names = new Set();
    if (MODE === 'personal') {
        const dir = tier === 'tier1'
            ? join(VAULT_PATH, LOGS_BASE, 'knowledge-base', 'tier1')
            : join(VAULT_PATH, LOGS_BASE, 'knowledge-base', 'tier2', slug);
        try {
            for (const f of readdirSync(dir)) names.add(f.toLowerCase());
        } catch {}
    } else {
        const path = tier === 'tier1'
            ? `${LOGS_BASE}/knowledge-base/tier1`
            : `${LOGS_BASE}/knowledge-base/tier2/${slug}`;
        try {
            const resp = await fetch(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`,
                { headers: { Authorization: `Bearer ${GITHUB_PAT}`, Accept: 'application/vnd.github.v3+json' } }
            );
            if (resp.ok) {
                const items = await resp.json();
                if (Array.isArray(items)) items.forEach(i => names.add(i.name.toLowerCase()));
            }
        } catch {}
    }
    return names;
}

function isDuplicate(existingNames, newTitle) {
    const lower = newTitle.toLowerCase();
    for (const name of existingNames) {
        if (name.includes(lower) || lower.includes(name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, ''))) {
            return true;
        }
    }
    return false;
}

// --- Single batched analysis call ---

async function analyzeSession(buffer, projectSlug) {
    const hasGitOps = buffer.some(b => b.action_type === 'git_op');
    const hasMeaningfulWork = buffer.some(b => ['file_write', 'git_op', 'fs_op', 'permission_change'].includes(b.action_type));

    const bufferSummary = buffer.map(b =>
        `[${b.timestamp}] ${b.tool_name} (${b.action_type}): ${b.extra || b.tool_input_preview}`
    ).join('\n');

    const prompt = `You are a structured log analyzer. Analyze this Claude Code session buffer and return a single JSON object. No explanation, no markdown fences, just valid JSON.

{
  "should_log": true,
  "dev_log": {
    "category": "one of: feature, bugfix, refactor, config, devops, research, docs, setup, other",
    "kebab_title": "short-kebab-title-max-6-words",
    "description": "2-3 sentence summary for Obsidian search — include key terms someone would search for",
    "aliases": ["alternative search terms", "e.g. if about nginx config, include: reverse proxy, web server"],
    "what_was_asked": "one sentence summary of what the user wanted",
    "what_was_done": ["bullet 1", "bullet 2"],
    "files_written": [{"path": "/full/path", "machine": "hostname"}],
    "permission_changes": [],
    "fs_ops": [],
    "folders_used": ["/unique/dirs"],
    "tags": ["specific", "searchable", "tags", "include-tool-names", "include-tech-names"],
    "duration_minutes": 0
  },
  "kb_entries": [
    {
      "summary": "one-line problem description — be specific, include error messages or tool names",
      "fix": "one-line fix description — include the actual command or config change",
      "type": "solution or failure",
      "tier": "tier1 if generic (tool failures, Linux quirks, shell gotchas, not repo-specific) or tier2 if project-specific",
      "tags": ["specific", "searchable", "tags"],
      "aliases": ["alternative search terms for this problem"]
    }
  ],
  "essentials": [
    {
      "key": "short-kebab-key (e.g. github-pat, db-password, api-url, ssh-key-path)",
      "category": "credential|url|config|path|key",
      "value": "the actual value or path",
      "context": "what this is for, where it's used",
      "project": "project-slug or 'global'"
    }
  ],
  "diff_summaries": [
    {
      "command": "the git command",
      "bullets": ["changelog bullet 1", "changelog bullet 2"]
    }
  ]
}

Rules:
- should_log: false if this session was trivial (only reads, no real work done, just browsing). true if any meaningful changes or insights happened.${!hasMeaningfulWork ? ' This session has NO file writes or git ops — strongly consider false.' : ''}
- kb_entries: only genuinely reusable insights. Empty array if nothing worth logging. Make tags SPECIFIC — not "config" but "nginx-config" or "systemd-unit". Include error message fragments people would search for.
- aliases: alternative ways someone might search for this topic. Think "what would I type in Obsidian search?"
- essentials: extract ANY passwords, API keys, tokens, important URLs, connection strings, file paths for credentials, or config values mentioned in the session. Include env var names. This is a personal secure log — capture everything useful.
- diff_summaries: only for git operations.${hasGitOps ? '' : ' Empty array — no git ops.'}
- tags: be specific and searchable. Include technology names, tool names, error types. Use kebab-case.
- duration_minutes: estimate from timestamps.
- Respond with ONLY the JSON object, nothing else.

Session buffer (project: ${projectSlug}):
${bufferSummary}`;

    const raw = await claudeCall(prompt, 90000);
    return parseJSON(raw);
}

// --- Write destinations ---

function writeDevLog(analysis, buffer, writeDir, projectSlug) {
    const d = analysis.dev_log;
    if (!d) return null;

    const hostname = buffer[0]?.hostname || 'unknown';
    const firstTs = buffer[0]?.timestamp || new Date().toISOString();
    const dateStr = firstTs.slice(0, 10);
    const startTime = firstTs.slice(11, 16);

    const title = d.kebab_title || 'untitled';
    const category = d.category || 'other';
    const filename = `${dateStr}-${title}.md`;
    const dir = join(writeDir, LOGS_BASE, 'dev-logs', category);
    ensureDir(dir);

    const aliases = d.aliases || [];
    const frontmatter = [
        '---',
        `date: ${dateStr}`,
        `machine: ${hostname}`,
        `duration: ~${d.duration_minutes || '?'}min`,
        `tags: [${(d.tags || []).join(', ')}]`,
        aliases.length ? `aliases: [${aliases.map(a => `"${a}"`).join(', ')}]` : null,
        d.description ? `description: "${d.description.replace(/"/g, '\\"')}"` : null,
        `trigger: ${TRIGGER}`,
        `project: ${projectSlug}`,
        '---',
    ].filter(Boolean).join('\n');

    const body = [
        `# ${title.replace(/-/g, ' ')}`,
        '',
        `**Asked:** ${d.what_was_asked || 'N/A'}`,
        '',
        '**Done:**',
        ...(d.what_was_done || []).map(x => `- ${x}`),
        '',
        '**Files:**',
        ...(d.files_written || []).map(f => `- \`${f.path}\` (${f.machine || hostname})`),
    ];

    if (d.permission_changes?.length)
        body.push('', '**Permission changes:**', ...d.permission_changes.map(p => `- ${p}`));
    if (d.fs_ops?.length)
        body.push('', '**FS operations:**', ...d.fs_ops.map(f => `- ${f}`));
    if (d.folders_used?.length)
        body.push('', '**Directories:**', ...d.folders_used.map(f => `- \`${f}\``));

    // Obsidian: inline tags + wikilink to project for graph view
    body.push('', `**Project:** [[${projectSlug}]]`);
    body.push('', (d.tags || []).map(t => `#${t.replace(/\s+/g, '-')}`).join(' ') + ` #${category}`);

    writeFileSync(join(dir, filename), `${frontmatter}\n\n${body.join('\n')}\n`);
    return { title, category, duration: d.duration_minutes, startTime };
}

function writeTimeLog(buffer, writeDir, projectSlug, devLogResult) {
    const firstTs = buffer[0]?.timestamp || new Date().toISOString();
    const hostname = buffer[0]?.hostname || 'unknown';
    const dateStr = firstTs.slice(0, 10);
    const monthStr = dateStr.slice(0, 7);
    const startTime = firstTs.slice(11, 16);
    const topic = devLogResult?.title?.replace(/-/g, ' ') || 'session';
    const duration = devLogResult?.duration || '?';

    const dir = join(writeDir, LOGS_BASE, 'time-log');
    ensureDir(dir);
    const file = join(dir, `${monthStr}.md`);

    let content = '';
    if (existsSync(file)) {
        content = readFileSync(file, 'utf8');
    } else {
        content = `# Time Log — ${monthStr}\n\n| Date | Time | Machine | Duration | Topic | Project |\n|------|------|---------|----------|-------|---------|\n`;
    }

    content += `| ${dateStr} | ${startTime} | ${hostname} | ~${duration}min | ${topic} | ${projectSlug} |\n`;
    writeFileSync(file, content);
}

async function writeKnowledgeBase(analysis, writeDir, projectSlug) {
    const entries = analysis.kb_entries || [];
    if (entries.length === 0) return;

    const dateStr = new Date().toISOString().slice(0, 10);
    const [existingTier1, existingTier2] = await Promise.all([
        existingKBFiles('tier1', projectSlug),
        existingKBFiles('tier2', projectSlug),
    ]);

    for (const entry of entries) {
        const tier = entry.tier === 'tier1' ? 'tier1' : 'tier2';
        const slug = (entry.summary || 'untitled')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50);

        const existingNames = tier === 'tier1' ? existingTier1 : existingTier2;
        if (isDuplicate(existingNames, slug)) continue;

        const filename = `${dateStr}-${slug}.md`;
        const tags = entry.tags || [];
        const aliases = entry.aliases || [];
        // Add tier and type as tags for Obsidian filtering
        const allTags = [...new Set([tier, entry.type, ...tags])];
        let dir, content;

        const aliasLine = aliases.length ? `aliases: [${aliases.map(a => `"${a}"`).join(', ')}]` : null;

        if (tier === 'tier1') {
            dir = join(writeDir, LOGS_BASE, 'knowledge-base', 'tier1');
            content = [
                '---',
                `date: ${dateStr}`,
                `type: ${entry.type}`,
                `tier: tier1`,
                `tags: [${allTags.join(', ')}]`,
                aliasLine,
                '---',
                '',
                `**Problem:** ${entry.summary}`,
                `**Fix:** ${entry.fix}`,
                '',
                `#${entry.type} #tier1 ${tags.map(t => `#${t.replace(/\s+/g, '-')}`).join(' ')}`,
                '',
            ].filter(Boolean).join('\n');
        } else {
            dir = join(writeDir, LOGS_BASE, 'knowledge-base', 'tier2', projectSlug);
            content = [
                '---',
                `date: ${dateStr}`,
                `type: ${entry.type}`,
                `tier: tier2`,
                `project: ${projectSlug}`,
                `tags: [${allTags.join(', ')}]`,
                aliasLine,
                '---',
                '',
                `**Problem:** ${entry.summary}`,
                `**Fix:** ${entry.fix}`,
                `**Project:** [[${projectSlug}]]`,
                '',
                `#${entry.type} #tier2 #${projectSlug} ${tags.map(t => `#${t.replace(/\s+/g, '-')}`).join(' ')}`,
                '',
            ].filter(Boolean).join('\n');
        }

        ensureDir(dir);
        writeFileSync(join(dir, filename), content);
    }
}

function writeDiffSummaries(analysis, buffer, writeDir, projectSlug) {
    const summaries = analysis.diff_summaries || [];
    if (summaries.length === 0) return;

    const dateStr = new Date().toISOString().slice(0, 10);
    const hostname = buffer[0]?.hostname || 'unknown';

    for (const ds of summaries) {
        const cmd = ds.command || '';
        const slug = cmd.replace(/^git\s+/, '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

        const filename = `${dateStr}-${slug}.md`;
        const dir = join(writeDir, LOGS_BASE, 'diff-summaries');
        ensureDir(dir);

        const tags = [];
        if (cmd.includes('push')) tags.push('push');
        if (cmd.includes('commit')) tags.push('commit');
        if (cmd.includes('merge')) tags.push('merge');

        const frontmatter = [
            '---',
            `date: ${dateStr}`,
            `machine: ${hostname}`,
            `command: "${cmd.slice(0, 100)}"`,
            `project: ${projectSlug}`,
            `tags: [${tags.join(', ')}]`,
            '---',
        ].join('\n');

        const bullets = (ds.bullets || []).map(b => `- ${b}`).join('\n');
        writeFileSync(join(dir, filename), `${frontmatter}\n\n${bullets}\n`);
    }
}

// --- KB Cleanup (runs at most once per day) ---

async function cleanupKB(writeDir) {
    const markerFile = '/tmp/claudelogs-last-cleanup';
    const now = Date.now();

    // Check if cleanup ran in the last 24 hours
    try {
        const lastRun = parseInt(readFileSync(markerFile, 'utf8').trim(), 10);
        if (now - lastRun < 86400000) return; // 24 hours
    } catch {}

    writeFileSync(markerFile, String(now));

    // Collect all KB entries
    const entries = [];
    for (const tier of ['tier1', 'tier2']) {
        const base = join(writeDir, LOGS_BASE, 'knowledge-base', tier);
        if (!existsSync(base)) continue;

        if (tier === 'tier1') {
            try {
                for (const f of readdirSync(base).filter(f => f.endsWith('.md'))) {
                    const content = readFileSync(join(base, f), 'utf8');
                    entries.push({ file: join(base, f), name: f, tier, content: content.slice(0, 300) });
                }
            } catch {}
        } else {
            // tier2 has project subdirs
            try {
                for (const projDir of readdirSync(base)) {
                    const projPath = join(base, projDir);
                    try {
                        for (const f of readdirSync(projPath).filter(f => f.endsWith('.md'))) {
                            const content = readFileSync(join(projPath, f), 'utf8');
                            entries.push({ file: join(projPath, f), name: f, tier, content: content.slice(0, 300) });
                        }
                    } catch {}
                }
            } catch {}
        }
    }

    if (entries.length < 5) return; // Not enough entries to bother

    const summaries = entries.map((e, i) =>
        `[${i}] ${e.name} (${e.tier}): ${e.content.replace(/---[\s\S]*?---/, '').trim().slice(0, 150)}`
    ).join('\n');

    try {
        const result = await claudeCall(
            `Review these knowledge base entries. Return ONLY a JSON array of indices for entries that are CLEARLY outdated, superseded, or no longer useful. Be conservative — only remove entries that are definitely stale (e.g., fixed in a newer version, about deprecated tools, duplicate of another entry). Return [] if nothing should be removed.\n\nToday: ${new Date().toISOString().slice(0, 10)}\n\n${summaries}`,
            30000,
        );
        const indices = JSON.parse(result.match(/\[[\d,\s]*\]/)?.[0] || '[]');
        let removed = 0;
        for (const idx of indices) {
            if (idx >= 0 && idx < entries.length) {
                try {
                    unlinkSync(entries[idx].file);
                    removed++;
                } catch {}
            }
        }
        if (removed > 0) logError(`KB cleanup: removed ${removed} stale entries`);
    } catch (err) {
        logError(`KB cleanup failed: ${err.message}`);
    }
}

function writeEssentials(analysis, writeDir, projectSlug) {
    const essentials = analysis.essentials || [];
    if (essentials.length === 0) return;

    const dir = join(writeDir, LOGS_BASE, 'essentials');
    ensureDir(dir);

    // Essentials are organized by project — one file per project (or global)
    // Each file is a living document that gets updated, not appended
    const byProject = {};
    for (const e of essentials) {
        const proj = e.project || projectSlug;
        if (!byProject[proj]) byProject[proj] = [];
        byProject[proj].push(e);
    }

    for (const [proj, entries] of Object.entries(byProject)) {
        const filename = `${proj}-essentials.md`;
        const filepath = join(dir, filename);
        const dateStr = new Date().toISOString().slice(0, 10);

        // Load existing entries if file exists
        let existing = {};
        if (existsSync(filepath)) {
            const content = readFileSync(filepath, 'utf8');
            // Parse existing entries from markdown table
            const rows = content.match(/^\| .+ \| .+ \| .+ \| .+ \|$/gm) || [];
            for (const row of rows) {
                const cols = row.split('|').map(c => c.trim()).filter(Boolean);
                if (cols.length >= 4 && cols[0] !== 'Key') {
                    existing[cols[0]] = { category: cols[1], value: cols[2], context: cols[3] };
                }
            }
        }

        // Merge new entries (update existing keys, add new ones)
        for (const e of entries) {
            existing[e.key] = { category: e.category, value: e.value, context: e.context };
        }

        // Write updated file
        const allTags = [...new Set(Object.values(existing).map(e => e.category))];
        const frontmatter = [
            '---',
            `date: ${dateStr}`,
            `project: ${proj}`,
            `tags: [essentials, ${allTags.join(', ')}]`,
            `description: "Credentials, keys, URLs, and config for ${proj}"`,
            `aliases: ["${proj} passwords", "${proj} credentials", "${proj} config", "${proj} keys"]`,
            '---',
        ].join('\n');

        const table = [
            `# Essentials — ${proj}`,
            '',
            `> Last updated: ${dateStr}`,
            '',
            '| Key | Category | Value | Context |',
            '|-----|----------|-------|---------|',
            ...Object.entries(existing).map(([key, e]) =>
                `| ${key} | ${e.category} | ${e.value} | ${e.context} |`
            ),
            '',
            `**Project:** [[${proj}]]`,
            '',
            `#essentials #${proj} ${allTags.map(t => `#${t}`).join(' ')}`,
            '',
        ].join('\n');

        writeFileSync(filepath, `${frontmatter}\n\n${table}`);
    }
}

// --- Main ---

async function main() {
    const buffer = readBuffer();
    if (buffer.length === 0) return;

    const projectSlug = getProjectSlug();
    const writeDir = getWriteDir();

    if (MODE === 'server') setupServerRepo();

    try {
        // Single claude call for all analysis
        const analysis = await analyzeSession(buffer, projectSlug);
        if (!analysis) throw new Error('Failed to parse analysis from claude');

        // If Claude determined this session isn't worth logging, skip (but still write essentials)
        if (analysis.should_log === false && (!analysis.essentials || analysis.essentials.length === 0)) {
            logError(`Session skipped (should_log=false, no essentials)`);
            clearBuffer();
            return;
        }

        // Write essentials always (even if should_log is false — credentials matter)
        writeEssentials(analysis, writeDir, projectSlug);

        if (analysis.should_log !== false) {
            // Write log destinations only if session is worth logging
            const devLogResult = writeDevLog(analysis, buffer, writeDir, projectSlug);
            writeTimeLog(buffer, writeDir, projectSlug, devLogResult);
            await writeKnowledgeBase(analysis, writeDir, projectSlug);
            writeDiffSummaries(analysis, buffer, writeDir, projectSlug);
        }

        // KB cleanup: prune stale entries (once per day, end-of-session only)
        if (TRIGGER === 'end-of-session' && MODE === 'personal') {
            await cleanupKB(writeDir);
        }

        // Commit and push with retry
        const dateStr = new Date().toISOString().slice(0, 10);
        commitAndPush(writeDir, `log: ${dateStr} session (${TRIGGER})`);

        clearBuffer();
    } catch (err) {
        logError(`Logger failed: ${err.message}`);
    } finally {
        cleanupServer();
    }
}

main().catch(err => {
    logError(`Logger fatal: ${err.message}`);
    process.exit(0);
});
