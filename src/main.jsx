import React from 'react'
import css from './styles.css?inline'
import { UsagePage } from './page.jsx'
import { UsageIcon } from './icon.jsx'

export const inject = ['slots']

const STYLE_ATTR = 'data-dtu'

/** Inject the compiled stylesheet once, and hand back its removal. */
function ensureStyle() {
  if (typeof document === 'undefined' || document.head === undefined) return () => {}
  if (document.querySelector(`style[${STYLE_ATTR}]`) !== null) return () => {}
  const style = document.createElement('style')
  style.setAttribute(STYLE_ATTR, '')
  style.textContent = css
  document.head.appendChild(style)
  return () => style.remove()
}

export function apply(ctx) {
  if (typeof ctx.effect === 'function') ctx.effect(() => ensureStyle())

  // The page fills the main column and is reached from the left sidebar row.
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'token-usage' }, UsagePage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'token-usage',
    order: 20,
    label: () => '用量',
  }, UsageIcon))
}
