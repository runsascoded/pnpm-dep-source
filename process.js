import { spawn } from 'child_process';
export function spawnAsync(cmd, args, opts) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [];
        const stderr = [];
        child.stdout.setEncoding(opts.encoding);
        child.stderr.setEncoding(opts.encoding);
        child.stdout.on('data', (d) => stdout.push(d));
        child.stderr.on('data', (d) => stderr.push(d));
        child.on('close', (status) => {
            resolve({ status, stdout: stdout.join(''), stderr: stderr.join('') });
        });
    });
}
//# sourceMappingURL=process.js.map