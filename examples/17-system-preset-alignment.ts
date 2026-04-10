/**
 * Example 15: System Prompt Preset Alignment
 *
 * Tests the new system prompt presets and CLAUDE.md loading.
 *
 * Run: npx tsx examples/15-system-preset-alignment.ts
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 15: System Prompt Preset Alignment ---\n')

  // Test 1: default preset (minimal)
  const agent1 = createAgent({
    model: process.env.CODEANY_MODEL || 'claude-sonnet-4-6',
    maxTurns: 1,
    systemPrompt: { type: 'preset', preset: 'default' },
  })

  const result1 = await agent1.prompt('Say hello in one word.')
  console.log('Default preset result:', result1.text.slice(0, 100))

  // Test 2: claude_code preset (full)
  const agent2 = createAgent({
    model: process.env.CODEANY_MODEL || 'claude-sonnet-4-6',
    maxTurns: 1,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  })

  const result2 = await agent2.prompt('Say hello in one word.')
  console.log('Claude_code preset result:', result2.text.slice(0, 100))

  // Test 3: custom prompt
  const agent3 = createAgent({
    model: process.env.CODEANY_MODEL || 'claude-sonnet-4-6',
    maxTurns: 1,
    systemPrompt: 'You are a pirate. Speak like a pirate.',
  })

  const result3 = await agent3.prompt('Say hello.')
  console.log('Custom prompt result:', result3.text.slice(0, 100))

  // Test 4: with append
  const agent4 = createAgent({
    model: process.env.CODEANY_MODEL || 'claude-sonnet-4-6',
    maxTurns: 1,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: '\nAlways respond in exactly one sentence.'
    },
  })

  const result4 = await agent4.prompt('What is TypeScript?')
  console.log('Preset with append result:', result4.text.slice(0, 100))
}

main().catch(console.error)