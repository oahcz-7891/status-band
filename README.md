# status-band

**English** | [中文](README.zh-CN.md)

A Claude Code **Mod** that draws a live status band above the prompt, running
inside the Claude Code process. Its only host process is a one-shot tail read
when a resumed transcript is over the plugin's 4 MiB read cap.

```
Opus 5.5  high  ctx 42%  ↑ 1.2k  ↓ 4.5k  cache 98.2k 87%  42 t/s
```

## Fields

| Segment | Meaning |
| --- | --- |
| `Opus 5.5` | current model, as `/model` shows it |
| `high` | reasoning effort: the current step's, else the model's configured level |
| `ctx 42%` | live context-window usage |
| `↑ 1.2k` | cumulative uncached input tokens this session |
| `↓ 4.5k` | cumulative output tokens this session |
| `cache 98.2k 87%` | cumulative cache-read tokens and cache hit rate |
| `42 t/s` | main-thread output tokens ÷ main-thread generation time |

## Commands

`/band` opens an inline picker just above the prompt (like `/effort`'s menu) and
takes the keyboard: `↑↓` + `Enter` or `1`/`2`/`3` pick, `Esc` or a second `/band`
closes.

```
Status band
1  Color  (current)
2  Grey
3  Hidden
```

Headless equivalents: `/band show`, `/band hide`, `/band color`, `/band gray`.
The choice is persisted to the plugin's `$.store` and restored next session;
`/clear` resets counters but not the display preference. Where no UI surface
exists (`-p`), `$.ui.open` reports why and the state is left alone.

## Colors

Both schemes use theme keys, so they follow dark/light.

- **Color** (default): `ctx` and cache hit rate in `warning`, `↑` in `claude`,
  `↓` and `t/s` in `success`, `cache` label/value in `text`; model and effort
  in bold `#4C9AFF`.
- **Grey**: every segment in `text` + `dimColor`, model/effort stay bold.

The arrows are dimmed. On a narrow band the header keeps `model effort ctx` and
the counters fold onto a second row.

## Counters

Counters accumulate across every model request the mod observes — main-thread
steps, subagents, `/compact`, and `$.model.complete` / `$.model.fork` — and reset
on `/clear`. On `/resume` they are seeded from the transcript's last `cost-state`
row, the same session ledger `/usage` restores, so the three token segments keep
matching `/usage`. A transcript over the 4 MiB plugin-read cap is read from its
tail by one host command — `Get-Content -Tail` through PowerShell on Windows,
`tail -n` elsewhere — and the last matching row there seeds the counters. If
the read and that tail both fail, they stay at zero and a delayed notice is
logged. Context % is always live. `t/s` times main-thread responses only, first
chunk to end (TTFT excluded; responses under 0.25 s skipped); while a
response streams it shows that response's estimate (4 chars/token, repainted at
most every 250 ms), then the session average.

Effort comes from three sources in arrival order: the configured
`modelSettings.<model>.effortLevel` (or `CLAUDE_CODE_EFFORT_LEVEL`) at session
start; `/effort`, read from the command output row it appends (the terminal's
effort dialog puts its answer there); then each request's step, which wins.

## Files

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             names the hooks module
hooks/register.tsx           the mod
types/index.d.ts             PluginState contract
tsconfig.json                type-check config
```
