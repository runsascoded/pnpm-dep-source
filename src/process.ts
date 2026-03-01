import { spawn } from 'child_process'

export function spawnAsync(
  cmd: string,
  args: string[],
  opts: { encoding: 'utf-8' },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.setEncoding(opts.encoding)
    child.stderr.setEncoding(opts.encoding)
    child.stdout.on('data', (d: string) => stdout.push(d))
    child.stderr.on('data', (d: string) => stderr.push(d))
    child.on('close', (status) => {
      resolve({ status, stdout: stdout.join(''), stderr: stderr.join('') })
    })
  })
}
