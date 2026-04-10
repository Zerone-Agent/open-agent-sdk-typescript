/**
 * Filesystem Skills Loader
 * 
 * Loads SKILL.md files from .claude/skills/ directories.
 */

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { parseSkillMarkdown } from './yaml.js'
import { registerSkill } from './registry.js'
import type { SkillDefinition, SkillContentBlock } from './types.js'
import type { SettingSource } from '../types.js'

export interface LoadResult {
  loaded: number
  errors: Error[]
}

/**
 * Load skills from filesystem directories based on settingSources.
 * 
 * @param cwd - Current working directory (project root)
 * @param settingSources - Array of sources to load from
 * @returns Number of loaded skills and any errors
 */
export async function loadSkillsFromFilesystem(
  cwd: string,
  settingSources?: SettingSource[]
): Promise<LoadResult> {
  if (!settingSources || settingSources.length === 0) {
    return { loaded: 0, errors: [] }
  }

  const errors: Error[] = []
  let loaded = 0

  // User-level skills (~/.claude/skills/)
  if (settingSources.includes('user')) {
    const userSkillsDir = join(homedir(), '.claude', 'skills')
    const result = await loadSkillsFromDir(userSkillsDir)
    loaded += result.loaded
    errors.push(...result.errors)
  }

  // Project-level skills (./.claude/skills/)
  if (settingSources.includes('project')) {
    const projectSkillsDir = join(cwd, '.claude', 'skills')
    const result = await loadSkillsFromDir(projectSkillsDir)
    loaded += result.loaded
    errors.push(...result.errors)
  }

  return { loaded, errors }
}

/**
 * Load all skills from a directory.
 */
async function loadSkillsFromDir(
  dir: string
): Promise<LoadResult> {
  const errors: Error[] = []
  let loaded = 0

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const skillDirs = entries.filter(entry => entry.isDirectory())

    for (const skillDir of skillDirs) {
      const skillPath = join(dir, skillDir.name, 'SKILL.md')
      try {
        await loadSkillFile(dir, skillDir.name, skillPath)
        loaded++
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
  } catch (error) {
    // Directory doesn't exist or permission denied - silently skip
    if ((error as any).code !== 'ENOENT') {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return { loaded, errors }
}

/**
 * Load a single SKILL.md file and register it.
 */
async function loadSkillFile(
  baseDir: string,
  skillName: string,
  skillPath: string
): Promise<void> {
  const content = await readFile(skillPath, 'utf-8')
  const { frontmatter, body } = parseSkillMarkdown(content)

  const finalBody = body.replace(
    /\$\{CLAUDE_SKILL_DIR\}/g,
    join(baseDir, skillName)
  )

  const definition: SkillDefinition = {
    name: frontmatter.name || skillName,
    description: frontmatter.description,
    model: frontmatter.model,
    allowedTools: frontmatter.allowedTools,
    userInvocable: frontmatter.userInvocable ?? true,
    async getPrompt(args: string): Promise<SkillContentBlock[]> {
      let text = finalBody
      if (args) {
        // Replace argument substitution placeholders if any
        text = text.replace(/\$\{args\}/g, args)
      }
      return [{ type: 'text', text }]
    },
  }

  registerSkill(definition)
}