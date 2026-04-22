export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';
export declare function getLogLevel(): LogLevel;
export declare function setLogLevel(l: LogLevel): void;
export declare function getRetries(): number;
export declare function setRetries(n: number): void;
export declare function getConfiguredRetries(): number;
export declare const log: {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
};
//# sourceMappingURL=log.d.ts.map