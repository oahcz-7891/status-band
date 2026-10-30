import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'status-band',
  component: 'AbovePrompt',
  requestId: 'status-band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 2,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 2 },
    view: {},
  },
} as const

test('draws the model, effort and context percentage', async ($, on) => {
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      rateLimits: [],
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('state.get', () => ({
    value: {
      value: {
        shape: 'band-tps-2',
        value: {
          model: 'Opus 5.5',
          effort: 'high',
          settingEffort: 'high',
          contextTokens: 84_000,
          contextWindow: 200_000,
          contextPercent: 42,
          inputTokens: 1_234,
          outputTokens: 4_567,
          cacheReadTokens: 98_200,
          cacheCreationTokens: 500,
          speedTokens: 4_567,
          speedMs: 108_000,
          liveTps: null,
        },
      },
      version: 1,
    },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Opus 5\.5/ }))?.text).toBe(
    'Opus 5.5',
  )
  const effort = await ui.find({ type: 'Text', text: 'high' })
  expect(effort?.props).toMatchObject({ bold: true, color: '#4C9AFF' })
  expect((await ui.find({ type: 'Text', text: /42%/ }))?.text).toBe('42%')
  expect((await ui.find({ type: 'Text', text: /1\.2k/ }))?.text).toBe('1.2k')
  expect((await ui.find({ type: 'Text', text: /42 t\/s/ }))?.text).toBe('42 t/s')
  await ui.unmount()
})

test('folds to two rows on a narrow band', async ($, on) => {
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      rateLimits: [],
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('state.get', () => ({
    value: {
      value: {
        shape: 'band-tps-2',
        value: {
          model: 'Opus 5.5',
          effort: 'high',
          settingEffort: 'high',
          contextTokens: 84_000,
          contextWindow: 200_000,
          contextPercent: 42,
          inputTokens: 1_234,
          outputTokens: 4_567,
          cacheReadTokens: 98_200,
          cacheCreationTokens: 500,
          speedTokens: 4_567,
          speedMs: 108_000,
          liveTps: null,
        },
      },
      version: 1,
    },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, bodyColumns: 40 },
  })
  expect((await ui.find({ type: 'Text', text: /Opus 5\.5/ }))?.text).toBe(
    'Opus 5.5',
  )
  expect((await ui.find({ type: 'Text', text: /1\.2k/ }))?.text).toBe('1.2k')
  await ui.unmount()
})

test('shows the settings effort before a request names one', async ($, on) => {
  on('session.model', () => ({ value: 'deepseek-v4.1-flash[1m]' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000 },
      rateLimits: [],
    },
  }))
  on('settings.read', () => ({
    value: { modelSettings: { 'deepseek-v4.1-flash': { effortLevel: 'high' } } },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'high' }))?.text).toBe('high')
  await ui.unmount()
})

test('counts a subagent turn step', async ($, on) => {
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [],
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'hello' } as const
    return {
      turnId: 't',
      index: 0,
      answer: 'hello',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 11,
        model: 'Opus 5.5',
      },
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  const stream = $.turn.step({
    turnId: 't',
    index: 0,
    model: 'Opus 5.5',
    messageCount: 1,
    agentId: 'agent-1',
  })
  for await (const _ of stream) {
    // The band passes every chunk through.
  }
  await stream.result

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^7$/ }))?.text).toBe('7')
  expect((await ui.find({ type: 'Text', text: /^3$/ }))?.text).toBe('3')
  expect((await ui.find({ type: 'Text', text: /^cache 50$/ }))?.text).toBe(
    'cache 50',
  )
  await ui.unmount()
})

test('counts a compaction summary usage', async ($, on) => {
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [],
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.compact', () => ({
    messages: [{ role: 'user', text: 'summary', toolUses: [] }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  const result = await $.session.compact({
    trigger: 'plugin',
    messages: [{ role: 'user', text: 'summary', toolUses: [] }],
  } as never)
  expect(result.skip).toBeUndefined()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^10$/ }))?.text).toBe('10')
  expect((await ui.find({ type: 'Text', text: /^5$/ }))?.text).toBe('5')
  expect((await ui.find({ type: 'Text', text: /^cache 100$/ }))?.text).toBe(
    'cache 100',
  )
  await ui.unmount()
})

