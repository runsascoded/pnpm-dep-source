import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { listWorkspacePackages } from './fleet.js';
import { log } from './log.js';
import { loadPackageJson } from './pkg.js';
function gitRoot(dir) {
    for (let d = dir;; d = dirname(d)) {
        if (existsSync(join(d, '.git')))
            return d;
        if (dirname(d) === d)
            return null;
    }
}
function packageName(dir) {
    try {
        const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).name;
        return typeof name === 'string' ? name : null;
    }
    catch {
        return null;
    }
}
// Nearest workspace root at or above `dir`, not leaving the repo at `root`.
function enclosingWorkspace(dir, root) {
    for (let d = dir;; d = dirname(d)) {
        if (listWorkspacePackages(d).length > 0)
            return d;
        if (d === root || dirname(d) === d)
            return null;
    }
}
export function findUnregisteredSiblings(projectRoot, config, pkg) {
    const depNames = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const registered = new Set();
    for (const [name, dc] of Object.entries(config.dependencies)) {
        registered.add(name);
        if (dc.npm)
            registered.add(dc.npm);
    }
    // Packages in the consumer's own repo are its workspace, not an external fleet.
    const projectRepo = gitRoot(resolve(projectRoot));
    const groups = new Map();
    for (const [name, dc] of Object.entries(config.dependencies)) {
        if (!dc.localPath)
            continue;
        const dir = resolve(projectRoot, dc.localPath);
        if (!existsSync(join(dir, 'package.json')))
            continue;
        const root = gitRoot(dir);
        if (!root || root === projectRepo)
            continue;
        let group = groups.get(root);
        if (!group) {
            group = { root, registered: new Set(), candidates: new Map() };
            groups.set(root, group);
        }
        group.registered.add(name);
        group.slug ??= dc.github ?? dc.gitlab;
        const ws = enclosingWorkspace(dir, root);
        if (ws) {
            group.monorepoRoot ??= ws;
            for (const p of listWorkspacePackages(ws))
                group.candidates.set(p.name, p.dir);
        }
        if (dir !== root) {
            const parent = dirname(dir);
            let entries = [];
            try {
                entries = readdirSync(parent);
            }
            catch { }
            for (const e of entries) {
                const sib = join(parent, e);
                const sibName = packageName(sib);
                if (sibName && !group.candidates.has(sibName))
                    group.candidates.set(sibName, sib);
            }
        }
    }
    const out = [];
    for (const group of groups.values()) {
        for (const [name, dir] of group.candidates) {
            if (!depNames.has(name) || registered.has(name))
                continue;
            out.push({
                name,
                dir,
                repo: group.slug ?? group.root,
                registered: [...group.registered].sort(),
                ...(group.monorepoRoot ? { monorepoRoot: group.monorepoRoot } : {}),
            });
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}
// Paths in the suggested commands are relative to cwd (where `pds init` resolves them).
export function formatSiblingWarning(s, cwd = process.cwd()) {
    const rel = (p) => relative(cwd, p) || '.';
    const repo = isAbsolute(s.repo) ? rel(s.repo) : s.repo;
    const lines = [
        `${s.name} is a dependency but isn't managed by pds, and comes from ${repo} (same repo as: ${s.registered.join(', ')}).`,
        `  Register it:  pds init ${rel(s.dir)}`,
    ];
    if (s.monorepoRoot)
        lines.push(`  Or the fleet: pds init ${rel(s.monorepoRoot)}`);
    return lines.join('\n');
}
let warned = false;
/** Warn (stderr, once per process) about unregistered repo siblings. Never throws. */
export function warnUnregisteredSiblings(projectRoot, config) {
    if (warned)
        return;
    warned = true;
    let found;
    try {
        found = findUnregisteredSiblings(projectRoot, config, loadPackageJson(projectRoot));
    }
    catch (e) {
        log.debug(`sibling check failed: ${e.message}`);
        return;
    }
    for (const s of found)
        log.warn(formatSiblingWarning(s));
}
//# sourceMappingURL=siblings.js.map