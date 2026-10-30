import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BandMetrics, BandScheme, BandView, Effort } from '../types'

const EMPTY: BandMetrics = {
  model: null,
  effort: null,
  settingEffort: null,
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  speedTokens: 0,
  speedMs: 0,
  liveTps: null,
}

const band = atom({ plugin: 'status-band', key: 'band' } as const, EMPTY, {
  shape: 'band-tps-2',
})

const DEFAULT_VIEW: BandView = { visible: true, scheme: 'color' }

// The display preference lives apart from the metrics: /clear resets the band
// but not what the person chose, and `$.store` carries it between sessions.
const view = atom(
  { plugin: 'status-band', key: 'view' } as const,
  DEFAULT_VIEW,
  { shape: 'view-1' },
)

const VIEW_KEY = 'view'

// The picker `/band` opens in the band's own place, above the prompt. Kept in
// state rather than as a Pane: the person wanted the /effort look, not a dock.
/** Responses shorter than this are left out of t/s: too few samples to mean much. */
const TPS_MIN_SECONDS = 0.25

/** The live estimate is repainted at most this often, however dense the deltas. */
const TPS_REFRESH_MS = 250

let generation = 0 // bumped on /clear and in-process resume
let isTicking = false
let pollTimer: Timer | null = null

// While a `model.fork` runs, its own turn steps are left to the fork's hook,
// which reports their summed usage. Non-fork steps keep counting.
let forkDepth = 0

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}

