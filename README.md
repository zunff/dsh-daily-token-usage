# Daily token usage

Reports provider-reported token usage per local calendar day, folded straight from the durable session logs. It calls no usage or billing endpoint and keeps no separate ledger.

## What it reads

Every model settlement in a session log already carries the usage the provider — or the gateway in front of it — returned: `assistant/message` carries `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`, while a failed or retried attempt keeps its last usage sample in `assistant/attempt`. The report folds those samples into the local day of each event's timestamp, so the numbers are the same whatever base URL or unified proxy produced them, official or internal.

The same pass over a log builds the request flow: each settlement becomes one row, attributed to the `provider`/`model` named on the committed message (or the turn's latest `request/context` for an attempt), timed from the step's `step/start` to the settlement, with the first streamed chunk as its first-token latency.

## How to read it

- **Left sidebar**: a `用量` row sits with the other panels (`插件`, `自动化任务`) and opens a full-width page: today's headline, cache-hit rate and estimate, a composition bar with the uncached/cache-read/output split, a trend card with `每日` / `今日` tabs, and the recent request flow. The page refreshes itself every minute and carries a `刷新` button.
- **`每日`** stacks the last 7 / 14 / 30 days of tokens. **`今日`** is the same chart one day wide: 24 hourly columns, each hour's peak or off-peak tariff painted behind it, and a thin row of request counts under the bars, because an hour that burns tokens in one long call is not the same hour as one that burns them in twenty short ones.
- **One-line footer**: totals and the way into `单价…`, which edits each route's price in the page instead of in a JSON file.
- Type `/usage` in any conversation. An optional number selects the window: `/usage 30`.
- Or ask an agent to report usage; the `token_usage` tool returns the same text and accepts `days`.

The Web surfaces read a loopback JSON route served by the host half, `GET /daily-token-usage/report?days=N`, and write prices through `POST /daily-token-usage/prices`.

## The page

The client half is compiled, not hand-written: React + Tailwind CSS with vendored shadcn-style
primitives (`src/components/ui`), built by Vite into `dist/client.js` — a single module that
registers the lazy factory the Web client asks for.

```
src/main.jsx      registers the page and sidebar row, injects the stylesheet
src/page.jsx      layout: summary, chart card, request card, one-line footer
src/price-panel.jsx  the price editor: one row per route seen, plus the fallback
src/chart.jsx     measured-width stacked bars with a hover tooltip
src/requests-table.jsx  one row per settlement
src/styles.css    Tailwind utilities mapped onto the host's --dsw-* tokens
```

The stylesheet carries no Tailwind preflight: this bundle is injected into a live app, so a
global reset would repaint everything around the page. Every color comes from host tokens, so
light and dark themes follow without a second palette.

```bash
pnpm install
pnpm build      # writes dist/client.js
pnpm test       # host fold/pricing + the rendered client
pnpm preview    # standalone preview.html for a headless browser
```

`dist/client.js` is committed: the profile links this directory, so the host serves whatever is
built here. Rebuild and reload the GUI page after changing `src/`; a change to `index.js` is the
host half and needs a DSH restart before the page's writes or the new report fields exist.

The footer is one line: totals, a warning when a route has no price, and `单价…`. The price list
and the input-shape caveat used to sit there as a paragraph that grew with every model; they
now live in the panel, which is also where they can be changed.

## Model names versus routed ids

A settlement records the id DSH routed by, and a profile can point that id at any upstream model:
the catalog in this machine's patch calls `ds/deepseek-flash` by the name
`bp-DeepSeek-V4.1-Flash`. A usage page that only showed the routed id would force the reader to
translate. So the report asks the `llm` service for each provider's catalog (`listModels`) and
adds `displayName` to every request row and route, and the page shows that name with the
provider, keeping the routed id in the tooltip. The lookup is cached for five minutes, capped at
three seconds, and failure is silent: no catalog simply means ids are shown.

Prices never use the display name. Keying stays on `provider/model` as recorded, so renaming a
model in the catalog cannot change an estimate.

## Reading a day

The composition bar under the headline splits the day's tokens into cache reads, uncached input,
and output. On a cache-heavy day that split hides where the money goes — 99% of the tokens can be
half the cost, and output can be a third of it while being a rounding error of the token count —
so the `token / 费用` switch re-renders the same bar and legend priced instead of counted. Both
readings come from the report itself (`costParts` per bucket), so the two views cannot drift.

`现在高峰 ×1` / `现在空闲 ×0.5` states the billing period a request would be priced at right now,
and a row's `费用` tooltip says which side of the boundary that settlement fell on. The day's
estimate then adds up to something a reader can check. Chinese statutory holidays are not
special-cased, so a holiday weekday is estimated at peak.

The trend card keeps a request count beside every token figure — in the header, in each tooltip,
and as its own strip under the hourly bars. A day can be expensive in a few long calls or cheap in
many short ones, and a token-only page cannot tell those apart.

The hourly view paints the tariff behind the bars: peak hours (Beijing weekdays 09:00–12:00 and
14:00–18:00) in the warning tint, the rest in a cool grey, both derived from host theme tokens so
dark mode follows. Cache reads are the cheap bulk of almost every day, so their band is a light
tint and the paid bands are the vivid ones: a chart that is 97% one saturated colour cannot be
read at all.

Only failures are marked in the request table: a column of identical `成功` cells spends width and
says nothing.

The report answers in its first line, which is what a collapsed command card shows:

```
今日 21.4M tok · 169 次结算 · 缓存命中 96.5%
未缓存输入 575,220 · 缓存读取 20,644,352 · 缓存写入 0 · 输出 166,600
合计含缓存读写，按 token 计费口径统计，非账单金额
```

Below it, the trailing window lists each day with usage and collapses runs of empty days into one range line, followed by the window total and the all-time total since the first recorded day. The report text is Chinese; the plugin metadata carries English and Chinese descriptions.

## Request flow

Under the chart, the page lists the newest settlements, one row per settlement, newest first:

| Column | Meaning |
|---|---|
| 时间 | Settlement time (`HH:MM:SS`, or `MM-DD HH:MM` for older days); hover shows the request's start |
| 状态 | `成功` for a committed message, `失败` for an attempt that settled without one |
| 模型 | The model as the profile's catalog names it (`bp-DeepSeek-V4.1-Flash`), with the provider beside it and the routed id in the tooltip |
| 未缓存输入 / 缓存读取 / 输出 | Provider-reported token counts for that one settlement |
| 费用 | The same list price and peak/off-peak factor applied to that settlement |
| 首字 | First streamed chunk minus the request's start; `—` when nothing was streamed |
| 耗时 | Settlement time minus the request's start |

The table holds the newest 50 settlements across all stored sessions and scrolls inside its own box, so the page stays a single screen. Hovering a numeric cell shows the exact token count, and the header line reports when the last refresh finished. A request starts at its step's `step/start`, or at the end of the previous attempt when a step retried, so one request's latency never includes the attempt before it.

## Cost and freshness

Nothing is accumulated in the background. A report lists the stored sessions and folds each log whose revision changed since the previous report, then caches the per-day buckets in memory:

- The first report after a start folds every stored session once. Subsequent reports re-read only sessions that changed, so a report costs one log read per active session.
- Numbers describe committed log events, so a settlement still in the persistence write buffer can trail the conversation by a moment; the next report picks it up.
- Re-folding from the log instead of accumulating deltas is what makes replay, resumed sessions, and forks exact: a session's figure never depends on how many reports ran before it.

## Input shape: disjoint counts or a prompt total

DSH's usage contract is disjoint — `inputTokens` is the uncached input and the cached part is reported beside it — and the report relies on that. A gateway in front of the API can break it: it leaves the whole prompt in `input_tokens` while also reporting the cached part, so the prompt is counted twice and its cached bulk is billed at the miss price.

The report detects that per route from the settlements themselves. A route that reports a prompt total never lets a cached read exceed the reported input, and its cached read swallows nearly all of it (≥95% in every settlement); a route that reports disjoint counts shows the opposite — cached reads routinely exceed the uncached input. So:

- **Disjoint** (official DeepSeek): left as recorded.
- **Prompt total** (such routes are named in the report's `输入口径` line): the cached share is peeled out, `未缓存输入 = 输入 − 缓存命中`, and the day totals, chart, request rows and prices all use the peeled counts.

The newest settlements of a route decide its reading, so switching a gateway's format takes effect as soon as two settlements agree; one cached read above the reported input already proves the disjoint contract. A row that proves disjoint is never rewritten, even when its route is currently read as a prompt total, so a route that changed format keeps both halves of its history readable.

Pin or override the reading in `prices.json` when the inference is not what you want:

```json
"prompt": {
  "default": "auto",
  "models": { "deepseek-official/test": "total", "deepseek-official/ds/deepseek-flash": "disjoint" }
}
```

`default` is `auto`; a per-route entry wins over it. A pinned `total` route with a cached read larger than its input clamps the cached read to the input and leaves the uncached share at zero.

## Price estimate


Costs come from DeepSeek's published list prices (CNY per million tokens, read on 2026-11-25 from `https://api-docs.deepseek.com/zh-cn/quick_start/pricing`):

| Model | Cache hit input | Cache miss input | Output |
|---|---|---|---|
| `deepseek-flash` | 0.04 | 2 | 8 |
| `deepseek-v4-pro` | 0.30 | 9 | 27 |

Peak hours (Beijing time, Monday–Friday 09:00–12:00 and 14:00–18:00) bill at these prices; every other hour bills at half. Cache writes are not billed separately. Chinese statutory holidays are not special-cased, so those days are estimated at peak price.

Each settlement is attributed to the route the committed message itself names (`message.source.provider`/`model`), falling back to the latest `request/context` in that session when the message carries none — as a failed attempt does. A proxy that renames the model still resolves: the lookup tries the exact `provider/model`, the recorded model id, its canonical family (`*flash*` → `deepseek-flash`, `*pro*` → `deepseek-v4-pro`, after stripping a `bp-`/`ds/` prefix), the id's last segment, and finally `*`.

Overrides live in `<DSH_HOME>/storages/daily-token-usage/prices.json`, written on first report with the routes this profile actually used:

```json
{
  "currency": "¥",
  "unit": 1000000,
  "models": {
    "deepseek-flash": { "input": 2, "cacheRead": 0.04, "cacheWrite": 0, "output": 8 },
    "*": { "input": 2, "cacheRead": 0.04, "cacheWrite": 0, "output": 8 }
  }
}
```

The page edits the same file: `单价…` in the footer lists every route the profile has used, plus
the `*` fallback, with the price in force and its usage. A row shows whether its price is set on
that route, inherited from a family or `*`, or missing entirely; only edited rows are written, so
opening and closing the panel cannot rewrite a hand-maintained file. `恢复官网价` deletes every
override and returns to the shipped table. Edits apply on the next report; no reload.

The unit column is what `unit` says: list prices are per million tokens, so a figure of `2` means
¥2 per million. The panel warns about a route it cannot price, because an unpriced route is
counted at zero and would make the day's estimate too low rather than obviously wrong.

The estimate is a usage-times-price calculation, not a bill — routing, discounts, and provider-side
rounding are not modelled.

## Units

Token counts use Chinese scale (`8,412` / `45.3万` / `6899万` / `1.24亿`) with an explicit `tok` unit, and money shows the configured currency. Exact per-day figures stay in the chart tooltip.

## Limits

- Only provider-reported usage is counted. A route whose adapter reports no usage contributes nothing; the report does not estimate tokens.
- A settlement counts on the local day it ended, so a turn crossing midnight lands on its end date.
- A "结算" is one recorded settlement: a step that committed an assistant message, or an attempt that reported usage. Retries therefore add settlements.
- Totals include cache reads and writes, which are usually the bulk of the token count but are not billed at the uncached input price. The figure is a usage count, not a billing amount.
- Counters are profile-global; there is no per-model, per-workspace, or per-gateway split yet.
- The request flow keeps the newest 50 settlements of each session — exactly enough to rebuild the newest 50 overall — so it is a live tail, not an archive.
- The input-shape inference needs at least two agreeing settlements, and it reads a route's newest ones first; a route that sits near a 50% hit rate is ambiguous, so pin it in `prices.json`. A route that switched from prompt totals to disjoint counts keeps its old rows only as they were recorded — prefer a new model id per format, or pin the shape.
- A first-token latency exists only for a streamed response; a buffered settlement shows `—`.
- A failed attempt appears only when it reported usage; an attempt that never reached the provider carries no usage and no row.
- A fork's inherited prefix belongs to its parent, so the child folds only its own events; the parent session must still exist in storage to be counted.
- At most 500 stored sessions are folded per report.
- The chart route answers any `GET` on the loopback listener without credentials, so any local process that can reach the GUI port can read the aggregate. It exposes no prompt or message content. The price route is the only writer: it takes `POST` with `application/json` from a `same-origin` page only, bounds the body and every number, and can only rewrite `prices.json`.
- After installing or changing the bundle, reload the GUI page once so the client half is picked up; a change under `src/` needs `pnpm build` first, because the host serves `dist/client.js`.
