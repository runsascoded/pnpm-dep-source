// Global git hook scripts installed by `pds hooks install` (into `core.hooksPath`).
//
// Setting `core.hooksPath` makes Git ignore each repo's own `.git/hooks`, so the
// pds hooks chain to them (and to any previous global `core.hooksPath`). Chained
// hooks must see exactly what Git gave us: the same args (`pre-push` gets the
// remote name and URL) and, for `pre-push`, the same stdin (the refs being
// pushed), which is buffered so each chained hook reads all of it.
// Hooks whose stdin carries input (rather than being `/dev/null`).
const STDIN_HOOKS = new Set(['pre-push']);
function shellQuote(s) {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
export function generateHookScript(hookType, previousHooksPath) {
    const stdin = STDIN_HOOKS.has(hookType);
    const feed = stdin ? ' < "$stdin_file"' : '';
    const chain = (path) => `if [ -x ${path} ]; then
  ${path} "$@"${feed} || exit 1
fi`;
    const previousHooksSection = previousHooksPath
        ? chain(shellQuote(`${previousHooksPath}/${hookType}`))
        : '# (no previous core.hooksPath)';
    const stdinSection = stdin
        ? `
# Buffer stdin (the refs being pushed), so every chained hook reads all of it
stdin_file=$(mktemp)
trap 'rm -f "$stdin_file"' EXIT
cat > "$stdin_file"
`
        : '';
    return `#!/bin/sh
# pds ${hookType} hook - checks for local dependencies
# Installed by: pds hooks install

# A chained hook that calls back into the global hooks would re-enter here; the
# outer invocation already ran everything, so don't loop.
[ -n "$PDS_HOOK_ACTIVE" ] && exit 0
PDS_HOOK_ACTIVE=1
export PDS_HOOK_ACTIVE
${stdinSection}
# 1. Run pds check
if command -v pds >/dev/null 2>&1; then
  pds check --hook ${hookType} < /dev/null || exit 1
else
  echo "Warning: pds not found in PATH, skipping local dependency check"
fi

# 2. Chain to previous global hooks (if any were configured before pds)
${previousHooksSection}

# 3. Chain to the repo's own hooks (which Git ignores when core.hooksPath is set).
# The common dir is shared by all worktrees; in a linked worktree \`.git\` is a file.
local_hook="$(git rev-parse --git-common-dir)/hooks/${hookType}"
${chain('"$local_hook"')}
`;
}
//# sourceMappingURL=hooks.js.map