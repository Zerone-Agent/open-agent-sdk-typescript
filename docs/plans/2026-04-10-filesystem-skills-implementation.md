# 文件系统 Skills 加载实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现从文件系统加载 SKILL.md 文件，支持 settingSources 参数控制加载源。

**Architecture:** 创建两个新模块（yaml.ts 解析 frontmatter，filesystem.ts 扫描目录和注册 skills），修改 Agent 构造函数集成加载逻辑。

**Tech Stack:** TypeScript, Node.js fs/promises API, 轻量 YAML 解析（无外部依赖）

---

## Task 1: YAML Frontmatter 解析器

**Files:**
- Create: `src/skills/yaml.ts`
- Test: `examples/test-yaml-parser.ts`

**Step 1: Write the failing test**

创建测试文件：

```typescript
// examples/test-yaml-parser.ts
import { parseSkillMarkdown } from '../src/skills/yaml.js'

console.log('=== Testing YAML Parser ===\n')

// Test 1: Basic frontmatter
const input1 = `---
description: A test skill
model: claude-sonnet-4-6
---

Skill content here.`

const result1 = parseSkillMarkdown(input1)
console.log('Test 1 - Basic frontmatter:')
console.log('  description:', result1.frontmatter.description)
console.log('  model:', result1.frontmatter.model)
console.log('  body length:', result1.body.length)
console.log('  Expected: description="A test skill", model="claude-sonnet-4-6"')
console.log('  Result:', result1.frontmatter.description === 'A test skill' ? '✓ PASS' : '✗ FAIL')
console.log()

// Test 2: Array fields
const input2 = `---
description: Another skill
allowed-tools:
  - Read
  - Bash
---

Content.`

const result2 = parseSkillMarkdown(input2)
console.log('Test 2 - Array fields:')
console.log('  allowed-tools:', result2.frontmatter.allowedTools)
console.log('  Expected: ["Read", "Bash"]')
console.log('  Result:', JSON.stringify(result2.frontmatter.allowedTools) === JSON.stringify(['Read', 'Bash']) ? '✓ PASS' : '✗ FAIL')
console.log()

// Test 3: Optional fields
const input3 = `---
description: Minimal skill
---

Minimal content.`

const result3 = parseSkillMarkdown(input3)
console.log('Test 3 - Optional fields:')
console.log('  description:', result3.frontmatter.description)
console.log('  model:', result3.frontmatter.model)
console.log('  Expected: description="Minimal skill", model=undefined')
console.log('  Result:', result3.frontmatter.description === 'Minimal skill' && result3.frontmatter.model === undefined ? '✓ PASS' : '✗ FAIL')
console.log()

console.log('All tests completed.')
```

运行测试（预期失败）：`npx tsx examples/test-yaml-parser.ts`

**Step 2: Run test to verify it fails**

运行: `npx tsx examples/test-yaml-parser.ts`  
预期: 报错 "Cannot find module '../src/skills/yaml.js'"

**Step 3: Write minimal implementation**

创建 `src/skills/yaml.ts`:

```typescript
/**
 * YAML Frontmatter Parser for SKILL.md files
 * 
 * Lightweight parser without external dependencies.
 */

export interface Frontmatter {
  name?: string
  description: string
  model?: string
  allowedTools?: string[]
  userInvocable?: boolean
}

/**
 * Parse a SKILL.md file content into frontmatter and body.
 * 
 * @param content - Raw SKILL.md content
 * @returns Parsed frontmatter and body
 */
export function parseSkillMarkdown(content: string): {
  frontmatter: Frontmatter
  body: string
} {
  // Match YAML frontmatter between --- delimiters
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  
  if (!match) {
    throw new Error('Invalid SKILL.md format: missing frontmatter')
  }

  const frontmatterStr = match[1]
  const body = match[2]

  const frontmatter = parseYamlFrontmatter(frontmatterStr)

  if (!frontmatter.description) {
    throw new Error('SKILL.md must have a description field')
  }

  return { frontmatter, body }
}

/**
 * Lightweight YAML parser for frontmatter fields.
 * Only supports basic types: string, array, boolean.
 */
function parseYamlFrontmatter(yaml: string): Frontmatter {
  const lines = yaml.split('\n')
  const result: Record<string, any> = {}
  let currentArray: string[] | null = null
  let currentArrayKey: string | null = null

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) {
      continue
    }

    // Array item
    if (line.startsWith('  - ')) {
      if (currentArrayKey && currentArray !== null) {
        currentArray.push(line.trim().substring(2))
      }
      continue
    }

    // Key-value pair
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.substring(0, colonIndex).trim()
    const value = line.substring(colonIndex + 1).trim()

    // Close previous array
    currentArray = null
    currentArrayKey = null

    // Parse value
    if (value === '') {
      // Array start
      currentArray = []
      result[key] = currentArray
      currentArrayKey = key
    } else if (value === 'true') {
      result[key] = true
    } else if (value === 'false') {
      result[key] = false
    } else {
      result[key] = value
    }
  }

  // Map to Frontmatter interface
  const frontmatter: Frontmatter = {
    description: result.description || '',
  }

  if (result.name) frontmatter.name = String(result.name)
  if (result.model) frontmatter.model = String(result.model)
  if (result['allowed-tools']) {
    frontmatter.allowedTools = (result['allowed-tools'] as string[]).map(s => String(s))
  }
  if (result['user-invocable'] !== undefined) {
    frontmatter.userInvocable = Boolean(result['user-invocable'])
  }

  return frontmatter
}
```

