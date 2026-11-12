import { describe, expect, test } from 'bun:test'
import { GOAL_STATUSES, goalActions, goalStatusLabel, normalizeGoal } from './goal'

describe('Goal 状态归一化', () => {
  test('Given 主进程返回的完整状态 When 归一化 Then 只保留展示需要的字段', () => {
    const goal = normalizeGoal({
      id: 'g1',
      sessionId: 's1',
      goal: '把构建修好',
      status: 'active',
      iteration: 3,
      updatedAt: 100,
      lastSummary: '已修复类型错误',
      limits: { maxIterations: 10, maxConsecutiveFailures: 3 },
      history: [{ iteration: 1 }],
      lifecycle: [{ id: 'e1' }],
    })
    expect(goal).toEqual({
      id: 'g1',
      goal: '把构建修好',
      status: 'active',
      iteration: 3,
      updatedAt: 100,
      lastSummary: '已修复类型错误',
      reasonDetail: undefined,
      maxIterations: 10,
      stopReason: undefined,
    })
  })

  test('Given 没有 Goal When 归一化 Then 返回 null（页面渲染「设定目标」入口）', () => {
    expect(normalizeGoal(null)).toBeNull()
    expect(normalizeGoal(undefined)).toBeNull()
    expect(normalizeGoal({})).toBeNull()
  })

  test('Given 关键字段缺失或脏值 When 归一化 Then 返回 null 而不是半成品状态', () => {
    expect(normalizeGoal({ id: '', goal: 'x', status: 'active' })).toBeNull()
    expect(normalizeGoal({ id: 'g1', goal: '   ', status: 'active' })).toBeNull()
    expect(normalizeGoal({ id: 'g1', goal: 'x' })).toBeNull()
    expect(normalizeGoal({ id: 'g1', goal: 'x', status: 'weird' })).toBeNull()
    expect(normalizeGoal('active')).toBeNull()
  })

  test('Given 两端版本不一致（未知状态） When 归一化 Then 宁可不显示也不猜状态', () => {
    expect(normalizeGoal({ id: 'g1', goal: 'x', status: 'paused_by_system' })).toBeNull()
  })

  test('Given 迭代轮次不是数字 When 归一化 Then 兜底为 0', () => {
    expect(normalizeGoal({ id: 'g1', goal: 'x', status: 'active', iteration: 'x' })?.iteration).toBe(0)
  })
})

describe('Goal 可用操作', () => {
  test('Given 执行中 When 取操作 Then 只有暂停与停止', () => {
    expect(goalActions('active')).toEqual(['pause', 'stop'])
  })

  test('Given 可恢复状态 When 取操作 Then 给「继续」而不是「暂停」', () => {
    for (const status of ['paused', 'blocked', 'failed', 'stopped', 'budget_limited'] as const) {
      expect(goalActions(status)).toEqual(['resume', 'clear'])
    }
  })

  test('Given 已完成或停止中 When 取操作 Then 只保留收尾动作', () => {
    expect(goalActions('completed')).toEqual(['clear'])
    expect(goalActions('stopping')).toEqual(['stop'])
  })

  test('Given 每个已知状态 When 取操作 Then 都至少有一个动作，不会出现卡死无按钮', () => {
    for (const status of GOAL_STATUSES) {
      expect(goalActions(status).length).toBeGreaterThan(0)
    }
  })
})

describe('Goal 状态文案', () => {
  test('Given 每个已知状态 When 取文案 Then 都是非空中文，不暴露内部枚举', () => {
    for (const status of GOAL_STATUSES) {
      const label = goalStatusLabel(status)
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toBe(status)
    }
  })
})
