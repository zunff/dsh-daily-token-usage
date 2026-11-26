// One-off: extend the captured report fixture with the fields the price panel
// reads, derived from its own request rows so the numbers stay consistent. The
// panel needs all three row states, so two routes the day names but the request
// tail does not cover are added: one inheriting the fallback, one unpriced.
import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('./fixture.json', import.meta.url)
const fixture = JSON.parse(await readFile(file, 'utf8'))

const FLASH = { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }
const PRO = { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 }

const routes = new Map()
for (const row of fixture.requests) {
  const key = `${row.provider}/${row.model}`
  const entry = routes.get(key) ?? { key, provider: row.provider, model: row.model, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0 }
  entry.input += row.input
  entry.cacheRead += row.cacheRead
  entry.cacheWrite += row.cacheWrite
  entry.output += row.output
  entry.requests += 1
  entry.cost += row.cost ?? 0
  routes.set(key, entry)
}

const priceOf = key => {
  const model = key.slice(key.indexOf('/') + 1).toLowerCase()
  if (model.includes('flash')) return { price: FLASH, source: 'deepseek-flash' }
  if (model.includes('pro')) return { price: PRO, source: 'deepseek-v4-pro' }
  if (model.includes('test')) return { price: FLASH, source: '*' }
  return { price: null, source: null }
}

/** The name the profile's model catalog gives a routed id, as the host reports it. */
const nameOf = key => {
  const model = key.slice(key.indexOf('/') + 1).toLowerCase()
  if (model.includes('flash')) return 'bp-DeepSeek-V4.1-Flash'
  if (model.includes('test')) return 'bp-Test-Route'
  return null
}

for (const row of fixture.requests) row.displayName = nameOf(`${row.provider}/${row.model}`)

const list = [...routes.values()].map(entry => {
  const { price, source } = priceOf(entry.key)
  return {
    ...entry,
    displayName: nameOf(entry.key),
    total: entry.input + entry.cacheRead + entry.cacheWrite + entry.output,
    price,
    priceSource: source,
  }
})

// Two routes the day names but the captured request tail does not reach, so the
// panel shows an inherited row and an unpriced row beside a configured one.
const synthetic = [
  { key: 'deepseek-official/test', provider: 'deepseek-official', model: 'test', input: 8420, cacheRead: 1_200_000, cacheWrite: 0, output: 900, requests: 12 },
  { key: 'deepseek-official/claude-sonnet-5-5', provider: 'deepseek-official', model: 'claude-sonnet-5-5', input: 51_000, cacheRead: 3_100_000, cacheWrite: 0, output: 41_000, requests: 3 },
]
for (const entry of synthetic) {
  if (routes.has(entry.key)) continue
  const { price, source } = priceOf(entry.key)
  list.push({
    ...entry,
    total: entry.input + entry.cacheRead + entry.cacheWrite + entry.output,
    price,
    priceSource: source,
    cost: price === null ? null : (entry.input * price.input + entry.cacheRead * price.cacheRead + entry.output * price.output) / 1e6,
  })
}

list.sort((left, right) => (right.cost ?? 0) - (left.cost ?? 0) || (right.total - left.total))
console.log('routes:', list.map(row => `${row.key}(${row.priceSource ?? '未定价'})`))

const table = { 'deepseek-flash': FLASH, 'deepseek-v4-pro': PRO, '*': FLASH }
const extended = {
  today: fixture.today,
  rows: fixture.rows,
  window: fixture.window,
  allTime: fixture.allTime,
  requests: fixture.requests,
  prices: {
    currency: fixture.currency ?? '¥',
    unit: 1000000,
    table,
    defaults: table,
    prompt: { default: 'auto', models: {} },
  },
  routes: list,
  currency: fixture.currency,
  priceNote: fixture.priceNote,
  promptNote: fixture.promptNote,
  generatedAt: fixture.generatedAt,
}

await writeFile(file, `${JSON.stringify(extended, null, 2)}\n`, 'utf8')
console.log(`wrote ${list.length} routes`)
