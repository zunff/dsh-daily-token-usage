import React from 'react'
import { Card, CardTitle } from './components/ui/card.jsx'
import { Button } from './components/ui/button.jsx'
import { BANDS, ChartLegend, DailyChart } from './chart.jsx'
import { RequestsTable } from './requests-table.jsx'
import { PricePanel } from './price-panel.jsx'
import { POLL_MS, useMeasuredWidth, useReport } from './api.js'
import { cacheHit, group, isPeak, money, pad2, percent, scale, todayKey, tokens } from './format.js'
import { cn } from './lib/utils.js'

const WINDOWS = [7, 14, 30]

/** Two-option switch: the window, and the composition bar's unit. */
function Segmented({ value, options, onChange, label }) {
  return (
    <div
      className="flex items-center gap-px rounded-md border border-line bg-surface/60 p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value ? 'true' : 'false'}
          className={cn(
            'rounded-[5px] px-1.5 py-0.5 text-[10.5px]',
            option.value === value
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-subtle-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function MetricLegend({ bands, total, currency, costMode }) {
  return (
    <div
      className="mt-2.5 grid gap-x-6 gap-y-2"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, bands.length)}, minmax(0, 1fr))` }}
    >
      {bands.map(band => (
        <div key={band.key}>
          <div className="flex items-center gap-1.5 text-[10px] text-subtle-foreground">
            <span className="h-[7px] w-[7px] shrink-0 rounded-[2px]" style={{ background: band.color }} />
            {band.label}
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-[16px] font-semibold leading-none tabular-nums">
              {costMode ? money(band.value, currency) : scale(band.value)}
            </span>
            <span className="text-[10px] text-subtle-foreground">{percent(band.value, total)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function Summary({ today, currency, costMode, onCostMode, peak }) {
  const hit = cacheHit(today)
  const parts = today.costParts ?? null
  const byCost = costMode && parts !== null
  const bands = BANDS
    .filter(band => band.key !== 'cacheWrite' || today.cacheWrite > 0)
    .map(band => ({ ...band, value: byCost ? (parts[band.key] ?? 0) : (today[band.key] || 0) }))
  const splitTotal = byCost ? parts.total : today.total
  const cost = today.cost === null || today.cost === undefined ? '未配置' : money(today.cost, currency)
  // A 99%-cache day makes the token split unreadable: two bands collapse to a
  // pixel. The same split priced in money is where the reading actually is.
  const canSwitch = parts !== null && parts.total > 0

  return (
    <Card className="shrink-0 border-line bg-surface/50 px-4 pb-3 pt-3">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <div className="text-[11px] text-subtle-foreground">今日用量</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-[34px] font-semibold leading-none tracking-tight">{scale(today.total)}</span>
            <span className="text-[12px] text-muted-foreground">tok</span>
          </div>
          <div className="mt-2 text-[11px] text-subtle-foreground">{group(today.requests)} 次结算</div>
        </div>
        <div className="flex items-start gap-10 text-right">
          <div>
            <div className="text-[11px] text-subtle-foreground">缓存命中</div>
            <div className="mt-1 text-[20px] font-semibold leading-none tracking-tight">{hit === null ? '—' : hit}</div>
            <div className="mt-1.5 text-[10px] text-subtle-foreground">按输入 token 计</div>
          </div>
          <div>
            <div className="text-[11px] text-subtle-foreground">今日估算费用</div>
            <div className="mt-1 flex items-baseline justify-end gap-1.5">
              <span className="text-[20px] font-semibold leading-none tracking-tight">{cost}</span>
              <span
                className="rounded bg-surface px-1 py-px text-[9.5px] leading-none text-muted-foreground"
                title="北京时区工作日 09:00–12:00、14:00–18:00 按全价估算，其余时间按 5 折；法定节假日不作特殊处理。"
              >
                现在{peak ? '高峰 ×1' : '空闲 ×0.5'}
              </span>
            </div>
            <div className="mt-1.5 text-[10px] text-subtle-foreground">官网价 × 峰谷时段</div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="flex h-2 min-w-0 flex-1 gap-px overflow-hidden rounded-full bg-surface">
          {bands.map(band => (
            band.value > 0 ? (
              <div
                key={band.key}
                style={{ width: `${band.value / Math.max(1e-9, splitTotal) * 100}%`, background: band.color }}
              />
            ) : null
          ))}
        </div>
        {canSwitch ? (
          <Segmented
            value={byCost ? 'cost' : 'token'}
            onChange={next => onCostMode(next === 'cost')}
            label="构成口径"
            options={[{ value: 'token', label: 'token' }, { value: 'cost', label: '费用' }]}
          />
        ) : null}
      </div>
      <MetricLegend bands={bands} total={splitTotal} currency={currency} costMode={byCost} />
    </Card>
  )
}

function DailyCard({ rows, window, hasWrite, currency }) {
  const [chartRef, chartWidth] = useMeasuredWidth(1120)
  const firstRecorded = rows.findIndex(row => row.total > 0)
  const visible = firstRecorded === -1 ? [] : rows.slice(firstRecorded)
  const cost = window.cost === null || window.cost === undefined ? null : money(window.cost, currency)

  return (
    <Card className="shrink-0 px-4 pb-2 pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <CardTitle>每日用量</CardTitle>
        <span className="text-[11px] text-subtle-foreground">
          最近 {window.days} 天 · {tokens(window.total)}
          {cost === null ? '' : ` · ${cost}`}
        </span>
        <div className="flex-1" />
        <ChartLegend showWrite={hasWrite} />
      </div>
      <div ref={chartRef} className="mt-1">
        {visible.length === 0 ? (
          <div className="flex h-[178px] items-center justify-center text-[11px] text-subtle-foreground">
            最近 {window.days} 天还没有记录
          </div>
        ) : (
          <DailyChart rows={visible} width={chartWidth} showWrite={hasWrite} currency={currency} />
        )}
      </div>
    </Card>
  )
}

/**
 * One line of totals instead of three lines of prose. The price list, the input
 * shape, and the "not a bill" caveat live in the price panel now; what stays
 * here is what changes per refresh plus the way into that panel.
 */
function Footer({ allTime, promptNote, unpriced, currency, onOpenPrices }) {
  const cost = allTime.cost === null || allTime.cost === undefined ? null : money(allTime.cost, currency)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] leading-relaxed text-subtle-foreground">
      <span>
        累计 {tokens(allTime.total)} · {group(allTime.requests)} 次结算
        {cost === null ? '' : ` · 约 ${cost}`}
        {` · ${group(allTime.days)} 天 · ${group(allTime.sessions)} 个会话`}
        {allTime.since ? ` · 自 ${allTime.since}` : ''}
      </span>
      {unpriced > 0 ? (
        <span className="text-warn" title="未定价的路由按 0 估算，金额会偏低">
          · {unpriced} 个路由未定价
        </span>
      ) : null}
      <div className="flex-1" />
      {promptNote ? (
        <span className="max-w-[340px] truncate" title={promptNote}>
          输入口径已折算
        </span>
      ) : null}
      <span>官网价 × 峰谷 · 非账单</span>
      <Button variant="ghost" size="sm" className="px-1.5" onClick={onOpenPrices} title="编辑每个路由的单价">
        单价…
      </Button>
    </div>
  )
}

/** Main-column page opened from the left sidebar row. `initialPricesOpen` is for the preview renderer. */
export function UsagePage({ initialPricesOpen = false } = {}) {
  const [days, setDays] = React.useState(14)
  const [costMode, setCostMode] = React.useState(false)
  const [pricesOpen, setPricesOpen] = React.useState(initialPricesOpen)
  const report = useReport(days)
  const data = report.data

  if (data === undefined) {
    return (
      <div
        className="dtu-root flex h-full flex-col items-center justify-center gap-2 text-[11px] text-subtle-foreground"
        role="region"
        aria-label="用量"
      >
        {report.status === 'error' ? (
          <>
            <span>无法读取本地用量数据。</span>
            <Button onClick={report.retry}>重试</Button>
          </>
        ) : (
          <span>正在读取用量…</span>
        )}
      </div>
    )
  }

  const today = data.today
  const currency = data.currency || '¥'
  const requests = Array.isArray(data.requests) ? data.requests : []
  const updated = new Date(data.generatedAt)
  const updatedAt = `${pad2(updated.getHours())}:${pad2(updated.getMinutes())}:${pad2(updated.getSeconds())}`
  const hasWrite = data.window.cacheWrite > 0
  const routes = Array.isArray(data.routes) ? data.routes : []
  const unpriced = routes.filter(route => route.price === null).length

  return (
    <div
      className="dtu-root relative flex h-full min-h-0 flex-col gap-3 overflow-hidden px-5 py-4 text-foreground"
      role="region"
      aria-label="用量"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <h1 className="text-[13px] font-semibold">用量</h1>
        <span className="text-[11px] text-subtle-foreground">更新于 {updatedAt}</span>
        <div className="flex-1" />
        <Segmented
          value={days}
          onChange={setDays}
          label="统计窗口"
          options={WINDOWS.map(value => ({ value, label: `${value} 天` }))}
        />
        <Button
          variant="outline"
          size="sm"
          className="w-16 justify-center"
          onClick={report.retry}
          aria-busy={report.refreshing ? 'true' : 'false'}
          title={`每 ${POLL_MS / 1000} 秒自动刷新`}
        >
          {report.refreshing ? '刷新中…' : '刷新'}
        </Button>
      </div>

      {report.status === 'error' ? (
        <div className="shrink-0 rounded-lg border border-danger/30 bg-danger/5 px-3 py-1.5 text-[11px] text-danger">
          刷新失败（{report.error}），下面是上次的结果。
        </div>
      ) : null}

      <Summary today={today} currency={currency} costMode={costMode} onCostMode={setCostMode} peak={isPeak()} />
      <DailyCard rows={data.rows} window={data.window} hasWrite={hasWrite} currency={currency} />

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
          <CardTitle>最近请求</CardTitle>
          <span className="text-[11px] text-subtle-foreground">
            最近 {group(requests.length)} 条 · 单位 tok
          </span>
          <div className="flex-1" />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <RequestsTable rows={requests} currency={currency} today={todayKey()} />
        </div>
      </Card>

      <Footer
        allTime={data.allTime}
        promptNote={data.promptNote}
        unpriced={unpriced}
        currency={currency}
        onOpenPrices={() => setPricesOpen(true)}
      />

      <PricePanel
        open={pricesOpen}
        data={data}
        currency={currency}
        onClose={() => setPricesOpen(false)}
        onSaved={report.retry}
      />
    </div>
  )
}
