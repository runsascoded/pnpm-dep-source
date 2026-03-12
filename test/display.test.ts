import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { DepConfig, DepDisplayInfo, RemoteVersions } from '../src/types.js'
import {
  getSourceType, extractSourceSha,
  formatAheadCount, formatAheadBehind, formatGitInfo,
  getActiveParts, formatActiveSuffix, displayDep,
} from '../src/display.js'
import { parseDistSourceSha, countNpmVersionsBetween, baseVersion } from '../src/remote.js'

// In non-TTY (test) mode, all ANSI codes are empty strings,
// so output is plain text — no stripping needed.

describe('getSourceType', () => {
  it('returns local for workspace:*', () => {
    expect(getSourceType('workspace:*')).toBe('local')
  })
  it('returns local for "local"', () => {
    expect(getSourceType('local')).toBe('local')
  })
  it('returns github for github: prefix', () => {
    expect(getSourceType('github:user/repo#abc1234')).toBe('github')
  })
  it('returns github for github.com URL', () => {
    expect(getSourceType('https://github.com/user/repo#abc1234')).toBe('github')
  })
  it('returns gitlab for gitlab archive URL', () => {
    expect(getSourceType('https://gitlab.com/user/repo/-/archive/abc1234/repo-abc1234.tar.gz')).toBe('gitlab')
  })
  it('returns npm for semver range', () => {
    expect(getSourceType('^1.0.0')).toBe('npm')
  })
  it('returns npm for plain version', () => {
    expect(getSourceType('1.0.0')).toBe('npm')
  })
  it('returns npm for latest', () => {
    expect(getSourceType('latest')).toBe('npm')
  })
  it('returns unknown for unrecognized', () => {
    expect(getSourceType('(not found)')).toBe('unknown')
  })
})

describe('parseDistSourceSha', () => {
  it('extracts sha from dist version', () => {
    expect(parseDistSourceSha('0.1.0-dist.5926331')).toBe('5926331')
  })
  it('extracts longer sha', () => {
    expect(parseDistSourceSha('1.2.3-dist.abc1234def5678')).toBe('abc1234def5678')
  })
  it('returns undefined for plain semver', () => {
    expect(parseDistSourceSha('1.0.0')).toBeUndefined()
  })
  it('returns undefined for non-dist prerelease', () => {
    expect(parseDistSourceSha('1.0.0-beta.1')).toBeUndefined()
  })
})

describe('extractSourceSha', () => {
  it('extracts sha from github source', () => {
    expect(extractSourceSha('https://github.com/user/repo#abcdef1234567')).toBe('abcdef1')
  })
  it('extracts sha from github: prefix source', () => {
    expect(extractSourceSha('github:user/repo#abcdef1234567')).toBe('abcdef1')
  })
  it('extracts sha from gitlab archive URL', () => {
    expect(extractSourceSha('https://gitlab.com/user/repo/-/archive/abcdef1234567/repo-abcdef1234567.tar.gz')).toBe('abcdef1')
  })
  it('returns undefined for npm source', () => {
    expect(extractSourceSha('^1.0.0')).toBeUndefined()
  })
  it('returns undefined for workspace source', () => {
    expect(extractSourceSha('workspace:*')).toBeUndefined()
  })
})

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

describe('baseVersion', () => {
  it('strips dist suffix', () => {
    expect(baseVersion('0.12.0-dist.3ee3953')).toBe('0.12.0')
  })
  it('passes through clean semver', () => {
    expect(baseVersion('1.2.3')).toBe('1.2.3')
  })
  it('strips any pre-release suffix', () => {
    expect(baseVersion('2.0.0-beta.1')).toBe('2.0.0')
  })
})