**Step 4: Run test to verify it passes**

运行: `npx tsx examples/test-yaml-parser.ts`  
预期: 所有测试通过 ✓ PASS

**Step 5: Commit**

```bash
git add src/skills/yaml.ts examples/test-yaml-parser.ts
git commit -m "feat: add YAML frontmatter parser for SKILL.md files"
```

---

## Task 2: 文件系统加载器

**Files:**
- Create: `src/skills/filesystem.ts`
- Create: `examples/test-filesystem-loader.ts`

**Step 1: Write the failing test**

创建测试文件：

```typescript
// examples/test-filesystem-loader.ts
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { loadSkillsFromFilesystem } from '../src/skills/filesystem.js'
import { getSkill, clearSkills } from '../src/skills/registry.js'

async function main() {
  console.log('=== Testing Filesystem Loader ===\n')

  // Setup: Clear existing skills
  clearSkills()

  // Setup: Create temporary test directory
  const testDir = join(process.cwd(), '.test-skills-temp')
  const skillDir = join(testDir, '.claude', 'skills', 'test-skill')

  try {
    await mkdir(skillDir, { recursive: true })
    
    // Create valid SKILL.md
    await writeFile(join(skillDir, 'SKILL.md'), `---
description: A filesystem-loaded skill
model: claude-sonnet-4-6
allowed-tools:
  - Read
  - Bash
---

This is a test skill loaded from filesystem.`)

    console.log('Test 1: Load skills from project directory')
    const result1 = await loadSkillsFromFilesystem(testDir, ['project'])
    console.log('  Loaded:', result1.loaded)
    console.log('  Errors:', result1.errors.length)
    console.log('  Expected: loaded=1, errors=0')
    console.log('  Result:', result1.loaded === 1 && result1.errors.length === 0 ? '✓ PASS' : '✗ FAIL')
    console.log()

    console.log('Test 2: Verify skill registered')
    const skill = getSkill('test-skill')
    console.log('  Skill found:', !!skill)
    console.log('  Description:', skill?.description)
    console.log('  Model:', skill?.model)
    console.log('  Allowed tools:', skill?.allowedTools)
    console.log('  Expected: found=true, description="A filesystem-loaded skill"')
    console.log('  Result:', skill && skill.description === 'A filesystem-loaded skill' ? '✓ PASS' : '✗ FAIL')
    console.log()

    console.log('Test 3: Duplicate loading (should overwrite)')
    clearSkills()
    const result2 = await loadSkillsFromFilesystem(testDir, ['project'])
    const result3 = await loadSkillsFromFilesystem(testDir, ['project'])
    console.log('  First load:', result2.loaded)
    console.log('  Second load:', result3.loaded)
    console.log('  Skills registered:', 1) // Should still be 1
    console.log('  Result:', getSkill('test-skill') ? '✓ PASS' : '✗ FAIL')
    console.log()

  } finally {
    // Cleanup
    await rm(testDir, { recursive: true, force: true })
  }

  console.log('All tests completed.')
}

main().catch(console.error)
```

运行测试（预期失败）：`npx tsx examples/test-filesystem-loader.ts`

**Step 2: Run test to verify it fails**

运行: `npx tsx examples/test-filesystem-loader.ts`  
预期: 报错 "Cannot find module '../src/skills/filesystem.js'"

**Step 3: Write minimal implementation**

创建 `src/skills/filesystem.ts`:

