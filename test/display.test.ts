import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { DepConfig, DepDisplayInfo, RemoteVersions } from '../src/types.js'
import {
  formatAheadCount, formatAheadBehind, formatGitInfo,
  getActiveParts, formatActiveSuffix, displayDep,
} from '../src/display.js'

// In non-TTY (test) mode, all ANSI codes are empty strings,
// so output is plain text — no stripping needed.

describe('formatAheadCount', () => {
  it('returns empty for undefined', () => {
    expect(formatAheadCount(undefined)).toBe('')
  })
  it('returns empty for 0', () => {
    expect(formatAheadCount(0)).toBe('')
  })
  it('returns +N for positive', () => {
    expect(formatAheadCount(3)).toBe('+3')
  })
})

describe('formatAheadBehind', () => {
  it('returns empty for no counts', () => {
    expect(formatAheadBehind(undefined, undefined)).toBe('')
  })
  it('returns empty for zeros', () => {
    expect(formatAheadBehind(0, 0)).toBe('')
  })
  it('returns +N for ahead only', () => {
    expect(formatAheadBehind(3, 0)).toBe(' +3')
  })
  it('returns -N for behind only', () => {
    expect(formatAheadBehind(0, 2)).toBe(' -2')
  })
  it('returns +M-N for both', () => {
    expect(formatAheadBehind(3, 2)).toBe(' +3-2')
  })
})

describe('formatGitInfo', () => {
  it('returns empty for null', () => {
    expect(formatGitInfo(null)).toBe('')
  })
  it('shows sha', () => {
    expect(formatGitInfo({ sha: 'abc1234', dirty: false })).toBe(' (abc1234)')
  })
  it('shows sha + dirty', () => {
    expect(formatGitInfo({ sha: 'abc1234', dirty: true })).toBe(' (abc1234 dirty)')
  })
})

describe('getActiveParts', () => {
  it('returns empty for local source', () => {
    const info = mkInfo({ sourceType: 'local', currentSource: 'workspace:*' })
    expect(getActiveParts(info)).toEqual([])
  })
  it('extracts sha from github source', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#abcdef1234567',
      version: '1.0.0-dist.xyz',
    })
    expect(getActiveParts(info)).toEqual(['abcdef1', '1.0.0-dist.xyz'])
  })
  it('extracts sha from gitlab source', () => {
    const info = mkInfo({
      sourceType: 'gitlab',
      currentSource: 'https://gitlab.com/user/repo/-/archive/abcdef1234567/repo-abcdef1234567.tar.gz',
      version: '2.0.0',
    })
    expect(getActiveParts(info)).toEqual(['abcdef1', '2.0.0'])
  })
  it('uses currentSpecifier for global deps', () => {
    const info = mkInfo({
      sourceType: 'github',
      isGlobal: true,
      currentSpecifier: 'https://github.com/user/repo#abc1234',
    })
    expect(getActiveParts(info)).toEqual(['https://github.com/user/repo#abc1234'])
  })
})

describe('formatActiveSuffix', () => {
  it('wraps parts in parentheses', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#abcdef1234567',
      version: '1.0.0',
    })
    expect(formatActiveSuffix(info)).toBe(' (abcdef1; 1.0.0)')
  })
  it('returns empty for local', () => {
    expect(formatActiveSuffix(mkInfo({ sourceType: 'local' }))).toBe('')
  })
})

