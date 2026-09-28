import { spawnSync } from 'child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generateHookScript } from '../src/hooks.js'

const ROOT = join(__dirname, 'fixtures', 'hooks')
const HOOKS = join(ROOT, 'global-hooks')
const PREV = join(ROOT, 'prev-hooks')
const BIN = join(ROOT, 'bin')
const LOG = join(ROOT, 'log')
const REPO = join(ROOT, 'repo')
const WT = join(REPO, 'wt', 'feat')
const REMOTE = join(ROOT, 'remote.git')

// Isolated from the user's git config (which may set `core.hooksPath`)
const env = {
  ...process.env,
  PATH: `${BIN}:${process.env.PATH}`,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r
}

function writeExe(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}`)
  chmodSync(path, 0o755)
}

// A hook that logs its name, args, and stdin
const logger = (name: string) => `echo "${name} args: $*" >> ${LOG}
while read -r line; do echo "${name} stdin: $line" >> ${LOG}; done
`

function installHooks(previousHooksPath?: string): void {
  mkdirSync(HOOKS, { recursive: true })
  for (const hookType of ['pre-push', 'pre-commit']) {
    writeExe(join(HOOKS, hookType), generateHookScript(hookType, previousHooksPath).replace(/^#!\/bin\/sh\n/, ''))
  }
}

const readLog = () => readFileSync(LOG, 'utf-8').trimEnd().split('\n')

function push(cwd: string) {
  return spawnSync('git', ['-c', `core.hooksPath=${HOOKS}`, 'push', 'r', 'HEAD:refs/heads/feat'], { cwd, env, encoding: 'utf-8' })
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  writeExe(join(BIN, 'pds'), `echo "pds $*" >> ${LOG}\n`)
  writeFileSync(LOG, '')
  git(ROOT, 'init', '-q', '--bare', REMOTE)
  git(ROOT, 'init', '-q', '-b', 'main', REPO)
  git(REPO, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(REPO, 'remote', 'add', 'r', REMOTE)
  git(REPO, 'worktree', 'add', '-q', '-b', 'feat', WT)
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('generated hooks', () => {
  it('chain to the repo hook from a linked worktree, with args and stdin', () => {
    installHooks()
    writeExe(join(REPO, '.git', 'hooks', 'pre-push'), logger('local'))
    const sha = git(WT, 'rev-parse', 'HEAD').stdout.trim()
    const r = push(WT)
    expect(r.status).toBe(0)
    expect(readLog()).toEqual([
      'pds check --hook pre-push',
      `local args: r ${REMOTE}`,
      `local stdin: HEAD ${sha} refs/heads/feat 0000000000000000000000000000000000000000`,
    ])
  })

  it('give the previous global hook and the repo hook the same args and stdin', () => {
    mkdirSync(PREV)
    writeExe(join(PREV, 'pre-push'), logger('prev'))
    installHooks(PREV)
    writeExe(join(REPO, '.git', 'hooks', 'pre-push'), logger('local'))
    const sha = git(REPO, 'rev-parse', 'HEAD').stdout.trim()
    const refs = `HEAD ${sha} refs/heads/feat 0000000000000000000000000000000000000000`
    expect(push(REPO).status).toBe(0)
    expect(readLog()).toEqual([
      'pds check --hook pre-push',
      `prev args: r ${REMOTE}`,
      `prev stdin: ${refs}`,
      `local args: r ${REMOTE}`,
      `local stdin: ${refs}`,
    ])
  })

  it("don't loop when the repo hook chains back into the global hooks", () => {
    installHooks()
    writeExe(join(REPO, '.git', 'hooks', 'pre-push'), `echo "local args: $*" >> ${LOG}\n${HOOKS}/pre-push "$@"\n`)
    const r = spawnSync('git', ['-c', `core.hooksPath=${HOOKS}`, 'push', 'r', 'HEAD:refs/heads/feat'], { cwd: WT, env, encoding: 'utf-8', timeout: 10_000 })
    expect(r.status).toBe(0)
    expect(readLog()).toEqual([
      'pds check --hook pre-push',
      `local args: r ${REMOTE}`,
    ])
  })

  it('fail the push when the repo hook fails', () => {
    installHooks()
    writeExe(join(REPO, '.git', 'hooks', 'pre-push'), `echo "local args: $*" >> ${LOG}\nexit 1\n`)
    expect(push(WT).status).toBe(1)
    expect(git(REPO, 'ls-remote', 'r').stdout).toBe('')
  })

  it('chain pre-commit with args, from a linked worktree', () => {
    installHooks()
    writeExe(join(REPO, '.git', 'hooks', 'pre-commit'), logger('local'))
    git(WT, '-c', `core.hooksPath=${HOOKS}`, 'commit', '-q', '--allow-empty', '-m', 'x')
    expect(readLog()).toEqual([
      'pds check --hook pre-commit',
      'local args:',
    ])
  })
})
