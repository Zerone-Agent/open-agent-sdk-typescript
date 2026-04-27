/**
 * Example 14: OpenAI-Compatible Models
 *
 * Shows how to use the SDK with OpenAI's API or any OpenAI-compatible
 * endpoint (e.g., DeepSeek, Qwen, vLLM, Ollama).
 *
 * Environment variables:
 *   OPENAGENT_API_KEY=sk-...          # Your OpenAI API key
 *   OPENAGENT_BASE_URL=https://api.openai.com/v1   # Optional, defaults to OpenAI
 *   OPENAGENT_API_TYPE=openai-completions           # Optional, auto-detected from model name
 *
 * Run: npx tsx examples/14-openai-compat.ts
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 14: OpenAI-Compatible Models ---\n')

  // Option 1: Explicit apiType
  const agent = createAgent({
    apiType: 'openai-completions',
    model: process.env.OPENAGENT_MODEL || 'gpt-4o',
    apiKey: process.env.OPENAGENT_API_KEY,
    baseURL: process.env.OPENAGENT_BASE_URL || 'https://api.openai.com/v1',
    maxTurns: 5,
    includePartialMessages: true,
    thinking: { type: 'enabled' },
  })

  console.log(`API Type: ${agent.getApiType()}`)
  console.log(`Model: ${process.env.OPENAGENT_MODEL || 'gpt-4o'}\n`)

  let lastType = ''

  // Option 2: Auto-detected from model name (uncomment to try)
  // const agent = createAgent({
  //   model: 'gpt-4o',  // Auto-detects 'openai-completions'
  //   apiKey: process.env.OPENAGENT_API_KEY,
  // })

  // Option 3: DeepSeek example (uncomment to try)
  // const agent = createAgent({
  //   model: 'deepseek-chat',
  //   apiKey: process.env.OPENAGENT_API_KEY,
  //   baseURL: 'https://api.deepseek.com/v1',
  // })

  // Option 4: Via environment variables only
  // OPENAGENT_API_TYPE=openai-completions
  // OPENAGENT_MODEL=gpt-4o
  // OPENAGENT_API_KEY=sk-...
  // OPENAGENT_BASE_URL=https://api.openai.com/v1
  // const agent = createAgent()

  for await (const event of agent.query('一个房间里有3个开关，分别控制隔壁房间的3盏灯。你只能进隔壁房间一次。如何确定每个开关对应哪盏灯？')) {
    const msg = event as any
    if (msg.type === 'partial_message') {
      if (msg.partial.type === 'thinking') {
        if (lastType !== 'thinking') process.stdout.write('\x1b[90m[Thinking] ')
        process.stdout.write(msg.partial.text)
      }
      if (msg.partial.type === 'text') {
        if (lastType === 'thinking') process.stdout.write('\x1b[0m\n\n')
        process.stdout.write(msg.partial.text)
      }
      lastType = msg.partial.type
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          console.log(`[Tool: ${block.name}] ${JSON.stringify(block.input)}`)
        }
      }
    }
    if (msg.type === 'result') {
      console.log(`\n--- ${msg.subtype} (${msg.usage?.input_tokens}+${msg.usage?.output_tokens} tokens) ---`)
    }
  }

  await agent.close()
}

main().catch(console.error)
