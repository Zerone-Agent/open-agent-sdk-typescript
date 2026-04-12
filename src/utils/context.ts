/**
 * System Context
 *
 * Builds the <env> block for the system prompt:
 * - Model identity
 * - Working directory
 * - Git repo status
 * - Platform
 * - Current date
 *
 * Project instructions (CLAUDE.md) are handled separately by claude-md.ts.
 */

import { execSync } from 'child_process'

/**
 * Check whether a directory is inside a git repository.
 */
function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --git-dir', {
      cwd,
      timeout: 3000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Get system context for the system prompt.
 *
 * Outputs a model identity line (if model is provided) followed by an
 * <env> XML block — mirroring OpenCode's environment injection format.
 *
 * Example output:
 *
 *   You are powered by the model named claude-sonnet-4-6.
 *   Here is some useful information about the environment you are running in:
 *   <env>
 *     Working directory: /Users/zero/project
 *     Is directory a git repo: yes
 *     Platform: darwin
 *     Today's date: Sun Apr 13 2026
 *   </env>
 */
export async function getSystemContext(cwd: string, model?: string): Promise<string> {
  const lines: string[] = []

  if (model) {
    lines.push(`You are powered by the model named ${model}.`)
  }

  lines.push('Here is some useful information about the environment you are running in:')
  lines.push('<env>')
  lines.push(`  Working directory: ${cwd}`)
  lines.push(`  Is directory a git repo: ${isGitRepo(cwd) ? 'yes' : 'no'}`)
  lines.push(`  Platform: ${process.platform}`)
  lines.push(`  Today's date: ${new Date().toDateString()}`)
  lines.push('</env>')

  return lines.join('\n')
}