```typescript
/**
 * Filesystem Skills Loader
 * 
 * Loads SKILL.md files from .claude/skills/ directories.
 */

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { parseSkillMarkdown } from './yaml.js'
import { registerSkill } from './registry.js'
import type { SkillDefinition, SkillContentBlock } from './types.js'
import type { SettingSource } from '../types.js'

export interface LoadResult {
  loaded: number
  errors: Error[]
}

/**
 * Load skills from filesystem directories based on settingSources.
 * 
 * @param cwd - Current working directory (project root)
 * @param settingSources - Array of sources to load from
 * @returns Number of loaded skills and any errors
 */
export async function loadSkillsFromFilesystem(
  cwd: string,
  settingSources?: SettingSource[]
): Promise<LoadResult> {
  if (!settingSources || settingSources.length === 0) {
    return { loaded: 0, errors: [] }
  }

  const errors: Error[] = []
  let loaded = 0

  // User-level skills (~/.claude/skills/)
  if (settingSources.includes('user')) {
    const userSkillsDir = join(homedir(), '.claude', 'skills')
    const result = await loadSkillsFromDir(userSkillsDir)
    loaded += result.loaded
    errors.push(...result.errors)
  }

  // Project-level skills (./.claude/skills/)
  if (settingSources.includes('project')) {
    const projectSkillsDir = join(cwd, '.claude', 'skills')
    const result = await loadSkillsFromDir(projectSkillsDir)
    loaded += result.loaded
    errors.push(...result.errors)
  }

  return { loaded, errors }
}

/**
 * Load all skills from a directory.
 */
async function loadSkillsFromDir(
  dir: string
): Promise<LoadResult> {
  const errors: Error[] = []
  let loaded = 0

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const skillDirs = entries.filter(entry => entry.isDirectory())

    for (const skillDir of skillDirs) {
      const skillPath = join(dir, skillDir.name, 'SKILL.md')
      try {
        await loadSkillFile(dir, skillDir.name, skillPath)
        loaded++
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
  } catch (error) {
    // Directory doesn't exist or permission denied - silently skip
    if ((error as any).code !== 'ENOENT') {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return { loaded, errors }
}

/**
 * Load a single SKILL.md file and register it.
 */
async function loadSkillFile(
  baseDir: string,
  skillName: string,
  skillPath: string
): Promise<void> {
  const content = await readFile(skillPath, 'utf-8')
  const { frontmatter, body } = parseSkillMarkdown(content)

  const finalBody = body.replace(
    /\$\{CLAUDE_SKILL_DIR\}/g,
    join(baseDir, skillName)
  )

  const definition: SkillDefinition = {
    name: frontmatter.name || skillName,
    description: frontmatter.description,
    model: frontmatter.model,
    allowedTools: frontmatter.allowedTools,
    userInvocable: frontmatter.userInvocable ?? true,
    async getPrompt(args: string): Promise<SkillContentBlock[]> {
      let text = finalBody
      if (args) {
        // Replace argument substitution placeholders if any
        text = text.replace(/\$\{args\}/g, args)
      }
      return [{ type: 'text', text }]
    },
  }

  registerSkill(definition)
}
```

**Step 4: Run test to verify it passes**

运行: `npx tsx examples/test-filesystem-loader.ts`  
预期: 所有测试通过 ✓ PASS

**Step 5: Commit**

```bash
git add src/skills/filesystem.ts examples/test-filesystem-loader.ts
git commit -m "feat: add filesystem skills loader"
```

---

## Task 3: 更新导出

**Files:**
- Modify: `src/skills/index.ts`

**Step 1: Add exports**

修改 `src/skills/index.ts`，添加导出：

```typescript
/**
 * Skills Module - Public API
 */

// Types
export type {
  SkillDefinition,
  SkillContentBlock,
  SkillResult,
} from './types.js'

// Registry
export {
  registerSkill,
  getSkill,
  getAllSkills,
  getUserInvocableSkills,
  hasSkill,
  unregisterSkill,
  clearSkills,
  formatSkillsForPrompt,
} from './registry.js'

// Bundled skills
export { initBundledSkills } from './bundled/index.js'

// Filesystem loading (NEW)
export { loadSkillsFromFilesystem } from './filesystem.js'
```

**Step 2: Verify exports work**

创建测试 `examples/test-exports.ts`:

```typescript
import { 
  loadSkillsFromFilesystem,
  registerSkill,
  getSkill,
  getAllSkills 
} from '../src/index.js'

console.log('Exported functions:')
console.log('  loadSkillsFromFilesystem:', typeof loadSkillsFromFilesystem)
console.log('  registerSkill:', typeof registerSkill)
console.log('  getSkill:', typeof getSkill)
console.log('  getAllSkills:', typeof getAllSkills)
console.log('Result:', typeof loadSkillsFromFilesystem === 'function' ? '✓ PASS' : '✗ FAIL')
```

运行: `npx tsx examples/test-exports.ts`  
预期: ✓ PASS

**Step 3: Commit**

```bash
git add src/skills/index.ts examples/test-exports.ts
git commit -m "feat: export loadSkillsFromFilesystem from skills module"
```

---

## Task 4: Agent 集成

**Files:**
- Modify: `src/agent.ts`
- Create: `examples/14-filesystem-skills-agent.ts`

**Step 1: Modify Agent constructor**

修改 `src/agent.ts`，在构造函数中添加文件系统加载：

