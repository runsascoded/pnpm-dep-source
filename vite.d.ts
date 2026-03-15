interface PdsVitePluginOptions {
    /** Path to project root (default: process.cwd()) */
    root?: string;
    /** Extra modules to always alias to consumer's node_modules */
    extra?: string[];
}
interface PdsPluginConfig {
    resolve: {
        alias: Record<string, string>;
    };
    optimizeDeps?: {
        include: string[];
    };
    define?: Record<string, string>;
}
/**
 * Vite plugin that auto-manages resolve aliases, optimizeDeps, and CJS compat
 * for pds local deps. Prevents duplicate React instances, unresolved peer imports
 * across symlink boundaries, and CJS require() failures in the browser.
 */
export declare function pdsPlugin(options?: PdsVitePluginOptions): {
    name: string;
    config(): PdsPluginConfig | undefined;
};
export {};
//# sourceMappingURL=vite.d.ts.map