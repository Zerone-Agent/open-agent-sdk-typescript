# Open Agent SDK — Tools 设计调研报告

> 调研时间：2026-04-22  
> 调研范围：`src/tools/` 全部工具模块、`src/engine.ts`、`src/agent.ts`、`src/types.ts`、`src/mcp/`、`src/cron/`

---

## 一、架构总览

### 1.1 核心类型

```
ToolDefinition（src/types.ts:186-195）
├── name: string                          // 工具唯一标识
├── description: string                   // LLM 看到的工具描述
├── inputSchema: ToolInputSchema          // JSON Schema 参数定义
├── call(input, context) → ToolResult     // 执行逻辑
├── isReadOnly?() → boolean               // 是否只读（影响并发策略）
├── isConcurrencySafe?() → boolean        // 是否并发安全
├── isEnabled?() → boolean                // 运行时启用/禁用
└── prompt?(context) → string             // 动态生成 prompt 描述
```

### 1.2 工具生命周期

```
注册阶段                  过滤阶段                   执行阶段
─────────────────    ─────────────────────    ──────────────────────
ALL_TOOLS (34个)  →  buildToolPool()        →  executeTools()
   │                  ├── tools 参数过滤         ├── isEnabled() 检查
   │                  ├── allowedTools 白名单    ├── canUseTool() 权限
   │                  └── disallowedTools 黑名单 ├── PreToolUse Hook
   │                                            └── call() 执行
   └── MCP tools → assembleToolPool() 去重合并
```

### 1.3 工具完整清单（34 个）

| 分类 | 工具名 | 只读 | 并发安全 | 文件 |
|------|--------|------|----------|------|
| **文件 I/O** | Bash | ✗ | ✗ | `bash.ts` |
| | Read | ✓ | ✓ | `read.ts` |
| | Write | ✗ | ✗ | `write.ts` |
| | Edit | ✗ | ✗ | `edit.ts` |
| | Glob | ✓ | ✓ | `glob.ts` |
| | Grep | ✓ | ✓ | `grep.ts` |
| | NotebookEdit | ✗ | ✗ | `notebook-edit.ts` |
| **Web** | WebFetch | ✓ | ✓ | `web-fetch.ts` |
| | WebSearch | ✗ | ✓ | `web-search.ts` |
| **多 Agent** | Agent | ✗ | ✗ | `agent-tool.ts` |
| | SendMessage | ✗ | ✓ | `send-message.ts` |
| | TeamCreate | ✗ | ✗ | `team-tools.ts` |
| | TeamDelete | ✗ | ✗ | `team-tools.ts` |
| **任务** | TaskCreate | ✗ | ✓ | `task-tools.ts` |
| | TaskList | ✓ | ✓ | `task-tools.ts` |
| | TaskUpdate | ✗ | ✓ | `task-tools.ts` |
| | TaskGet | ✓ | ✓ | `task-tools.ts` |
| | TaskStop | ✗ | ✓ | `task-tools.ts` |
| | TaskOutput | ✓ | ✓ | `task-tools.ts` |
| **Worktree** | EnterWorktree | ✗ | ✗ | `worktree-tools.ts` |
| | ExitWorktree | ✗ | ✗ | `worktree-tools.ts` |
| **规划** | EnterPlanMode | ✗ | ✗ | `plan-tools.ts` |
| | ExitPlanMode | ✗ | ✗ | `plan-tools.ts` |
| **用户交互** | AskUserQuestion | ✓ | ✗ | `ask-user.ts` |
| **发现** | ToolSearch | ✓ | ✓ | `tool-search.ts` |
| **MCP 资源** | ListMcpResources | ✓ | ✓ | `mcp-resource-tools.ts` |
| | ReadMcpResource | ✓ | ✓ | `mcp-resource-tools.ts` |
| **调度** | CronCreate | ✗ | ✓ | `cron-tools.ts` |
| | CronDelete | ✗ | ✓ | `cron-tools.ts` |
| | CronList | ✓ | ✓ | `cron-tools.ts` |
| | RemoteTrigger | ✗ | ✓ | `cron-tools.ts` |
| **LSP** | LSP | ✓ | ✓ | `lsp-tool.ts` |
| **配置** | Config | ✗ | ✓ | `config-tool.ts` |
| **待办** | TodoWrite | ✗ | ✓ | `todo-tool.ts` |
| **技能** | Skill | ✓ | ✓ | `skill-tool.ts` |

