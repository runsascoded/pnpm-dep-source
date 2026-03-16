import { existsSync, readFileSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { CONFIG_FILES } from './constants.js';
/**
 * Vite plugin that auto-manages resolve aliases, optimizeDeps, and CJS compat
 * for pds local deps. Prevents duplicate React instances, unresolved peer imports
 * across symlink boundaries, and CJS require() failures in the browser.
 */
export function pdsPlugin(options) {
    const root = options?.root ?? process.cwd();
    return {
        name: 'pds-resolve',
        config() {
            const configPath = CONFIG_FILES.map(f => resolve(root, f)).find(existsSync);
            if (!configPath)
                return undefined;
            let config;
            try {
                config = JSON.parse(readFileSync(configPath, 'utf-8'));
            }
            catch {
                return undefined;
            }
            if (!config.dependencies)
                return undefined;
            const aliases = {};
            const localDeps = [];
            for (const [name, dep] of Object.entries(config.dependencies)) {
                if (!dep.localPath)
                    continue;
                const localPkgPath = resolve(root, dep.localPath, 'package.json');
                if (!existsSync(localPkgPath))
                    continue;
                // Check if the dep is actually installed as local (symlink points to localPath)
                // vs GH/npm dist (localPath exists in config but isn't active)
                // Verify dep is actually installed as local (symlink → localPath)
                // If switched to GH/npm dist, localPath exists in config but isn't active
                try {
                    const installedReal = realpathSync(resolve(root, 'node_modules', name));
                    const localReal = realpathSync(resolve(root, dep.localPath));
                    if (!installedReal.startsWith(localReal))
                        continue;
                }
                catch {
                    continue;
                }
                let localPkg;
                try {
                    localPkg = JSON.parse(readFileSync(localPkgPath, 'utf-8'));
                }
                catch {
                    continue;
                }
                const isCJS = !localPkg.type || localPkg.type !== 'module';
                localDeps.push({ name, localPath: dep.localPath, pkg: localPkg, isCJS });
                const peers = Object.keys((localPkg.peerDependencies ?? {}));
                for (const peer of peers) {
                    const resolved = resolve(root, 'node_modules', peer);
                    if (!existsSync(resolved))
                        continue;
                    aliases[peer] = resolved;
                    if (peer === 'react') {
                        const jsxRuntime = resolve(resolved, 'jsx-runtime');
                        if (existsSync(jsxRuntime)) {
                            aliases['react/jsx-runtime'] = jsxRuntime;
                        }
                    }
                    if (peer === 'react-dom') {
                        const client = resolve(resolved, 'client');
                        if (existsSync(client)) {
                            aliases['react-dom/client'] = client;
                        }
                    }
                }
            }
            if (options?.extra) {
                for (const mod of options.extra) {
                    const resolved = resolve(root, 'node_modules', mod);
                    if (existsSync(resolved)) {
                        aliases[mod] = resolved;
                    }
                }
            }
            if (localDeps.length === 0 && Object.keys(aliases).length === 0)
                return undefined;
            const result = { resolve: { alias: aliases } };
            // Auto-include local deps in optimizeDeps (CJS→ESM pre-bundling)
            // Skip pnpm-dep-source itself (build-time dep, not runtime)
            const runtimeDeps = localDeps.filter(d => d.name !== 'pnpm-dep-source');
            if (runtimeDeps.length > 0) {
                const includes = runtimeDeps.map(d => d.name);
                // For CJS local deps with exports maps, also include raw internal paths
                // for each exported subpath (Vite's optimizer can't resolve clean export
                // names like "plotly.js/basic" for symlinked deps, but CAN resolve raw
                // paths like "plotly.js/lib/index-basic.js")
                for (const dep of runtimeDeps) {
                    if (!dep.isCJS)
                        continue;
                    const pkgExports = dep.pkg.exports;
                    if (!pkgExports)
                        continue;
                    for (const [key, target] of Object.entries(pkgExports)) {
                        if (key === '.' || key.includes('*'))
                            continue;
                        let targetPath;
                        if (typeof target === 'string')
                            targetPath = target;
                        else if (target && typeof target === 'object') {
                            const cond = target;
                            targetPath = cond.import ?? cond.require ?? cond.default;
                        }
                        if (!targetPath)
                            continue;
                        const rawPath = targetPath.replace(/^\.\//, '');
                        includes.push(`${dep.name}/${rawPath}`);
                        // Also include without .js extension (import specifiers often omit it)
                        if (rawPath.endsWith('.js')) {
                            includes.push(`${dep.name}/${rawPath.slice(0, -3)}`);
                        }
                    }
                }
                result.optimizeDeps = { include: includes };
            }
            // Auto-define Node.js globals for CJS local deps
            if (localDeps.some(d => d.isCJS)) {
                result.define = {
                    global: 'globalThis',
                };
            }
            return result;
        },
    };
}
//# sourceMappingURL=vite.js.map