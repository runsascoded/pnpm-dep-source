import { resolve } from 'path';
import { c } from './constants.js';
import { getCurrentSource, getInstalledVersion } from './pkg.js';
import { getLocalGitInfo, getLocalGitInfoAsync, getGlobalInstallSource, resolveGitHubRef, resolveGitLabRef, resolveGitHubRefAsync, resolveGitLabRefAsync, fetchGitHubPackageJson, fetchGitLabPackageJson, fetchGitHubPackageJsonAsync, fetchGitLabPackageJsonAsync, getLatestNpmVersion, getLatestNpmVersionAsync, } from './remote.js';
export function getSourceType(source) {
    if (source === 'workspace:*' || source === 'local')
        return 'local';
    if (source.startsWith('github:') || source.includes('github.com/'))
        return 'github';
    if (source.includes('gitlab.com') && source.includes('/-/archive/'))
        return 'gitlab';
    if (source.match(/^\^?\d|^latest/))
        return 'npm';
    return 'unknown';
}
export function formatGitInfo(info) {
    if (!info)
        return '';
    const dirtyStr = info.dirty ? ` ${c.red}dirty${c.reset}` : '';
    return ` ${c.blue}(${info.sha}${dirtyStr}${c.blue})${c.reset}`;
}
// Build blue-colored parenthesized suffix showing current ref/version for the active line
export function formatActiveSuffix(info) {
    if (info.sourceType === 'local')
        return '';
    const parts = [];
    if (info.isGlobal && info.currentSpecifier) {
        parts.push(info.currentSpecifier);
    }
    else {
        if (info.sourceType === 'github') {
            const match = info.currentSource.match(/#([a-f0-9]+)$/);
            if (match)
                parts.push(match[1].slice(0, 7));
        }
        else if (info.sourceType === 'gitlab') {
            const match = info.currentSource.match(/\/-\/archive\/([^/]+)\//);
            if (match)
                parts.push(match[1].slice(0, 7));
        }
        if (info.version)
            parts.push(info.version);
    }
    if (parts.length === 0)
        return '';
    return ` ${c.blue}(${parts.join('; ')})${c.reset}`;
}
export function displayDep(info, verbose = false, remoteVersions) {
    const tag = info.isGlobal ? ` ${c.yellow}[global]${c.reset}`
        : info.isDev ? ` ${c.yellow}[dev]${c.reset}`
            : '';
    console.log(`${c.bold}${c.cyan}${info.name}${c.reset}${tag}:`);
    const active = info.sourceType;
    const versions = verbose ? (remoteVersions ?? fetchRemoteVersions(info.config, info.name)) : undefined;
    function line(label, isActive, value, suffix = '') {
        const prefix = isActive ? `${c.green}*${c.reset} ` : '  ';
        const coloredLabel = isActive ? `${c.green}${label}${c.reset}` : label;
        console.log(`${prefix}${coloredLabel}: ${value}${suffix}`);
    }
    if (info.config.localPath) {
        const gitSuffix = info.gitInfo ? formatGitInfo(info.gitInfo) : '';
        line('Local', active === 'local', info.config.localPath, gitSuffix);
    }
    if (info.config.github) {
        const isActive = active === 'github';
        const activeSuffix = isActive ? formatActiveSuffix(info) : '';
        const distParts = [versions?.github, versions?.githubVersion].filter(Boolean);
        const subdirSuffix = info.config.subdir ? ` ${c.cyan}[${info.config.subdir}]${c.reset}` : '';
        if (isActive && distParts.length && !distParts.every(p => activeSuffix.includes(p))) {
            line('GitHub', true, info.config.github + subdirSuffix, activeSuffix);
            console.log(`      ${c.blue}dist@${distParts.join('; ')}${c.reset}`);
        }
        else {
            const distSuffix = !isActive && distParts.length ? ` ${c.blue}(dist@${distParts.join('; ')})${c.reset}` : '';
            line('GitHub', isActive, info.config.github + subdirSuffix, activeSuffix + distSuffix);
        }
    }
    if (info.config.gitlab) {
        const isActive = active === 'gitlab';
        const activeSuffix = isActive ? formatActiveSuffix(info) : '';
        const distParts = [versions?.gitlab, versions?.gitlabVersion].filter(Boolean);
        if (isActive && distParts.length && !distParts.every(p => activeSuffix.includes(p))) {
            line('GitLab', true, info.config.gitlab, activeSuffix);
            console.log(`      ${c.blue}dist@${distParts.join('; ')}${c.reset}`);
        }
        else {
            const distSuffix = !isActive && distParts.length ? ` ${c.blue}(dist@${distParts.join('; ')})${c.reset}` : '';
            line('GitLab', isActive, info.config.gitlab, activeSuffix + distSuffix);
        }
    }
    if (info.config.npm) {
        const isActive = active === 'npm';
        // In verbose mode, omit NPM line if no published version exists and npm isn't the active source
        if (verbose && !isActive && !versions?.npm)
            return;
        const activeSuffix = isActive ? formatActiveSuffix(info) : '';
        const latestSuffix = versions?.npm ? ` ${c.blue}(latest: ${versions.npm})${c.reset}` : '';
        line('NPM', isActive, info.config.npm, activeSuffix + latestSuffix);
    }
}
export function buildGlobalDepInfo(name, dep) {
    const installSource = getGlobalInstallSource(name);
    const sourceType = installSource?.source ?? 'unknown';
    const gitInfo = dep.localPath ? getLocalGitInfo(dep.localPath) : null;
    return {
        name,
        currentSource: installSource?.source ?? '(not installed)',
        currentSpecifier: installSource?.specifier,
        sourceType,
        isGlobal: true,
        gitInfo,
        config: dep,
    };
}
export function buildProjectDepInfo(name, dep, projectRoot, pkg) {
    const currentSource = getCurrentSource(pkg, name);
    const sourceType = getSourceType(currentSource);
    const devDeps = pkg.devDependencies;
    const isDev = !!(devDeps && name in devDeps);
    const version = sourceType !== 'local' ? (getInstalledVersion(projectRoot, name) ?? undefined) : undefined;
    const gitInfo = dep.localPath ? getLocalGitInfo(resolve(projectRoot, dep.localPath)) : null;
    return {
        name,
        currentSource,
        sourceType,
        isDev,
        version,
        gitInfo,
        config: dep,
    };
}
export async function buildGlobalDepInfoAsync(name, dep, globalSources) {
    const installSource = globalSources.get(name) ?? null;
    const sourceType = installSource?.source ?? 'unknown';
    const gitInfo = dep.localPath ? await getLocalGitInfoAsync(dep.localPath) : null;
    return {
        name,
        currentSource: installSource?.source ?? '(not installed)',
        currentSpecifier: installSource?.specifier,
        sourceType,
        isGlobal: true,
        gitInfo,
        config: dep,
    };
}
export async function buildProjectDepInfoAsync(name, dep, projectRoot, pkg) {
    const currentSource = getCurrentSource(pkg, name);
    const sourceType = getSourceType(currentSource);
    const devDeps = pkg.devDependencies;
    const isDev = !!(devDeps && name in devDeps);
    const version = sourceType !== 'local' ? (getInstalledVersion(projectRoot, name) ?? undefined) : undefined;
    const gitInfo = dep.localPath ? await getLocalGitInfoAsync(resolve(projectRoot, dep.localPath)) : null;
    return {
        name,
        currentSource,
        sourceType,
        isDev,
        version,
        gitInfo,
        config: dep,
    };
}
export async function fetchRemoteVersionsAsync(dep, depName) {
    const distBranch = dep.distBranch ?? 'dist';
    const npmName = dep.npm ?? depName;
    const [npmVersion, ghSha, ghPkg, glSha, glPkg] = await Promise.all([
        getLatestNpmVersionAsync(npmName).catch(() => undefined),
        dep.github ? resolveGitHubRefAsync(dep.github, distBranch).catch(() => undefined) : undefined,
        dep.github ? fetchGitHubPackageJsonAsync(dep.github, distBranch).catch(() => undefined) : undefined,
        dep.gitlab ? resolveGitLabRefAsync(dep.gitlab, distBranch).catch(() => undefined) : undefined,
        dep.gitlab ? fetchGitLabPackageJsonAsync(dep.gitlab, distBranch).catch(() => undefined) : undefined,
    ]);
    return {
        npm: npmVersion,
        github: ghSha ? ghSha.slice(0, 7) : undefined,
        githubVersion: ghPkg?.version,
        gitlab: glSha ? glSha.slice(0, 7) : undefined,
        gitlabVersion: glPkg?.version,
    };
}
// Fetch remote version info for a dependency (sync, for verbose listing)
export function fetchRemoteVersions(dep, depName) {
    const result = {};
    const distBranch = dep.distBranch ?? 'dist';
    const npmName = dep.npm ?? depName;
    try {
        result.npm = getLatestNpmVersion(npmName);
    }
    catch { }
    if (dep.github) {
        try {
            const sha = resolveGitHubRef(dep.github, distBranch);
            result.github = sha.slice(0, 7);
        }
        catch { }
        try {
            const pkg = fetchGitHubPackageJson(dep.github, distBranch);
            result.githubVersion = pkg.version;
        }
        catch { }
    }
    if (dep.gitlab) {
        try {
            const sha = resolveGitLabRef(dep.gitlab, distBranch);
            result.gitlab = sha.slice(0, 7);
        }
        catch { }
        try {
            const pkg = fetchGitLabPackageJson(dep.gitlab, distBranch);
            result.gitlabVersion = pkg.version;
        }
        catch { }
    }
    return result;
}
//# sourceMappingURL=display.js.map