import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { CONFIG_FILES } from './constants.js';
/**
 * Vite plugin that auto-manages resolve aliases for pds local deps' peer dependencies.
 * Prevents duplicate React instances and unresolved peer imports across symlink boundaries.
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
            for (const [, dep] of Object.entries(config.dependencies)) {
                if (!dep.localPath)
                    continue;
                const localPkgPath = resolve(root, dep.localPath, 'package.json');
                if (!existsSync(localPkgPath))
                    continue;
                let localPkg;
                try {
                    localPkg = JSON.parse(readFileSync(localPkgPath, 'utf-8'));
                }
                catch {
                    continue;
                }
                const peers = Object.keys(localPkg.peerDependencies ?? {});
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
            if (Object.keys(aliases).length === 0)
                return undefined;
            return { resolve: { alias: aliases } };
        },
    };
}
//# sourceMappingURL=vite.js.map