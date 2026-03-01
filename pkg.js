import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
export function loadPackageJson(projectRoot) {
    const pkgPath = join(projectRoot, 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8'));
}
export function savePackageJson(projectRoot, pkg) {
    const pkgPath = join(projectRoot, 'package.json');
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}
export function removePnpmOverride(pkg, depName) {
    const pnpm = pkg.pnpm;
    if (!pnpm)
        return;
    const overrides = pnpm.overrides;
    if (!overrides || !(depName in overrides))
        return;
    delete overrides[depName];
    // Clean up empty overrides object
    if (Object.keys(overrides).length === 0) {
        delete pnpm.overrides;
    }
}
export function updatePackageJsonDep(pkg, depName, specifier) {
    const deps = pkg.dependencies;
    const devDeps = pkg.devDependencies;
    if (deps && depName in deps) {
        deps[depName] = specifier;
    }
    else if (devDeps && depName in devDeps) {
        devDeps[depName] = specifier;
    }
    else {
        throw new Error(`Dependency "${depName}" not found in package.json`);
    }
}
export function hasDependency(pkg, depName) {
    const deps = pkg.dependencies;
    const devDeps = pkg.devDependencies;
    return (deps && depName in deps) || (devDeps && depName in devDeps) || false;
}
export function addDependency(pkg, depName, specifier, isDev) {
    const key = isDev ? 'devDependencies' : 'dependencies';
    if (!pkg[key]) {
        pkg[key] = {};
    }
    const deps = pkg[key];
    deps[depName] = specifier;
}
export function removeDependency(pkg, depName) {
    const deps = pkg.dependencies;
    const devDeps = pkg.devDependencies;
    if (deps && depName in deps) {
        delete deps[depName];
        return true;
    }
    if (devDeps && depName in devDeps) {
        delete devDeps[depName];
        return true;
    }
    return false;
}
export function getCurrentSource(pkg, depName) {
    const deps = pkg.dependencies;
    const devDeps = pkg.devDependencies;
    return deps?.[depName] ?? devDeps?.[depName] ?? '(not found)';
}
export function getInstalledVersion(projectRoot, depName) {
    const pkgPath = join(projectRoot, 'node_modules', depName, 'package.json');
    if (!existsSync(pkgPath)) {
        return null;
    }
    try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return pkg.version ?? null;
    }
    catch {
        return null;
    }
}
export function loadWorkspaceYaml(projectRoot) {
    const wsPath = join(projectRoot, 'pnpm-workspace.yaml');
    if (!existsSync(wsPath)) {
        return null;
    }
    // Simple YAML parser for our use case
    const content = readFileSync(wsPath, 'utf-8');
    const packages = [];
    let inPackages = false;
    for (const line of content.split('\n')) {
        if (line.startsWith('packages:')) {
            inPackages = true;
            continue;
        }
        if (inPackages && line.match(/^\s+-\s+/)) {
            const pkg = line.replace(/^\s+-\s+/, '').trim();
            packages.push(pkg);
        }
        else if (inPackages && !line.match(/^\s/) && line.trim()) {
            inPackages = false;
        }
    }
    return { packages };
}
export function saveWorkspaceYaml(projectRoot, config) {
    const wsPath = join(projectRoot, 'pnpm-workspace.yaml');
    let existingContent = '';
    if (existsSync(wsPath)) {
        existingContent = readFileSync(wsPath, 'utf-8');
    }
    // Remove existing packages section from content
    const lines = existingContent.split('\n');
    const filteredLines = [];
    let inPackages = false;
    for (const line of lines) {
        if (line.match(/^packages:\s*$/)) {
            inPackages = true;
            continue;
        }
        if (inPackages) {
            // Skip package list items (indented with -)
            if (line.match(/^\s+-/)) {
                continue;
            }
            // Non-indented non-empty line ends packages section
            if (!line.match(/^\s/) && line.trim()) {
                inPackages = false;
                filteredLines.push(line);
            }
            // Skip empty/whitespace lines within packages section
            continue;
        }
        filteredLines.push(line);
    }
    // Build new content
    let newContent = filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // Add packages section if we have packages
    if (config?.packages && config.packages.length > 0) {
        const packagesSection = 'packages:\n' + config.packages.map(p => `  - ${p}`).join('\n');
        if (newContent) {
            newContent = newContent + '\n\n' + packagesSection + '\n';
        }
        else {
            newContent = packagesSection + '\n';
        }
        writeFileSync(wsPath, newContent);
    }
    else if (newContent) {
        // No packages but other content exists - keep the file without packages section
        writeFileSync(wsPath, newContent + '\n');
    }
    else if (existsSync(wsPath)) {
        // No packages and no other content - remove the file
        execSync(`rm "${wsPath}"`);
    }
}
//# sourceMappingURL=pkg.js.map