import type { DepConfig } from './types.js';
export declare function updateViteConfig(projectRoot: string, depName: string, exclude: boolean): void;
export declare function makeGitHubSpecifier(repo: string, ref: string, subdir?: string): string;
export declare function switchToLocal(projectRoot: string, depName: string, localPath: string, workspaceRoot?: string | null): void;
export declare function switchToGitHub(projectRoot: string, depName: string, depConfig: DepConfig, ref?: string, workspaceRoot?: string | null): void;
export declare function switchToGitLab(projectRoot: string, depName: string, depConfig: DepConfig, ref?: string, workspaceRoot?: string | null): void;
export declare function cleanupDepReferences(projectRoot: string, depName: string, depConfig: DepConfig, workspaceRoot?: string | null): void;
export declare function runPnpmInstall(projectRoot: string, workspaceRoot?: string | null): void;
export declare function runGlobalInstall(specifier: string): void;
//# sourceMappingURL=switch.d.ts.map