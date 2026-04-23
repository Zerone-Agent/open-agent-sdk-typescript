/**
 * Cron/Scheduling Tools
 *
 * CronCreate, CronDelete, CronList - Schedule recurring tasks.
 * RemoteTrigger - Manage remote scheduled agent triggers.
 */

import type { ToolDefinition, ToolResult } from '../types.js'
import type { CronTask } from '../cron/types.js'
import type { CronStorage } from '../cron/storage.js'
import {
  parseCronExpression,
  computeNextCronRun,
  cronToHuman,
} from '../cron/cron.js'

let storage: CronStorage | null = null

export type CronJob = CronTask

export function initCronTools(storageImpl: CronStorage): void {
  storage = storageImpl
}

function notInitializedResult(): ToolResult {
  return {
    type: 'tool_result',
    tool_use_id: '',
    content: 'Cron storage is not initialized.',
    is_error: true,
  }
}

function formatPrompt(prompt: string): string {
  return prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt
}

/**
 * Get all cron jobs.
 */
export async function getAllCronJobs(): Promise<CronTask[]> {
  if (!storage) return []
  return storage.load()
}

/**
 * Clear all cron jobs.
 */
export async function clearCronJobs(): Promise<void> {
  if (!storage) return
  await storage.save([])
}

export const CronCreateTool: ToolDefinition = {
  name: 'CronCreate',
  description:
    'Create a scheduled task. Supports TWO modes:\n' +
    '- Recurring tasks: set recurring=true, provide a 5-field cron expression (e.g. "*/5 * * * *").\n' +
    '- One-shot tasks: set recurring=false and delay_seconds to the number of seconds from now. ' +
    'No need to calculate absolute times — just pass the relative delay (e.g. 300 = 5 minutes, 3600 = 1 hour). ' +
    'The tool converts it to an absolute schedule automatically.\n' +
    'Always prefer this tool over system schedulers like `at`, `crontab`, or `sleep`.\n\n' +
    '**IMPORTANT: Agent selection rule** — When the user mentions a specific role (e.g. 政策助手, 法务助手, 财务军师) or the task clearly belongs to a domain (招投标→bid, 法律→legal, 政策→policy, 人力资源→hr, 财务→finance, 商业调研→business), you MUST set the `agent` field to the corresponding agent ID. Do NOT embed agent role instructions in the prompt — the selected agent will automatically apply its own system prompt and tools.',
  inputSchema: {
    type: 'object',
    properties: {
      cron: {
        type: 'string',
        description:
          '5-field cron expression for recurring tasks (e.g. "*/5 * * * *"). Ignored for one-shot tasks when delay_seconds is set.',
      },
      prompt: { type: 'string', description: 'Prompt to execute when the task fires. Write only the task itself — do NOT include agent role instructions (the `agent` field handles that).' },
      recurring: {
        type: 'boolean',
        description: 'true = repeats on schedule; false = fires once then auto-removed',
      },
      delay_seconds: {
        type: 'number',
        description:
          'For one-shot tasks only: how many seconds from now to fire. Examples: 60=1min, 300=5min, 3600=1h, 86400=1day. ' +
          'The tool converts this to an absolute cron time internally. No need to compute absolute timestamps yourself.',
      },
      durable: { type: 'boolean', description: 'Whether the task should survive temporary cleanup' },
      agent: {
        type: 'string',
        description: [
          'Agent ID to execute this task. Analyze the task content and select the best-matching agent.',
          'Available agents:',
          '- "bid": 投标战略师 — 招投标全流程（标书编制、竞对分析、报价策略、中标概率评估）',
          '- "legal": 法务守门人 — 合同审查、法律文书、合规检查、风险识别',
          '- "policy": 政策雷达 — 政策解读、红利估算、申报路径、合规预警（可创建/管理定时任务）',
          '- "hr": 人才架构师 — 招聘、薪酬设计、劳动合同、考勤管理、人事制度',
          '- "finance": 财务军师 — 报表分析、预算编制、成本优化、现金流预测、ROI测算',
          '- "business": 商业侦探 — 市场调研、竞品分析、客户洞察、商业计划',
          'Omit or leave empty to use the default general agent.',
        ].join('\n'),
      },
    },
    required: ['cron', 'prompt', 'recurring'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Create a scheduled cron task.' },
  async call(input: any): Promise<ToolResult> {
    const cronStorage = storage
    if (!cronStorage) return notInitializedResult()

    if (typeof input?.cron !== 'string' || typeof input?.prompt !== 'string' || typeof input?.recurring !== 'boolean') {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'CronCreate requires cron, prompt, and recurring fields.',
        is_error: true,
      }
    }

    let cronExpr = input.cron
    if (!input.recurring && typeof input.delay_seconds === 'number' && input.delay_seconds > 0) {
      const runAt = new Date(Date.now() + input.delay_seconds * 1000)
      cronExpr = `${runAt.getMinutes()} ${runAt.getHours()} ${runAt.getDate()} ${runAt.getMonth() + 1} *`
    }

    const fields = parseCronExpression(cronExpr)
    if (!fields) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Invalid cron expression: "${cronExpr}". Must be a valid 5-field cron (e.g. "0 16 * * *").`,
        is_error: true,
      }
    }

    const nextRun = computeNextCronRun(fields, new Date())
    if (!nextRun) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Cron expression has no matching run time within 366 days: ${cronExpr}`,
        is_error: true,
      }
    }

    const tasks = await cronStorage.load()
    if (tasks.length >= 50) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Cron task limit reached: maximum 50 tasks.',
        is_error: true,
      }
    }

    const task: Omit<CronTask, 'id' | 'createdAt'> = {
      cron: cronExpr,
      prompt: input.prompt,
      recurring: input.recurring,
    }
    if (typeof input.durable === 'boolean') {
      task.permanent = input.durable
    }
    if (typeof input.agent === 'string') {
      task.agentId = input.agent
    }

    const id = await cronStorage.add(task)
    const description = cronToHuman(input.cron)
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localTimeStr = nextRun.toLocaleString('zh-CN', {timeZone, hour12: false}) 

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Cron task created: ${id} (${description}). Next run: ${localTimeStr} (${timeZone})`,
    }
  },
}

export const CronDeleteTool: ToolDefinition = {
  name: 'CronDelete',
  description: 'Delete a scheduled cron task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Cron task ID to delete' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Delete a cron task.' },
  async call(input: any): Promise<ToolResult> {
    const cronStorage = storage
    if (!cronStorage) return notInitializedResult()

    if (typeof input?.id !== 'string') {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'CronDelete requires an id field.',
        is_error: true,
      }
    }

    const tasks = await cronStorage.load()
    if (!tasks.some((task) => task.id === input.id)) {
      return { type: 'tool_result', tool_use_id: '', content: `Cron task not found: ${input.id}`, is_error: true }
    }

    await cronStorage.remove([input.id])
    return { type: 'tool_result', tool_use_id: '', content: `Cron task deleted: ${input.id}` }
  },
}

export const CronListTool: ToolDefinition = {
  name: 'CronList',
  description: 'List all scheduled cron tasks.',
  inputSchema: { type: 'object', properties: {} },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'List cron tasks.' },
  async call(): Promise<ToolResult> {
    const cronStorage = storage
    if (!cronStorage) return notInitializedResult()

    const tasks = await cronStorage.load()
    if (tasks.length === 0) {
      return { type: 'tool_result', tool_use_id: '', content: 'No cron tasks scheduled.' }
    }

    const lines = tasks.map((task) => {
      let line = `[${task.id}] ${cronToHuman(task.cron)} (${task.recurring ? 'recurring' : 'one-shot'}${task.permanent ? ', durable' : ''}) cron="${task.cron}" prompt="${formatPrompt(task.prompt)}"`;
      if (task.agentId) {
        line += ` agent="${task.agentId}"`;
      }
      return line;
    })
    return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
  },
}

/**
 * 这个tool是一个占位符，用于在远程环境中管理定时触发器（RemoteTrigger）。在本地SDK模式下，它不会执行实际的调度操作，而是提示用户需要连接远程后端来使用此功能。
 */
// export const RemoteTriggerTool: ToolDefinition = {
//   name: 'RemoteTrigger',
//   description: 'Manage remote scheduled agent triggers. Supports list, get, create, update, and run operations.',
//   inputSchema: {
//     type: 'object',
//     properties: {
//       action: {
//         type: 'string',
//         enum: ['list', 'get', 'create', 'update', 'run'],
//         description: 'Operation to perform',
//       },
//       id: { type: 'string', description: 'Trigger ID (for get/update/run)' },
//       name: { type: 'string', description: 'Trigger name (for create)' },
//       schedule: { type: 'string', description: 'Cron schedule (for create/update)' },
//       prompt: { type: 'string', description: 'Agent prompt (for create/update)' },
//     },
//     required: ['action'],
//   },
//   isReadOnly: () => false,
//   isConcurrencySafe: () => true,
//   isEnabled: () => true,
//   async prompt() { return 'Manage remote agent triggers.' },
//   async call(input: any): Promise<ToolResult> {
//     // RemoteTrigger operations are typically handled by the remote backend
//     // In standalone SDK mode, we provide a stub implementation
//     return {
//       type: 'tool_result',
//       tool_use_id: '',
//       content: `RemoteTrigger ${input.action}: This feature requires a connected remote backend. In standalone SDK mode, use CronCreate/CronList/CronDelete for local scheduling.`,
//     }
//   },
// }
