/**
 * Example 1: Simple Query with Streaming
 *
 * Demonstrates the basic createAgent() + query() flow with
 * real-time event streaming.
 *
 * Run: npx tsx examples/01-simple-query.ts
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 1: Simple Query ---\n')

  const agent = createAgent({
    model: process.env.OPENAGENT_MODEL || 'claude-sonnet-4-6',
    maxTurns: 10,
  })

  const userPrompt = 'Read package.json and tell me the project name and version in one sentence.'

  console.log('=== USER REQUEST ===')
  console.log(userPrompt)
  console.log('\n')

  let turnCount = 0

  for await (const event of agent.query(userPrompt)) {
    const msg = event as any

    if (msg.type === 'assistant') {
      turnCount++
      console.log(`\n=== LLM RESPONSE (Turn ${turnCount}) ===`)
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          console.log(`\n[Tool Call]`)
          console.log(`  id: ${block.id}`)
          console.log(`  name: ${block.name}`)
          console.log(`  input: ${JSON.stringify(block.input, null, 2)}`)
        }
        if (block.type === 'text') {
          console.log(`\n[Text Response]\n${block.text}`)
        }
      }
    }

    if (msg.type === 'tool_result') {
      console.log(`\n=== TOOL RESULT ===`)
      console.log(`  tool_name: ${msg.result.tool_name}`)
      console.log(`  output: ${msg.result.output}`)
    }

    if (msg.type === 'result') {
      console.log(`\n=== FINAL RESULT ===`)
      console.log(`  subtype: ${msg.subtype}`)
      console.log(`  num_turns: ${msg.num_turns}`)
      console.log(`  tokens: ${msg.usage?.input_tokens} in / ${msg.usage?.output_tokens} out`)
    }
  }
}

main().catch(console.error)
