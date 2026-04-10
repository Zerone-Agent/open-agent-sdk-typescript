/**
 * Example 14: Filesystem Skills
 * 
 * Demonstrates loading skills from .claude/skills/ directory.
 */
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { createAgent, getSkill, getAllSkills } from '../src/index.js'

async function main() {
  console.log('=== Example 14: Filesystem Skills ===\n')

  // Setup: Create test skill directory
  const testDir = join(process.cwd(), '.test-example-14')
  const skillDir = join(testDir, '.claude', 'skills', 'example-skill')

  await mkdir(skillDir, { recursive: true })
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
      settingSources: ['project'], // Load from .claude/skills/
      maxTurns: 1,
    })

    // Wait for skills to load
    await agent['setupDone']

    // Verify skill loaded
    const skill = getSkill('filesystem-example')
    console.log('Loaded skill:', !!skill)
    console.log('Name:', skill?.name)
    console.log('Description:', skill?.description)
    console.log('Model:', skill?.model)
    console.log('Allowed tools:', skill?.allowedTools)
    console.log()

    // Test invocation
    if (skill) {
      const blocks = await skill.getPrompt('test arguments', { cwd: testDir } as any)
      console.log('Prompt preview (first 200 chars):')
      console.log(blocks[0]?.type === 'text' ? blocks[0].text.slice(0, 200) + '...' : '(no text)')
    }

    await agent.close()
    console.log('\n✓ Example completed successfully')

  } finally {
    // Cleanup
    await rm(testDir, { recursive: true, force: true })
  }
}

main().catch(console.error)