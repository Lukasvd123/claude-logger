#!/usr/bin/env node
// obsidian-logger.mjs — Write-time processor for Claude Code session logs
// 4 destinations: dev-log, time-log, knowledge-base, diff-summaries
// All run in parallel. Buffer cleared only after all writes + push succeed.

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { join, basename } from 'path';

const GITHUB_PAT = process.env.GITHUB_PAT;
const VAULT_PATH = process.env.VAULT_PATH;
const API_KEY = process.env.ANTHROPIC_API_KEY;
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

function timestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function logError(msg) {
    const line = `[${timestamp()}] ${msg}\n`;
    try { writeFileSync('/tmp/claudelogs-errors.log', line, { flag: 'a' }); } catch {}
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

async function anthropicCall(prompt, { maxTokens = 1024, system } = {}) {
    if (!API_KEY) throw new Error('No ANTHROPIC_API_KEY');
    const body = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
    };
    if (system) body.system = system;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.content?.[0]?.text || '';
}

function parseJSON(text) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    try { return JSON.parse(match[1].trim()); } catch { return null; }
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
    execSync(`git clone --depth 1 "${url}" "${staging}"`, {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
    });
    return staging;
}

function commitAndPush(writeDir, message) {
    const opts = { cwd: writeDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, encoding: 'utf8' };
    const maxRetries = 3;

    execSync('git add .', opts);

    // Check if there's anything to commit
    try {
        const status = execSync('git status --porcelain', opts).trim();
        if (!status) return; // nothing to commit
    } catch {}

    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, opts);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            execSync('git push', opts);
            return; // success
        } catch (err) {
            if (attempt === maxRetries) {
                throw new Error(`git push failed after ${maxRetries} attempts: ${err.message}`);
            }
            // Pull rebase and retry
            try {
                execSync('git pull --rebase', opts);
            } catch (pullErr) {
                // If rebase fails, abort and retry fresh
                try { execSync('git rebase --abort', opts); } catch {}
                execSync('git pull --rebase', opts);
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

// --- Dedup: check existing filenames ---

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

// --- Destination 1: Dev Log ---

async function writeDevLog(buffer, writeDir, projectSlug) {
    const hostname = buffer[0]?.hostname || 'unknown';
    const firstTs = buffer[0]?.timestamp || new Date().toISOString();
    const lastTs = buffer[buffer.length - 1]?.timestamp || firstTs;
    const dateStr = firstTs.slice(0, 10);

    const bufferSummary = buffer.map(b =>
        `[${b.timestamp}] ${b.tool_name} (${b.action_type}): ${b.extra || b.tool_input_preview}`
    ).join('\n');

    const prompt = `Analyze this Claude Code session log and return JSON with these fields:
- category: one of [feature, bugfix, refactor, config, devops, research, docs, setup, other]
- kebab_title: short kebab-case title (max 6 words)
- what_was_asked: one sentence
- what_was_done: array of short bullet strings
- files_written: array of {path, machine} objects
- permission_changes: array of strings (empty if none)
- fs_ops: array of strings (empty if none)
- folders_used: array of unique directory paths
- tags: array of relevant tags
- duration_minutes: estimated from timestamps

Session buffer:
${bufferSummary}

Respond with valid JSON only.`;

    const result = parseJSON(await anthropicCall(prompt, { maxTokens: 1500 }));
    if (!result) return null;

    const title = result.kebab_title || 'untitled';
    const category = result.category || 'other';
    const filename = `${dateStr}-${title}.md`;
    const dir = join(writeDir, LOGS_BASE, 'dev-logs', category);
    ensureDir(dir);

    const startTime = firstTs.slice(11, 16);
    const duration = result.duration_minutes || '?';

    const frontmatter = [
        '---',
        `date: ${dateStr}`,
        `machine: ${hostname}`,
        `duration: ~${duration}min`,
        `tags: [${(result.tags || []).join(', ')}]`,
        `trigger: ${TRIGGER}`,
        `project: ${projectSlug}`,
        '---',
    ].join('\n');

    const body = [
        `# ${title.replace(/-/g, ' ')}`,
        '',
        `**Asked:** ${result.what_was_asked || 'N/A'}`,
        '',
        '**Done:**',
        ...(result.what_was_done || []).map(d => `- ${d}`),
        '',
        '**Files:**',
        ...(result.files_written || []).map(f => `- \`${f.path}\` (${f.machine || hostname})`),
    ];

    if (result.permission_changes?.length) {
        body.push('', '**Permission changes:**', ...result.permission_changes.map(p => `- ${p}`));
    }
    if (result.fs_ops?.length) {
        body.push('', '**FS operations:**', ...result.fs_ops.map(f => `- ${f}`));
    }
    if (result.folders_used?.length) {
        body.push('', '**Directories:**', ...result.folders_used.map(f => `- \`${f}\``));
    }

    writeFileSync(join(dir, filename), `${frontmatter}\n\n${body.join('\n')}\n`);
    return { title, category, duration, startTime };
}

// --- Destination 2: Time Log ---

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

    const row = `| ${dateStr} | ${startTime} | ${hostname} | ~${duration}min | ${topic} | ${projectSlug} |`;
    content += `${row}\n`;
    writeFileSync(file, content);
}

// --- Destination 3: Knowledge Base ---

async function writeKnowledgeBase(buffer, writeDir, projectSlug) {
    const bufferSummary = buffer.map(b =>
        `[${b.timestamp}] ${b.tool_name} (${b.action_type}): ${b.extra || b.tool_input_preview}`
    ).join('\n');

    const extractPrompt = `Analyze this Claude Code session log. Extract any reusable solutions (things that worked) and failures (things that didn't work and the fix). Return JSON:
{
  "solutions": [{"summary": "one-line problem", "fix": "one-line fix"}],
  "failures": [{"summary": "one-line problem", "fix": "one-line fix"}]
}
Return empty arrays if nothing worth logging. Only extract genuinely reusable insights.

Session log:
${bufferSummary}

Respond with valid JSON only.`;

    const extracted = parseJSON(await anthropicCall(extractPrompt, { maxTokens: 1000 }));
    if (!extracted) return;

    const allEntries = [
        ...(extracted.solutions || []).map(s => ({ ...s, type: 'solution' })),
        ...(extracted.failures || []).map(f => ({ ...f, type: 'failure' })),
    ];
    if (allEntries.length === 0) return;

    const classifyPrompt = `For each entry below, classify as "tier1" (generic — tool failures, Linux quirks, shell/env gotchas, recurring habits, not tied to any specific repo) or "tier2" (project-specific — bugs, domain config, errors tied to a particular codebase). Return JSON array of objects with index and tier.

Entries:
${allEntries.map((e, i) => `[${i}] ${e.type}: ${e.summary} → ${e.fix}`).join('\n')}

Respond with valid JSON only, e.g. [{"index":0,"tier":"tier1"},{"index":1,"tier":"tier2"}]`;

    const classifications = parseJSON(await anthropicCall(classifyPrompt, { maxTokens: 500 }));
    if (!Array.isArray(classifications)) return;

    const dateStr = new Date().toISOString().slice(0, 10);
    const [existingTier1, existingTier2] = await Promise.all([
        existingKBFiles('tier1', projectSlug),
        existingKBFiles('tier2', projectSlug),
    ]);

    for (const cls of classifications) {
        const entry = allEntries[cls.index];
        if (!entry) continue;
        const tier = cls.tier === 'tier1' ? 'tier1' : 'tier2';
        const slug = entry.summary
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50);

        const existingNames = tier === 'tier1' ? existingTier1 : existingTier2;
        if (isDuplicate(existingNames, slug)) continue;

        const filename = `${dateStr}-${slug}.md`;
        let dir, content;

        if (tier === 'tier1') {
            dir = join(writeDir, LOGS_BASE, 'knowledge-base', 'tier1');
            content = `**Problem:** ${entry.summary}\n**Fix:** ${entry.fix}\n**Type:** ${entry.type}\n`;
        } else {
            dir = join(writeDir, LOGS_BASE, 'knowledge-base', 'tier2', projectSlug);
            content = `**Problem:** ${entry.summary}\n**Fix:** ${entry.fix}\n**Type:** ${entry.type}\n**Project:** ${projectSlug}\n`;
        }

        ensureDir(dir);
        writeFileSync(join(dir, filename), content);
    }
}

