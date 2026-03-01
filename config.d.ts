import type { Config, DepConfig, HooksConfig } from './types.js';
export declare function loadConfig(projectRoot: string): Config;
export declare function saveConfig(projectRoot: string, config: Config): void;
export declare function loadGlobalConfig(): Config;
export declare function saveGlobalConfig(config: Config): void;
export declare function findMatchingDep(config: Config, query?: string): [string, DepConfig];
export declare function loadHooksConfig(): HooksConfig;
export declare function saveHooksConfig(config: HooksConfig): void;
//# sourceMappingURL=config.d.ts.map