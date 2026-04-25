/**
 * Skill Tool
 *
 * Allows the model to invoke registered skills by name.
 * Skills are prompt templates that provide specialized capabilities.
 *
 * Two-layer injection strategy (following OpenCode design):
 * - System prompt: verbose XML listing with locations (formatSkillsForSystemPrompt)
 * - Tool description: concise Markdown for fast matching (formatSkillsForToolDescription)
 * - Tool output: <skill_content> XML with full SKILL.md content, base dir, and file listing
 */

import { readdir } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import { getSkill, getUserInvocableSkills, formatSkillsForToolDescription } from '../skills/registry.js'

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * List all files recursively under a directory.
 * Returns absolute paths, sampled to at most `limit` entries.
 */
async function listSkillFiles(dir: string, limit = 20): Promise<string[]> {
  const results: string[] = []

  async function walk(current: string) {
    if (results.length >= limit) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= limit) break
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        // Skip the SKILL.md itself — the content is already included inline
        if (entry.name !== 'SKILL.md') {
          results.push(fullPath)
        }
      }
    }
  }

  await walk(dir)
  return results
}

/**
 * Build the <skill_content> XML block returned to the model after invoking a skill.
 *
 * Format mirrors OpenCode's output:
 *
 *   <skill_content name="agents-sdk">
 *   # Skill: agents-sdk
 *
 *   [SKILL.md content]
 *
 *   Base directory for this skill: file:///path/to/skill/
 *   Relative paths in this skill are relative to this base directory.
 *   Note: file list is sampled.
 *
 *   <skill_files>
 *   <file>/path/to/references/callable.md</file>
 *   </skill_files>
 *   </skill_content>
 */
async function buildSkillContent(
  skillName: string,
  promptText: string,
  skillDir: string | undefined,
): Promise<string> {
  const lines: string[] = []
  lines.push(`<skill_content name="${skillName}">`)
  lines.push(`# Skill: ${skillName}`)
  lines.push('')
  lines.push(promptText)

  if (skillDir) {
    const baseDirUrl = pathToFileURL(skillDir).href + '/'
    const siblingFiles = await listSkillFiles(skillDir)

    lines.push('')
    lines.push(`Base directory for this skill: ${baseDirUrl}`)
    lines.push('Relative paths in this skill are relative to this base directory.')

    if (siblingFiles.length > 0) {
      lines.push('Note: file list is sampled.')
      lines.push('')
      lines.push('<skill_files>')
      for (const f of siblingFiles) {
        lines.push(`<file>${f}</file>`)
      }
      lines.push('</skill_files>')
    }
  }

  lines.push('</skill_content>')
  return lines.join('\n')
}

// --------------------------------------------------------------------------
// Tool definition
// --------------------------------------------------------------------------

export const SkillTool: ToolDefinition = {
  name: 'Skill',
  description:
    'Load a specialized skill that provides domain-specific instructions and workflows.\n\n' +
    'When you recognize that a task matches one of the available skills listed below, ' +
    'use this tool to load the full skill instructions.\n\n' +
     'The skill will inject detailed instructions, workflows, and access to specialized ' +
     'resources (scripts, references, templates) into the conversation context.\n\n' +
     'Tool output includes a `<skill_content name="...">` block with the loaded content.',

  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The name of the skill from available_skills (e.g., "commit", "review")',
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill',
      },
    },
    required: ['skill'],
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => getUserInvocableSkills().length > 0,

  /**
   * Concise Markdown listing injected into the tool description.
   * Kept brief so it doesn't dominate the tool listing.
   * The system prompt carries the verbose XML version.
   */
  async prompt(): Promise<string> {
    const skills = getUserInvocableSkills()
    if (skills.length === 0) return ''

    return [
      'The following skills provide specialized sets of instructions for particular tasks',
      'Invoke this tool to load a skill when a task matches one of the available skills listed below:\n',
      formatSkillsForToolDescription(),
    ].join('\n')
  },

  async call(input: any, _context: ToolContext): Promise<ToolResult> {
    const skillName: string = input.skill
    const args: string = input.args || ''

    if (!skillName) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Error: skill name is required',
        is_error: true,
      }
    }

    const skill = getSkill(skillName)
    if (!skill) {
      const available = getUserInvocableSkills()
        .map((s) => s.name)
        .join(', ')
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: Unknown skill "${skillName}". Available skills: ${available || 'none'}`,
        is_error: true,
      }
    }

    if (skill.isEnabled && !skill.isEnabled()) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: Skill "${skillName}" is currently disabled`,
        is_error: true,
      }
    }

    try {
      const contentBlocks = await skill.getPrompt(args, _context)

      // Extract text blocks; image blocks are preserved separately
      const textBlocks = contentBlocks.filter(
        (b): b is { type: 'text'; text: string } => b.type === 'text',
      )
      const promptText = textBlocks.map((b) => b.text).join('\n\n')

      // Build the <skill_content> XML output
      const skillContent = await buildSkillContent(skillName, promptText, skill.skillDir)

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: skillContent,
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error executing skill "${skillName}": ${err.message}`,
        is_error: true,
      }
    }
  },
}
