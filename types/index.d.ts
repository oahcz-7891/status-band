export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

export type BandMetrics = {
  model: string | null
  effort: Effort | null
  // Hidden: the level the settings last gave for this model, so a settings
  // read that changes nothing does not overwrite a live step or `/effort`
  // value, and one that does change it shows at once.
  settingEffort: Effort | null

  // The engine's live context window; tokens/percent are absent until the
  // first response of the live window (fresh session, or just after compact).
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null

  // Cumulative over every model request this process observed: main-thread
  // turn steps, subagents, compaction summaries, `$.model.complete` and
  // `$.model.fork` calls. Reset on /clear. On /resume, seeded from the
  // transcript's cost-state ledger, the totals `/usage` restores.
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number

  // Hidden: what the t/s figure divides. Main-thread responses only, tokens
  // and time of each response from its first output chunk to its end, so time
  // to first token is left out. Responses under 0.25s are not counted.
  speedTokens: number
  speedMs: number

  // While a response streams: its estimated tokens per second so far, from
  // the text and thinking chunks at four characters per token. Null when no
  // response is streaming, so the session average shows.
  liveTps: number | null
}

export type BandScheme = 'color' | 'gray'

// The person's display preference, kept apart from the metrics so /clear and
// a session end never reset it.
export type BandView = {
  visible: boolean
  scheme: BandScheme
}

declare module 'claude-code' {
  interface PluginState {
    'status-band': {
      band: Shaped<BandMetrics>
      view: Shaped<BandView>
    }
  }
}
