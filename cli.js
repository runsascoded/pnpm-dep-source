#!/usr/bin/env node
import { program } from 'commander';
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { VERSION, resolveConfigPath, GLOBAL_HOOKS_DIR, HOOKS_CONFIG_FILE } from './constants.js';
import { findProjectRoot, findWorkspaceRoot, workspaceLocalPath } from './project.js';
import { loadConfig, saveConfig, loadGlobalConfig, saveGlobalConfig, findMatchingDep, loadHooksConfig, saveHooksConfig } from './config.js';
import { loadPackageJson, savePackageJson, removePnpmOverride, updatePackageJsonDep, hasDependency, addDependency, removeDependency, getCurrentSource, loadWorkspaceYaml, saveWorkspaceYaml, } from './pkg.js';
import { resolveGitHubRef, resolveGitLabRef, getLatestNpmVersion, npmPackageExists, getLocalPackageInfo, getRemotePackageInfo, isRepoUrl, getGlobalInstallSource, fetchAllGlobalInstallSourcesAsync, } from './remote.js';
import { getSourceType, displayDep, buildGlobalDepInfoAsync, buildProjectDepInfoAsync, fetchRemoteVersionsAsync } from './display.js';
import { updateViteConfig, makeGitHubSpecifier, switchToLocal, switchToGitHub, switchToGitLab, cleanupDepReferences, runPnpmInstall, runGlobalInstall, } from './switch.js';
program
    .name('pnpm-dep-source')
    .description('Switch pnpm dependencies between local, GitHub, and NPM sources')
    .version(VERSION)
    .option('-g, --global', 'Use global config (~/.config/pnpm-dep-source/) for CLI tools');
