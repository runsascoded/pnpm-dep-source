import type { DepConfig, DepDisplayInfo, RemoteVersions } from './types.js';
export declare function getSourceType(source: string): 'local' | 'github' | 'gitlab' | 'npm' | 'unknown';
export declare function formatGitInfo(info: {
    sha: string;
    dirty: boolean;
} | null): string;
export declare function formatActiveSuffix(info: DepDisplayInfo): string;
export declare function displayDep(info: DepDisplayInfo, verbose?: boolean, remoteVersions?: RemoteVersions): void;
export declare function buildGlobalDepInfo(name: string, dep: DepConfig): DepDisplayInfo;
export declare function buildProjectDepInfo(name: string, dep: DepConfig, projectRoot: string, pkg: Record<string, unknown>): DepDisplayInfo;
export declare function buildGlobalDepInfoAsync(name: string, dep: DepConfig, globalSources: Map<string, {
    source: string;
    specifier: string;
}>): Promise<DepDisplayInfo>;
export declare function buildProjectDepInfoAsync(name: string, dep: DepConfig, projectRoot: string, pkg: Record<string, unknown>): Promise<DepDisplayInfo>;
export declare function fetchRemoteVersionsAsync(dep: DepConfig, depName: string): Promise<RemoteVersions>;
export declare function fetchRemoteVersions(dep: DepConfig, depName: string): RemoteVersions;
//# sourceMappingURL=display.d.ts.map