// Builds a standalone HTML page from the built client bundle so the page can be
// looked at in headless Edge (`--screenshot`) without the Desktop host.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { renderPage } from './render.mjs'

const fixture = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url), 'utf8'))
const outPath = process.env.PREVIEW_OUT ?? fileURLToPath(new URL('./preview.html', import.meta.url))
const chartWidth = Number(process.env.CHART_WIDTH ?? 1188)

const { html, css } = await renderPage({
  fixture,
  chartWidth,
  props: { initialPricesOpen: process.env.PRICES_OPEN === '1' },
})
if (!css) throw new Error('the plugin did not inject a stylesheet')

const dark = process.env.DARK === '1'
const tokens = dark
  ? `--dsw-alias-label-primary: #ecedef;
    --dsw-alias-label-secondary: #a7adb6;
    --dsw-alias-label-tertiary: #7d838d;
    --dsw-alias-border-l1: rgba(255, 255, 255, 0.10);
    --dsw-alias-border-l2: rgba(255, 255, 255, 0.16);
    --dsw-alias-bg-layer-1: #1b1c1f;
    --dsw-alias-bg-layer-2: #24262a;`
  : `--dsw-alias-label-primary: #17181c;
    --dsw-alias-label-secondary: #5c6068;
    --dsw-alias-label-tertiary: #8b909a;
    --dsw-alias-border-l1: rgba(20, 22, 30, 0.10);
    --dsw-alias-border-l2: rgba(20, 22, 30, 0.16);
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-bg-layer-2: #f5f6f7;`

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>用量预览</title>
<style>
  /* Light-theme stand-ins for the host tokens the page reads. */
  :root {
    ${tokens}
    --dsw-alias-chart-messages: #4c8dff;
    --dsw-alias-chart-tools: #9a7cff;
    --dsw-alias-chart-system: #9aa7bd;
    --dsw-alias-state-warn-primary: #d49b00;
    --dsw-alias-state-success-primary: #2f9e44;
    --dsw-alias-state-error-primary: #e03131;
    --dsw-alias-state-business-primary: #4c8dff;
  }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--dsw-alias-bg-layer-1);
    color: var(--dsw-alias-label-primary);
    font-family: "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
    -webkit-font-smoothing: antialiased;
    color-scheme: ${dark ? 'dark' : 'light'};
  }
  #host { height: 100%; }
</style>
<style>${css}</style>
</head><body><div id="host">${html}</div></body></html>`

await writeFile(outPath, page, 'utf8')
console.log(`wrote ${outPath} · ${(page.length / 1024).toFixed(1)}KB · css ${(css.length / 1024).toFixed(1)}KB · nodes ${(page.match(/class=/g) ?? []).length}`)
process.exit(0)