program
    .command('init [path-or-url]')
    .description('Initialize a dependency from local path or repo URL and activate it')
    .option('-b, --dist-branch <branch>', 'Git branch for dist builds', 'dist')
    .option('-D, --dev', 'Add as devDependency (if adding to package.json)')
    .option('-f, --force', 'Suppress mismatch warnings')
    .option('-H, --github <repo>', 'GitHub repo (e.g. "user/repo")')
    .option('-I, --no-install', 'Skip running pnpm install')
    .option('-L, --gitlab <repo>', 'GitLab repo (e.g. "user/repo")')
    .option('-l, --local <path>', 'Local path (when initializing from URL)')
    .option('-n, --npm <name>', 'NPM package name (defaults to name from package.json)')
    .action((pathOrUrl, options, cmd) => {
    if (!pathOrUrl) {
        cmd.help();
        return;
    }
    const isGlobal = program.opts().global;
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
    let npmName;
    if (options.npm !== undefined) {
        npmName = options.npm;
    }
    else if (pkgInfo.private) {
        npmName = undefined;
    }
    else if (npmPackageExists(pkgName)) {
        npmName = pkgName;
    }
    const github = options.github ?? pkgInfo.github;
    const gitlab = options.gitlab ?? pkgInfo.gitlab;
    const subdir = 'subdir' in pkgInfo ? pkgInfo.subdir : undefined;
    if (isGlobal) {
        const config = loadGlobalConfig();
        config.dependencies[pkgName] = {
            localPath,
            github,
            gitlab,
            npm: npmName,
            distBranch: options.distBranch,
            subdir,
        };
        saveGlobalConfig(config);
        console.log(`Initialized ${pkgName} (global):`);
        if (localPath)
            console.log(`  Local path: ${localPath}`);
        if (github)
            console.log(`  GitHub: ${github}`);
        if (gitlab)
            console.log(`  GitLab: ${gitlab}`);
        if (subdir)
            console.log(`  Subdir: ${subdir}`);
        if (npmName)
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
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    const config = loadConfig(projectRoot);
    const relLocalPath = localPath ? relative(projectRoot, localPath) : undefined;
    const depConfig = {
        localPath: relLocalPath,
        github,
        gitlab,
        npm: npmName,
        distBranch: options.distBranch,
        subdir,
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
    if (subdir)
        console.log(`  Subdir: ${subdir}`);
    if (npmName)
        console.log(`  NPM: ${npmName}`);
    console.log(`  Dist branch: ${options.distBranch}`);
    // Activate the dependency based on input type
    // If dep not in package.json, add it first
    const pkg = loadPackageJson(projectRoot);
    const needsAdd = !hasDependency(pkg, pkgName);
    if (needsAdd) {
        // Add a placeholder that will be replaced by the switch function
        addDependency(pkg, pkgName, '*', !!options.dev);
        savePackageJson(projectRoot, pkg);
        console.log(`Added ${pkgName} to ${options.dev ? 'devDependencies' : 'dependencies'}`);
    }
    if (activateSource === 'local' && relLocalPath) {
        switchToLocal(projectRoot, pkgName, relLocalPath, workspaceRoot);
        if (options.install) {
            runPnpmInstall(projectRoot, workspaceRoot);
        }
    }
    else if (activateSource === 'github' && github) {
        switchToGitHub(projectRoot, pkgName, depConfig, undefined, workspaceRoot);
        if (options.install) {
            runPnpmInstall(projectRoot, workspaceRoot);
        }
    }
    else if (activateSource === 'gitlab' && gitlab) {
        switchToGitLab(projectRoot, pkgName, depConfig, undefined, workspaceRoot);
        if (options.install) {
            runPnpmInstall(projectRoot, workspaceRoot);
        }
    }
    else if (needsAdd && (depConfig.npm || npmPackageExists(pkgName))) {
        // No activation source but we added the dep - use npm latest
        const npmPkgName = depConfig.npm ?? pkgName;
        const latestVersion = getLatestNpmVersion(npmPkgName);
        const pkgUpdated = loadPackageJson(projectRoot);
        updatePackageJsonDep(pkgUpdated, pkgName, `^${latestVersion}`);
        savePackageJson(projectRoot, pkgUpdated);
        console.log(`Set ${pkgName} to npm: ^${latestVersion}`);
        if (options.install) {
            runPnpmInstall(projectRoot, workspaceRoot);
        }
    }
});
program
    .command('set [dep]')
    .description('Update fields for an existing dependency')
    .option('-b, --dist-branch <branch>', 'Set dist branch')
    .option('-H, --github <repo>', 'Set GitHub repo (use "" to remove)')
    .option('-l, --local <path>', 'Set local path (use "" to remove)')
    .option('-L, --gitlab <repo>', 'Set GitLab repo (use "" to remove)')
    .option('-n, --npm <name>', 'Set NPM package name')
    .action((depQuery, options) => {
    const isGlobal = program.opts().global;
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
    .alias('di')
    .description('Stop tracking a dependency with pds (keeps in package.json)')
    .action((depQuery) => {
    const isGlobal = program.opts().global;
    const projectRoot = isGlobal ? '' : findProjectRoot();
    const workspaceRoot = isGlobal ? null : findWorkspaceRoot(projectRoot);
    const config = isGlobal ? loadGlobalConfig() : loadConfig(projectRoot);
    const [name, depConfig] = findMatchingDep(config, depQuery);
    // Remove from pds config
    delete config.dependencies[name];
    if (!isGlobal) {
        cleanupDepReferences(projectRoot, name, depConfig, workspaceRoot);
    }
    if (isGlobal) {
        saveGlobalConfig(config);
    }
    else {
        saveConfig(projectRoot, config);
    }
    console.log(`Stopped tracking ${name}${isGlobal ? ' (global)' : ''}`);
});
program
    .command('rm [dep]')
    .aliases(['r', 'remove'])
    .description('Remove a dependency from pds config and package.json')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((depQuery, options) => {
    const isGlobal = program.opts().global;
    const projectRoot = isGlobal ? '' : findProjectRoot();
    const workspaceRoot = isGlobal ? null : findWorkspaceRoot(projectRoot);
    const config = isGlobal ? loadGlobalConfig() : loadConfig(projectRoot);
    const [name, depConfig] = findMatchingDep(config, depQuery);
    // Remove from pds config
    delete config.dependencies[name];
    if (isGlobal) {
        saveGlobalConfig(config);
        // Uninstall globally
        console.log(`Removing ${name} globally...`);
        execSync(`pnpm rm -g ${depConfig.npm ?? name}`, { stdio: 'inherit' });
        console.log(`Removed ${name} (global)`);
    }
    else {
        cleanupDepReferences(projectRoot, name, depConfig, workspaceRoot);
        saveConfig(projectRoot, config);
        // Remove from package.json
        const pkg = loadPackageJson(projectRoot);
        if (removeDependency(pkg, name)) {
            savePackageJson(projectRoot, pkg);
            console.log(`Removed ${name} from package.json`);
        }
        if (options.install) {
            runPnpmInstall(projectRoot, workspaceRoot);
        }
    }
});
program
    .command('list')
    .alias('ls')
    .description('List configured dependencies and their current sources')
    .option('-a, --all', 'Show both project and global dependencies')
    .option('-v, --verbose', 'Show available remote versions')
    .action(async (options) => {
    await listDepsAsync(options.verbose ?? false, options.all);
});
// Helper for list/versions commands
async function listDepsAsync(verbose, all) {
    const isGlobal = program.opts().global;
    // Kick off global sources fetch early (if needed)
    const globalSourcesPromise = (isGlobal || all)
        ? fetchAllGlobalInstallSourcesAsync()
        : undefined;
    if (isGlobal && !all) {
        const config = loadGlobalConfig();
        if (Object.keys(config.dependencies).length === 0) {
            console.log('No global dependencies configured. Use "pds -g init <path>" to add one.');
            return;
        }
        const entries = Object.entries(config.dependencies);
        // Launch dep info builds and remote version fetches all concurrently
        const [infos, remoteVersions] = await Promise.all([
            globalSourcesPromise.then(sources => Promise.all(entries.map(([name, dep]) => buildGlobalDepInfoAsync(name, dep, sources)))),
            verbose
                ? Promise.all(entries.map(([name, dep]) => fetchRemoteVersionsAsync(dep, name)))
                : Promise.resolve([]),
        ]);
        const indexed = infos.map((info, i) => ({ info, versions: remoteVersions[i] }));
        indexed.sort((a, b) => a.info.name.localeCompare(b.info.name));
        for (const { info, versions } of indexed) {
            displayDep(info, verbose, versions);
        }
        return;
    }
    // Gather entries from project and global configs
    let projectRoot;
    let projectEntries = [];
    let pkg;
    if (!isGlobal) {
        projectRoot = findProjectRoot();
        const config = loadConfig(projectRoot);
        pkg = loadPackageJson(projectRoot);
        if (Object.keys(config.dependencies).length === 0 && !all) {
            console.log('No dependencies configured. Use "pds init <path>" to add one.');
            return;
        }
        projectEntries = Object.entries(config.dependencies);
    }
    let globalEntries = [];
    if (all) {
        const globalConfig = loadGlobalConfig();
        globalEntries = Object.entries(globalConfig.dependencies);
    }
    // Launch everything concurrently: dep info builds, global sources, and remote version fetches
    const [projectInfos, globalInfos, projectVersions, globalVersions] = await Promise.all([
        Promise.all(projectEntries.map(([name, dep]) => buildProjectDepInfoAsync(name, dep, projectRoot, pkg))),
        globalSourcesPromise
            ? globalSourcesPromise.then(sources => Promise.all(globalEntries.map(([name, dep]) => buildGlobalDepInfoAsync(name, dep, sources))))
            : Promise.resolve([]),
        verbose
            ? Promise.all(projectEntries.map(([name, dep]) => fetchRemoteVersionsAsync(dep, name)))
            : Promise.resolve([]),
        verbose
            ? Promise.all(globalEntries.map(([name, dep]) => fetchRemoteVersionsAsync(dep, name)))
            : Promise.resolve([]),
    ]);
    // Combine, alpha-sort, and display
    const allDeps = [
        ...projectInfos.map((info, i) => ({ info, versions: projectVersions[i] })),
        ...globalInfos.map((info, i) => ({ info, versions: globalVersions[i] })),
    ];
    allDeps.sort((a, b) => a.info.name.localeCompare(b.info.name));
    for (const { info, versions } of allDeps) {
        displayDep(info, verbose, versions);
    }
}
program
    .command('versions')
    .alias('v')
    .description('List dependencies with available remote versions (alias for ls -v)')
    .action(async () => {
    await listDepsAsync(true);
});
program
    .command('local [dep]')
    .alias('l')
    .description('Switch dependency to local directory')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((depQuery, options) => {
    if (program.opts().global) {
        const config = loadGlobalConfig();
        const [depName, depConfig] = findMatchingDep(config, depQuery);
        runGlobalInstall(`file:${depConfig.localPath}`);
        console.log(`Installed ${depName} globally from local: ${depConfig.localPath}`);
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
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
    const wsRoot = workspaceRoot ?? projectRoot;
    const ws = loadWorkspaceYaml(wsRoot) ?? { packages: workspaceRoot ? [] : ['.'] };
    if (!ws.packages)
        ws.packages = workspaceRoot ? [] : ['.'];
    if (!workspaceRoot && !ws.packages.includes('.'))
        ws.packages.unshift('.');
    const wsLocalPath = workspaceLocalPath(projectRoot, depConfig.localPath, workspaceRoot);
    if (!ws.packages.includes(wsLocalPath)) {
        ws.packages.push(wsLocalPath);
    }
    saveWorkspaceYaml(wsRoot, ws);
    // Update vite.config.ts
    updateViteConfig(projectRoot, depName, true);
    console.log(`Switched ${depName} to local: ${absLocalPath}`);
    if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
    }
});
program
    .command('github [dep]')
    .aliases(['gh'])
    .description('Switch dependency to GitHub ref (defaults to dist branch HEAD)')
    .option('-n, --dry-run', 'Show what would be installed without making changes')
    .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
    .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((depQuery, options) => {
    const isGlobal = program.opts().global;
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot());
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
    const specifier = makeGitHubSpecifier(depConfig.github, resolvedRef, depConfig.subdir);
    if (options.dryRun) {
        console.log(`Would switch ${depName} to: ${specifier}`);
        return;
    }
    if (isGlobal) {
        runGlobalInstall(specifier);
        console.log(`Installed ${depName} globally from GitHub: ${specifier}`);
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, specifier);
    removePnpmOverride(pkg, depName);
    savePackageJson(projectRoot, pkg);
    // Remove from pnpm-workspace.yaml
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
    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false);
    console.log(`Switched ${depName} to GitHub: ${depConfig.github}#${resolvedRef}`);
    if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
    }
});
program
    .command('gitlab [dep]')
    .aliases(['gl'])
    .description('Switch dependency to GitLab ref (defaults to dist branch HEAD)')
    .option('-n, --dry-run', 'Show what would be installed without making changes')
    .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
    .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((depQuery, options) => {
    const isGlobal = program.opts().global;
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot());
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
    if (options.dryRun) {
        console.log(`Would switch ${depName} to: ${tarballUrl}`);
        return;
    }
    if (isGlobal) {
        runGlobalInstall(tarballUrl);
        console.log(`Installed ${depName} globally from GitLab: ${depConfig.gitlab}@${resolvedRef}`);
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, tarballUrl);
    removePnpmOverride(pkg, depName);
    savePackageJson(projectRoot, pkg);
    // Remove from pnpm-workspace.yaml
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
    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false);
    console.log(`Switched ${depName} to GitLab: ${depConfig.gitlab}@${resolvedRef}`);
    if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
    }
});
program
    .command('git [dep]')
    .alias('g')
    .description('Switch dependency to GitHub or GitLab (auto-detects which is configured)')
    .option('-n, --dry-run', 'Show what would be installed without making changes')
    .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
    .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((depQuery, options) => {
    const isGlobal = program.opts().global;
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot());
    const [depName, depConfig] = findMatchingDep(config, depQuery);
    if (options.ref && options.rawRef) {
        throw new Error('Cannot use both -r/--ref and -R/--raw-ref');
    }
    const hasGitHub = !!depConfig.github;
    const hasGitLab = !!depConfig.gitlab;
    if (!hasGitHub && !hasGitLab) {
        throw new Error(`No GitHub or GitLab repo configured for ${depName}. Use "pds init" with -H or -L`);
    }
    if (hasGitHub && hasGitLab) {
        throw new Error(`Both GitHub and GitLab configured for ${depName}. Use "pds gh" or "pds gl" explicitly`);
    }
    const distBranch = depConfig.distBranch ?? 'dist';
    // Determine the ref to use
    let resolvedRef;
    if (options.rawRef) {
        resolvedRef = options.rawRef;
    }
    else if (options.ref) {
        // Resolve via the appropriate API
        resolvedRef = hasGitHub
            ? resolveGitHubRef(depConfig.github, options.ref)
            : resolveGitLabRef(depConfig.gitlab, options.ref);
    }
    // Resolve ref for dry-run or actual switch
    if (hasGitHub) {
        const ref = resolvedRef ?? resolveGitHubRef(depConfig.github, distBranch);
        const specifier = makeGitHubSpecifier(depConfig.github, ref, depConfig.subdir);
        if (options.dryRun) {
            console.log(`Would switch ${depName} to: ${specifier}`);
            return;
        }
        if (isGlobal) {
            runGlobalInstall(specifier);
            console.log(`Installed ${depName} globally from GitHub: ${specifier}`);
            return;
        }
        const projectRoot = findProjectRoot();
        const workspaceRoot = findWorkspaceRoot(projectRoot);
        switchToGitHub(projectRoot, depName, depConfig, ref, workspaceRoot);
        if (options.install) {
            runPnpmInstall(projectRoot, workspaceRoot);
        }
    }
    else {
        const ref = resolvedRef ?? resolveGitLabRef(depConfig.gitlab, distBranch);
        const repoBasename = depConfig.gitlab.split('/').pop();
        const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${ref}/${repoBasename}-${ref}.tar.gz`;
        if (options.dryRun) {
            console.log(`Would switch ${depName} to: ${tarballUrl}`);
            return;
        }
        if (isGlobal) {
            runGlobalInstall(tarballUrl);
            console.log(`Installed ${depName} globally from GitLab: ${depConfig.gitlab}@${ref}`);
            return;
        }
        const projectRoot = findProjectRoot();
        const workspaceRoot = findWorkspaceRoot(projectRoot);
        switchToGitLab(projectRoot, depName, depConfig, ref, workspaceRoot);
        if (options.install) {
            runPnpmInstall(projectRoot, workspaceRoot);
        }
    }
});
program
    .command('npm [dep] [version]')
    .alias('n')
    .description('Switch dependency to NPM (defaults to latest)')
    .option('-n, --dry-run', 'Show what would be installed without making changes')
    .option('-I, --no-install', 'Skip running pnpm install')
    .action((arg1, arg2, options) => {
    const isGlobal = program.opts().global;
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot());
    const deps = Object.entries(config.dependencies);
    // If only one arg and exactly one dep configured, decide whether it's a version or dep query.
    // Versions start with a digit; anything else is a dep query (substring match).
    let depQuery;
    let version;
    if (arg1 && !arg2 && deps.length === 1 && /^\d/.test(arg1)) {
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
    const specifier = `^${resolvedVersion}`;
    if (options.dryRun) {
        console.log(`Would switch ${depName} to: ${specifier}`);
        return;
    }
    if (isGlobal) {
        runGlobalInstall(`${npmName}@${resolvedVersion}`);
        console.log(`Installed ${depName} globally from NPM: ${npmName}@${resolvedVersion}`);
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    const pkg = loadPackageJson(projectRoot);
    updatePackageJsonDep(pkg, depName, specifier);
    removePnpmOverride(pkg, depName);
    savePackageJson(projectRoot, pkg);
    // Remove from pnpm-workspace.yaml
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
    // Remove from vite.config.ts optimizeDeps.exclude
    updateViteConfig(projectRoot, depName, false);
    console.log(`Switched ${depName} to NPM: ${specifier}`);
    if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
    }
});
program
    .command('status [dep]')
    .alias('s')
    .description('Show current source for dependency (or all if none specified)')
    .action((depQuery) => {
    if (program.opts().global) {
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
        const sourceType = getSourceType(current);
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
// Check if any pds-managed deps are set to local (workspace:*)
function checkLocalDeps(projectRoot) {
    const configPath = resolveConfigPath(projectRoot);
    if (!existsSync(configPath)) {
        return []; // No pds config, nothing to check
    }
    const config = loadConfig(projectRoot);
    const pkg = loadPackageJson(projectRoot);
    const localDeps = [];
    for (const name of Object.keys(config.dependencies)) {
        const source = getCurrentSource(pkg, name);
        if (source === 'workspace:*') {
            localDeps.push({ name, source });
        }
    }
    return localDeps;
}
function resolveCheckOn(projectConfig) {
    if (projectConfig.checkOn)
        return projectConfig.checkOn;
    if (projectConfig.skipCheck)
        return "none";
    const globalConfig = loadGlobalConfig();
    if (globalConfig.checkOn)
        return globalConfig.checkOn;
    return "pre-push";
}
program
    .command('check')
    .description('Check if any pds-managed deps are set to local (for git hooks)')
    .option('-q, --quiet', 'Exit with code only, no output')
    .option('--hook <type>', 'Hook type invoking this check (pre-push or pre-commit)')
    .action((options) => {
    let projectRoot;
    try {
        projectRoot = findProjectRoot();
    }
    catch {
        // Not in a JS project, nothing to check
        if (!options.quiet) {
            console.log('Not in a JS project, skipping check.');
        }
        return;
    }
    const config = loadConfig(projectRoot);
    const checkOn = resolveCheckOn(config);
    // When invoked from a hook, skip if this hook type shouldn't run the check
    if (options.hook) {
        if (checkOn === "none" || checkOn !== options.hook) {
            return;
        }
    }
    else {
        // Manual invocation: still respect checkOn: "none" / skipCheck
        if (checkOn === "none") {
            if (!options.quiet) {
                console.log('Check disabled for this project (checkOn: "none").');
            }
            return;
        }
    }
    const localDeps = checkLocalDeps(projectRoot);
    if (localDeps.length === 0) {
        if (!options.quiet) {
            console.log('No local dependencies found.');
        }
        return;
    }
    const verb = checkOn === "pre-commit" ? "committing" : "pushing";
    const bypass = checkOn === "pre-commit" ? "git commit --no-verify" : "git push --no-verify";
    if (!options.quiet) {
        console.error('Error: The following dependencies are set to local:');
        for (const { name } of localDeps) {
            console.error(`  - ${name}`);
        }
        console.error(`\nSwitch them before ${verb}:`);
        console.error('  pds gh <dep>   # Switch to GitHub');
        console.error('  pds gl <dep>   # Switch to GitLab');
        console.error('  pds npm <dep>  # Switch to NPM');
        console.error(`\nOr bypass with: ${bypass}`);
    }
    process.exit(1);
});
function generateHookScript(hookType, previousHooksPath) {
    const previousHooksSection = previousHooksPath
        ? `if [ -x "${previousHooksPath}/${hookType}" ]; then
  "${previousHooksPath}/${hookType}" || exit 1
fi`
        : '# (no previous core.hooksPath)';
    return `#!/bin/sh
# pds ${hookType} hook - checks for local dependencies
# Installed by: pds hooks install

# 1. Run pds check
if command -v pds >/dev/null 2>&1; then
  pds check --hook ${hookType} || exit 1
else
  echo "Warning: pds not found in PATH, skipping local dependency check"
fi

# 2. Chain to previous global hooks (if any were configured before pds)
${previousHooksSection}

# 3. Chain to local .git/hooks (which Git ignores when core.hooksPath is set)
if [ -x .git/hooks/${hookType} ]; then
  .git/hooks/${hookType} || exit 1
fi
`;
}
const hooks = program
    .command('hooks')
    .description('Manage git hooks for pds');
hooks
    .command('install')
    .description('Install global git hooks for pds (pre-push and pre-commit)')
    .option('-f, --force', 'Overwrite existing core.hooksPath')
    .action((options) => {
    // Check if core.hooksPath is already set
    const existingPath = spawnSync('git', ['config', '--global', 'core.hooksPath'], {
        encoding: 'utf-8',
    });
    const currentHooksPath = existingPath.stdout.trim();
    let previousHooksPath;
    if (currentHooksPath && currentHooksPath !== GLOBAL_HOOKS_DIR) {
        if (!options.force) {
            console.error(`Error: core.hooksPath is already set to: ${currentHooksPath}`);
            console.error('Use --force to chain to existing hooks.');
            process.exit(1);
        }
        // Save the previous path so we can chain to it
        previousHooksPath = currentHooksPath;
        console.log(`Chaining to existing hooks: ${currentHooksPath}`);
    }
    // Create hooks directory
    if (!existsSync(GLOBAL_HOOKS_DIR)) {
        mkdirSync(GLOBAL_HOOKS_DIR, { recursive: true });
    }
    // Save hooks config (previous path for chaining and uninstall)
    const hooksConfig = {};
    if (previousHooksPath) {
        hooksConfig.previousHooksPath = previousHooksPath;
    }
    saveHooksConfig(hooksConfig);
    // Write both hook scripts
    for (const hookType of ['pre-push', 'pre-commit']) {
        const hookPath = join(GLOBAL_HOOKS_DIR, hookType);
        writeFileSync(hookPath, generateHookScript(hookType, previousHooksPath));
        execSync(`chmod +x "${hookPath}"`);
    }
    // Set global core.hooksPath
    execSync(`git config --global core.hooksPath "${GLOBAL_HOOKS_DIR}"`);
    console.log('Installed global git hooks (pre-push + pre-commit).');
    console.log(`  Hooks directory: ${GLOBAL_HOOKS_DIR}`);
    console.log(`  Default check runs on: pre-push`);
    console.log(`  Per-project override: set "checkOn" in .pds.json`);
    if (previousHooksPath) {
        console.log(`  Chaining to: ${previousHooksPath}`);
    }
    console.log('  Also chains to local .git/hooks/ if present');
});
hooks
    .command('uninstall')
    .description('Remove global git hooks for pds')
    .action(() => {
    // Check if our hooks are installed
    const existingPath = spawnSync('git', ['config', '--global', 'core.hooksPath'], {
        encoding: 'utf-8',
    });
    const currentHooksPath = existingPath.stdout.trim();
    if (currentHooksPath !== GLOBAL_HOOKS_DIR) {
        if (currentHooksPath) {
            console.log(`core.hooksPath is set to a different directory: ${currentHooksPath}`);
            console.log('Not modifying.');
        }
        else {
            console.log('No global hooks path configured.');
        }
        return;
    }
    // Load hooks config to check for previous path
    const hooksConfig = loadHooksConfig();
    // Restore previous core.hooksPath or unset
    if (hooksConfig.previousHooksPath) {
        execSync(`git config --global core.hooksPath "${hooksConfig.previousHooksPath}"`);
        console.log(`Restored previous core.hooksPath: ${hooksConfig.previousHooksPath}`);
    }
    else {
        execSync('git config --global --unset core.hooksPath');
        console.log('Unset core.hooksPath');
    }
    // Remove both hook files
    for (const hookType of ['pre-push', 'pre-commit']) {
        const hookPath = join(GLOBAL_HOOKS_DIR, hookType);
        if (existsSync(hookPath)) {
            execSync(`rm "${hookPath}"`);
        }
    }
    // Remove hooks config
    if (existsSync(HOOKS_CONFIG_FILE)) {
        execSync(`rm "${HOOKS_CONFIG_FILE}"`);
    }
    console.log('Removed pds hooks.');
});
hooks
    .command('status')
    .description('Show hooks installation status')
    .action(() => {
    const existingPath = spawnSync('git', ['config', '--global', 'core.hooksPath'], {
        encoding: 'utf-8',
    });
    const currentHooksPath = existingPath.stdout.trim();
    if (!currentHooksPath) {
        console.log('Status: Not installed');
        console.log('  No global core.hooksPath configured');
        return;
    }
    if (currentHooksPath === GLOBAL_HOOKS_DIR) {
        const hooksConfig = loadHooksConfig();
        console.log('Status: Installed');
        console.log(`  core.hooksPath: ${currentHooksPath}`);
        for (const hookType of ['pre-push', 'pre-commit']) {
            const hookPath = join(GLOBAL_HOOKS_DIR, hookType);
            console.log(`  ${hookType} hook: ${existsSync(hookPath) ? 'present' : 'missing'}`);
        }
        if (hooksConfig.previousHooksPath) {
            console.log(`  chaining to: ${hooksConfig.previousHooksPath}`);
        }
        console.log('  chains to local .git/hooks/ if present');
    }
    else {
        console.log('Status: Different hooks path configured');
        console.log(`  core.hooksPath: ${currentHooksPath}`);
        console.log(`  (not managed by pds)`);
    }
});
const SHELL_ALIASES = `# pds shell aliases
# Add to your shell rc file: eval "$(pds shell-integration)"

alias pdg='pds -g'     # global mode (pdg ls, pdg gh, etc.)
alias pdgg='pds -g g'     # global git (auto-detect GitHub/GitLab)
alias pdgi='pds -g init'  # global init
alias pdsg='pds g'     # git (auto-detect GitHub/GitLab)
alias pdi='pds init'   # init
alias pdid='pds init -D'  # init as devDependency
alias pdsi='pds init'  # init (alt)
alias pdl='pds ls'     # list
alias pdla='pds ls -a' # list all (project + global)
alias pdlv='pds ls -v'    # list with versions
alias pdlav='pds ls -av'  # list all with versions
alias pdlg='pds -g ls'   # global list
alias pdav='pds ls -av'   # list all with versions (alt)
alias pdgv='pds -g ls -v' # global list with versions
alias pdsl='pds l'     # local
alias pdgh='pds gh'    # github
alias pdgl='pds gl'    # gitlab
alias pdsn='pds n'     # npm
alias pdsv='pds v'     # versions
alias pdss='pds s'     # status
alias pdsc='pds check' # check for local deps
alias pddi='pds di'    # deinit (stop tracking, keep in package.json)
alias pdr='pds rm'     # remove (from pds config and package.json)
alias pdgr='pds -g rm' # global remove
`;
program
    .command('shell-integration')
    .alias('shell')
    .description('Output shell aliases for eval (add to .bashrc/.zshrc)')
    .action(() => {
    console.log(SHELL_ALIASES);
});
// Default to 'list' if deps configured, otherwise show help
// Also handle `pds -g` as shorthand for `pds -g ls`
const hasOnlyGlobalFlag = process.argv.length === 3 && (process.argv[2] === '-g' || process.argv[2] === '--global');
if (process.argv.length <= 2 || hasOnlyGlobalFlag) {
    // Check if there are any deps configured
    const isGlobal = hasOnlyGlobalFlag;
    try {
        if (isGlobal) {
            const config = loadGlobalConfig();
            if (Object.keys(config.dependencies).length > 0) {
                process.argv.push('list');
            }
            else {
                process.argv.push('--help');
            }
        }
        else {
            const projectRoot = findProjectRoot();
            const config = loadConfig(projectRoot);
            if (Object.keys(config.dependencies).length > 0) {
                process.argv.push('list');
            }
            else {
                process.argv.push('--help');
            }
        }
    }
    catch {
        // Not in a project or error - show help
        process.argv.push('--help');
    }
}
try {
    await program.parseAsync();
}
catch (err) {
    if (err instanceof Error) {
        console.error(`Error: ${err.message}`);
    }
    else {
        console.error('An unknown error occurred');
    }
    process.exit(1);
}
//# sourceMappingURL=cli.js.map