function fmt(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 10_000) return `${trimZero((value / 1_000).toFixed(1))}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  if (value < 10_000_000) return `${trimZero((value / 1_000_000).toFixed(1))}M`
  return `${Math.round(value / 1_000_000)}M`
}

function fmtSpeed(value: number): string {
  return value < 10 ? trimZero(value.toFixed(1)) : String(Math.round(value))
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A model id as `modelSettings` keys it: the context suffix (`[1m]`) is the
 * window variant and not part of the name the setting is filed under.
 */
function modelKey(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').trim()
}

function levelOf(entry: unknown): Effort | null {
  if (!isRecord(entry)) return null
  const level = entry.effortLevel
  // Settings may name a level the API's set does not; the band still shows it.
  return typeof level === 'number' || (typeof level === 'string' && level !== '')
    ? (level as Effort)
    : null
}

/** `modelSettings.<model>.effortLevel` out of one merged settings object. */
function effortFromTable(table: unknown, model: string): Effort | null {
  if (!isRecord(table)) return null
  const wanted = [model, modelKey(model)].map(name => name.toLowerCase())
  for (const [name, entry] of Object.entries(table)) {
    if (wanted.includes(name.toLowerCase())) {
      const level = levelOf(entry)
      if (level !== null) return level
    }
  }
  return null
}

/**
 * The same, folded over a settings read's layers: lowest precedence first,
 * each model's object merged as the engine merges settings.
 */
function effortFromLayers(
  layers: readonly { settings: Readonly<Record<string, unknown>> }[],
  model: string,
): Effort | null {
  const table: Record<string, unknown> = {}
  for (const layer of layers) {
    const part = layer.settings.modelSettings
    if (!isRecord(part)) continue
    for (const [name, entry] of Object.entries(part)) {
      const prior = table[name]
      table[name] =
        isRecord(prior) && isRecord(entry) ? { ...prior, ...entry } : entry
    }
  }
  return effortFromTable(table, model)
}

/**
 * The effort the settings pin for a model (`/config`'s per-model setting),
 * or the env level when settings name none.
 *
 * A request's own effort is authoritative once one names it; this fills the
 * band before the first request of a session, and for a model whose requests
 * carry no effort at all.
 */
async function configuredEffort(
  $: EngineInterface,
  model: string,
): Promise<Effort | null> {
  try {
    const settings = await $.settings.read()
    const level = effortFromTable(settings.modelSettings, model)
    if (level !== null) return level
  } catch {}

  try {
    const level = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
    return level === undefined || level === '' ? null : (level as Effort)
  } catch {
    return null
  }
}

/**
 * The command's own words out of an output row: the engine wraps a command's
 * output in `<local-command-stdout>`/`<local-command-stderr>`, which is not
 * part of what the command said.
 */
function commandOutput(text: string): string {
  const wrapped =
    /^<local-command-(?:stdout|stderr)>([\s\S]*)<\/local-command-(?:stdout|stderr)>$/.exec(
      text.trim(),
    )
  return wrapped?.[1] ?? text
}

/** The text of one appended row: its text blocks, in order. */
function appendedText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('\n')
}

/**
 * What `/effort`'s own output says it put in force: a level, `null` for auto,
 * or `undefined` when the line names none (or only reports the current level).
 *
 * The command changes the session's live level without a request, so its
 * output is the only immediate account of it; the engine's wording is
 * `Set effort level to <level>`, `set to '<level>' instead` when a cap
 * lowered the pick, and `Effort level set to auto`. A status line
 * (`Effort level: auto (currently <level>)`) changes nothing and is left out.
 */
function appliedEffort(text: string | undefined): Effort | null | undefined {
  if (text === undefined) return undefined
  const output = commandOutput(text)
  if (output.startsWith('Not applied')) return undefined
  const capped = /set to '([^']+)' instead/.exec(output)
  if (capped?.[1] !== undefined) return capped[1] as Effort
  const set = /^Set effort level to (\w+)/.exec(output)
  if (set?.[1] !== undefined) return set[1] as Effort
  if (/^Effort level set to auto/.test(output)) return null
  return undefined
}

/**
 * The settings' level for a model and the marker of what it said, so a later
 * read can tell a changed setting from a read that changed nothing.
 */
async function settingFields(
  $: EngineInterface,
  model: string,
): Promise<Patch> {
  const settingEffort = await configuredEffort($, model)
  return { effort: settingEffort, settingEffort }
}

/** The share of the cumulative prompt that came from the cache. */
function cacheRate(m: BandMetrics): number | null {
  const total = m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens
  return total > 0 ? Math.round((m.cacheReadTokens / total) * 100) : null
}

/** Cumulative output tokens per second of cumulative generation time. */
function tokPerSec(m: BandMetrics): number | null {
  if (m.speedMs <= 0 || m.speedTokens <= 0) return null
  return m.speedTokens / (m.speedMs / 1_000)
}

type Patch = Partial<BandMetrics>

async function patch($: EngineInterface, partial: Patch): Promise<void> {
  const current = await read($, band)
  const changed = (Object.keys(partial) as (keyof BandMetrics)[]).some(
    key => !Object.is(current[key], partial[key]),
  )
  if (!changed) return

  await update($, band, latest => ({ ...latest, ...partial }))
}

function isBandView(value: unknown): value is BandView {
  if (!isRecord(value)) return false
  return (
    typeof value.visible === 'boolean' &&
    (value.scheme === 'color' || value.scheme === 'gray')
  )
}

/** The view a command argument names, or undefined when it names none. */
function viewFromArg(arg: string, current: BandView): BandView | undefined {
  switch (arg.trim().toLowerCase()) {
    case 'show':
    case 'on':
    case '显示':
      return { ...current, visible: true }
    case 'hide':
    case 'off':
    case '隐藏':
      return { ...current, visible: false }
    case 'color':
    case 'colour':
    case '彩色':
      return { visible: true, scheme: 'color' }
    case 'gray':
    case 'grey':
    case 'mono':
    case '全灰':
      return { visible: true, scheme: 'gray' }
    default:
      return undefined
  }
}

const MENU_ID = 'band-menu'
const MENU_TITLE = 'Status band'

type BandKind = 'color' | 'gray' | 'hidden'

const OPTIONS: readonly { label: string; hotkey: string; kind: BandKind }[] = [
  { label: 'Color', hotkey: '1', kind: 'color' },
  { label: 'Grey', hotkey: '2', kind: 'gray' },
  { label: 'Hidden', hotkey: '3', kind: 'hidden' },
]

/** Which option stands for a view: hidden wins over the scheme it kept. */
function kindOf(v: BandView): BandKind {
  if (!v.visible) return 'hidden'
  return v.scheme === 'gray' ? 'gray' : 'color'
}

function viewOf(kind: BandKind, current: BandView): BandView {
  if (kind === 'hidden') return { ...current, visible: false }
  return { visible: true, scheme: kind }
}

function describeView(v: BandView): string {
  if (!v.visible) return 'Status band hidden.'
  return v.scheme === 'gray'
    ? 'Status band shown in grey.'
    : 'Status band shown in color.'
}

const USAGE = 'Usage: /band [show|hide|color|gray], or /band alone to open the panel.'

/** Writes the view to the atom and to the store the next session reads. */
async function applyView($: EngineInterface, next: BandView): Promise<void> {
  await update($, view, () => next)
  try {
    await $.store.set(VIEW_KEY, next)
  } catch {}
}

/** Reads the stored preference back, declining anything malformed. */
async function restoreView($: EngineInterface): Promise<void> {
  try {
    const stored = await $.store.get(VIEW_KEY)
    if (!isBandView(stored)) return
    // Both session.start and classic.SessionStart run at a fresh process's
    // start; the second write would only bump the version and redraw.
    const current = await read($, view)
    if (current.visible === stored.visible && current.scheme === stored.scheme) {
      return
    }
    await update($, view, () => stored)
  } catch {}
}

/** The four token counts one model response reports. */
type UsageCounts = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function hasTokens(usage: UsageCounts): boolean {
  return (
    usage.input_tokens +
      usage.output_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens >
    0
  )
}

/**
 * Adds one response's usage to the session counters. `gen` is the generation
 * read before the request, so one that straddles `/clear` changes nothing.
 */
async function addUsage(
  $: EngineInterface,
  usage: UsageCounts,
  gen: number,
  speed?: { tokens: number; ms: number },
): Promise<void> {
  if (gen !== generation || !hasTokens(usage)) return
  try {
    await update($, band, current => ({
      ...current,
      inputTokens: current.inputTokens + usage.input_tokens,
      outputTokens: current.outputTokens + usage.output_tokens,
      cacheReadTokens: current.cacheReadTokens + usage.cache_read_input_tokens,
      cacheCreationTokens:
        current.cacheCreationTokens + usage.cache_creation_input_tokens,
      ...(speed === undefined
        ? {}
        : {
            speedTokens: current.speedTokens + speed.tokens,
            speedMs: current.speedMs + speed.ms,
          }),
    }))
  } catch {}
}

async function seed($: EngineInterface): Promise<void> {
  const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
  const current = await read($, band)
  const switched = current.model !== null && current.model !== model

  await patch($, {
    model,
    // A start (or a reload after /clear) fills the effort from the settings;
    // a live value already on the band is left to the step that set it.
    ...(switched || current.effort === null
      ? await settingFields($, model)
      : {}),
    contextTokens: usage.context.tokens ?? null,
    contextWindow: usage.context.window,
    contextPercent: usage.context.percent ?? null,
  })
}

async function refresh($: EngineInterface): Promise<void> {
  if (isTicking) return
  isTicking = true

  const gen = generation
  try {
    const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
    if (gen !== generation) return

    const current = await read($, band)
    const switched = current.model !== null && current.model !== model
    await patch($, {
      model,
      ...(switched ? await settingFields($, model) : {}),
      contextTokens: usage.context.tokens ?? null,
      contextWindow: usage.context.window,
      contextPercent: usage.context.percent ?? null,
    })
  } catch {
    // A poll must never surface an error into the session.
  } finally {
    isTicking = false
  }
}

export const register: Register = on => {
  // /clear (and its /new alias) and an in-process /resume end the conversation
  // in the same process: the engine drops every plugin's `$.state` value at
  // session end and fires no `session.start` for the new one. The classic
  // SessionStart hook runs right after, so the stored preference is read again
  // here; without it `view` falls back to the atom's initial, color.
  on('classic.SessionStart', async ($, e, next) => {
    await restoreView($).catch(() => {})
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      pollTimer?.cancel()
      pollTimer = $.clock.every(3_000, () => {
        void refresh($)
      })
    }

    await restoreView($).catch(() => {})
    await seed($).catch(() => {})

    try {
      await $.command.register({
        name: 'band',
        description: 'Show, hide or recolour the status band',
        argumentHint: 'show|hide|color|gray',
      })
    } catch {}

    return next(e)
  })

  // The engine re-reads the settings when they change: a changed per-model
  // level shows at once. A read that changed nothing must not overwrite a
  // live step or `/effort` value, and a read of one source is that source
  // alone, so only a merged read that moves the level is applied.
  on('settings.read', async ($, e, next) => {
    if (e.source === undefined) {
      try {
        const current = await read($, band)
        if (current.model !== null) {
          const settingEffort = effortFromLayers(e.layers, current.model)
          if (!Object.is(settingEffort, current.settingEffort)) {
            await patch($, { effort: settingEffort, settingEffort })
          }
        }
      } catch {}
    }
    return next(e)
  })

  // `/effort` moves the session's live level with no request to report it.
  // In the terminal it is a `local-jsx` dialog: the engine's command result
  // carries no text for that kind, and the message it shows is appended as a
  // `<local-command-stdout>` row instead. That row is the immediate account
  // of the level the dialog put in force, so read it here.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        const level = appliedEffort(appendedText(e.message.content))
        if (level !== undefined) await patch($, { effort: level })
      }
    } catch {}
    return next(e)
  })

  // A command run without a dialog (a headless `local` command, or a plugin's
  // `$.command.run`) answers `next(e)` with its text: read the level there.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const level = appliedEffort(result.text)
      if (level !== undefined) await patch($, { effort: level })
    } catch {}
    return result
  })

  // A bare `/band` opens the picker just above the prompt; an argument jumps
  // straight to one state, for a script or a headless run.
  on('command.run', { command: 'band' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg !== '') {
      const current = await read($, view)
      const chosen = viewFromArg(arg, current)
      if (chosen === undefined) return { text: USAGE }

      await applyView($, chosen)
      return { text: describeView(chosen) }
    }

    const isUp = (await $.ui.panes()).some(pane => pane.id === MENU_ID)
    if (isUp) {
      await $.ui.close({ id: MENU_ID })
      return { text: 'Status band picker closed.' }
    }

    // An inline pane, `rows` asking for its content's height: it sits above the
    // prompt rather than docking. `closeOnEscape` makes Esc close it, and with
    // `focus` its buttons take Tab/arrows and Enter.
    const opened = await $.ui.open({
      id: MENU_ID,
      title: MENU_TITLE,
      focus: true,
      closeOnEscape: true,
      rows: 6,
    })
    if (!opened.isPlaced) {
      const reason = 'reason' in opened ? opened.reason : 'no surface'
      return { text: `The picker cannot open here (${reason}). ${USAGE}` }
    }

    return { text: 'Status band picker opened: press 1, 2 or 3.' }
  })

  // The picker's body, in the `/effort` menu's shape: a title, three numbered
  // rows with the current one at full strength, and the keys that work.
  on('ui.render', { component: 'Pane', requestId: MENU_ID }, async ($, e) => {
    const v = await read($, view)
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = kindOf(v)

    const choose = (kind: BandKind) => {
      void (async () => {
        try {
          await applyView($, viewOf(kind, v))
          await $.ui.close({ id: MENU_ID })
        } catch {}
      })()
    }

    return (
      <Box flexDirection="column" width={e.props.bodyColumns} overflow="hidden">
        <Text bold>{MENU_TITLE}</Text>
        {OPTIONS.map(option => (
          <Button
            key={option.kind}
            hotkey={option.hotkey}
            plain
            dimColor={option.kind !== current}
            autoFocus={option.kind === current ? true : undefined}
            onPress={() => choose(option.kind)}
          >
            {`${option.label}${option.kind === current ? '  (current)' : ''}`}
          </Button>
        ))}
        <Text dimColor>1 / 2 / 3 or ↑↓ Enter · Esc close</Text>
      </Box>
    )
  })

  on('session.measure', async ($, e, next) => {
    const gen = generation
    try {
      if (gen === generation) {
        await patch($, {
          contextTokens: e.context.tokens ?? null,
          contextWindow: e.context.window,
          contextPercent: e.context.percent ?? null,
        })
      }
    } catch {}
    return next(e)
  })

  // A compaction summary is a model request of its own: /usage's ledger
  // counts it, and so does the band.
  on('session.compact', async ($, e, next) => {
    const gen = generation
    const result = await next(e)
    const usage = 'usage' in result ? result.usage : undefined
    if (usage !== undefined) await addUsage($, usage, gen)
    return result
  })

  // Completions other plugins (and the engine's own background work that
  // goes through the op) are priced too; they are in the same ledger.
  on('model.complete', async ($, e, next) => {
    const gen = generation
    const result = await next(e)
    if (result.value !== undefined) {
      await addUsage($, result.value.usage, gen)
    }
    return result
  })

  // A fork's requests are summed in its result; its own `turn.step`s are
  // held out in the handler below while `forkDepth` is set.
  on('model.fork', async ($, e, next) => {
    const gen = generation
    forkDepth += 1
    try {
      const result = await next(e)
      if (result.value !== undefined && 'usage' in result.value) {
        await addUsage($, result.value.usage, gen)
      }
      return result
    } finally {
      forkDepth -= 1
    }
  })

  on('turn.step', async function* ($, e, next) {
    // Every loop's usage counts, main's and agents' alike, so the counters
    // match /usage's session ledger. Only main-thread responses feed t/s.
    const isMain = e.agentId === undefined
    const gen = generation

    // Effort is only exposed on the step, just before the request is sent; it
    // is the level that request actually carries (a silent downgrade
    // included). A subagent's level is its own, not the session's, and a step
    // that names none (a model that takes no effort) leaves what the settings
    // or `/effort` put on the band.
    try {
      if (isMain && gen === generation && e.effort !== undefined) {
        await patch($, { effort: e.effort })
      }
    } catch {}

    // Timing starts at the first output chunk, so the wait for the first
    // token stays out of the denominator. Chunks pass through unchanged.
    const stream = next(e)
    void stream.result.catch(() => {}) // closed early when the turn is interrupted

    let firstOutputAt = 0
    let chars = 0
    let lastLiveAt = 0

    try {
      for await (const chunk of stream) {
        const kind = chunk.kind
        if (
          isMain &&
          (kind === 'text' ||
            kind === 'thinking' ||
            kind === 'tool' ||
            kind === 'input')
        ) {
          const now = Date.now()
          if (firstOutputAt === 0) firstOutputAt = now

          // The provider reports usage only when a response ends; until then
          // text and thinking at four characters per token approximate it.
          if (kind === 'text' || kind === 'thinking') chars += chunk.text.length

          if (now - lastLiveAt >= TPS_REFRESH_MS) {
            const tokens = Math.round(chars / 4)
            const seconds = (now - firstOutputAt) / 1_000
            if (tokens > 0 && seconds >= TPS_MIN_SECONDS) {
              lastLiveAt = now
              try {
                if (gen === generation) {
                  await patch($, { liveTps: tokens / seconds })
                }
              } catch {}
            }
          }
        }
        yield chunk
      }

      const result = await stream.result

      if (result.usage) {
        // Response time with the time to first token taken out.
        const endedAt = Date.now()
        const seconds =
          firstOutputAt > 0 && endedAt >= firstOutputAt
            ? (endedAt - firstOutputAt) / 1_000
            : 0
        const countsForSpeed =
          isMain &&
          seconds >= TPS_MIN_SECONDS &&
          result.usage.output_tokens > 0
        const usage = result.usage

        // A fork's own steps are summed by its `model.fork` hook; counting
        // them here as well would double the fork's usage.
        if (!(forkDepth > 0 && !isMain)) {
          await addUsage(
            $,
            usage,
            gen,
            countsForSpeed
              ? { tokens: usage.output_tokens, ms: seconds * 1_000 }
              : undefined,
          )
        }
      }

      return result
    } finally {
      // An interrupted response leaves no live figure behind.
      if (isMain) {
        try {
          if (gen === generation) await patch($, { liveTps: null })
        } catch {}
      }
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      generation += 1
      try {
        await update($, band, () => ({ ...EMPTY }))
      } catch {}
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (
      e.props.hasSurvey ||
      e.props.maxRows < 1 ||
      e.props.bodyColumns < 1
    ) {
      return next(e)
    }

    const v = await read($, view) // subscribes this render to the preference
    if (!v.visible) return next(e)

    const m = await read($, band) // subscribes this render to the atom

    const { Box, Text } = $.ui.resolve(e)
    const isGray = v.scheme === 'gray'

    // One palette switch for every segment: the gray scheme keeps `text`,
    // which follows the theme, and dims it, rather than a fixed hex that
    // would read differently on a light background.
    const tone = (color: string) =>
      isGray ? { color: 'text' as const, dimColor: true as const } : { color }

    const model = clip(m.model ?? '—', 28)
    const effort = m.effort === null ? '—' : String(m.effort)
    const ctxPct =
      m.contextPercent === null ? '—' : `${Math.round(m.contextPercent)}%`

    const rate = cacheRate(m)
    const speed = m.liveTps ?? tokPerSec(m)
    const hasTokens =
      m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens > 0
    const hasTail = hasTokens || speed !== null

    // Plain strings, used only to choose a layout that fits.
    const tokenPlain = hasTokens
      ? `↑ ${fmt(m.inputTokens)}  ↓ ${fmt(m.outputTokens)}  cache ${fmt(
          m.cacheReadTokens,
        )}${rate === null ? '' : ` ${rate}%`}`
      : ''
    const speedPlain = speed === null ? '' : `${fmtSpeed(speed)} t/s`
    const tail = [tokenPlain, speedPlain].filter(Boolean).join('  ')
    const head = [model, effort, `ctx ${ctxPct}`].join('  ')

    type Layout = { rows: number }
    const candidates: Layout[] = tail
      ? [{ rows: 1 }, { rows: 2 }]
      : [{ rows: 1 }]

    const fits = (layout: Layout): boolean => {
      if (layout.rows > e.props.maxRows) return false
      if (head.length > e.props.bodyColumns) return false
      return layout.rows === 1
        ? head.length + (tail ? 2 + tail.length : 0) <= e.props.bodyColumns
        : tail.length === 0 || tail.length <= e.props.bodyColumns
    }

    const chosen =
      candidates.find(fits) ??
      candidates.filter(layout => layout.rows <= e.props.maxRows).pop() ??
      candidates[0]!

    const headerNode = (
      <Box flexDirection="row" columnGap={2}>
        <Text bold {...tone('#4C9AFF')}>
          {model}
        </Text>
        <Text bold {...tone('#4C9AFF')}>
          {effort}
        </Text>
        <Box flexDirection="row" columnGap={0}>
          <Text {...tone('text')}>ctx </Text>
          <Text tabular {...tone('warning')}>
            {ctxPct}
          </Text>
        </Box>
      </Box>
    )

    const tailNode = (
      <Box flexDirection="row" columnGap={2}>
        {hasTokens ? (
          <Box flexDirection="row" columnGap={2}>
            <Box flexDirection="row" columnGap={0}>
              <Text dimColor>↑ </Text>
              <Text tabular {...tone('claude')}>{fmt(m.inputTokens)}</Text>
            </Box>
            <Box flexDirection="row" columnGap={0}>
              <Text dimColor>↓ </Text>
              <Text tabular {...tone('success')}>{fmt(m.outputTokens)}</Text>
            </Box>
            <Box flexDirection="row" columnGap={0}>
              <Text tabular {...tone('text')}>{`cache ${fmt(m.cacheReadTokens)}`}</Text>
              {rate === null ? null : (
                <Text tabular {...tone('warning')}>{` ${rate}%`}</Text>
              )}
            </Box>
          </Box>
        ) : null}
        {speed === null ? null : (
          <Text tabular {...tone('success')}>{`${fmtSpeed(speed)} t/s`}</Text>
        )}
      </Box>
    )

    if (chosen.rows === 1) {
      return (
        <Box
          flexDirection="row"
          columnGap={2}
          flexGrow={1}
          alignItems="flex-end"
          width={e.props.bodyColumns}
          overflow="hidden"
        >
          {headerNode}
          {hasTail ? tailNode : null}
        </Box>
      )
    }

    return (
      <Box
        flexDirection="column"
        flexGrow={1}
        justifyContent="flex-end"
        width={e.props.bodyColumns}
        overflow="hidden"
      >
        {headerNode}
        {hasTail ? tailNode : null}
      </Box>
    )
  })
}
