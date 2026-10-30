# pi-dragon-tui 的 tok/s（TPS）计算逻辑

> 源码位置：`D:/other project/pi-dragon-tui/index.ts`
> 本文所有 `index.ts:NNN` 均为该文件的行号。

TPS 是一套「分段计时 + 会话累计」的实现，与 status-band 那种纯累计口径不同。

---

## 1. 核心公式

| 状态 | 显示值 |
| --- | --- |
| 生成中（流式） | `tokens(当前这条消息的累计数) / 从第一个 delta 到现在的秒数` |
| 停下后（消息结束 / 整轮结束） | `tpsSumTokens / tpsSumSeconds`（整个会话的平均速度） |

即：**流式阶段看单条消息的平均速度，停下后切成会话加权平均速度。**

---

## 2. token 数怎么来

`countOutputTokens()` — `index.ts:348`

1. 优先使用 `message.usage.output`（已包含 reasoning / thinking token），只要 `> 0` 就用它；
2. provider 在流式途中还没上报 usage 时，退化为估算：
   `(text 字符数 + thinking 字符数) / 4`，四舍五入取整。

注意事项：

- 流式阶段常常是 ÷4 粗估，`message_end` 拿到真实 usage 后才换成精确值，因此数值会有一点跳变。
- `toolcall_delta` 也会触发刷新，但估算分支不统计 toolCall 参数，所以「纯工具调用」期间可能算出 0 而不显示。

---

## 3. 时间怎么算

- 计时起点 `tpsStartMs` 在**第一个** `text_delta / thinking_delta / toolcall_delta` 到达时打点（`index.ts:1212`）
  → **TTFT（首 token 延迟）不计入**。
- 计时终点是 `message_end`（`index.ts:1230`）的 `Date.now()`。
- 每条 assistant 消息各自计时：`turn_start`（`index.ts:1197`）与 `message_end` 都会把 `tpsStartMs` 置空，
  所以一条消息里的工具调用 / 等工具不会串到下一条消息的生成时间里。
  本质上是「纯生成时段」的累加，而不是墙钟时间。
- 同一条消息内部的网络卡顿、provider 停顿仍然算在分母里。

---

## 4. 刷新节流与显示门槛

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `TPS_REFRESH_MS` | `250`（`index.ts:159`） | delta 再密也只 250ms 重绘一次 |
| `TPS_MIN_SECONDS` | `0.25`（`index.ts:161`） | 开头 0.25 秒内不报数，避免样本太少导致数字乱跳 |
| — | `tokens <= 0` | 直接跳过，不更新显示 |

---

## 5. 累计与清空

| 事件 | 行为 |
| --- | --- |
| `message_end`（`index.ts:1225`） | `tpsSumTokens += tokens; tpsSumSeconds += seconds`，随后立即显示会话平均值 |
| `agent_end`（`index.ts:1240`） | 再写一次平均值，兜住中途 abort / 没有 `message_end` 的情况 |
| `turn_start`（`index.ts:1197`） | 只重置**本条消息**的计时器，不清空显示；会话累计值继续保留，空闲时仍能看到上次的平均值 |
| `session_start`（`index.ts:1244`） | 累计值与显示一起清掉（新会话 / 切会话） |
| 切换配色 | `repaintTpsStatus`（`index.ts:1184`）用缓存值重画，不用等下一条消息才变色 |

---

## 6. 显示格式

```ts
ctx.ui.setStatus("dragon-tps", border.paint(`${TPS_PREFIX}${formatTps(v)}${TPS_SUFFIX}`));
```

- 渲染成一行主题色文字：`48.2 tok/s`
- 颜色与边框同源（`border.paint`），`/dragon` 换色后同步
- 走 `ctx.ui.setStatus()`，占扩展状态那一行，不改动原生 footer
- `TPS_PREFIX`（`index.ts:156`）默认空字符串，`TPS_SUFFIX`（`index.ts:157`）默认 `" tok/s"`

`formatTps()` — `index.ts:338`

- 非有限值或 `<= 0` → `"0.0"`
- `>= 100` → 取整（省得数字乱跳）
- 其余 → 保留一位小数

---

## 7. 一句话总结

**流式阶段是「本条消息的累计平均速度」（扣掉 TTFT），停下后切成「整个会话的加权平均速度」；工具等待与首 token 延迟都不进分母。**

---

## 附：相关配置开关

```ts
const TPS_ENABLED = true;   // index.ts:154  不想要就设 false
const TPS_PREFIX = "";      // index.ts:156  数字前缀，例如 "⚡ "
const TPS_SUFFIX = " tok/s"; // index.ts:157
const TPS_REFRESH_MS = 250; // index.ts:159
const TPS_MIN_SECONDS = 0.25; // index.ts:161
const TPS_KEY = "dragon-tps"; // index.ts:163  setStatus 的 key，传 undefined 清空
```
