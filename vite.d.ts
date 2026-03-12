interface PdsVitePluginOptions {
    /** Path to project root (default: process.cwd()) */
    root?: string;
    /** Extra modules to always alias to consumer's node_modules */
    extra?: string[];
}
/**
 * Vite plugin that auto-manages resolve aliases for pds local deps' peer dependencies.
 * Prevents duplicate React instances and unresolved peer imports across symlink boundaries.
 */
export declare function pdsPlugin(options?: PdsVitePluginOptions): {
    name: string;
    config: () => {
        resolve: {
            alias: Record<string, string>;
        };
    } | undefined;
};
export {};
//# sourceMappingURL=vite.d.ts.map