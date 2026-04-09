/**
 * Example 16: Streaming with Tool Calls
 *
 * Demonstrates streaming output combined with tool execution.
 *
 * Run: npx tsx examples/16-streaming-with-tools.ts
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 16: Streaming with Tool Calls ---\n')

  const agent = createAgent({
    model: process.env.CODEANY_MODEL || 'claude-sonnet-4-6',
    maxTurns: 10,
    includePartialMessages: true,
    thinking: { type: 'enabled', budgetTokens: 2000 },
  })

  let lastType = ''

  for await (const event of agent.query(
    '使用 Read 工具读取当前目录下的 package.json 文件，告诉我项目名称和版本号。',
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
        const toolUses = (event.message?.content || []).filter(
          (block: any) => block.type === 'tool_use',
        )
        if (toolUses.length > 0) {
          console.log('\n\n[Tool Calls]')
          for (const tool of toolUses) {
            console.log(`  - ${tool.name}: ${JSON.stringify(tool.input).slice(0, 100)}`)
          }
        }
        break
      }
      case 'tool_result': {
        console.log(`\n[Tool Result] ${event.result.tool_name}`)
        console.log(
          event.result.output.slice(0, 200) +
            (event.result.output.length > 200 ? '...' : ''),
        )
        break
      }
      case 'result': {
        console.log(`\n\n--- Result: ${event.subtype} ---`)
        console.log(`Tokens: ${event.usage?.input_tokens} in / ${event.usage?.output_tokens} out`)
        console.log(`Turns: ${event.num_turns}`)
        if (event.errors) {
          console.log(`Errors: ${event.errors.join(', ')}`)
        }
      }
    }
  }

  console.log('\n')
}

main().catch(console.error)