import type { DepConfig } from './types.js';
export declare function makeLinkSpecifier(projectRoot: string, root: string, localPath: string): string;
export declare function updateViteConfig(projectRoot: string, depName: string, exclude: boolean): void;
export declare function makeGitHubSpecifier(repo: string, ref: string, subdir?: string): string;
export declare function makePkgPrNewSpecifier(repo: string, npm: string, sha: string): string;
export declare function switchToLocal(projectRoot: string, depName: string, depConfig: DepConfig, workspaceRoot?: string | null): void;
export declare function switchToGitHub(projectRoot: string, depName: string, depConfig: DepConfig, ref?: string, workspaceRoot?: string | null): void;
export declare function switchToGitLab(projectRoot: string, depName: string, depConfig: DepConfig, ref?: string, workspaceRoot?: string | null): void;
export declare function switchToPkgPrNew(projectRoot: string, depName: string, depConfig: DepConfig, resolvedSha: string, workspaceRoot?: string | null): void;
export declare function switchToNpm(projectRoot: string, depName: string, depConfig: DepConfig, specifier: string, workspaceRoot?: string | null): void;
export declare function cleanupDepReferences(projectRoot: string, depName: string, depConfig: DepConfig, workspaceRoot?: string | null): void;
export declare function runPnpmInstall(projectRoot: string, workspaceRoot?: string | null): void;
export declare function runGlobalInstall(specifier: string): void;
//# sourceMappingURL=switch.d.ts.map