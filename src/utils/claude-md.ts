import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type { SettingSource } from '../types.js'

export async function loadClaudeMd(
  cwd: string,
  settingSources?: SettingSource[]
): Promise<string | null> {
  if (!settingSources || settingSources.length === 0) {
    return null
  }

  const parts: string[] = []

  if (settingSources.includes('user')) {
    const userPath = join(homedir(), '.claude', 'CLAUDE.md')
    const content = await safeReadFile(userPath)
    if (content) {
      parts.push(`## User-level Instructions\n${content}`)
    }
  }

  if (settingSources.includes('project')) {
    const projectHiddenPath = join(cwd, '.claude', 'CLAUDE.md')
    const projectPath = join(cwd, 'CLAUDE.md')

    const content = await safeReadFile(projectHiddenPath) || await safeReadFile(projectPath)
    if (content) {
      parts.push(`## Project-level Instructions\n${content}`)
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}