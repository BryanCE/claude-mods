import { expect, test } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const RUN = {
  command: 'bar',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

// A 400k compaction window on a 1M model, auto-compact at 367k, 73k used.
const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 3000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 20000, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 50000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33000, color: 'subtle', isDeferred: false, kind: 'buffer' },
    { name: 'Free space', tokens: 294000, color: 'subtle', isDeferred: false, kind: 'free' },
  ],
  totalTokens: 73000,
  maxTokens: 400000,
  rawMaxTokens: 400000,
  autocompactSource: 'env',
  percentage: 18,
  gridRows: [],
  model: 'opus',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  autoCompactThreshold: 367000,
  isAutoCompactEnabled: true,
  apiUsage: null,
}

test('/bar opens and closes a reading against the auto-compact window', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 73000, window: 1000000, percent: 7, breakdown: BREAKDOWN },
      rateLimits: [],
    },
  }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const opened = await $.command.run(RUN)
  expect(opened.text).toBe('Context bar open.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'bar', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^20% $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /73\.0k used · 294\.0k left · Auto-compact at 367\.0k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /┃/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /window 400\.0k · opus/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Messages 50\.0k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Tools 20\.0k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Buffer 33\.0k/ })).toBeDefined()
    await ui.unmount()
  }

  const closed = await $.command.run(RUN)
  expect(closed.text).toBe('Context bar closed.')

  const ui = await $.ui.mount({ plugin: 'bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Auto-compact/ })).toBeUndefined()
  await ui.unmount()
})

// No event follows a compaction's install, so the bar reads the compacted
// conversation when the next row, here a prompt, is stored.
test('the bar reads the context again when a row is stored', async ($, on) => {
  const COMPACTED: SessionContextBreakdown = {
    ...BREAKDOWN,
    categories: BREAKDOWN.categories.map(c => (c.name === 'Messages' ? { ...c, tokens: 5000 } : c)),
    totalTokens: 28000,
  }
  let breakdown = BREAKDOWN
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: breakdown.totalTokens, window: 1000000, percent: 7, breakdown },
      rateLimits: [],
    },
  }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.command.run(RUN)
  breakdown = COMPACTED
  await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text: 'next prompt' }] },
    door: 'prompt',
    origin: { kind: 'engine' },
    uuid: 'prompt-1',
  })

  const ui = await $.ui.mount({ plugin: 'bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /28\.0k used/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Messages 5\.0k/ })).toBeDefined()
  await ui.unmount()
})
