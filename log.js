const LEVELS = { debug: 0, warn: 1, error: 2, none: 3 };
let level;
export function getLogLevel() {
    if (level !== undefined)
        return level;
    const env = process.env.PDS_LOG_LEVEL?.toLowerCase();
    if (env && env in LEVELS)
        return env;
    return 'warn';
}
export function setLogLevel(l) { level = l; }
export function getRetries() {
    const env = process.env.PDS_RETRIES;
    if (env !== undefined) {
        const n = parseInt(env, 10);
        if (!isNaN(n) && n >= 0)
            return n;
    }
    return 1;
}
let retries;
export function setRetries(n) { retries = n; }
export function getConfiguredRetries() {
    if (retries !== undefined)
        return retries;
    return getRetries();
}
function shouldLog(msgLevel) {
    return LEVELS[msgLevel] >= LEVELS[getLogLevel()];
}
export const log = {
    debug(...args) {
        if (shouldLog('debug'))
            console.error('[pds:debug]', ...args);
    },
    warn(...args) {
        if (shouldLog('warn'))
            console.error('[pds:warn]', ...args);
    },
    error(...args) {
        if (shouldLog('error'))
            console.error('[pds:error]', ...args);
    },
};
//# sourceMappingURL=log.js.map