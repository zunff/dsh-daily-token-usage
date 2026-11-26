import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const modulePath = new URL('../index.js', import.meta.url).href
const { apply } = await import(modulePath)

const now = Date.now()
const midnight = new Date(now)
midnight.setHours(0, 0, 0, 0)
const yesterday = midnight.getTime() - 12 * 3600 * 1000
const day = time => {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const message = (seq, time, usage) => ({
  type: 'assistant/message',
  seq,
  time,
  data: { turn: 1, step: seq + 1, usage },
})
const route = (seq, time, provider, model) => ({
  type: 'request/context',
  seq,
  time,
  data: { provider, model },
})

/** A fake persistence backend with per-session revisions and read accounting. */
function fakePersistence(sessions) {
  const reads = new Map()
  return {
    reads,
    async list() {
      return [...sessions.keys()].map(id => ({ header: { id }, revision: sessions.get(id).revision }))
    },
    async open(id) {
      const session = sessions.get(id)
      if (session === undefined) throw new Error(`no session ${id}`)
      reads.set(id, (reads.get(id) ?? 0) + 1)
      return {
        inheritedEventCount: session.inherited ?? 0,
        async read(offset = 0) {
          return { events: session.events.slice(offset) }
        },
        async close() {},
      }
    },
  }
}

function makeContext(persistence, webServer) {
  const ctx = {
    effect: fn => fn(),
    on: () => () => {},
    get: name => {
      if (name === 'sessionPersistence') return persistence
      if (name === 'webServer') return webServer
      return undefined
    },
    commands: { register: definition => { ctx.command = definition } },
    tools: { register: definition => { ctx.tool = definition } },
  }
  return ctx
}

/** A web server stand-in that keeps the registered route for a direct call. */
function fakeWebServer() {
  const server = {
    routes: new Map(),
    register(definition) {
      server.routes.set(definition.path, definition)
      return () => {}
    },
  }
  return server
}

async function reportJson(server, days = 14) {
  const route = server.routes.get('/daily-token-usage/report')
  assert.ok(route, 'report route registered')
  const response = await route.resource(new Request(`http://127.0.0.1/daily-token-usage/report?days=${days}`))
  assert.equal(response.status, 200)
  return response.json()
}

async function report(ctx, input = '') {
  return ctx.command.handler({ rawInput: input })
}

const sessionsWithRoute = () => new Map([
  ['s1', {
    revision: 'r1',
    events: [
      route(0, midnight.getTime(), 'deepseek-official', 'ds/deepseek-flash'),
      message(1, midnight.getTime() + 3600 * 1000, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10 }),
    ],
  }],
  ['s2', {
    revision: 'r2',
    events: [{
      type: 'assistant/attempt', seq: 0, time: yesterday,
      data: { turn: 1, step: 2, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } } }] },
    }],
  }],
])

