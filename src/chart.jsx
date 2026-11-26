import React from 'react'
import { group, money, niceMax, percent } from './format.js'

const TONE = {
  brand: 'var(--dsw-alias-chart-messages, #4c8dff)',
  cache: 'var(--dsw-alias-chart-system, #9aa7bd)',
  output: 'var(--dsw-alias-chart-tools, #9a7cff)',
  write: 'var(--dsw-alias-state-warn-primary, #d49b00)',
  grid: 'var(--dsw-alias-border-l1, rgba(20, 22, 30, 0.10))',
  axis: 'var(--dsw-alias-label-tertiary, #8b909a)',
  highlight: 'var(--dsw-alias-bg-layer-2, #f5f6f7)',
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
  const axisUnit = max >= 1e8 ? '亿' : max >= 1e4 ? '万' : ''
  const axisText = value => {
    if (value === 0) return '0'
    if (axisUnit === '亿') return `${Number((value / 1e8).toFixed(2))}亿`
    if (axisUnit === '万') return `${Number((value / 1e4).toFixed(max < 1e5 ? 1 : 0))}万`
    return String(Math.round(value))
  }

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

export function ChartLegend({ showWrite }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {BANDS.filter(band => showWrite || band.key !== 'cacheWrite').map(band => (
        <span key={band.key} className="flex items-center gap-1 text-[10px] text-subtle-foreground">
          <Swatch color={band.color} />
          {band.label}
        </span>
      ))}
    </div>
  )
}
