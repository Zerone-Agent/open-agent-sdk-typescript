/**
 * BashTool - Execute shell commands
 * Supports Windows (PowerShell > Git Bash > cmd) and Unix (bash)
 */

import crossSpawn from 'cross-spawn'
import { defineTool } from './types.js'

function getShellConfig(): { shell: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { shell: 'bash', args: ['-c'] }
  }

  // Windows: try PowerShell first, then Git Bash, then cmd
  // PowerShell Core (pwsh) or Windows PowerShell (powershell)
  const psPaths = ['pwsh.exe', 'powershell.exe']
  for (const ps of psPaths) {
    try {
      // Check if PowerShell is available
      const result = crossSpawn.sync(ps, ['-Command', 'exit 0'], { stdio: 'ignore' })
      if (result.status === 0) {
        return { shell: ps, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }
      }
    } catch {
      // Continue to next option
    }
  }

  // Try Git Bash via git.exe path
  try {
    const gitResult = crossSpawn.sync('git', ['--exec-path'], { encoding: 'utf-8' })
    if (gitResult.status === 0 && gitResult.stdout) {
      const gitPath = gitResult.stdout.trim()
      const gitBashPath = gitPath.replace(/\/libexec\/git-core$/, '/bin/bash.exe').replace(/\\libexec\\git-core$/, '\\bin\\bash.exe')
      if (gitBashPath !== gitPath) {
        try {
          const bashResult = crossSpawn.sync(gitBashPath, ['-c', 'exit 0'], { stdio: 'ignore' })
          if (bashResult.status === 0) {
            return { shell: gitBashPath, args: ['-c'] }
          }
        } catch {
          // Continue to fallback
        }
      }
    }
  } catch {
    // Continue to fallback
  }

  // Fallback to cmd.exe
  return { shell: 'cmd.exe', args: ['/c'] }
}

export const BashTool = defineTool({
  name: 'Bash',
  description: 'Execute a bash command and return its output. Use for running shell commands, scripts, and system operations.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000, default 120000)',
      },
    },
    required: ['command'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    const { command, timeout: userTimeout } = input
    const timeoutMs = Math.min(userTimeout || 120000, 600000)
    const { shell, args } = getShellConfig()

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []

      const proc = crossSpawn(shell, [...args, command], {
        cwd: context.cwd,
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

      proc.on('close', (code) => {
        const stdout = Buffer.concat(chunks).toString('utf-8')
        const stderr = Buffer.concat(errChunks).toString('utf-8')

        let output = ''
        if (stdout) output += stdout
        if (stderr) output += (output ? '\n' : '') + stderr
        if (code !== 0 && code !== null) {
          output += `\nExit code: ${code}`
        }

        // Truncate very large outputs
        if (output.length > 100000) {
          output = output.slice(0, 50000) + '\n...(truncated)...\n' + output.slice(-50000)
        }

        resolve(output || '(no output)')
      })

      proc.on('error', (err) => {
        resolve(`Error executing command: ${err.message}`)
      })
    })
  },
})
