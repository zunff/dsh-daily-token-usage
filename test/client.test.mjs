// Structural checks for the built Web client: what it registers, what it renders
// from a report payload, and how it degrades when the route fails or is empty.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { renderPage } from './render.mjs'

const fixture = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url), 'utf8'))

const clone = value => JSON.parse(JSON.stringify(value))

// --- registration -----------------------------------------------------------
const ready = await renderPage({ fixture })
assert.equal(ready.id, '@local/daily-token-usage', 'loader id matches the package name')
assert.deepEqual(ready.plugin.inject, ['slots'])

const main = ready.registrations.get('main')
assert.ok(main, 'main panel registered')
assert.equal(main.options.key, 'token-usage')

const sidebar = ready.registrations.get('sidebar.panellist')
assert.ok(sidebar, 'left sidebar row registered')
assert.equal(sidebar.options.id, 'token-usage')
assert.equal(sidebar.options.order, 20)
assert.equal(sidebar.options.label(), '用量')
assert.equal(ready.registrations.get('conversation.composer.dock'), undefined, 'the composer pill is gone')

// --- injected stylesheet ----------------------------------------------------
assert.ok(ready.css.length > 4000, 'stylesheet injected')
assert.match(ready.css, /--dsw-alias-label-primary/, 'colors come from host tokens')
assert.doesNotMatch(ready.css, /-webkit-text-size-adjust/, 'no Tailwind preflight: it would repaint the host app')
assert.doesNotMatch(ready.css, /\*,\s*::?before,\s*::?after\s*\{\s*box-sizing/, 'no global border-box reset')
assert.match(ready.css, /\.dtu-root/, 'page root rules ship with the bundle')

// --- summary ----------------------------------------------------------------
assert.match(ready.html, /今日用量/)
assert.match(ready.html, /今日估算费用/)
assert.match(ready.html, /缓存命中/)
assert.match(ready.html, /最近请求/)
assert.match(ready.html, /单位 tok/)
assert.match(ready.html, /官网价 × 峰谷时段/)
assert.match(ready.html, /现在(高峰|空闲) ×(1|0\.5)/, 'the current billing period is stated, not implied')
assert.match(ready.html, /构成口径/, 'the composition bar switches between tokens and money')
assert.match(ready.html, /7 天/, 'range chooser offers 7 days')
assert.match(ready.html, /30 天/, 'range chooser offers 30 days')

// The range selector drives the whole page: today's headline and the hourly
// chart by default, one window's headline and daily bars when a range is picked.
assert.match(ready.html, /每小时用量/, 'today is the default range')
assert.match(ready.html, />次数</, 'request counts get their own row')
assert.match(ready.html, /高峰/, 'peak hours are named in the legend')
assert.match(ready.html, /空闲/, 'off-peak hours are named in the legend')
assert.match(ready.html, /今天 · .+ · [\d,]+ 次/, 'the header carries the day total and its count')
for (const hour of ['0', '6', '12', '21']) {
  assert.ok(ready.html.includes(`>${hour}<`), `hour tick ${hour}`)
}

const windowed = await renderPage({ fixture, props: { initialRange: 14 } })
assert.match(windowed.html, /每日用量/, 'a numeric range shows days')
assert.match(windowed.html, /最近 14 天用量/, 'the headline follows the range')
assert.match(windowed.html, /14 天估算费用/)
assert.match(windowed.html, /最近 14 天 · .+ · [\d,]+ 次/, 'the chart header carries the window count')
assert.doesNotMatch(windowed.html, />次数</, 'the hourly count row belongs to today only')
assert.doesNotMatch(windowed.html, /现在(高峰|空闲)/, 'the current tariff is a fact about now, not about a window')

// --- request table ----------------------------------------------------------
for (const header of ['时间', '状态', '模型', '未缓存输入', '缓存读取', '输出', '费用', '首字', '耗时']) {
  assert.ok(ready.html.includes(`>${header}<`), `table header ${header}`)
}
const bodyRows = (ready.html.match(/<tr class="border-b/g) ?? []).length
assert.equal(bodyRows, fixture.requests.length + 1, 'one row per settlement plus the header row')
assert.equal((ready.html.match(/>成功</g) ?? []).length, 0, 'a successful request is not labelled')
assert.match(ready.html, /bp-DeepSeek-V4\.1-Flash/, 'the model is named the way the catalog names it')
assert.match(ready.html, /bp-DeepSeek-V4\.1-Flash（deepseek-official\/ds\/deepseek-flash）/, 'the routed id stays reachable')


// --- notes ------------------------------------------------------------------
assert.match(ready.html, /输入口径已折算/, 'the prompt-shape note collapses into one word')
assert.match(ready.html, /单价…/, 'the footer leads to the price editor')
assert.match(ready.html, /1 个路由未定价/, 'an unpriced route is called out')

// --- price panel ------------------------------------------------------------
const panel = ready.html.slice(ready.html.indexOf('role="dialog"'))
assert.ok(panel.length > 0, 'the price panel is mounted')
assert.match(ready.html, /blur-sm hidden"/, 'closed by default')
assert.match(panel, /每百万 token 的高峰价/)
assert.match(panel, /恢复官网价/)
assert.match(panel, /保存/)

const opened = await renderPage({ fixture, props: { initialPricesOpen: true } })
const open = opened.html.slice(opened.html.indexOf('aria-label="单价设置"'))
assert.match(opened.html, /blur-sm flex"/, 'open when asked to be')
for (const route of fixture.routes) {
  assert.ok(open.includes(route.key), `price row ${route.key}`)
}
assert.match(open, /继承自 \*/, 'a row priced by the fallback says so')
assert.match(open, /未定价/, 'a row with no price says so')
assert.equal((open.match(/type="number"/g) ?? []).length, (fixture.routes.length + 1) * 4, 'four inputs per row, plus the fallback row')

// A report from a host half that predates the price table: say why, and offer
// the retry instead of an empty box.
const noPrices = JSON.parse(await readFile(new URL('./fixture-no-prices.json', import.meta.url), 'utf8'))
const degraded = await renderPage({ fixture: noPrices, props: { initialPricesOpen: true } })
assert.match(degraded.html, /这一页还拿不到单价表/)
assert.match(degraded.html, /重启 DSH/)
assert.match(degraded.html, /重新读取/)
assert.doesNotMatch(degraded.html, /每百万 token 的高峰价/, 'no table is promised when there is none')

const degradedHours = await renderPage({ fixture: noPrices })
assert.match(degradedHours.html, /这个报表没有按小时的数据/, 'an old payload says why the hourly tab is empty')

// --- failure ----------------------------------------------------------------
const failed = await renderPage({
  fixture,
  fetchImpl: async () => { throw new Error('boom') },
})
assert.match(failed.html, /无法读取本地用量数据/)
assert.match(failed.html, /重试/)

// --- empty --------------------------------------------------------------
const empty = clone(fixture)
empty.requests = []
empty.rows = empty.rows.map(row => ({ ...row, total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0 }))
empty.today = { ...empty.today, total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0, costParts: null }
empty.hours = empty.hours.map(hour => ({ ...hour, total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0 }))
const blank = await renderPage({ fixture: empty })
assert.match(blank.html, /还没有请求记录/)
assert.match(blank.html, /今天还没有记录/)
// The label follows the payload's own window, not the clicked tab.
const blankWindow = await renderPage({ fixture: empty, props: { initialRange: 7 } })
assert.match(blankWindow.html, /最近 14 天还没有记录/)

// --- failed attempt ---------------------------------------------------------
const withFailure = clone(fixture)
withFailure.requests = withFailure.requests.slice(0, 3).map(row => ({ ...row, failed: true }))
const failureRow = await renderPage({ fixture: withFailure })
assert.match(failureRow.html, /失败/)

console.log('ALL CLIENT ASSERTIONS PASSED')
