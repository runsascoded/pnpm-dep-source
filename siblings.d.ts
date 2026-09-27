import type { Config } from './types.js';
export interface UnregisteredSibling {
    /** The unregistered `package.json` dependency. */
    name: string;
    /** Its package directory (absolute). */
    dir: string;
    /** The repo it shares with registered deps: `github`/`gitlab` slug, else the repo's local path. */
    repo: string;
    /** Registered deps from the same repo, sorted. */
    registered: string[];
    /** Workspace root enclosing the siblings, if any (for `pds init <monorepo-root>`). */
    monorepoRoot?: string;
}
export declare function findUnregisteredSiblings(projectRoot: string, config: Config, pkg: Record<string, unknown>): UnregisteredSibling[];
export declare function formatSiblingWarning(s: UnregisteredSibling, cwd?: string): string;
/** Warn (stderr, once per process) about unregistered repo siblings. Never throws. */
export declare function warnUnregisteredSiblings(projectRoot: string, config: Config): void;
//# sourceMappingURL=siblings.d.ts.map