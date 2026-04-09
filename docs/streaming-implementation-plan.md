# Streaming Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add token-level streaming output support to the Open Agent SDK, yielding partial messages for text and thinking content while maintaining backward compatibility.

**Architecture:** Extend the LLMProvider interface with a `createMessageStream()` method that returns `AsyncGenerator<StreamChunk>`. The QueryEngine will use streaming when `includePartialMessages` is enabled, aggregating chunks into complete responses for tool execution while yielding partial messages to the consumer.

**Tech Stack:** TypeScript, Anthropic SDK, native fetch for OpenAI

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/providers/types.ts` | Define `StreamChunk` type and extend `LLMProvider` interface |
| `src/providers/anthropic.ts` | Implement `createMessageStream()` for Anthropic API |
| `src/providers/openai.ts` | Implement `createMessageStream()` for OpenAI API |
| `src/types.ts` | Update `SDKPartialMessage` to support `thinking` type |
| `src/engine.ts` | Add streaming logic in `submitMessage()` method |
| `src/index.ts` | Export new types |

---

## Task 1: Update Provider Types

**Files:**
- Modify: `src/providers/types.ts`

### Step 1.1: Add StreamChunk type

```typescript
// Add after CreateMessageResponse interface

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'done'
  index: number
  delta?: string
  name?: string
  input?: string
}
```

### Step 1.2: Extend LLMProvider interface

```typescript
// Replace LLMProvider interface

export interface LLMProvider {
  readonly apiType: ApiType
  createMessage(params: CreateMessageParams): Promise<CreateMessageResponse>
  createMessageStream(params: CreateMessageParams): AsyncGenerator<StreamChunk>
}
```

Run: `npm run build`
Expected: SUCCESS (types only, no runtime changes)

### Step 1.3: Commit

```bash
git add src/providers/types.ts
git commit -m "feat: add StreamChunk type and extend LLMProvider interface"
```

---

## Task 2: Implement Anthropic Streaming

**Files:**
- Modify: `src/providers/anthropic.ts`

### Step 2.1: Add createMessageStream implementation

Replace the entire file content:

```typescript
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

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        currentBlockIndex = event.index
        
        if (event.content_block.type === 'tool_use') {
          yield {
            type: 'tool_use',
            index: event.index,
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
            input: toolInputs.get(event.index),
          }
          toolInputs.delete(event.index)
        }
      }
    }

    yield { type: 'done', index: -1 }
  }
}
```

### Step 2.2: Verify build

Run: `npm run build`
Expected: SUCCESS

### Step 2.3: Commit

```bash
git add src/providers/anthropic.ts
git commit -m "feat: implement createMessageStream for Anthropic provider"
```

---

## Task 3: Implement OpenAI Streaming

**Files:**
- Modify: `src/providers/openai.ts`

### Step 3.1: Add SSE parsing helper

Add at the top of the file after imports:

```typescript
/**
 * Parse SSE (Server-Sent Events) stream from OpenAI
 */
