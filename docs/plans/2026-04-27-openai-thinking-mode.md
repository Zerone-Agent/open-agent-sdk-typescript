# OpenAI Thinking Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `reasoning_content` (thinking mode) support to the OpenAI compatible API provider, enabling reasoning model output from DeepSeek-R1, Qwen-QWQ, etc.

**Architecture:** Reuse the existing thinking pipeline (StreamChunk, NormalizedContentBlock, ContentBlock, SDKPartialMessage already support thinking types). Only the OpenAI provider needs to start producing thinking chunks, and the engine needs to assemble them into the response.

**Tech Stack:** TypeScript, vitest for tests, native fetch for HTTP.

---

### Task 1: Add thinking variant to NormalizedResponseBlock

**Files:**
- Modify: `src/providers/types.ts:71-73`
- Test: `src/providers/__tests__/openai-thinking.test.ts`

**Step 1: Write the failing test**

Create `src/providers/__tests__/openai-thinking.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type { NormalizedResponseBlock } from '../types.js'

describe('NormalizedResponseBlock thinking type', () => {
  it('accepts thinking variant', () => {
    const block: NormalizedResponseBlock = {
      type: 'thinking',
      thinking: 'model reasoning here',
    }
    expect(block.type).toBe('thinking')
    expect(block.thinking).toBe('model reasoning here')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/__tests__/openai-thinking.test.ts`
Expected: FAIL — TypeScript compilation error, `thinking` not assignable to `NormalizedResponseBlock`

**Step 3: Write minimal implementation**

In `src/providers/types.ts`, line 71-73, change:

```typescript
export type NormalizedResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
```

to:

```typescript
export type NormalizedResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'thinking'; thinking: string }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/__tests__/openai-thinking.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/types.ts src/providers/__tests__/openai-thinking.test.ts
git commit -m "feat: add thinking variant to NormalizedResponseBlock"
```

---

### Task 2: Add reasoning_content to OpenAI type definitions

**Files:**
- Modify: `src/providers/openai.ts:60-65` (OpenAIChatMessage)
- Modify: `src/providers/openai.ts:85-101` (OpenAIChatResponse)

**Step 1: Update OpenAIChatMessage**

In `src/providers/openai.ts`, the `OpenAIChatMessage` interface at line 60, add `reasoning_content`:

```typescript
interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}
```

**Step 2: Update OpenAIChatResponse**

In `src/providers/openai.ts`, the `OpenAIChatResponse` interface at line 85, add `reasoning_content` to the message type:

```typescript
interface OpenAIChatResponse {
  id: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      reasoning_content?: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
```

**Step 3: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/providers/openai.ts
git commit -m "feat: add reasoning_content to OpenAI type definitions"
```

---

### Task 3: Parse reasoning_content in streaming

**Files:**
- Modify: `src/providers/openai.ts:210-220` (createMessageStream delta handling)
- Test: `src/providers/__tests__/openai-thinking.test.ts`

**Step 1: Write the failing test**

Append to `src/providers/__tests__/openai-thinking.test.ts`:

```typescript
import { OpenAIProvider } from '../openai.js'

