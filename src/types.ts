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
  config: DepConfig
}

export type RemoteVersions = {
  npm?: string
  github?: string; githubVersion?: string
  gitlab?: string; gitlabVersion?: string
}

export interface HooksConfig {
  previousHooksPath?: string  // Saved core.hooksPath before pds install
}
