/**
 * Git Worktree Tools
 *
 * EnterWorktree / ExitWorktree - Isolated git worktree environments
 * for parallel work without affecting the main working tree.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'

const execAsync = promisify(exec)

// Track active worktrees
const activeWorktrees = new Map<string, { path: string; branch: string; originalCwd: string }>()

export const EnterWorktreeTool: ToolDefinition = {
  name: 'EnterWorktree',
  description: 'Create an isolated git worktree for parallel work. The agent will work in the worktree without affecting the main working tree.',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Branch name for the worktree (auto-generated if not provided)' },
      path: { type: 'string', description: 'Path for the worktree (auto-generated if not provided)' },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Create an isolated git worktree for parallel work.' },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: context.cwd, encoding: 'utf-8', signal: context.abortSignal })

      const branch = input.branch || `worktree-${Date.now()}`
      const worktreePath = input.path || join(context.cwd, '..', `.worktree-${branch}`)

      try {
        await execAsync(`git branch ${branch}`, { cwd: context.cwd, encoding: 'utf-8', signal: context.abortSignal })
      } catch {
        // Branch might already exist
      }

      await execAsync(`git worktree add ${JSON.stringify(worktreePath)} ${branch}`, {
        cwd: context.cwd,
        encoding: 'utf-8',
        signal: context.abortSignal,
      })

      const id = crypto.randomUUID()
      activeWorktrees.set(id, {
        path: worktreePath,
        branch,
        originalCwd: context.cwd,
      })

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Worktree created:\n  ID: ${id}\n  Path: ${worktreePath}\n  Branch: ${branch}\n\nYou are now working in the isolated worktree.`,
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error creating worktree: ${err.message}`,
        is_error: true,
      }
    }
  },
}

export const ExitWorktreeTool: ToolDefinition = {
  name: 'ExitWorktree',
  description: 'Exit and optionally remove a git worktree. Use "keep" to preserve changes or "remove" to clean up.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Worktree ID' },
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description: 'Whether to keep or remove the worktree (default: remove)',
      },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Exit a git worktree.' },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const worktree = activeWorktrees.get(input.id)
    if (!worktree) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Worktree not found: ${input.id}`,
        is_error: true,
      }
    }

    const action = input.action || 'remove'

    try {
      if (action === 'remove') {
        await execAsync(`git worktree remove ${JSON.stringify(worktree.path)} --force`, {
          cwd: worktree.originalCwd,
          encoding: 'utf-8',
          signal: context.abortSignal,
        })
        try {
          await execAsync(`git branch -D ${worktree.branch}`, {
            cwd: worktree.originalCwd,
            encoding: 'utf-8',
            signal: context.abortSignal,
          })
        } catch {
          // Branch might have commits
        }
      }

      activeWorktrees.delete(input.id)

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Worktree ${action === 'remove' ? 'removed' : 'kept'}: ${worktree.path}`,
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: ${err.message}`,
        is_error: true,
      }
    }
  },
}
