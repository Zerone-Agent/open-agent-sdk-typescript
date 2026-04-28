/**
 * BashTool - Execute shell commands
 * Supports macOS (zsh > bash), Linux (bash), Windows (PowerShell > Git Bash > cmd)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crossSpawn from 'cross-spawn'
import { defineTool } from './types.js'

const MAX_OUTPUT_CHARS = 100_000
const MAX_LINES = 2000
const MAX_BYTES = 51_200

const TEMPLATE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'bash.txt'),
  'utf-8',
)

interface ShellConfig {
  shell: string
  args: string[]
  name: string
}

function getShellConfig(): ShellConfig {
  if (process.platform === 'darwin') {
    try {
      const result = crossSpawn.sync('zsh', ['-c', 'exit 0'], { stdio: 'ignore' })
      if (result.status === 0) {
        return { shell: 'zsh', args: ['-c'], name: 'zsh' }
      }
    } catch {}
    return { shell: 'bash', args: ['-c'], name: 'bash' }
  }

  if (process.platform !== 'win32') {
    return { shell: 'bash', args: ['-c'], name: 'bash' }
  }

  const psPaths = ['pwsh.exe', 'powershell.exe']
  for (const ps of psPaths) {
    try {
      const result = crossSpawn.sync(ps, ['-Command', 'exit 0'], { stdio: 'ignore' })
      if (result.status === 0) {
        return { shell: ps, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], name: ps === 'pwsh.exe' ? 'pwsh' : 'powershell' }
      }
    } catch {}
  }

  try {
    const gitResult = crossSpawn.sync('git', ['--exec-path'], { encoding: 'utf-8' })
    if (gitResult.status === 0 && gitResult.stdout) {
      const gitPath = gitResult.stdout.trim()
      const gitBashPath = gitPath.replace(/\/libexec\/git-core$/, '/bin/bash.exe').replace(/\\libexec\\git-core$/, '\\bin\\bash.exe')
      if (gitBashPath !== gitPath) {
        try {
          const bashResult = crossSpawn.sync(gitBashPath, ['-c', 'exit 0'], { stdio: 'ignore' })
          if (bashResult.status === 0) {
            return { shell: gitBashPath, args: ['-c'], name: 'bash' }
          }
        } catch {}
      }
    }
  } catch {}

  return { shell: 'cmd.exe', args: ['/c'], name: 'cmd' }
}

const shellConfig = getShellConfig()

const chaining =
  shellConfig.name === 'powershell'
    ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
    : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."

const DESCRIPTION = TEMPLATE
  .replaceAll('${os}', process.platform)
  .replaceAll('${shell}', shellConfig.name)
  .replaceAll('${chaining}', chaining)
  .replaceAll('${maxLines}', String(MAX_LINES))
  .replaceAll('${maxBytes}', String(MAX_BYTES))

export const BashTool = defineTool({
  name: 'Bash',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      description: {
        type: 'string',
        description: [
          'Clear, concise description of what this command does in 5-10 words.',
          'Examples:',
          'Input: ls → Output: Lists files in current directory',
          'Input: git status → Output: Shows working tree status',
          'Input: mkdir foo → Output: 创建目录 \'foo\'',
        ].join('\n'),
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000, default 120000)',
      },
      workdir: {
        type: 'string',
        description: 'The working directory to run the command in. Defaults to the current directory. Use this instead of cd commands.',
      },
    },
    required: ['command'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    const { command, timeout: userTimeout } = input
    const timeoutMs = Math.min(userTimeout || 120000, 600000)
    const cwd = input.workdir || context.cwd

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []

      const proc = crossSpawn(shellConfig.shell, [...shellConfig.args, command], {
        cwd,
        env: { ...process.env },
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      proc.stdout?.on('data', (data: Buffer) => chunks.push(data))
      proc.stderr?.on('data', (data: Buffer) => errChunks.push(data))

      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', () => {
          proc.kill('SIGTERM')
        }, { once: true })
      }

      proc.on('close', (code: number | null) => {
        const stdout = Buffer.concat(chunks).toString('utf-8')
        const stderr = Buffer.concat(errChunks).toString('utf-8')

        let output = ''
        if (stdout) output += stdout
        if (stderr) output += (output ? '\n' : '') + stderr
        if (code !== 0 && code !== null) {
          output += `\nExit code: ${code}`
        }

        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS / 2) + '\n...(truncated)...\n' + output.slice(-MAX_OUTPUT_CHARS / 2)
        }

        resolve(output || '(no output)')
      })

      proc.on('error', (err: Error) => {
        resolve(`Error executing command: ${err.message}`)
      })
    })
  },
})
