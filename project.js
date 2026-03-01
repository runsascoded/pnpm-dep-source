import { existsSync, readdirSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { JS_PROJECT_SUBDIRS } from './constants.js';
// Find project root (directory containing package.json)
export function findProjectRoot(startDir = process.cwd()) {
    let dir = startDir;
    let foundGit = false;
    while (dir !== dirname(dir)) {
        if (existsSync(join(dir, '.git')))
            foundGit = true;
        if (existsSync(join(dir, 'package.json'))) {
            return dir;
        }
        const parent = dirname(dir);
        // Don't walk past git repo boundary into a parent git repo
        if (foundGit && parent !== dir && existsSync(join(parent, '.git')))
            break;
        dir = parent;
    }
    // No package.json found - look for JS projects in subdirectories and provide helpful error
    const cwd = process.cwd();
    const suggestions = [];
    for (const subdir of JS_PROJECT_SUBDIRS) {
        const subdirPath = join(cwd, subdir);
        if (existsSync(join(subdirPath, 'package.json'))) {
            suggestions.push(subdir);
        }
    }
    // Also check for any immediate subdirectory with package.json
    try {
        const entries = readdirSync(cwd, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && !suggestions.includes(entry.name)) {
                if (existsSync(join(cwd, entry.name, 'package.json'))) {
                    suggestions.push(entry.name);
                }
            }
        }
    }
    catch {
        // Ignore errors reading directory
    }
    let message = 'No package.json found in current directory or any parent.';
    if (suggestions.length > 0) {
        message += `\n\nFound JS projects in subdirectories:\n${suggestions.map(s => `  cd ${s}`).join('\n')}`;
    }
    throw new Error(message);
}
// Find workspace root (ancestor directory with pnpm-workspace.yaml above projectRoot)
export function findWorkspaceRoot(projectRoot) {
    let dir = dirname(projectRoot);
    while (dir !== dirname(dir)) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml')))
            return dir;
        dir = dirname(dir);
    }
    return null;
}
// Compute the path to put in pnpm-workspace.yaml for a dep's localPath
export function workspaceLocalPath(projectRoot, localPath, workspaceRoot) {
    const wsRoot = workspaceRoot ?? projectRoot;
    return relative(wsRoot, resolve(projectRoot, localPath));
}
//# sourceMappingURL=project.js.map