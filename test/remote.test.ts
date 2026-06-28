import { describe, expect, it } from 'vitest'

import { parseGlobalPkgSource, isNotFoundError, isMissingRef } from '../src/remote.js'

const GLOBAL_DIR = '/g/nm'

describe('parseGlobalPkgSource', () => {
  it('classifies a file: install (copy) as local, resolving the path', () => {
    expect(parseGlobalPkgSource({ version: 'file:../c/js/pds' }, GLOBAL_DIR)).toEqual({
      source: 'local',
      specifier: '/g/c/js/pds',
    })
  })

  it('classifies a link: install (live symlink) as local, resolving the path', () => {
    expect(parseGlobalPkgSource({ version: 'link:../c/js/pds' }, GLOBAL_DIR)).toEqual({
      source: 'local',
      specifier: '/g/c/js/pds',
    })
  })

  it('classifies a github tarball install as github', () => {
    expect(parseGlobalPkgSource(
      { version: '0.4.0', resolved: 'https://codeload.github.com/runsascoded/pnpm-dep-source/tar.gz/f93b15258b9e8366de5822221c57fe428a5ee52b' },
      GLOBAL_DIR,
    )).toEqual({ source: 'github', specifier: 'f93b152; 0.4.0' })
  })

  it('classifies a plain version as npm', () => {
    expect(parseGlobalPkgSource({ version: '0.4.0' }, GLOBAL_DIR)).toEqual({
      source: 'npm',
      specifier: '0.4.0',
    })
  })
})

describe('isNotFoundError', () => {
  it('matches a missing GitHub ref (HTTP 422)', () => {
    expect(isNotFoundError('Failed to resolve GitHub ref "dist" for Open-Athena/slidev: gh: No commit found for SHA: dist (HTTP 422)')).toBe(true)
  })
  it('matches a missing GitHub package.json (HTTP 404)', () => {
    expect(isNotFoundError('Failed to fetch package.json from GitHub Open-Athena/slidev: gh: No commit found for the ref dist (HTTP 404)')).toBe(true)
  })
  it('matches a GitLab 404 Not Found', () => {
    expect(isNotFoundError('Failed to resolve GitLab ref "dist" for grp/proj: 404 Not Found')).toBe(true)
  })
  it('does not match a transient/rate-limit error', () => {
    expect(isNotFoundError('Failed to resolve GitHub ref "dist" for o/r: gh: HTTP 503 (rate limited)')).toBe(false)
  })
  it('does not match a network error', () => {
    expect(isNotFoundError('connect ETIMEDOUT api.github.com:443')).toBe(false)
  })
})

describe('isMissingRef', () => {
  it('matches a missing GitHub ref (repo exists)', () => {
    expect(isMissingRef('Failed to resolve GitHub ref "dist" for o/r: gh: No commit found for the ref dist (HTTP 404)')).toBe(true)
    expect(isMissingRef('gh: No commit found for SHA: dist (HTTP 422)')).toBe(true)
  })
  it('matches a missing GitLab commit', () => {
    expect(isMissingRef('glab: 404 Commit Not Found')).toBe(true)
  })
  it('does NOT match a missing repo (bare Not Found) — must not be mistaken for noDist', () => {
    expect(isMissingRef('Failed to resolve GitHub ref "dist" for typo/repo: gh: Not Found (HTTP 404)')).toBe(false)
  })
  it('does NOT match a transient error', () => {
    expect(isMissingRef('gh: HTTP 503 (rate limited)')).toBe(false)
  })
})
