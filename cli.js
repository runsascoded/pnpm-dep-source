#!/usr/bin/env node
import { program } from 'commander';
import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
const CONFIG_FILE = '.pnpm-dep-source.json';
// Find project root (directory containing package.json)
function findProjectRoot(startDir = process.cwd()) {
    let dir = startDir;
    while (dir !== '/') {
        if (existsSync(join(dir, 'package.json'))) {
            return dir;
        }
        dir = dirname(dir);
    }
    throw new Error('Could not find project root (no package.json found)');
}
function loadConfig(projectRoot) {
    const configPath = join(projectRoot, CONFIG_FILE);
    if (!existsSync(configPath)) {
        return { dependencies: {} };
    }
    return JSON.parse(readFileSync(configPath, 'utf-8'));
}
function saveConfig(projectRoot, config) {
    const configPath = join(projectRoot, CONFIG_FILE);
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
function loadPackageJson(projectRoot) {
    const pkgPath = join(projectRoot, 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8'));
}
function savePackageJson(projectRoot, pkg) {
    const pkgPath = join(projectRoot, 'package.json');
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}
function removePnpmOverride(pkg, depName) {
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
function loadWorkspaceYaml(projectRoot) {
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
function saveWorkspaceYaml(projectRoot, config) {
    const wsPath = join(projectRoot, 'pnpm-workspace.yaml');
    if (!config || !config.packages || config.packages.length === 0) {
        if (existsSync(wsPath)) {
            execSync(`rm ${wsPath}`);
        }
        return;
    }
    const content = 'packages:\n' + config.packages.map(p => `  - ${p}`).join('\n') + '\n';
    writeFileSync(wsPath, content);
}
function findMatchingDep(config, query) {
    const deps = Object.entries(config.dependencies);
    if (!query) {
        // No query - default to single dep if there's exactly one
        if (deps.length === 0) {
            throw new Error('No dependencies configured. Use "pds init <path>" to add one.');
        }
        if (deps.length === 1) {
            return deps[0];
        }
        throw new Error(`Multiple dependencies configured. Specify one: ${deps.map(([n]) => n).join(', ')}`);
    }
    const matches = deps.filter(([name]) => name.toLowerCase().includes(query.toLowerCase()));
    if (matches.length === 0) {
        throw new Error(`No dependency matching "${query}" found in config`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous match "${query}" - matches: ${matches.map(([n]) => n).join(', ')}`);
    }
    return matches[0];
}
function updatePackageJsonDep(pkg, depName, specifier) {
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
function getCurrentSource(pkg, depName) {
    const deps = pkg.dependencies;
    const devDeps = pkg.devDependencies;
    return deps?.[depName] ?? devDeps?.[depName] ?? '(not found)';
}
function updateViteConfig(projectRoot, depName, exclude) {
    const vitePath = join(projectRoot, 'vite.config.ts');
    if (!existsSync(vitePath)) {
        return; // No vite config, nothing to do
    }
    let content = readFileSync(vitePath, 'utf-8');
    if (exclude) {
        // Add to optimizeDeps.exclude if not present
        if (content.includes('optimizeDeps:')) {
            if (!content.includes(`'${depName}'`) && !content.includes(`"${depName}"`)) {
                // Add to existing exclude array
                content = content.replace(/exclude:\s*\[([^\]]*)\]/, (_, inner) => {
                    const items = inner.trim() ? inner.trim() + `, '${depName}'` : `'${depName}'`;
                    return `exclude: [${items}]`;
                });
                if (!content.includes(`'${depName}'`)) {
                    // No exclude array, add one
                    content = content.replace(/optimizeDeps:\s*\{([^}]*)\}/, (_, inner) => `optimizeDeps: {${inner.trimEnd()}\n    exclude: ['${depName}'],\n  }`);
                }
            }
        }
        else {
            // Add optimizeDeps section before closing })
            content = content.replace(/}\)\s*$/, `  optimizeDeps: {\n    exclude: ['${depName}'],\n  },\n})\n`);
        }
    }
    else {
        // Remove from optimizeDeps.exclude
        // Remove the dep from exclude array
        content = content.replace(new RegExp(`['"]${depName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"],?\\s*`, 'g'), '');
        // Clean up empty exclude arrays
        content = content.replace(/\s*exclude:\s*\[\s*\],?/g, '');
        // Clean up empty optimizeDeps (including leading whitespace)
        content = content.replace(/\s*optimizeDeps:\s*\{\s*\},?/g, '');
    }
    writeFileSync(vitePath, content);
}
function resolveGitHubRef(repo, ref) {
    // Use gh api to resolve ref to SHA from GitHub
    const result = spawnSync('gh', ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error(`Failed to resolve GitHub ref "${ref}" for ${repo}: ${result.stderr}`);
    }
    return result.stdout.trim();
}
function resolveGitLabRef(repo, ref) {
    // Use glab api to resolve ref to SHA from GitLab
    const encodedRepo = encodeURIComponent(repo);
    const result = spawnSync('glab', ['api', `projects/${encodedRepo}/repository/commits/${ref}`], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error(`Failed to resolve GitLab ref "${ref}" for ${repo}: ${result.stderr}`);
    }
    try {
        const data = JSON.parse(result.stdout);
        return data.id;
    }
    catch {
        throw new Error(`Failed to parse GitLab API response for ${repo}: ${result.stdout}`);
    }
}
function getLocalPackageName(localPath) {
    const pkgPath = join(localPath, 'package.json');
    if (!existsSync(pkgPath)) {
        throw new Error(`No package.json found at ${localPath}`);
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.name;
}
function runPnpmInstall(projectRoot) {
    console.log('Running pnpm install...');
    execSync('pnpm install', { cwd: projectRoot, stdio: 'inherit' });
}
function runGlobalInstall(specifier) {
    console.log(`Running pnpm add -g ${specifier}...`);
    execSync(`pnpm add -g ${specifier}`, { stdio: 'inherit' });
}
function getLatestNpmVersion(packageName) {
    const result = spawnSync('npm', ['view', packageName, 'version'], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error(`Failed to get latest version for ${packageName}: ${result.stderr}`);
    }
    return result.stdout.trim();
}
function getGlobalInstallSource() {
    const result = spawnSync('pnpm', ['list', '-g', 'pnpm-dep-source', '--json'], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        return null;
    }
    try {
        const data = JSON.parse(result.stdout);
        // pnpm list -g --json returns array of global packages
        const pkg = data[0]?.dependencies?.['pnpm-dep-source'];
        if (!pkg)
            return null;
        const version = pkg.version;
        const from = pkg.from || '';
        if (from.startsWith('file:')) {
            return { source: 'local', specifier: from };
        }
        else if (from.startsWith('github:')) {
            return { source: 'github', specifier: from };
        }
        else if (from.includes('gitlab.com') && from.includes('/-/archive/')) {
            return { source: 'gitlab', specifier: from };
        }
        else if (version) {
            return { source: 'npm', specifier: version };
        }
        return null;
    }
    catch {
        return null;
    }
}
program
    .name('pnpm-dep-source')
    .description('Switch pnpm dependencies between local, GitHub, and NPM sources')
    .version('0.1.1');
program
    .command('init <local-path>')
    .description('Initialize a dependency in the config')
    .option('-b, --dist-branch <branch>', 'Git branch for dist builds', 'dist')
    .option('-g, --github <repo>', 'GitHub repo (e.g. "user/repo")')
    .option('-l, --gitlab <repo>', 'GitLab repo (e.g. "user/repo")')
    .option('-n, --npm <name>', 'NPM package name (defaults to name from local package.json)')
    .action((localPath, options) => {
    const projectRoot = findProjectRoot();
    const config = loadConfig(projectRoot);
    const absLocalPath = resolve(localPath);
    const relLocalPath = relative(projectRoot, absLocalPath);
    const pkgName = getLocalPackageName(absLocalPath);
    const npmName = options.npm ?? pkgName;
    config.dependencies[pkgName] = {
        localPath: relLocalPath,
        github: options.github,
        gitlab: options.gitlab,
        npm: npmName,
        distBranch: options.distBranch,
    };
    saveConfig(projectRoot, config);
    console.log(`Initialized ${pkgName}:`);
    console.log(`  Local path: ${relLocalPath}`);
    if (options.github)
        console.log(`  GitHub: ${options.github}`);
    if (options.gitlab)
        console.log(`  GitLab: ${options.gitlab}`);
    console.log(`  NPM: ${npmName}`);
    console.log(`  Dist branch: ${options.distBranch}`);
});
program
    .command('list')
    .alias('ls')
    .description('List configured dependencies and their current sources')
    .action(() => {
    const projectRoot = findProjectRoot();
    const config = loadConfig(projectRoot);
    const pkg = loadPackageJson(projectRoot);
    if (Object.keys(config.dependencies).length === 0) {
        console.log('No dependencies configured. Use "pnpm-dep-source init <path>" to add one.');
        return;
    }
    for (const [name, dep] of Object.entries(config.dependencies)) {
        const current = getCurrentSource(pkg, name);
        console.log(`${name}:`);
        console.log(`  Current: ${current}`);
        console.log(`  Local: ${dep.localPath}`);
        if (dep.github)
            console.log(`  GitHub: ${dep.github}`);
        if (dep.gitlab)
            console.log(`  GitLab: ${dep.gitlab}`);
        if (dep.npm)
            console.log(`  NPM: ${dep.npm}`);
    }
});
program
    .command('local [dep]')
    .alias('l')
    .description('Switch dependency to local directory')
    .option('-g, --global', 'Install globally')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((depQuery, options) => {
    const projectRoot = findProjectRoot();
    const config = loadConfig(projectRoot);
    const [depName, depConfig] = findMatchingDep(config, depQuery);
    const absLocalPath = resolve(projectRoot, depConfig.localPath);
    if (options.global) {
        runGlobalInstall(`file:${absLocalPath}`);
        console.log(`Installed ${depName} globally from local: ${absLocalPath}`);
        return;
    }
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, 'workspace:*');
    savePackageJson(projectRoot, pkg);
    // Update pnpm-workspace.yaml
    const ws = loadWorkspaceYaml(projectRoot) ?? { packages: ['.'] };
    if (!ws.packages)
        ws.packages = ['.'];
    if (!ws.packages.includes('.'))
        ws.packages.unshift('.');
    if (!ws.packages.includes(depConfig.localPath)) {
        ws.packages.push(depConfig.localPath);
    }
    saveWorkspaceYaml(projectRoot, ws);
    // Update vite.config.ts
    updateViteConfig(projectRoot, depName, true);
    console.log(`Switched ${depName} to local: ${depConfig.localPath}`);
    if (options.install) {
        runPnpmInstall(projectRoot);
    }
});
program
    .command('github [dep] [ref]')
    .aliases(['gh', 'g'])
    .description('Switch dependency to GitHub ref (defaults to dist branch HEAD)')
    .option('-g, --global', 'Install globally')
    .option('-s, --sha', 'Resolve ref to SHA')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((arg1, arg2, options) => {
    const projectRoot = findProjectRoot();
    const config = loadConfig(projectRoot);
    const deps = Object.entries(config.dependencies);
    // If only one arg and exactly one dep configured, treat arg as ref
    let depQuery;
    let ref;
    if (arg1 && !arg2 && deps.length === 1) {
        depQuery = undefined;
        ref = arg1;
    }
    else {
        depQuery = arg1;
        ref = arg2;
    }
    const [depName, depConfig] = findMatchingDep(config, depQuery);
    if (!depConfig.github) {
        throw new Error(`No GitHub repo configured for ${depName}. Use "pnpm-dep-source init" with --github`);
    }
    const distBranch = depConfig.distBranch ?? 'dist';
    let resolvedRef;
    if (!ref) {
        // No ref provided: use dist branch, resolve to SHA
        resolvedRef = resolveGitHubRef(depConfig.github, distBranch);
    }
    else if (options.sha) {
        // Ref provided with -s: resolve to SHA via GitHub API
        resolvedRef = resolveGitHubRef(depConfig.github, ref);
    }
    else {
        // Ref provided without -s: use as-is
        resolvedRef = ref;
    }
    const specifier = `github:${depConfig.github}#${resolvedRef}`;
    if (options.global) {
        runGlobalInstall(specifier);
        console.log(`Installed ${depName} globally from GitHub: ${depConfig.github}#${resolvedRef}`);
        return;
    }
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, specifier);
    removePnpmOverride(pkg, depName);
    savePackageJson(projectRoot, pkg);
    // Remove from pnpm-workspace.yaml
    const ws = loadWorkspaceYaml(projectRoot);
    if (ws?.packages) {
        ws.packages = ws.packages.filter(p => p !== depConfig.localPath);
        if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
            saveWorkspaceYaml(projectRoot, null);
        }
        else {
            saveWorkspaceYaml(projectRoot, ws);
        }
    }
    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false);
    console.log(`Switched ${depName} to GitHub: ${depConfig.github}#${resolvedRef}`);
    if (options.install) {
        runPnpmInstall(projectRoot);
    }
});
program
    .command('gitlab [dep] [ref]')
    .aliases(['gl'])
    .description('Switch dependency to GitLab ref (defaults to dist branch HEAD)')
    .option('-g, --global', 'Install globally')
    .option('-s, --sha', 'Resolve ref to SHA')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((arg1, arg2, options) => {
    const projectRoot = findProjectRoot();
    const config = loadConfig(projectRoot);
    const deps = Object.entries(config.dependencies);
    // If only one arg and exactly one dep configured, treat arg as ref
    let depQuery;
    let ref;
    if (arg1 && !arg2 && deps.length === 1) {
        depQuery = undefined;
        ref = arg1;
    }
    else {
        depQuery = arg1;
        ref = arg2;
    }
    const [depName, depConfig] = findMatchingDep(config, depQuery);
    if (!depConfig.gitlab) {
        throw new Error(`No GitLab repo configured for ${depName}. Use "pnpm-dep-source init" with --gitlab`);
    }
    const distBranch = depConfig.distBranch ?? 'dist';
    let resolvedRef;
    if (!ref) {
        // No ref provided: use dist branch, resolve to SHA
        resolvedRef = resolveGitLabRef(depConfig.gitlab, distBranch);
    }
    else if (options.sha) {
        // Ref provided with -s: resolve to SHA via GitLab API
        resolvedRef = resolveGitLabRef(depConfig.gitlab, ref);
    }
    else {
        // Ref provided without -s: use as-is
        resolvedRef = ref;
    }
    // GitLab uses tarball URL format (pnpm doesn't support gitlab: prefix)
    // Format: https://gitlab.com/{repo}/-/archive/{ref}/{basename}-{ref}.tar.gz
    const repoBasename = depConfig.gitlab.split('/').pop();
    const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${resolvedRef}/${repoBasename}-${resolvedRef}.tar.gz`;
    if (options.global) {
        runGlobalInstall(tarballUrl);
        console.log(`Installed ${depName} globally from GitLab: ${depConfig.gitlab}@${resolvedRef}`);
        return;
    }
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, tarballUrl);
    removePnpmOverride(pkg, depName);
    savePackageJson(projectRoot, pkg);
    // Remove from pnpm-workspace.yaml
    const ws = loadWorkspaceYaml(projectRoot);
    if (ws?.packages) {
        ws.packages = ws.packages.filter(p => p !== depConfig.localPath);
        if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
            saveWorkspaceYaml(projectRoot, null);
        }
        else {
            saveWorkspaceYaml(projectRoot, ws);
        }
    }
    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false);
    console.log(`Switched ${depName} to GitLab: ${depConfig.gitlab}@${resolvedRef}`);
    if (options.install) {
        runPnpmInstall(projectRoot);
    }
});
program
    .command('npm [dep] [version]')
    .alias('n')
    .description('Switch dependency to NPM (defaults to latest)')
    .option('-g, --global', 'Install globally')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((arg1, arg2, options) => {
    const projectRoot = findProjectRoot();
    const config = loadConfig(projectRoot);
    const deps = Object.entries(config.dependencies);
    // If only one arg and exactly one dep configured, treat arg as version
    let depQuery;
    let version;
    if (arg1 && !arg2 && deps.length === 1) {
        depQuery = undefined;
        version = arg1;
    }
    else {
        depQuery = arg1;
        version = arg2;
    }
    const [depName, depConfig] = findMatchingDep(config, depQuery);
    const npmName = depConfig.npm ?? depName;
    // Resolve latest version from NPM if not specified
    const resolvedVersion = version ?? getLatestNpmVersion(npmName);
    const specifier = `${npmName}@${resolvedVersion}`;
    if (options.global) {
        runGlobalInstall(specifier);
        console.log(`Installed ${depName} globally from NPM: ${specifier}`);
        return;
    }
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, `^${resolvedVersion}`);
    removePnpmOverride(pkg, depName);
    savePackageJson(projectRoot, pkg);
    // Remove from pnpm-workspace.yaml
    const ws = loadWorkspaceYaml(projectRoot);
    if (ws?.packages) {
        ws.packages = ws.packages.filter(p => p !== depConfig.localPath);
        if (ws.packages.length === 0 || (ws.packages.length === 1 && ws.packages[0] === '.')) {
            saveWorkspaceYaml(projectRoot, null);
        }
        else {
            saveWorkspaceYaml(projectRoot, ws);
        }
    }
    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false);
    console.log(`Switched ${depName} to NPM: ^${resolvedVersion}`);
    if (options.install) {
        runPnpmInstall(projectRoot);
    }
});
program
    .command('status [dep]')
    .alias('s')
    .description('Show current source for dependency (or all if none specified)')
    .action((depQuery) => {
    const projectRoot = findProjectRoot();
    const config = loadConfig(projectRoot);
    const pkg = loadPackageJson(projectRoot);
    const deps = depQuery
        ? [findMatchingDep(config, depQuery)]
        : Object.entries(config.dependencies);
    for (const [name] of deps) {
        const current = getCurrentSource(pkg, name);
        let sourceType = 'unknown';
        if (current === 'workspace:*')
            sourceType = 'local';
        else if (current.startsWith('github:'))
            sourceType = 'github';
        else if (current.includes('gitlab.com') && current.includes('/-/archive/'))
            sourceType = 'gitlab';
        else if (current.match(/^\^?\d|^latest/))
            sourceType = 'npm';
        console.log(`${name}: ${sourceType} (${current})`);
    }
});
program
    .command('info')
    .alias('i')
    .description('Show pds version and install source')
    .action(() => {
    const binPath = process.argv[1];
    let realPath;
    try {
        realPath = realpathSync(binPath);
    }
    catch {
        realPath = binPath;
    }
    console.log(`pnpm-dep-source v0.1.1`);
    if (binPath !== realPath) {
        console.log(`  binary: ${binPath} -> ${realPath}`);
    }
    else {
        console.log(`  binary: ${binPath}`);
    }
    // Try pnpm global list first
    const installSource = getGlobalInstallSource();
    if (installSource) {
        console.log(`  source: ${installSource.source} (${installSource.specifier})`);
        return;
    }
    // Check package.json in the package directory
    const pkgDir = realPath.includes('/dist/cli.js')
        ? realPath.replace(/\/dist\/cli\.js$/, '')
        : dirname(dirname(realPath)); // assume bin/pds structure
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
            const version = pkg.version || 'unknown';
            // Check if this looks like a development checkout (has src/, .git, etc.)
            const hasSrc = existsSync(join(pkgDir, 'src'));
            const hasGit = existsSync(join(pkgDir, '.git'));
            if (hasSrc && hasGit) {
                console.log(`  source: local (${pkgDir})`);
            }
            else if (realPath.includes('node_modules')) {
                // Installed in node_modules - check if it's pnpm, npm, or linked
                if (realPath.includes('.pnpm')) {
                    console.log(`  source: pnpm (v${version})`);
                }
                else {
                    console.log(`  source: npm (v${version})`);
                }
            }
            else {
                console.log(`  source: v${version} (${pkgDir})`);
            }
            return;
        }
        catch {
            // Fall through
        }
    }
    console.log(`  source: unknown`);
});
program.parse();
//# sourceMappingURL=cli.js.map