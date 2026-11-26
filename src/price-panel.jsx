import React from 'react'
import { Button } from './components/ui/button.jsx'
import { cn } from './lib/utils.js'
import { money, scale } from './format.js'
import { savePrices } from './api.js'

/** One row's four billable inputs, in the order the price file stores them. */
const FIELDS = [
  { key: 'input', label: '未命中' },
  { key: 'cacheRead', label: '命中' },
  { key: 'cacheWrite', label: '写入' },
  { key: 'output', label: '输出' },
]

const FALLBACK_KEY = '*'

/** Unit phrase for the column header prose: the price is per this many tokens. */
function unitLabel(unit) {
  if (unit === 1000000) return '百万'
  return Math.round(unit).toLocaleString('en-US')
}

/** The value to show: the edit in progress, else the price currently in force. */
function fieldValue(edit, price, field) {
  if (edit !== undefined && edit[field] !== undefined) return edit[field]
  if (price === null || price === undefined) return ''
  const value = price[field]
  return typeof value === 'number' ? String(value) : ''
}

/**
 * Price editor for the routes this profile actually used, plus the `*`
 * fallback. Rows start from the price in force (which may be inherited from a
 * family or from `*`), and only edited rows are sent, so opening the panel and
 * closing it cannot rewrite a hand-maintained price file.
 */
