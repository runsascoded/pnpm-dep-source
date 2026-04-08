import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { log, getLogLevel, setLogLevel, getRetries, setRetries, getConfiguredRetries } from '../src/log.js'

describe('log levels', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>
  const origEnv = { ...process.env }

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    setLogLevel('warn' as any) // reset
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    process.env = { ...origEnv }
    setLogLevel(undefined as any) // clear override so env is re-read
  })

  it('defaults to warn level', () => {
    delete process.env.PDS_LOG_LEVEL
    setLogLevel(undefined as any)
    expect(getLogLevel()).toBe('warn')
  })

  it('reads PDS_LOG_LEVEL from env', () => {
    process.env.PDS_LOG_LEVEL = 'debug'
    setLogLevel(undefined as any)
    expect(getLogLevel()).toBe('debug')
  })

  it('setLogLevel overrides env', () => {
    process.env.PDS_LOG_LEVEL = 'debug'
    setLogLevel('error')
    expect(getLogLevel()).toBe('error')
  })

  it('log.warn outputs at warn level', () => {
    setLogLevel('warn')
    log.warn('test warning')
    expect(stderrSpy).toHaveBeenCalledWith('[pds:warn]', 'test warning')
  })

  it('log.debug is suppressed at warn level', () => {
    setLogLevel('warn')
    log.debug('test debug')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('log.debug outputs at debug level', () => {
    setLogLevel('debug')
    log.debug('test debug')
    expect(stderrSpy).toHaveBeenCalledWith('[pds:debug]', 'test debug')
  })

  it('none suppresses everything', () => {
    setLogLevel('none')
    log.debug('d')
    log.warn('w')
    log.error('e')
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})

describe('retries config', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...origEnv }
    setRetries(undefined as any) // clear
  })

  it('defaults to 1 retry', () => {
    delete process.env.PDS_RETRIES
    expect(getRetries()).toBe(1)
  })

  it('reads PDS_RETRIES from env', () => {
    process.env.PDS_RETRIES = '3'
    expect(getRetries()).toBe(3)
  })

  it('PDS_RETRIES=0 means no retries', () => {
    process.env.PDS_RETRIES = '0'
    expect(getRetries()).toBe(0)
  })

  it('setRetries overrides env', () => {
    process.env.PDS_RETRIES = '5'
    setRetries(2)
    expect(getConfiguredRetries()).toBe(2)
  })
})