describe('displayDep', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows basic local active dep', () => {
    const info = mkInfo({
      sourceType: 'local',
      currentSource: 'workspace:*',
      config: { localPath: '../my-dep', github: 'user/repo' },
      gitInfo: { sha: 'abc1234', dirty: false },
    })
    displayDep(info)
    expect(logs).toEqual([
      'test-dep:',
      '* Local: ../my-dep (abc1234)',
      '  GitHub: user/repo',
    ])
  })

  it('shows github active with same pinned/latest (single line)', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#abcdef1',
      version: '1.0.0-dist.abc1234',
      config: { localPath: '../my-dep', github: 'user/repo' },
    })
    const versions: RemoteVersions = {
      github: 'abcdef1',
      githubVersion: '1.0.0-dist.abc1234',
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '  Local: ../my-dep',
      '* GitHub: user/repo (abcdef1; 1.0.0-dist.abc1234)',
    ])
  })

  it('shows github active with different pinned/latest (sub-lines)', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#aaaaaaa',
      version: '1.0.0-dist.old1234',
      config: { localPath: '../my-dep', github: 'user/repo' },
    })
    const versions: RemoteVersions = {
      github: 'bbbbbbb',
      githubVersion: '1.0.0-dist.new5678',
      distAheadOfPinned: 3,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '  Local: ../my-dep',
      '* GitHub: user/repo',
      '      pinned: aaaaaaa; 1.0.0-dist.old1234',
      '      latest: bbbbbbb; 1.0.0-dist.new5678 +3',
    ])
  })

  it('shows github active with pinned ahead of dist (red -N)', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#aaaaaaa',
      version: '1.0.0-dist.new5678',
      config: { localPath: undefined, github: 'user/repo' },
    })
    const versions: RemoteVersions = {
      github: 'bbbbbbb',
      githubVersion: '1.0.0-dist.old1234',
      pinnedAheadOfDist: 2,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* GitHub: user/repo',
      '      pinned: aaaaaaa; 1.0.0-dist.new5678',
      '      latest: bbbbbbb; 1.0.0-dist.old1234 -2',
    ])
  })

  it('shows github active with both ahead and behind (+M-N)', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#aaaaaaa',
      version: '1.0.0-dist.aaa1111',
      config: { localPath: undefined, github: 'user/repo' },
    })
    const versions: RemoteVersions = {
      github: 'bbbbbbb',
      githubVersion: '1.0.0-dist.bbb2222',
      distAheadOfPinned: 5,
      pinnedAheadOfDist: 1,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* GitHub: user/repo',
      '      pinned: aaaaaaa; 1.0.0-dist.aaa1111',
      '      latest: bbbbbbb; 1.0.0-dist.bbb2222 +5-1',
    ])
  })

  it('shows non-active github with dist info', () => {
    const info = mkInfo({
      sourceType: 'local',
      currentSource: 'workspace:*',
      config: { localPath: '../my-dep', github: 'user/repo' },
      gitInfo: { sha: 'abc1234', dirty: false },
    })
    const versions: RemoteVersions = {
      github: 'ddd4444',
      githubVersion: '2.0.0-dist.eee5555',
      distAheadOfPinned: 2,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* Local: ../my-dep (abc1234)',
      '  GitHub: user/repo (dist@ddd4444; 2.0.0-dist.eee5555) +2',
    ])
  })

  it('shows local ahead count', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#abcdef1',
      version: '1.0.0-dist.abc1234',
      config: { localPath: '../my-dep', github: 'user/repo' },
      gitInfo: { sha: 'fff6666', dirty: true },
    })
    const versions: RemoteVersions = {
      github: 'abcdef1',
      githubVersion: '1.0.0-dist.abc1234',
      localAheadOfPinned: 7,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '  Local: ../my-dep (fff6666 dirty) +7',
      '* GitHub: user/repo (abcdef1; 1.0.0-dist.abc1234)',
    ])
  })

  it('shows subdir suffix', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#abcdef1',
      version: '1.0.0',
      config: { localPath: undefined, github: 'user/repo', subdir: '/packages/client' },
    })
    displayDep(info)
    expect(logs).toEqual([
      'test-dep:',
      '* GitHub: user/repo [/packages/client] (abcdef1; 1.0.0)',
    ])
  })

  it('shows dev tag', () => {
    const info = mkInfo({
      sourceType: 'local',
      currentSource: 'workspace:*',
      isDev: true,
      config: { localPath: '../dep' },
    })
    displayDep(info)
    expect(logs).toEqual([
      'test-dep [dev]:',
      '* Local: ../dep',
    ])
  })

  it('shows global tag', () => {
    const info = mkInfo({
      sourceType: 'github',
      isGlobal: true,
      currentSource: 'github',
      currentSpecifier: 'https://github.com/user/repo#abc1234',
      config: { localPath: '/abs/path', github: 'user/repo' },
    })
    displayDep(info)
    expect(logs).toEqual([
      'test-dep [global]:',
      '  Local: /abs/path',
      '* GitHub: user/repo (https://github.com/user/repo#abc1234)',
    ])
  })

  it('shows npm with latest version', () => {
    const info = mkInfo({
      sourceType: 'npm',
      currentSource: '^1.0.0',
      version: '1.0.5',
      config: { localPath: undefined, npm: 'test-dep', github: 'user/repo' },
    })
    const versions: RemoteVersions = {
      npm: '1.2.0',
      github: 'abc1234',
      githubVersion: '1.2.0-dist.def5678',
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '  GitHub: user/repo (dist@abc1234; 1.2.0-dist.def5678)',
      '* NPM: test-dep (1.0.5) (latest: 1.2.0)',
    ])
  })

  it('omits npm line when no published version and not active', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#abc1234',
      version: '1.0.0',
      config: { localPath: undefined, github: 'user/repo', npm: 'test-dep' },
    })
    const versions: RemoteVersions = {}
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* GitHub: user/repo (abc1234; 1.0.0)',
    ])
  })

  it('shows gitlab active with different pinned/latest', () => {
    const info = mkInfo({
      sourceType: 'gitlab',
      currentSource: 'https://gitlab.com/user/repo/-/archive/aaaaaaa/repo-aaaaaaa.tar.gz',
      version: '1.0.0-dist.old1234',
      config: { localPath: undefined, gitlab: 'user/repo' },
    })
    const versions: RemoteVersions = {
      gitlab: 'bbbbbbb',
      gitlabVersion: '1.0.0-dist.new5678',
      distAheadOfPinned: 4,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* GitLab: user/repo',
      '      pinned: aaaaaaa; 1.0.0-dist.old1234',
      '      latest: bbbbbbb; 1.0.0-dist.new5678 +4',
    ])
  })
})

function mkInfo(overrides: Partial<DepDisplayInfo> & { config?: Partial<DepConfig> } = {}): DepDisplayInfo {
  const { config: configOverrides, ...rest } = overrides
  return {
    name: 'test-dep',
    currentSource: 'workspace:*',
    sourceType: 'local',
    config: { localPath: '../test-dep', ...configOverrides },
    ...rest,
  }
}