test('follows /effort as soon as it runs', async ($, on) => {
  on('session.model', () => ({ value: 'deepseek-v4.1-flash[1m]' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000 },
      rateLimits: [],
    },
  }))
  on('settings.read', () => ({
    value: { modelSettings: { 'deepseek-v4.1-flash': { effortLevel: 'high' } } },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', { command: 'effort' }, () => ({
    text: 'Set effort level to max (this session only): Maximum capability.',
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'high' }))?.text).toBe('high')
  await ui.unmount()

  await $.command.run({
    command: 'effort',
    args: 'max',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'max' }))?.text).toBe('max')
  await ui.unmount()
})

test("follows the /effort dialog's output row as soon as it is appended", async ($, on) => {
  on('session.model', () => ({ value: 'deepseek-v4.1-flash[1m]' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000 },
      rateLimits: [],
    },
  }))
  on('settings.read', () => ({
    value: { modelSettings: { 'deepseek-v4.1-flash': { effortLevel: 'high' } } },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'high' }))?.text).toBe('high')
  await ui.unmount()

  // What the terminal's local-jsx /effort dialog appends after a pick: the
  // command.run result itself carries no text for that kind.
  await $.session.append({
    message: {
      type: 'user',
      content: [
        {
          type: 'text',
          text: '<local-command-stdout>Set effort level to max (this session only): Maximum capability with deepest reasoning.</local-command-stdout>',
        },
      ],
    },
    door: 'command',
    origin: { kind: 'engine' },
    uuid: 'effort-output',
  })

  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'max' }))?.text).toBe('max')
  await ui.unmount()
})


const METRICS = {
  model: 'Opus 5.5',
  effort: 'high',
  settingEffort: 'high',
  contextTokens: 84_000,
  contextWindow: 200_000,
  contextPercent: 42,
  inputTokens: 1_234,
  outputTokens: 4_567,
  cacheReadTokens: 98_200,
  cacheCreationTokens: 500,
  speedTokens: 4_567,
  speedMs: 108_000,
  liveTps: null,
}

/**
 * The world the /band tests share: a band of metrics, an empty persistent
 * store, and the engine's own drawing for when the plugin steps aside.
 *
 * Only the `band` key is faked; `view` reads the kit's own state store, so a
 * write and the read that follows it see the same version.
 */
function stubBand(on: On): void {
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      rateLimits: [],
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'band' } }))
  on('state.get', ($, e, next) =>
    e.key === 'band'
      ? { value: { value: { shape: 'band-tps-2', value: METRICS }, version: 1 } }
      : next(e),
  )
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })
}

