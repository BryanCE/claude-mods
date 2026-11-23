import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextBreakdown } from 'claude-code'

import type { ContextSlice, ContextSnapshot } from '../types'

const snapshot = atom({ plugin: 'bar', key: 'snapshot' } as const, null)
const isOpen = atom({ plugin: 'bar', key: 'isOpen' } as const, false)
const effort = atom({ plugin: 'bar', key: 'effort' } as const, null)

// Session state starts over on /clear, so the open flag is also kept in the
// store, which outlives the session; restore reads it back.
const OPEN_KEY = 'isOpen'

const LEVEL = /effort level to (\w+)/i

const levelOf = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || !('effortLevel' in value)) return null
  return typeof value.effortLevel === 'string' ? value.effortLevel : null
}

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

// The thinking level before a request names one: the current model's entry in
// modelSettings, matched by id or by the name /model shows, else effortLevel.
const readEffortSetting = async ($: EngineInterface): Promise<string | null> => {
  const model = slug(await $.session.model())
  const perModel = await $.settings.read({ key: 'modelSettings' })
  if (typeof perModel === 'object' && perModel !== null) {
    const entry = Object.entries(perModel).find(([id]) => slug(id) === model || slug(id).includes(model))
    const level = entry === undefined ? null : levelOf(entry[1])
    if (level !== null) return level
  }
  const level = await $.settings.read({ key: 'effortLevel' })
  return typeof level === 'string' ? level : null
}

// /effort and /model change the level at once; the bar follows without
// waiting for the next request. The command's own line names the level when
// it set one; otherwise the setting it saved does.
const followCommand = async ($: EngineInterface, text: string | undefined): Promise<void> => {
  const named = text === undefined ? null : (LEVEL.exec(text)?.[1] ?? null)
  const level = named ?? (await readEffortSetting($))
  await update($, effort, current => level ?? current)
}

type Cell = { char: string; color: string | null }

const FREE: Cell = { char: '░', color: null }
const MARKER: Cell = { char: '┃', color: 'error' }

// Short legend names for /context's category labels.
const SHORT_NAMES: Record<string, string> = {
  'System prompt': 'Prompt',
  'System tools': 'Tools',
  'MCP tools': 'MCP',
  'MCP server instructions': 'MCP instr',
  'Custom agents': 'Agents',
  'Memory files': 'Memory',
  'Autocompact buffer': 'Buffer',
}

// The window is the compaction window (rawMaxTokens), so the bar follows the
// auto-compact setting rather than the model's full limit.
const toSnapshot = (breakdown: SessionContextBreakdown): ContextSnapshot => ({
  slices: breakdown.categories
    .filter(c => (c.kind === 'used' || c.kind === 'buffer') && c.tokens > 0)
    .map(c => ({
      name: SHORT_NAMES[c.name] ?? c.name,
      tokens: c.tokens,
      color: c.color,
      isBuffer: c.kind === 'buffer',
    })),
  model: breakdown.model,
  totalTokens: breakdown.totalTokens,
  maxTokens: breakdown.rawMaxTokens,
  percent: breakdown.percentage,
  autoCompactAt: breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null,
})

// Reads the live context, as /context counts it, into the snapshot the bar draws.
const refresh = async ($: EngineInterface): Promise<void> => {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const { breakdown } = context

  if (breakdown !== undefined) {
    await update($, snapshot, () => toSnapshot(breakdown))
  }
}

// Fills a session's fresh state: the open choice from the store, the effort
// from settings, and a first reading of the context.
const restore = async ($: EngineInterface): Promise<void> => {
  const stored = await $.store.get(OPEN_KEY)
  await update($, isOpen, () => stored === true)
  const level = await readEffortSetting($)
  await update($, effort, current => current ?? level)
  await refresh($)
}

const kTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

// How far toward auto-compact (or the window, with it off), 0 to 1.
const progress = (snap: ContextSnapshot): number => snap.totalTokens / (snap.autoCompactAt ?? snap.maxTokens)

// Green, then yellow at 60% of the way to auto-compact, red at 85%.
const badgeColor = (snap: ContextSnapshot): 'success' | 'warning' | 'error' => {
  const ratio = progress(snap)
  if (ratio >= 0.85) return 'error'
  if (ratio >= 0.6) return 'warning'
  return 'success'
}

const headline = (snap: ContextSnapshot): string => {
  const limit = snap.autoCompactAt ?? snap.maxTokens
  const left = kTokens(Math.max(0, limit - snap.totalTokens))
  const label = snap.autoCompactAt === null ? 'Auto-compact off · window' : 'Auto-compact at'

  return `${kTokens(snap.totalTokens)} used · ${left} left · ${label} ${kTokens(limit)}`
}

const entryText = (s: ContextSlice): string => `${s.name} ${kTokens(s.tokens)}`

