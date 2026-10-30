# status-band

[English](README.md) | **中文**

一个 Claude Code **Mod**：在输入框上方绘制实时状态条，运行在 Claude Code 进程内。
唯一会启动的宿主进程，是在恢复的 transcript 超过插件 4 MiB 读取上限时，一次性读取文件尾部。

```
Opus 5.5  high  ctx 42%  ↑ 1.2k  ↓ 4.5k  cache 98.2k 87%  42 t/s
```

## 字段

| 片段 | 含义 |
| --- | --- |
| `Opus 5.5` | 当前模型，与 `/model` 显示一致 |
| `high` | 推理强度：优先取当前步骤的，否则取模型配置的等级 |
| `ctx 42%` | 当前上下文窗口占用（实时） |
| `↑ 1.2k` | 本会话累计未命中缓存的输入 token |
| `↓ 4.5k` | 本会话累计输出 token |
| `cache 98.2k 87%` | 累计缓存读取 token 与缓存命中率 |
| `42 t/s` | 主线程输出 token ÷ 主线程生成耗时 |

## 命令

`/band` 在输入框上方打开一个内联选择器（类似 `/effort` 的菜单）并接管键盘：
`↑↓` + `Enter` 或直接按 `1`/`2`/`3` 选择，`Esc` 或再次 `/band` 关闭。

```
Status band
1  Color  (current)
2  Grey
3  Hidden
```

无界面时可用：`/band show`、`/band hide`、`/band color`、`/band gray`。
选择（可见性与配色）写入插件的 `$.store`，下次会话自动恢复；`/clear` 只清计数，
不清显示偏好。没有可用 UI 时（如 `-p`），`$.ui.open` 会报告原因，状态保持不变。

## 配色

两套配色都基于主题键，随深色/浅色主题变化。

- **Color（默认）**：`ctx` 与缓存命中率用 `warning`，`↑` 用 `claude`，`↓` 与
  `t/s` 用 `success`，`cache` 标签与数值用 `text`；模型与强度为加粗 `#4C9AFF`。
- **Grey**：所有片段用 `text` + `dimColor`，模型与强度保持加粗。

两个箭头做了淡化处理。状态条较窄时，首行保留 `model effort ctx`，计数折到第二行。

## 计数口径

计数累计该 Mod 观察到的所有模型请求 —— 主线程步骤、子代理、`/compact`，以及
`$.model.complete` / `$.model.fork` —— 并在 `/clear` 时归零。`/resume` 时，三条
token 会先用 transcript 最后一条 `cost-state`（即 `/usage` 恢复的会话账本）做基数，
再继续累计，从而与 `/usage` 保持一致。整份文件读不了时（最常见是超过插件 4 MiB
读取上限），会用一条宿主命令读取末尾（Windows 为 PowerShell 的 `Get-Content -Tail`，
其他平台为 `tail -n`），并用末尾最后一条匹配记录做基数；只有连它也取不到时，才从 0
开始并输出一条提示。上下文百分比始终是
实时值。`t/s` 只统计主线程响应，从第一个输出块到结束（不含首 token 延迟；短于
0.25 秒的响应跳过）；流式过程中显示当前响应的估算值（每 token 按 4 字符，最多每
250 ms 重绘一次），结束后显示会话平均值。

推理强度按落地顺序取三个来源：会话开始时配置的
`modelSettings.<model>.effortLevel`（或 `CLAUDE_CODE_EFFORT_LEVEL`）；从 `/effort`
追加的命令输出行中读取（终端的 `/effort` 是对话框，答案落在该行里）；随后每个
请求的步骤值，后者优先。

## 文件

```
.claude-plugin/plugin.json   插件清单
hooks/hooks.json             指定 hooks 模块
hooks/register.tsx           Mod 实现
types/index.d.ts             PluginState 类型契约
tsconfig.json                类型检查配置
```
