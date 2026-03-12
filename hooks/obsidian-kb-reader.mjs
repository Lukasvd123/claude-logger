#!/usr/bin/env node
// obsidian-kb-reader.mjs — Two-tier KB fetcher for session-start injection
// Uses `claude -p` for tier 2 selection (OAuth subscription, no API key needed).
// Outputs markdown to stdout. Hard 5s timeout enforced by caller.

import { execSync, spawn } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

const GITHUB_PAT = process.env.GITHUB_PAT;
const VAULT_PATH = process.env.VAULT_PATH;
const MODE = VAULT_PATH ? 'personal' : 'server';
const REPO_OWNER = 'Lukasvd123';
const REPO_NAME = 'Claudelogs';
const KB_BASE = 'claude-logs/knowledge-base';

// --- Helpers ---

function getProjectSlug() {
    try {
        const remote = execSync('git remote get-url origin', {
            cwd: process.cwd(), encoding: 'utf8', timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const match = remote.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
        if (match) return `${match[1]}-${match[2]}`.toLowerCase();
    } catch {}
    return basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

async function githubFetch(path) {
    if (!GITHUB_PAT) return null;
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${GITHUB_PAT}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!resp.ok) return null;
    return resp.json();
}

async function githubReadFile(path) {
    const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/${path}`;
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${GITHUB_PAT}` },
    });
    if (!resp.ok) return null;
    return resp.text();
}

function localReadDir(dir) {
    try {
        return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => ({ name: f, path: join(dir, f) }));
    } catch { return []; }
}

function localReadFile(filePath) {
    try { return readFileSync(filePath, 'utf8'); } catch { return null; }
}

function claudeCall(prompt, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, CLAUDELOGS_INTERNAL: '1' };
        for (const key of Object.keys(env)) {
            if (key.startsWith('CLAUDE') && key !== 'CLAUDELOGS_INTERNAL') delete env[key];
        }
        const proc = spawn('claude', ['-p', '--model', 'haiku'], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stdin.write(prompt);
        proc.stdin.end();
        const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, timeoutMs);
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`claude exited ${code}`));
        });
        proc.on('error', err => { clearTimeout(timer); reject(err); });
    });
}

// --- Tier 1: Always injected ---

async function fetchTier1() {
    const entries = [];
    if (MODE === 'personal') {
        const dir = join(VAULT_PATH, KB_BASE, 'tier1');
        for (const file of localReadDir(dir)) {
            const content = localReadFile(file.path);
            if (content) entries.push({ name: file.name, content });
        }
    } else {
        const listing = await githubFetch(`${KB_BASE}/tier1`);
        if (!Array.isArray(listing)) return entries;
        for (const item of listing) {
            if (!item.name.endsWith('.md')) continue;
            const content = await githubReadFile(item.path);
            if (content) entries.push({ name: item.name, content });
        }
    }
    return entries;
}

// --- Tier 2: Project-scoped, Claude selects ---

async function fetchTier2(slug) {
    const entries = [];
    if (MODE === 'personal') {
        const dir = join(VAULT_PATH, KB_BASE, 'tier2', slug);
        if (!existsSync(dir)) return entries;
        for (const file of localReadDir(dir)) {
            const content = localReadFile(file.path);
            if (content) entries.push({ name: file.name, content });
        }
    } else {
        const listing = await githubFetch(`${KB_BASE}/tier2/${slug}`);
        if (!Array.isArray(listing)) return entries;
        for (const item of listing) {
            if (!item.name.endsWith('.md')) continue;
            const content = await githubReadFile(item.path);
            if (content) entries.push({ name: item.name, content });
        }
    }
    return entries;
}

async function selectRelevantTier2(entries, slug) {
    if (entries.length === 0) return [];
    if (entries.length <= 8) return entries;

    const summaries = entries.map((e, i) => `[${i}] ${e.name}: ${e.content.slice(0, 200)}`).join('\n');
    const cwd = process.cwd();

    try {
        const result = await claudeCall(
            `Given project "${slug}" at "${cwd}", select the top 8 most relevant KB entries. Return ONLY a JSON array of indices, e.g. [0,2,5]. No explanation.\n\n${summaries}`,
            4000,
        );
        const indices = JSON.parse(result.match(/\[[\d,\s]+\]/)?.[0] || '[]');
        return indices.filter(i => i >= 0 && i < entries.length).map(i => entries[i]);
    } catch {
        return entries.slice(0, 8);
    }
}

// --- Essentials: credentials, configs, important values ---

async function fetchEssentials(slug) {
    const entries = [];
    if (MODE === 'personal') {
        const dir = join(VAULT_PATH, 'claude-logs', 'essentials');
        if (!existsSync(dir)) return entries;
        for (const file of localReadDir(dir)) {
            // Include global essentials + current project essentials
            if (file.name.includes('global') || file.name.includes(slug)) {
                const content = localReadFile(file.path);
                if (content) entries.push({ name: file.name, content });
            }
        }
    } else {
        const listing = await githubFetch('claude-logs/essentials');
        if (!Array.isArray(listing)) return entries;
        for (const item of listing) {
            if (!item.name.endsWith('.md')) continue;
            if (item.name.includes('global') || item.name.includes(slug)) {
                const content = await githubReadFile(item.path);
                if (content) entries.push({ name: item.name, content });
            }
        }
    }
    return entries;
}

// --- Main ---

async function main() {
    const slug = getProjectSlug();
    const [tier1Entries, tier2AllEntries, essentialEntries] = await Promise.all([
        fetchTier1(),
        fetchTier2(slug),
        fetchEssentials(slug),
    ]);

    const tier2Entries = await selectRelevantTier2(tier2AllEntries, slug);

    if (tier1Entries.length === 0 && tier2Entries.length === 0 && essentialEntries.length === 0) {
        process.exit(0);
    }

    const output = [];
    output.push('## Knowledge Base\n');

    if (tier1Entries.length > 0) {
        output.push('### Always-applicable patterns\n');
        for (const entry of tier1Entries) {
            output.push('<!-- tier1-entry -->');
            output.push(entry.content.trim());
            output.push('');
        }
    }

    if (tier2Entries.length > 0) {
        output.push(`### Project: ${slug} — relevant past notes\n`);
        for (const entry of tier2Entries) {
            output.push('<!-- tier2-entry -->');
            output.push(entry.content.trim());
            output.push('');
        }
    }

    if (essentialEntries.length > 0) {
        output.push('### Essentials — credentials, configs, and important values\n');
        for (const entry of essentialEntries) {
            output.push('<!-- essentials-entry -->');
            output.push(entry.content.trim());
            output.push('');
        }
    }

    process.stdout.write(output.join('\n'));
}

main().catch(err => {
    process.stderr.write(`kb-reader error: ${err.message}\n`);
    process.exit(0);
});
