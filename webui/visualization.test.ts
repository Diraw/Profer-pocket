import { describe, expect, test } from 'bun:test'
import { niceCeil, normalizeVisualizations, placeOrphanVisualizations, toCsv } from './visualization'

/** 桌面端写入的一条图表记录（present_visualization 落盘后的形状）。 */
function barRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'viz-1',
    sessionId: 's1',
    toolCallId: 'call-chart-1',
    title: '各渠道停留时长',
    summary: '按渠道统计',
    format: 'chart',
    createdAt: 1700000000000,
    chart: {
      chartType: 'bar',
      xKey: 'channel',
      xAxisLabel: '渠道',
      series: [{ dataKey: 'minutes', label: '分钟' }],
      data: [
        { channel: '搜索', minutes: 42 },
        { channel: '直连', minutes: 18 },
      ],
    },
    ...overrides,
  }
}

describe('可视化记录归一化', () => {
  test('Given 完整图表记录 When 归一化 Then 保留挂回回合所需的 toolCallId 与图表规格', () => {
    const items = normalizeVisualizations([barRecord()])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'viz-1',
      toolCallId: 'call-chart-1',
      title: '各渠道停留时长',
      format: 'chart',
    })
    expect(items[0]?.chart?.chartType).toBe('bar')
    expect(items[0]?.chart?.data).toHaveLength(2)
    expect(items[0]?.chart?.series[0]?.dataKey).toBe('minutes')
  })

  test('Given 缺 id / toolCallId / title 的脏项 When 归一化 Then 全部丢弃而不是渲染孤立卡片', () => {
    const missingId = barRecord({ id: undefined })
    const missingTool = barRecord({ id: 'viz-2', toolCallId: '' })
    const missingTitle = barRecord({ id: 'viz-3', title: '   ' })
    expect(normalizeVisualizations([missingId, missingTool, missingTitle])).toEqual([])
  })

  test('Given 非数组输入 When 归一化 Then 返回空数组（旧服务端不认这条命令）', () => {
    expect(normalizeVisualizations(undefined)).toEqual([])
    expect(normalizeVisualizations({ records: [] })).toEqual([])
    expect(normalizeVisualizations(null)).toEqual([])
  })

  test('Given 未知 chartType 或空 data When 归一化 Then 丢掉 chart 但保留记录（HTML 型仍可提示）', () => {
    const unknown = barRecord({ chart: { chartType: 'radar', series: [], data: [{ a: 1 }] } })
    const empty = barRecord({ id: 'viz-2', chart: { chartType: 'bar', series: [], data: [] } })
    const [first, second] = normalizeVisualizations([unknown, empty])
    expect(first?.chart).toBeUndefined()
    expect(second?.chart).toBeUndefined()
    // 记录本身还在：卡片会退化成「需要在电脑端查看」而不是整条消失
    expect(first?.toolCallId).toBe('call-chart-1')
  })

  test('Given 缺 layout When 归一化 Then 默认纵向；显式 horizontal 才横排', () => {
    expect(normalizeVisualizations([barRecord()])[0]?.chart?.layout).toBe('vertical')
    const horizontal = barRecord({ chart: { ...(barRecord().chart as Record<string, unknown>), layout: 'horizontal' } })
    expect(normalizeVisualizations([horizontal])[0]?.chart?.layout).toBe('horizontal')
  })
})

describe('坐标轴刻度取整', () => {
  test('Given 任意上界 When 取整 Then 落在 1/2/5×10ⁿ 上，不出现小数刻度', () => {
    expect(niceCeil(42)).toBe(50)
    expect(niceCeil(18)).toBe(20)
    expect(niceCeil(100)).toBe(100)
    expect(niceCeil(0.37)).toBe(0.5)
  })

  test('Given 非正数或非有限值 When 取整 Then 回落到 1，除零不会发生', () => {
    expect(niceCeil(0)).toBe(1)
    expect(niceCeil(-5)).toBe(1)
    expect(niceCeil(Number.NaN)).toBe(1)
  })
})

describe('CSV 导出', () => {
  test('Given 中文列名 When 导出 Then 带 BOM 且列序为 xKey + 各 series', () => {
    const csv = toCsv(normalizeVisualizations([barRecord()])[0]!.chart!)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    // BOM 挂在首行上，比对列序时先摘掉
    expect(csv.slice(1).split('\n')[0]).toBe('channel,minutes')
    expect(csv).toContain('搜索,42')
  })

  test('Given 值里含逗号与引号 When 导出 Then 按 CSV 规则转义，Excel 不会串列', () => {
    const spec = {
      chartType: 'bar' as const,
      xKey: 'name',
      series: [{ dataKey: 'note' }],
      data: [{ name: 'a,b', note: '他说"好"' }],
    }
    const csv = toCsv(spec)
    expect(csv).toContain('"a,b","他说""好"""')
  })
})

describe('孤儿图表的插入位置', () => {
  const viz = (id: string, createdAt: number) => ({ id, toolCallId: `t-${id}`, title: id, createdAt })

  test('Given 图表早于所有已加载回合 When 定位 Then 插到最前（绝不跑到最后）', () => {
    const slots = placeOrphanVisualizations([viz('a', 1000)], [2000, 3000, 4000])
    expect([...slots.keys()]).toEqual([0])
    expect(slots.get(0)?.map((item) => item.id)).toEqual(['a'])
    expect(slots.has(3)).toBe(false)
  })

  test('Given 图表落在两个回合之间 When 定位 Then 插到第一个不早于它的回合前', () => {
    const slots = placeOrphanVisualizations([viz('a', 2500)], [1000, 2000, 3000, 4000])
    expect([...slots.keys()]).toEqual([2])
  })

  test('Given 图表比所有回合都新 When 定位 Then 才允许插到末尾', () => {
    const slots = placeOrphanVisualizations([viz('a', 9000)], [1000, 2000])
    expect([...slots.keys()]).toEqual([2])
  })

  test('Given 多个图表不同时间 When 定位 Then 分槽且槽内按时间升序', () => {
    const slots = placeOrphanVisualizations(
      [viz('c', 3500), viz('a', 500), viz('b', 600), viz('d', 8000)],
      [1000, 2000, 4000],
    )
    expect(slots.get(0)?.map((item) => item.id)).toEqual(['a', 'b'])
    expect(slots.get(2)?.map((item) => item.id)).toEqual(['c'])
    expect(slots.get(3)?.map((item) => item.id)).toEqual(['d'])
  })

  test('Given 回合时间戳全部缺失 When 定位 Then 退化到最前，不追加到末尾', () => {
    const slots = placeOrphanVisualizations([viz('a', 5000)], [undefined, undefined])
    expect([...slots.keys()]).toEqual([0])
  })

  test('Given 图表自身没有时间 When 定位 Then 同样当早期图表处理', () => {
    const slots = placeOrphanVisualizations([viz('a', 0)], [1000, 2000])
    expect([...slots.keys()]).toEqual([0])
  })

  test('Given 没有孤儿图表 When 定位 Then 空 Map（不渲染多余区块）', () => {
    expect(placeOrphanVisualizations([], [1000, 2000]).size).toBe(0)
  })
})
