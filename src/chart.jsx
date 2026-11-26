import React from 'react'
import { group, money, niceMax, percent } from './format.js'

/**
 * Colors come from host tokens so light and dark themes follow. The cache band
 * dominates every day, so it is mixed toward the brand hue instead of using the
 * neutral chart-system grey alone: a page that is 99% grey reads as disabled.
 */
const TONE = {
  brand: 'var(--dsw-alias-chart-messages, #4c8dff)',
  // Cache reads are the cheap bulk — usually ~97% of the tokens — so they are a
  // light tint. The paid bands then read as crisp caps on a pale body instead of
  // one flat slab of a single hue.
  cache: 'color-mix(in oklab, var(--dsw-alias-chart-system, #9aa7bd) 72%, var(--dsw-alias-bg-layer-1, #ffffff))',
  output: 'var(--dsw-alias-chart-tools, #9a7cff)',
  write: 'var(--dsw-alias-state-warn-primary, #d49b00)',
  grid: 'var(--dsw-alias-border-l1, rgba(20, 22, 30, 0.10))',
  axis: 'var(--dsw-alias-label-tertiary, #8b909a)',
  highlight: 'var(--dsw-alias-bg-layer-2, #f5f6f7)',
  // Peak hours are the ones that bill at full price; the tint is the warning hue.
  peakBand: 'color-mix(in oklab, var(--dsw-alias-state-warn-primary, #d49b00) 12%, transparent)',
  offBand: 'color-mix(in oklab, var(--dsw-alias-chart-system, #9aa7bd) 7%, transparent)',
  count: 'color-mix(in oklab, var(--dsw-alias-chart-messages, #4c8dff) 45%, var(--dsw-alias-chart-system, #9aa7bd))',
}

/** Stacks bottom-up, so the muted cache band grounds every bar. */
export const BANDS = [
  { key: 'cacheRead', label: '缓存读取', color: TONE.cache },
  { key: 'input', label: '未缓存输入', color: TONE.brand },
  { key: 'output', label: '输出', color: TONE.output },
  { key: 'cacheWrite', label: '缓存写入', color: TONE.write },
]

function stacks(row, showWrite) {
  const parts = [
    { key: 'cacheRead', value: row.cacheRead, color: TONE.cache },
    { key: 'input', value: row.input, color: TONE.brand },
  ]
  if (showWrite) parts.push({ key: 'cacheWrite', value: row.cacheWrite, color: TONE.write })
  parts.push({ key: 'output', value: row.output, color: TONE.output })
  return parts
}

function Swatch({ color }) {
  return <span className="h-[7px] w-[7px] shrink-0 rounded-[2px]" style={{ background: color }} />
}

/** Axis tick labels in Chinese scale, so 2.5亿 stays one short string. */
function axisFor(max) {
  const unit = max >= 1e8 ? '亿' : max >= 1e4 ? '万' : ''
  return value => {
    if (value === 0) return '0'
    if (unit === '亿') return `${Number((value / 1e8).toFixed(2))}亿`
    if (unit === '万') return `${Number((value / 1e4).toFixed(max < 1e5 ? 1 : 0))}万`
    return String(Math.round(value))
  }
}

