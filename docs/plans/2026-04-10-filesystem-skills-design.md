# 文件系统 Skills 加载设计

**日期**: 2026-04-10  
**状态**: 已批准  
**目标**: 对齐官方 Agent SDK 的 Skills 方案，支持从文件系统加载 SKILL.md

## 背景

当前 Open Agent SDK 只支持程序化注册 skills (`registerSkill()`)，不支持官方 Agent SDK 的文件系统 Skills 方案（`.claude/skills/*/SKILL.md` + `settingSources`）。

`src/skills/references/` 目录包含官方参考实现，但依赖 30+ 个缺失的基础设施模块（analytics、gitignore、managed paths 等）。

## 目标

实现核心功能：
- ✅ 从 `.claude/skills/*/SKILL.md` 加载
- ✅ 解析 YAML frontmatter
- ✅ 通过 `settingSources` 控制加载源
- ✅ 调用 `registerSkill()` 注册

**不实现**（高级功能）：
- ❌ Managed paths
- ❌ Gitignore 检查
- ❌ Conditional skills（路径过滤）
- ❌ Hooks 系统
- ❌ Shell 执行
- ❌ Analytics

## 架构

```
createAgent({ settingSources: ['user', 'project'] })
     ↓
loadSkillsFromFilesystem(cwd, settingSources)
     ↓
扫描 .claude/skills/ 目录
     ↓
解析 SKILL.md (YAML frontmatter + Markdown)
     ↓
registerSkill(skillDefinition)
```

## 文件结构

### 新增文件

```
src/skills/filesystem.ts          ← 核心加载逻辑
src/skills/yaml.ts                ← YAML frontmatter 解析（轻量实现）
```

### 修改文件

```
src/types.ts                      ← 添加 settingSources 默认值
src/agent.ts                      ← 初始化时调用加载函数
src/skills/index.ts               ← 导出新函数
```

## API 设计

### `loadSkillsFromFilesystem()`

```typescript
// src/skills/filesystem.ts
export async function loadSkillsFromFilesystem(
  cwd: string,
  settingSources?: SettingSource[]
): Promise<{ loaded: number; errors: Error[] }>
```

**参数**：
- `cwd`: 项目根目录，用于定位 `./.claude/skills/`
- `settingSources`: 加载源配置
  - `['user']` → 从 `~/.claude/skills/` 加载
  - `['project']` → 从 `${cwd}/.claude/skills/` 加载
  - `['user', 'project']` → 两者都加载（项目 skills 优先）
  - `undefined` → 不加载

**返回**：
- `loaded`: 成功加载的 skills 数量
- `errors`: 加载过程中的错误列表

### `AgentOptions.settingSources`

```typescript
// src/types.ts
export interface AgentOptions {
  // ... 现有选项
  settingSources?: SettingSource[]  // 默认: undefined（不加载）
}
```

默认值：`undefined`（与官方 SDK 一致，必须显式指定才加载）

## SKILL.md 格式

### 目录结构

```
.claude/skills/
├── my-skill/
│   └── SKILL.md
└── another-skill/
    └── SKILL.md

~/.claude/skills/
├── global-skill/
│   └── SKILL.md
```

### 支持的 Frontmatter

```yaml
---
name: my-skill                    # 可选，默认使用目录名
description: 描述技能的内容         # 必需
model: claude-sonnet-4-6          # 可选
allowed-tools:                     # 可选
  - Read
  - Bash
user-invocable: true               # 可选，默认 true
---

Skill content in Markdown...

${CLAUDE_SKILL_DIR} 会被替换为技能目录路径
```

### 不支持的 Frontmatter

以下 frontmatter 字段将被**忽略**（不影响功能）：

```yaml
when_to_use: ...        # 条件激活
paths: [...]            # 路径过滤
hooks: ...              # 生命周期钩子
shell: ...              # Shell 执行
effort: ...             # 推理强度
agent: ...              # 子代理
```

## 实现细节

### 1. YAML Frontmatter 解析

**文件**: `src/skills/yaml.ts`

```typescript
export interface Frontmatter {
  name?: string
  description: string
  model?: string
  allowedTools?: string[]
  userInvocable?: boolean
}

export function parseSkillMarkdown(content: string): {
  frontmatter: Frontmatter
  body: string
}
```

**实现**：
- 提取 `---` 之间的 YAML
- 使用轻量 YAML 解析（不引入 `yaml` 依赖）
- 基本类型解析：string, boolean, array

### 2. 文件系统加载

**文件**: `src/skills/filesystem.ts`