// The largest categories first, as many as fit beside the free space and the
// buffer, which always show.
const fitLegend = (snap: ContextSnapshot, width: number, freeTokens: number): ContextSlice[] => {
  const tail = [`Free ${kTokens(freeTokens)}`, ...snap.slices.filter(s => s.isBuffer).map(entryText)]
  const tailWidth = tail.reduce((sum, text) => sum + text.length + 5, 0)
  const ranked = snap.slices.filter(s => !s.isBuffer).sort((a, b) => b.tokens - a.tokens)

  return ranked.reduce<{ fitted: ContextSlice[]; used: number }>(
    (acc, s) => {
      const cost = entryText(s).length + 5
      return acc.used + cost <= width
        ? { fitted: [...acc.fitted, s], used: acc.used + cost }
        : acc
    },
    { fitted: [], used: tailWidth },
  ).fitted
}

// Used categories fill from the left, the compaction buffer from the right,
// free space between, and the auto-compact point is marked over the top.
const toCells = (snap: ContextSnapshot, width: number): Cell[] => {
  const cellsOf = (tokens: number): number => Math.round((tokens / snap.maxTokens) * width)
  const used = snap.slices.filter(s => !s.isBuffer)
  const buffer = snap.slices.filter(s => s.isBuffer)
  const left = used.flatMap(s => Array<Cell>(cellsOf(s.tokens)).fill({ char: '█', color: s.color }))
  const right = buffer.flatMap(s => Array<Cell>(cellsOf(s.tokens)).fill({ char: '▒', color: s.color }))
  const free = Math.max(0, width - left.length - right.length)
  const cells = [...left, ...Array<Cell>(free).fill(FREE), ...right].slice(0, width)

  if (snap.autoCompactAt !== null) {
    cells[Math.min(width - 1, cellsOf(snap.autoCompactAt))] = MARKER
  }

  return cells
}

const toRuns = (cells: Cell[]): Cell[] =>
  cells.reduce<Cell[]>((runs, cell) => {
    const last = runs.at(-1)
    if (last !== undefined && last.color === cell.color) {
      runs[runs.length - 1] = { char: last.char + cell.char, color: last.color }
    } else {
      runs.push(cell)
    }
    return runs
  }, [])

// The bar reads the context when it opens, whenever a row is stored in the
// main conversation, and after each turn. No event follows a compaction once
// the new conversation is in place, so the reading catches up at the next row.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'bar',
      description: 'Open or close the color-coded context bar above the prompt',
    })
    await restore($)

    return result
  })

  // session.start fires once per process, never on /clear; the classic
  // SessionStart fires for every session, the one /clear starts included.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await restore($)

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await refresh($)
    }

    return next(e)
  })

  // Every row the main conversation stores: a prompt, a reply, a tool result.
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await refresh($)
    }

    return result
  })

  // The effort the main loop's request carries, after the session setting and
  // any downgrade for the model; absent on a model without effort.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await update($, effort, () => (e.effort === undefined ? null : `${e.effort}`))
    }

    return yield* next(e)
  })

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    await followCommand($, result.text)
    return result
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    await followCommand($, undefined)
    return result
  })

  on('command.run', { command: 'bar' }, async $ => {
    const open = !(await read($, isOpen))
    if (open) {
      await refresh($)
    }
    await update($, isOpen, () => open)
    await $.store.set(OPEN_KEY, open)

    return { text: open ? 'Context bar open.' : 'Context bar closed.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const level = await read($, effort)

    if (e.props.hasSurvey || snap === null || !(await read($, isOpen))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(10, e.props.bodyColumns)
    const runs = toRuns(toCells(snap, width))
    const usedTokens = snap.slices.reduce((sum, s) => sum + s.tokens, 0)
    const freeTokens = Math.max(0, snap.maxTokens - usedTokens)

    return (
      <Box key="bar" flexDirection="column">
        <Text wrap="truncate">
          <Text bold color={badgeColor(snap)}>{`${Math.round(progress(snap) * 100)}% `}</Text>
          <Text bold>{headline(snap)}</Text>
          <Text>{'   '}</Text>
          <Text bold color="claude">{snap.model}</Text>
          {level === null ? null : <Text bold color="suggestion">{` ${level}`}</Text>}
        </Text>
        <Text wrap="truncate">
          {runs.map(run =>
            run.color === null ? <Text dimColor>{run.char}</Text> : <Text color={run.color}>{run.char}</Text>,
          )}
        </Text>
        <Text wrap="truncate">
          {fitLegend(snap, width, freeTokens).map(s => (
            <Text>
              <Text color={s.color}>█ </Text>
              <Text dimColor>{`${entryText(s)}   `}</Text>
            </Text>
          ))}
          <Text dimColor>{`░ Free ${kTokens(freeTokens)}   `}</Text>
          {snap.slices
            .filter(s => s.isBuffer)
            .map(s => (
              <Text>
                <Text color={s.color}>▒ </Text>
                <Text dimColor>{entryText(s)}</Text>
              </Text>
            ))}
        </Text>
      </Box>
    )
  })
}
