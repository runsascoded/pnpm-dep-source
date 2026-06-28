import { describe, expect, it } from 'vitest'

import { parseGlobalPkgSource } from '../src/remote.js'

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
