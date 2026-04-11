/**
 * QueryEngine - Core agentic loop
 *
 * Manages the full conversation lifecycle:
 * 1. Take user prompt
 * 2. Build system prompt with context (git status, project context, tools)
 * 3. Call LLM API with tools (via provider abstraction)
 * 4. Stream response
 * 5. Execute tool calls (concurrent for read-only, serial for mutations)
 * 6. Send results back, repeat until done
 * 7. Auto-compact when context exceeds threshold
 * 8. Retry with exponential backoff on transient errors
 */

import type {
  SDKMessage,
  QueryEngineConfig,
  ToolDefinition,
  ToolResult,
  ToolContext,
  TokenUsage,
} from './types.js'
import type {
  LLMProvider,
  CreateMessageResponse,
  NormalizedMessageParam,
  NormalizedTool,
} from './providers/types.js'
import {
  estimateMessagesTokens,
  estimateCost,
  getAutoCompactThreshold,
} from './utils/tokens.js'
import {
  shouldAutoCompact,
  compactConversation,
  microCompactMessages,
  createAutoCompactState,
  type AutoCompactState,
} from './utils/compact.js'
import {
  withRetry,
  isPromptTooLongError,
} from './utils/retry.js'
import { getSystemContext, getUserContext } from './utils/context.js'
import { normalizeMessagesForAPI } from './utils/messages.js'
import type { HookRegistry, HookInput, HookOutput } from './hooks.js'
import { formatSkillsForPrompt, getUserInvocableSkills } from './skills/registry.js'
import { SYSTEM_PROMPTS } from './prompts/system-prompts.js'
import { loadClaudeMd } from './utils/claude-md.js'

// ============================================================================
// Tool format conversion
// ============================================================================

/** Convert a ToolDefinition to the normalized provider tool format. */
function toProviderTool(tool: ToolDefinition): NormalizedTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

// ============================================================================
// ToolUseBlock (internal type for extracted tool_use blocks)
// ============================================================================

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

// ============================================================================
// System Prompt Builder
// ============================================================================

async function buildEnvironmentPrompt(config: QueryEngineConfig): Promise<string> {
  const parts: string[] = []

  // List available tools with descriptions
  parts.push('\n# Available Tools\n')
  for (const tool of config.tools) {
    parts.push(`- **${tool.name}**: ${tool.description}`)
  }

  // Add agent definitions
  if (config.agents && Object.keys(config.agents).length > 0) {
    parts.push('\n# Available Subagents\n')
    for (const [name, def] of Object.entries(config.agents)) {
      parts.push(`- **${name}**: ${def.description}`)
    }
  }

  // Add skills
  const skillsText = formatSkillsForPrompt()
  if (skillsText) {
    parts.push('\n# Available Skills\n')
    parts.push(skillsText)
    parts.push('\nUse the Skill tool to invoke a skill by name with optional arguments.')
  }

  // System context (git status, etc.)
  try {
    const sysCtx = await getSystemContext(config.cwd)
    if (sysCtx) {
      parts.push('\n# Environment\n')
      parts.push(sysCtx)
    }
  } catch {
    // Context is best-effort
  }

  // User context (AGENT.md, date)
  try {
    const userCtx = await getUserContext(config.cwd)
    if (userCtx) {
      parts.push('\n# Project Context\n')
      parts.push(userCtx)
    }
  } catch {
    // Context is best-effort
  }

  // Working directory
  parts.push(`\n# Working Directory\n${config.cwd}`)

  // Load CLAUDE.md
  const claudeMdContent = await loadClaudeMd(config.cwd, config.settingSources)
  if (claudeMdContent) {
    parts.push('\n# CLAUDE.md Instructions\n')
    parts.push(claudeMdContent)
  }

  return parts.join('\n')
}

async function buildSystemPrompt(config: QueryEngineConfig): Promise<string> {
  const basePrompt = config.systemPrompt || SYSTEM_PROMPTS.default
  const envPrompt = await buildEnvironmentPrompt(config)

  let result = basePrompt + '\n\n' + envPrompt

  if (config.appendSystemPrompt) {
    result += '\n\n' + config.appendSystemPrompt
  }

  return result
}

