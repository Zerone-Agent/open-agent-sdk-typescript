/**
 * System & User Context
 *
 * Builds context for the system prompt:
 * - <env> block: working directory, git repo status, platform, date, model identity
 * - AGENT.md / project context discovery and injection
 */

import { execSync } from 'child_process'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'

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
 *   You are powered by the model named claude-sonnet-4-6. The exact model ID is opencode/claude-sonnet-4-6
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
    lines.push(`You are powered by the model named ${model}. The exact model ID is opencode/${model}`)
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

/**
 * Discover project context files (AGENT.md, CLAUDE.md) in the project.
 */
export async function discoverProjectContextFiles(cwd: string): Promise<string[]> {
  const candidates = [
    join(cwd, 'AGENTS.md'),
    join(cwd, 'AGENT.md'),
    join(cwd, 'CLAUDE.md'),
    join(cwd, '.claude', 'CLAUDE.md'),
    join(cwd, 'claude.md'),
  ]

  // Also check home directory
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home) {
    candidates.push(join(home, '.claude', 'CLAUDE.md'))
  }

  const found: string[] = []
  for (const path of candidates) {
    try {
      const s = await stat(path)
      if (s.isFile()) found.push(path)
    } catch {
      // File doesn't exist
    }
  }

  return found
}

/**
 * Read project context file content from discovered files.
 */
export async function readProjectContextContent(cwd: string): Promise<string> {
  const files = await discoverProjectContextFiles(cwd)
  if (files.length === 0) return ''

  const parts: string[] = []
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8')
      if (content.trim()) {
        parts.push(`# From ${file}:\n${content.trim()}`)
      }
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join('\n\n')
}

/**
 * Get user context (AGENT.md, project instructions, etc).
 */
export async function getUserContext(cwd: string): Promise<string> {
  const projectCtx = await readProjectContextContent(cwd)
  return projectCtx
}

/**
 * @deprecated No longer needed — git status details removed from system prompt.
 */
export function clearContextCache(): void {}
