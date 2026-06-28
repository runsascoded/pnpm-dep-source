#!/usr/bin/env node
import { program } from 'commander';
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { VERSION, resolveConfigPath, GLOBAL_HOOKS_DIR, HOOKS_CONFIG_FILE, c } from './constants.js';
import { findProjectRoot, findWorkspaceRoot } from './project.js';
import { loadConfig, saveConfig, loadGlobalConfig, saveGlobalConfig, findMatchingDep, findAllMatchingDeps, loadHooksConfig, saveHooksConfig } from './config.js';
import { loadPackageJson, savePackageJson, updatePackageJsonDep, hasDependency, addDependency, removeDependency, getCurrentSource, getCommittedPackageJson, getInstalledVersion, getGlobalInstalledVersion, } from './pkg.js';
import { resolveGitHubRef, resolveGitLabRef, getLatestNpmVersion, npmPackageExists, getLocalPackageInfo, getRemotePackageInfo, isRepoUrl, getGlobalInstallSource, fetchAllGlobalInstallSourcesAsync, pkgPrNewBuildExists, isMissingRef, } from './remote.js';
import { getSourceType, displayDep, buildGlobalDepInfoAsync, buildProjectDepInfoAsync, fetchRemoteVersionsAsync } from './display.js';
import { detectFleet } from './fleet.js';
import { setLogLevel, setRetries } from './log.js';
import { makeGitHubSpecifier, makePkgPrNewSpecifier, switchToLocal, switchToGitHub, switchToGitLab, switchToPkgPrNew, switchToNpm, cleanupDepReferences, runPnpmInstall, runGlobalInstall, } from './switch.js';
// Iterate `items`, invoking `fn` on each. On error, abort (default) or
// continue collecting failures (`keepGoing`). After iteration, if any
// failures were collected, exit non-zero.
function runMultiple(items, keepGoing, fn) {
    const failures = [];
    for (const item of items) {
        try {
            fn(item);
        }
        catch (err) {
            if (!keepGoing)
                throw err;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`${c.red}Error:${c.reset} ${msg}`);
            failures.push({ item, error: err });
        }
    }
    if (failures.length > 0) {
        console.error(`${c.red}${failures.length} of ${items.length} failed${c.reset}`);
        process.exit(1);
    }
}
// Resolve dep queries into the concrete [name, config] pairs to operate on.
// Default: each query resolves to exactly one dep (errors if zero/ambiguous).
// With `all`: each query is a regex matching ALL deps (union, deduped, config
// order); a bare invocation (no query) selects every configured dep.
function resolveDepItems(config, queries, all) {
    if (!all) {
        return queries.map(q => findMatchingDep(config, q));
    }
    const patterns = queries.filter((q) => q !== undefined);
    if (patterns.length === 0) {
        const entries = Object.entries(config.dependencies);
        if (entries.length === 0) {
            throw new Error('No dependencies configured. Use "pds init <path>" to add one.');
        }
        return entries;
    }
    const seen = new Set();
    const out = [];
    for (const pattern of patterns) {
        for (const [name, dep] of findAllMatchingDeps(config, pattern)) {
            if (!seen.has(name)) {
                seen.add(name);
                out.push([name, dep]);
            }
        }
    }
    return out;
}
// Warn-only build-existence check for pkg.pr.new: a build URL only resolves once
// CI has published that SHA. HEAD each (concurrently) and warn on 404. Skipped on
// dry-run (nothing was switched).
async function warnMissingBuilds(built, dryRun) {
    if (dryRun || built.length === 0)
        return;
    await Promise.all(built.map(async ({ depName, url }) => {
        if (!(await pkgPrNewBuildExists(url))) {
            console.error(`${c.yellow}Warning: no published pkg.pr.new build for ${depName} at ${url} yet; CI may still be running${c.reset}`);
        }
    }));
}
program
    .name('pnpm-dep-source')
    .description('Switch pnpm dependencies between local, GitHub, GitLab, pkg.pr.new, and NPM sources')
    .version(VERSION)
    .option('-C, --dir <path>', 'Run as if started in <path> (like git -C)')
    .option('-g, --global', 'Use global config (~/.config/pnpm-dep-source/) for CLI tools')
    .hook('preAction', () => {
    const dir = program.opts().dir;
    if (dir)
        process.chdir(resolve(dir));
    // Apply config-based log level and retries (env vars take precedence, handled inside)
    try {
        const cfg = program.opts().global ? loadGlobalConfig() : loadConfig(findProjectRoot());
        if (cfg.logLevel)
            setLogLevel(cfg.logLevel);
        if (cfg.retries !== undefined)
            setRetries(cfg.retries);
    }
    catch { }
});
// Probe the configured repo's dist branch once, at init, to record the dep's
// "style": a repo with no dist branch (e.g. a fork that ships via pkg.pr.new)
// isn't installable via gh/gl/git tarball mode, so we mark `noDist` and drop the
// (now-meaningless) `distBranch`. Returns the dist-related config fields to spread
// onto the dep. Transient/unknown failures fall through to the default (no mark),
// leaving the live verbose probe to decide later.
function detectDistStyle(github, gitlab, distBranch) {
    const repo = github ?? gitlab;
    if (!repo)
        return { distBranch };
    try {
        if (github)
            resolveGitHubRef(github, distBranch);
        else
            resolveGitLabRef(gitlab, distBranch);
        return { distBranch };
    }
    catch (err) {
        if (isMissingRef(err instanceof Error ? err.message : String(err))) {
            console.log(`  No '${distBranch}' branch on ${repo}; marking noDist (gh/gl tarball mode unavailable)`);
            return { noDist: true };
        }
        return { distBranch };
    }
}
// Per-arg init logic. Returns true when a project-mode install is needed (a
// project dep was activated). The trailing `pnpm install` is fired once by
// the outer loop, not per-call.
function initOne(pathOrUrl, options, isGlobal, projectRoot, workspaceRoot) {
    const isUrl = isRepoUrl(pathOrUrl);
    let pkgInfo;
    let localPath;
    let activateSource;
    if (isUrl) {
        pkgInfo = getRemotePackageInfo(pathOrUrl);
        localPath = options.local ? resolve(options.local) : undefined;
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
        localPath = resolve(pathOrUrl);
        pkgInfo = getLocalPackageInfo(localPath);
        activateSource = 'local';
    }
    // --source flag overrides the default activation source (resolve 'g'/'git' after config is built)
    let sourceFlag;
    if (options.source) {
        const s = options.source.toLowerCase();
        if (s === 'local' || s === 'l')
            activateSource = 'local';
        else if (s === 'github' || s === 'gh')
            activateSource = 'github';
        else if (s === 'gitlab' || s === 'gl')
            activateSource = 'gitlab';
        else if (s === 'git' || s === 'g')
            sourceFlag = 'git';
        else if (s === 'cr' || s === 'pkg-pr-new')
            activateSource = 'cr';
        else if (s === 'npm' || s === 'n')
            activateSource = 'npm';
        else
            throw new Error(`Unknown --source value: '${options.source}'. Use: local, github/gh, git/g, gitlab/gl, cr/pkg-pr-new, npm`);
    }
    const pkgName = pkgInfo.name;
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
    if (sourceFlag === 'git') {
        if (github && gitlab) {
            throw new Error(`Both GitHub and GitLab configured for ${pkgName}. Use -s gh or -s gl explicitly.`);
        }
        else if (github) {
            activateSource = 'github';
        }
        else if (gitlab) {
            activateSource = 'gitlab';
        }
        else {
            throw new Error(`No GitHub or GitLab repo configured for ${pkgName}. Use -H or -L to specify one.`);
        }
    }
    const distStyle = detectDistStyle(github, gitlab, options.distBranch);
    if (isGlobal) {
        const config = loadGlobalConfig();
        config.dependencies[pkgName] = {
            localPath,
            github,
            gitlab,
            npm: npmName,
            ...distStyle,
            subdir,
            override: options.override || undefined,
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
        if (distStyle.distBranch)
            console.log(`  Dist branch: ${distStyle.distBranch}`);
        if (localPath) {
            // link: (live symlink) rather than file: (copy), so a global install of a
            // dep under active development reflects rebuilds without reinstalling.
            runGlobalInstall(`link:${localPath}`);
            console.log(`Installed ${pkgName} globally from local: ${localPath}`);
        }
        return false;
    }
    const config = loadConfig(projectRoot);
    const relLocalPath = localPath ? relative(projectRoot, localPath) : undefined;
    const depConfig = {
        localPath: relLocalPath,
        github,
        gitlab,
        npm: npmName,
        ...distStyle,
        subdir,
        override: options.override || undefined,
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
    if (distStyle.distBranch)
        console.log(`  Dist branch: ${distStyle.distBranch}`);
    const pkg = loadPackageJson(projectRoot);
    const needsAdd = !hasDependency(pkg, pkgName);
    if (needsAdd) {
        addDependency(pkg, pkgName, '*', !!options.dev);
        savePackageJson(projectRoot, pkg);
        console.log(`Added ${pkgName} to ${options.dev ? 'devDependencies' : 'dependencies'}`);
    }
    else if (options.dev) {
        const deps = pkg.dependencies;
        if (deps && pkgName in deps) {
            const specifier = deps[pkgName];
            delete deps[pkgName];
            addDependency(pkg, pkgName, specifier, true);
            savePackageJson(projectRoot, pkg);
            console.log(`Moved ${pkgName} to devDependencies`);
        }
    }
    if (activateSource === 'local' && relLocalPath) {
        switchToLocal(projectRoot, pkgName, depConfig, workspaceRoot);
        return true;
    }
    else if (activateSource === 'github') {
        if (!github)
            throw new Error(`No GitHub repo configured for ${pkgName}. Use -H/--github to specify one.`);
        switchToGitHub(projectRoot, pkgName, depConfig, options.rawRef, workspaceRoot);
        return true;
    }
    else if (activateSource === 'gitlab') {
        if (!gitlab)
            throw new Error(`No GitLab repo configured for ${pkgName}. Use -L/--gitlab to specify one.`);
        switchToGitLab(projectRoot, pkgName, depConfig, options.rawRef, workspaceRoot);
        return true;
    }
    else if (activateSource === 'cr') {
        if (!github)
            throw new Error(`No GitHub repo configured for ${pkgName}. Use -H/--github to specify one.`);
        if (!npmName)
            throw new Error(`No npm package name configured for ${pkgName}. Use -n/--npm to specify one.`);
        const sha = options.rawRef ?? resolveGitHubRef(github, 'HEAD');
        switchToPkgPrNew(projectRoot, pkgName, depConfig, sha, workspaceRoot);
        return true;
    }
    else if (activateSource === 'npm' || (needsAdd && !activateSource && (depConfig.npm || npmPackageExists(pkgName)))) {
        const npmPkgName = depConfig.npm ?? pkgName;
        const latestVersion = getLatestNpmVersion(npmPkgName);
        const pkgUpdated = loadPackageJson(projectRoot);
        updatePackageJsonDep(pkgUpdated, pkgName, `^${latestVersion}`);
        savePackageJson(projectRoot, pkgUpdated);
        console.log(`Set ${pkgName} to npm: ^${latestVersion}`);
        return true;
    }
    return false;
}
// Resolve the post-init activation source from -s/--source (default local).
function resolveActivateSource(source, pick) {
    if (!source)
        return 'local';
    const s = source.toLowerCase();
    if (s === 'local' || s === 'l')
        return 'local';
    if (s === 'github' || s === 'gh')
        return 'github';
    if (s === 'gitlab' || s === 'gl')
        return 'gitlab';
    if (s === 'cr' || s === 'pkg-pr-new')
        return 'cr';
    if (s === 'npm' || s === 'n')
        return 'npm';
    if (s === 'git' || s === 'g')
        return 'git';
    throw new Error(`Unknown --source value: '${source}'. Use: local, github/gh, git/g, gitlab/gl, cr/pkg-pr-new, npm`);
}
// Register a detected monorepo fleet (hint-file- or auto-detected) as a set of
// pds-managed deps and activate them. Members are managed as a unit (override
// strategy by default), so the consumer can `pds [l|cr] <repo> -a` afterward.
// Returns true (always a mutation when there are members).
function registerFleet(fleet, options, projectRoot, workspaceRoot) {
    const config = loadConfig(projectRoot);
    const useOverride = fleet.strategy === 'override' || !!options.override;
    const requested = resolveActivateSource(options.source, () => 'github');
    for (const m of fleet.members) {
        config.dependencies[m.npm] = {
            localPath: relative(projectRoot, m.localPath),
            github: m.github,
            gitlab: m.gitlab,
            npm: m.npm,
            ...detectDistStyle(m.github, m.gitlab, options.distBranch),
            subdir: m.subdir,
            override: useOverride || undefined,
        };
    }
    saveConfig(projectRoot, config);
    console.log(`Initialized fleet (${fleet.members.length} package${fleet.members.length === 1 ? '' : 's'}, ${useOverride ? 'override' : 'default'} strategy${fleet.fromHint ? ', from hint file' : ', auto-detected'}):`);
    for (const m of fleet.members) {
        console.log(`  ${m.npm}${m.subdir ? ` ${c.cyan}[${m.subdir}]${c.reset}` : ''}`);
    }
    for (const m of fleet.members) {
        const depConfig = config.dependencies[m.npm];
        let source = requested;
        if (source === 'git') {
            if (depConfig.github && depConfig.gitlab)
                throw new Error(`Both GitHub and GitLab configured for ${m.npm}. Use -s gh or -s gl explicitly.`);
            source = depConfig.github ? 'github' : 'gitlab';
        }
        switch (source) {
            case 'local':
                switchToLocal(projectRoot, m.npm, depConfig, workspaceRoot);
                break;
            case 'github':
                switchToGitHub(projectRoot, m.npm, depConfig, options.rawRef, workspaceRoot);
                break;
            case 'gitlab':
                switchToGitLab(projectRoot, m.npm, depConfig, options.rawRef, workspaceRoot);
                break;
            case 'cr': {
                if (!depConfig.github)
                    throw new Error(`No GitHub repo configured for ${m.npm}`);
                if (!depConfig.npm)
                    throw new Error(`No npm package name configured for ${m.npm}`);
                const sha = options.rawRef ?? resolveGitHubRef(depConfig.github, 'HEAD');
                switchToPkgPrNew(projectRoot, m.npm, depConfig, sha, workspaceRoot);
                break;
            }
            case 'npm': {
                const latest = getLatestNpmVersion(depConfig.npm ?? m.npm);
                switchToNpm(projectRoot, m.npm, depConfig, `^${latest}`, workspaceRoot);
                break;
            }
        }
    }
    return true;
}
program
    .command('init [paths-or-urls...]')
    .description('Initialize (or reinitialize) one or more dependencies from local paths or repo URLs and activate them. A local path that is a monorepo root (a pds.json/package.json#pds hint file, or a pnpm/npm workspace) expands to its whole fleet, managed via pnpm.overrides. Re-running init on an existing dep refreshes its config from the local package.json.')
    .option('-b, --dist-branch <branch>', 'Git branch for dist builds', 'dist')
    .option('-D, --dev', 'Add as devDependency (if adding to package.json)')
    .option('-f, --force', 'Suppress mismatch warnings')
    .option('-H, --github <repo>', 'GitHub repo (e.g. "user/repo")')
    .option('-I, --no-install', 'Skip running pnpm install')
    .option('-k, --keep-going', 'Continue past per-dep failures (default: stop on first error)')
    .option('-L, --gitlab <repo>', 'GitLab repo (e.g. "user/repo")')
    .option('-l, --local <path>', 'Local path (when initializing from URL)')
    .option('-n, --npm <name>', 'NPM package name (defaults to name from package.json)')
    .option('-o, --override', 'Manage via pnpm.overrides (forces the whole graph, incl. transitive monorepo siblings) instead of rewriting the package.json dep spec')
    .option('-R, --raw-ref <ref>', 'Git ref for GitHub/GitLab activation (used as-is, e.g. branch name)')
    .option('-s, --source <source>', 'Activate source after init: local, github/gh, gitlab/gl, cr/pkg-pr-new, npm (default: local for path, inferred for URL)')
    .action((pathsOrUrls, options, cmd) => {
    if (pathsOrUrls.length === 0) {
        cmd.help();
        return;
    }
    const isGlobal = program.opts().global;
    const projectRoot = isGlobal ? undefined : findProjectRoot();
    const workspaceRoot = isGlobal ? undefined : findWorkspaceRoot(projectRoot);
    let anyMutation = false;
    runMultiple(pathsOrUrls, !!options.keepGoing, pathOrUrl => {
        // A local path that is a monorepo root (hint file or workspace) expands to
        // its fleet, so `pds init <repo>` registers the whole set in one shot.
        if (!isGlobal && !isRepoUrl(pathOrUrl)) {
            const fleet = detectFleet(resolve(pathOrUrl));
            if (fleet) {
                if (registerFleet(fleet, options, projectRoot, workspaceRoot))
                    anyMutation = true;
                return;
            }
        }
        if (initOne(pathOrUrl, options, isGlobal, projectRoot, workspaceRoot)) {
            anyMutation = true;
        }
    });
    if (!isGlobal && anyMutation && options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
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
    .option('-o, --override', 'Manage via pnpm.overrides (forces the whole graph, incl. transitive monorepo siblings)')
    .option('-O, --no-override', 'Stop managing via pnpm.overrides')
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
    if (options.override !== undefined) {
        if (options.override) {
            dep.override = true;
            console.log(`  Override: pnpm.overrides`);
        }
        else {
            delete dep.override;
            console.log(`  Override: off`);
        }
        changed = true;
    }
    if (!changed) {
        console.log(`No changes specified. Use -l, -H, -L, -n, -b, or -o/-O to update fields.`);
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
    .command('list [filters...]')
    .alias('ls')
    .description('List configured dependencies and their current sources')
    .option('-a, --all', 'Show both project and global dependencies')
    .option('-s, --source <type>', 'Filter by active source type (local, github/gh, gitlab/gl, cr/pkg-pr-new, npm)')
    .option('-v, --verbose', 'Show available remote versions')
    .action(async (filters, options) => {
    await listDepsAsync(options.verbose ?? false, options.all, filters.length ? filters : undefined, options.source);
});
// pnpm.overrides live at the workspace root; load that map (override-managed
// deps surface their active source from it, not the package.json dep spec).
function loadOverrides(projectRoot, projectPkg) {
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    const pkg = workspaceRoot && workspaceRoot !== projectRoot ? loadPackageJson(workspaceRoot) : projectPkg;
    const pnpm = pkg.pnpm;
    return pnpm?.overrides ?? {};
}
function filterEntries(entries, filters) {
    if (!filters)
        return entries;
    return entries.filter(([name]) => filters.some(f => name.toLowerCase().includes(f.toLowerCase())));
}
function normalizeSourceFilter(s) {
    const lower = s.toLowerCase();
    if (lower === 'local' || lower === 'l')
        return 'local';
    if (lower === 'github' || lower === 'gh')
        return 'github';
    if (lower === 'gitlab' || lower === 'gl')
        return 'gitlab';
    if (lower === 'cr' || lower === 'pkg-pr-new')
        return 'cr';
    if (lower === 'npm' || lower === 'n')
        return 'npm';
    return undefined;
}
// Helper for list/versions commands
async function listDepsAsync(verbose, all, filters, sourceFilter) {
    const sourceType = sourceFilter ? normalizeSourceFilter(sourceFilter) : undefined;
    if (sourceFilter && !sourceType) {
        console.error(`Unknown source type: ${sourceFilter}. Use: local, github/gh, gitlab/gl, cr/pkg-pr-new, npm`);
        process.exit(1);
    }
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
        const entries = filterEntries(Object.entries(config.dependencies), filters);
        // Launch dep info builds and remote version fetches all concurrently
        const [infos, remoteVersions] = await Promise.all([
            globalSourcesPromise.then(sources => Promise.all(entries.map(([name, dep]) => buildGlobalDepInfoAsync(name, dep, sources)))),
            verbose
                ? Promise.all(entries.map(([name, dep]) => fetchRemoteVersionsAsync(dep, name, dep.localPath, getGlobalInstalledVersion(name) ?? undefined)))
                : Promise.resolve([]),
        ]);
        let indexed = infos.map((info, i) => ({ info, versions: remoteVersions[i] }));
        if (sourceType)
            indexed = indexed.filter(d => d.info.sourceType === sourceType);
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
    let overrides = {};
    if (!isGlobal) {
        projectRoot = findProjectRoot();
        const config = loadConfig(projectRoot);
        pkg = loadPackageJson(projectRoot);
        overrides = loadOverrides(projectRoot, pkg);
        if (Object.keys(config.dependencies).length === 0 && !all) {
            console.log('No dependencies configured. Use "pds init <path>" to add one.');
            return;
        }
        projectEntries = filterEntries(Object.entries(config.dependencies), filters);
    }
    let globalEntries = [];
    if (all) {
        const globalConfig = loadGlobalConfig();
        globalEntries = filterEntries(Object.entries(globalConfig.dependencies), filters);
    }
    // Launch everything concurrently: dep info builds, global sources, and remote version fetches
    const [projectInfos, globalInfos, projectVersions, globalVersions] = await Promise.all([
        Promise.all(projectEntries.map(([name, dep]) => buildProjectDepInfoAsync(name, dep, projectRoot, pkg, overrides))),
        globalSourcesPromise
            ? globalSourcesPromise.then(sources => Promise.all(globalEntries.map(([name, dep]) => buildGlobalDepInfoAsync(name, dep, sources))))
            : Promise.resolve([]),
        verbose
            ? (() => {
                const committedPkg = getCommittedPackageJson(projectRoot);
                return Promise.all(projectEntries.map(([name, dep]) => {
                    const currentSrc = getCurrentSource(pkg, name);
                    const committedSrc = committedPkg ? getCurrentSource(committedPkg, name) : undefined;
                    const cs = committedSrc && committedSrc !== currentSrc && committedSrc !== '(not found)'
                        ? committedSrc : undefined;
                    return fetchRemoteVersionsAsync(dep, name, dep.localPath ? resolve(projectRoot, dep.localPath) : undefined, getInstalledVersion(projectRoot, name) ?? undefined, cs);
                }));
            })()
            : Promise.resolve([]),
        verbose
            ? Promise.all(globalEntries.map(([name, dep]) => fetchRemoteVersionsAsync(dep, name, dep.localPath, getGlobalInstalledVersion(name) ?? undefined)))
            : Promise.resolve([]),
    ]);
    // Display globals first, then project deps, then project devDeps (alpha-sorted within each group)
    const srcFilter = (d) => !sourceType || d.info.sourceType === sourceType;
    const globalDeps = globalInfos.map((info, i) => ({ info, versions: globalVersions[i] })).filter(srcFilter);
    const projectRegular = projectInfos
        .map((info, i) => ({ info, versions: projectVersions[i] }))
        .filter(d => !d.info.isDev)
        .filter(srcFilter);
    const projectDev = projectInfos
        .map((info, i) => ({ info, versions: projectVersions[i] }))
        .filter(d => d.info.isDev)
        .filter(srcFilter);
    const cmp = (a, b) => a.info.name.localeCompare(b.info.name);
    globalDeps.sort(cmp);
    projectRegular.sort(cmp);
    projectDev.sort(cmp);
    for (const { info, versions } of [...globalDeps, ...projectRegular, ...projectDev]) {
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
    .command('local [deps...]')
    .alias('l')
    .description('Switch dependencies to local directory')
    .option('-I, --no-install', 'Skip running pnpm install')
    .option('-k, --keep-going', 'Continue past per-dep failures (default: stop on first error)')
    .option('-a, --all', 'Treat each query as a regex and switch ALL matching deps (no query = all configured deps)')
    .action((deps, options) => {
    const queries = deps.length ? deps : [undefined];
    const isGlobal = program.opts().global;
    if (isGlobal) {
        const config = loadGlobalConfig();
        const items = resolveDepItems(config, queries, options.all);
        runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
            if (!depConfig.localPath) {
                throw new Error(`No local path configured for ${depName}. Use "pds set ${depName} -l <path>" to set one.`);
            }
            // link: (live symlink) rather than file: (copy) — see initOne note.
            runGlobalInstall(`link:${depConfig.localPath}`);
            console.log(`Installed ${depName} globally from local: ${depConfig.localPath}`);
        });
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    const config = loadConfig(projectRoot);
    const items = resolveDepItems(config, queries, options.all);
    runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
        if (!depConfig.localPath) {
            throw new Error(`No local path configured for ${depName}. Use "pds set ${depName} -l <path>" to set one.`);
        }
        switchToLocal(projectRoot, depName, depConfig, workspaceRoot);
    });
    if (options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
    }
});
program
    .command('github [deps...]')
    .aliases(['gh'])
    .description('Switch dependencies to GitHub ref (defaults to dist branch HEAD)')
    .option('-n, --dry-run', 'Show what would be installed without making changes')
    .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
    .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .option('-k, --keep-going', 'Continue past per-dep failures (default: stop on first error)')
    .option('-a, --all', 'Treat each query as a regex and switch ALL matching deps (no query = all configured deps)')
    .action((deps, options) => {
    if (options.ref && options.rawRef) {
        throw new Error('Cannot use both -r/--ref and -R/--raw-ref');
    }
    const queries = deps.length ? deps : [undefined];
    const isGlobal = program.opts().global;
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot());
    const resolveRef = (github, distBranch) => {
        if (options.rawRef)
            return options.rawRef;
        if (options.ref)
            return resolveGitHubRef(github, options.ref);
        return resolveGitHubRef(github, distBranch);
    };
    if (isGlobal) {
        const items = resolveDepItems(config, queries, options.all);
        runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
            if (!depConfig.github) {
                throw new Error(`No GitHub repo configured for ${depName}. Use "pds init" with -H/--github`);
            }
            const distBranch = depConfig.distBranch ?? 'dist';
            const resolvedRef = resolveRef(depConfig.github, distBranch);
            const specifier = makeGitHubSpecifier(depConfig.github, resolvedRef, depConfig.subdir);
            if (options.dryRun) {
                console.log(`Would switch ${depName} to: ${specifier}`);
                return;
            }
            runGlobalInstall(specifier);
            console.log(`Installed ${depName} globally from GitHub: ${specifier}`);
        });
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    let anyMutation = false;
    const items = resolveDepItems(config, queries, options.all);
    runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
        if (!depConfig.github) {
            throw new Error(`No GitHub repo configured for ${depName}. Use "pds init" with -H/--github`);
        }
        const distBranch = depConfig.distBranch ?? 'dist';
        const resolvedRef = resolveRef(depConfig.github, distBranch);
        if (options.dryRun) {
            const specifier = makeGitHubSpecifier(depConfig.github, resolvedRef, depConfig.subdir);
            console.log(`Would switch ${depName} to: ${specifier}`);
            return;
        }
        switchToGitHub(projectRoot, depName, depConfig, resolvedRef, workspaceRoot);
        anyMutation = true;
    });
    if (anyMutation && options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
    }
});
program
    .command('gitlab [deps...]')
    .aliases(['gl'])
    .description('Switch dependencies to GitLab ref (defaults to dist branch HEAD)')
    .option('-n, --dry-run', 'Show what would be installed without making changes')
    .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
    .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .option('-k, --keep-going', 'Continue past per-dep failures (default: stop on first error)')
    .option('-a, --all', 'Treat each query as a regex and switch ALL matching deps (no query = all configured deps)')
    .action((deps, options) => {
    if (options.ref && options.rawRef) {
        throw new Error('Cannot use both -r/--ref and -R/--raw-ref');
    }
    const queries = deps.length ? deps : [undefined];
    const isGlobal = program.opts().global;
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot());
    const resolveRef = (gitlab, distBranch) => {
        if (options.rawRef)
            return options.rawRef;
        if (options.ref)
            return resolveGitLabRef(gitlab, options.ref);
        return resolveGitLabRef(gitlab, distBranch);
    };
    const tarballUrlFor = (gitlab, ref) => {
        const repoBasename = gitlab.split('/').pop();
        return `https://gitlab.com/${gitlab}/-/archive/${ref}/${repoBasename}-${ref}.tar.gz`;
    };
    if (isGlobal) {
        const items = resolveDepItems(config, queries, options.all);
        runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
            if (!depConfig.gitlab) {
                throw new Error(`No GitLab repo configured for ${depName}. Use "pds init" with -L/--gitlab`);
            }
            const distBranch = depConfig.distBranch ?? 'dist';
            const resolvedRef = resolveRef(depConfig.gitlab, distBranch);
            const tarballUrl = tarballUrlFor(depConfig.gitlab, resolvedRef);
            if (options.dryRun) {
                console.log(`Would switch ${depName} to: ${tarballUrl}`);
                return;
            }
            runGlobalInstall(tarballUrl);
            console.log(`Installed ${depName} globally from GitLab: ${depConfig.gitlab}@${resolvedRef}`);
        });
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    let anyMutation = false;
    const items = resolveDepItems(config, queries, options.all);
    runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
        if (!depConfig.gitlab) {
            throw new Error(`No GitLab repo configured for ${depName}. Use "pds init" with -L/--gitlab`);
        }
        const distBranch = depConfig.distBranch ?? 'dist';
        const resolvedRef = resolveRef(depConfig.gitlab, distBranch);
        if (options.dryRun) {
            const tarballUrl = tarballUrlFor(depConfig.gitlab, resolvedRef);
            console.log(`Would switch ${depName} to: ${tarballUrl}`);
            return;
        }
        switchToGitLab(projectRoot, depName, depConfig, resolvedRef, workspaceRoot);
        anyMutation = true;
    });
    if (anyMutation && options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
    }
});
program
    .command('git [deps...]')
    .alias('g')
    .description('Switch dependencies to GitHub or GitLab (auto-detects which is configured)')
    .option('-n, --dry-run', 'Show what would be installed without making changes')
    .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
    .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .option('-k, --keep-going', 'Continue past per-dep failures (default: stop on first error)')
    .option('-a, --all', 'Treat each query as a regex and switch ALL matching deps (no query = all configured deps)')
    .action((deps, options) => {
    if (options.ref && options.rawRef) {
        throw new Error('Cannot use both -r/--ref and -R/--raw-ref');
    }
    const queries = deps.length ? deps : [undefined];
    const isGlobal = program.opts().global;
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot());
    if (isGlobal) {
        const items = resolveDepItems(config, queries, options.all);
        runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
            const hasGitHub = !!depConfig.github;
            const hasGitLab = !!depConfig.gitlab;
            if (!hasGitHub && !hasGitLab) {
                throw new Error(`No GitHub or GitLab repo configured for ${depName}. Use "pds init" with -H or -L`);
            }
            if (hasGitHub && hasGitLab) {
                throw new Error(`Both GitHub and GitLab configured for ${depName}. Use "pds gh" or "pds gl" explicitly`);
            }
            const distBranch = depConfig.distBranch ?? 'dist';
            if (hasGitHub) {
                const ref = options.rawRef
                    ?? (options.ref ? resolveGitHubRef(depConfig.github, options.ref) : resolveGitHubRef(depConfig.github, distBranch));
                const specifier = makeGitHubSpecifier(depConfig.github, ref, depConfig.subdir);
                if (options.dryRun) {
                    console.log(`Would switch ${depName} to: ${specifier}`);
                    return;
                }
                runGlobalInstall(specifier);
                console.log(`Installed ${depName} globally from GitHub: ${specifier}`);
            }
            else {
                const ref = options.rawRef
                    ?? (options.ref ? resolveGitLabRef(depConfig.gitlab, options.ref) : resolveGitLabRef(depConfig.gitlab, distBranch));
                const repoBasename = depConfig.gitlab.split('/').pop();
                const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${ref}/${repoBasename}-${ref}.tar.gz`;
                if (options.dryRun) {
                    console.log(`Would switch ${depName} to: ${tarballUrl}`);
                    return;
                }
                runGlobalInstall(tarballUrl);
                console.log(`Installed ${depName} globally from GitLab: ${depConfig.gitlab}@${ref}`);
            }
        });
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    let anyMutation = false;
    const items = resolveDepItems(config, queries, options.all);
    runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
        const hasGitHub = !!depConfig.github;
        const hasGitLab = !!depConfig.gitlab;
        if (!hasGitHub && !hasGitLab) {
            throw new Error(`No GitHub or GitLab repo configured for ${depName}. Use "pds init" with -H or -L`);
        }
        if (hasGitHub && hasGitLab) {
            throw new Error(`Both GitHub and GitLab configured for ${depName}. Use "pds gh" or "pds gl" explicitly`);
        }
        const distBranch = depConfig.distBranch ?? 'dist';
        if (hasGitHub) {
            const ref = options.rawRef
                ?? (options.ref ? resolveGitHubRef(depConfig.github, options.ref) : resolveGitHubRef(depConfig.github, distBranch));
            if (options.dryRun) {
                const specifier = makeGitHubSpecifier(depConfig.github, ref, depConfig.subdir);
                console.log(`Would switch ${depName} to: ${specifier}`);
                return;
            }
            switchToGitHub(projectRoot, depName, depConfig, ref, workspaceRoot);
            anyMutation = true;
        }
        else {
            const ref = options.rawRef
                ?? (options.ref ? resolveGitLabRef(depConfig.gitlab, options.ref) : resolveGitLabRef(depConfig.gitlab, distBranch));
            if (options.dryRun) {
                const repoBasename = depConfig.gitlab.split('/').pop();
                const tarballUrl = `https://gitlab.com/${depConfig.gitlab}/-/archive/${ref}/${repoBasename}-${ref}.tar.gz`;
                console.log(`Would switch ${depName} to: ${tarballUrl}`);
                return;
            }
            switchToGitLab(projectRoot, depName, depConfig, ref, workspaceRoot);
            anyMutation = true;
        }
    });
    if (anyMutation && options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
    }
});
program
    .command('cr [deps...]')
    .alias('pkg-pr-new')
    .description('Switch dependencies to pkg.pr.new continuous-release build (SHA-pinned, defaults to default-branch HEAD)')
    .option('-n, --dry-run', 'Show what would be installed without making changes')
    .option('-r, --ref <ref>', 'Git ref, resolved to SHA')
    .option('-R, --raw-ref <ref>', 'Git ref, used as-is (pin to branch/tag name)')
    .option('-I, --no-install', 'Skip running pnpm install')
    .option('-k, --keep-going', 'Continue past per-dep failures (default: stop on first error)')
    .option('-a, --all', 'Treat each query as a regex and switch ALL matching deps (no query = all configured deps)')
    .action(async (deps, options) => {
    if (options.ref && options.rawRef) {
        throw new Error('Cannot use both -r/--ref and -R/--raw-ref');
    }
    const queries = deps.length ? deps : [undefined];
    const isGlobal = program.opts().global;
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot());
    // Default ref: the repo's default-branch HEAD (pkg.pr.new keys builds off
    // main/PR commits; no dist branch). `commits/HEAD` resolves the default
    // branch regardless of its name.
    const resolveSha = (github) => {
        if (options.rawRef)
            return options.rawRef;
        return resolveGitHubRef(github, options.ref ?? 'HEAD');
    };
    const requireFields = (depName, depConfig) => {
        if (!depConfig.github) {
            throw new Error(`No GitHub repo configured for ${depName}. Use "pds init" with -H/--github`);
        }
        if (!depConfig.npm) {
            throw new Error(`No npm package name configured for ${depName}. Use "pds set ${depName} -n <name>"`);
        }
        return { github: depConfig.github, npm: depConfig.npm };
    };
    // Collected (depName, url) for the post-switch warn-only build-existence check
    const built = [];
    if (isGlobal) {
        const items = resolveDepItems(config, queries, options.all);
        runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
            const { github, npm } = requireFields(depName, depConfig);
            const sha = resolveSha(github);
            const specifier = makePkgPrNewSpecifier(github, npm, sha);
            if (options.dryRun) {
                console.log(`Would switch ${depName} to: ${specifier}`);
                return;
            }
            runGlobalInstall(specifier);
            console.log(`Installed ${depName} globally from pkg.pr.new: ${specifier}`);
            built.push({ depName, url: specifier });
        });
        await warnMissingBuilds(built, options.dryRun);
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    let anyMutation = false;
    const items = resolveDepItems(config, queries, options.all);
    runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
        const { github, npm } = requireFields(depName, depConfig);
        const sha = resolveSha(github);
        if (options.dryRun) {
            console.log(`Would switch ${depName} to: ${makePkgPrNewSpecifier(github, npm, sha)}`);
            return;
        }
        switchToPkgPrNew(projectRoot, depName, depConfig, sha, workspaceRoot);
        built.push({ depName, url: makePkgPrNewSpecifier(github, npm, sha) });
        anyMutation = true;
    });
    await warnMissingBuilds(built, options.dryRun);
    if (anyMutation && options.install) {
        runPnpmInstall(projectRoot, workspaceRoot);
    }
});
program
    .command('npm [args...]')
    .alias('n')
    .description('Switch dependencies to NPM (defaults to latest). With 1-2 args, last may be a version (must start with digit).')
    .option('-n, --dry-run', 'Show what would be installed without making changes')
    .option('-I, --no-install', 'Skip running pnpm install')
    .option('-k, --keep-going', 'Continue past per-dep failures (default: stop on first error)')
    .option('-a, --all', 'Treat each query as a regex and switch ALL matching deps (no query = all configured deps)')
    .action((args, options) => {
    const isGlobal = program.opts().global;
    const config = isGlobal ? loadGlobalConfig() : loadConfig(findProjectRoot());
    const deps = Object.entries(config.dependencies);
    // Disambiguate args. Versions start with a digit; anything else is a dep query.
    //   []                                 → [undefined], no version
    //   [arg1] where exactly 1 dep & digit → [undefined], version=arg1
    //   [arg1]                             → [arg1], no version
    //   [arg1, arg2] where arg2 is digit   → [arg1], version=arg2  (single-dep + explicit version)
    //   [arg1, ...]                        → all args as queries, no version
    let queries;
    let version;
    if (options.all) {
        // With --all, every arg is a regex pattern; a shared trailing version
        // makes no sense across many deps, so don't special-case it.
        queries = args.length ? args : [undefined];
    }
    else if (args.length === 0) {
        queries = [undefined];
    }
    else if (args.length === 1) {
        if (deps.length === 1 && /^\d/.test(args[0])) {
            queries = [undefined];
            version = args[0];
        }
        else {
            queries = [args[0]];
        }
    }
    else if (args.length === 2 && /^\d/.test(args[1])) {
        queries = [args[0]];
        version = args[1];
    }
    else {
        queries = args;
    }
    if (isGlobal) {
        const items = resolveDepItems(config, queries, options.all);
        runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
            const npmName = depConfig.npm ?? depName;
            const resolvedVersion = version ?? getLatestNpmVersion(npmName);
            const specifier = `^${resolvedVersion}`;
            if (options.dryRun) {
                console.log(`Would switch ${depName} to: ${specifier}`);
                return;
            }
            runGlobalInstall(`${npmName}@${resolvedVersion}`);
            console.log(`Installed ${depName} globally from NPM: ${npmName}@${resolvedVersion}`);
        });
        return;
    }
    const projectRoot = findProjectRoot();
    const workspaceRoot = findWorkspaceRoot(projectRoot);
    let anyMutation = false;
    const items = resolveDepItems(config, queries, options.all);
    runMultiple(items, !!options.keepGoing, ([depName, depConfig]) => {
        const npmName = depConfig.npm ?? depName;
        const resolvedVersion = version ?? getLatestNpmVersion(npmName);
        const specifier = `^${resolvedVersion}`;
        if (options.dryRun) {
            console.log(`Would switch ${depName} to: ${specifier}`);
            return;
        }
        switchToNpm(projectRoot, depName, depConfig, specifier, workspaceRoot);
        anyMutation = true;
    });
    if (anyMutation && options.install) {
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
    const overrides = loadOverrides(projectRoot, pkg);
    const deps = depQuery
        ? [findMatchingDep(config, depQuery)]
        : Object.entries(config.dependencies);
    for (const [name, dep] of deps) {
        const override = dep.override ? overrides[name] : undefined;
        const current = override ?? getCurrentSource(pkg, name);
        const sourceType = getSourceType(current);
        const tag = override ? ' [override]' : '';
        console.log(`${name}: ${sourceType} (${current})${tag}`);
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
// Check if any pds-managed deps are set to local (workspace:* dep spec, or a
// link:/file: pnpm.override for override-managed deps)
function checkLocalDeps(projectRoot) {
    const configPath = resolveConfigPath(projectRoot);
    if (!existsSync(configPath)) {
        return []; // No pds config, nothing to check
    }
    const config = loadConfig(projectRoot);
    const pkg = loadPackageJson(projectRoot);
    const overrides = loadOverrides(projectRoot, pkg);
    const localDeps = [];
    for (const [name, dep] of Object.entries(config.dependencies)) {
        const override = dep.override ? overrides[name] : undefined;
        const source = override ?? getCurrentSource(pkg, name);
        if (source === 'workspace:*' || source.startsWith('link:') || source.startsWith('file:')) {
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
alias pdll='pds ls -s local'  # list local deps only
alias pdlv='pds ls -v'    # list with versions
alias pdlav='pds ls -av'  # list all with versions
alias pdlg='pds -g ls'   # global list
alias pdav='pds ls -av'   # list all with versions (alt)
alias pdgv='pds -g ls -v' # global list with versions
alias pdsl='pds l'     # local
alias pdgh='pds gh'    # github
alias pdgl='pds gl'    # gitlab
alias pdcr='pds cr'    # pkg.pr.new continuous release
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
// Pre-parse -C/--dir before default command detection, since commander hasn't run yet
function extractDir(arg, nextArg) {
    if (arg === '-C' || arg === '--dir') {
        return nextArg ? { dir: nextArg, consumesNext: true } : null;
    }
    const eqMatch = arg.match(/^(?:-C|--dir)=(.+)$/);
    if (eqMatch)
        return { dir: eqMatch[1], consumesNext: false };
    // -Cwww (combined short option + value)
    if (arg.startsWith('-C') && arg.length > 2)
        return { dir: arg.slice(2), consumesNext: false };
    return null;
}
function preParseDir() {
    for (let i = 2; i < process.argv.length; i++) {
        const result = extractDir(process.argv[i], process.argv[i + 1]);
        if (result) {
            process.chdir(resolve(result.dir));
            return;
        }
    }
}
function argsWithoutFlags() {
    const skip = new Set(['-g', '--global']);
    const result = [];
    for (let i = 2; i < process.argv.length; i++) {
        if (skip.has(process.argv[i]))
            continue;
        const dirResult = extractDir(process.argv[i], process.argv[i + 1]);
        if (dirResult) {
            if (dirResult.consumesNext)
                i++;
            continue;
        }
        result.push(process.argv[i]);
    }
    return result;
}
preParseDir();
const nonFlagArgs = argsWithoutFlags();
const hasGlobalFlag = process.argv.slice(2).some(a => a === '-g' || a === '--global');
if (nonFlagArgs.length === 0) {
    // Check if there are any deps configured
    try {
        if (hasGlobalFlag) {
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