describe('countNpmVersionsBetween', () => {
  const versions = ['0.8.0', '0.9.0', '0.10.0', '0.11.0', '0.12.0']

  it('returns 0 when from === to', () => {
    expect(countNpmVersionsBetween(versions, '0.10.0', '0.10.0')).toBe(0)
  })
  it('counts versions between', () => {
    expect(countNpmVersionsBetween(versions, '0.10.0', '0.12.0')).toBe(2)
  })
  it('returns undefined when from not found', () => {
    expect(countNpmVersionsBetween(versions, '0.7.0', '0.12.0')).toBeUndefined()
  })
  it('returns undefined when to not found', () => {
    expect(countNpmVersionsBetween(versions, '0.10.0', '0.13.0')).toBeUndefined()
  })
  it('returns undefined when to is before from', () => {
    expect(countNpmVersionsBetween(versions, '0.12.0', '0.10.0')).toBeUndefined()
  })
  it('counts single version gap', () => {
    expect(countNpmVersionsBetween(versions, '0.11.0', '0.12.0')).toBe(1)
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

  it('shows local ahead count when in local mode (vs latest dist)', () => {
    const info = mkInfo({
      sourceType: 'local',
      currentSource: 'workspace:*',
      config: { localPath: '../scrns', gitlab: 'runsascoded/js/scrns' },
      gitInfo: { sha: 'ed7262f', dirty: true },
    })
    const versions: RemoteVersions = {
      gitlab: 'c69b691',
      gitlabVersion: '0.3.0-dist.9d846cd',
      localAheadOfPinned: 3,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* Local: ../scrns (ed7262f dirty) +3',
      '  GitLab: runsascoded/js/scrns (dist@c69b691; 0.3.0-dist.9d846cd)',
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

  it('shows npm versions behind count', () => {
    const info = mkInfo({
      sourceType: 'npm',
      currentSource: '^0.10.0',
      version: '0.10.0',
      config: { localPath: undefined, npm: 'test-dep' },
    })
    const versions: RemoteVersions = {
      npm: '0.12.0',
      npmVersionsBehind: 5,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* NPM: test-dep (0.10.0) (latest: 0.12.0) +5',
    ])
  })

  it('shows no npm delta when versions match', () => {
    const info = mkInfo({
      sourceType: 'npm',
      currentSource: '^0.12.0',
      version: '0.12.0',
      config: { localPath: undefined, npm: 'test-dep' },
    })
    const versions: RemoteVersions = {
      npm: '0.12.0',
      npmVersionsBehind: 0,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* NPM: test-dep (0.12.0) (latest: 0.12.0)',
    ])
  })

  it('shows npm source sha and no delta when dist matches npm', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#abc1234',
      version: '0.12.0-dist.abc1234',
      config: { localPath: undefined, github: 'user/repo', npm: 'test-dep' },
    })
    const versions: RemoteVersions = {
      npm: '0.12.0',
      npmSourceSha: 'abc1234def5678',
      npmVersionsBehind: 0,
      github: 'abc1234',
      githubVersion: '0.12.0-dist.abc1234',
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* GitHub: user/repo (abc1234; 0.12.0-dist.abc1234)',
      '  NPM: test-dep (latest: 0.12.0, src: abc1234)',
    ])
  })

  it('shows was/now sub-lines for committed → current transition on gitlab', () => {
    const info = mkInfo({
      sourceType: 'gitlab',
      currentSource: 'https://gitlab.com/user/repo/-/archive/6357eb6/repo-6357eb6.tar.gz',
      committedSource: 'https://gitlab.com/user/repo/-/archive/8ca11d0/repo-8ca11d0.tar.gz',
      version: '0.1.0-dist.88d29d2',
      config: { localPath: undefined, gitlab: 'user/repo' },
    })
    const versions: RemoteVersions = {
      gitlab: '6357eb6',
      gitlabVersion: '0.1.0-dist.88d29d2',
      committedDistSha: '8ca11d0',
      committedDistVersion: '0.1.0-dist.abc1234',
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* GitLab: user/repo',
      '      was: 8ca11d0 (src: abc1234)',
      '      now: 6357eb6 (src: 88d29d2)',
    ])
  })

  it('shows was/now sub-lines for committed → current transition on github', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#bbb2222',
      committedSource: 'https://github.com/user/repo#aaa1111',
      version: '1.0.0-dist.de45678',
      config: { localPath: undefined, github: 'user/repo' },
    })
    const versions: RemoteVersions = {
      github: 'bbb2222',
      githubVersion: '1.0.0-dist.de45678',
      committedDistSha: 'aaa1111',
      committedDistVersion: '1.0.0-dist.ab01234',
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* GitHub: user/repo',
      '      was: aaa1111 (src: ab01234)',
      '      now: bbb2222 (src: de45678)',
    ])
  })

  it('shows latest line when current differs from dist head in transition', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#bbb2222',
      committedSource: 'https://github.com/user/repo#aaa1111',
      version: '1.0.0-dist.de45678',
      config: { localPath: undefined, github: 'user/repo' },
    })
    const versions: RemoteVersions = {
      github: 'ccc3333',
      githubVersion: '1.0.0-dist.eee9999',
      committedDistSha: 'aaa1111',
      committedDistVersion: '1.0.0-dist.ab01234',
      distAheadOfPinned: 2,
    }
    displayDep(info, true, versions)
    expect(logs).toEqual([
      'test-dep:',
      '* GitHub: user/repo',
      '      was: aaa1111 (src: ab01234)',
      '      now: bbb2222 (src: de45678)',
      '      latest: ccc3333; 1.0.0-dist.eee9999 +2',
    ])
  })

  it('no transition when committedSource is undefined', () => {
    const info = mkInfo({
      sourceType: 'github',
      currentSource: 'https://github.com/user/repo#abc1234',
      version: '1.0.0',
      config: { localPath: undefined, github: 'user/repo' },
    })
    displayDep(info)
    expect(logs).toEqual([
      'test-dep:',
      '* GitHub: user/repo (abc1234; 1.0.0)',
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
