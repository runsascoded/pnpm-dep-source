import type { WorkspaceConfig } from './types.js';
export declare function loadPackageJson(projectRoot: string): Record<string, unknown>;
export declare function savePackageJson(projectRoot: string, pkg: Record<string, unknown>): void;
export declare function removePnpmOverride(pkg: Record<string, unknown>, depName: string): void;
export declare function updatePackageJsonDep(pkg: Record<string, unknown>, depName: string, specifier: string): void;
export declare function hasDependency(pkg: Record<string, unknown>, depName: string): boolean;
export declare function addDependency(pkg: Record<string, unknown>, depName: string, specifier: string, isDev: boolean): void;
export declare function removeDependency(pkg: Record<string, unknown>, depName: string): boolean;
export declare function getCurrentSource(pkg: Record<string, unknown>, depName: string): string;
export declare function getInstalledVersion(projectRoot: string, depName: string): string | null;
export declare function loadWorkspaceYaml(projectRoot: string): WorkspaceConfig | null;
export declare function saveWorkspaceYaml(projectRoot: string, config: WorkspaceConfig | null): void;
//# sourceMappingURL=pkg.d.ts.map