/**
 * Daily token usage — reports provider-reported token usage folded per local
 * calendar day, plus a DeepSeek-list-price estimate, from the durable session logs.
 *
 * There is no accumulator to keep in sync: a report folds each stored session's
 * log once per revision and caches the per-day buckets, so replayed history,
 * live appends, and fork-inherited prefixes cannot be counted twice or skipped.
 * The fold mirrors `dsh-token-meter`: `assistant/message` carries the step's
 * usage, a failed or retried attempt keeps its last usage sample in its stream,
 * and a fork parent's inherited prefix is skipped. Each settlement is attributed
 * to the route the committed message names (or the turn's latest
 * `request/context`), split by DeepSeek's peak/off-peak window so the estimate
 * can price it, and kept as one request-flow row with its own start, first-token
 * latency, and duration.
 *
 * @module @local/daily-token-usage
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const DEFAULT_REPORT_DAYS = 7
const MAX_REPORT_DAYS = 365
/** Upper bound on sessions folded by one refresh, to keep a report bounded. */
const MAX_SESSIONS = 500
/** Request rows published by one report, newest first. */
const MAX_REPORT_REQUESTS = 50
/**
 * Per-session tail kept for the flow table. Keeping as many as the report
 * publishes is enough to rebuild the global newest rows exactly, while a
 * long session cannot grow the cache without bound.
 */
const MAX_SESSION_REQUESTS = MAX_REPORT_REQUESTS
const DEFAULT_UNIT = 1_000_000
const DEFAULT_CURRENCY = '¥'
/** Off-peak calls bill at half the list price. */
const OFF_PEAK_FACTOR = 0.5
/** Bounds on one price edit from the Web page, so a bad body cannot bloat the file. */
const MAX_PRICE_KEYS = 200
const MAX_PRICE_KEY_LENGTH = 200
const MAX_PRICE_BODY = 64 * 1024
/** Per-token ceiling accepted from the Web editor; above any real list price. */
const MAX_PRICE = 1_000_000
const PRICE_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output']
/** Shipped next to the table so the units are explained where the file is edited. */
const PRICE_FILE_NOTE = '每 unit（100 万）个 token 的高峰时段价格，人民币。input=缓存未命中输入，cacheRead=缓存命中输入，cacheWrite=缓存写入，output=输出；空闲时段按 5 折。键可以是 provider/model、模型名，或 "*" 兜底；改完下一次报表生效。'
/** The prompt-shape override shipped in the same note. */
const PRICE_FILE_PROMPT_NOTE = 'prompt.default=auto 表示按记录自动判断输入口径；某个 provider/model 的上报把缓存命中算进了输入时（常见于网关），把它写成 "total"，插件会按「输入 − 缓存命中」折算；写成 "disjoint" 表示输入本来就只是未缓存部分。'

/**
 * DeepSeek list prices in CNY per million tokens, peak time, read from
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing on 2026-11-25:
 *
 *   deepseek-flash      缓存命中 0.04 · 缓存未命中 2 · 输出 8
 *   deepseek-v4-pro     缓存命中 0.30 · 缓存未命中 9 · 输出 27
 *
 * Off-peak calls bill at half these prices. Cache writes are not billed
 * separately. `prices.json` overrides this table per route or model.
 */
const DEFAULT_PRICES = {
  currency: DEFAULT_CURRENCY,
  unit: DEFAULT_UNIT,
  models: {
    'deepseek-flash': { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    'deepseek-v4-pro': { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
    '*': { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
  },
  prompt: { default: 'auto', models: {} },
}

/**
 * How a route reports prompt tokens. DSH's usage contract is disjoint —
 * `inputTokens` is uncached input only — but a gateway can leave the whole
 * prompt in `input_tokens` while reporting the cached part beside it. Then the
 * prompt is counted twice and its cached bulk is billed at the miss price, so
 * the record has to be folded back before it is priced.
 *
 * `auto` infers the shape per route from the recorded settlements, `total`
 * pins "the input already contains the cached part", `disjoint` pins the
 * contract, and a route may be overridden in prices.json.
 */
const PROMPT_SHAPES = ['auto', 'disjoint', 'total']
/** A route is read as a prompt total only above this cached share of input. */
const PROMPT_TOTAL_SHARE = 0.95
/** Settlements needed before a route's shape is inferred. */
const PROMPT_TOTAL_SAMPLES = 2
/** Newest same-shape settlements that confirm a route's shape. */
const PROMPT_SHAPE_RUN = 8

/** Model families recognized in a route's model id, newest name first. */
const MODEL_ALIASES = [
  { pattern: /pro/i, canonical: 'deepseek-v4-pro' },
  { pattern: /flash/i, canonical: 'deepseek-flash' },
]

/** Services this plugin cannot work without. */
export const inject = ['commands', 'tools']

function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  return path.join(homedir(), '.dsh')
}

function dataDir() {
  return path.join(homeDir(), 'storages', 'daily-token-usage')
}

function pricesPath() {
  return path.join(dataDir(), 'prices.json')
}

function emptyCounts() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }
}

function emptyRoute() {
  return { peak: emptyCounts(), off: emptyCounts() }
}

function emptyDay() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0, models: Object.create(null) }
}

function zeroCounts() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0, models: Object.create(null) }
}

/** Local calendar day of an epoch-millisecond timestamp, as `YYYY-MM-DD`. */
function localDay(time) {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * DeepSeek's peak window in Beijing time (UTC+8): Monday through Friday,
 * 09:00–12:00 and 14:00–18:00. Chinese statutory holidays are treated as peak
 * because the plugin carries no holiday calendar; every other hour is off-peak.
 */
function isPeak(time) {
  const beijing = new Date(time + 8 * 3600_000)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** The last usage chunk of one durable assistant stream, if any. */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record !== null && typeof record === 'object' && record.type === 'chunk'
      && record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage') {
      return record.chunk.usage
    }
  }
  return undefined
}