```typescript
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { parseSkillMarkdown } from './yaml.js'
import { registerSkill } from './registry.js'
import type { SkillDefinition, SkillContentBlock } from './types.js'

export async function loadSkillsFromFilesystem(
  cwd: string,
  settingSources?: SettingSource[]
): Promise<{ loaded: number; errors: Error[] }> {
  const errors: Error[] = []
  let loaded = 0

  if (!settingSources || settingSources.length === 0) {
    return { loaded: 0, errors: [] }
  }

  // 用户级 skills（~/.claude/skills/）
  if (settingSources.includes('user')) {
    const userSkillsDir = join(homedir(), '.claude', 'skills')
    const result = await loadSkillsFromDir(userSkillsDir)
    loaded += result.loaded
    errors.push(...result.errors)
  }

  // 项目级 skills（./.claude/skills/）
  if (settingSources.includes('project')) {
    const projectSkillsDir = join(cwd, '.claude', 'skills')
    const result = await loadSkillsFromDir(projectSkillsDir)
    loaded += result.loaded
    errors.push(...result.errors)
  }

  return { loaded, errors }
}

async function loadSkillsFromDir(dir: string): Promise<{
  loaded: number
  errors: Error[]
}> {
  const errors: Error[] = []
  let loaded = 0

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const skillDirs = entries.filter(e => e.isDirectory())

    for (const skillDir of skillDirs) {
      const skillPath = join(dir, skillDir.name, 'SKILL.md')
      try {
        const content = await readFile(skillPath, 'utf-8')
        const { frontmatter, body } = parseSkillMarkdown(content)
        
        const definition: SkillDefinition = {
          name: frontmatter.name || skillDir.name,
          description: frontmatter.description,
          model: frontmatter.model,
          allowedTools: frontmatter.allowedTools,
          userInvocable: frontmatter.userInvocable ?? true,
          async getPrompt(args: string): Promise<SkillContentBlock[]> {
            const text = body.replace(/\${CLAUDE_SKILL_DIR}/g, join(dir, skillDir.name))
            return [{ type: 'text', text }]
          },
        }
        
        registerSkill(definition)
        loaded++
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
  } catch (error) {
    // 目录不存在或无权限，静默跳过
    if ((error as any).code !== 'ENOENT') {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return { loaded, errors }
}
```

### 3. Agent 初始化集成

**文件**: `src/agent.ts`

```typescript
import { loadSkillsFromFilesystem } from './skills/filesystem.js'

export class Agent {
  constructor(options: AgentOptions = {}) {
    // ... 现有代码

    // 加载文件系统 skills
    if (options.settingSources && options.settingSources.length > 0) {
      this.setupDone = this.setupDone.then(async () => {
        try {
          const cwd = options.cwd ?? process.cwd()
          const result = await loadSkillsFromFilesystem(cwd, options.settingSources)
          // 可选：记录加载结果（debug 日志）
        } catch (error) {
          // 不阻止 agent 启动
        }
      })
    }
  }
}
```

### 4. 导出更新

**文件**: `src/skills/index.ts`

```typescript
// 现有导出
export { initBundledSkills } from './bundled/index.js'
export { registerSkill, getSkill, getAllSkills, ... } from './registry.js'

// 新增导出
export { loadSkillsFromFilesystem } from './filesystem.js'
```

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| 目录不存在 | 静默跳过（记录 debug 日志） |
| 目录无权限 | 记录错误到 `errors` 数组，继续加载其他源 |
| SKILL.md 不存在 | 跳过该目录 |
| YAML 语法错误 | 跳过该文件，记录到 `errors` 数组 |
| 重复 skill 名称 | 后加载的覆盖先加载的（项目覆盖用户） |

## 测试计划

### 单元测试

1. YAML frontmatter 解析
2. 目录扫描逻辑
3. 错误处理

### 集成测试

1. 创建临时 `.claude/skills/` 目录
2. 创建有效的 SKILL.md 文件
3. 验证 `createAgent({ settingSources: ['project'] })` 加载 skills
4. 验证 `getSkill()` 返回正确结果

### 测试用例

```typescript
// test-filesystem-skills.ts
import { createAgent, getSkill } from '../src/index.js'

// 准备测试 skill
await fs.mkdir('.claude/skills/test-skill', { recursive: true })
await fs.writeFile('.claude/skills/test-skill/SKILL.md', `
---
description: A test skill
model: claude-sonnet-4-6
---

This is a test skill.
`)

// 测试加载
const agent = createAgent({
  cwd: process.cwd(),
  settingSources: ['project']
})

await agent.setupDone // 等待加载完成

const skill = getSkill('test-skill')
assert(skill)
assert(skill.description === 'A test skill')
```

## 文档更新

- [x] README.md: 添加文件系统 Skills 示例
- [x] API 文档: `loadSkillsFromFilesystem()`
- [x] AgentOptions: `settingSources` 参数说明

## 待办事项

### 必需实现

- [ ] 创建 `src/skills/yaml.ts`（YAML 解析）
- [ ] 创建 `src/skills/filesystem.ts`（文件加载）
- [ ] 修改 `src/agent.ts`（初始化集成）
- [ ] 修改 `src/skills/index.ts`（导出）
- [ ] 创建示例：`examples/13-filesystem-skills.ts`

### 可选优化

- [ ] 添加 debug 日志
- [ ] 支持 `${CLAUDE_SKILL_DIR}` 变量替换
- [ ] 缓存已加载的 skills（避免重复扫描）

## 参考资料

- 官方 SDK 文档: https://code.claude.com/docs/en/agent-sdk/skills
- 参考实现: `src/skills/references/loadSkillsDir.ts`
- bundledSkills: `src/skills/references/bundledSkills.ts`