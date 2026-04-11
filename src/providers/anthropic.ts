/**
 * Anthropic Messages API Provider
 *
 * Wraps the @anthropic-ai/sdk client. Since our internal format is
 * Anthropic-like, this is mostly a thin pass-through.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  StreamChunk,
} from './types.js'

export class AnthropicProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  private client: Anthropic

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    })
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }

    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    }

    const response = await this.client.messages.create(requestParams)

    return {
      content: response.content as CreateMessageResponse['content'],
      stopReason: response.stop_reason || 'end_turn',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          (response.usage as any).cache_creation_input_tokens,
        cache_read_input_tokens:
          (response.usage as any).cache_read_input_tokens,
      },
    }
  }

  async *createMessageStream(params: CreateMessageParams): AsyncGenerator<StreamChunk> {
    const requestParams: Anthropic.MessageCreateParamsStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
      stream: true,
    }

    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    }

    const stream = await this.client.messages.create(requestParams)

    let currentBlockIndex = -1
    const toolInputs: Map<number, string> = new Map()
    const toolUseIds: Map<number, string> = new Map()

    for await (const event of stream) {
      if (event.type === 'message_start') {
        const usage = (event as any).message?.usage
        if (usage) {
          yield {
            type: 'usage',
            index: -1,
            usage: {
              input_tokens: usage.input_tokens || 0,
              output_tokens: 0,
            },
          }
        }
      }

      if (event.type === 'message_delta') {
        const usage = (event as any).usage
        if (usage) {
          yield {
            type: 'usage',
            index: -1,
            usage: {
              input_tokens: 0,
              output_tokens: usage.output_tokens || 0,
            },
          }
        }
      }

      if (event.type === 'content_block_start') {
        currentBlockIndex = event.index
        
        if (event.content_block.type === 'tool_use') {
          const toolId = (event.content_block as any).id || ''
          toolUseIds.set(event.index, toolId)
          yield {
            type: 'tool_use',
            index: event.index,
            id: toolId,
            name: event.content_block.name,
            input: '',
          }
        }
      }
      
      if (event.type === 'content_block_delta') {
        const delta = event.delta
        
        if (delta.type === 'text_delta') {
          yield {
            type: 'text',
            index: currentBlockIndex,
            delta: delta.text,
          }
        }
        
        if (delta.type === 'thinking_delta') {
          yield {
            type: 'thinking',
            index: currentBlockIndex,
            delta: delta.thinking,
          }
        }
        
        if (delta.type === 'input_json_delta') {
          const existing = toolInputs.get(currentBlockIndex) || ''
          toolInputs.set(currentBlockIndex, existing + delta.partial_json)
        }
      }
      
      if (event.type === 'content_block_stop') {
        if (toolInputs.has(event.index)) {
          yield {
            type: 'tool_use',
            index: event.index,
            id: toolUseIds.get(event.index) || '',
            input: toolInputs.get(event.index),
          }
          toolInputs.delete(event.index)
          toolUseIds.delete(event.index)
        }
      }
    }

    yield { type: 'done', index: -1 }
  }
}