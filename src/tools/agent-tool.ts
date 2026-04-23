/**
 * AgentTool - Spawn subagents for parallel/delegated work
 *
 * Supports built-in agents (Explore, Plan) and custom agent definitions.
 * Agents run as nested query loops with their own context and tool sets.
 * Subagent events are propagated to the parent stream via context.emitEvent.
 */

import type { ToolDefinition, ToolContext, ToolResult, AgentDefinition, SDKMessage } from '../types.js'
import { QueryEngine } from '../engine.js'
import { getAllBaseTools, filterTools } from './index.js'
import { createProvider, type ApiType } from '../providers/index.js'

// Store for registered agent definitions
let registeredAgents: Record<string, AgentDefinition> = {}

/**
 * Register agent definitions for the AgentTool to use.
 */
export function registerAgents(agents: Record<string, AgentDefinition>): void {
  registeredAgents = { ...registeredAgents, ...agents }
}

/**
 * Clear registered agents.
 */
export function clearAgents(): void {
  registeredAgents = {}
}

/**
 * Built-in agent definitions.
 */
const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  Explore: {
    description: 'Fast agent for exploring codebases. Use for finding files, searching code, and answering questions about the codebase.',
    prompt: 'You are a codebase exploration agent. Search through files and code to answer questions. Be thorough but efficient. Use Glob to find files, Grep to search content, and Read to examine files.',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
  },
  Plan: {
    description: 'Software architect agent for designing implementation plans. Returns step-by-step plans and identifies critical files.',
    prompt: 'You are a software architect. Design implementation plans for the given task. Identify critical files, consider trade-offs, and provide step-by-step plans. Use search tools to understand the codebase before planning.',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
  },
}

export const AgentTool: ToolDefinition = {
  name: 'Agent',
  description: 'Launch a subagent to handle complex, multi-step tasks autonomously. Subagents have their own context and can run specialized tool sets.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task for the agent to perform',
      },
      description: {
        type: 'string',
        description: 'A short (3-5 word) description of the task',
      },
      subagent_type: {
        type: 'string',
        description: 'The type of agent to use (e.g., "Explore", "Plan", or a custom agent name)',
      },
      model: {
        type: 'string',
        description: 'Optional model override for this agent',
      },
      name: {
        type: 'string',
        description: 'Name for the spawned agent',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Whether to run in background',
      },
    },
    required: ['prompt', 'description'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() {
    return 'Launch a subagent to handle complex tasks autonomously.'
  },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const agentType = input.subagent_type || 'general-purpose'

    const agentDef = registeredAgents[agentType] || BUILTIN_AGENTS[agentType]

    let tools = getAllBaseTools()
    if (agentDef?.tools) {
      tools = filterTools(tools, agentDef.tools)
    }

    tools = tools.filter(t => t.name !== 'Agent')

    const systemPrompt = agentDef?.prompt ||
      'You are a helpful assistant. Complete the given task using the available tools.'

    const subModel = input.model || context.model || process.env.OPENAGENT_MODEL || 'claude-sonnet-4-6'
    const provider = context.provider ?? createProvider(
      (context.apiType || process.env.OPENAGENT_API_TYPE as ApiType) || 'anthropic-messages',
      {
        apiKey: process.env.OPENAGENT_API_KEY,
        baseURL: process.env.OPENAGENT_BASE_URL,
      },
    )

    const subSessionId = crypto.randomUUID()

    const engine = new QueryEngine({
      cwd: context.cwd,
      model: subModel,
      provider,
      tools,
      systemPrompt,
      maxTurns: agentDef?.maxTurns || 10,
      maxTokens: 16384,
      canUseTool: async () => ({ behavior: 'allow' }),
      includePartialMessages: true,
      sessionId: subSessionId,
    })

    const emitEvent = context.emitEvent
    let resultText = ''
    let toolCalls: string[] = []

    try {
      for await (const event of engine.submitMessage(input.prompt)) {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if ('text' in block && block.text) {
              resultText = block.text
            }
            if ('name' in block) {
              toolCalls.push(block.name as string)
            }
          }
        }

        if (emitEvent) {
          const propagatedTypes = ['assistant', 'partial_message', 'tool_result', 'system']
          if (propagatedTypes.includes(event.type)) {
            emitEvent({
              type: 'subagent',
              parent_tool_use_id: '',
              session_id: subSessionId,
              event: event as any,
            })
          }
        }
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Subagent error: ${err.message}`,
        is_error: true,
      }
    }

    const output = resultText || '(Subagent completed with no text output)'
    const toolSummary = toolCalls.length > 0
      ? `\n[Tools used: ${toolCalls.join(', ')}]`
      : ''

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: output + toolSummary,
    }
  },
}
