import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { spawnAsync } from './process.js';
import { log, getConfiguredRetries } from './log.js';
async function withRetry(label, fn) {
    const maxRetries = getConfiguredRetries();
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt < maxRetries) {
                log.debug(`${label}: attempt ${attempt + 1} failed (${msg}), retrying...`);
            }
            else if (maxRetries > 0) {
                log.warn(`${label}: failed after ${maxRetries + 1} attempts: ${msg}`);
            }
            else {
                log.warn(`${label}: failed: ${msg}`);
            }
        }
    }
    throw lastErr;
}
export function getLocalGitInfo(localPath) {
    if (!existsSync(localPath)) {
        return null;
    }
    try {
        // Get short SHA
        const shaResult = spawnSync('git', ['-C', localPath, 'rev-parse', '--short', 'HEAD'], {
            encoding: 'utf-8',
        });
        if (shaResult.status !== 0) {
            return null;
        }
        const sha = shaResult.stdout.trim();
        // Check if dirty
        const statusResult = spawnSync('git', ['-C', localPath, 'status', '--porcelain'], {
            encoding: 'utf-8',
        });
        const dirty = statusResult.status === 0 && statusResult.stdout.trim().length > 0;
        return { sha, dirty };
    }
    catch {
        return null;
    }
}
const gitInfoCache = new Map();
export function getLocalGitInfoAsync(localPath) {
    if (!existsSync(localPath)) {
        return Promise.resolve(null);
    }
    // Cache by git repo root to deduplicate deps sharing the same repo
    const cached = gitInfoCache.get(localPath);
    if (cached)
        return cached;
    const promise = (async () => {
        try {
            const [shaResult, statusResult, rootResult] = await Promise.all([
                spawnAsync('git', ['-C', localPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }),
                spawnAsync('git', ['-C', localPath, 'status', '--porcelain'], { encoding: 'utf-8' }),
                spawnAsync('git', ['-C', localPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' }),
            ]);
            if (shaResult.status !== 0)
                return null;
            const sha = shaResult.stdout.trim();
            const dirty = statusResult.status === 0 && statusResult.stdout.trim().length > 0;
            const result = { sha, dirty };
            // Also cache under the repo root so other paths in the same repo hit the cache
            if (rootResult.status === 0) {
                const root = rootResult.stdout.trim();
                if (root !== localPath)
                    gitInfoCache.set(root, Promise.resolve(result));
            }
            return result;
        }
        catch {
            return null;
        }
    })();
    gitInfoCache.set(localPath, promise);
    return promise;
}
// Extract source commit SHA from npm-dist version strings like "0.1.0-dist.5926331"
export function parseDistSourceSha(version) {
    const match = version.match(/-dist\.([a-f0-9]+)$/);
    return match?.[1];
}
// Count commits reachable from `head` but not from `base` in a local repo
export async function gitRevListCountAsync(repoPath, base, head) {
    try {
        const result = await spawnAsync('git', ['-C', repoPath, 'rev-list', '--count', `${base}..${head}`], { encoding: 'utf-8' });
        if (result.status !== 0)
            return null;
        return parseInt(result.stdout.trim(), 10);
    }
    catch {
        return null;
    }
}
// Resolve an npm version to a git SHA via local tags (tries v1.2.3 then 1.2.3)
export async function resolveVersionTagAsync(repoPath, version) {
    for (const tag of [`v${version}`, version]) {
        try {
            const result = await spawnAsync('git', ['-C', repoPath, 'rev-parse', '--verify', `${tag}^{commit}`], { encoding: 'utf-8' });
            if (result.status === 0)
                return result.stdout.trim();
        }
        catch { }
    }
    return undefined;
}
export function resolveGitHubRef(repo, ref) {
    // Use gh api to resolve ref to SHA from GitHub
    const result = spawnSync('gh', ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error(`Failed to resolve GitHub ref "${ref}" for ${repo}: ${result.stderr}`);
    }
    return result.stdout.trim();
}
const ghRefCache = new Map();
export function resolveGitHubRefAsync(repo, ref) {
    const key = `${repo}:${ref}`;
    const cached = ghRefCache.get(key);
    if (cached)
        return cached;
    const promise = withRetry(`GitHub ref ${repo}@${ref}`, async () => {
        const result = await spawnAsync('gh', ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'], { encoding: 'utf-8' });
        if (result.status !== 0) {
            throw new Error(`Failed to resolve GitHub ref "${ref}" for ${repo}: ${result.stderr}`);
        }
        return result.stdout.trim();
    });
    ghRefCache.set(key, promise);
    return promise;
}
export function resolveGitLabRef(repo, ref) {
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
const glRefCache = new Map();
export function resolveGitLabRefAsync(repo, ref) {
    const key = `${repo}:${ref}`;
    const cached = glRefCache.get(key);
    if (cached)
        return cached;
    const promise = withRetry(`GitLab ref ${repo}@${ref}`, async () => {
        const encodedRepo = encodeURIComponent(repo);
        const result = await spawnAsync('glab', ['api', `projects/${encodedRepo}/repository/commits/${ref}`], { encoding: 'utf-8' });
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
    });
    glRefCache.set(key, promise);
    return promise;
}
// Parse GitHub/GitLab repo from a URL string
export function parseRepoUrl(repoUrl) {
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
export function parsePackageJson(pkg) {
    const result = { name: pkg.name };
    if (pkg.private === true)
        result.private = true;
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
export function fetchGitHubPackageJson(repo, ref = 'HEAD') {
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
export function fetchGitLabPackageJson(repo, ref = 'HEAD') {
    const encodedPath = encodeURIComponent(repo);
    const result = spawnSync('glab', ['api', `projects/${encodedPath}/repository/files/package.json/raw?ref=${ref}`], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error(`Failed to fetch package.json from GitLab ${repo}: ${result.stderr}`);
    }
    return JSON.parse(result.stdout);
}
const ghPkgCache = new Map();
export function fetchGitHubPackageJsonAsync(repo, ref = 'HEAD') {
    const key = `${repo}:${ref}`;
    const cached = ghPkgCache.get(key);
    if (cached)
        return cached;
    const promise = withRetry(`GitHub package.json ${repo}@${ref}`, async () => {
        const result = await spawnAsync('gh', ['api', `repos/${repo}/contents/package.json?ref=${ref}`, '--jq', '.content'], { encoding: 'utf-8' });
        if (result.status !== 0) {
            throw new Error(`Failed to fetch package.json from GitHub ${repo}: ${result.stderr}`);
        }
        const content = Buffer.from(result.stdout.trim(), 'base64').toString('utf-8');
        return JSON.parse(content);
    });
    ghPkgCache.set(key, promise);
    return promise;
}
const glPkgCache = new Map();
export function fetchGitLabPackageJsonAsync(repo, ref = 'HEAD') {
    const key = `${repo}:${ref}`;
    const cached = glPkgCache.get(key);
    if (cached)
        return cached;
    const promise = withRetry(`GitLab package.json ${repo}@${ref}`, async () => {
        const encodedPath = encodeURIComponent(repo);
        const result = await spawnAsync('glab', ['api', `projects/${encodedPath}/repository/files/package.json/raw?ref=${ref}`], { encoding: 'utf-8' });
        if (result.status !== 0) {
            throw new Error(`Failed to fetch package.json from GitLab ${repo}: ${result.stderr}`);
        }
        return JSON.parse(result.stdout);
    });
    glPkgCache.set(key, promise);
    return promise;
}
// Detect GitHub/GitLab repo from git remote in or above the given path
// Also returns subdir if startPath is inside a subdirectory of the repo
export function detectGitRepo(startPath) {
    let dir = startPath;
    while (dir !== dirname(dir)) {
        if (existsSync(join(dir, '.git'))) {
            // Found git repo, get remote URLs
            const result = spawnSync('git', ['-C', dir, 'remote', '-v'], {
                encoding: 'utf-8',
            });
            if (result.status !== 0) {
                return null;
            }
            // Calculate subdir relative to git root
            const relPath = relative(dir, startPath);
            const subdir = relPath ? `/${relPath}` : undefined;
            // Parse remote URLs - take the first fetch URL that matches GitHub/GitLab
            for (const line of result.stdout.split('\n')) {
                const match = line.match(/^\S+\s+(\S+)\s+\(fetch\)$/);
                if (match) {
                    const parsed = parseRepoUrl(match[1]);
                    if (parsed.github || parsed.gitlab) {
                        return { ...parsed, subdir };
                    }
                }
            }
            return null;
        }
        dir = dirname(dir);
    }
    return null;
}
// Get package info from local path
export function getLocalPackageInfo(localPath) {
    const pkgPath = join(localPath, 'package.json');
    if (!existsSync(pkgPath)) {
        throw new Error(`No package.json found at ${localPath}`);
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const info = parsePackageJson(pkg);
    // Detect git repo and subdir
    const gitRepo = detectGitRepo(localPath);
    if (gitRepo) {
        // Fallback to git remote detection if no repo found in package.json
        if (!info.github && !info.gitlab) {
            info.github = gitRepo.github;
            info.gitlab = gitRepo.gitlab;
        }
        // Always capture subdir for monorepo support
        return { ...info, subdir: gitRepo.subdir };
    }
    return info;
}
// Get package info from URL (GitHub or GitLab)
export function getRemotePackageInfo(url) {
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
export function isRepoUrl(arg) {
    return arg.startsWith('http://') ||
        arg.startsWith('https://') ||
        arg.startsWith('github:') ||
        arg.startsWith('gitlab:') ||
        arg.startsWith('git@');
}
export function getLocalPackageName(localPath) {
    return getLocalPackageInfo(localPath).name;
}
export function getLatestNpmVersion(packageName) {
    const result = spawnSync('npm', ['view', packageName, 'version'], {
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error(`Failed to get latest version for ${packageName}: ${result.stderr}`);
    }
    return result.stdout.trim();
}
export function npmPackageExists(packageName) {
    const result = spawnSync('npm', ['view', packageName, 'version'], {
        encoding: 'utf-8',
    });
    return result.status === 0;
}
export async function getLatestNpmVersionAsync(packageName) {
    const info = await getNpmInfoAsync(packageName);
    if (!info)
        throw new Error(`Failed to get latest version for ${packageName}`);
    return info.version;
}
export async function getNpmVersionsAsync(packageName) {
    const info = await getNpmInfoAsync(packageName);
    return info?.versions ?? [];
}
// Fetch npm package info via registry HTTP API (faster than spawning npm CLI).
// Cached per package name to avoid redundant calls.
const npmInfoCache = new Map();
export function getNpmInfoAsync(packageName) {
    const cached = npmInfoCache.get(packageName);
    if (cached)
        return cached;
    const promise = withRetry(`npm info ${packageName}`, async () => {
        const resp = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
        if (!resp.ok)
            throw new Error(`npm registry returned ${resp.status}`);
        const data = await resp.json();
        const distTags = data['dist-tags'];
        const version = distTags?.latest ?? data.version;
        if (!version)
            throw new Error(`no version found for ${packageName}`);
        const rawVersions = data.versions;
        const versions = rawVersions && typeof rawVersions === 'object'
            ? Object.keys(rawVersions)
            : [version];
        return { version, versions };
    }).catch(() => undefined);
    npmInfoCache.set(packageName, promise);
    return promise;
}
// Strip pre-release/dist suffixes to get the base semver: "1.2.3-dist.abc" → "1.2.3"
export function baseVersion(version) {
    const match = version.match(/^(\d+\.\d+\.\d+)/);
    return match ? match[1] : version;
}
// Cache for global install sources (fetched once via pnpm list -g --json)
let globalInstallCache = null;
export function parseGlobalPkgSource(pkg, globalDir) {
    const version = pkg.version || '';
    const resolved = pkg.resolved || '';
    const pkgPath = pkg.path || '';
    // Local file install: version is "file:..." path
    if (version.startsWith('file:')) {
        const filePath = version.slice(5);
        const absPath = globalDir ? resolve(globalDir, filePath) : filePath;
        return { source: 'local', specifier: absPath };
    }
    // Check resolved URL and install path for source detection
    const resolvedOrPath = resolved || pkgPath;
    if (resolvedOrPath.includes('codeload.github.com') || resolvedOrPath.includes('github.com')) {
        const shaMatch = resolvedOrPath.match(/([a-f0-9]{40})/);
        const sha = shaMatch ? shaMatch[1].slice(0, 7) : '';
        return { source: 'github', specifier: `${sha}; ${version}` };
    }
    else if (resolvedOrPath.includes('gitlab.com') && (resolved.includes('/-/archive/') || pkgPath.includes('gitlab.com'))) {
        const refMatch = resolvedOrPath.match(/\/-\/archive\/([^/]+)\//) ?? resolvedOrPath.match(/([a-f0-9]{40})/);
        const ref = refMatch ? refMatch[1].slice(0, 7) : '';
        return { source: 'gitlab', specifier: `${ref}; ${version}` };
    }
    else if (version) {
        return { source: 'npm', specifier: version };
    }
    return null;
}
export function fetchAllGlobalInstallSources() {
    if (globalInstallCache)
        return globalInstallCache;
    globalInstallCache = new Map();
    const result = spawnSync('pnpm', ['list', '-g', '--json'], {
        encoding: 'utf-8',
    });
    if (result.status !== 0)
        return globalInstallCache;
    try {
        const data = JSON.parse(result.stdout);
        const globalDir = data[0]?.path || '';
        const deps = data[0]?.dependencies ?? {};
        for (const [name, pkg] of Object.entries(deps)) {
            const source = parseGlobalPkgSource(pkg, globalDir);
            if (source) {
                globalInstallCache.set(name, source);
            }
        }
    }
    catch {
        // Ignore parse errors
    }
    return globalInstallCache;
}
export async function fetchAllGlobalInstallSourcesAsync() {
    const map = new Map();
    const result = await spawnAsync('pnpm', ['list', '-g', '--json'], { encoding: 'utf-8' });
    if (result.status !== 0)
        return map;
    try {
        const data = JSON.parse(result.stdout);
        const globalDir = data[0]?.path || '';
        const deps = data[0]?.dependencies ?? {};
        for (const [name, pkg] of Object.entries(deps)) {
            const source = parseGlobalPkgSource(pkg, globalDir);
            if (source) {
                map.set(name, source);
            }
        }
    }
    catch {
        // Ignore parse errors
    }
    return map;
}
export function getGlobalInstallSource(packageName = 'pnpm-dep-source') {
    return fetchAllGlobalInstallSources().get(packageName) ?? null;
}
//# sourceMappingURL=remote.js.map