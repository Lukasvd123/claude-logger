#!/usr/bin/env node
// obsidian-kb-reader.mjs — KB fetcher for session-start injection
// v3.1: Sonnet selection, no legacy paths, frontmatter stripping, vault health check
// Uses `claude -p` for relevance selection. Outputs markdown to stdout.

import { execSync, spawn } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

const GITHUB_PAT = process.env.GITHUB_PAT;
const VAULT_PATH = process.env.VAULT_PATH;
const MODE = VAULT_PATH ? 'personal' : 'server';
const REPO_OWNER = 'Lukasvd123';
const REPO_NAME = 'Claudelogs';
const BASE = 'claude-logs';

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
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${GITHUB_PAT}` } });
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

function claudeCall(prompt, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, CLAUDELOGS_INTERNAL: '1' };
        for (const key of Object.keys(env)) {
            if (key.startsWith('CLAUDE') && key !== 'CLAUDELOGS_INTERNAL') delete env[key];
        }
        const proc = spawn('claude', ['-p', '--model', 'sonnet'], {
            env, stdio: ['pipe', 'pipe', 'pipe'],
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

// --- Vault health check ---

function vaultHealthCheck() {
    if (MODE !== 'personal') return;
    const gitDir = join(VAULT_PATH, '.git');
    if (!existsSync(gitDir)) return;

    // Abort stuck rebase/merge
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
        try { execSync('git rebase --abort', { cwd: VAULT_PATH, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }); } catch {}
    }
    if (existsSync(join(gitDir, 'MERGE_HEAD'))) {
        try { execSync('git merge --abort', { cwd: VAULT_PATH, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }); } catch {}
    }

    // Pull latest
    try {
        execSync('git -c "credential.https://github.com.helper=" pull --no-rebase -X theirs', {
            cwd: VAULT_PATH, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
        });
    } catch {}
}

// --- Extract tier from frontmatter ---

function getTier(content) {
    const match = content.match(/^tier:\s*(tier[12])/m);
    return match ? match[1] : 'tier2';
}

function getProject(content) {
    const match = content.match(/^project:\s*(.+)$/m);
    return match ? match[1].trim() : null;
}

// --- Strip YAML frontmatter ---

function stripFrontmatter(content) {
    return content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
}

// --- Fetch all knowledge entries ---

async function fetchKnowledge() {
    const entries = [];
    if (MODE === 'personal') {
        const dir = join(VAULT_PATH, BASE, 'knowledge');
        for (const file of localReadDir(dir)) {
            const content = localReadFile(file.path);
            if (content) {
                entries.push({
                    name: file.name,
                    content,
                    tier: getTier(content),
                    project: getProject(content),
                });
            }
        }
    } else {
        const listing = await githubFetch(`${BASE}/knowledge`);
        if (Array.isArray(listing)) {
            for (const item of listing) {
                if (!item.name.endsWith('.md')) continue;
                const content = await githubReadFile(item.path);
                if (content) {
                    entries.push({
                        name: item.name,
                        content,
                        tier: getTier(content),
                        project: getProject(content),
                    });
                }
            }
        }
    }
    return entries;
}

// --- Fetch essentials ---

async function fetchEssentials(slug) {
    const entries = [];
    if (MODE === 'personal') {
        const dir = join(VAULT_PATH, BASE, 'essentials');
        if (!existsSync(dir)) return entries;
        for (const file of localReadDir(dir)) {
            if (file.name.includes('global') || file.name.includes(slug)) {
                const content = localReadFile(file.path);
                if (content) entries.push({ name: file.name, content });
            }
        }
    } else {
        const listing = await githubFetch(`${BASE}/essentials`);
        if (Array.isArray(listing)) {
            for (const item of listing) {
                if (!item.name.endsWith('.md')) continue;
                if (item.name.includes('global') || item.name.includes(slug)) {
                    const content = await githubReadFile(item.path);
                    if (content) entries.push({ name: item.name, content });
                }
            }
        }
    }
    return entries;
}

// --- Select relevant tier2 entries ---

async function selectRelevant(entries, slug) {
    if (entries.length <= 10) return entries;

    const summaries = entries.map((e, i) => `[${i}] ${e.name}: ${stripFrontmatter(e.content).slice(0, 200)}`).join('\n');
    try {
        const result = await claudeCall(
            `Given project "${slug}" at "${process.cwd()}", select the top 10 most relevant KB entries for context injection. Prioritize: (1) same project entries, (2) same technology, (3) most recent. Return ONLY a JSON array of indices. No explanation.\n\n${summaries}`,
            8000,
        );
        const indices = JSON.parse(result.match(/\[[\d,\s]+\]/)?.[0] || '[]');
        return indices.filter(i => i >= 0 && i < entries.length).map(i => entries[i]);
    } catch {
        // Smart fallback: prefer same-project, then most recent
        const sameProject = entries.filter(e => e.project === slug);
        const rest = entries.filter(e => e.project !== slug);
        return [...sameProject, ...rest].slice(0, 10);
    }
}

// --- Main ---

async function main() {
    // Vault health check + pull latest before reading
    vaultHealthCheck();

    const slug = getProjectSlug();
    const [allKnowledge, essentialEntries] = await Promise.all([
        fetchKnowledge(),
        fetchEssentials(slug),
    ]);

    // Split by tier
    const tier1 = allKnowledge.filter(e => e.tier === 'tier1');
    const tier2All = allKnowledge.filter(e => e.tier === 'tier2');

    // For tier2: prefer current project, then select from rest
    const tier2Project = tier2All.filter(e => e.project === slug || e.project === null);
    const tier2 = await selectRelevant(tier2Project.length > 0 ? tier2Project : tier2All, slug);

    if (tier1.length === 0 && tier2.length === 0 && essentialEntries.length === 0) {
        process.exit(0);
    }

    const output = [];
    output.push('## Knowledge Base\n');

    if (tier1.length > 0) {
        output.push('### Universal patterns (tier1)\n');
        for (const entry of tier1) {
            output.push('<!-- tier1-entry -->');
            output.push(stripFrontmatter(entry.content));
            output.push('');
        }
    }

    if (tier2.length > 0) {
        output.push(`### Project-specific: ${slug} (tier2)\n`);
        for (const entry of tier2) {
            output.push('<!-- tier2-entry -->');
            output.push(stripFrontmatter(entry.content));
            output.push('');
        }
    }

    if (essentialEntries.length > 0) {
        output.push('### Essentials — credentials, configs, important values\n');
        for (const entry of essentialEntries) {
            output.push('<!-- essentials-entry -->');
            output.push(stripFrontmatter(entry.content));
            output.push('');
        }
    }

    // Sanity check
    const totalOutput = output.join('\n');
    if (totalOutput.length < 100) {
        process.stderr.write('Warning: KB output suspiciously small (<100 bytes)\n');
    }

    process.stdout.write(totalOutput);
}

main().catch(err => {
    process.stderr.write(`kb-reader error: ${err.message}\n`);
    process.exit(0);
});