// ---------------------------------------------------------------- scenario A
// Official list prices apply out of the box; the price file is seeded with the
// routes the fold discovered so one line per model is all a user edits.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-a-'))
  process.env.DSH_HOME = home
  const ctx = makeContext(fakePersistence(sessionsWithRoute()))
  apply(ctx)

  const first = await report(ctx)
  assert.equal(first.kind, 'success')
  console.log(first.text)
  console.log('-----')
  assert.match(first.text, /^今日 1,260 tok · 1 次结算 · 缓存命中 4\.7% · 约 ¥[\d.]+$/m)
  assert.match(first.text, /未缓存输入 1,000 tok · 缓存读取 50 tok · 缓存写入 10 tok · 输出 200 tok/)
  assert.match(first.text, /按 DeepSeek 官网价估算/)
  assert.match(first.text, /窗口合计 1,270 tok · 2 次结算 · 约 ¥/)
  assert.match(first.text, /数据自 \d{4}-\d{2}-\d{2} 起 · 1,270 tok · 2 次结算 · 2 天有记录 · 2 个会话/)
  assert.ok(first.text.includes(day(yesterday).slice(5)), 'yesterday row present')

  const template = JSON.parse(await readFile(path.join(home, 'storages', 'daily-token-usage', 'prices.json'), 'utf8'))
  assert.deepEqual(template.models['deepseek-flash'], { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 })
  assert.deepEqual(template.models['deepseek-v4-pro'], { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 })
  assert.deepEqual(template.models['deepseek-official/ds/deepseek-flash'], { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 })
  assert.match(template.note, /空闲时段按 5 折/)
  console.log('scenario A passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario B
// An override table is honoured, and a peak-hour call bills double an off-peak
// one. Expectations are derived with the same public rule (weekday daytime).
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-b-'))
  process.env.DSH_HOME = home
  const pricesFile = path.join(home, 'storages', 'daily-token-usage', 'prices.json')
  await mkdir(path.dirname(pricesFile), { recursive: true })
  await writeFile(pricesFile, JSON.stringify({
    currency: '¥',
    unit: 1000000,
    models: { '*': { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 } },
  }))
  const peak = new Date(midnight)
  peak.setHours(10, 0, 0, 0)
  const off = new Date(midnight)
  off.setHours(2, 0, 0, 0)
  const ctx = makeContext(fakePersistence(new Map([
    ['peak', { revision: 'p', events: [message(0, peak.getTime(), { inputTokens: 1_000_000, outputTokens: 0 })] }],
    ['off', { revision: 'o', events: [message(0, off.getTime(), { inputTokens: 1_000_000, outputTokens: 0 })] }],
  ])))
  apply(ctx)

  const weekday = peak.getDay() >= 1 && peak.getDay() <= 5
  const expected = weekday ? 3 : 2
  const priced = await report(ctx)
  console.log(priced.text)
  assert.match(priced.text, new RegExp(`约 ¥${expected}\\.00`), 'peak hour bills double off-peak')
  assert.match(priced.text, /按 DeepSeek 官网价估算/)
  console.log('scenario B passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario C
// Nothing stored: say so instead of printing zeroes.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-c-'))
  process.env.DSH_HOME = home
  const ctx = makeContext(fakePersistence(new Map()))
  apply(ctx)
  const result = await report(ctx)
  console.log(result.text)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /还没有记录到 token 用量/)
  console.log('scenario C passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario D
// A fork's inherited prefix belongs to its parent and is skipped.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-d-'))
  process.env.DSH_HOME = home
  const ctx = makeContext(fakePersistence(new Map([
    ['parent', { revision: 'p1', events: [message(0, midnight.getTime(), { inputTokens: 500, outputTokens: 50 })] }],
    ['child', {
      revision: 'c1',
      inherited: 1,
      events: [
        message(0, midnight.getTime(), { inputTokens: 500, outputTokens: 50 }),
        message(1, midnight.getTime() + 1000, { inputTokens: 20, outputTokens: 2 }),
      ],
    }],
  ])))
  apply(ctx)
  const result = await report(ctx)
  console.log(result.text)
  assert.match(result.text, /今日 572 tok · 2 次结算/, 'parent counted once, child only its own event')
  console.log('scenario D passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario E
// Window parsing, clamping, and the tool's own path.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-e-'))
  process.env.DSH_HOME = home
  const ctx = makeContext(fakePersistence(new Map([
    ['s1', { revision: 'r', events: [message(0, midnight.getTime(), { inputTokens: 10, outputTokens: 1 })] }],
  ])))
  apply(ctx)
  assert.match((await report(ctx, ' 30 ')).text, /最近 30 天/)
  assert.match((await report(ctx, 'abc')).text, /最近 7 天/)
  assert.match((await report(ctx, '9999')).text, /最近 365 天/)
  const tool = await ctx.tool.execute({ days: 2 })
  assert.match(tool.text, /最近 2 天/)
  assert.equal(typeof tool.text, 'string')
  console.log('scenario E passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario F
// No persistence backend: a typed error instead of a zeroed report.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-f-'))
  process.env.DSH_HOME = home
  const ctx = makeContext(undefined)
  apply(ctx)
  const result = await report(ctx)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有会话持久化后端/)
  console.log('scenario F passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario G
// The JSON route publishes the request flow: one row per settlement with its
// own route, first-token latency, and duration from the step's start event.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-g-'))
  process.env.DSH_HOME = home
  const peak = new Date(midnight)
  peak.setHours(10, 0, 0, 0)
  const t0 = peak.getTime()
  const server = fakeWebServer()
  const ctx = makeContext(fakePersistence(new Map([
    ['flow', {
      revision: 'g1',
      events: [
        { type: 'step/start', seq: 0, time: t0, data: { turn: 1, step: 1 } },
        route(1, t0, 'deepseek-official', 'ds/deepseek-flash'),
        {
          type: 'assistant/message', seq: 2, time: t0 + 3000,
          data: {
            turn: 1,
            step: 1,
            message: { role: 'assistant', source: { kind: 'model', provider: 'proxy', model: 'bp-deepseek-v4-pro' } },
            usage: { inputTokens: 1_000_000, outputTokens: 0 },
            stream: [
              { type: 'chunk', time: t0 + 1200, chunk: { type: 'block-start' } },
              { type: 'chunk', time: t0 + 3000, chunk: { type: 'finish' } },
            ],
          },
        },
        { type: 'step/start', seq: 3, time: t0 + 4000, data: { turn: 1, step: 2 } },
        {
          type: 'assistant/attempt', seq: 4, time: t0 + 5000,
          data: { turn: 1, step: 2, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } }] },
        },
        {
          type: 'assistant/message', seq: 5, time: t0 + 7000,
          data: {
            turn: 1,
            step: 2,
            message: { role: 'assistant', source: { kind: 'model', provider: 'proxy', model: 'bp-deepseek-v4-pro' } },
            usage: { inputTokens: 10, outputTokens: 2 },
            stream: [{ type: 'chunk', time: t0 + 6000, chunk: { type: 'text-delta', index: 0, text: '' } }],
          },
        },
      ],
    }],
  ])), server)
  apply(ctx)

  const json = await reportJson(server, 14)
  assert.equal(json.requests.length, 3, 'one row per settlement')
  const [retried, failed, message] = json.requests
  assert.equal(retried.model, 'bp-deepseek-v4-pro')
  assert.equal(retried.start, t0 + 5000, 'a retry starts where its failed attempt settled')
  assert.equal(retried.duration, 2000, 'not from the step start, and not including the attempt')
  assert.equal(retried.firstToken, 1000)
  assert.equal(failed.failed, true)
  assert.equal(failed.model, 'ds/deepseek-flash', 'an attempt falls back to the turn route')
  assert.equal(failed.duration, 1000)
  assert.equal(failed.firstToken, null, 'a buffered attempt has no first-token time')
  assert.equal(message.failed, false)
  assert.equal(message.provider, 'proxy')
  assert.equal(message.model, 'bp-deepseek-v4-pro', 'the committed message names its own route')
  assert.equal(message.input, 1_000_000)
  assert.equal(message.cacheRead, 0)
  assert.equal(message.firstToken, 1200)
  assert.equal(message.duration, 3000)
  const weekday = peak.getDay() >= 1 && peak.getDay() <= 5
  assert.equal(message.cost, weekday ? 9 : 4.5, 'pro list price, half off-peak')
  assert.ok(failed.cost !== null)
  assert.ok(json.today.models.includes('proxy/bp-deepseek-v4-pro'), 'the settlement route prices the day')
  assert.match(json.priceNote, /proxy\/bp-deepseek-v4-pro/)
  console.log('scenario G passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario H
// A gateway can report the whole prompt in `inputTokens` and the cached part
// beside it. That route is read as a prompt total: the cached share is peeled
// out of the uncached input before the day is summed and the row is priced,
// while a route whose cached reads exceed its input keeps the contract shape.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-h-'))
  process.env.DSH_HOME = home
  const off = new Date(midnight)
  off.setHours(19, 0, 0, 0)
  const t0 = off.getTime()
  const gateway = (seq, time, input, cacheRead, output) => ({
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: seq + 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'gateway', model: 'wide-input' } },
      usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output },
    },
  })
  const server = fakeWebServer()
  const ctx = makeContext(fakePersistence(new Map([
    ['gateway', {
      revision: 'h1',
      events: [
        gateway(0, t0, 151280, 151040, 131),
        gateway(1, t0 + 5000, 152000, 151000, 200),
      ],
    }],
    ['contract', {
      revision: 'h2',
      events: [
        route(0, t0, 'deepseek-official', 'ds/deepseek-flash'),
        message(1, t0, { inputTokens: 928, outputTokens: 159, cacheReadTokens: 9344 }),
      ],
    }],
  ])), server)
  apply(ctx)

  const json = await reportJson(server, 14)
  assert.equal(json.requests.length, 3)
  const older = json.requests.find(row => row.time === t0 && row.model === 'wide-input')
  const newer = json.requests.find(row => row.model === 'wide-input' && row.time === t0 + 5000)
  const contract = json.requests.find(row => row.model === 'ds/deepseek-flash')
  assert.equal(older.input, 240, 'cached share is peeled out of the reported input')
  assert.equal(older.cacheRead, 151040, 'cache reads keep their own weight')
  assert.equal(newer.input, 1000)
  const expected = ((151280 - 151040) * 2 + 151040 * 0.04 + 131 * 8) / 1e6 * 0.5
  assert.ok(Math.abs(older.cost - expected) < 1e-9, 'off-peak flash price on the peeled counts')
  assert.equal(contract.input, 928, 'a route whose cache exceeds its input is untouched')
  assert.equal(contract.cacheRead, 9344)
  assert.equal(json.today.input, 240 + 1000 + 928)
  assert.equal(json.today.cacheRead, 151040 + 151000 + 9344)
  assert.equal(json.today.total, json.today.input + json.today.cacheRead + json.today.output)
  assert.match(json.promptNote, /gateway\/wide-input/)
  assert.doesNotMatch(json.promptNote, /deepseek-flash/)

  // Pinning the shape in prices.json wins over the inference.
  const pricesFile = path.join(home, 'storages', 'daily-token-usage', 'prices.json')
  const prices = JSON.parse(await readFile(pricesFile, 'utf8'))
  assert.equal(prices.prompt.default, 'auto')
  prices.prompt.models['deepseek-official/ds/deepseek-flash'] = 'total'
  await writeFile(pricesFile, `${JSON.stringify(prices, null, 2)}\n`, 'utf8')
  const pinned = await reportJson(server, 14)
  const pinnedRow = pinned.requests.find(row => row.model === 'ds/deepseek-flash')
  assert.equal(pinnedRow.input, 0, '928 < 9344 clamps to zero uncached input')
  assert.equal(pinnedRow.cacheRead, 928, 'no more cached tokens than the reported input')
  console.log('scenario H passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario I
// A route can change format. The newest settlements decide the reading, so a
// gateway that switches to prompt totals takes effect without waiting for the
// old shape to age out; the older rows keep their own, provably disjoint shape.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-i-'))
  process.env.DSH_HOME = home
  const off = new Date(midnight)
  off.setHours(19, 0, 0, 0)
  const t0 = off.getTime()
  const settle = (seq, time, input, cacheRead, output) => ({
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: seq + 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'switch', model: 'flip' } },
      usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output },
    },
  })
  const server = fakeWebServer()
  const ctx = makeContext(fakePersistence(new Map([
    ['flip', {
      revision: 'i1',
      events: [
        settle(0, t0, 1000, 5000, 10),
        settle(1, t0 + 1000, 1000, 5200, 10),
        settle(2, t0 + 2000, 200000, 199000, 20),
        settle(3, t0 + 3000, 201000, 199500, 20),
      ],
    }],
  ])), server)
  apply(ctx)

  const json = await reportJson(server, 14)
  const newest = json.requests.filter(row => row.time >= t0 + 2000)
  const oldest = json.requests.filter(row => row.time < t0 + 2000)
  assert.equal(newest.length, 2)
  assert.equal(oldest.length, 2)
  for (const row of newest) {
    assert.ok(row.input < 2000, 'the newest format is read as a prompt total')
    assert.ok(row.cacheRead > 190000)
  }
  for (const row of oldest) {
    assert.equal(row.input, 1000, 'older rows keep their disjoint reading')
    assert.ok(row.cacheRead >= 5000)
  }
  assert.match(json.promptNote, /switch\/flip/)
  console.log('scenario I passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario J
// The page can publish prices: the report names each route's usage and the
// entry that prices it, a JSON POST rewrites prices.json and the next report
// prices from it, and the write route refuses anything a browser page could
// forge or a typo could poison.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-j-'))
  process.env.DSH_HOME = home
  const off = new Date(midnight)
  off.setHours(19, 0, 0, 0)
  const t0 = off.getTime()
  const server = fakeWebServer()
  const ctx = makeContext(fakePersistence(new Map([
    ['priced', {
      revision: 'j1',
      events: [
        route(0, t0, 'deepseek-official', 'ds/deepseek-flash'),
        message(1, t0, { inputTokens: 1_000_000, outputTokens: 0 }),
      ],
    }],
  ])), server)
  apply(ctx)

  const post = (body, headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }) => {
    const pricesRoute = server.routes.get('/daily-token-usage/prices')
    assert.ok(pricesRoute, 'price route registered')
    return pricesRoute.resource(new Request('http://127.0.0.1/daily-token-usage/prices', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
  }

  const before = await reportJson(server, 14)
  assert.equal(before.prices.unit, 1_000_000)
  assert.deepEqual(before.prices.defaults['deepseek-flash'], { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 })
  const published = before.routes.find(row => row.key === 'deepseek-official/ds/deepseek-flash')
  assert.ok(published, 'the report names the route it priced')
  assert.equal(published.requests, 1)
  assert.equal(published.total, 1_000_000)
  assert.deepEqual(published.price, { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 })
  assert.equal(published.cost, 1, 'off-peak flash: one million uncached tokens at half of ¥2')

  const key = 'deepseek-official/ds/deepseek-flash'
  const saved = await post({ models: { [key]: { input: 4, cacheRead: 0.04, cacheWrite: 0, output: 8 } } })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).ok, true)
  const written = JSON.parse(await readFile(path.join(home, 'storages', 'daily-token-usage', 'prices.json'), 'utf8'))
  assert.deepEqual(written.models[key], { input: 4, cacheRead: 0.04, cacheWrite: 0, output: 8 })
  assert.match(written.note, /空闲时段按 5 折/, 'the note survives a write')
  assert.deepEqual(written.prompt, { default: 'auto', models: {} })

  const after = await reportJson(server, 14)
  assert.equal(after.requests[0].cost, 2, 'the new price is in force without a reload')
  assert.equal(after.routes.find(row => row.key === key).cost, 2)

  // Rejections: a page on another origin, a non-JSON body, a negative price, GET.
  const crossSite = await post({ models: {} }, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })
  assert.equal(crossSite.status, 403)
  const form = await post({ models: {} }, { 'content-type': 'text/plain' })
  assert.equal(form.status, 415)
  const negative = await post({ models: { [key]: { input: -1 } } })
  assert.equal(negative.status, 400)
  const garbage = await post('{')
  assert.equal(garbage.status, 400)
  const get = await server.routes.get('/daily-token-usage/prices')
    .resource(new Request('http://127.0.0.1/daily-token-usage/prices'))
  assert.equal(get.status, 405)
  assert.equal(JSON.parse(await readFile(path.join(home, 'storages', 'daily-token-usage', 'prices.json'), 'utf8')).models[key].input, 4, 'a rejected write changes nothing')

  // A route with no price anywhere shows up as unpriced, and a deleted entry is
  // how the page un-prices one: the exact key, its family, and the fallback all go.
  const unpriced = await post({ models: { [key]: null, 'deepseek-flash': null, '*': null } })
  assert.equal(unpriced.status, 200)
  const bare = await reportJson(server, 14)
  assert.equal(bare.prices.table['*'], undefined)
  assert.equal(bare.routes.find(row => row.key === key).price, null)
  assert.equal(bare.routes.find(row => row.key === key).cost, null)
  assert.equal(bare.requests[0].cost, null)
  assert.equal(bare.priceNote, null, 'nothing is claimed as priced')

  // Everything back to the shipped list prices.
  const reset = await post({ reset: true })
  assert.equal(reset.status, 200)
  const restored = await reportJson(server, 14)
  assert.deepEqual(restored.prices.table['deepseek-flash'], { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 })
  assert.equal(restored.requests[0].cost, 1)
  console.log('scenario J passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario K
// A model id a session routed by is not always the name the profile shows. The
// page names the model the way the catalog does and keeps the routed id on the
// row, so a renamed gateway model still reads as the model a user recognizes.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-k-'))
  process.env.DSH_HOME = home
  const server = fakeWebServer()
  const persistence = fakePersistence(new Map([
    ['named', {
      revision: 'k1',
      events: [
        route(0, midnight.getTime(), 'deepseek-official', 'ds/deepseek-flash'),
        message(1, midnight.getTime() + 1000, { inputTokens: 100, outputTokens: 10 }),
      ],
    }],
  ]))
  const asked = []
  const ctx = makeContext(persistence, server)
  ctx.get = name => {
    if (name === 'webServer') return server
    if (name === 'sessionPersistence') return persistence
    if (name === 'llm') {
      return {
        async listModels(provider) {
          asked.push(provider)
          return provider === 'deepseek-official'
            ? [{ id: 'ds/deepseek-flash', name: 'bp-DeepSeek-V4.1-Flash' }]
            : []
        },
      }
    }
    return undefined
  }
  apply(ctx)

  const json = await reportJson(server, 14)
  assert.equal(json.requests[0].displayName, 'bp-DeepSeek-V4.1-Flash')
  assert.equal(json.requests[0].model, 'ds/deepseek-flash', 'the routed id is still reported')
  assert.equal(json.routes[0].displayName, 'bp-DeepSeek-V4.1-Flash')
  assert.deepEqual(asked, ['deepseek-official'], 'the catalog is asked once per provider')
  console.log('scenario K passed')
  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------- scenario L
// The 今日 tab reads today hour by hour. Each hour carries its own counts, its
// own price, and the tariff band it falls in, and the hours add up to the day.
{
  const home = await mkdtemp(path.join(tmpdir(), 'daily-usage-l-'))
  process.env.DSH_HOME = home
  const server = fakeWebServer()
  const ten = new Date(midnight)
  ten.setHours(10, 0, 0, 0)
  const nineteen = new Date(midnight)
  nineteen.setHours(19, 0, 0, 0)
  const ctx = makeContext(fakePersistence(new Map([
    ['hours', {
      revision: 'l1',
      events: [
        message(0, ten.getTime(), { inputTokens: 1000, outputTokens: 100 }),
        message(1, nineteen.getTime(), { inputTokens: 40, outputTokens: 4 }),
      ],
    }],
  ])), server)
  apply(ctx)

  const json = await reportJson(server, 14)
  assert.equal(json.hours.length, 24, 'one bucket per local hour')
  const weekday = ten.getDay() >= 1 && ten.getDay() <= 5
  assert.equal(json.hours[10].peak, weekday, '10:00 is peak on a weekday')
  assert.equal(json.hours[19].peak, false, '19:00 is always off-peak')
  assert.equal(json.hours[10].requests, 1)
  assert.equal(json.hours[10].total, 1100)
  assert.equal(json.hours[19].total, 44)
  assert.equal(json.hours[3].requests, 0, 'an unused hour still has a slot')
  assert.equal(json.hours.reduce((sum, hour) => sum + hour.total, 0), json.today.total, 'the hours add up to the day')
  assert.equal(json.hours.reduce((sum, hour) => sum + hour.requests, 0), json.today.requests)
  assert.ok(json.hours[10].cost > json.hours[19].cost, 'an hour is priced on its own counts')
  console.log('scenario L passed')
  await rm(home, { recursive: true, force: true })
}

console.log('ALL ASSERTIONS PASSED')
