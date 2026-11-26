// Renders the built client bundle without a browser: a tiny hook store stands in
// for React, so the real component tree can be asserted in tests and screenshotted
// through preview.mjs. React itself stays the host's copy at runtime; here it is
// a plain element tree.
import { readFile } from 'node:fs/promises'

const bundlePath = new URL('../dist/client.js', import.meta.url)

const voidTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col'])
const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = value => escapeText(value).replace(/"/g, '&quot;')
const kebab = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)

function styleText(style) {
  if (typeof style === 'string') return style
  return Object.entries(style ?? {}).map(([key, value]) => `${kebab(key)}:${value}`).join(';')
}

export async function renderPage(options = {}) {
  const {
    fixture,
    chartWidth = 1188,
    fetchImpl,
    bundle,
    maxRounds = 40,
    props = null,
  } = options

  const source = bundle ?? await readFile(bundlePath, 'utf8')
  let capturedCss = ''
  let styleCount = 0
  const styleNode = {
    setAttribute() {},
    remove() { styleCount -= 1 },
    set textContent(value) { capturedCss = value },
    get textContent() { return capturedCss },
  }
  const documentStub = {
    head: { appendChild() { styleCount += 1 } },
    createElement: () => styleNode,
    querySelector: () => (styleCount > 0 ? styleNode : null),
  }

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    ResizeObserver: globalThis.ResizeObserver,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }

  let loaded
  globalThis.window = { __ModuleLoader__: { load: spec => { loaded = spec } } }
  globalThis.document = documentStub
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe() { this.callback([{ contentRect: { width: chartWidth } }]) }
    disconnect() {}
  }
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl
  else globalThis.fetch = async () => ({ ok: true, json: async () => fixture })
  // The poll timer would keep the test process alive; the refresh path is manual here.
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}

  const instances = new Map()
  let current = null
  let dirty = false
  let queued = []

  const instanceFor = key => {
    let inst = instances.get(key)
    if (inst === undefined) {
      inst = { values: [], effects: [], refs: [] }
      instances.set(key, inst)
    }
    return inst
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const normalized = { ...(props ?? {}) }
      if (children.length === 1) normalized.children = children[0]
      else if (children.length > 1) normalized.children = children
      return { type, props: normalized }
    },
    useState(initial) {
      const inst = current
      const index = inst.h++
      if (!(index in inst.values)) inst.values[index] = typeof initial === 'function' ? initial() : initial
      const set = value => {
        const next = typeof value === 'function' ? value(inst.values[index]) : value
        if (next === inst.values[index]) return
        inst.values[index] = next
        dirty = true
      }
      return [inst.values[index], set]
    },
    useEffect(fn) {
      const inst = current
      const index = inst.e++
      if (!(index in inst.effects)) {
        inst.effects[index] = fn
        queued.push(fn)
      }
    },
    useRef() {
      const inst = current
      const index = inst.r++
      if (!(index in inst.refs)) {
        inst.refs[index] = { current: { getBoundingClientRect: () => ({ width: chartWidth }) } }
      }
      return inst.refs[index]
    },
    createContext: () => ({}),
  }

  const html = { value: '' }
  try {
    new Function('window', 'document', source)(globalThis.window, documentStub)
    if (loaded === undefined) throw new Error('bundle did not register with the module loader')

    const plugin = loaded.factory(name => {
      if (name !== 'react') throw new Error(`unexpected require ${name}`)
      return React
    })

    const registrations = new Map()
    plugin.apply({
      effect: callback => { callback() },
      slots: {
        inject: (key, callback) => callback(),
        register: (options_, Component) => {
          registrations.set(options_.name, { options: options_, Component })
          return () => {}
        },
      },
    })
    const page = registrations.get('main')
    if (page === undefined) throw new Error('main panel not registered')

    const render = (node, path) => {
      if (node === null || node === undefined || node === false || node === true) return ''
      if (typeof node === 'string' || typeof node === 'number') return escapeText(node)
      if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}.${index}`)).join('')
      // A fragment is not an element: its children are siblings of the parent.
      if (node.type === React.Fragment) return render(node.props?.children, `${path}.fragment`)

      if (typeof node.type === 'function') {
        const key = `${path}:${node.type.name || 'component'}`
        const inst = instanceFor(key)
        inst.h = 0
        inst.e = 0
        inst.r = 0
        const previousInstance = current
        current = inst
        let output
        try {
          output = node.type(node.props)
        } finally {
          current = previousInstance
        }
        return render(output, key)
      }

      const { children, ...raw } = node.props ?? {}
      const attrs = []
      for (const [key, value] of Object.entries(raw)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'ref' || key === 'key' || key === 'children' || key.startsWith('on')) continue
        if (key === 'style') attrs.push(`style="${escapeAttr(styleText(value))}"`)
        else if (key === 'className') attrs.push(`class="${escapeAttr(value)}"`)
        else if (value === true) attrs.push(key)
        else attrs.push(`${key}="${escapeAttr(value)}"`)
      }
      const tag = node.type
      const head = `<${tag}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`
      if (voidTags.has(tag)) return head
      const inner = tag === 'style'
        ? (Array.isArray(children) ? children.join('') : String(children ?? ''))
        : render(children, `${path}.${tag}`)
      return `${head}${inner}</${tag}>`
    }

    const renderRoot = () => {
      const markup = render(React.createElement(page.Component, props), 'root')
      const effects = queued
      queued = []
      for (const effect of effects) effect()
      return markup
    }

    dirty = true
    html.value = renderRoot()
    for (let round = 0; round < maxRounds; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!dirty) {
        if (round > 3) break
        continue
      }
      dirty = false
      html.value = renderRoot()
    }

    return { html: html.value, css: capturedCss, registrations, plugin, id: loaded.id }
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.fetch = previous.fetch
    globalThis.ResizeObserver = previous.ResizeObserver
    globalThis.setInterval = previous.setInterval
    globalThis.clearInterval = previous.clearInterval
  }
}
