import React from 'react'

/** Left sidebar row glyph; the sidebar owns the row, label, and navigation. */
export function UsageIcon({ size }) {
  const edge = typeof size === 'number' && size > 0 ? size : 16
  return (
    <svg width={edge} height={edge} viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="2" y="9" width="3" height="5" rx="1" fill="currentColor" />
      <rect x="6.5" y="5" width="3" height="9" rx="1" fill="currentColor" />
      <rect x="11" y="2" width="3" height="12" rx="1" fill="currentColor" />
    </svg>
  )
}
