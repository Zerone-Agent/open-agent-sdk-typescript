/**
 * Example 14: Filesystem Skills
 *
 * Demonstrates loading skills from .claude/skills/ directory.
 */
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { createAgent, getSkill } from '../src/index.js'

async function main() {
  console.log('=== Example 14: Filesystem Skills ===\n')

  // Setup: Create test skill directory
  const testDir = join(process.cwd(), '.test-example-14')
  const skillDir = join(testDir, '.claude', 'skills', 'example-skill')

  await mkdir(skillDir, { recursive: true })

  // Setup: Create project-level AGENTS.md
  await writeFile(join(testDir, 'AGENTS.md'), `# Project Instructions

This is a test project for verifying filesystem skill loading.

## Guidelines
- Always use the filesystem-example skill when examining files
- Prefer the Read tool over Bash for file inspection
`)

  await writeFile(join(skillDir, 'SKILL.md'), `---
name: filesystem-example
description: An example skill loaded from filesystem
model: claude-sonnet-4-6
allowed-tools:
  - Read
  - Glob
---

# Example Skill

This skill demonstrates filesystem loading.

Use the Read tool to examine files in: \${CLAUDE_SKILL_DIR}

Arguments: \${args}
`)

  try {
    // Create agent with settingSources
    const agent = createAgent({
      cwd: testDir,
      settingSources: ['project'],
      maxTurns: 2,
    })

    // Wait for skills to load
    await agent['setupDone']

    // Verify skill loaded
    const skill = getSkill('filesystem-example')
    console.log('Loaded skill:', !!skill)
    console.log('Name:', skill?.name)
    console.log('Description:', skill?.description)
    console.log()

    // Test with actual LLM query
    console.log('=== Sending query to agent ===\n')

    const messages: any[] = []
    for await (const event of agent.query('Use the filesystem-example skill to read the SKILL.md file')) {
      messages.push(event)

      if (event.type === 'system') {
        console.log('--- System Message ---')
        const { system_prompt, ...rest } = event as any
        console.log(JSON.stringify(rest, null, 2))
        if (system_prompt) {
          console.log('  "system_prompt":')
          console.log('---')
          console.log(system_prompt)
          console.log('---')
        }
      } else if (event.type === 'assistant') {
        console.log('--- Assistant Message ---')
        console.log(JSON.stringify(event.message, null, 2))
      } else if (event.type === 'tool_result') {
        console.log('--- Tool Result ---')
        console.log(JSON.stringify(event.result, null, 2))
      } else if (event.type === 'result') {
        console.log('--- Final Result ---')
        console.log(JSON.stringify(event, null, 2))
      }
    }

    console.log('\n=== All Events Summary ===')
    console.log('Total events:', messages.length)
    console.log('Event types:', messages.map(m => m.type).join(', '))

    // Get session messages
    const sessionMessages = agent.getMessages()
    console.log('\n=== Session Messages (full history) ===')
    console.log(JSON.stringify(sessionMessages, null, 2))

    await agent.close()
    console.log('\n✓ Example completed successfully')

  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
}

main().catch(console.error)