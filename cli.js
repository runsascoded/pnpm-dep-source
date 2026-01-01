#!/usr/bin/env node
import { program } from 'commander';
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
// Find package.json by walking up from current file
// (handles both dev mode where cli is in dist/, and dist branch where cli is at root)
function findOwnPackageJson() {
    let dir = __dirname;
    while (dir !== dirname(dir)) {
        const pkgPath = join(dir, 'package.json');
        if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            if (pkg.name === 'pnpm-dep-source')
                return pkgPath;
        }
        dir = dirname(dir);
    }
    throw new Error('Could not find pnpm-dep-source package.json');
}
const pkgJson = JSON.parse(readFileSync(findOwnPackageJson(), 'utf-8'));
const VERSION = pkgJson.version;
const CONFIG_FILE = '.pnpm-dep-source.json';
const GLOBAL_CONFIG_DIR = join(homedir(), '.config', 'pnpm-dep-source');
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json');
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
function loadGlobalConfig() {
    if (!existsSync(GLOBAL_CONFIG_FILE)) {
        return { dependencies: {} };
    }
    return JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, 'utf-8'));
}
function saveGlobalConfig(config) {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
    }
    writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
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
function hasDependency(pkg, depName) {
    const deps = pkg.dependencies;
    const devDeps = pkg.devDependencies;
    return (deps && depName in deps) || (devDeps && depName in devDeps) || false;
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
// Parse GitHub/GitLab repo from a URL string
function parseRepoUrl(repoUrl) {
    const result = {};
    // Handle various URL formats:
    // - git+https://github.com/user/repo.git
    // - https://github.com/user/repo
    // - github:user/repo
    // - git@github.com:user/repo.git
    const githubMatch = repoUrl.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
        || repoUrl.match(/^github:([\w.-]+\/[\w.-]+)$/);
    if (githubMatch) {
        result.github = githubMatch[1];
    }
    // GitLab supports nested groups: gitlab.com/group/subgroup/repo
    const gitlabMatch = repoUrl.match(/gitlab\.com[/:]([\w./-]+?)(?:\.git)?$/)
        || repoUrl.match(/^gitlab:([\w./-]+)$/);
    if (gitlabMatch) {
        result.gitlab = gitlabMatch[1];
    }
    return result;
}
// Parse package.json content into PackageInfo
function parsePackageJson(pkg) {
    const result = { name: pkg.name };
    const repo = pkg.repository;
    if (repo) {
        let repoUrl;
        if (typeof repo === 'string') {
            repoUrl = repo;
        }
        else if (typeof repo === 'object' && repo !== null && 'url' in repo) {
            repoUrl = repo.url;
        }
        if (repoUrl) {
            const parsed = parseRepoUrl(repoUrl);
            result.github = parsed.github;
            result.gitlab = parsed.gitlab;
        }
    }
    return result;
}
// Fetch package.json from GitHub repo
function fetchGitHubPackageJson(repo, ref = 'HEAD') {
    const result = spawnSync('gh', ['api', `repos/${repo}/contents/package.json`, '--jq', '.content'], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error(`Failed to fetch package.json from GitHub ${repo}: ${result.stderr}`);
    }
    const content = Buffer.from(result.stdout.trim(), 'base64').toString('utf-8');
    return JSON.parse(content);
}
// Fetch package.json from GitLab repo
function fetchGitLabPackageJson(repo, ref = 'HEAD') {
    const encodedPath = encodeURIComponent(repo);
    const result = spawnSync('glab', ['api', `projects/${encodedPath}/repository/files/package.json/raw?ref=${ref}`], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error(`Failed to fetch package.json from GitLab ${repo}: ${result.stderr}`);
    }
    return JSON.parse(result.stdout);
}
// Get package info from local path
function getLocalPackageInfo(localPath) {
    const pkgPath = join(localPath, 'package.json');
    if (!existsSync(pkgPath)) {
        throw new Error(`No package.json found at ${localPath}`);
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return parsePackageJson(pkg);
}
// Get package info from URL (GitHub or GitLab)
function getRemotePackageInfo(url) {
    const parsed = parseRepoUrl(url);
    let pkg;
    if (parsed.github) {
        pkg = fetchGitHubPackageJson(parsed.github);
    }
    else if (parsed.gitlab) {
        pkg = fetchGitLabPackageJson(parsed.gitlab);
    }
    else {
        throw new Error(`Cannot parse repository from URL: ${url}`);
    }
    const info = parsePackageJson(pkg);
    // Override with the URL we were given (it's authoritative)
    return {
        ...info,
        github: parsed.github ?? info.github,
        gitlab: parsed.gitlab ?? info.gitlab,
    };
}
// Check if argument looks like a URL rather than a local path
function isRepoUrl(arg) {
    return arg.startsWith('http://') ||
        arg.startsWith('https://') ||
        arg.startsWith('github:') ||
        arg.startsWith('gitlab:') ||
        arg.startsWith('git@');
}
function getLocalPackageName(localPath) {
    return getLocalPackageInfo(localPath).name;
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
function getGlobalInstallSource(packageName = 'pnpm-dep-source') {
    const result = spawnSync('pnpm', ['list', '-g', packageName, '--json'], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        return null;
    }
    try {
        const data = JSON.parse(result.stdout);
        // pnpm list -g --json returns array of global packages
        const pkg = data[0]?.dependencies?.[packageName];
        if (!pkg)
            return null;
        const version = pkg.version || '';
        const resolved = pkg.resolved || '';
        // Local file install: version is "file:..." path
        if (version.startsWith('file:')) {
            // Resolve relative path to absolute (relative to pnpm global dir)
            const filePath = version.slice(5); // remove "file:"
            const globalDir = data[0]?.path || '';
            const absPath = globalDir ? resolve(globalDir, filePath) : filePath;
            return { source: 'local', specifier: absPath };
        }
        // Check resolved URL for source detection
        if (resolved.includes('codeload.github.com') || resolved.includes('github.com')) {
            // Extract SHA from GitHub URL
            const shaMatch = resolved.match(/([a-f0-9]{40})/);
            const sha = shaMatch ? shaMatch[1].slice(0, 7) : '';
            return { source: 'github', specifier: `${sha}; ${version}` };
        }
        else if (resolved.includes('gitlab.com') && resolved.includes('/-/archive/')) {
            // Extract ref from GitLab tarball URL
            const refMatch = resolved.match(/\/-\/archive\/([^/]+)\//);
            const ref = refMatch ? refMatch[1].slice(0, 7) : '';
            return { source: 'gitlab', specifier: `${ref}; ${version}` };
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
// Helper to switch a dependency to local mode
function switchToLocal(projectRoot, depName, localPath) {
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, 'workspace:*');
    savePackageJson(projectRoot, pkg);
    // Update pnpm-workspace.yaml
    const ws = loadWorkspaceYaml(projectRoot) ?? { packages: ['.'] };
    if (!ws.packages)
        ws.packages = ['.'];
    if (!ws.packages.includes('.'))
        ws.packages.unshift('.');
    if (!ws.packages.includes(localPath)) {
        ws.packages.push(localPath);
    }
    saveWorkspaceYaml(projectRoot, ws);
    // Update vite.config.ts
    updateViteConfig(projectRoot, depName, true);
    console.log(`Switched ${depName} to local: ${resolve(projectRoot, localPath)}`);
}
// Helper to switch a dependency to GitHub mode
function switchToGitHub(projectRoot, depName, depConfig, ref) {
    if (!depConfig.github) {
        throw new Error(`No GitHub repo configured for ${depName}`);
    }
    const distBranch = depConfig.distBranch ?? 'dist';
    const resolvedRef = ref ?? resolveGitHubRef(depConfig.github, distBranch);
    const specifier = `github:${depConfig.github}#${resolvedRef}`;
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, specifier);
    removePnpmOverride(pkg, depName);
    savePackageJson(projectRoot, pkg);
    // Remove from pnpm-workspace.yaml
    if (depConfig.localPath) {
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
    }
    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false);
    console.log(`Switched ${depName} to GitHub: ${depConfig.github}#${resolvedRef}`);
}
// Helper to switch a dependency to GitLab mode
function switchToGitLab(projectRoot, depName, depConfig, ref) {
    if (!depConfig.gitlab) {
        throw new Error(`No GitLab repo configured for ${depName}`);
    }
    const distBranch = depConfig.distBranch ?? 'dist';
    const resolvedRef = ref ?? resolveGitLabRef(depConfig.gitlab, distBranch);
    // GitLab uses tarball URL format (pnpm doesn't support gitlab: prefix)
    const repoBasename = depConfig.gitlab.split('/').pop();
    const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${resolvedRef}/${repoBasename}-${resolvedRef}.tar.gz`;
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, tarballUrl);
    removePnpmOverride(pkg, depName);
    savePackageJson(projectRoot, pkg);
    // Remove from pnpm-workspace.yaml
    if (depConfig.localPath) {
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
    }
    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false);
    console.log(`Switched ${depName} to GitLab: ${depConfig.gitlab}@${resolvedRef}`);
}
program
    .name('pnpm-dep-source')
    .description('Switch pnpm dependencies between local, GitHub, and NPM sources')
    .version(VERSION);
program
    .command('init <path-or-url>')
    .description('Initialize a dependency from local path or repo URL and activate it')
    .option('-b, --dist-branch <branch>', 'Git branch for dist builds', 'dist')
    .option('-f, --force', 'Suppress mismatch warnings')
    .option('-g, --global', 'Add to global config (for CLI tools)')
    .option('-H, --github <repo>', 'GitHub repo (e.g. "user/repo")')
    .option('-I, --no-install', 'Skip running pnpm install')
    .option('-L, --gitlab <repo>', 'GitLab repo (e.g. "user/repo")')
    .option('-l, --local <path>', 'Local path (when initializing from URL)')
    .option('-n, --npm <name>', 'NPM package name (defaults to name from package.json)')
    .action((pathOrUrl, options) => {
    const isUrl = isRepoUrl(pathOrUrl);
    let pkgInfo;
    let localPath;
    let activateSource;
    if (isUrl) {
        // Fetch package.json from remote repo
        pkgInfo = getRemotePackageInfo(pathOrUrl);
        localPath = options.local ? resolve(options.local) : undefined;
        // Determine which source to activate based on URL type
        if (localPath) {
            activateSource = 'local';
        }
        else if (pkgInfo.github) {
            activateSource = 'github';
        }
        else if (pkgInfo.gitlab) {
            activateSource = 'gitlab';
        }
    }
    else {
        // Read from local path
        localPath = resolve(pathOrUrl);
        pkgInfo = getLocalPackageInfo(localPath);
        activateSource = 'local';
    }
    const pkgName = pkgInfo.name;
    // Warn on mismatches (unless --force)
    if (!options.force) {
        if (options.github && pkgInfo.github && options.github !== pkgInfo.github) {
            console.warn(`Warning: GitHub '${options.github}' differs from package.json '${pkgInfo.github}'`);
        }
        if (options.gitlab && pkgInfo.gitlab && options.gitlab !== pkgInfo.gitlab) {
            console.warn(`Warning: GitLab '${options.gitlab}' differs from package.json '${pkgInfo.gitlab}'`);
        }
        if (options.npm && options.npm !== pkgName) {
            console.warn(`Warning: NPM name '${options.npm}' differs from package.json '${pkgName}'`);
        }
    }
    const npmName = options.npm ?? pkgName;
    const github = options.github ?? pkgInfo.github;
    const gitlab = options.gitlab ?? pkgInfo.gitlab;
    if (options.global) {
        const config = loadGlobalConfig();
        config.dependencies[pkgName] = {
            localPath,
            github,
            gitlab,
            npm: npmName,
            distBranch: options.distBranch,
        };
        saveGlobalConfig(config);
        console.log(`Initialized ${pkgName} (global):`);
        if (localPath)
            console.log(`  Local path: ${localPath}`);
        if (github)
            console.log(`  GitHub: ${github}`);
        if (gitlab)
            console.log(`  GitLab: ${gitlab}`);
        console.log(`  NPM: ${npmName}`);
        console.log(`  Dist branch: ${options.distBranch}`);
        // Activate for global: install from local path if provided
        if (localPath) {
            runGlobalInstall(`file:${localPath}`);
            console.log(`Installed ${pkgName} globally from local: ${localPath}`);
        }
        return;
    }
    const projectRoot = findProjectRoot();
    const config = loadConfig(projectRoot);
    const relLocalPath = localPath ? relative(projectRoot, localPath) : undefined;
    const depConfig = {
        localPath: relLocalPath,
        github,
        gitlab,
        npm: npmName,
        distBranch: options.distBranch,
    };
    config.dependencies[pkgName] = depConfig;
    saveConfig(projectRoot, config);
    console.log(`Initialized ${pkgName}:`);
    if (relLocalPath)
        console.log(`  Local path: ${relLocalPath}`);
    if (github)
        console.log(`  GitHub: ${github}`);
    if (gitlab)
        console.log(`  GitLab: ${gitlab}`);
    console.log(`  NPM: ${npmName}`);
    console.log(`  Dist branch: ${options.distBranch}`);
    // Activate the dependency based on input type (only if dep exists in package.json)
    const pkg = loadPackageJson(projectRoot);
    if (!hasDependency(pkg, pkgName)) {
        console.log(`(${pkgName} not in package.json, skipping activation)`);
        return;
    }
    if (activateSource === 'local' && relLocalPath) {
        switchToLocal(projectRoot, pkgName, relLocalPath);
        if (options.install) {
            runPnpmInstall(projectRoot);
        }
    }
    else if (activateSource === 'github' && github) {
        switchToGitHub(projectRoot, pkgName, depConfig);
        if (options.install) {
            runPnpmInstall(projectRoot);
        }
    }
    else if (activateSource === 'gitlab' && gitlab) {
        switchToGitLab(projectRoot, pkgName, depConfig);
        if (options.install) {
            runPnpmInstall(projectRoot);
        }
    }
});
program
    .command('set [dep]')
    .description('Update fields for an existing dependency')
    .option('-b, --dist-branch <branch>', 'Set dist branch')
    .option('-g, --global', 'Update global config')
    .option('-H, --github <repo>', 'Set GitHub repo (use "" to remove)')
    .option('-l, --local <path>', 'Set local path (use "" to remove)')
    .option('-L, --gitlab <repo>', 'Set GitLab repo (use "" to remove)')
    .option('-n, --npm <name>', 'Set NPM package name')
    .action((depQuery, options) => {
    const isGlobal = options.global;
    const projectRoot = isGlobal ? '' : findProjectRoot();
    const config = isGlobal ? loadGlobalConfig() : loadConfig(projectRoot);
    const [name, dep] = findMatchingDep(config, depQuery);
    if (!dep) {
        console.error(`Dependency not found: ${depQuery}`);
        process.exit(1);
    }
    let changed = false;
    if (options.local !== undefined) {
        if (options.local === '') {
            delete dep.localPath;
            console.log(`  Removed local path`);
        }
        else {
            const absPath = resolve(options.local);
            dep.localPath = isGlobal ? absPath : relative(projectRoot, absPath);
            console.log(`  Local path: ${dep.localPath}`);
        }
        changed = true;
    }
    if (options.github !== undefined) {
        if (options.github === '') {
            delete dep.github;
            console.log(`  Removed GitHub`);
        }
        else {
            dep.github = options.github;
            console.log(`  GitHub: ${options.github}`);
        }
        changed = true;
    }
    if (options.gitlab !== undefined) {
        if (options.gitlab === '') {
            delete dep.gitlab;
            console.log(`  Removed GitLab`);
        }
        else {
            dep.gitlab = options.gitlab;
            console.log(`  GitLab: ${options.gitlab}`);
        }
        changed = true;
    }
    if (options.npm !== undefined) {
        dep.npm = options.npm;
        console.log(`  NPM: ${options.npm}`);
        changed = true;
    }
    if (options.distBranch !== undefined) {
        dep.distBranch = options.distBranch;
        console.log(`  Dist branch: ${options.distBranch}`);
        changed = true;
    }
    if (!changed) {
        console.log(`No changes specified. Use -l, -H, -L, -n, or -b to update fields.`);
        return;
    }
    if (isGlobal) {
        saveGlobalConfig(config);
    }
    else {
        saveConfig(projectRoot, config);
    }
    console.log(`Updated ${name}`);
});
program
    .command('deinit [dep]')
    .aliases(['rm', 'remove'])
    .description('Remove a dependency from config')
    .option('-g, --global', 'Remove from global config')
    .action((depQuery, options) => {
    const isGlobal = options.global;
    const projectRoot = isGlobal ? '' : findProjectRoot();
    const config = isGlobal ? loadGlobalConfig() : loadConfig(projectRoot);
    const [name, depConfig] = findMatchingDep(config, depQuery);
    // Remove from config
    delete config.dependencies[name];
    if (!isGlobal) {
        // Clean up pnpm-workspace.yaml if the dep was in it
        if (depConfig.localPath) {
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
        }
        // Clean up vite.config.ts
        updateViteConfig(projectRoot, name, false);
    }
    if (isGlobal) {
        saveGlobalConfig(config);
    }
    else {
        saveConfig(projectRoot, config);
    }
    console.log(`Removed ${name} from ${isGlobal ? 'global ' : ''}config`);
});
program
    .command('list')
    .alias('ls')
    .description('List configured dependencies and their current sources')
    .option('-g, --global', 'List global dependencies')
    .action((options) => {
    if (options.global) {
        const config = loadGlobalConfig();
        if (Object.keys(config.dependencies).length === 0) {
            console.log('No global dependencies configured. Use "pds init -G <path>" to add one.');
            return;
        }
        for (const [name, dep] of Object.entries(config.dependencies)) {
            const installSource = getGlobalInstallSource(name);
            console.log(`${name}:`);
            console.log(`  Current: ${installSource ? `${installSource.source} (${installSource.specifier})` : '(not installed)'}`);
            console.log(`  Local: ${dep.localPath}`);
            if (dep.github)
                console.log(`  GitHub: ${dep.github}`);
            if (dep.gitlab)
                console.log(`  GitLab: ${dep.gitlab}`);
            if (dep.npm)
                console.log(`  NPM: ${dep.npm}`);
        }
        return;
    }
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
    .option('-g, --global', 'Install globally (uses global config)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((depQuery, options) => {
    if (options.global) {
        const config = loadGlobalConfig();
        const [depName, depConfig] = findMatchingDep(config, depQuery);
        runGlobalInstall(`file:${depConfig.localPath}`);
        console.log(`Installed ${depName} globally from local: ${depConfig.localPath}`);
        return;
    }
    const projectRoot = findProjectRoot();
    const config = loadConfig(projectRoot);
    const [depName, depConfig] = findMatchingDep(config, depQuery);
    if (!depConfig.localPath) {
        console.error(`No local path configured for ${depName}. Use "pds set ${depName} -l <path>" to set one.`);
        process.exit(1);
    }
    const absLocalPath = resolve(projectRoot, depConfig.localPath);
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
    console.log(`Switched ${depName} to local: ${absLocalPath}`);
    if (options.install) {
        runPnpmInstall(projectRoot);
    }
});
program
    .command('github [dep]')
    .aliases(['gh', 'g'])
    .description('Switch dependency to GitHub ref (defaults to dist branch HEAD)')
    .option('-g, --global', 'Install globally (uses global config)')
    .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
    .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((depQuery, options) => {
    const config = options.global ? loadGlobalConfig() : loadConfig(findProjectRoot());
    const [depName, depConfig] = findMatchingDep(config, depQuery);
    if (!depConfig.github) {
        throw new Error(`No GitHub repo configured for ${depName}. Use "pds init" with -G/--github`);
    }
    if (options.ref && options.rawRef) {
        throw new Error('Cannot use both -r/--ref and -R/--raw-ref');
    }
    const distBranch = depConfig.distBranch ?? 'dist';
    let resolvedRef;
    if (options.rawRef) {
        // Raw ref: use as-is
        resolvedRef = options.rawRef;
    }
    else if (options.ref) {
        // Ref provided: resolve to SHA
        resolvedRef = resolveGitHubRef(depConfig.github, options.ref);
    }
    else {
        // No ref provided: use dist branch, resolve to SHA
        resolvedRef = resolveGitHubRef(depConfig.github, distBranch);
    }
    const specifier = `github:${depConfig.github}#${resolvedRef}`;
    if (options.global) {
        runGlobalInstall(specifier);
        console.log(`Installed ${depName} globally from GitHub: ${depConfig.github}#${resolvedRef}`);
        return;
    }
    const projectRoot = findProjectRoot();
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
    .command('gitlab [dep]')
    .aliases(['gl'])
    .description('Switch dependency to GitLab ref (defaults to dist branch HEAD)')
    .option('-g, --global', 'Install globally (uses global config)')
    .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
    .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((depQuery, options) => {
    const config = options.global ? loadGlobalConfig() : loadConfig(findProjectRoot());
    const [depName, depConfig] = findMatchingDep(config, depQuery);
    if (!depConfig.gitlab) {
        throw new Error(`No GitLab repo configured for ${depName}. Use "pds init" with -l/--gitlab`);
    }
    if (options.ref && options.rawRef) {
        throw new Error('Cannot use both -r/--ref and -R/--raw-ref');
    }
    const distBranch = depConfig.distBranch ?? 'dist';
    let resolvedRef;
    if (options.rawRef) {
        // Raw ref: use as-is
        resolvedRef = options.rawRef;
    }
    else if (options.ref) {
        // Ref provided: resolve to SHA
        resolvedRef = resolveGitLabRef(depConfig.gitlab, options.ref);
    }
    else {
        // No ref provided: use dist branch, resolve to SHA
        resolvedRef = resolveGitLabRef(depConfig.gitlab, distBranch);
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
    const projectRoot = findProjectRoot();
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
    .option('-g, --global', 'Install globally (uses global config)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((arg1, arg2, options) => {
    const config = options.global ? loadGlobalConfig() : loadConfig(findProjectRoot());
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
    const projectRoot = findProjectRoot();
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
    .option('-g, --global', 'Show status of global dependencies')
    .action((depQuery, options) => {
    if (options.global) {
        const config = loadGlobalConfig();
        const deps = depQuery
            ? [findMatchingDep(config, depQuery)]
            : Object.entries(config.dependencies);
        for (const [name] of deps) {
            const installSource = getGlobalInstallSource(name);
            if (installSource) {
                console.log(`${name}: ${installSource.source} (${installSource.specifier})`);
            }
            else {
                console.log(`${name}: (not installed)`);
            }
        }
        return;
    }
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
    console.log(`pnpm-dep-source v${VERSION}`);
    if (binPath !== realPath) {
        console.log(`  binary: ${binPath} -> ${realPath}`);
    }
    else {
        console.log(`  binary: ${binPath}`);
    }
    // Determine source from the actual binary path first
    const pkgDir = realPath.includes('/dist/cli.js')
        ? realPath.replace(/\/dist\/cli\.js$/, '')
        : realPath.includes('/cli.js')
            ? realPath.replace(/\/cli\.js$/, '')
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
                console.log(`  source: local development`);
                return;
            }
            // Check if it's in pnpm global store
            if (realPath.includes('.pnpm')) {
                console.log(`  source: pnpm global (${version})`);
                return;
            }
            // Check if it's in node_modules
            if (realPath.includes('node_modules')) {
                console.log(`  source: npm (${version})`);
                return;
            }
            // Has package.json but not in node_modules or local dev
            console.log(`  source: ${version}`);
            return;
        }
        catch {
            // Fall through
        }
    }
    // Fallback: try pnpm global list
    const installSource = getGlobalInstallSource();
    if (installSource) {
        console.log(`  source: ${installSource.source} (${installSource.specifier})`);
        return;
    }
    console.log(`  source: unknown`);
});
program.parse();
//# sourceMappingURL=cli.js.map