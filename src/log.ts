export type LogLevel = 'debug' | 'warn' | 'error' | 'none'

const LEVELS: Record<LogLevel, number> = { debug: 0, warn: 1, error: 2, none: 3 }

let level: LogLevel | undefined

export function getLogLevel(): LogLevel {
  if (level !== undefined) return level
  const env = process.env.PDS_LOG_LEVEL?.toLowerCase()
  if (env && env in LEVELS) return env as LogLevel
  return 'warn'
}

export function setLogLevel(l: LogLevel): void { level = l }

export function getRetries(): number {
  const env = process.env.PDS_RETRIES
  if (env !== undefined) {
    const n = parseInt(env, 10)
    if (!isNaN(n) && n >= 0) return n
  }
  return 1
}

let retries: number | undefined
export function setRetries(n: number): void { retries = n }
export function getConfiguredRetries(): number {
  if (retries !== undefined) return retries
  return getRetries()
}

function shouldLog(msgLevel: LogLevel): boolean {
  return LEVELS[msgLevel] >= LEVELS[getLogLevel()]
}

export const log = {
  debug(...args: unknown[]): void {
    if (shouldLog('debug')) console.error('[pds:debug]', ...args)
  },
  warn(...args: unknown[]): void {
    if (shouldLog('warn')) console.error('[pds:warn]', ...args)
  },
  error(...args: unknown[]): void {
    if (shouldLog('error')) console.error('[pds:error]', ...args)
  },
}