---

## 二、工具可见性设计

### 2.1 多层过滤机制

工具对 LLM 的可见性由以下层级控制，按执行顺序排列：

#### 层级 1：工具池构建（`src/agent.ts:172-186`）

```typescript
private buildToolPool(): ToolDefinition[] {
    const raw = this.cfg.tools
    
    if (!raw || isPresetObject(raw)) {
      pool = getAllBaseTools()                          // 默认：全部 34 个
    } else if (isStringArray(raw)) {
      pool = filterTools(getAllBaseTools(), raw)        // tools=["Bash","Read"] → 白名单
    } else {
      pool = raw as ToolDefinition[]                    // 自定义 ToolDefinition[]
    }
    
    return filterTools(pool, this.cfg.allowedTools, this.cfg.disallowedTools)
}
```

| 参数 | 类型 | 作用 |
|------|------|------|
| `tools` | `string[]` | 按名称白名单过滤基础工具 |
| `tools` | `ToolDefinition[]` | 完全替换工具集 |
| `tools` | `{ type: 'preset'; preset: 'default' }` | 使用全部基础工具 |
| `allowedTools` | `string[]` | 二次白名单过滤（交集） |
| `disallowedTools` | `string[]` | 黑名单排除 |

#### 层级 2：MCP 工具合并（`src/tools/index.ts:169-185`）

```typescript
assembleToolPool(baseTools, mcpTools, allowedTools, disallowedTools)
```

- 基础工具 + MCP 工具合并，按 name 去重（后定义覆盖先定义）
- 再应用 allowedTools / disallowedTools 过滤

#### 层级 3：Query 级覆盖（`src/agent.ts:291-302`）

单次 `query()` 调用可通过 overrides 动态调整：

```typescript
agent.query(prompt, {
  allowedTools: ['Bash', 'Read'],          // 单次查询限定工具
  disallowedTools: ['Write'],              // 单次查询排除工具
  tools: ['Bash', 'Glob', 'Grep'],         // 单次查询替换工具集
})
```

#### 层级 4：工具自身状态（`src/engine.ts:702-709`）

```typescript
if (tool.isEnabled && !tool.isEnabled()) {
    return { content: `Error: Tool "${block.name}" is not enabled`, is_error: true }
}
```

工具可通过 `isEnabled()` 在运行时动态决定是否可用。

#### 层级 5：Hook 拦截（`src/engine.ts:740-755`）

```typescript
const preHookResults = await this.executeHooks('PreToolUse', { toolName, toolInput })
if (preHookResults.some(r => r.block)) {
    return { content: 'Blocked by PreToolUse hook', is_error: true }
}
```

### 2.2 `allowedTools` 语义问题

**文档注释**（`src/types.ts:412`）：

```typescript
/** Tool names to pre-approve without prompting */
allowedTools?: string[]
```

**实际实现**：在 `buildToolPool()` 中作为硬过滤条件，不在列表中的工具直接从工具池移除，LLM 完全不可见。

| | 注释含义 | 实际行为 |
|---|---------|---------|
| `allowedTools` | 免确认的工具列表 | **工具白名单，决定哪些工具注册给 LLM** |

**影响**：使用侧若期望"所有工具可见，部分免确认"的语义，需要把 `allowedTools` 的过滤逻辑从工具池构建阶段移到 `executeSingleTool` 的权限判断中。

### 2.3 子 Agent 工具隔离（`src/tools/agent-tool.ts:91-96`）

```typescript
let tools = getAllBaseTools()                    // 继承全部基础工具
if (agentDef?.tools) {
  tools = filterTools(tools, agentDef.tools)    // 按 AgentDefinition.tools 白名单过滤
}
tools = tools.filter(t => t.name !== 'Agent')   // 防止无限递归嵌套
```