// --- Destination 4: Diff Summaries ---

async function writeDiffSummaries(buffer, writeDir, projectSlug) {
    const gitOps = buffer.filter(b => b.action_type === 'git_op');
    if (gitOps.length === 0) return;

    const dateStr = new Date().toISOString().slice(0, 10);
    const hostname = buffer[0]?.hostname || 'unknown';

    for (const op of gitOps) {
        const cmd = op.extra || op.tool_input_preview || '';
        const prompt = `Given this git command from a Claude Code session, write a 2-3 bullet changelog summary of what likely changed. Be concise.

Command: ${cmd}
Project: ${projectSlug}
Machine: ${hostname}

Return a markdown bullet list only.`;

        let summary;
        try {
            summary = await anthropicCall(prompt, { maxTokens: 300 });
        } catch { continue; }
        if (!summary) continue;

        const slug = cmd
            .replace(/^git\s+/, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40);

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

        writeFileSync(join(dir, filename), `${frontmatter}\n\n${summary.trim()}\n`);
    }
}

// --- Main ---

async function main() {
    const buffer = readBuffer();
    if (buffer.length === 0) {
        return;
    }

    const projectSlug = getProjectSlug();
    const writeDir = getWriteDir();

    // Server mode: clone repo first
    if (MODE === 'server') {
        setupServerRepo();
    }

    try {
        // Dev log runs first so time log can use its result
        const devLogResult = await writeDevLog(buffer, writeDir, projectSlug);

        // Remaining 3 destinations in parallel
        await Promise.all([
            Promise.resolve(writeTimeLog(buffer, writeDir, projectSlug, devLogResult)),
            writeKnowledgeBase(buffer, writeDir, projectSlug),
            writeDiffSummaries(buffer, writeDir, projectSlug),
        ]);

        // Commit and push with retry
        const dateStr = new Date().toISOString().slice(0, 10);
        commitAndPush(writeDir, `log: ${dateStr} session (${TRIGGER})`);

        // Clear buffer only after successful push
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
