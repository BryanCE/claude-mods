import { expect, test } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
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

// Runs a streamed call to its end.
const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of stream) {
    // the chunks are not under test
  }
}

// The plugin's store on disk, held in memory for one test.
const stubStore = (on: On): Map<string, unknown> => {
  const kept = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_$, e) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })
  return kept
}

test('/bar opens and closes a reading against the auto-compact window', async ($, on) => {
  stubStore(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.model', () => ({ value: 'opus' }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))
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

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const opened = await $.command.run(RUN)
  expect(opened.text).toBe('Context bar open.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'bar', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^20% $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /73\.0k used · 294\.0k left · Auto-compact at 367\.0k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /┃/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /window/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^opus$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ high$/ })).toBeDefined()
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

// /clear starts a new session with fresh state and raises only the classic
// SessionStart, never session.start; only the store carries the choice.
test('/clear opens the bar the store says was left open', async ($, on) => {
  const store = stubStore(on)
  store.set('isOpen', true)
  on('classic.SessionStart', () => ({}))
  on('session.model', () => ({ value: 'opus' }))
  on('settings.read', () => ({ value: {} }))
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

  await $.classic.SessionStart({ source: 'clear' })

  const open = await $.ui.mount({ plugin: 'bar', surface: 'terminal', ...BAND })
  expect(await open.find({ type: 'Text', text: /Auto-compact at/ })).toBeDefined()
  await open.unmount()

  const closed = await $.command.run(RUN)
  expect(closed.text).toBe('Context bar closed.')
  expect(store.get('isOpen')).toBe(false)
})

// No event follows a compaction's install, so the bar reads the compacted
// conversation when the next row, here a prompt, is stored.
test('the bar reads the context again when a row is stored', async ($, on) => {
  stubStore(on)
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

test('the bar shows the effort the main loop sent, after the model', async ($, on) => {
  stubStore(on)
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
  // A stub model that answers whole, streaming no chunks.
  // oxlint-disable-next-line require-yield
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const step = { turnId: 't1', index: 0, model: 'opus', messageCount: 1 }

  await $.command.run(RUN)
  await drain($.turn.step({ ...step, effort: 'xhigh' }))
  await drain($.turn.step({ ...step, effort: 'low', agentId: 'agent-1' }))

  const ui = await $.ui.mount({ plugin: 'bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^ xhigh$/ })).toBeDefined()
  await ui.unmount()

  await drain($.turn.step(step))
  const plain = await $.ui.mount({ plugin: 'bar', surface: 'terminal', ...BAND })
  expect(await plain.find({ type: 'Text', text: /^ (xhigh|low)$/ })).toBeUndefined()
  await plain.unmount()
})

test('/effort and /model move the level without waiting for a request', async ($, on) => {
  stubStore(on)
  const saved = { effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' }, 'claude-fable-5-2': { effortLevel: 'medium' } } }
  let model = 'claude-opus-5-5'
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.model', () => ({ value: model }))
  on('settings.read', () => ({ value: saved }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 73000, window: 1000000, percent: 7, breakdown: BREAKDOWN }, rateLimits: [] },
  }))
  on('command.run', (_$, e) =>
    e.command === 'effort' ? { text: `Set effort level to ${e.args}` } : { text: 'Set model' },
  )
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN)

  await $.command.run({ ...RUN, command: 'effort', args: 'low' })
  const ui = await $.ui.mount({ plugin: 'bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^ low$/ })).toBeDefined()
  await ui.unmount()

  model = 'Fable 5.2'
  await $.command.run({ ...RUN, command: 'model', args: '' })
  const after = await $.ui.mount({ plugin: 'bar', surface: 'terminal', ...BAND })
  expect(await after.find({ type: 'Text', text: /^ medium$/ })).toBeDefined()
  await after.unmount()
})
