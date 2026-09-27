import type { DepConfig } from './types.js';
import { type ViteEditStatus } from './vite-config.js';
export declare function makeLinkSpecifier(projectRoot: string, root: string, localPath: string): string;
export declare function updateViteConfig(projectRoot: string, depName: string, exclude: boolean): ViteEditStatus | undefined;
export declare function makeGitHubSpecifier(repo: string, ref: string, subdir?: string): string;
export declare function makeGitLabTarballUrl(gitlab: string, ref: string): string;
export declare function makePkgPrNewSpecifier(repo: string, npm: string, sha: string): string;
export declare function switchToLocal(projectRoot: string, depName: string, depConfig: DepConfig, workspaceRoot?: string | null): void;
export declare function switchToGitHub(projectRoot: string, depName: string, depConfig: DepConfig, ref?: string, workspaceRoot?: string | null): void;
export declare function switchToGitLab(projectRoot: string, depName: string, depConfig: DepConfig, ref?: string, workspaceRoot?: string | null): void;
export declare function switchToPkgPrNew(projectRoot: string, depName: string, depConfig: DepConfig, resolvedSha: string, workspaceRoot?: string | null): void;
export declare function switchToNpm(projectRoot: string, depName: string, depConfig: DepConfig, specifier: string, workspaceRoot?: string | null): void;
export declare function cleanupDepReferences(projectRoot: string, depName: string, depConfig: DepConfig, workspaceRoot?: string | null): void;
export declare function runPnpmInstall(projectRoot: string, workspaceRoot?: string | null): void;
export declare function runGlobalInstall(specifier: string): void;
export type InstallSource = 'local' | 'github' | 'gitlab' | 'cr' | 'npm';
export interface GlobalInstallOpts {
    /** Ref to resolve to a SHA (default: the dist branch; `HEAD` for `cr`). */
    ref?: string;
    /** Ref used as-is (unresolved). */
    rawRef?: string;
    /** npm version (default: latest). */
    version?: string;
}
/** What a global install of `depName` from `source` installs, and how to describe it. */
export declare function globalInstallTarget(depName: string, depConfig: DepConfig, source: InstallSource, opts?: GlobalInstallOpts): {
    specifier: string;
    label: string;
};
/** Install `depName` globally from `source` (or, with `dryRun`, just print it). Returns the specifier. */
export declare function installGlobal(depName: string, depConfig: DepConfig, source: InstallSource, opts?: GlobalInstallOpts & {
    dryRun?: boolean;
}): string;
//# sourceMappingURL=switch.d.ts.map