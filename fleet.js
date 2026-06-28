import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { loadWorkspaceYaml } from './pkg.js';
import { detectGitRepo } from './remote.js';
// Read a library-side hint from `<root>/pds.json`, else `package.json#pds`.
export function readPdsHint(root) {
    const hintPath = join(root, 'pds.json');
    if (existsSync(hintPath)) {
        try {
            return JSON.parse(readFileSync(hintPath, 'utf-8'));
        }
        catch {
            return null;
        }
    }
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            if (pkg.pds && typeof pkg.pds === 'object')
                return pkg.pds;
        }
        catch { }
    }
    return null;
}
// The package globs that define a workspace: pnpm-workspace.yaml `packages:`, or
// the `workspaces` field in package.json (npm/yarn style). Null if neither.
function workspaceGlobs(root) {
    const ws = loadWorkspaceYaml(root);
    if (ws?.packages?.length)
        return ws.packages;
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            const wsf = pkg.workspaces;
            if (Array.isArray(wsf))
                return wsf;
            if (wsf && Array.isArray(wsf.packages))
                return wsf.packages;
        }
        catch { }
    }
    return null;
}
// Expand a single workspace glob into matching directories. Handles literal
// paths, `.`, and `*` segments (one level, e.g. `packages/*`); `**` is treated
// like `*` (best-effort — workspace globs are rarely deeper). Negations (`!…`)
// are skipped.
function expandGlob(root, pattern) {
    if (pattern.startsWith('!'))
        return [];
    if (pattern === '.' || pattern === './')
        return [root];
    const segs = pattern.replace(/\/+$/, '').split('/').filter(Boolean);
    let dirs = [root];
    for (const seg of segs) {
        const next = [];
        for (const d of dirs) {
            if (seg === '*' || seg === '**') {
                try {
                    for (const e of readdirSync(d, { withFileTypes: true })) {
                        if (e.isDirectory() && !e.name.startsWith('.'))
                            next.push(join(d, e.name));
                    }
                }
                catch { }
            }
            else {
                const p = join(d, seg);
                if (existsSync(p))
                    next.push(p);
            }
        }
        dirs = next;
    }
    return dirs;
}
// Enumerate the named packages of a workspace rooted at `root`.
export function listWorkspacePackages(root) {
    const globs = workspaceGlobs(root);
    if (!globs)
        return [];
    const out = [];
    const seen = new Set();
    for (const g of globs) {
        for (const dir of expandGlob(root, g)) {
            if (seen.has(dir))
                continue;
            seen.add(dir);
            const pkgPath = join(dir, 'package.json');
            if (!existsSync(pkgPath))
                continue;
            try {
                const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
                if (pkg.name)
                    out.push({ dir, name: pkg.name, private: !!pkg.private });
            }
            catch { }
        }
    }
    return out;
}
// Detect whether `initPath` is a monorepo (root) whose fleet pds should manage as
// a unit. Returns null for a plain single package (caller falls back to the
// normal single-dep init). Resolution: a library hint file wins; otherwise the
// workspace's publishable packages are the fleet. Multiple members ⇒ override
// strategy by default (only `pnpm.overrides` forces transitive siblings).
export function detectFleet(initPath) {
    const hint = readPdsHint(initPath);
    const isWorkspaceRoot = workspaceGlobs(initPath) !== null;
    if (!hint && !isWorkspaceRoot)
        return null;
    const pkgs = listWorkspacePackages(initPath);
    let candidates = pkgs.filter(p => p.name);
    if (hint?.fleet?.length) {
        const want = new Set(hint.fleet);
        candidates = candidates.filter(p => want.has(p.name));
    }
    else {
        // Without an explicit fleet list, take the publishable packages.
        candidates = candidates.filter(p => !p.private);
    }
    if (candidates.length === 0)
        return null;
    const repo = detectGitRepo(initPath);
    const members = candidates.map(p => {
        const rel = relative(initPath, p.dir);
        return {
            localPath: p.dir,
            npm: p.name,
            subdir: rel ? `/${rel}` : undefined,
            github: repo?.github,
            gitlab: repo?.gitlab,
        };
    });
    const strategy = hint?.strategy ?? (members.length > 1 ? 'override' : 'default');
    return { members, strategy, fromHint: !!hint };
}
//# sourceMappingURL=fleet.js.map