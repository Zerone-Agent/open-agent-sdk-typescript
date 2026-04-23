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
    model: process.env.OPENAGENT_MODEL || 'claude-sonnet-4-6',
    maxTurns: 10,
    includePartialMessages: true,
    thinking: { type: 'enabled', budgetTokens: 2000 },
  })

  let lastType = ''

  for await (const event of agent.query(
    '27 乘以 43 等于多少？请展示你的推理过程。',
  )) {
    switch (event.type) {
      case 'partial_message': {
        if (event.partial.type === 'text') {
          if (lastType === 'thinking') {
            process.stdout.write('\n\n')
          }
          process.stdout.write(event.partial.text)
        }
        if (event.partial.type === 'thinking') {
          process.stdout.write(`\x1b[90m${event.partial.text}\x1b[0m`)
        }
        lastType = event.partial.type
        break
      }
      case 'assistant': {
        console.log('\n\n[Complete message received]')
        break
      }
      case 'result': {
        console.log(`\n--- Result: ${event.subtype} ---`)
        console.log(`Tokens: ${event.usage?.input_tokens} in / ${event.usage?.output_tokens} out`)
        if (event.errors) {
          console.log(`Errors: ${event.errors.join(', ')}`)
        }
      }
    }
  }

  console.log('\n')
}

main().catch(console.error)