function createMockStreamResponse(chunks: any[]): Response {
  const encoder = new TextEncoder()
  const lines = chunks.map(c => `data: ${JSON.stringify(c)}`).join('\n\n') + '\ndata: [DONE]\n'
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines))
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('OpenAI streaming reasoning_content', () => {
  it('yields thinking chunks for reasoning_content', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test', baseURL: 'http://localhost:1234' })
    const thinkingChunks: string[] = []
    const textChunks: string[] = []

    const streamChunks: any[] = [
      { choices: [{ delta: { reasoning_content: 'thinking part 1', role: 'assistant' }, index: 0 }] },
      { choices: [{ delta: { reasoning_content: ' thinking part 2' }, index: 0 }] },
      { choices: [{ delta: { content: 'hello', reasoning_content: null }, index: 0 }] },
      { choices: [{ delta: { content: ' world' }, index: 0 }] },
      { choices: [{ finish_reason: 'stop', delta: { content: '' }, index: 0 }] },
      { usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 } },
    ]

    const mockResponse = createMockStreamResponse(streamChunks)

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => mockResponse

    try {
      for await (const chunk of provider.createMessageStream!({
        model: 'deepseek-v4-flash',
        maxTokens: 1024,
        system: '',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        if (chunk.type === 'thinking') {
          thinkingChunks.push(chunk.delta || '')
        } else if (chunk.type === 'text') {
          textChunks.push(chunk.delta || '')
        }
      }
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(thinkingChunks).toEqual(['thinking part 1', ' thinking part 2'])
    expect(textChunks).toEqual(['hello', ' world'])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/__tests__/openai-thinking.test.ts`
Expected: FAIL — `thinkingChunks` is empty because reasoning_content is ignored

**Step 3: Write implementation**

In `src/providers/openai.ts`, after line 220 (after the `delta.content` block), add reasoning_content handling. Change the delta handling section (lines 213-220) from:

```typescript
      // Text content
      if (delta.content) {
        yield {
          type: 'text',
          index: currentBlockIndex,
          delta: delta.content,
        }
      }
```

to:

```typescript
      // Reasoning/thinking content (DeepSeek-R1, Qwen-QWQ, etc.)
      if (delta.reasoning_content) {
        yield {
          type: 'thinking',
          index: currentBlockIndex,
          delta: delta.reasoning_content,
        }
      }

      // Text content
      if (delta.content) {
        yield {
          type: 'text',
          index: currentBlockIndex,
          delta: delta.content,
        }
      }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/__tests__/openai-thinking.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/openai.ts src/providers/__tests__/openai-thinking.test.ts
git commit -m "feat: parse reasoning_content in OpenAI streaming responses"
```

---

### Task 4: Parse reasoning_content in non-streaming response

**Files:**
- Modify: `src/providers/openai.ts:391-443` (convertResponse)
- Test: `src/providers/__tests__/openai-thinking.test.ts`

**Step 1: Write the failing test**

Append to `src/providers/__tests__/openai-thinking.test.ts`:

```typescript
describe('OpenAI non-streaming reasoning_content', () => {
  it('includes thinking block when reasoning_content is present', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test', baseURL: 'http://localhost:1234' })

    const mockResponse = {
      ok: true,
      json: async () => ({
        id: 'chatcmpl-test',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello!',
            reasoning_content: 'user said hi, I should respond warmly',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
      }),
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => mockResponse as any

    try {
      const result = await provider.createMessage({
        model: 'deepseek-v4-flash',
        maxTokens: 1024,
        system: '',
        messages: [{ role: 'user', content: 'hi' }],
      })

      const thinkingBlock = result.content.find(b => b.type === 'thinking')
      expect(thinkingBlock).toEqual({
        type: 'thinking',
        thinking: 'user said hi, I should respond warmly',
      })
      const textBlock = result.content.find(b => b.type === 'text')
      expect(textBlock).toEqual({ type: 'text', text: 'Hello!' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/__tests__/openai-thinking.test.ts`
Expected: FAIL — `thinkingBlock` is undefined

**Step 3: Write implementation**

In `src/providers/openai.ts`, in the `convertResponse()` method at line 401, after the `content` array is created, add reasoning_content handling. Change from:

```typescript
    const content: NormalizedResponseBlock[] = []

    // Add text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content })
    }
```

to:

```typescript
    const content: NormalizedResponseBlock[] = []

    // Add thinking content (before text, matches streaming order)
    if (choice.message.reasoning_content) {
      content.push({ type: 'thinking', thinking: choice.message.reasoning_content })
    }

    // Add text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content })
    }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/__tests__/openai-thinking.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/openai.ts src/providers/__tests__/openai-thinking.test.ts
git commit -m "feat: parse reasoning_content in OpenAI non-streaming responses"
```

---

### Task 5: Filter thinking blocks in convertAssistantMessage

**Files:**
- Modify: `src/providers/openai.ts:330-370` (convertAssistantMessage)
- Test: `src/providers/__tests__/openai-thinking.test.ts`

**Step 1: Write the failing test**

Append to `src/providers/__tests__/openai-thinking.test.ts`:

```typescript
describe('OpenAI convertMessages filters thinking', () => {
  it('does not send thinking blocks back to the API', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test', baseURL: 'http://localhost:1234' })

    let capturedBody: any = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          id: 'chatcmpl-test',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        }),
      } as any
    }

    try {
      await provider.createMessage({
        model: 'test-model',
        maxTokens: 1024,
        system: 'you are helpful',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'internal reasoning' },
              { type: 'text', text: 'hello!' },
            ],
          },
          { role: 'user', content: 'how are you?' },
        ],
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    const assistantMsg = capturedBody.messages.find(
      (m: any) => m.role === 'assistant'
    )
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg.content).toBe('hello!')
    expect(assistantMsg.reasoning_content).toBeUndefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/__tests__/openai-thinking.test.ts`
Expected: FAIL — assistant message content might include thinking text or be wrong

**Step 3: Write implementation**

In `src/providers/openai.ts`, in `convertAssistantMessage()` at line 343, filter out thinking blocks. Change from:

```typescript
    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
```

to:

```typescript
    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'thinking') {
        // Skip thinking blocks — OpenAI-compatible models don't need them in requests
      } else if (block.type === 'tool_use') {
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/providers/__tests__/openai-thinking.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/openai.ts src/providers/__tests__/openai-thinking.test.ts
git commit -m "feat: filter thinking blocks from assistant messages in OpenAI requests"
```

---

### Task 6: Assemble thinking chunks in buildResponseFromChunks

**Files:**
- Modify: `src/engine.ts:156-221` (buildResponseFromChunks)
- Test: `src/providers/__tests__/openai-thinking.test.ts`

**Step 1: Write the failing test**

Append to `src/providers/__tests__/openai-thinking.test.ts`:

```typescript
describe('buildResponseFromChunks with thinking', () => {
  it('assembles thinking chunks into thinking block', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test', baseURL: 'http://localhost:1234' })

    const streamChunks: any[] = [
      { choices: [{ delta: { reasoning_content: 'part1', role: 'assistant' }, index: 0 }] },
      { choices: [{ delta: { reasoning_content: ' part2' }, index: 0 }] },
      { choices: [{ delta: { content: 'answer' }, index: 0 }] },
      { choices: [{ finish_reason: 'stop', delta: { content: '' }, index: 0 }] },
      { usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 } },
    ]

    const mockResponse = createMockStreamResponse(streamChunks)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => mockResponse

    try {
      const chunks: any[] = []
      for await (const chunk of provider.createMessageStream!({
        model: 'deepseek-v4-flash',
        maxTokens: 1024,
        system: '',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk)
      }

      const thinkingChunks = chunks.filter(c => c.type === 'thinking')
      const textChunks = chunks.filter(c => c.type === 'text')

      expect(thinkingChunks.length).toBe(2)
      expect(thinkingChunks[0].delta).toBe('part1')
      expect(thinkingChunks[1].delta).toBe(' part2')
      expect(textChunks.length).toBe(1)
      expect(textChunks[0].delta).toBe('answer')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
```

**Step 2: Write implementation**

In `src/engine.ts`, in `buildResponseFromChunks()` at line 173, change the thinking handling from:

```typescript
      if (chunk.type === 'thinking') {
        // Thinking is not part of NormalizedResponseBlock, skip for now
        // Could be added to content if needed
      }
```

to:

```typescript
      if (chunk.type === 'thinking') {
        if (!currentBlock || currentBlock.type !== 'thinking') {
          currentBlock = { type: 'thinking', thinking: chunk.delta || '' }
          content.push(currentBlock)
        } else {
          currentBlock.thinking += chunk.delta || ''
        }
      }
```

**Step 3: Run all tests to verify**

Run: `npx vitest run src/providers/__tests__/openai-thinking.test.ts`
Expected: ALL PASS

**Step 4: Run full type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/engine.ts src/providers/__tests__/openai-thinking.test.ts
git commit -m "feat: assemble thinking chunks in buildResponseFromChunks"
```

---

### Task 7: Final verification

**Step 1: Run all existing tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Run build**

Run: `npm run build`
Expected: Success
