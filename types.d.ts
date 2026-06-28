export interface DepConfig {
    localPath?: string;
    github?: string;
    gitlab?: string;
    npm?: string;
    distBranch?: string;
    noDist?: boolean;
    subdir?: string;
    override?: boolean;
}
export interface Config {
    dependencies: Record<string, DepConfig>;
    skipCheck?: boolean;
    checkOn?: "pre-push" | "pre-commit" | "none";
    retries?: number;
    logLevel?: "debug" | "info" | "warn" | "error" | "none";
}
export interface WorkspaceConfig {
    packages?: string[];
}
export interface PackageInfo {
    name: string;
    private?: boolean;
    github?: string;
    gitlab?: string;
}
export interface DepDisplayInfo {
    name: string;
    currentSource: string;
    currentSpecifier?: string;
    sourceType: 'local' | 'github' | 'gitlab' | 'cr' | 'npm' | 'unknown';
    isDev?: boolean;
    isGlobal?: boolean;
    version?: string;
    gitInfo?: {
        sha: string;
        dirty: boolean;
    } | null;
    committedSource?: string;
    config: DepConfig;
}
export type RemoteVersions = {
    npm?: string;
    npmSourceSha?: string;
    github?: string;
    githubVersion?: string;
    gitlab?: string;
    gitlabVersion?: string;
    githubDistMissing?: boolean;
    gitlabDistMissing?: boolean;
    committedDistSha?: string;
    committedDistVersion?: string;
    localAheadOfPinned?: number;
    distAheadOfPinned?: number;
    pinnedAheadOfDist?: number;
    npmAheadOfDist?: number;
    distAheadOfNpm?: number;
    pinnedSrcMissing?: boolean;
};
export interface HooksConfig {
    previousHooksPath?: string;
}
//# sourceMappingURL=types.d.ts.map