import type { PackageInfo } from './types.js';
export declare function getLocalGitInfo(localPath: string): {
    sha: string;
    dirty: boolean;
} | null;
export declare function getLocalGitInfoAsync(localPath: string): Promise<{
    sha: string;
    dirty: boolean;
} | null>;
export declare function resolveGitHubRef(repo: string, ref: string): string;
export declare function resolveGitHubRefAsync(repo: string, ref: string): Promise<string>;
export declare function resolveGitLabRef(repo: string, ref: string): string;
export declare function resolveGitLabRefAsync(repo: string, ref: string): Promise<string>;
export declare function parseRepoUrl(repoUrl: string): {
    github?: string;
    gitlab?: string;
};
export declare function parsePackageJson(pkg: Record<string, unknown>): PackageInfo;
export declare function fetchGitHubPackageJson(repo: string, ref?: string): Record<string, unknown>;
export declare function fetchGitLabPackageJson(repo: string, ref?: string): Record<string, unknown>;
export declare function fetchGitHubPackageJsonAsync(repo: string, ref?: string): Promise<Record<string, unknown>>;
export declare function fetchGitLabPackageJsonAsync(repo: string, ref?: string): Promise<Record<string, unknown>>;
export declare function detectGitRepo(startPath: string): {
    github?: string;
    gitlab?: string;
    subdir?: string;
} | null;
export declare function getLocalPackageInfo(localPath: string): PackageInfo & {
    subdir?: string;
};
export declare function getRemotePackageInfo(url: string): PackageInfo & {
    github?: string;
    gitlab?: string;
};
export declare function isRepoUrl(arg: string): boolean;
export declare function getLocalPackageName(localPath: string): string;
export declare function getLatestNpmVersion(packageName: string): string;
export declare function npmPackageExists(packageName: string): boolean;
export declare function getLatestNpmVersionAsync(packageName: string): Promise<string>;
export declare function parseGlobalPkgSource(pkg: {
    version?: string;
    resolved?: string;
    path?: string;
}, globalDir: string): {
    source: string;
    specifier: string;
} | null;
export declare function fetchAllGlobalInstallSources(): Map<string, {
    source: string;
    specifier: string;
}>;
export declare function fetchAllGlobalInstallSourcesAsync(): Promise<Map<string, {
    source: string;
    specifier: string;
}>>;
export declare function getGlobalInstallSource(packageName?: string): {
    source: string;
    specifier: string;
} | null;
//# sourceMappingURL=remote.d.ts.map