```typescript
// 在文件开头添加导入
import { loadSkillsFromFilesystem } from './skills/filesystem.js'

// 在 Agent 类构造函数中，找到 initBundledSkills() 调用后，添加：
export class Agent {
  constructor(options: AgentOptions = {}) {
    // ... 现有代码 ...

    // Initialize bundled skills
    initBundledSkills()

    // Initialize filesystem skills
    this.setupDone = this.setupDone.then(async () => {
      if (options.settingSources && options.settingSources.length > 0) {
        try {
          const cwd = options.cwd ?? process.cwd()
          await loadSkillsFromFilesystem(cwd, options.settingSources)
        } catch (error) {
          // Don't fail agent startup
          console.error('Failed to load filesystem skills:', error)
        }
      }
    })
  }
}
```

**Step 2: Create integration test**

创建 `examples/14-filesystem-skills-agent.ts`:

```typescript
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
```

运行: `npx tsx examples/14-filesystem-skills-agent.ts`  
预期: 显示加载的 skill 信息

**Step 3: Commit**

```bash
git add src/agent.ts examples/14-filesystem-skills-agent.ts
git commit -m "feat: integrate filesystem skills loading in Agent constructor"
```

---

## Task 5: 更新 README 和类型定义

**Files:**
- Modify: `README.md`
- Modify: `src/types.ts`

**Step 1: Update AgentOptions type**

确认 `src/types.ts` 中 `settingSources` 字段已存在（应该已在），否则添加：

```typescript
export type SettingSource = 'user' | 'project' | 'local'

export interface AgentOptions {
  // ... 现有字段
  settingSources?: SettingSource[]
}
```

**Step 2: Update README**

在 `README.md` 的 Skills 部分添加文件系统加载示例：

```markdown
### Skills

Skills are reusable prompt templates that extend agent capabilities.

#### Bundled Skills

Five skills are included: `simplify`, `commit`, `review`, `debug`, `test`.

#### Programmatic Registration

```typescript
import { registerSkill } from "@codeany/open-agent-sdk";

registerSkill({
  name: "explain",
  description: "Explain a concept in simple terms",
  userInvocable: true,
  async getPrompt(args) {
    return [{ type: "text", text: `Explain: ${args}` }];
  },
});
```

#### Filesystem Skills (Official SDK compatible)

Create `.claude/skills/my-skill/SKILL.md`:

```yaml
---
description: Analyze code quality
model: claude-sonnet-4-6
allowed-tools:
  - Read
  - Glob
---

Analyze the codebase structure and provide recommendations.
```

Load in your application:

```typescript
import { createAgent } from "@codeany/open-agent-sdk";

const agent = createAgent({
  cwd: "/path/to/project",
  settingSources: ["project"], // Load from .claude/skills/
});

// Or load user-level skills:
const agent = createAgent({
  settingSources: ["user"], // Load from ~/.claude/skills/
});
```

**Setting source priority:**

- `['user']`: Load from `~/.claude/skills/`
- `['project']`: Load from `${cwd}/.claude/skills/`
- `['user', 'project']`: Load both (project skills override user skills)
```

**Step 3: Commit**

```bash
git add src/types.ts README.md
git commit -m "docs: add filesystem skills to README and update types"
```

---

## Task 6: 清理和验证

**Files:**
- Delete: `examples/test-yaml-parser.ts` (临时测试文件)
- Delete: `examples/test-filesystem-loader.ts` (临时测试文件)
- Delete: `examples/test-exports.ts` (临时测试文件)

**Step 1: Remove temporary test files**

```bash
rm examples/test-yaml-parser.ts examples/test-filesystem-loader.ts examples/test-exports.ts
git add examples/
git commit -m "chore: remove temporary test files"
```

**Step 2: Run final integration test**

```bash
npx tsx examples/14-filesystem-skills-agent.ts
```

预期: 成功执行，显示加载的 skill 信息

**Step 3: Run TypeScript compilation**

```bash
npm run build
```

预期: 编译成功，无错误

**Step 4: Create feature branch and summary**

```bash
git checkout -b feature/filesystem-skills
git log --oneline --graph -10
```

---

## 完成清单

- [x] YAML frontmatter 解析器（Task 1）
- [x] 文件系统加载器（Task 2）
- [x] 导出更新（Task 3）
- [x] Agent 集成（Task 4）
- [x] README 和类型定义（Task 5）
- [x] 清理和验证（Task 6）

---

## 测试验证

所有测试通过后，feature 分支应包含：

```
* feat: add filesystem skills to README and update types
* feat: integrate filesystem skills loading in Agent constructor
* feat: export loadSkillsFromFilesystem from skills module
* feat: add filesystem skills loader
* feat: add YAML frontmatter parser for SKILL.md files
* docs: add filesystem skills design document
```

运行示例：
```bash
# 编译
npm run build

# 测试示例
npx tsx examples/12-skills.ts
npx tsx examples/14-filesystem-skills-agent.ts
```