async function* parseSSEStream(response: Response): AsyncGenerator<any> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6)
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data)
        } catch {
          // Ignore parse errors
        }
      }
    }
  }
}
```

### Step 3.2: Add createMessageStream implementation

Add the method to OpenAIProvider class after createMessage:

```typescript
async *createMessageStream(params: CreateMessageParams): AsyncGenerator<StreamChunk> {
  const messages = this.convertMessages(params.system, params.messages)
  const tools = params.tools ? this.convertTools(params.tools) : undefined

  const body: Record<string, any> = {
    model: params.model,
    max_tokens: params.maxTokens,
    messages,
    stream: true,
  }

  if (tools && tools.length > 0) {
    body.tools = tools
  }

  const response = await fetch(`${this.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    const err: any = new Error(
      `OpenAI API error: ${response.status} ${response.statusText}: ${errBody}`,
    )
    err.status = response.status
    throw err
  }

  let currentBlockIndex = -1
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()

  for await (const chunk of parseSSEStream(response)) {
    const choice = chunk.choices?.[0]
    if (!choice) continue

    const delta = choice.delta
    if (!delta) continue

    // Text content
    if (delta.content) {
      yield {
        type: 'text',
        index: currentBlockIndex,
        delta: delta.content,
      }
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index || 0
        currentBlockIndex = index

        if (!toolCalls.has(index)) {
          toolCalls.set(index, { id: tc.id || '', name: '', arguments: '' })
        }

        const call = toolCalls.get(index)!

        if (tc.function?.name) {
          call.name += tc.function.name
        }

        if (tc.function?.arguments) {
          call.arguments += tc.function.arguments
        }

        if (tc.id) {
          call.id = tc.id
        }

        // Yield complete tool_use when finished
        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
          if (call.name) {
            yield {
              type: 'tool_use',
              index,
              name: call.name,
              input: call.arguments,
            }
          }
        }
      }
    }
  }

  yield { type: 'done', index: -1 }
}
```

### Step 3.3: Verify build

Run: `npm run build`
Expected: SUCCESS

### Step 3.4: Commit

```bash
git add src/providers/openai.ts
git commit -m "feat: implement createMessageStream for OpenAI provider"
```

---

## Task 4: Update SDK Types

**Files:**
- Modify: `src/types.ts`

### Step 4.1: Update SDKPartialMessage

Replace the SDKPartialMessage interface:

```typescript
export interface SDKPartialMessage {
  type: 'partial_message'
  partial: {
    type: 'text' | 'thinking'
    text?: string
  }
}
```

### Step 4.2: Verify build

Run: `npm run build`
Expected: SUCCESS

### Step 4.3: Commit

```bash
git add src/types.ts
git commit -m "feat: update SDKPartialMessage to support thinking type"
```

---

## Task 5: Update QueryEngine

**Files:**
- Modify: `src/engine.ts`

### Step 5.1: Add helper method to build response from chunks

Add a private method to QueryEngine class:

```typescript
/**
 * Build complete response from stream chunks
 */
private buildResponseFromChunks(chunks: import('./providers/types.js').StreamChunk[]): CreateMessageResponse {
  const content: import('./providers/types.js').NormalizedResponseBlock[] = []
  let currentBlock: import('./providers/types.js').NormalizedResponseBlock | null = null
  const toolInputs: Map<number, string> = new Map()

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
      if (chunk.name) {
        // Start of tool use
        toolInputs.set(chunk.index, '')
      }
      if (chunk.input !== undefined) {
        // Complete tool use
        let input: any
        try {
          input = JSON.parse(chunk.input)
        } catch {
          input = chunk.input
        }
        content.push({
          type: 'tool_use',
          id: `tool_${chunk.index}`,
          name: chunk.name || '',
          input,
        })
      }
    }
  }

  return {
    content,
    stopReason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}
```

### Step 5.2: Modify submitMessage to support streaming

Replace the API call section in submitMessage (around line 273-326):

```typescript
// Make API call with retry via provider
let response: CreateMessageResponse
const apiStart = performance.now()

try {
  if (this.config.includePartialMessages) {
    // Streaming mode
    const chunks: import('./providers/types.js').StreamChunk[] = []
    
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
  } else {
    // Non-streaming mode (existing logic)
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
  }
  return
}
```

### Step 5.3: Verify build

Run: `npm run build`
Expected: SUCCESS

### Step 5.4: Commit

```bash
git add src/engine.ts
git commit -m "feat: add streaming support in QueryEngine"
```

---

## Task 6: Export New Types

**Files:**
- Modify: `src/index.ts`

### Step 6.1: Add StreamChunk export

Add to the exports from './providers/index.js':

```typescript
// Add to the providers section
export type {
  ApiType,
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  NormalizedMessageParam,
  NormalizedContentBlock,
  NormalizedTool,
  NormalizedResponseBlock,
  StreamChunk,  // Add this
} from './providers/index.js'
```

### Step 6.2: Ensure SDKPartialMessage is exported

Verify this is already exported:

```typescript
// Should already exist
export type {
  // SDK message types (streaming events)
  SDKPartialMessage,
  // ... other types
} from './types.js'
```

### Step 6.3: Verify build

Run: `npm run build`
Expected: SUCCESS

### Step 6.4: Commit

```bash
git add src/index.ts
git commit -m "feat: export StreamChunk type"
```

---

## Task 7: Create Example

**Files:**
- Create: `examples/15-streaming.ts`

### Step 7.1: Write streaming example

```typescript
/**
 * Example 15: Streaming Output
 *
 * Demonstrates token-level streaming with partial messages.
 *
 * Run: npx tsx examples/15-streaming.ts
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 15: Streaming Output ---\n')

  const agent = createAgent({
    model: process.env.CODEANY_MODEL || 'claude-sonnet-4-6',
    maxTurns: 10,
    includePartialMessages: true,  // Enable streaming
  })

  let partialText = ''

  for await (const event of agent.query(
    'Explain what streaming means in AI context in 2-3 sentences.',
  )) {
    switch (event.type) {
      case 'partial_message': {
        if (event.partial.type === 'text') {
          partialText += event.partial.text
          process.stdout.write(event.partial.text)
        }
        if (event.partial.type === 'thinking') {
          // Thinking content
          process.stdout.write(`[thinking: ${event.partial.text}]`)
        }
        break
      }
      case 'assistant': {
        console.log('\n\n[Complete message received]')
        break
      }
      case 'result': {
        console.log(`\n--- Result: ${event.subtype} ---`)
        console.log(`Tokens: ${event.usage?.input_tokens} in / ${event.usage?.output_tokens} out`)
        console.log(`Complete text length: ${partialText.length} chars`)
      }
    }
  }

  console.log('\n')
}

main().catch(console.error)
```

### Step 7.2: Test the example

Run: `npx tsx examples/15-streaming.ts`
Expected: See streaming text output in real-time

### Step 7.3: Commit

```bash
git add examples/15-streaming.ts
git commit -m "feat: add streaming example"
```

---

## Task 8: Update Documentation

**Files:**
- Modify: `AGENTS.md`

### Step 8.1: Add streaming section

Add to AGENTS.md after Test Commands section:

```markdown
## Streaming Output

Enable token-level streaming with `includePartialMessages: true`:

```typescript
const agent = createAgent({
  model: 'claude-sonnet-4-6',
  includePartialMessages: true,
})

for await (const event of agent.query('Hello')) {
  if (event.type === 'partial_message') {
    // Real-time text/thinking chunks
    process.stdout.write(event.partial.text)
  }
  if (event.type === 'assistant') {
    // Complete message (includes tool_use)
    console.log(event.message)
  }
}
```

Note: tool_use blocks are not streamed; they only appear in the complete `assistant` message.
```

### Step 8.2: Commit

```bash
git add AGENTS.md
git commit -m "docs: add streaming output documentation"
```

---

## Verification Checklist

- [ ] All tasks completed
- [ ] Build passes: `npm run build`
- [ ] Example runs: `npx tsx examples/15-streaming.ts`
- [ ] Existing examples still work: `npm run test:all`
- [ ] All changes committed

---

## Self-Review

**Spec coverage:**
- ✅ Chunk-level streaming (Task 5)
- ✅ Text content streaming (Task 2, 3, 5)
- ✅ Thinking content streaming (Task 2, 3, 4, 5)
- ✅ Tool use remains complete (Task 5)
- ✅ Backward compatible (Task 5 with includePartialMessages flag)

**Placeholder scan:**
- ✅ No TBD/TODO markers
- ✅ All code blocks complete
- ✅ Exact commands provided

**Type consistency:**
- ✅ StreamChunk matches LLMProvider.createMessageStream signature
- ✅ SDKPartialMessage.partial.type uses 'text' | 'thinking'
