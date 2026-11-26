/** Number and time formatting shared by every part of the page. */

export function group(value) {
  return String(Math.max(0, Math.round(value || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Chinese-scale count: 8,412 / 45.3万 / 6899万 / 1.47亿. */
export function scale(value) {
  const amount = Math.max(0, Math.round(value || 0))
  if (amount < 10000) return group(amount)
  const wan = amount / 10000
  if (wan < 9999.5) return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1).replace(/\.0$/, '')}万`
  const yi = amount / 100000000
  return `${yi >= 10 ? Math.round(yi) : yi.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}亿`
}

export function tokens(value) {
  return `${scale(value)} tok`
}

export function money(value, currency = '¥') {
  const amount = Math.abs(value || 0)
  if (amount === 0) return `${currency}0`
  // Below one unit every figure keeps four decimals, so a column of tiny costs
  // lines up instead of mixing `0.010` with `0.0077`.
  const text = amount >= 100 ? value.toFixed(0)
    : amount >= 1 ? value.toFixed(2)
      : amount < 0.0001 ? '<0.0001'
        : value.toFixed(4)
  return `${currency}${text}`
}

/**
 * DeepSeek bills peak list price on Beijing weekdays 09:00–12:00 and
 * 14:00–18:00; every other hour is off-peak at half. Statutory holidays are not
 * special-cased, matching the host's estimate.
 */
export function isPeak(time = Date.now()) {
  const beijing = new Date(time + 8 * 3600_000)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** Share of the prompt that came from cache, or null when nothing was sent. */
export function cacheHit(bucket) {
  const prompt = bucket.input + bucket.cacheRead + bucket.cacheWrite
  if (prompt === 0) return null
  return `${(bucket.cacheRead / prompt * 100).toFixed(1)}%`
}

/** Latency in milliseconds below a second, seconds above it. */
export function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`
}

export function pad2(value) {
  return String(value).padStart(2, '0')
}

/** `HH:MM:SS` for today, `MM-DD HH:MM` for older settlements. */
export function clock(time, today) {
  const date = new Date(time)
  const hhmmss = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  const dateKey = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return dateKey === today ? hhmmss : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${hhmmss.slice(0, 5)}`
}

export function todayKey() {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/** Round an axis maximum up to 1/2/5 × 10^n so gridline labels stay legible. */
export function niceMax(value) {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

export function percent(part, whole) {
  if (!whole || whole <= 0) return '0%'
  const share = part / whole * 100
  if (share > 0 && share < 0.1) return '<0.1%'
  return `${share.toFixed(1)}%`
}