子 agent 不继承父 agent 的 MCP 工具，仅能访问基础工具集。

---

## 三、工具可用性设计

### 3.1 并发执行策略（`src/engine.ts:622-681`）

引擎将工具调用分为两类执行：

```
toolUseBlocks
    ├── isReadOnly() === true  → readOnly[]   → Promise.all 批量并发（上限 10）
    └── isReadOnly() === false → mutations[]  → for...of 严格串行
```

- **只读工具**（Glob、Grep、Read、WebFetch 等）：最多 10 个并发执行
- **写操作工具**（Write、Edit、Bash、Agent 等）：严格串行执行，避免竞态
- 并发上限通过 `AGENT_SDK_MAX_TOOL_CONCURRENCY` 环境变量可调

### 3.2 权限控制（`src/engine.ts:713-737`）

```typescript
const permission = await this.config.canUseTool(tool, block.input)
if (permission.behavior === 'deny') {
    return { content: permission.message, is_error: true }
}
if (permission.updatedInput !== undefined) {
    block = { ...block, input: permission.updatedInput }   // 支持修改输入参数
}
```

支持三种结果：
- `allow`：正常执行
- `deny`：拒绝执行，返回错误
- `allow + updatedInput`：允许执行但修改输入参数

### 3.3 Hook 生命周期

```
SessionStart → UserPromptSubmit → [Agentic Loop] → Stop → SessionEnd
                                    │
                                    ├── PreToolUse → call() → PostToolUse
                                    │                        → PostToolUseFailure
                                    └── PreCompact → compact → PostCompact
```

每个 Hook 点可：
- 阻断操作（`block: true`）
- 附加消息（`message`）

### 3.4 子 Agent 事件传播

AgentTool 创建子 agent 时，通过 `context.emitEvent` 回调将子 agent 的事件包装为 `SDKSubagentMessage` 传播给父 agent 的流式输出：

```typescript
// engine.ts 中的异步队列机制
pendingSubagentEvents → yield → 父 agent 的 query() generator
```

---

## 四、各工具详细分析

### 4.1 文件 I/O 工具组

**Bash**：执行 shell 命令，支持 workdir 参数。写操作、非并发安全。

**Read**：读取文件或目录。支持 offset/limit 分页读取、图片和 PDF 文件。只读。

**Write**：写入文件（覆盖）。非并发安全。

**Edit**：精确字符串替换。支持单次替换和 `replaceAll` 批量替换。非并发安全。

**Glob**：文件模式匹配搜索。使用 Node.js 22+ 内置 glob。只读。

**Grep**：文件内容正则搜索。优先使用 ripgrep，回退 grep。只读。

**NotebookEdit**：Jupyter Notebook 单元格编辑。写操作。

### 4.2 Web 工具组

**WebFetch**：抓取 URL 内容，支持 markdown/text/html 输出格式。只读。

**WebSearch**：Web 搜索工具。写操作（但标记为并发安全，因为不修改本地状态）。

### 4.3 多 Agent 工具组

#### Agent（`agent-tool.ts`）

启动子 agent 执行复杂任务。关键设计：

| 特性 | 实现 |
|------|------|
| 内置 agent 类型 | `Explore`（代码探索）、`Plan`（架构设计） |
| 自定义 agent | 通过 `AgentOptions.agents` 注册，`registerAgents()` 注入 |
| 工具继承 | 继承 `getAllBaseTools()`，按 `AgentDefinition.tools` 白名单过滤 |
| 递归防护 | 子 agent 过滤掉 `Agent` 工具（`tools.filter(t => t.name !== 'Agent')`） |
| Provider 继承 | 复用父 agent 的 provider 和 model |
| 事件传播 | 子 agent 事件通过 `context.emitEvent` → `SDKSubagentMessage` 传播 |

#### SendMessage（`send-message.ts`）

Agent 间消息传递，基于内存邮箱模型：

```
mailboxes: Map<agentName, AgentMessage[]>
├── readMailbox(name)    → 读取并清空
├── writeToMailbox(name) → 追加消息
└── 支持 to="*" 广播
```