async function runBand(
  $: Engine,
  args: string,
): Promise<string> {
  const result = await $.command.run({
    command: 'band',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  return result.text ?? ''
}

test('/band gray paints every segment in the theme grey', async ($, on) => {
  stubBand(on)
  mock.store(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect(await runBand($, 'gray')).toContain('grey')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const model = await ui.find({ type: 'Text', text: 'Opus 5.5' })
  expect(model?.props).toMatchObject({ bold: true, color: 'text', dimColor: true })

  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.filter(one => one.props.color === '#4C9AFF')).toHaveLength(0)
  expect(texts.filter(one => one.props.color === 'success')).toHaveLength(0)
  await ui.unmount()
})

test('/band hide steps aside, and show brings the grey back', async ($, on) => {
  stubBand(on)
  mock.store(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await runBand($, 'gray')
  await runBand($, 'hide')

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).toEqual([
    'engine band',
  ])
  await ui.unmount()

  await runBand($, 'show')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject(
    { color: 'text', dimColor: true },
  )
  await ui.unmount()
})

test('/band color returns to the four-hue scheme', async ($, on) => {
  stubBand(on)
  mock.store(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await runBand($, 'gray')
  await runBand($, 'color')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject({
    bold: true,
    color: '#4C9AFF',
  })
  await ui.unmount()
})

test('a stored view is restored at session start', async ($, on) => {
  stubBand(on)
  mock.store(on, { view: { visible: true, scheme: 'gray' } })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject(
    { color: 'text', dimColor: true },
  )
  await ui.unmount()
})

test('classic SessionStart restores the stored grey view after /clear', async ($, on) => {
  stubBand(on)
  mock.store(on, { view: { visible: true, scheme: 'gray' } })
  on('classic.SessionStart', () => ({}))

  // /clear, /new and an in-process /resume wipe plugin state and fire no
  // session.start; classic.SessionStart is the new conversation's signal.
  await $.classic.SessionStart({ source: 'clear' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject(
    { color: 'text', dimColor: true },
  )
  await ui.unmount()
})

test('an unknown argument changes nothing and shows the usage', async ($, on) => {
  stubBand(on)
  mock.store(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect(await runBand($, 'purple')).toContain('Usage')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject({
    color: '#4C9AFF',
  })
  await ui.unmount()
})



const PANE = {
  plugin: 'status-band',
  component: 'Pane',
  requestId: 'band-menu',
  props: {
    title: 'Status band',
    isFocused: true,
    bodyColumns: 40,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

/** Answers the pane ops a bare /band reaches, recording what it asked for. */
function stubPanes(
  on: On,
  options: { isPlaced: boolean; reason?: string; isOpen?: boolean } = {
    isPlaced: true,
  },
): { opened: string[]; closed: string[] } {
  const opened: string[] = []
  const closed: string[] = []

  on('ui.panes', () =>
    options.isOpen === false
      ? { value: [] }
      : {
          value: [
            {
              id: 'band-menu',
              title: 'Status band',
              isShown: true,
              isFocused: true,
              isPlaced: true,
            },
          ],
        },
  )
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return options.isPlaced
      ? { value: { isPlaced: true } }
      : { value: { isPlaced: false, reason: options.reason ?? 'no surface' } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })

  return { opened, closed }
}

test('a bare /band opens the picker above the prompt', async ($, on) => {
  stubBand(on)
  mock.store(on)
  const { opened } = stubPanes(on, { isPlaced: true, isOpen: false })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  const result = await runBand($, '')

  expect(opened).toEqual(['band-menu'])
  expect(result).toContain('picker opened')
})

test('a picker row sets the view and closes the picker', async ($, on) => {
  stubBand(on)
  mock.store(on)
  const { closed } = stubPanes(on, { isPlaced: true, isOpen: false })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await runBand($, '')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'gray' })).toBeDefined()
  await ui.press({ key: 'gray' })
  await ui.unmount()

  expect(closed).toEqual(['band-menu'])

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject({
    color: 'text',
    dimColor: true,
  })
  await band.unmount()
})

test('the picker marks the current choice and focuses it', async ($, on) => {
  stubBand(on)
  mock.store(on)
  stubPanes(on, { isPlaced: true, isOpen: false })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await runBand($, 'gray')
  await runBand($, '')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'gray' }))?.props).toMatchObject({
    dimColor: false,
    autoFocus: true,
  })
  expect((await ui.find({ type: 'Button', key: 'color' }))?.props).toMatchObject({
    dimColor: true,
  })
  await ui.unmount()
})

test('a second bare /band closes the open picker', async ($, on) => {
  stubBand(on)
  mock.store(on)
  const { closed } = stubPanes(on, { isPlaced: true, isOpen: true })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect(await runBand($, '')).toContain('closed')
  expect(closed).toEqual(['band-menu'])
})

test('the picker reports a surface that cannot place it', async ($, on) => {
  stubBand(on)
  mock.store(on)
  stubPanes(on, { isPlaced: false, reason: 'no surface attached', isOpen: false })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  const result = await runBand($, '')

  expect(result).toContain('no surface attached')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject({
    color: '#4C9AFF',
  })
  await ui.unmount()
})
