/**
 * LANDING-HERO A1 tests — the SHIPPED bundle.
 *
 * Everything here is asserted against landing/hero/hero.js, the built
 * artifact the page actually loads, not against the TypeScript sources it
 * was built from. Two kinds of check:
 *
 *  1. Static — the bytes that will be served carry no URL scheme, no
 *     socket, no fetch and no credential-shaped name.
 *  2. Dynamic — the bundle is imported and RUN, with fetch,
 *     XMLHttpRequest, WebSocket, EventSource, sendBeacon and Image
 *     replaced by functions that throw. A page that quietly reached the
 *     network would fail here rather than pass a grep. The same run also
 *     proves the bundle renders: it has to issue real draw calls against
 *     the fake 2D context before the test will pass.
 *
 * Build first: cd landing && ./node_modules/.bin/vite build --config vite.hero.config.ts
 * Run:         npx tsx landing/src/heroBundle.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    console.log(`[Pass] ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}`)
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_PATH = path.join(__dirname, '..', 'hero', 'hero.js')

// --- 1. static ------------------------------------------------------------

assert(fs.existsSync(BUNDLE_PATH), `the built bundle exists at ${BUNDLE_PATH}`)
const source = fs.readFileSync(BUNDLE_PATH, 'utf8')
console.log(`[info] bundle is ${source.length} bytes`)

// Any URL SCHEME would be a fetchable endpoint. The bare string
// "openstreetmap.org/copyright" is deliberately allowed and deliberately
// present: it is the OSM attribution, drawn as canvas text precisely
// because it must not be a link (shared/src/basemap.ts's ATTRIBUTION_TEXT
// has the licence reasoning).
for (const scheme of ['http://', 'https://', 'ws://', 'wss://', '//cdn', 'data:application']) {
  assert(!source.includes(scheme), `bundle contains no ${scheme} URL`)
}
assert(
  source.includes('openstreetmap.org/copyright'),
  'bundle DOES carry the OpenStreetMap attribution text (drawn, not linked)',
)

// LANDING-HERO-2 (B0/B1): the shipped page must still contain no map
// engine. These are the standing regression guards for that decision.
for (const token of ['maplibre', 'MapLibre', 'protomaps', 'WebGL', 'getContext("webgl"', 'Protocol(']) {
  assert(!source.includes(token), `bundle contains no "${token}" -- no map engine ships`)
}

for (const token of [
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'sendBeacon',
  'importScripts',
  'aisstream',
  'AISSTREAM',
  'AISCAST',
  'TRAFIKLAB',
  'APIKey',
  'apiKey',
  'api_key',
  'token',
]) {
  assert(!source.includes(token), `bundle contains no "${token}"`)
}

// fetch( would be a call; "prefetch" and similar are not. Checked as a
// word boundary rather than a substring.
assert(!/\bfetch\s*\(/.test(source), 'bundle makes no fetch() call')
assert(!/\bimport\s*\(/.test(source), 'bundle makes no dynamic import()')
assert(!/^\s*import\s.+\sfrom\s/m.test(source), 'bundle has no external ES import — it is self-contained')

// --- 2. dynamic: run it with the network booby-trapped --------------------

const networkAttempts: string[] = []

function trap(name: string) {
  return (...args: unknown[]) => {
    networkAttempts.push(`${name}(${args.map(String).join(',')})`)
    throw new Error(`LANDING-HERO: the hero bundle attempted ${name}()`)
  }
}

const g = globalThis as unknown as Record<string, unknown>

g.fetch = trap('fetch')
g.XMLHttpRequest = trap('XMLHttpRequest')
g.WebSocket = trap('WebSocket')
g.EventSource = trap('EventSource')
g.Image = trap('Image')
// Node defines navigator as a getter-only global, so it is patched in
// place rather than replaced.
Object.defineProperty(globalThis, 'navigator', {
  value: { sendBeacon: trap('sendBeacon'), userAgent: 'node-test' },
  configurable: true,
  writable: true,
})

// --- a fake DOM, just enough for hero.ts ---------------------------------

const drawCalls: string[] = []
const offscreenCalls: string[] = []
const gradient = { addColorStop: () => {} }

function makeCtx(sink: string[]) {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
          sink.push(`${prop}(${args.length})`)
          if (String(prop).startsWith('create') && String(prop).endsWith('Gradient')) return gradient
          if (prop === 'measureText') return { width: 0 }
          return undefined
        }
      },
      set(_t, prop: string) {
        sink.push(`${String(prop)}=`)
        return true
      },
    },
  )
}

const fakeCtx = makeCtx(drawCalls)
const offscreenCtx = makeCtx(offscreenCalls)

class FakeCanvas {
  width = 0
  height = 0
  clientWidth = 1100
  style: Record<string, string> = {}
  parentElement = { clientWidth: 1100 }
  constructor(private readonly ctx: unknown = fakeCtx) {}
  getContext(kind: string) {
    return kind === '2d' ? this.ctx : null
  }
}

g.HTMLCanvasElement = FakeCanvas
const heroCanvas = new FakeCanvas()
let createdCanvases = 0
g.document = {
  getElementById: (id: string) => (id === 'hero-canvas' ? heroCanvas : null),
  // LANDING-HERO-2: hero.ts bakes the coastline into an offscreen canvas
  // once per resize. Providing createElement here exercises that path
  // rather than its inline fallback.
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`)
    createdCanvases++
    return new FakeCanvas(offscreenCtx)
  },
}
g.devicePixelRatio = 2

// matchMedia deliberately absent, so hero.ts takes its animated branch;
// the reduced-motion branch is covered separately below.
delete g.matchMedia

let observedTarget: unknown = null
class FakeIntersectionObserver {
  private readonly callback: (entries: { isIntersecting: boolean }[]) => void
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    this.callback = callback
  }
  observe(target: unknown) {
    observedTarget = target
    this.callback([{ isIntersecting: true }])
  }
  disconnect() {}
}
g.IntersectionObserver = FakeIntersectionObserver

const MAX_FRAMES = 240
let framesRun = 0
g.requestAnimationFrame = (fn: () => void) => {
  if (framesRun >= MAX_FRAMES) return 0
  framesRun++
  queueMicrotask(fn)
  return framesRun
}
g.cancelAnimationFrame = () => {}
if (typeof (globalThis as { addEventListener?: unknown }).addEventListener !== 'function') {
  g.addEventListener = () => {}
  g.removeEventListener = () => {}
}

let threw: Error | null = null
try {
  await import(pathToFileURL(BUNDLE_PATH).href)
  // Let the queued frames drain.
  for (let i = 0; i < MAX_FRAMES + 10; i++) await Promise.resolve()
} catch (err) {
  threw = err as Error
}

assert(threw === null, `the bundle ran without throwing${threw ? ` (threw: ${threw.message})` : ''}`)
assert(
  networkAttempts.length === 0,
  `the running bundle made ZERO network calls (attempts: ${networkAttempts.length === 0 ? 'none' : networkAttempts.join(', ')})`,
)
assert(observedTarget === heroCanvas, 'the bundle found the hero canvas and observed it')
assert(framesRun > 0, `the bundle drove animation frames (${framesRun})`)
assert(drawCalls.length > 1000, `the bundle actually rendered (${drawCalls.length} context operations recorded)`)
assert(createdCanvases > 0, `the coastline was baked into an offscreen canvas (${createdCanvases} created)`)
assert(
  offscreenCalls.length > 5000,
  `and the bake really drew the coastline into it (${offscreenCalls.length} operations, once, off the frame loop)`,
)
const drawImageCalls = drawCalls.filter((c) => c.startsWith('drawImage(')).length
assert(
  drawImageCalls >= framesRun,
  `every frame paints the coastline with ONE drawImage rather than replaying its ~10,000 path ops (${drawImageCalls} drawImage calls over ${framesRun} frames)`,
)
assert(
  drawCalls.filter((c) => c === 'stroke(0)').length < framesRun * 900,
  'the per-frame stroke count is the ship scene alone, not the ship scene plus a coastline replay',
)
assert(heroCanvas.width > 0 && heroCanvas.height > 0, `the bundle sized the canvas (${heroCanvas.width}x${heroCanvas.height})`)
assert(
  Math.abs(heroCanvas.width / heroCanvas.height - 1920 / 890) < 0.01,
  `the canvas keeps the approved screenshot's aspect (${(heroCanvas.width / heroCanvas.height).toFixed(4)} vs ${(1920 / 890).toFixed(4)})`,
)

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
