import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolveConfigPath, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE, HOOKS_CONFIG_FILE } from './constants.js';
export function loadConfig(projectRoot) {
    const configPath = resolveConfigPath(projectRoot);
    if (!existsSync(configPath)) {
        return { dependencies: {} };
    }
    return JSON.parse(readFileSync(configPath, 'utf-8'));
}
export function saveConfig(projectRoot, config) {
    const configPath = resolveConfigPath(projectRoot);
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
export function loadGlobalConfig() {
    if (!existsSync(GLOBAL_CONFIG_FILE)) {
        return { dependencies: {} };
    }
    return JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, 'utf-8'));
}
export function saveGlobalConfig(config) {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
    }
    writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}
export function findMatchingDep(config, query) {
    const deps = Object.entries(config.dependencies);
    if (!query) {
        // No query - default to single dep if there's exactly one
        if (deps.length === 0) {
            throw new Error('No dependencies configured. Use "pds init <path>" to add one.');
        }
        if (deps.length === 1) {
            return deps[0];
        }
        throw new Error(`Multiple dependencies configured. Specify one: ${deps.map(([n]) => n).join(', ')}`);
    }
    const queryLower = query.toLowerCase();
    // First, check for exact match (case-insensitive)
    const exactMatch = deps.find(([name]) => name.toLowerCase() === queryLower);
    if (exactMatch) {
        return exactMatch;
    }
    // Fall back to substring matching
    const matches = deps.filter(([name]) => name.toLowerCase().includes(queryLower));
    if (matches.length === 0) {
        throw new Error(`No dependency matching "${query}" found in config`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous match "${query}" - matches: ${matches.map(([n]) => n).join(', ')}`);
    }
    return matches[0];
}
export function loadHooksConfig() {
    if (!existsSync(HOOKS_CONFIG_FILE)) {
        return {};
    }
    return JSON.parse(readFileSync(HOOKS_CONFIG_FILE, 'utf-8'));
}
export function saveHooksConfig(config) {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
    }
    writeFileSync(HOOKS_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}
//# sourceMappingURL=config.js.map