/**
 * Test: Parallel Tool Calls (Streaming)
 *
 * Tests that multiple tool_use blocks are correctly handled in streaming mode.
 * Run: npx tsx examples/test-parallel-tools.ts
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Test: Parallel Tool Calls ---\n')

  const agent = createAgent({
    model: process.env.OPENAGENT_MODEL || 'claude-sonnet-4-6',
    maxTurns: 3,
    includePartialMessages: true,
  })

  const userPrompt = 'Use BOTH Glob AND Bash in parallel: ' +
    '1) Glob to find "*.ts" in src/ ' +
    '2) Bash to run "ls -la src/" ' +
    'Do both at the same time, not sequentially.'

  console.log('=== USER REQUEST ===')
  console.log(userPrompt)
  console.log('\n')

  const toolCalls: Array<{ id: string; name: string; input: any }> = []
  const toolResults: Array<{ tool_use_id: string; tool_name: string; output: string }> = []

  for await (const event of agent.query(userPrompt)) {
    const msg = event as any

    if (msg.type === 'partial_message') {
      process.stdout.write(msg.partial.text || '')
    }

    if (msg.type === 'assistant') {
      console.log('\n=== LLM RESPONSE ===')
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, input: block.input })
          console.log(`\n[Tool Call #${toolCalls.length}]`)
          console.log(`  id: ${block.id}`)
          console.log(`  name: ${block.name}`)
          console.log(`  input: ${JSON.stringify(block.input, null, 2)}`)
        }
        if (block.type === 'text' && block.text.trim()) {
          console.log(`\n[Text] ${block.text}`)
        }
      }
    }

    if (msg.type === 'tool_result') {
      toolResults.push({ 
        tool_use_id: msg.result.tool_use_id, 
        tool_name: msg.result.tool_name,
        output: msg.result.output 
      })
      console.log(`\n=== TOOL RESULT #${toolResults.length} ===`)
      console.log(`  tool_use_id: ${msg.result.tool_use_id}`)
      console.log(`  tool_name: ${msg.result.tool_name}`)
      console.log(`  output: ${msg.result.output.slice(0, 500)}${msg.result.output.length > 500 ? '...(truncated)' : ''}`)
    }

    if (msg.type === 'result') {
      console.log(`\n\n=== FINAL RESULT ===`)
      console.log(`  subtype: ${msg.subtype}`)
      console.log(`  num_turns: ${msg.num_turns}`)
      console.log(`  tokens: ${msg.usage?.input_tokens} in / ${msg.usage?.output_tokens} out`)
      console.log(`  tool_calls made: ${toolCalls.length}`)
      console.log(`  tool_results received: ${toolResults.length}`)
      
      if (toolCalls.length >= 2 && toolResults.length >= 2) {
        console.log('\n✅ PASS: Multiple parallel tool calls handled correctly')
      } else if (toolCalls.length === 0) {
        console.log('\n⚠️  No tool calls - check API connection')
      } else {
        console.log('\n❌ FAIL: Expected at least 2 parallel tool calls')
      }
    }
  }
}

main().catch(console.error)