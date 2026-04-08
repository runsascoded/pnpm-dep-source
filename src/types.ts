export interface DepConfig {
  localPath?: string    // optional when initialized from URL
  github?: string       // e.g. "runsascoded/use-kbd"
  gitlab?: string       // e.g. "runsascoded/js/screenshots"
  npm?: string          // e.g. "use-kbd" (defaults to package name from local)
  distBranch?: string   // defaults to "dist"
  subdir?: string       // e.g. "/packages/client" for monorepo subdirectory
}

export interface Config {
  dependencies: Record<string, DepConfig>
  skipCheck?: boolean  // Deprecated: use checkOn: "none" instead
  checkOn?: "pre-push" | "pre-commit" | "none"
  retries?: number     // API call retries (default: 1, env: PDS_RETRIES)
  logLevel?: "debug" | "warn" | "error" | "none"  // (default: "warn", env: PDS_LOG_LEVEL)
}

export interface WorkspaceConfig {
  packages?: string[]
}

export interface PackageInfo {
  name: string
  private?: boolean
  github?: string  // "user/repo" format
  gitlab?: string  // "group/subgroup/repo" format
}

// Unified display info for a dependency
export interface DepDisplayInfo {
  name: string
  currentSource: string        // e.g. "workspace:*", "github:user/repo#sha", or "local"
  currentSpecifier?: string    // For global mode: the path or version
  sourceType: 'local' | 'github' | 'gitlab' | 'npm' | 'unknown'
  isDev?: boolean              // Whether it's a devDependency
  isGlobal?: boolean           // Whether it's a global dependency
  version?: string             // Installed version from node_modules
  gitInfo?: { sha: string; dirty: boolean } | null
  committedSource?: string     // Source from HEAD (when different from working tree)
  config: DepConfig
}

export type RemoteVersions = {
  npm?: string; npmSourceSha?: string
  github?: string; githubVersion?: string
  gitlab?: string; gitlabVersion?: string
  committedDistSha?: string     // dist SHA from committed (HEAD) package.json
  committedDistVersion?: string // version from committed dist SHA's package.json
  localAheadOfPinned?: number   // commits in local HEAD not in pinned source
  distAheadOfPinned?: number    // commits in latest dist source not in pinned source
  pinnedAheadOfDist?: number    // commits in pinned source not in latest dist (diverged)
  npmAheadOfDist?: number       // commits in npm source not in latest dist source
  distAheadOfNpm?: number       // commits in latest dist source not in npm source
}

export interface HooksConfig {
  previousHooksPath?: string  // Saved core.hooksPath before pds install
}
