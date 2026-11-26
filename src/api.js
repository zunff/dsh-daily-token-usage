import React from 'react'

const ENDPOINT = '/daily-token-usage/report'
const PRICES_ENDPOINT = '/daily-token-usage/prices'
const POLL_MS = 60000

/** The report JSON for one window, refreshed on a slow poll plus a manual retry. */
export function useReport(days = 14) {
  const [state, setState] = React.useState({
    status: 'loading',
    data: undefined,
    error: undefined,
    refreshing: false,
  })
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    let live = true
    const load = async () => {
      setState(previous => ({ ...previous, refreshing: true }))
      try {
        const response = await fetch(`${ENDPOINT}?days=${days}&_t=${Date.now()}`, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        if (live) setState({ status: 'ready', data, error: undefined, refreshing: false })
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        if (live) {
          setState(previous => ({ status: 'error', data: previous.data, error: message, refreshing: false }))
        }
      }
    }
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [tick, days])

  return { ...state, retry: () => setTick(value => value + 1) }
}

/**
 * Save the price table: `{ models }` sets or (with `null`) deletes one route,
 * `{ reset: true }` drops every override back to the shipped list prices. The
 * host writes `prices.json`, so the next report already prices from it.
 */
export async function savePrices(patch) {
  const response = await fetch(PRICES_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(patch),
  })
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(String(payload?.error ?? `HTTP ${response.status}`))
  return payload
}

/**
 * Track a container's content width so the chart draws at real pixel size:
 * a scaled viewBox would shrink or grow its labels along with the bars.
 */
export function useMeasuredWidth(fallback) {
  const [width, setWidth] = React.useState(fallback)
  const ref = React.useRef(null)

  React.useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver !== 'function') return undefined
    const apply = next => {
      if (!Number.isFinite(next) || next < 160) return
      setWidth(previous => (Math.abs(previous - next) < 1 ? previous : Math.round(next)))
    }
    apply(node.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry !== undefined) apply(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}

export { POLL_MS }
