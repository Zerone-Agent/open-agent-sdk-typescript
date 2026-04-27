# OpenAI Compatible API Thinking Mode Support

## Background

The OpenAI compatible provider currently ignores `reasoning_content` in streaming and non-streaming responses from reasoning models (DeepSeek-R1, Qwen-QWQ, etc.). The Anthropic provider already supports thinking via `thinking_delta` events. The type system already defines thinking types (`StreamChunk.type = 'thinking'`, `NormalizedContentBlock`, `ContentBlock`, `SDKPartialMessage`), but the OpenAI provider never produces them.

## Requirements

- Parse `delta.reasoning_content` from OpenAI-compatible streaming responses
- Parse `message.reasoning_content` from non-streaming responses
- Thinking content preserved in final response (`AssistantMessage.content`)
- Thinking delivered via streaming events (`SDKPartialMessage`)
- Thinking NOT sent back to API in multi-turn conversations (OpenAI models don't need it)
- No request parameter changes needed (models decide when to think)
- Minimal changes, reuse existing thinking pipeline

## API Format Reference

Streaming response from DeepSeek:
```json
{"choices":[{"delta":{"content":null,"reasoning_content":"思考内容","role":"assistant"},"finish_reason":null,"index":0}]}
```

- `reasoning_content` and `content` are mutually exclusive per chunk
- `reasoning_content` chunks come first, then `content` chunks
- Usage includes `reasoning_tokens` in `completion_tokens_details`

## Changes

### 1. `src/providers/types.ts` - Add thinking to NormalizedResponseBlock

Add `{ type: 'thinking'; thinking: string }` variant to `NormalizedResponseBlock`.

### 2. `src/providers/openai.ts` - Stream parsing

In `createMessageStream()`, check for `delta.reasoning_content` and yield `{ type: 'thinking', index, delta: delta.reasoning_content }` chunks. Handle `null` values (when content is active, reasoning_content is null).

### 3. `src/providers/openai.ts` - Non-streaming response

In response conversion, check `message.reasoning_content` and include as thinking block.

### 4. `src/providers/openai.ts` - Type definitions

Add `reasoning_content?: string | null` to `OpenAIChatMessage` interface.

### 5. `src/providers/openai.ts` - Filter thinking in convertMessages

In `convertMessages()`, filter out `{ type: 'thinking' }` blocks from assistant message content before sending to API. OpenAI-compatible models don't expect thinking in request messages.

### 6. `src/engine.ts` - buildResponseFromChunks

Update `buildResponseFromChunks()` to accumulate thinking chunks into a `{ type: 'thinking', thinking: string }` block in the content array, instead of skipping them.

## Data Flow

```
OpenAI API Response
       |
       v
OpenAI Provider
  +- stream: delta.reasoning_content -> StreamChunk { type: 'thinking', delta }
  +- non-stream: message.reasoning_content -> thinking block
  +- convertMessages: filter out thinking from assistant messages
       |
       v
QueryEngine
  +- streaming: yield SDKPartialMessage { type: 'thinking' }
  +- buildResponseFromChunks: thinking -> { type: 'thinking', thinking: '...' }
  +- assistant message includes thinking in content
       |
       v
SDK Consumer
  +- streaming events show thinking partial messages
  +- final assistant message contains thinking block
```

## Non-Goals

- No request parameter changes for enabling/disabling thinking
- No changes to Anthropic provider behavior
- No thinking content roundtrip to API in multi-turn conversations