消息类型：`text`、`shutdown_request`、`shutdown_response`、`plan_approval_response`

#### TeamCreate / TeamDelete（`team-tools.ts`）

多 agent 团队管理，数据模型：

```typescript
interface Team {
  id: string
  name: string
  members: string[]
  leaderId: string
  taskListId?: string
  status: 'active' | 'disbanded'
}
```

进程内 `Map` 存储，无持久化。

### 4.4 任务工具组（`task-tools.ts`）

结构化任务管理系统，6 个独立工具：

```
TaskCreate → 创建任务
TaskList   → 列出/过滤任务（按 status、owner）
TaskUpdate → 更新任务状态/描述/负责人/输出
TaskGet    → 获取任务详情
TaskStop   → 取消任务
TaskOutput → 获取任务输出结果
```

数据模型：

```typescript
interface Task {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  owner?: string
  output?: string
  blockedBy?: string[]     // 预留：依赖关系
  blocks?: string[]        // 预留：阻塞关系
  metadata?: Record<string, unknown>
}
```

**状态机**：`pending → in_progress → completed / failed / cancelled`

**注意**：`blockedBy` / `blocks` 字段已定义但无检查逻辑，为预留设计。

### 4.5 TodoWrite vs Task 对比

| 维度 | TodoWrite | Task 工具组 |
|------|-----------|------------|
| 定位 | 轻量 checklist | 结构化项目管理系统 |
| 数据 | `id + text + done + priority` | `id + subject + status + owner + output + dependencies + metadata` |
| 状态 | `done / !done` | 5 种状态的状态机 |
| 工具数 | 1 个（5 个 action） | 6 个独立工具 |
| 过滤 | 无 | 按 status、owner |
| 依赖关系 | 无 | blockedBy / blocks（预留） |
| 用途 | LLM 自用备忘录 | 多 agent 协作任务追踪 |

### 4.6 Worktree 工具组（`worktree-tools.ts`）

Git worktree 隔离环境管理：

- **EnterWorktree**：创建隔离的 git worktree + branch，用于并行开发
- **ExitWorktree**：退出 worktree，可选 keep 或 remove

进程内 `activeWorktrees: Map` 跟踪活跃 worktree。

### 4.7 Plan Mode 工具组（`plan-tools.ts`）

结构化规划模式：

- **EnterPlanMode**：进入规划模式，agent 专注设计而非执行
- **ExitPlanMode**：提交计划并退出，记录 `currentPlan`

进程级单例状态（`planModeActive` + `currentPlan`），同一进程同时只有一个 plan。

### 4.8 用户交互工具（`ask-user.ts`）

AskUserQuestion：向用户提问并等待回复。

- SDK 模式：通过 `setQuestionHandler()` 注入回调
- 非交互模式：返回默认消息，使用 best judgment 继续

### 4.9 LSP 工具（`lsp-tool.ts`）

代码智能工具，支持 9 种操作。**当前为降级实现**——无真正 LSP Server 连接，回退到 grep/ripgrep：

| 操作 | 实现方式 |
|------|---------|
| goToDefinition / goToImplementation | grep 搜索 `(function\|class\|...) symbol` |
| findReferences | grep 搜索符号名 |
| hover | 直接提示"需要 LSP Server" |
| documentSymbol | grep 搜索文件顶层声明 |
| workspaceSymbol | grep 搜索全局符号 |
| prepareCallHierarchy / incomingCalls / outgoingCalls | 未实现，提示"需要 LSP Server" |

### 4.10 Config 工具（`config-tool.ts`）

进程内 KV 存储，`Map<string, unknown>`：

- `get` / `set` / `list` 三个操作
- 进程级共享，所有 Agent 实例共享同一个 store
- 纯内存，不持久化
- 导出 `getConfig()` / `setConfig()` 供使用侧代码读写

### 4.11 Skill 工具（`skill-tool.ts`）

技能加载工具，从技能注册表加载特定技能的完整指令到对话上下文。

---

## 五、空壳工具分析

以下工具存在完整接口定义，但**核心逻辑未接入**：