export function DailyChart({ rows, width, showWrite, currency = '¥' }) {
  const [active, setActive] = React.useState(-1)

  const height = 178
  const left = 46
  const right = 4
  const top = 10
  const bottom = 20
  const plotWidth = Math.max(140, width - left - right)
  const plotHeight = height - top - bottom

  const totals = rows.map(row => row.input + row.cacheRead + row.cacheWrite + row.output)
  const max = niceMax(Math.max(1, ...totals))
  const axisText = axisFor(max)

  const slot = Math.min(plotWidth / Math.max(1, rows.length), 110)
  const span = slot * rows.length
  const offset = left + (plotWidth - span) / 2
  const barWidth = Math.max(8, Math.min(64, slot * 0.62))
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7))

  const ticks = [0, 0.5, 1].map(ratio => ({
    value: max * ratio,
    y: top + plotHeight - plotHeight * ratio,
  }))

  const activeRow = active >= 0 && active < rows.length ? rows[active] : undefined
  const tooltipX = activeRow === undefined
    ? 0
    : Math.min(Math.max(offset + active * slot + slot / 2, 96), Math.max(96, width - 96))

  return (
    <div className="relative" style={{ height }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`最近 ${rows.length} 天每日 token 用量`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {ticks.map(tick => (
          <g key={tick.value}>
            <line
              x1={left}
              x2={width - right}
              y1={tick.y}
              y2={tick.y}
              stroke={TONE.grid}
              strokeWidth={tick.value === 0 ? 1 : 0.75}
            />
            <text x={left - 8} y={tick.y + 3} textAnchor="end" fontSize={10} fill={TONE.axis}>
              {axisText(tick.value)}
            </text>
          </g>
        ))}

        {activeRow === undefined ? null : (
          <rect
            x={offset + active * slot + 1}
            y={top}
            width={Math.max(4, slot - 2)}
            height={plotHeight}
            rx={6}
            fill={TONE.highlight}
          />
        )}

        {rows.map((row, index) => {
          const parts = stacks(row, showWrite)
          const x = offset + index * slot + (slot - barWidth) / 2
          let cursor = top + plotHeight
          const segments = parts.map((part, partIndex) => {
            if (part.value <= 0) return null
            const segmentHeight = Math.max(1, plotHeight * (part.value / max))
            const y = cursor - segmentHeight
            const isTop = parts.slice(partIndex + 1).every(next => next.value <= 0)
            cursor = y
            return (
              <rect
                key={part.key}
                x={x}
                y={y}
                width={barWidth}
                height={segmentHeight}
                rx={isTop ? 3 : 0}
                fill={part.color}
                opacity={activeRow === undefined || active === index ? 1 : 0.45}
              />
            )
          })
          return (
            <g key={row.date}>
              {totals[index] > 0 ? segments : (
                <rect
                  x={x}
                  y={top + plotHeight - 2}
                  width={barWidth}
                  height={2}
                  rx={1}
                  fill={TONE.grid}
                />
              )}
              {index % labelEvery === 0 ? (
                <text
                  x={offset + index * slot + slot / 2}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize={10}
                  fill={TONE.axis}
                >
                  {row.date.slice(5)}
                </text>
              ) : null}
            </g>
          )
        })}

        {rows.map((row, index) => (
          <rect
            key={`hit-${row.date}`}
            x={offset + index * slot}
            y={top}
            width={slot}
            height={plotHeight}
            fill="transparent"
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(previous => (previous === index ? -1 : previous))}
          />
        ))}
      </svg>

      {activeRow === undefined ? null : (
        <div
          className="pointer-events-none absolute z-10 w-[176px] -translate-x-1/2 rounded-lg border border-line bg-background/95 px-2.5 py-2 shadow-sm backdrop-blur"
          style={{ left: tooltipX, top: 2 }}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-foreground">{activeRow.date}</span>
            <span className="text-[10px] text-subtle-foreground">{group(activeRow.requests)} 次</span>
          </div>
          {stacks(activeRow, showWrite)
            .filter(part => part.value > 0)
            .map(part => (
              <div key={part.key} className="flex items-center justify-between gap-2 py-[1px]">
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Swatch color={part.color} />
                  {BANDS.find(band => band.key === part.key).label}
                </span>
                <span className="text-[10px] text-foreground">
                  {percent(part.value, totals[active])}
                </span>
              </div>
            ))}
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-line pt-1 text-[10px] text-subtle-foreground">
            <span>合计 {group(totals[active])} tok</span>
            <span className="text-foreground">
              {activeRow.cost === null || activeRow.cost === undefined
                ? ''
                : money(activeRow.cost, currency)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Today, hour by hour. The plot carries two readings: the stacked token bars a
 * day is made of, and a thin row of request counts under them, because a cheap
 * hour with many calls and an expensive hour with one call are different facts.
 * Peak hours are the ones that bill at full price, so the background says which
 * is which instead of leaving it to the reader's knowledge of the tariff.
 */
export function HourlyChart({ rows, width, showWrite, currency = '¥' }) {
  const [active, setActive] = React.useState(-1)

  const height = 176
  const left = 46
  const right = 4
  const top = 8
  const plotHeight = 112
  const stripTop = top + plotHeight + 8
  const stripHeight = 16
  const axisY = stripTop + stripHeight + 14

  const plotWidth = Math.max(200, width - left - right)
  const slot = plotWidth / 24
  const barWidth = Math.max(4, Math.min(26, slot * 0.62))
  const totals = rows.map(row => row.total)
  const max = niceMax(Math.max(1, ...totals))
  const axisText = axisFor(max)
  const maxRequests = Math.max(1, ...rows.map(row => row.requests))
  const nowHour = new Date().getHours()

  const ticks = [0, 0.5, 1].map(ratio => ({
    value: max * ratio,
    y: top + plotHeight - plotHeight * ratio,
  }))

  // Contiguous runs of the same tariff, painted behind the bars.
  const runs = []
  for (let hour = 0; hour < 24; hour += 1) {
    const peak = rows[hour]?.peak === true
    const last = runs[runs.length - 1]
    if (last !== undefined && last.peak === peak) last.to = hour
    else runs.push({ from: hour, to: hour, peak })
  }

  const activeRow = active >= 0 && active < rows.length ? rows[active] : undefined
  const tooltipX = activeRow === undefined
    ? 0
    : Math.min(Math.max(left + active * slot + slot / 2, 92), Math.max(92, width - 92))

  return (
    <div className="relative" style={{ height }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="今日每小时 token 用量与结算次数"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {runs.map(run => (
          <rect
            key={`band-${run.from}`}
            x={left + run.from * slot}
            y={top}
            width={Math.max(1, (run.to - run.from + 1) * slot)}
            height={plotHeight}
            fill={run.peak ? TONE.peakBand : TONE.offBand}
          />
        ))}

        {ticks.map(tick => (
          <g key={tick.value}>
            <line
              x1={left}
              x2={width - right}
              y1={tick.y}
              y2={tick.y}
              stroke={TONE.grid}
              strokeWidth={tick.value === 0 ? 1 : 0.75}
            />
            <text x={left - 8} y={tick.y + 3} textAnchor="end" fontSize={10} fill={TONE.axis}>
              {axisText(tick.value)}
            </text>
          </g>
        ))}

        {rows.map((row, hour) => {
          const x = left + hour * slot + (slot - barWidth) / 2
          let cursor = top + plotHeight
          const parts = stacks(row, showWrite)
          return (
            <g key={`hour-${hour}`}>
              {parts.map((part, partIndex) => {
                if (part.value <= 0) return null
                const segmentHeight = Math.max(0.5, plotHeight * (part.value / max))
                const y = cursor - segmentHeight
                const isTop = parts.slice(partIndex + 1).every(next => next.value <= 0)
                cursor = y
                return (
                  <rect
                    key={part.key}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={segmentHeight}
                    rx={isTop ? 2 : 0}
                    fill={part.color}
                    opacity={activeRow === undefined || active === hour ? 1 : 0.5}
                  />
                )
              })}
            </g>
          )
        })}

        {/* Request counts, one thin bar per hour, on their own scale. */}
        <text x={left - 8} y={stripTop + stripHeight - 2} textAnchor="end" fontSize={9.5} fill={TONE.axis}>
          次数
        </text>
        {rows.map((row, hour) => {
          if (row.requests <= 0) return null
          const barHeight = Math.max(2, stripHeight * (row.requests / maxRequests))
          return (
            <rect
              key={`count-${hour}`}
              x={left + hour * slot + (slot - barWidth) / 2}
              y={stripTop + stripHeight - barHeight}
              width={barWidth}
              height={barHeight}
              rx={1.5}
              fill={TONE.count}
              opacity={activeRow === undefined || active === hour ? 0.9 : 0.35}
            />
          )
        })}

        {[0, 3, 6, 9, 12, 15, 18, 21].map(hour => (
          <text
            key={`tick-${hour}`}
            x={left + hour * slot + slot / 2}
            y={axisY}
            textAnchor="middle"
            fontSize={10}
            fill={TONE.axis}
          >
            {hour}
          </text>
        ))}
        <text x={left - 8} y={axisY} textAnchor="end" fontSize={9.5} fill={TONE.axis}>
          时
        </text>

        {nowHour >= 0 && nowHour < 24 ? (
          <line
            x1={left + nowHour * slot + slot / 2}
            x2={left + nowHour * slot + slot / 2}
            y1={top}
            y2={stripTop + stripHeight}
            stroke={TONE.brand}
            strokeWidth={1}
            strokeDasharray="2 3"
            opacity={0.8}
          />
        ) : null}

        {rows.map((row, hour) => (
          <rect
            key={`hit-${hour}`}
            x={left + hour * slot}
            y={top}
            width={slot}
            height={axisY - top}
            fill="transparent"
            onMouseEnter={() => setActive(hour)}
            onMouseLeave={() => setActive(previous => (previous === hour ? -1 : previous))}
          />
        ))}
      </svg>

      {activeRow === undefined ? null : (
        <div
          className="pointer-events-none absolute z-10 w-[168px] -translate-x-1/2 rounded-lg border border-line bg-background/95 px-2.5 py-2 shadow-sm backdrop-blur"
          style={{ left: tooltipX, top: 2 }}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-foreground">
              {String(active).padStart(2, '0')}:00–{String(active + 1).padStart(2, '0')}:00
            </span>
            <span className={activeRow.peak ? 'text-[9.5px] text-warn' : 'text-[9.5px] text-subtle-foreground'}>
              {activeRow.peak ? '高峰 ×1' : '空闲 ×0.5'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 py-[1px]">
            <span className="text-[10px] text-muted-foreground">结算次数</span>
            <span className="text-[10px] text-foreground">{group(activeRow.requests)} 次</span>
          </div>
          <div className="flex items-center justify-between gap-2 py-[1px]">
            <span className="text-[10px] text-muted-foreground">合计</span>
            <span className="text-[10px] text-foreground">{group(activeRow.total)} tok</span>
          </div>
          {activeRow.cost === null || activeRow.cost === undefined ? null : (
            <div className="mt-1 flex items-center justify-between gap-2 border-t border-line pt-1 text-[10px] text-subtle-foreground">
              <span>估算</span>
              <span className="text-foreground">{money(activeRow.cost, currency)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ChartLegend({ showWrite, peakBands = false }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
      {BANDS.filter(band => showWrite || band.key !== 'cacheWrite').map(band => (
        <span key={band.key} className="flex items-center gap-1 text-[10px] text-subtle-foreground">
          <Swatch color={band.color} />
          {band.label}
        </span>
      ))}
      {peakBands ? (
        <>
          <span className="flex items-center gap-1 text-[10px] text-subtle-foreground">
            <span className="h-[7px] w-[7px] shrink-0 rounded-[2px]" style={{ background: TONE.peakBand, boxShadow: 'inset 0 0 0 1px rgba(212,155,0,0.35)' }} />
            高峰
          </span>
          <span className="flex items-center gap-1 text-[10px] text-subtle-foreground">
            <span className="h-[7px] w-[7px] shrink-0 rounded-[2px]" style={{ background: TONE.offBand }} />
            空闲
          </span>
        </>
      ) : null}
    </div>
  )
}
