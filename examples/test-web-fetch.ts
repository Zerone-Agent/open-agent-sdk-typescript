/**
 * Test: WebFetch Tool
 *
 * Tests the WebFetch tool with real websites.
 * Run: npx tsx examples/test-web-fetch.ts
 */

import { WebFetchTool } from '../src/tools/web-fetch'
import { createAgent } from '../src/index'

async function testDirectCall() {
  console.log('--- Test 1: Direct Call ---\n')

  console.log('Fetching https://www.baidu.com...\n')
  const result = await WebFetchTool.call({ url: 'https://www.baidu.com' }, {})

  console.log('is_error:', result.is_error)
  console.log('content length:', result.content.length)
  console.log('content preview:', result.content.slice(0, 500))

  if (!result.is_error && result.content.length > 0 && !result.content.includes('<')) {
    console.log('\n✅ PASS: Direct call to baidu.com\n')
    return true
  } else {
    console.log('\n❌ FAIL\n')
    return false
  }
}

async function testLLMCall() {
  console.log('--- Test 2: LLM Call ---\n')

  const apiKey = process.env.CODEANY_API_KEY || process.env.CODEANY_AUTH_TOKEN
  if (!apiKey) {
    console.log('⚠️  SKIP: No CODEANY_API_KEY set, skipping LLM test\n')
    return true
  }

  const agent = createAgent({
    model: process.env.CODEANY_MODEL || 'claude-sonnet-4-6',
    maxTurns: 5,
  })

  console.log('Using WebFetch to fetch baidu.com via LLM...\n')

  const userPrompt = 'Use WebFetch to fetch https://www.baidu.com and tell me what the page is about in one sentence.'

  let toolCalled = false
  let toolSuccess = false

  for await (const event of agent.query(userPrompt)) {
    const msg = event as any

    if (msg.type === 'assistant') {
      console.log('\n=== LLM RESPONSE ===')
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          console.log(`\n[Tool Call]`)
          console.log(`  name: ${block.name}`)
          console.log(`  input: ${JSON.stringify(block.input, null, 2)}`)
          if (block.name === 'WebFetch') {
            toolCalled = true
          }
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
      if (msg.result.tool_name === 'WebFetch' && !msg.result.is_error) {
        toolSuccess = true
      }
    }

    if (msg.type === 'result') {
      console.log(`\n=== FINAL RESULT ===`)
      console.log(`  num_turns: ${msg.num_turns}`)
    }
  }

  if (toolCalled && toolSuccess) {
    console.log('\n✅ PASS: LLM called WebFetch successfully\n')
    return true
  } else {
    console.log('\n❌ FAIL: LLM did not call WebFetch or call failed\n')
    return false
  }
}

async function main() {
  console.log('--- WebFetch Tool Tests ---\n')

  const result1 = await testDirectCall()
  const result2 = await testLLMCall()

  if (result1 && result2) {
    console.log('=== All Tests Passed ===')
    process.exit(0)
  } else {
    console.log('=== Some Tests Failed ===')
    process.exit(1)
  }
}

main().catch(console.error)