/** Provider-reported usage of one settlement event, mirroring dsh-token-meter. */
function usageOf(event) {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (event.type === 'assistant/message' && data.usage !== undefined && data.usage !== null) return data.usage
  return streamUsage(data.stream)
}

/**
 * Route recorded on the settlement itself. A committed assistant message names
 * the provider and model that produced it, which is more precise than the
 * turn's latest `request/context`; return undefined when it does not.
 */
function routeOfEvent(event) {
  const source = event.data?.message?.source
  if (source === null || typeof source !== 'object') return undefined
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') return undefined
  return routeKey(source.provider, source.model)
}

/**
 * Arrival of the first streamed chunk, i.e. the first token's timestamp. Only
 * records that were actually streamed carry `time`; a buffered response has none.
 */
function firstStreamTime(event) {
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record !== null && typeof record === 'object' && Number.isFinite(record.time)) return record.time
  }
  return undefined
}

function countsFrom(usage) {
  return {
    input: count(usage.inputTokens),
    cacheRead: count(usage.cacheReadTokens),
    cacheWrite: count(usage.cacheWriteTokens),
    output: count(usage.outputTokens),
    requests: 1,
  }
}

function group(value) {
  return String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Chinese-scale count: 8,412 / 45.3万 / 6899万 / 1.24亿. */
function scale(value) {
  const amount = Math.max(0, Math.round(value))
  if (amount < 10_000) return group(amount)
  if (amount < 100_000_000) {
    const wan = amount / 10_000
    return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1).replace(/\.0$/, '')}万`
  }
  const yi = amount / 100_000_000
  return `${yi >= 10 ? Math.round(yi) : yi.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}亿`
}

function tokens(value) {
  return `${scale(value)} tok`
}

function money(value) {
  const amount = Math.abs(value)
  if (amount >= 100) return value.toFixed(0)
  if (amount < 0.0001) return '<0.0001'
  if (amount >= 1) return value.toFixed(2)
  if (amount >= 0.01) return value.toFixed(3)
  return value.toFixed(4)
}

/** Token-weighted cache hit rate over the billed prompt, or null without a prompt. */
function cacheHit(bucket) {
  const prompt = bucket.input + bucket.cacheRead + bucket.cacheWrite
  if (prompt === 0) return null
  return `${(bucket.cacheRead / prompt * 100).toFixed(1)}%`
}

function pad(value, width) {
  return String(value).padStart(width, ' ')
}

function addCounts(target, bucket) {
  target.input += bucket.input
  target.cacheRead += bucket.cacheRead
  target.cacheWrite += bucket.cacheWrite
  target.output += bucket.output
  target.reasoning += bucket.reasoning
  target.requests += bucket.requests
  if (bucket.models !== undefined) {
    for (const [key, entry] of Object.entries(bucket.models)) {
      const slot = target.models[key] ?? (target.models[key] = emptyRoute())
      for (const band of ['peak', 'off']) {
        if (entry[band] === undefined) continue
        slot[band].input += entry[band].input
        slot[band].cacheRead += entry[band].cacheRead
        slot[band].cacheWrite += entry[band].cacheWrite
        slot[band].output += entry[band].output
        slot[band].requests += entry[band].requests
      }
    }
  }
  return target
}

function totalTokens(bucket) {
  return bucket.input + bucket.cacheRead + bucket.cacheWrite + bucket.output
}

/** Route key used by both the fold and the price table: `provider/model`. */
function routeKey(provider, model) {
  return `${provider ?? 'unknown'}/${model ?? 'unknown'}`
}

/** Canonical price key for a model id: strip proxy prefixes, then match a family. */
function canonicalModel(name) {
  const bare = String(name ?? '')
    .toLowerCase()
    .replace(/^bp-/, '')
    .replace(/^ds\//, '')
  for (const alias of MODEL_ALIASES) {
    if (alias.pattern.test(bare)) return alias.canonical
  }
  return bare
}

/**
 * Price table keys one route is looked up under, most specific first: the exact
 * `provider/model`, the recorded model id, its canonical family, the id's last
 * segment, and finally `*`. A proxy that renames `ds/deepseek-flash` still lands
 * on the official flash price.
 */
function priceCandidates(key) {
  const slash = key.indexOf('/')
  const model = slash >= 0 ? key.slice(slash + 1) : key
  const tail = model.slice(model.lastIndexOf('/') + 1)
  return [key, model, canonicalModel(model), tail, canonicalModel(tail), '*']
}

/** The table entry that prices one route, with the key it matched. */
function priceEntry(prices, key) {
  if (prices === undefined) return undefined
  for (const candidate of priceCandidates(key)) {
    if (candidate && prices.models[candidate] !== undefined) {
      return { key: candidate, price: prices.models[candidate] }
    }
  }
  return undefined
}

function priceFor(prices, key) {
  return priceEntry(prices, key)?.price
}

/** A route key the price file can hold: non-empty, bounded, no control characters. */
function validPriceKey(key) {
  return typeof key === 'string'
    && key.length > 0
    && key.length <= MAX_PRICE_KEY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(key)
}

/** One price row from the Web editor, or undefined when any field is not a price. */
function validPrice(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const price = {}
  for (const field of PRICE_FIELDS) {
    const raw = value[field] ?? 0
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > MAX_PRICE) return undefined
    price[field] = raw
  }
  return price
}

function countsCost(counts, price) {
  return counts.input * price.input
    + counts.cacheRead * price.cacheRead
    + counts.cacheWrite * price.cacheWrite
    + counts.output * price.output
}

/** Cost split by billing bucket, so a report can show why the total is what it is. */
function costPartsOf(bucket, prices) {
  if (prices === undefined) return null
  const parts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  let priced = false
  for (const [key, entry] of Object.entries(bucket.models ?? {})) {
    const price = priceFor(prices, key)
    if (price === undefined) continue
    if (price.input + price.cacheRead + price.cacheWrite + price.output === 0) continue
    priced = true
    for (const band of ['peak', 'off']) {
      const factor = band === 'off' ? OFF_PEAK_FACTOR : 1
      const counts = entry[band] ?? emptyCounts()
      parts.input += counts.input * price.input * factor
      parts.cacheRead += counts.cacheRead * price.cacheRead * factor
      parts.cacheWrite += counts.cacheWrite * price.cacheWrite * factor
      parts.output += counts.output * price.output * factor
    }
  }
  if (!priced) return null
  const divide = value => value / prices.unit
  const input = divide(parts.input)
  const cacheRead = divide(parts.cacheRead)
  const cacheWrite = divide(parts.cacheWrite)
  const output = divide(parts.output)
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output }
}

/** Cost of one bucket under the configured table, or null when nothing is priced. */
function costOf(bucket, prices) {
  const parts = costPartsOf(bucket, prices)
  return parts === null ? null : parts.total
}

/**
 * All-time usage of every route the fold saw, priced, heaviest spender first.
 * The Web page uses it both for the price table it is allowed to edit and for
 * the routes it must warn about: one with no resolvable price has no estimate.
 */
function routesOf(allTime, prices) {
  const rows = []
  for (const [key, entry] of Object.entries(allTime.models ?? {})) {
    if (key === 'unknown/unknown') continue
    const counts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }
    for (const band of ['peak', 'off']) {
      const sample = entry[band]
      if (sample === undefined) continue
      for (const field of ['input', 'cacheRead', 'cacheWrite', 'output', 'requests']) {
        counts[field] += sample[field] ?? 0
      }
    }
    const priced = priceEntry(prices, key)
    rows.push({
      key,
      provider: key.slice(0, key.indexOf('/')),
      model: key.slice(key.indexOf('/') + 1),
      ...counts,
      total: counts.input + counts.cacheRead + counts.cacheWrite + counts.output,
      price: priced === undefined ? null : { ...priced.price },
      priceSource: priced === undefined ? null : priced.key,
      cost: costOf({ models: { [key]: entry } }, prices),
    })
  }
  rows.sort((left, right) => (
    (right.cost ?? 0) - (left.cost ?? 0)
    || right.total - left.total
    || left.key.localeCompare(right.key)
  ))
  return rows
}

function normalizePromptShape(parsed) {
  const shape = { default: 'auto', models: {} }
  if (parsed === null || typeof parsed !== 'object') return shape
  if (PROMPT_SHAPES.includes(parsed.default)) shape.default = parsed.default
  const models = parsed.models !== null && typeof parsed.models === 'object' ? parsed.models : {}
  for (const [key, value] of Object.entries(models)) {
    if (value === 'total' || value === 'disjoint') shape.models[key] = value
  }
  return shape
}

function normalizePrices(parsed) {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const models = {}
  const source = parsed.models !== null && typeof parsed.models === 'object' ? parsed.models : {}
  for (const [key, price] of Object.entries(source)) {
    if (price === null || typeof price !== 'object') continue
    models[key] = {
      input: Number.isFinite(price.input) ? price.input : 0,
      cacheRead: Number.isFinite(price.cacheRead) ? price.cacheRead : 0,
      cacheWrite: Number.isFinite(price.cacheWrite) ? price.cacheWrite : 0,
      output: Number.isFinite(price.output) ? price.output : 0,
    }
  }
  return {
    currency: typeof parsed.currency === 'string' && parsed.currency.length > 0 ? parsed.currency : DEFAULT_CURRENCY,
    unit: Number.isFinite(parsed.unit) && parsed.unit > 0 ? parsed.unit : DEFAULT_UNIT,
    models: Object.keys(models).length > 0 ? models : DEFAULT_PRICES.models,
    prompt: normalizePromptShape(parsed.prompt),
  }
}

export function apply(ctx) {
  /** Per-session fold cache: `{ revision, days }`, keyed by session id. */
  const cache = new Map()
  let refreshing = Promise.resolve()
  /** Cached price table with the mtime it was read at, so edits apply on the next report. */
  let priceCache = { mtimeMs: -1, value: undefined }
  /** Route keys discovered so far, used to write the editable price file once. */
  const seenRoutes = new Set()

  async function loadPrices() {
    try {
      const info = await stat(pricesPath())
      if (priceCache.mtimeMs === info.mtimeMs && priceCache.value !== undefined) return priceCache.value
      const parsed = JSON.parse(await readFile(pricesPath(), 'utf8'))
      priceCache = { mtimeMs: info.mtimeMs, value: normalizePrices(parsed) ?? DEFAULT_PRICES }
      return priceCache.value
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[daily-token-usage] ignored unreadable prices.json:', error?.message ?? error)
      }
      return DEFAULT_PRICES
    }
  }

  /** Write an editable price file seeded with the list prices and seen routes. */
  async function ensurePricesFile() {
    try {
      await stat(pricesPath())
      return
    } catch {
      // Missing: create it below.
    }
    if (seenRoutes.size === 0) return
    // Seed with the official families, then bind every route seen so far to the
    // family price it resolves to, so one line per model is all a user edits.
    const models = {}
    for (const [key, price] of Object.entries(DEFAULT_PRICES.models)) {
      models[key] = { ...price }
    }
    for (const key of [...seenRoutes].sort()) {
      const price = priceFor(DEFAULT_PRICES, key)
      models[key] = price === undefined ? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } : { ...price }
    }
    try {
      await mkdir(dataDir(), { recursive: true })
      await writeFile(pricesPath(), `${JSON.stringify({
        currency: DEFAULT_CURRENCY,
        unit: DEFAULT_UNIT,
        source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing（读取于 2026-11-25）',
        note: `${PRICE_FILE_NOTE}${PRICE_FILE_PROMPT_NOTE}`,
        prompt: { default: 'auto', models: {} },
        models,
      }, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn('[daily-token-usage] cannot write prices.json:', error?.message ?? error)
    }
  }

  /** Raw price file, so a write keeps the note, currency, and prompt pins already there. */
  async function readPricesRaw() {
    try {
      return JSON.parse(await readFile(pricesPath(), 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[daily-token-usage] replacing unreadable prices.json:', error?.message ?? error)
      }
      return undefined
    }
  }

  /**
   * Write the price table from the Web page. The route takes JSON from the same
   * origin only, merges `{ models }` (a `null` entry deletes its key), and lets
   * `{ reset: true }` drop every override back to the shipped list prices. The
   * file stays the only state, so an edit survives a restart and a hand edit
   * stays equivalent to one made in the page.
   */
  async function updatePrices(request, jsonResponse) {
    if (request.method !== 'POST') return jsonResponse({ error: '只接受 POST' }, 405)
    // A browser adds `sec-fetch-site`; anything but same-origin is a forged write.
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin') return jsonResponse({ error: '拒绝跨站写入' }, 403)
    const type = String(request.headers.get('content-type') ?? '').toLowerCase()
    if (!type.startsWith('application/json')) return jsonResponse({ error: '需要 application/json' }, 415)
    let body
    try {
      body = await request.text()
    } catch {
      return jsonResponse({ error: '读取请求体失败' }, 400)
    }
    if (body.length > MAX_PRICE_BODY) return jsonResponse({ error: '请求体过大' }, 413)
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      return jsonResponse({ error: 'JSON 无法解析' }, 400)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonResponse({ error: '请求体必须是对象' }, 400)
    }

    const base = await readPricesRaw()
    const models = { ...(base?.models ?? DEFAULT_PRICES.models) }
    if (parsed.reset === true) {
      for (const key of Object.keys(models)) delete models[key]
      Object.assign(models, DEFAULT_PRICES.models)
    }
    if (parsed.models !== undefined) {
      if (parsed.models === null || typeof parsed.models !== 'object' || Array.isArray(parsed.models)) {
        return jsonResponse({ error: 'models 必须是对象' }, 400)
      }
      const keys = Object.keys(parsed.models)
      if (keys.length > MAX_PRICE_KEYS) return jsonResponse({ error: `一次最多修改 ${MAX_PRICE_KEYS} 条` }, 400)
      for (const key of keys) {
        if (!validPriceKey(key)) return jsonResponse({ error: `无效的路由键：${String(key).slice(0, 40)}` }, 400)
        if (parsed.models[key] === null) {
          delete models[key]
          continue
        }
        const price = validPrice(parsed.models[key])
        if (price === undefined) return jsonResponse({ error: `「${key}」的单价必须是 0 到 ${MAX_PRICE} 之间的数字` }, 400)
        models[key] = price
      }
    }
    if (Object.keys(models).length === 0) return jsonResponse({ error: '至少要保留一条单价' }, 400)

    const next = {
      currency: typeof base?.currency === 'string' && base.currency.length > 0 ? base.currency : DEFAULT_CURRENCY,
      unit: typeof base?.unit === 'number' && base.unit > 0 ? base.unit : DEFAULT_UNIT,
      ...(typeof base?.source === 'string' ? { source: base.source } : {}),
      note: typeof base?.note === 'string' ? base.note : `${PRICE_FILE_NOTE}${PRICE_FILE_PROMPT_NOTE}`,
      prompt: normalizePromptShape(base?.prompt),
      models,
    }
    try {
      await mkdir(dataDir(), { recursive: true })
      await writeFile(pricesPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (error) {
      return jsonResponse({ error: `无法写入 prices.json：${error?.message ?? error}` }, 500)
    }
    // The cached table is keyed by mtime, which a same-millisecond write can miss.
    priceCache = { mtimeMs: -1, value: undefined }
    return jsonResponse({ ok: true, prices: normalizePrices(next) })
  }

  /**
   * Fold one stored session from its inherited cut, returning its per-day
   * buckets plus the tail of its individual settlements for the flow table.
   * A settlement is one `assistant/message`, or an `assistant/attempt` that
   * reported usage; the step's `step/start` gives the request its start time.
   */
  async function foldSession(persistence, id) {
    const handle = await persistence.open(id, 'read')
    try {
      const inherited = typeof handle.inheritedEventCount === 'number' ? handle.inheritedEventCount : 0
      const { events } = await handle.read(inherited)
      const days = Object.create(null)
      const requests = []
      // Prompt-shape evidence per route, kept for every settlement the log
      // holds, not just the tail the flow table shows.
      const shapes = Object.create(null)
      const starts = new Map()
      const ends = new Map()
      let route = 'unknown/unknown'
      for (const event of events) {
        if (event.type === 'step/start') {
          if (Number.isFinite(event.time)) starts.set(`${event.data?.turn}/${event.data?.step}`, event.time)
          continue
        }
        if (event.type === 'request/context') {
          route = routeKey(event.data?.provider, event.data?.model)
          seenRoutes.add(route)
          continue
        }
        const usage = usageOf(event)
        if (usage === undefined || !Number.isFinite(event.time)) continue
        const day = localDay(event.time)
        if (days[day] === undefined) days[day] = emptyDay()
        const bucket = days[day]
        const counts = countsFrom(usage)
        addCounts(bucket, { ...counts, models: Object.create(null) })
        const settledRoute = routeOfEvent(event) ?? route
        const entry = bucket.models[settledRoute] ?? (bucket.models[settledRoute] = emptyRoute())
        const band = entry[isPeak(event.time) ? 'peak' : 'off']
        band.input += counts.input
        band.cacheRead += counts.cacheRead
        band.cacheWrite += counts.cacheWrite
        band.output += counts.output
        band.requests += 1

        const shape = shapes[settledRoute] ?? (shapes[settledRoute] = { settlements: 0, maxShare: 0, exceeds: false })
        shape.settlements += 1
        if (counts.cacheRead > counts.input) shape.exceeds = true
        else if (counts.input > 0) shape.maxShare = Math.max(shape.maxShare, counts.cacheRead / counts.input)

        // A retried step starts where its previous attempt settled, so one
        // request's latency never swallows the attempt before it.
        const stepKey = `${event.data?.turn}/${event.data?.step}`
        const bounds = [starts.get(stepKey), ends.get(stepKey)].filter(value => Number.isFinite(value))
        const start = bounds.length === 0 ? undefined : Math.max(...bounds)
        ends.set(stepKey, event.time)
        const first = firstStreamTime(event)
        requests.push({
          time: event.time,
          start: Number.isFinite(start) && start <= event.time ? start : null,
          provider: settledRoute.slice(0, settledRoute.indexOf('/')),
          model: settledRoute.slice(settledRoute.indexOf('/') + 1),
          input: counts.input,
          cacheRead: counts.cacheRead,
          cacheWrite: counts.cacheWrite,
          output: counts.output,
          firstToken: Number.isFinite(first) && Number.isFinite(start) && first >= start && first <= event.time
            ? first - start
            : null,
          duration: Number.isFinite(start) && start <= event.time ? event.time - start : null,
          failed: event.type === 'assistant/attempt',
        })
        if (requests.length > MAX_SESSION_REQUESTS) requests.shift()
      }
      return { days, requests, shapes }
    } finally {
      await handle.close()
    }
  }

  /**
   * A forked child continues an existing message series, so its own events can
   * precede any `request/context` and land under `unknown/unknown`. When a
   * session names exactly one real route, fold the unknown share into it.
   */
  function settleUnknownRoute(days, requests, shapes) {
    const all = new Set()
    for (const bucket of Object.values(days)) {
      for (const key of Object.keys(bucket.models)) all.add(key)
    }
    for (const request of requests ?? []) all.add(routeKey(request.provider, request.model))
    const known = [...all].filter(key => key !== 'unknown/unknown')
    if (known.length !== 1 || !all.has('unknown/unknown')) return
    const target = known[0]
    const strayShape = shapes?.['unknown/unknown']
    if (strayShape !== undefined && shapes !== undefined) {
      const merged = shapes[target] ?? (shapes[target] = { settlements: 0, maxShare: 0, exceeds: false })
      merged.settlements += strayShape.settlements
      merged.maxShare = Math.max(merged.maxShare, strayShape.maxShare)
      merged.exceeds = merged.exceeds || strayShape.exceeds
      delete shapes['unknown/unknown']
    }
    for (const bucket of Object.values(days)) {
      const stray = bucket.models['unknown/unknown']
      if (stray === undefined) continue
      const entry = bucket.models[target] ?? (bucket.models[target] = emptyRoute())
      for (const band of ['peak', 'off']) {
        entry[band].input += stray[band].input
        entry[band].cacheRead += stray[band].cacheRead
        entry[band].cacheWrite += stray[band].cacheWrite
        entry[band].output += stray[band].output
        entry[band].requests += stray[band].requests
      }
      delete bucket.models['unknown/unknown']
    }
    const slash = target.indexOf('/')
    const provider = target.slice(0, slash)
    const model = target.slice(slash + 1)
    for (const request of requests ?? []) {
      if (request.provider !== 'unknown' || request.model !== 'unknown') continue
      request.provider = provider
      request.model = model
    }
  }

  /** Re-fold every session whose log revision changed since the last report. */
  async function refresh() {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('本 profile 没有会话持久化后端，无法读取会话日志')
    }
    const snapshots = (await persistence.list()).slice(0, MAX_SESSIONS)
    const next = new Map()
    for (const snapshot of snapshots) {
      const id = snapshot?.header?.id
      if (typeof id !== 'string') continue
      const revision = String(snapshot.revision)
      const cached = cache.get(id)
      if (cached !== undefined && cached.revision === revision) {
        next.set(id, cached)
        continue
      }
      try {
        const folded = await foldSession(persistence, id)
        settleUnknownRoute(folded.days, folded.requests, folded.shapes)
        next.set(id, { revision, days: folded.days, requests: folded.requests, shapes: folded.shapes })
      } catch (error) {
        console.warn(`[daily-token-usage] cannot fold session ${id}:`, error?.message ?? error)
        if (cached !== undefined) next.set(id, cached)
      }
    }
    cache.clear()
    for (const [id, entry] of next) cache.set(id, entry)
    await ensurePricesFile()
  }

  /** Serialize refreshes so two reports cannot fold the same session at once. */
  function refreshOnce() {
    refreshing = refreshing.then(refresh, refresh)
    return refreshing
  }

  /**
   * Per-route prompt shape, decided from the route's newest settlements so a
   * gateway that switches formats takes effect without waiting for old history
   * to age out. A cached read above the reported input proves disjoint counts; a
   * run of settlements where the cached read sits at 95% of the reported input
   * or more, never above it, reads as a prompt total.
   */
  function promptShapes() {
    const byRoute = new Map()
    for (const entry of cache.values()) {
      for (const request of entry.requests ?? []) {
        const key = routeKey(request.provider, request.model)
        const list = byRoute.get(key) ?? []
        list.push(request)
        byRoute.set(key, list)
      }
    }
    const shapes = new Map()
    for (const [key, list] of byRoute) {
      list.sort((left, right) => right.time - left.time)
      let signature
      let run = 0
      for (const request of list) {
        const shape = request.cacheRead > request.input
          ? 'disjoint'
          : request.input > 0 && request.cacheRead / request.input >= PROMPT_TOTAL_SHARE ? 'total' : 'ambiguous'
        if (shape === 'ambiguous') break
        if (signature === undefined) signature = shape
        else if (shape !== signature) break
        run += 1
        if (run >= PROMPT_SHAPE_RUN) break
      }
      if (signature === 'disjoint') shapes.set(key, { includesCache: false, pinned: false })
      else if (signature === 'total' && run >= PROMPT_TOTAL_SAMPLES) shapes.set(key, { includesCache: true, pinned: false })
    }
    // Routes whose newest settlements aged out of the retained tails keep the
    // counters recorded while folding their sessions.
    const aged = new Map()
    for (const entry of cache.values()) {
      for (const [key, shape] of Object.entries(entry.shapes ?? {})) {
        let slot = aged.get(key)
        if (slot === undefined) {
          slot = { settlements: 0, maxShare: 0, exceeds: false }
          aged.set(key, slot)
        }
        slot.settlements += shape.settlements
        slot.maxShare = Math.max(slot.maxShare, shape.maxShare)
        slot.exceeds = slot.exceeds || shape.exceeds
      }
    }
    for (const [key, slot] of aged) {
      if (shapes.has(key)) continue
      shapes.set(key, {
        includesCache: !slot.exceeds
          && slot.settlements >= PROMPT_TOTAL_SAMPLES
          && slot.maxShare >= PROMPT_TOTAL_SHARE,
        pinned: false,
      })
    }
    return shapes
  }

  /**
   * How a route's `inputTokens` is read. A pinned `total`/`disjoint` in
   * prices.json always wins; otherwise the inferred shape decides.
   */
  function promptShapeOf(prices, shapes, key) {
    const pinned = prices?.prompt?.models?.[key] ?? prices?.prompt?.default ?? 'auto'
    if (pinned === 'total' || pinned === 'disjoint') {
      return { includesCache: pinned === 'total', pinned: true }
    }
    const shape = shapes.get(key)
    return { includesCache: shape?.includesCache === true, pinned: false }
  }

  /**
   * Move a route's cached share out of `input` for a route that reports a
   * prompt total, then rebuild the day's own figures from its route bands. A
   * band whose cached read exceeds its input is left alone: that reading only
   * occurs under the disjoint contract, so it belongs to a format the route no
   * longer reports.
   */
  function normalizeBucket(bucket, prices, shapes) {
    let changed = false
    for (const [key, entry] of Object.entries(bucket.models ?? {})) {
      const shape = promptShapeOf(prices, shapes, key)
      if (!shape.includesCache) continue
      for (const band of ['peak', 'off']) {
        const counts = entry[band]
        if (!shape.pinned && counts.cacheRead > counts.input) continue
        const cached = Math.min(counts.cacheRead, counts.input)
        if (cached <= 0) continue
        counts.input -= cached
        counts.cacheRead = cached
        changed = true
      }
    }
    if (!changed) return
    const totals = zeroCounts()
    for (const entry of Object.values(bucket.models)) {
      for (const band of ['peak', 'off']) {
        totals.input += entry[band].input
        totals.cacheRead += entry[band].cacheRead
        totals.cacheWrite += entry[band].cacheWrite
        totals.output += entry[band].output
        totals.requests += entry[band].requests
      }
    }
    bucket.input = totals.input
    bucket.cacheRead = totals.cacheRead
    bucket.cacheWrite = totals.cacheWrite
    bucket.output = totals.output
    bucket.requests = totals.requests
  }

  /** Merge every cached session into one per-day view. */
  function aggregate(prices, shapes) {
    const days = Object.create(null)
    let sessions = 0
    for (const entry of cache.values()) {
      sessions += 1
      for (const [day, bucket] of Object.entries(entry.days)) {
        if (days[day] === undefined) days[day] = zeroCounts()
        addCounts(days[day], bucket)
      }
    }
    for (const bucket of Object.values(days)) normalizeBucket(bucket, prices, shapes)
    const recordedDays = Object.keys(days).length
    const allTime = Object.values(days).reduce((totals, bucket) => addCounts(totals, bucket), zeroCounts())
    const recordedSince = recordedDays === 0 ? null : Object.keys(days).sort()[0]
    return {
      days,
      sessions,
      recordedDays,
      allTime,
      recordedSince,
      currency: prices?.currency ?? DEFAULT_CURRENCY,
      cost: costOf(allTime, prices),
    }
  }

  /** Price summary for the model routes actually seen, when priced. */
  function priceNote(prices, bucket) {
    if (prices === undefined) return null
    const parts = []
    let fallback = false
    for (const key of Object.keys(bucket.models ?? {}).sort()) {
      if (key === 'unknown/unknown') {
        fallback = true
        continue
      }
      const price = priceFor(prices, key)
      if (price === undefined) continue
      if (price.input + price.cacheRead + price.cacheWrite + price.output === 0) continue
      parts.push(`${key} 未命中 ${price.input} · 命中 ${price.cacheRead} · 输出 ${price.output}`)
    }
    if (parts.length === 0 && !fallback) return null
    const head = `按 DeepSeek 官网价估算（${prices.currency}/百万 token，空闲时段 5 折）`
    const tail = fallback ? `${parts.length > 0 ? '；' : ''}未标注路由的调用按 "*" 兜底价计` : ''
    return `${head}：${parts.join('；')}${tail}`
  }

  /** Cost of one settlement under the configured table, or null when unpriced. */
  function requestCost(request, prices) {
    if (prices === undefined) return null
    const price = priceFor(prices, routeKey(request.provider, request.model))
    if (price === undefined) return null
    const factor = isPeak(request.time) ? 1 : OFF_PEAK_FACTOR
    const amount = request.input * price.input
      + request.cacheRead * price.cacheRead
      + request.cacheWrite * price.cacheWrite
      + request.output * price.output
    return amount * factor / prices.unit
  }

  /** Newest settlements across every cached session, priced, newest first. */
  function requestRows(prices, shapes) {
    const merged = []
    for (const entry of cache.values()) {
      for (const request of entry.requests ?? []) merged.push(request)
    }
    merged.sort((left, right) => right.time - left.time)
    return merged.slice(0, MAX_REPORT_REQUESTS).map(request => {
      const shape = promptShapeOf(prices, shapes, routeKey(request.provider, request.model))
      // A cached read above the reported input belongs to the disjoint contract,
      // so it is only peeled when the shape was pinned by hand.
      const peel = shape.includesCache && (shape.pinned || request.cacheRead <= request.input)
      const cacheRead = peel ? Math.min(request.cacheRead, request.input) : request.cacheRead
      const row = {
        time: request.time,
        start: request.start,
        provider: request.provider,
        model: request.model,
        input: peel ? request.input - cacheRead : request.input,
        cacheRead,
        cacheWrite: request.cacheWrite,
        output: request.output,
        firstToken: request.firstToken,
        duration: request.duration,
        failed: request.failed,
      }
      return { ...row, cost: requestCost(row, prices) }
    })
  }

  /** Note naming the routes read as prompt totals, so the assumption is visible. */
  function promptNote(prices, shapes) {
    const routes = new Set()
    for (const key of shapes.keys()) {
      if (promptShapeOf(prices, shapes, key).includesCache) routes.add(key)
    }
    for (const [key, value] of Object.entries(prices?.prompt?.models ?? {})) {
      if (value === 'total') routes.add(key)
    }
    if (prices?.prompt?.default === 'total') routes.add('全部路由')
    if (routes.size === 0) return null
    return `输入口径：${[...routes].sort().join('、')} 上报的输入已含缓存命中，已按「输入 − 缓存命中」折算后计价`
  }

  /** Build the text report shared by the command and the tool. */
  function report(days, prices, now = Date.now()) {
    const window = Math.min(MAX_REPORT_DAYS, Math.max(1, Math.trunc(days)))
    const shapes = promptShapes()
    const view = aggregate(prices, shapes)
    const rows = []
    const start = new Date(now)
    for (let index = 0; index < window; index += 1) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() - index)
      const day = localDay(date.getTime())
      rows.push({ date: day, ...(view.days[day] ?? zeroCounts()) })
    }
    const windowTotals = rows.reduce((totals, row) => addCounts(totals, row), zeroCounts())
    const windowCost = costOf(windowTotals, prices)
    const todayCost = costOf(rows[0], prices)
    const money_ = value => `${view.currency}${money(value)}`

    if (view.recordedDays === 0) {
      return {
        text: [
          `今日 ${rows[0].date} · 还没有记录到 token 用量`,
          '可能原因：模型适配器或网关没有上报 usage，或本机尚无模型请求。',
        ].join('\n'),
        rows,
        windowTotals,
        allTime: view.allTime,
        recordedDays: 0,
        cost: null,
        currency: view.currency,
      }
    }

    const today = rows[0]
    const hit = cacheHit(today)
    const lines = []
    // The command card collapses to its first line, so the headline must answer alone.
    lines.push(`今日 ${scale(totalTokens(today))} tok · ${group(today.requests)} 次结算${hit === null ? '' : ` · 缓存命中 ${hit}`}${todayCost === null ? '' : ` · 约 ${money_(todayCost)}`}`)
    lines.push(`未缓存输入 ${tokens(today.input)} · 缓存读取 ${tokens(today.cacheRead)} · 缓存写入 ${tokens(today.cacheWrite)} · 输出 ${tokens(today.output)}`)
    lines.push(todayCost === null
      ? '未配置价格（填写 prices.json 后可估算金额）'
      : '金额按官网单价与峰谷时段估算，非账单；合计含缓存读写')
    lines.push('')
    lines.push(`最近 ${window} 天（每日合计 / 结算次数${windowCost === null ? '' : ' / 估算金额'}）`)
    // Inside one year the table drops the year; a window spanning years keeps it.
    const showYear = rows[0].date.slice(0, 4) !== rows[rows.length - 1].date.slice(0, 4)
    const label = date => (showYear ? date : date.slice(5))
    let zeroFrom = null
    let zeroTo = null
    const flushZeros = () => {
      if (zeroFrom === null) return
      const span = zeroFrom === zeroTo ? label(zeroFrom) : `${label(zeroFrom)}…${label(zeroTo)}`
      lines.push(`${span}  ${pad('0', 8)}  ${pad('0', 6)} 次`)
      zeroFrom = null
      zeroTo = null
    }
    for (const row of rows) {
      if (totalTokens(row) === 0 && row.requests === 0) {
        if (zeroFrom === null || row.date < zeroFrom) zeroFrom = row.date
        if (zeroTo === null || row.date > zeroTo) zeroTo = row.date
        continue
      }
      flushZeros()
      const rowCost = costOf(row, prices)
      const costCell = windowCost === null ? '' : `  ${pad(rowCost === null ? '—' : money_(rowCost), 10)}`
      lines.push(`${label(row.date)}  ${pad(scale(totalTokens(row)), 8)}  ${pad(group(row.requests), 6)} 次${costCell}`)
    }
    flushZeros()
    lines.push(`窗口合计 ${scale(totalTokens(windowTotals))} tok · ${group(windowTotals.requests)} 次结算${windowCost === null ? '' : ` · 约 ${money_(windowCost)}`}`)
    lines.push('')
    lines.push(`数据自 ${view.recordedSince} 起 · ${scale(totalTokens(view.allTime))} tok · ${group(view.allTime.requests)} 次结算 · ${group(view.recordedDays)} 天有记录 · ${group(view.sessions)} 个会话${view.cost === null ? '' : ` · 累计约 ${money_(view.cost)}`}`)
    if (view.allTime.reasoning > 0) lines.push(`其中推理 ${tokens(view.allTime.reasoning)}`)
    const note = priceNote(prices, view.allTime)
    if (note !== null) lines.push(note)
    const shapeNote = promptNote(prices, shapes)
    if (shapeNote !== null) lines.push(shapeNote)
    return {
      text: lines.join('\n'),
      rows,
      windowTotals,
      allTime: view.allTime,
      recordedDays: view.recordedDays,
      cost: view.cost,
      windowCost,
      currency: view.currency,
    }
  }

  function parseDays(rawInput, fallback = DEFAULT_REPORT_DAYS) {
    const match = /(\d+)/.exec(rawInput ?? '')
    if (match === null) return fallback
    const value = Number.parseInt(match[1], 10)
    if (!Number.isFinite(value) || value < 1) return fallback
    return Math.min(MAX_REPORT_DAYS, value)
  }

  /** Machine-readable view for the Web client's page. */
  function reportJson(days, prices) {
    const shapes = promptShapes()
    const view = aggregate(prices, shapes)
    const bucketOf = date => {
      const bucket = view.days[date] ?? zeroCounts()
      return {
        date,
        total: totalTokens(bucket),
        input: bucket.input,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        output: bucket.output,
        requests: bucket.requests,
        cost: costOf(bucket, prices),
        costParts: costPartsOf(bucket, prices),
        models: Object.keys(bucket.models),
      }
    }
    const nowDate = new Date()
    const rows = []
    for (let index = days - 1; index >= 0; index -= 1) {
      const date = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - index)
      rows.push(bucketOf(localDay(date.getTime())))
    }
    const windowTotals = rows.reduce((totals, row) => {
      totals.input += row.input
      totals.cacheRead += row.cacheRead
      totals.cacheWrite += row.cacheWrite
      totals.output += row.output
      totals.requests += row.requests
      return totals
    }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 })
    // Row costs are already additive; summing them avoids rebuilding route bands.
    const costs = rows.map(row => row.cost).filter(value => typeof value === 'number')
    const windowCost = costs.length === 0 ? null : costs.reduce((total, value) => total + value, 0)
    const parts = rows.map(row => row.costParts).filter(value => value !== null && value !== undefined)
    const windowParts = parts.length === 0 ? null : parts.reduce((sum, part) => ({
      input: sum.input + part.input,
      cacheRead: sum.cacheRead + part.cacheRead,
      cacheWrite: sum.cacheWrite + part.cacheWrite,
      output: sum.output + part.output,
      total: sum.total + part.total,
    }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 })
    return {
      today: bucketOf(localDay(nowDate.getTime())),
      rows,
      window: {
        days,
        total: totalTokens(windowTotals),
        requests: windowTotals.requests,
        input: windowTotals.input,
        cacheRead: windowTotals.cacheRead,
        cacheWrite: windowTotals.cacheWrite,
        output: windowTotals.output,
        cost: windowCost,
        costParts: windowParts,
      },
      allTime: {
        total: totalTokens(view.allTime),
        requests: view.allTime.requests,
        days: view.recordedDays,
        sessions: view.sessions,
        since: view.recordedSince,
        cost: view.cost,
      },
      // Newest settlements, so the page can show a live request flow.
      requests: requestRows(prices, shapes),
      // What the page needs to edit a price: the table actually in force, the
      // shipped list prices to fall back to, and the usage of each route seen.
      prices: {
        currency: view.currency,
        unit: prices?.unit ?? DEFAULT_UNIT,
        table: prices?.models ?? {},
        defaults: DEFAULT_PRICES.models,
        prompt: prices?.prompt ?? DEFAULT_PRICES.prompt,
      },
      routes: routesOf(view.allTime, prices),
      currency: view.currency,
      priceNote: priceNote(prices, view.allTime),
      promptNote: promptNote(prices, shapes),
      generatedAt: Date.now(),
    }
  }

  // The Web client's page reads this loopback JSON route; it exposes the same
  // aggregate the command prints. The Web server may not exist yet when the
  // profile activates (it starts with the GUI), so wait for the service instead
  // of silently skipping the route on a cold start.
  let routeMounted = false
  const mountRoutes = (webServer) => {
    if (routeMounted || webServer === undefined) return
    routeMounted = true
    ctx.effect(() => {
      const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
      const reportRoute = webServer.register({
        kind: 'exact',
        path: '/daily-token-usage/report',
        resource: async (request) => {
          try {
            const url = new URL(request.url)
            const requested = Number.parseInt(url.searchParams.get('days') ?? '', 10)
            const bounded = Number.isFinite(requested) && requested >= 1 ? Math.min(MAX_REPORT_DAYS, requested) : 14
            await refreshOnce()
            return jsonResponse(reportJson(bounded, await loadPrices()))
          } catch (error) {
            return jsonResponse({ error: String(error?.message ?? error) }, 500)
          }
        },
      })
      const priceRoute = webServer.register({
        kind: 'exact',
        path: '/daily-token-usage/prices',
        resource: request => updatePrices(request, jsonResponse),
      })
      return () => {
        routeMounted = false
        if (typeof priceRoute === 'function') priceRoute()
        if (typeof reportRoute === 'function') reportRoute()
      }
    })
  }
  mountRoutes(ctx.get('webServer'))
  if (!routeMounted) {
    if (typeof ctx.inject === 'function') {
      // Re-checked through ctx.get: the callback runs once the service is available.
      ctx.inject(['webServer'], () => mountRoutes(ctx.get('webServer')))
    } else if (typeof ctx.on === 'function') {
      ctx.on('ready', () => mountRoutes(ctx.get('webServer')))
    }
  }

  ctx.commands.register({
    name: 'usage',
    description: '跨会话按天汇总 token 用量与估算金额（默认最近 7 天，可跟天数）',
    input: { hint: '天数，例如 14' },
    handler: async ({ rawInput }) => {
      try {
        await refreshOnce()
        return { kind: 'success', text: report(parseDays(rawInput), await loadPrices()).text }
      } catch (error) {
        return { kind: 'error', text: `无法统计 token 用量：${error?.message ?? error}` }
      }
    },
  })

  ctx.tools.register({
    name: 'token_usage',
    description: 'Report daily provider-reported token usage recorded by this profile: today, the requested window, and the all-time total, split into uncached input, cache read, cache write, and output tokens, with a token-weighted cache hit rate and a DeepSeek list-price estimate that applies the peak/off-peak factor. Totals include cache reads and the estimate is not a billing amount. Report text is Chinese.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_REPORT_DAYS,
          description: 'Number of trailing local days to list, counting today. Defaults to 7.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      await refreshOnce()
      const requested = args?.days
      return { text: report(Number.isFinite(requested) ? requested : DEFAULT_REPORT_DAYS, await loadPrices()).text }
    },
  })
}
