export type ViteEditStatus = 'changed' | 'unchanged' | 'unsupported';
export interface ViteEdit {
    content: string;
    status: ViteEditStatus;
    /** Why the edit couldn't be made (status `unsupported`). */
    reason?: string;
}
/** Add `dep` to the config's `optimizeDeps.exclude`, creating the key/block as needed. */
export declare function addOptimizeDepsExclude(content: string, dep: string): ViteEdit;
/**
 * Remove `dep` from the config's `optimizeDeps.exclude`. If that empties the
 * array, the `exclude` key is removed; if that empties `optimizeDeps`, the block
 * is removed. Sibling keys and comments are preserved (a list whose only
 * remaining content is a comment is kept).
 */
export declare function removeOptimizeDepsExclude(content: string, dep: string): ViteEdit;
//# sourceMappingURL=vite-config.d.ts.map