### 5.1 ToolSearch（`tool-search.ts`）

**设计目标**：延迟加载工具发现机制，让 LLM 按需搜索未加载的工具。

**当前状态**：
- `setDeferredTools()` 已导出，但**整个代码库无任何调用方**
- `deferredTools` 永远为空数组
- 所有查询返回 `"No deferred tools available."`

**设计价值**：当 MCP 工具数量巨大时，不需要把所有工具描述塞入 LLM 上下文，而是按需发现。

**激活条件**：需要在 Agent 初始化时将部分工具设为 deferred。

### 5.2 MCP Resource 工具（`mcp-resource-tools.ts`）

**设计目标**：让 LLM 访问 MCP Server 暴露的 Resources（区别于 Tools）。

**当前状态**：
- `setMcpConnections()` 已导出，但 **Agent 中从未调用**
- `mcpConnections` 永远为空数组
- ListMcpResources 返回 `"No MCP servers connected."`
- 实现依赖 `(conn as any)._client?.listResources?.()` 访问内部属性

### 5.3 Cron 工具链

**设计目标**：本地定时任务调度。

**当前状态**：
- `CronStorage` 接口已定义（`load/save/add/remove/markFired`）
- `AgentOptions.cronStorage` 已暴露
- `initCronTools()` 已导出
- **但 Agent 构造函数中从未调用 `initCronTools()` 注入 storage**
- 所有 Cron 工具（Create/Delete/List）返回 `"Cron storage is not initialized."`

**缺失环节**：
1. 无本地 `CronStorage` 实现（需使用侧自行实现）
2. 无调度器（Scheduler）轮询 storage 并触发 Agent 执行
3. `AgentOptions.cronStorage` 未被消费

### 5.4 RemoteTrigger（`cron-tools.ts`）

**设计目标**：远程定时 Agent 触发，面向云端托管场景。

**当前状态**：纯 stub，所有 action 返回固定文案。

### 5.5 空壳工具汇总

| 工具 | 缺失环节 | 激活方式 |
|------|---------|---------|
| ToolSearch | 无调用方为 deferredTools 喂数据 | 在 Agent.setup() 中调用 `setDeferredTools()` |
| ListMcpResources | 无调用方注入 MCP connections | 在 Agent.setup() 中调用 `setMcpConnections()` |
| ReadMcpResource | 同上 | 同上 |
| CronCreate/Delete/List | Agent 未调用 `initCronTools()` 注入 storage | 在 Agent 构造函数中消费 `cronStorage` 选项 |
| RemoteTrigger | 无远程后端实现 | 需要接入远程 API |

---

## 六、MCP 体系设计

### 6.1 三层架构

```
┌─────────────────────────────────────────────────────┐
│                   Agent (toolPool)                   │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  外部 MCP     │  │  进程内 MCP   │  │ MCP 资源   │  │
│  │  (stdio/sse/ │  │  (type:sdk)  │  │ (空壳)     │  │
│  │   http)      │  │              │  │            │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┘ │
│         │                  │                         │
│    client.callTool()   直接本地调用                   │
│    (网络转发)          (零开销)                       │
└─────────┴──────────────────┴─────────────────────────┘
```

### 6.2 外部 MCP Server（`src/mcp/client.ts`）

支持三种传输协议：

| 类型 | 类 | 场景 |
|------|-----|------|
| `stdio` | `StdioClientTransport` | 本地子进程 |
| `sse` | `SSEClientTransport` | 远程 SSE 端点 |
| `http` | `StreamableHTTPClientTransport` | 远程 HTTP 端点 |

连接流程：
1. 根据 config 创建 transport
2. `client.connect(transport)` 建立连接
3. `client.listTools()` 获取工具列表
4. 每个工具包装为 `ToolDefinition`，命名 `mcp__{serverName}__{toolName}`
5. 调用时通过 `client.callTool()` 转发远端执行

### 6.3 进程内 MCP Server（`src/sdk-mcp-server.ts`）

同一进程内注册工具，无网络开销：

