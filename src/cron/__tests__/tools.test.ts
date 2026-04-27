import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronStorage } from '../storage.js'
import type { CronTask } from '../types.js'
import {
  CronCreateTool,
  CronDeleteTool,
  CronListTool,
  initCronTools,
} from '../../tools/cron-tools.js'

const toolContext = { cwd: process.cwd() }

function createMockStorage() {
  return {
    load: vi.fn<() => Promise<CronTask[]>>(),
    save: vi.fn<(tasks: CronTask[]) => Promise<void>>(),
    add: vi.fn<(task: Omit<CronTask, 'id' | 'createdAt'>) => Promise<string>>(),
    remove: vi.fn<(ids: string[]) => Promise<void>>(),
    markFired: vi.fn<(ids: string[], firedAt: number) => Promise<void>>(),
  }
}

function cronTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'task-1',
    cron: '*/5 * * * *',
    prompt: 'Run the report',
    createdAt: 1_000,
    recurring: true,
    ...overrides,
  }
}

describe('CronCreateTool', () => {
  let storage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    storage = createMockStorage()
    storage.load.mockResolvedValue([])
    storage.add.mockResolvedValue('task-1')
    initCronTools(storage as CronStorage)
  })

  it('validates cron expressions and rejects invalid ones', async () => {
    const result = await CronCreateTool.call(
      { cron: 'invalid cron', prompt: 'Run this', recurring: true, agent: 'bid' },
      toolContext,
    )

    expect(result).toEqual({
      type: 'tool_result',
      tool_use_id: '',
      content: 'Invalid cron expression: "invalid cron". Must be a valid 5-field cron (e.g. "0 16 * * *").',
      is_error: true,
    })
    expect(storage.load).not.toHaveBeenCalled()
    expect(storage.add).not.toHaveBeenCalled()
  })

  it('rejects task creation without agent field', async () => {
    const result = await CronCreateTool.call(
      { cron: '*/5 * * * *', prompt: 'Run the report', recurring: true },
      toolContext,
    )

    expect(result).toEqual({
      type: 'tool_result',
      tool_use_id: '',
      content: '错误：创建 cron 任务时必须指定 agent 字段。请根据任务内容分析并选择最合适的 agent。',
      is_error: true,
    })
    expect(storage.add).not.toHaveBeenCalled()
  })

  it('calls storage.add with the correct CronTask fields', async () => {
    const result = await CronCreateTool.call(
      {
        cron: '*/5 * * * *',
        prompt: 'Run the report',
        recurring: true,
        durable: true,
        agent: 'finance',
      },
      toolContext,
    )

    expect(storage.load).toHaveBeenCalledTimes(1)
    expect(storage.add).toHaveBeenCalledTimes(1)
    expect(storage.add).toHaveBeenCalledWith({
      cron: '*/5 * * * *',
      prompt: 'Run the report',
      recurring: true,
      permanent: true,
      agentId: 'finance',
    })
    expect(result.type).toBe('tool_result')
    expect(result.is_error).toBeUndefined()
    expect(result.content).toContain('Cron task created: task-1 (Every 5 minutes). Next run: ')
  })
})

describe('CronDeleteTool', () => {
  let storage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    storage = createMockStorage()
    storage.load.mockResolvedValue([cronTask({ id: 'task-1' })])
    storage.remove.mockResolvedValue()
    initCronTools(storage as CronStorage)
  })

  it('calls storage.remove with the correct id', async () => {
    const result = await CronDeleteTool.call({ id: 'task-1' }, toolContext)

    expect(storage.load).toHaveBeenCalledTimes(1)
    expect(storage.remove).toHaveBeenCalledTimes(1)
    expect(storage.remove).toHaveBeenCalledWith(['task-1'])
    expect(result).toEqual({
      type: 'tool_result',
      tool_use_id: '',
      content: 'Cron task deleted: task-1',
    })
  })
})

describe('CronListTool', () => {
  let storage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    storage = createMockStorage()
    initCronTools(storage as CronStorage)
  })

  it('calls storage.load and returns the list of tasks', async () => {
    storage.load.mockResolvedValue([
      cronTask({ id: 'task-1', cron: '*/5 * * * *', recurring: true }),
      cronTask({
        id: 'task-2',
        cron: '0 9 * * 1-5',
        prompt: 'Do a one-time weekday check',
        recurring: false,
        permanent: true,
      }),
    ])

    const result = await CronListTool.call({}, toolContext)

    expect(storage.load).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('tool_result')
    expect(result.is_error).toBeUndefined()
    expect(result.content).toBe(
      [
        '[task-1] Every 5 minutes (recurring) cron="*/5 * * * *" prompt="Run the report"',
        '[task-2] Weekdays at 9:00 AM (one-shot, durable) cron="0 9 * * 1-5" prompt="Do a one-time weekday check"',
      ].join('\n'),
    )
  })
})