export function PricePanel({ open, data, currency = '¥', onClose, onSaved }) {
  const [edits, setEdits] = React.useState({})
  const [status, setStatus] = React.useState('idle')
  const [message, setMessage] = React.useState('')
  const [resetArmed, setResetArmed] = React.useState(false)

  // Abandoned edits must not survive a close, or the next open would show values
  // the file does not have.
  React.useEffect(() => {
    if (open) return
    setEdits({})
    setStatus('idle')
    setMessage('')
    setResetArmed(false)
  }, [open])

  React.useEffect(() => {
    if (!open || typeof document.addEventListener !== 'function') return undefined
    const onKey = event => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const prices = data?.prices
  const unit = typeof prices?.unit === 'number' ? prices.unit : 1000000
  const routes = Array.isArray(data?.routes) ? data.routes : []
  const fallbackPrice = prices?.table?.[FALLBACK_KEY] ?? null
  const rows = routes.map(route => ({ ...route, fallback: false }))
  rows.push({
    key: FALLBACK_KEY,
    provider: '',
    model: '',
    total: null,
    requests: null,
    cost: null,
    price: fallbackPrice,
    priceSource: fallbackPrice === null ? null : FALLBACK_KEY,
    fallback: true,
  })
  const editedKeys = Object.keys(edits)
  const canSave = editedKeys.length > 0 && status !== 'saving'

  const editField = (key, field, value) => {
    setStatus('idle')
    setMessage('')
    setEdits(previous => {
      const price = previous[key] ?? {}
      const fields = { ...price, [field]: value }
      // Typing back to the value in force leaves nothing to write for this row.
      return { ...previous, [key]: fields }
    })
  }

  /** Edited rows only, parsed and validated; throws with the row that is wrong. */
  const collect = () => {
    const models = {}
    for (const key of editedKeys) {
      const edit = edits[key] ?? {}
      const price = {}
      for (const field of FIELDS) {
        const raw = String(edit[field.key] ?? '').trim()
        const value = raw === '' ? 0 : Number(raw)
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`「${key}」的${field.label}不是有效单价`)
        }
        price[field.key] = value
      }
      models[key] = price
    }
    return models
  }

  const submit = async patch => {
    setStatus('saving')
    setMessage('')
    try {
      await savePrices(patch)
      setStatus('saved')
      setEdits({})
      if (typeof onSaved === 'function') onSaved()
      onClose()
    } catch (error) {
      setStatus('error')
      setMessage(String(error?.message ?? error))
    }
  }

  const save = () => {
    let models
    try {
      models = collect()
    } catch (error) {
      setStatus('error')
      setMessage(String(error?.message ?? error))
      return
    }
    void submit({ models })
  }

  const reset = () => {
    if (!resetArmed) {
      setResetArmed(true)
      setMessage('')
      return
    }
    setResetArmed(false)
    void submit({ reset: true })
  }

  const unpriced = rows.filter(row => !row.fallback && row.price === null).length

  return (
    <div
      className={cn(
        'absolute inset-0 z-20 items-center justify-center bg-background/70 p-6 backdrop-blur-sm',
        // One display utility only: a stale `.flex` would beat `.hidden`.
        open ? 'flex' : 'hidden',
      )}
      role="dialog"
      aria-modal="true"
      aria-label="单价设置"
      hidden={!open}
    >
      <div className="flex max-h-full w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-line bg-background shadow-lg">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-[13px] font-semibold text-foreground">单价</h2>
            <p className="mt-0.5 text-[10.5px] text-subtle-foreground">
              每{unitLabel(unit)} token 的高峰价（{currency}）；空闲时段按 5 折估算，只影响金额，不改 token 计数。
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭" title="关闭">
            ✕
          </Button>
        </div>

        {prices === undefined ? (
          <div className="px-4 py-8 text-center text-[11px] text-subtle-foreground">
            当前报表没有单价表：宿主端插件需要更新后重启 DSH，刷新本页再试。
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="grid grid-cols-[minmax(0,1fr)_70px_70px_58px_58px_92px] items-center gap-x-2 border-b border-line bg-surface/40 px-4 py-1.5 text-[10px] text-subtle-foreground">
              <span>路由</span>
              {FIELDS.map(field => (
                <span key={field.key} className="text-right">{field.label}</span>
              ))}
              <span className="text-right">已用</span>
            </div>
            {rows.map(row => {
              const edit = edits[row.key]
              const dirty = edit !== undefined
              return (
                <div
                  key={row.key}
                  className={cn(
                    'grid grid-cols-[minmax(0,1fr)_70px_70px_58px_58px_92px] items-center gap-x-2 border-b border-line px-4 py-1.5',
                    dirty && 'bg-brand/5',
                  )}
                >
                  <div className="min-w-0">
                    <div className={cn('truncate text-[11px]', row.fallback ? 'text-muted-foreground' : 'text-foreground')} title={row.fallback ? '没有单独定价的路由都按这一行计费' : row.key}>
                      {row.fallback ? '* 兜底价（其余路由）' : row.key}
                    </div>
                    <div className="mt-0.5 truncate text-[9.5px] text-subtle-foreground">
                      {row.fallback
                        ? (fallbackPrice === null ? '未设置：未定价路由不估算金额' : '未单独定价的路由按此行计费')
                        : row.price === null
                          ? '未定价：这一路由不计入金额'
                          : row.priceSource === row.key
                            ? `已设单价${row.cost === null ? '' : ` · 约 ${money(row.cost, currency)}`}`
                            : `继承自 ${row.priceSource}`}
                    </div>
                  </div>
                  {FIELDS.map(field => (
                    <input
                      key={field.key}
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      aria-label={`${row.fallback ? '兜底价' : row.key}的${field.label}单价`}
                      value={fieldValue(edit, row.price, field.key)}
                      placeholder="—"
                      onChange={event => editField(row.key, field.key, event.target.value)}
                      className="h-6 w-full rounded border border-line bg-background px-1.5 text-right text-[11px] tabular-nums text-foreground outline-none placeholder:text-subtle-foreground focus:border-line-strong"
                    />
                  ))}
                  <div className="truncate text-right text-[10.5px] text-subtle-foreground" title={row.requests === null ? undefined : `${row.requests} 次结算`}>
                    {row.total === null ? '—' : scale(row.total)}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          <span className="text-[10.5px] text-subtle-foreground">
            {status === 'error' ? <span className="text-danger">{message}</span> : null}
            {status === 'error' ? null : unpriced > 0 ? (
              <span className="text-warn">{unpriced} 个路由未定价，编辑对应行即可补上</span>
            ) : (
              '改完保存，下一次报表生效'
            )}
          </span>
          <div className="flex-1" />
          <Button
            variant={resetArmed ? 'outline' : 'ghost'}
            className={cn(resetArmed && 'text-danger')}
            onClick={reset}
            disabled={prices === undefined || status === 'saving'}
            title="删除所有自定义单价，回到内置官网价"
          >
            {resetArmed ? '再点一次确认' : '恢复官网价'}
          </Button>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="subtle"
            className="bg-brand text-white hover:bg-brand hover:text-white"
            onClick={save}
            disabled={!canSave}
            aria-busy={status === 'saving' ? 'true' : 'false'}
          >
            {status === 'saving' ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}