// ============================================================================
// QueryEngine
// ============================================================================

export class QueryEngine {
  private config: QueryEngineConfig
  private provider: LLMProvider
  public messages: NormalizedMessageParam[] = []
  private totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  private totalCost = 0
  private turnCount = 0
  private compactState: AutoCompactState
  private sessionId: string
  private apiTimeMs = 0
  private hookRegistry?: HookRegistry

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.provider = config.provider
    this.compactState = createAutoCompactState()
    this.sessionId = config.sessionId || crypto.randomUUID()
    this.hookRegistry = config.hookRegistry
  }

  /**
   * Build complete response from stream chunks
   */
  private buildResponseFromChunks(chunks: import('./providers/types.js').StreamChunk[]): CreateMessageResponse {
    const content: import('./providers/types.js').NormalizedResponseBlock[] = []
    let currentBlock: import('./providers/types.js').NormalizedResponseBlock | null = null
    const toolUses: Map<number, { id: string; name: string; input: string }> = new Map()

    for (const chunk of chunks) {
      if (chunk.type === 'done') continue

      if (chunk.type === 'text') {
        if (!currentBlock || currentBlock.type !== 'text') {
          currentBlock = { type: 'text', text: chunk.delta || '' }
          content.push(currentBlock)
        } else {
          currentBlock.text += chunk.delta || ''
        }
      }

      if (chunk.type === 'thinking') {
        // Thinking is not part of NormalizedResponseBlock, skip for now
        // Could be added to content if needed
      }

      if (chunk.type === 'tool_use') {
        // Accumulate tool_use chunks by index
        const toolUse = toolUses.get(chunk.index) || { id: '', name: '', input: '' }
        if (chunk.id) {
          toolUse.id = chunk.id
        }
        if (chunk.name) {
          toolUse.name = chunk.name
        }
        if (chunk.input !== undefined && chunk.input !== '') {
          toolUse.input = chunk.input
        }
        toolUses.set(chunk.index, toolUse)
      }
    }

    // Build complete tool_use blocks
    for (const [index, toolUse] of toolUses) {
      if (toolUse.name && toolUse.input) {
        let input: any
        try {
          input = JSON.parse(toolUse.input)
        } catch {
          input = toolUse.input
        }
        content.push({
          type: 'tool_use',
          id: toolUse.id || `tool_${index}`,
          name: toolUse.name,
          input,
        })
      }
    }

    // Determine stop reason based on content
    const hasToolUse = content.some(block => block.type === 'tool_use')
    const hasText = content.some(block => block.type === 'text')

    return {
      content,
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  }

  /**
   * Execute hooks for a lifecycle event.
   * Returns hook outputs; never throws.
   */
  private async executeHooks(
    event: import('./hooks.js').HookEvent,
    extra?: Partial<HookInput>,
  ): Promise<HookOutput[]> {
    if (!this.hookRegistry?.hasHooks(event)) return []
    try {
      return await this.hookRegistry.execute(event, {
        event,
        sessionId: this.sessionId,
        cwd: this.config.cwd,
        ...extra,
      })
    } catch {
      return []
    }
  }

  /**
   * Submit a user message and run the agentic loop.
   * Yields SDKMessage events as the agent works.
   */
  async *submitMessage(
    prompt: string | any[],
  ): AsyncGenerator<SDKMessage> {
    // Hook: SessionStart
    await this.executeHooks('SessionStart')

    // Hook: UserPromptSubmit
    const userHookResults = await this.executeHooks('UserPromptSubmit', {
      toolInput: prompt,
    })
    // Check if any hook blocks the submission
    if (userHookResults.some((r) => r.block)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        usage: this.totalUsage,
        num_turns: 0,
        cost: 0,
        errors: ['Blocked by UserPromptSubmit hook'],
      }
      return
    }

    // Add user message
    this.messages.push({ role: 'user', content: prompt as any })

    // Build tool definitions for provider
    const tools = this.config.tools.map(toProviderTool)

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(this.config)

    // Emit init system message
    const skills = getUserInvocableSkills()
    yield {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      tools: this.config.tools.map(t => t.name),
      skills: skills.map(s => s.name),
      model: this.config.model,
      cwd: this.config.cwd,
      mcp_servers: [],
      permission_mode: 'bypassPermissions',
      system_prompt: systemPrompt,
    } as SDKMessage

    // Agentic loop
    let turnsRemaining = this.config.maxTurns
    let budgetExceeded = false
    let maxOutputRecoveryAttempts = 0
    const MAX_OUTPUT_RECOVERY = 3

    while (turnsRemaining > 0) {
      if (this.config.abortSignal?.aborted) break

      // Check budget
      if (this.config.maxBudgetUsd && this.totalCost >= this.config.maxBudgetUsd) {
        budgetExceeded = true
        break
      }

      // Auto-compact if context is too large
      if (shouldAutoCompact(this.messages as any[], this.config.model, this.compactState)) {
        await this.executeHooks('PreCompact')
        try {
          const result = await compactConversation(
            this.provider,
            this.config.model,
            this.messages as any[],
            this.compactState,
          )
          this.messages = result.compactedMessages as NormalizedMessageParam[]
          this.compactState = result.state
          await this.executeHooks('PostCompact')
        } catch {
          // Continue with uncompacted messages
        }
      }

      // Micro-compact: truncate large tool results
      const apiMessages = microCompactMessages(
        normalizeMessagesForAPI(this.messages as any[]),
      ) as NormalizedMessageParam[]

      this.turnCount++
      turnsRemaining--

      // Make API call with retry via provider
      let response: CreateMessageResponse
      const apiStart = performance.now()

      try {
        if (this.config.includePartialMessages) {
          // Check if provider supports streaming
          if (!this.provider.createMessageStream) {
            throw new Error('Streaming not supported by this provider')
          }

          // Streaming mode
          // Note: Retry is not applied here because we yield partial messages as they arrive.
          // If the stream fails mid-way, we let the error propagate.
          const chunks: import('./providers/types.js').StreamChunk[] = []
          const streamUsage = { input_tokens: 0, output_tokens: 0 }

          for await (const chunk of this.provider.createMessageStream({
            model: this.config.model,
            maxTokens: this.config.maxTokens,
            system: systemPrompt,
            messages: apiMessages,
            tools: tools.length > 0 ? tools : undefined,
            thinking:
              this.config.thinking?.type === 'enabled' &&
              this.config.thinking.budgetTokens
                ? {
                    type: 'enabled',
                    budget_tokens: this.config.thinking.budgetTokens,
                  }
                : undefined,
          })) {
            chunks.push(chunk)

            // Accumulate usage from stream
            if (chunk.type === 'usage' && chunk.usage) {
              streamUsage.input_tokens += chunk.usage.input_tokens
              streamUsage.output_tokens += chunk.usage.output_tokens
            }

            // Yield partial messages for text and thinking
            if (chunk.type === 'text' || chunk.type === 'thinking') {
              yield {
                type: 'partial_message',
                partial: {
                  type: chunk.type,
                  text: chunk.delta || '',
                },
              }
            }
          }

          response = this.buildResponseFromChunks(chunks)
          // Use stream usage if available
          if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
            response.usage = streamUsage
          }
        } else {
          // Non-streaming mode
          response = await withRetry(
            async () => {
              return this.provider.createMessage({
                model: this.config.model,
                maxTokens: this.config.maxTokens,
                system: systemPrompt,
                messages: apiMessages,
                tools: tools.length > 0 ? tools : undefined,
                thinking:
                  this.config.thinking?.type === 'enabled' &&
                  this.config.thinking.budgetTokens
                    ? {
                        type: 'enabled',
                        budget_tokens: this.config.thinking.budgetTokens,
                      }
                    : undefined,
              })
            },
            undefined,
            this.config.abortSignal,
          )
        }
      } catch (err: any) {
        // Handle prompt-too-long by compacting
        if (isPromptTooLongError(err) && !this.compactState.compacted) {
          try {
            const result = await compactConversation(
              this.provider,
              this.config.model,
              this.messages as any[],
              this.compactState,
            )
            this.messages = result.compactedMessages as NormalizedMessageParam[]
            this.compactState = result.state
            turnsRemaining++ // Retry this turn
            this.turnCount--
            continue
          } catch {
            // Can't compact, give up
          }
        }

        yield {
          type: 'result',
          subtype: 'error',
          usage: this.totalUsage,
          num_turns: this.turnCount,
          cost: this.totalCost,
          errors: [err.message],
        }
        return
      }

      // Track API timing
      this.apiTimeMs += performance.now() - apiStart

      // Track usage (normalized by provider)
      if (response.usage) {
        this.totalUsage.input_tokens += response.usage.input_tokens
        this.totalUsage.output_tokens += response.usage.output_tokens
        if (response.usage.cache_creation_input_tokens) {
          this.totalUsage.cache_creation_input_tokens =
            (this.totalUsage.cache_creation_input_tokens || 0) +
            response.usage.cache_creation_input_tokens
        }
        if (response.usage.cache_read_input_tokens) {
          this.totalUsage.cache_read_input_tokens =
            (this.totalUsage.cache_read_input_tokens || 0) +
            response.usage.cache_read_input_tokens
        }
        this.totalCost += estimateCost(this.config.model, response.usage)
      }

      // Add assistant message to conversation
      this.messages.push({ role: 'assistant', content: response.content as any })

      // Yield assistant message
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: response.content as any,
        },
      }

      // Handle max_output_tokens recovery
      if (
        response.stopReason === 'max_tokens' &&
        maxOutputRecoveryAttempts < MAX_OUTPUT_RECOVERY
      ) {
        maxOutputRecoveryAttempts++
        // Add continuation prompt
        this.messages.push({
          role: 'user',
          content: 'Please continue from where you left off.',
        })
        continue
      }

      // Check for tool use
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use',
      )

      if (toolUseBlocks.length === 0) {
        break // No tool calls - agent is done
      }

      // Reset max_output recovery counter on successful tool use
      maxOutputRecoveryAttempts = 0

      // Execute tools (concurrent read-only, serial mutations)
      const toolResults = await this.executeTools(toolUseBlocks)

      // Yield tool results
      for (const result of toolResults) {
        yield {
          type: 'tool_result',
          result: {
            tool_use_id: result.tool_use_id,
            tool_name: result.tool_name || '',
            output:
              typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content),
          },
        }
      }

      // Add tool results to conversation
      this.messages.push({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.tool_use_id,
          content:
            typeof r.content === 'string'
              ? r.content
              : JSON.stringify(r.content),
          is_error: r.is_error,
        })),
      })

      if (response.stopReason === 'end_turn') break
    }

    // Hook: Stop (end of agentic loop)
    await this.executeHooks('Stop')

    // Hook: SessionEnd
    await this.executeHooks('SessionEnd')

    // Yield enriched final result
    const endSubtype = budgetExceeded
      ? 'error_max_budget_usd'
      : turnsRemaining <= 0
        ? 'error_max_turns'
        : 'success'

    yield {
      type: 'result',
      subtype: endSubtype,
      session_id: this.sessionId,
      is_error: endSubtype !== 'success',
      num_turns: this.turnCount,
      total_cost_usd: this.totalCost,
      duration_api_ms: Math.round(this.apiTimeMs),
      usage: this.totalUsage,
      model_usage: { [this.config.model]: { input_tokens: this.totalUsage.input_tokens, output_tokens: this.totalUsage.output_tokens } },
      cost: this.totalCost,
    }
  }

  /**
   * Execute tool calls with concurrency control.
   *
   * Read-only tools run concurrently (up to 10 at a time).
   * Mutation tools run sequentially.
   */
  private async executeTools(
    toolUseBlocks: ToolUseBlock[],
  ): Promise<(ToolResult & { tool_name?: string })[]> {
    const context: ToolContext = {
      cwd: this.config.cwd,
      abortSignal: this.config.abortSignal,
      provider: this.provider,
      model: this.config.model,
      apiType: this.provider.apiType,
    }

    const MAX_CONCURRENCY = parseInt(
      process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY || '10',
    )

    // Partition into read-only (concurrent) and mutation (serial)
    const readOnly: Array<{ block: ToolUseBlock; tool?: ToolDefinition }> = []
    const mutations: Array<{ block: ToolUseBlock; tool?: ToolDefinition }> = []

    for (const block of toolUseBlocks) {
      const tool = this.config.tools.find((t) => t.name === block.name)
      if (tool?.isReadOnly?.()) {
        readOnly.push({ block, tool })
      } else {
        mutations.push({ block, tool })
      }
    }

    const results: (ToolResult & { tool_name?: string })[] = []

    // Execute read-only tools concurrently (batched by MAX_CONCURRENCY)
    for (let i = 0; i < readOnly.length; i += MAX_CONCURRENCY) {
      const batch = readOnly.slice(i, i + MAX_CONCURRENCY)
      const batchResults = await Promise.all(
        batch.map((item) =>
          this.executeSingleTool(item.block, item.tool, context),
        ),
      )
      results.push(...batchResults)
    }

    // Execute mutation tools sequentially
    for (const item of mutations) {
      const result = await this.executeSingleTool(item.block, item.tool, context)
      results.push(result)
    }

    return results
  }

  /**
   * Execute a single tool with permission checking.
   */
  private async executeSingleTool(
    block: ToolUseBlock,
    tool: ToolDefinition | undefined,
    context: ToolContext,
  ): Promise<ToolResult & { tool_name?: string }> {
    if (!tool) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: Unknown tool "${block.name}"`,
        is_error: true,
        tool_name: block.name,
      }
    }

    // Check enabled
    if (tool.isEnabled && !tool.isEnabled()) {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: Tool "${block.name}" is not enabled`,
        is_error: true,
        tool_name: block.name,
      }
    }

    // Check permissions
    if (this.config.canUseTool) {
      try {
        const permission = await this.config.canUseTool(tool, block.input)
        if (permission.behavior === 'deny') {
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: permission.message || `Permission denied for tool "${block.name}"`,
            is_error: true,
            tool_name: block.name,
          }
        }
        if (permission.updatedInput !== undefined) {
          block = { ...block, input: permission.updatedInput }
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Permission check error: ${err.message}`,
          is_error: true,
          tool_name: block.name,
        }
      }
    }

    // Hook: PreToolUse
    const preHookResults = await this.executeHooks('PreToolUse', {
      toolName: block.name,
      toolInput: block.input,
      toolUseId: block.id,
    })
    // Check if any hook blocks this tool
    if (preHookResults.some((r) => r.block)) {
      const msg = preHookResults.find((r) => r.message)?.message || 'Blocked by PreToolUse hook'
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: msg,
        is_error: true,
        tool_name: block.name,
      }
    }

    // Execute the tool
    try {
      const result = await tool.call(block.input, context)

      // Hook: PostToolUse
      await this.executeHooks('PostToolUse', {
        toolName: block.name,
        toolInput: block.input,
        toolOutput: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        toolUseId: block.id,
      })

      return { ...result, tool_use_id: block.id, tool_name: block.name }
    } catch (err: any) {
      // Hook: PostToolUseFailure
      await this.executeHooks('PostToolUseFailure', {
        toolName: block.name,
        toolInput: block.input,
        toolUseId: block.id,
        error: err.message,
      })

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Tool execution error: ${err.message}`,
        is_error: true,
        tool_name: block.name,
      }
    }
  }

  /**
   * Get current messages for session persistence.
   */
  getMessages(): NormalizedMessageParam[] {
    return [...this.messages]
  }

  /**
   * Get total usage across all turns.
   */
  getUsage(): TokenUsage {
    return { ...this.totalUsage }
  }

  /**
   * Get total cost.
   */
  getCost(): number {
    return this.totalCost
  }
}