```typescript
const server = createSdkMcpServer({ name: 'weather', tools: [weatherTool] })
const agent = createAgent({ mcpServers: { weather: server } })
```

识别 `type === 'sdk'` 后直接将 `config.tools` 合并到 toolPool。

---

## 七、Cron 调度体系

### 7.1 数据模型

```typescript
interface CronTask {
  id: string
  cron: string              // cron 表达式
  prompt: string            // 触发时执行的 Agent prompt
  createdAt: number
  lastFiredAt?: number
  recurring: boolean        // 是否重复执行
  permanent?: boolean       // 是否持久（不被过期清理）
}
```

### 7.2 存储接口

```typescript
interface CronStorage {
  load(): Promise<CronTask[]>
  save(tasks: CronTask[]): Promise<void>
  add(task: Omit<CronTask, 'id' | 'createdAt'>): Promise<string>
  remove(ids: string[]): Promise<void>
  markFired(ids: string[], firedAt: number): Promise<void>
}
```

纯接口设计，SDK 不提供实现。使用侧可根据环境选择：文件系统（JSON）、内存、Redis、SQLite 等。

### 7.3 缺失的调度器

当前只有"数据模型 + CRUD 工具 + 存储接口"，缺少调度器：

```
预期流程：
  Scheduler (轮询) → storage.load() → 比对时间 → 到期?
    → agent.query(task.prompt)   执行
    → storage.markFired()        标记
    → 非重复则 remove()
```

---

## 八、设计问题与改进建议

### 8.1 `allowedTools` 语义混淆

**问题**：注释说"pre-approve without prompting"，但实现是硬过滤。

**建议**：拆分为两个概念：
- `tools` / `allowedTools` → 控制工具池（已实现）
- 新增 `autoApprovedTools` 或在 `canUseTool` 中判断 → 控制免确认（需实现）

### 8.2 空壳工具未标记

**问题**：ToolSearch、MCP Resources、Cron、RemoteTrigger 都是空壳，但对 LLM 不可见——LLM 会尝试调用并得到无意义的结果。

**建议**：
- 在 `isEnabled()` 中检查前置条件，未满足时返回 false
- 或在 description 中注明"需要配置才能使用"

### 8.3 进程级单例状态

**问题**：Config、Todo、Task、Team、Mailboxes、PlanMode、CronStorage、DeferredTools、McpConnections 全部使用模块级变量（`let` / `const` Map/Array），同一进程多个 Agent 实例共享状态。

**影响**：
- 多 Agent 实例之间的任务、配置会互相干扰
- 测试隔离困难

**建议**：改为 Agent 实例级作用域，通过 ToolContext 传递。

### 8.4 MCP 工具不继承到子 Agent

**问题**：`AgentTool` 中子 agent 只继承 `getAllBaseTools()`，不继承父 agent 的 MCP 工具。

**建议**：将父 agent 的完整 toolPool 传递给子 agent，或至少传递 MCP 工具。

### 8.5 LSP 降级实现未告知 LLM

**问题**：LSP 工具回退到 grep 实现，但 description 没有说明这一点，LLM 可能对结果有错误预期。

**建议**：在 description 或 prompt 中注明当前为 grep-based 降级实现。

### 8.6 Task 依赖关系未实现

**问题**：`blockedBy` / `blocks` 字段已定义但无逻辑。

**建议**：在 TaskUpdate 中检查依赖状态，阻止执行被阻塞的任务。

---

## 九、结论

Open Agent SDK 的 Tools 体系设计层次清晰：

1. **核心工具**（文件 I/O、Web、搜索）——功能完整，可直接使用
2. **多 Agent 协作**（Agent、SendMessage、Team、Task）——框架完整，适合基础协作场景
3. **扩展工具**（Cron、MCP Resources、ToolSearch、LSP、RemoteTrigger）——接口设计合理，但**核心逻辑未接入**，均为架构占位

主要技术债务集中在：进程级单例状态、空壳工具未标记、`allowedTools` 语义与实现不一致。建议优先解决语义混淆和空壳标记问题，再逐步接入调度器和 MCP Resource 的实际逻辑。
