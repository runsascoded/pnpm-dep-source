import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { c } from './constants.js';
import { loadPackageJson, savePackageJson, updatePackageJsonDep, setPnpmOverride, removePnpmOverride, hasDependency, loadWorkspaceYaml, saveWorkspaceYaml, } from './pkg.js';
import { resolveGitHubRef, resolveGitLabRef } from './remote.js';
import { workspaceLocalPath } from './project.js';
// pnpm.overrides live at the workspace root (the dir holding pnpm-workspace.yaml,
// or the single-package project root). `override`-managed deps force the WHOLE
// graph — including transitive monorepo siblings — to a single source, which the
// per-dependency package.json-rewrite strategy can't do.
function overrideRoot(projectRoot, workspaceRoot) {
    return workspaceRoot ?? projectRoot;
}
// Write (or, with `specifier === null`, remove) a pnpm.overrides entry.
function applyOverride(root, depName, specifier) {
    const pkg = loadPackageJson(root);
    if (specifier === null)
        removePnpmOverride(pkg, depName);
    else
        setPnpmOverride(pkg, depName, specifier);
    savePackageJson(root, pkg);
}
// `link:<path>` specifier for an override-managed local dep. localPath is relative
// to projectRoot; the override is declared at `root`, so re-relativize.
export function makeLinkSpecifier(projectRoot, root, localPath) {
    return `link:${relative(root, resolve(projectRoot, localPath))}`;
}
export function updateViteConfig(projectRoot, depName, exclude) {
    const vitePath = join(projectRoot, 'vite.config.ts');
    if (!existsSync(vitePath)) {
        return;
    }
    const content = readFileSync(vitePath, 'utf-8');
    const quoted = `'${depName}'`;
    if (exclude) {
        // Add depName to optimizeDeps.exclude
        if (content.includes(quoted) && content.includes('optimizeDeps')) {
            // Check if already in exclude array
            const excludeMatch = content.match(/exclude:\s*\[([^\]]*)\]/s);
            if (excludeMatch && excludeMatch[1].includes(quoted))
                return;
        }
        // Detect indentation from the file (horizontal whitespace only)
        const indentMatch = content.match(/\n([ \t]+)\S/);
        const indent = indentMatch?.[1] ?? '  ';
        const i2 = indent + indent;
        // Try to insert into existing optimizeDeps block
        const existingOptRe = /(\boptimizeDeps:\s*\{[^}]*)(})/;
        const existingOptMatch = content.match(existingOptRe);
        if (existingOptMatch) {
            // Has optimizeDeps but maybe no exclude, or exclude without this dep
            const existingExcludeRe = /(exclude:\s*\[)([^\]]*)(])/s;
            const innerMatch = existingOptMatch[0].match(existingExcludeRe);
            if (innerMatch) {
                // Add to existing exclude array
                if (innerMatch[2].includes(quoted))
                    return;
                const items = innerMatch[2].trim();
                const newItems = items ? `${items}, ${quoted}` : quoted;
                const updated = content.replace(existingExcludeRe, `$1${newItems}$3`);
                writeFileSync(vitePath, updated);
            }
            else {
                // Has optimizeDeps but no exclude — add exclude inside it
                const updated = content.replace(existingOptRe, `$1${i2}exclude: [${quoted}],\n${indent}$2`);
                writeFileSync(vitePath, updated);
            }
            return;
        }
        // No optimizeDeps block — insert before the closing `})` or `}`
        // Match the last closing: newline, optional indent, `}` optionally followed by `)`
        const closingRe = /\n([ \t]*)(}\)?\s*)$/;
        const closingMatch = content.match(closingRe);
        if (closingMatch) {
            const excludeBlock = `${indent}optimizeDeps: {\n${i2}exclude: [${quoted}],\n${indent}},`;
            // Ensure the previous property has a trailing comma
            let updated = content;
            const lastPropRe = /([^\s,])([ \t]*\n[ \t]*}\)?\s*)$/;
            updated = updated.replace(lastPropRe, '$1,$2');
            updated = updated.replace(closingRe, `\n${excludeBlock}\n$1$2`);
            writeFileSync(vitePath, updated);
        }
    }
    else {
        // Remove depName from optimizeDeps.exclude
        if (!content.includes('optimizeDeps'))
            return;
        let updated = content;
        // Remove the entry from the exclude array
        const excludeRe = /exclude:\s*\[([^\]]*)\]/s;
        const excludeMatch = updated.match(excludeRe);
        if (!excludeMatch)
            return;
        if (!excludeMatch[1].includes(quoted))
            return;
        // Remove the dep from the array
        const items = excludeMatch[1]
            .split(',')
            .map(s => s.trim())
            .filter(s => s && s !== quoted);
        if (items.length > 0) {
            // Other items remain
            updated = updated.replace(excludeRe, `exclude: [${items.join(', ')}]`);
        }
        else {
            // exclude array is now empty — remove the entire optimizeDeps block
            // Match the property line through closing `},` at the same indent level
            const indentMatch = updated.match(/\n([ \t]*)optimizeDeps:/);
            if (indentMatch) {
                const propIndent = indentMatch[1];
                const blockRe = new RegExp(`\\n${propIndent}optimizeDeps:\\s*\\{[\\s\\S]*?\\n${propIndent}\\},?\\n?`);
                updated = updated.replace(blockRe, '\n');
                // Check if the now-last property has a trailing comma we should remove.
                // We added a comma during insertion if the file didn't use trailing commas
                // on its last property. Detect by checking: does the now-last line before
                // `})` end with `,`, and would removing it leave a `}` or `]` (i.e., the
                // comma was after a closing bracket, not inline like `foo: 1,`)?
                // Simple heuristic: if the file's last property ends with `},` or `],`
                // before `})`, check if all OTHER properties at this level also end with
                // `,`. If not, this trailing comma was likely added by us.
                const propEndRe = new RegExp(`^${propIndent}(\\S.*?)\\s*$`, 'gm');
                const propEndings = [];
                let m;
                while ((m = propEndRe.exec(updated)) !== null) {
                    if (m[1].startsWith('optimizeDeps'))
                        continue;
                    propEndings.push(m[1].endsWith(','));
                }
                // If the last entry is true (has comma) but most others are false,
                // it was likely added by us. More precisely: if it's the only one
                // without a matching style, remove it.
                if (propEndings.length > 0) {
                    const lastHasComma = propEndings[propEndings.length - 1];
                    const othersWithComma = propEndings.slice(0, -1).filter(Boolean).length;
                    const othersWithout = propEndings.slice(0, -1).filter(x => !x).length;
                    if (lastHasComma && othersWithout > 0 && othersWithComma <= othersWithout) {
                        updated = updated.replace(/,([ \t]*\n[ \t]*}\)?\s*$)/, '$1');
                    }
                }
            }
        }
        if (updated !== content) {
            writeFileSync(vitePath, updated);
        }
    }
}
// Generate GitHub specifier using HTTPS tarball URL (avoids SSH auth issues in CI)
export function makeGitHubSpecifier(repo, ref, subdir) {
    if (subdir) {
        // pnpm git subdirectory syntax: #ref&path:/subdir
        return `https://github.com/${repo}#${ref}&path:${subdir}`;
    }
    return `https://github.com/${repo}#${ref}`;
}
// Generate a pkg.pr.new continuous-release URL: a raw HTTPS tarball-style
// specifier pnpm installs directly (mechanically like the GitLab tarball URL).
// Format: https://pkg.pr.new/<owner>/<repo>/<npmName>@<sha>
// `repo` is the GitHub "owner/repo"; `npm` is the package name (scope included).
export function makePkgPrNewSpecifier(repo, npm, sha) {
    return `https://pkg.pr.new/${repo}/${npm}@${sha}`;
}
// pds can track transitive deps of a monorepo fork (e.g. `@slidev/client` when
// only `@slidev/cli` is a direct dep). Those have no package.json entry to
// rewrite, but still need their workspace/override references managed. Apply the
// specifier when the dep is a direct dependency; always strip any pnpm override.
// Returns whether it was a direct dependency.
function applyPackageJsonSpecifier(projectRoot, depName, specifier) {
    const pkg = loadPackageJson(projectRoot);
    const inPkg = hasDependency(pkg, depName);
    if (inPkg)
        updatePackageJsonDep(pkg, depName, specifier);
    removePnpmOverride(pkg, depName);
    savePackageJson(projectRoot, pkg);
    return inPkg;
}
const transitiveNote = (inPkg) => inPkg ? '' : ' (transitive; package.json unchanged)';
// Helper to switch a dependency to local mode
export function switchToLocal(projectRoot, depName, depConfig, workspaceRoot) {
    const localPath = depConfig.localPath;
    if (!localPath) {
        throw new Error(`No local path configured for ${depName}. Use "pds set ${depName} -l <path>" to set one.`);
    }
    if (depConfig.override) {
        const root = overrideRoot(projectRoot, workspaceRoot);
        const specifier = makeLinkSpecifier(projectRoot, root, localPath);
        applyOverride(root, depName, specifier);
        console.log(`Switched ${depName} to local (override): ${specifier}`);
        return;
    }
    const pkg = loadPackageJson(projectRoot);
    const inPkg = hasDependency(pkg, depName);
    if (inPkg) {
        updatePackageJsonDep(pkg, depName, 'workspace:*');
        savePackageJson(projectRoot, pkg);
    }
    // Update pnpm-workspace.yaml
    const wsRoot = workspaceRoot ?? projectRoot;
    const ws = loadWorkspaceYaml(wsRoot) ?? { packages: workspaceRoot ? [] : ['.'] };
    if (!ws.packages)
        ws.packages = workspaceRoot ? [] : ['.'];
    if (!workspaceRoot && !ws.packages.includes('.'))
        ws.packages.unshift('.');
    const wsLocalPath = workspaceLocalPath(projectRoot, localPath, workspaceRoot);
    if (!ws.packages.includes(wsLocalPath)) {
        ws.packages.push(wsLocalPath);
    }
    saveWorkspaceYaml(wsRoot, ws);
    // Update vite.config.ts
    updateViteConfig(projectRoot, depName, true);
    console.log(`Switched ${depName} to local: ${resolve(projectRoot, localPath)}${transitiveNote(inPkg)}`);
}
// Helper to switch a dependency to GitHub mode
export function switchToGitHub(projectRoot, depName, depConfig, ref, workspaceRoot) {
    if (!depConfig.github) {
        throw new Error(`No GitHub repo configured for ${depName}`);
    }
    const distBranch = depConfig.distBranch ?? 'dist';
    const resolvedRef = ref ?? resolveGitHubRef(depConfig.github, distBranch);
    const specifier = makeGitHubSpecifier(depConfig.github, resolvedRef, depConfig.subdir);
    if (depConfig.override) {
        const root = overrideRoot(projectRoot, workspaceRoot);
        applyOverride(root, depName, specifier);
        console.log(`Switched ${depName} to GitHub (override): ${specifier}`);
        return;
    }
    const inPkg = applyPackageJsonSpecifier(projectRoot, depName, specifier);
    // Drop from pnpm-workspace.yaml + vite optimizeDeps.exclude
    cleanupDepReferences(projectRoot, depName, depConfig, workspaceRoot);
    console.log(`Switched ${depName} to GitHub: ${specifier}${transitiveNote(inPkg)}`);
}
// Helper to switch a dependency to GitLab mode
export function switchToGitLab(projectRoot, depName, depConfig, ref, workspaceRoot) {
    if (!depConfig.gitlab) {
        throw new Error(`No GitLab repo configured for ${depName}`);
    }
    const distBranch = depConfig.distBranch ?? 'dist';
    const resolvedRef = ref ?? resolveGitLabRef(depConfig.gitlab, distBranch);
    // GitLab uses tarball URL format (pnpm doesn't support gitlab: prefix)
    const repoBasename = depConfig.gitlab.split('/').pop();
    const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${resolvedRef}/${repoBasename}-${resolvedRef}.tar.gz`;
    if (depConfig.override) {
        const root = overrideRoot(projectRoot, workspaceRoot);
        applyOverride(root, depName, tarballUrl);
        console.log(`Switched ${depName} to GitLab (override): ${depConfig.gitlab}@${resolvedRef}`);
        return;
    }
    const inPkg = applyPackageJsonSpecifier(projectRoot, depName, tarballUrl);
    // Drop from pnpm-workspace.yaml + vite optimizeDeps.exclude
    cleanupDepReferences(projectRoot, depName, depConfig, workspaceRoot);
    console.log(`Switched ${depName} to GitLab: ${depConfig.gitlab}@${resolvedRef}${transitiveNote(inPkg)}`);
}
// Helper to switch a dependency to pkg.pr.new mode (SHA-pinned continuous release)
export function switchToPkgPrNew(projectRoot, depName, depConfig, resolvedSha, workspaceRoot) {
    if (!depConfig.github) {
        throw new Error(`No GitHub repo configured for ${depName}`);
    }
    if (!depConfig.npm) {
        throw new Error(`No npm package name configured for ${depName}`);
    }
    const specifier = makePkgPrNewSpecifier(depConfig.github, depConfig.npm, resolvedSha);
    if (depConfig.override) {
        const root = overrideRoot(projectRoot, workspaceRoot);
        applyOverride(root, depName, specifier);
        console.log(`Switched ${depName} to pkg.pr.new (override): ${specifier}`);
        return;
    }
    const inPkg = applyPackageJsonSpecifier(projectRoot, depName, specifier);
    // Drop from pnpm-workspace.yaml + vite optimizeDeps.exclude (same as gh/gl)
    cleanupDepReferences(projectRoot, depName, depConfig, workspaceRoot);
    console.log(`Switched ${depName} to pkg.pr.new: ${specifier}${transitiveNote(inPkg)}`);
}
// Helper to switch a dependency to NPM mode
export function switchToNpm(projectRoot, depName, depConfig, specifier, workspaceRoot) {
    if (depConfig.override) {
        // Pin the whole graph to the published version via override (symmetric with
        // the other override modes), rather than rewriting the package.json baseline.
        const root = overrideRoot(projectRoot, workspaceRoot);
        applyOverride(root, depName, specifier);
        console.log(`Switched ${depName} to NPM (override): ${specifier}`);
        return;
    }
    const inPkg = applyPackageJsonSpecifier(projectRoot, depName, specifier);
    // Drop from pnpm-workspace.yaml + vite optimizeDeps.exclude
    cleanupDepReferences(projectRoot, depName, depConfig, workspaceRoot);
    console.log(`Switched ${depName} to NPM: ${specifier}${transitiveNote(inPkg)}`);
}
// Helper to clean up workspace/vite when removing a dep
export function cleanupDepReferences(projectRoot, depName, depConfig, workspaceRoot) {
    // Drop any pnpm.overrides entry for override-managed deps
    if (depConfig.override) {
        applyOverride(overrideRoot(projectRoot, workspaceRoot), depName, null);
    }
    // Clean up pnpm-workspace.yaml if the dep was in it
    if (depConfig.localPath) {
        const wsRoot = workspaceRoot ?? projectRoot;
        const ws = loadWorkspaceYaml(wsRoot);
        if (ws?.packages) {
            const wsPath = workspaceLocalPath(projectRoot, depConfig.localPath, workspaceRoot);
            ws.packages = ws.packages.filter(p => p !== wsPath);
            if (workspaceRoot) {
                saveWorkspaceYaml(wsRoot, ws);
            }
            else if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
                saveWorkspaceYaml(wsRoot, null);
            }
            else {
                saveWorkspaceYaml(wsRoot, ws);
            }
        }
    }
    // Clean up vite.config.ts
    updateViteConfig(projectRoot, depName, false);
}
export function runPnpmInstall(projectRoot, workspaceRoot) {
    const installDir = workspaceRoot ?? projectRoot;
    console.log('Running pnpm install...');
    try {
        execSync('pnpm install', { cwd: installDir, stdio: 'inherit' });
    }
    catch {
        console.error(`${c.yellow}Warning: pnpm install failed (config changes were saved)${c.reset}`);
    }
}
export function runGlobalInstall(specifier) {
    console.log(`Running pnpm add -g ${specifier}...`);
    execSync(`pnpm add -g ${specifier}`, { stdio: 'inherit' });
}
//# sourceMappingURL=switch.js.map