export interface DepConfig {
    localPath?: string;
    github?: string;
    gitlab?: string;
    npm?: string;
    distBranch?: string;
    subdir?: string;
}
export interface Config {
    dependencies: Record<string, DepConfig>;
    skipCheck?: boolean;
    checkOn?: "pre-push" | "pre-commit" | "none";
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
    sourceType: 'local' | 'github' | 'gitlab' | 'npm' | 'unknown';
    isDev?: boolean;
    isGlobal?: boolean;
    version?: string;
    gitInfo?: {
        sha: string;
        dirty: boolean;
    } | null;
    config: DepConfig;
}
export type RemoteVersions = {
    npm?: string;
    github?: string;
    githubVersion?: string;
    gitlab?: string;
    gitlabVersion?: string;
};
export interface HooksConfig {
    previousHooksPath?: string;
}
//# sourceMappingURL=types.d.ts.map