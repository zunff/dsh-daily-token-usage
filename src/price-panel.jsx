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
export function PricePanel({ open, data, currency = '¥', onClose, onSaved, onRetry }) {
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
      <div className="flex max-h-full w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-line-strong bg-background shadow-xl">
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-4">
          <div>
            <h2 className="text-[13px] font-semibold text-foreground">单价</h2>
            {prices === undefined ? null : (
              <p className="mt-1 text-[11px] text-subtle-foreground">
                每{unitLabel(unit)} token 的高峰价（{currency}），空闲时段按 5 折估算；只影响金额，不改 token 计数。
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="-mr-1.5 -mt-0.5 shrink-0 text-subtle-foreground"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            ✕
          </Button>
        </div>

        {prices === undefined ? (
          <div className="border-t border-line px-5 py-10 text-center">
            <div className="text-[12px] font-medium text-foreground">这一页还拿不到单价表</div>
            <p className="mx-auto mt-1.5 max-w-[420px] text-[11px] leading-relaxed text-subtle-foreground">
              报表来自旧版宿主端（<code className="rounded bg-surface px-1 py-0.5 text-[10px]">index.js</code> 重启后才生效），
              所以这里没有价格可以列。重启 DSH，再刷新本页。
            </p>
            <Button variant="outline" size="sm" className="mt-3.5" onClick={onRetry}>
              重新读取
            </Button>          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto border-t border-line">
            <div className="grid grid-cols-[minmax(0,1fr)_70px_70px_58px_58px_92px] items-center gap-x-2 border-b border-line bg-surface/50 px-5 py-2 text-[10px] font-medium text-subtle-foreground">
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
                    'grid grid-cols-[minmax(0,1fr)_70px_70px_58px_58px_92px] items-center gap-x-2 border-b border-line px-5 py-2 transition-colors last:border-b-0 hover:bg-surface/40',
                    dirty && 'bg-brand/5 hover:bg-brand/5',
                  )}
                >
                  <div className="min-w-0">
                    <div className={cn('truncate text-[11.5px]', row.fallback ? 'text-muted-foreground' : 'text-foreground')} title={row.fallback ? '没有单独定价的路由都按这一行计费' : row.key}>
                      {row.fallback ? '* 兜底价（其余路由）' : row.key}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-subtle-foreground">
                      {row.fallback
                        ? (fallbackPrice === null ? '未设置：未定价路由不估算金额' : '未单独定价的路由按此行计费')
                        : row.price === null
                          ? <span className="text-warn">未定价：这一路由不计入金额</span>
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
                      className="h-7 w-full rounded-md border border-line bg-background px-2 text-right text-[11px] tabular-nums text-foreground outline-none transition-colors placeholder:text-subtle-foreground hover:border-line-strong focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
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

        <div className="flex shrink-0 items-center gap-3 border-t border-line px-5 py-3">
          <Button
            variant={resetArmed ? 'danger' : 'ghost'}
            size="sm"
            className="-ml-1.5"
            onClick={reset}
            disabled={prices === undefined || status === 'saving'}
            title="删除所有自定义单价，回到内置官网价"
          >
            {resetArmed ? '再点一次确认' : '恢复官网价'}
          </Button>
          <span className="h-4 w-px bg-line" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-subtle-foreground">
            {status === 'error' ? <span className="text-danger">{message}</span> : null}
            {status === 'error' ? null : unpriced > 0 ? (
              <span className="text-warn">{unpriced} 个路由未定价，编辑对应行即可补上</span>
            ) : (
              '只保存改动过的行，下一次报表生效'
            )}
          </span>
          <Button variant="outline" size="md" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="md"
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
