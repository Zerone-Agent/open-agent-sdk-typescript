/**
 * Example 2: Multi-Tool Orchestration
 *
 * The agent autonomously uses Glob, Bash, and Read tools to
 * accomplish a multi-step task.
 *
 * Run: npx tsx examples/02-multi-tool.ts
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 2: Multi-Tool Orchestration ---\n')

  const agent = createAgent({
    model: process.env.OPENAGENT_MODEL || 'claude-sonnet-4-6',
    maxTurns: 15,
  })

  const userPrompt = 'Do these steps: ' +
    '1) Use Glob to find all .ts files in src/ (pattern "src/*.ts"). ' +
    '2) Use Bash to count lines in src/agent.ts with `wc -l`. ' +
    '3) Give a brief summary.'

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
        if (block.type === 'text' && block.text.trim()) {
          console.log(`\n[Text Response]\n${block.text}`)
        }
      }
    }

    if (msg.type === 'tool_result') {
      console.log(`\n=== TOOL RESULT ===`)
      console.log(`  tool_name: ${msg.result.tool_name}`)
      console.log(`  output: ${msg.result.output.slice(0, 300)}${msg.result.output.length > 300 ? '...(truncated)' : ''}`)
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
