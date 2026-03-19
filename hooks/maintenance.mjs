#!/usr/bin/env node
// maintenance.mjs — Phase 6: Periodic maintenance for claude-logs vault
// Called from obsidian-logger.mjs at end-of-session on personal machine only.
// 7-day cooldown between runs.

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join, basename } from 'path';

const VAULT_PATH = process.env.VAULT_PATH;
if (!VAULT_PATH) { console.error('VAULT_PATH required'); process.exit(0); }

const BASE = 'claude-logs';
const COOLDOWN_FILE = '/tmp/claudelogs-last-maintenance';
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function logError(msg) {
    try { writeFileSync('/tmp/claudelogs-errors.log', `[${ts()}] maintenance: ${msg}\n`, { flag: 'a' }); } catch {}
}

function claudeCall(prompt, timeoutMs = 60000) {
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

// --- Archive inactive projects ---

function archiveInactiveProjects() {
    const sessionsDir = join(VAULT_PATH, BASE, 'sessions');
    const knowledgeDir = join(VAULT_PATH, BASE, 'knowledge');
    const essentialsDir = join(VAULT_PATH, BASE, 'essentials');
    const projectsDir = join(VAULT_PATH, BASE, 'projects');
    const archiveDir = join(VAULT_PATH, BASE, 'archive', 'inactive');

    if (!existsSync(sessionsDir)) return;

    // Scan sessions for project references and find last activity date
    const projectActivity = {};
    try {
        for (const f of readdirSync(sessionsDir).filter(f => f.endsWith('.md'))) {
            const content = readFileSync(join(sessionsDir, f), 'utf8');
            const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
            if (!dateMatch) continue;
            const date = dateMatch[1];
            const projectRefs = content.match(/\[\[([a-z0-9][\w.-]*-[\w.-]+)\]\]/g) || [];
            for (const ref of projectRefs) {
                const slug = ref.replace(/\[\[|\]\]/g, '');
                if (!projectActivity[slug] || date > projectActivity[slug]) {
                    projectActivity[slug] = date;
                }
            }
        }
    } catch {}

    const now = new Date();
    const fourWeeksAgo = new Date(now - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let archived = 0;

    for (const [slug, lastDate] of Object.entries(projectActivity)) {
        if (lastDate >= fourWeeksAgo) continue;

        mkdirSync(join(archiveDir, slug), { recursive: true });

        // Move KB entries for this project
        if (existsSync(knowledgeDir)) {
            for (const f of readdirSync(knowledgeDir).filter(f => f.endsWith('.md'))) {
                const content = readFileSync(join(knowledgeDir, f), 'utf8');
                const projectMatch = content.match(/^project:\s*(.+)$/m);
                if (projectMatch && projectMatch[1].trim() === slug) {
                    renameSync(join(knowledgeDir, f), join(archiveDir, slug, f));
                }
            }
        }

        // Move essentials for this project
        const essFile = join(essentialsDir, `${slug}.md`);
        if (existsSync(essFile)) {
            renameSync(essFile, join(archiveDir, slug, `${slug}-essentials.md`));
        }

        // Update project hub
        const hubFile = join(projectsDir, `${slug}.md`);
        if (existsSync(hubFile)) {
            let content = readFileSync(hubFile, 'utf8');
            if (!content.includes('archived on')) {
                content += `\n> **Archived on ${now.toISOString().slice(0, 10)}** — no activity since ${lastDate}\n`;
                writeFileSync(hubFile, content);
            }
        }

        archived++;
    }

    if (archived > 0) logError(`Archived ${archived} inactive projects`);
}

// --- Consolidate duplicates ---

async function consolidateDuplicates() {
    const dir = join(VAULT_PATH, BASE, 'knowledge');
    if (!existsSync(dir)) return;

    const entries = [];
    for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
        const content = readFileSync(join(dir, f), 'utf8');
        const titleMatch = content.match(/^# (.+)$/m);
        const problemMatch = content.match(/\*\*Problem:\*\*\s*(.+)/);
        entries.push({
            file: f,
            path: join(dir, f),
            title: titleMatch?.[1] || f,
            problem: problemMatch?.[1] || '',
            content,
        });
    }

    if (entries.length < 3) return;

    const summaries = entries.map((e, i) =>
        `[${i}] "${e.title}" — ${e.problem.slice(0, 150)}`
    ).join('\n');

    try {
        const result = await claudeCall(
            `Review these knowledge base entries. Identify groups of TRUE duplicates (same problem AND same solution, not just similar topic). Return JSON: {"groups": [[idx1, idx2], [idx3, idx4, idx5]]} where each group is indices of duplicate entries. The FIRST index in each group is the best/most complete entry to keep. Return {"groups": []} if no duplicates.\n\n${summaries}`,
            60000,
        );
        const parsed = JSON.parse(result.match(/\{[\s\S]*\}/)?.[0] || '{"groups":[]}');
        let removed = 0;

        for (const group of (parsed.groups || [])) {
            if (!Array.isArray(group) || group.length < 2) continue;
            const keeper = entries[group[0]];
            if (!keeper) continue;

            // Merge unique info from duplicates into keeper
            let keeperContent = keeper.content;
            for (let i = 1; i < group.length; i++) {
                const dup = entries[group[i]];
                if (!dup) continue;
                // Extract gotchas from duplicate that might not be in keeper
                const gotchas = dup.content.match(/\*\*Gotchas:\*\*\n((?:- .+\n)*)/);
                if (gotchas && !keeperContent.includes(gotchas[1].trim())) {
                    keeperContent = keeperContent.replace(/\n$/, `\n${gotchas[0]}\n`);
                }
                try { unlinkSync(dup.path); removed++; } catch {}
            }
            if (keeperContent !== keeper.content) {
                writeFileSync(keeper.path, keeperContent);
            }
        }

        if (removed > 0) logError(`Dedup: removed ${removed} duplicate KB entries`);
    } catch (err) {
        logError(`Dedup failed: ${err.message}`);
    }
}

// --- Validate essentials ---

function validateEssentials() {
    const dir = join(VAULT_PATH, BASE, 'essentials');
    if (!existsSync(dir)) return;

    const eightWeeksAgo = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let flagged = 0;

    for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
        const filepath = join(dir, f);
        let content = readFileSync(filepath, 'utf8');
        let modified = false;

        // Check last_verified
        const verifiedMatch = content.match(/^last_verified:\s*(.+)$/m);
        const needsVerification = !verifiedMatch || verifiedMatch[1].trim() < eightWeeksAgo;

        if (needsVerification) {
            // Check rows for path values and validate they exist
            const rows = content.match(/^\| .+ \| .+ \| .+ \| .+ \|$/gm) || [];
            for (const row of rows) {
                const cols = row.split('|').map(c => c.trim()).filter(Boolean);
                if (cols.length >= 4 && cols[1] === 'path') {
                    const pathVal = cols[2].replace(/`/g, '');
                    if (pathVal.startsWith('/') && !existsSync(pathVal)) {
                        if (!cols[3].includes('NEEDS VERIFICATION')) {
                            const newRow = row.replace(cols[3], `NEEDS VERIFICATION — ${cols[3]}`);
                            content = content.replace(row, newRow);
                            modified = true;
                            flagged++;
                        }
                    }
                }
            }

            // Add NEEDS VERIFICATION to frontmatter
            if (!content.includes('needs_verification: true')) {
                content = content.replace(/^(---\n)/, `$1needs_verification: true\n`);
                modified = true;
                flagged++;
            }
        }

        if (modified) writeFileSync(filepath, content);
    }

    if (flagged > 0) logError(`Essentials: flagged ${flagged} items needing verification`);
}

// --- Clean stale entries ---

function cleanStaleEntries() {
    const knowledgeDir = join(VAULT_PATH, BASE, 'knowledge');
    const archiveDir = join(VAULT_PATH, BASE, 'archive', 'stale');
    if (!existsSync(knowledgeDir)) return;

    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Get list of archived (inactive) projects
    const inactiveDir = join(VAULT_PATH, BASE, 'archive', 'inactive');
    const archivedProjects = new Set();
    if (existsSync(inactiveDir)) {
        for (const d of readdirSync(inactiveDir)) archivedProjects.add(d);
    }

    let moved = 0;
    for (const f of readdirSync(knowledgeDir).filter(f => f.endsWith('.md'))) {
        const content = readFileSync(join(knowledgeDir, f), 'utf8');
        const tierMatch = content.match(/^tier:\s*(tier\d)/m);
        const dateMatch = content.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m);
        const projectMatch = content.match(/^project:\s*(.+)$/m);

        if (tierMatch?.[1] !== 'tier2') continue;
        if (!dateMatch || dateMatch[1] >= sixMonthsAgo) continue;
        if (!projectMatch || !archivedProjects.has(projectMatch[1].trim())) continue;

        mkdirSync(archiveDir, { recursive: true });
        renameSync(join(knowledgeDir, f), join(archiveDir, f));
        moved++;
    }

    if (moved > 0) logError(`Stale cleanup: moved ${moved} old tier2 entries to archive`);
}

// --- Main ---

async function main() {
    // Check cooldown
    try {
        const lastRun = parseInt(readFileSync(COOLDOWN_FILE, 'utf8').trim(), 10);
        if (Date.now() - lastRun < COOLDOWN_MS) {
            logError('Maintenance skipped — cooldown not elapsed');
            return;
        }
    } catch {}

    writeFileSync(COOLDOWN_FILE, String(Date.now()));
    logError('Starting maintenance run');

    try { archiveInactiveProjects(); } catch (err) { logError(`Archive failed: ${err.message}`); }
    try { await consolidateDuplicates(); } catch (err) { logError(`Dedup failed: ${err.message}`); }
    try { validateEssentials(); } catch (err) { logError(`Validate failed: ${err.message}`); }
    try { cleanStaleEntries(); } catch (err) { logError(`Stale cleanup failed: ${err.message}`); }

    logError('Maintenance complete');
}

main().catch(err => {
    logError(`Maintenance fatal: ${err.message}`);
    process.exit(0);
});
