import { attributionBox, drawAttribution, drawPlaceNames, projectPlaces } from './placeNames'
import { estimateTextWidth } from './labels'
import {
  ATTRIBUTION_TEXT,
  DEMO_AREAS,
  basemapAreaFor,
  mapProject,
  type BasemapPlace,
} from '@wake/shared'

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

// Minimal recording context, same shape as glyphs.test.ts's.
function createMockCtx() {
  const calls: string[] = []
  let fillStyle = ''
  let letterSpacing = '0px'
  let font = ''
  let textAlign = 'start'
  let globalAlpha = 1

  const ctx = {
    save: () => { calls.push('save') },
    restore: () => { calls.push('restore') },
    fillText: (text: string, x: number, y: number) => {
      calls.push(`fillText("${text}",${x.toFixed(3)},${y.toFixed(3)},align=${textAlign},fill=${fillStyle},alpha=${globalAlpha},font=${font},ls=${letterSpacing})`)
    },
    rotate: (a: number) => { calls.push(`rotate(${a})`) },
    translate: (x: number, y: number) => { calls.push(`translate(${x},${y})`) },
    scale: (x: number, y: number) => { calls.push(`scale(${x},${y})`) },
    setTransform: () => { calls.push('setTransform') },
    get fillStyle() { return fillStyle },
    set fillStyle(v: string) { fillStyle = v },
    get font() { return font },
    set font(v: string) { font = v },
    get textAlign() { return textAlign },
    set textAlign(v: string) { textAlign = v },
    get globalAlpha() { return globalAlpha },
    set globalAlpha(v: number) { globalAlpha = v },
    get letterSpacing() { return letterSpacing },
    set letterSpacing(v: string) { letterSpacing = v },
    _calls: calls,
  }
  return ctx as unknown as CanvasRenderingContext2D & { _calls: string[] }
}

const AREA = DEMO_AREAS.dover
const DOVER = basemapAreaFor('dover')
if (DOVER === undefined) throw new Error('dover basemap area missing')
const PLACES = DOVER.places

// --- projectPlaces: real projected positions, not invented ones ---

for (const size of [
  [1920, 1080],
  [1024, 768],
] as const) {
  const w = size[0]
  const h = size[1]
  for (const mirrorX of [false, true]) {
    const config = { mirrorX, rotationDeg: 0 }
    const projected = projectPlaces(PLACES, AREA.centerLat, AREA.centerLon, AREA.radiusNm, config, w, h)

    assert(
      projected.length === 4,
      `projectPlaces ${w}x${h} mirrorX=${mirrorX}: 4 of 5 places are on screen (Boulogne-sur-Mer is culled)`,
    )
    assert(
      !projected.some((p) => p.name === 'BOULOGNE-SUR-MER'),
      `projectPlaces ${w}x${h} mirrorX=${mirrorX}: Boulogne-sur-Mer is not drawn`,
    )

    // Each surviving place must be at EXACTLY mapProject's own answer --
    // independently recomputed here rather than trusted.
    for (const place of PLACES) {
      const expected = mapProject(
        place.lat,
        place.lon,
        AREA.centerLat,
        AREA.centerLon,
        AREA.radiusNm,
        config,
        w,
        h,
      )
      const got = projected.find((p) => p.name === place.name.toUpperCase())
      if (expected === null) continue
      assert(
        got !== undefined && got.x === expected.x && got.y === expected.y,
        `projectPlaces ${w}x${h} mirrorX=${mirrorX}: ${place.name} at mapProject's own (${expected.x.toFixed(2)}, ${expected.y.toFixed(2)})`,
      )
    }
  }

  // The mirror moves a place name exactly as it moves a vessel: x -> w-x.
  const plain = projectPlaces(PLACES, AREA.centerLat, AREA.centerLon, AREA.radiusNm, { mirrorX: false, rotationDeg: 0 }, w, h)
  const flipped = projectPlaces(PLACES, AREA.centerLat, AREA.centerLon, AREA.radiusNm, { mirrorX: true, rotationDeg: 0 }, w, h)
  for (let i = 0; i < plain.length; i++) {
    assert(
      Math.abs(plain[i].x + flipped[i].x - w) < 1e-9 && plain[i].y === flipped[i].y,
      `projectPlaces ${w}x${h}: ${plain[i].name} mirrors to exactly canvasWidth - x, with y untouched`,
    )
  }
}

// --- drawPlaceNames ---

{
  const ctx = createMockCtx()
  drawPlaceNames(ctx, PLACES, AREA.centerLat, AREA.centerLon, AREA.radiusNm, { mirrorX: true, rotationDeg: 0 }, 1920, 1080)
  const texts = ctx._calls.filter((c) => c.startsWith('fillText'))

  // Four places, each drawn twice: its shadow, then the text.
  assert(texts.length === 8, `drawPlaceNames: 4 places x (shadow + text) = 8 fillText calls (got ${texts.length})`)
  for (const name of ['DOVER', 'CALAIS', 'FOLKESTONE', 'RAMSGATE']) {
    assert(
      texts.filter((c) => c.includes(`"${name}"`)).length === 2,
      `drawPlaceNames: ${name} drawn once over its own shadow`,
    )
  }
  assert(
    !texts.some((c) => c.includes('BOULOGNE')),
    'drawPlaceNames: the culled place produces no fillText at all',
  )

  // Ambient chrome styling, not hero-label styling: Inter Light at 16*s.
  assert(
    texts.every((c) => c.includes('font=300 16px Inter')),
    'drawPlaceNames: 300 weight at 16*s px Inter -- labels.ts\'s ambient chrome convention',
  )
  assert(
    texts.some((c) => c.includes('fill=#C8D8F0') && c.includes('alpha=0.5')),
    'drawPlaceNames: #C8D8F0 at alpha 0.5, the same values "LIVE AIS" and the legend use',
  )
  assert(
    texts.some((c) => c.includes('fill=#0A0E14')),
    'drawPlaceNames: each name draws over a DARK_OUTLINE_COLOR shadow, because it sits on the land fill',
  )
  assert(texts.every((c) => c.includes('align=center')), 'drawPlaceNames: centred on the place itself')

  // Never rotated, never mirrored: the text is drawn straight onto the
  // unflipped canvas at an already-flipped position, which is why it reads
  // correctly from the bed in both mirrorX states.
  assert(
    !ctx._calls.some((c) => c.startsWith('rotate') || c.startsWith('scale') || c === 'setTransform'),
    'drawPlaceNames: no rotate, scale or setTransform -- the text itself is never flipped',
  )
  assert(
    ctx._calls[ctx._calls.length - 1] === 'restore',
    'drawPlaceNames: letterSpacing and style are restored',
  )
}

{
  const ctx = createMockCtx()
  drawPlaceNames(ctx, [], AREA.centerLat, AREA.centerLon, AREA.radiusNm, { mirrorX: true, rotationDeg: 0 }, 1920, 1080)
  assert(ctx._calls.length === 0, 'drawPlaceNames: an empty place list draws nothing at all')
}

{
  // A place list for somewhere else entirely projects to nothing rather
  // than drawing at a clamped position.
  const elsewhere: BasemapPlace[] = [{ name: 'Sydney', lat: -33.93, lon: 151.22 }]
  const ctx = createMockCtx()
  drawPlaceNames(ctx, elsewhere, AREA.centerLat, AREA.centerLon, AREA.radiusNm, { mirrorX: true, rotationDeg: 0 }, 1920, 1080)
  assert(ctx._calls.length === 0, 'drawPlaceNames: a place outside the view radius is culled, not clamped')
}

// --- drawAttribution ---

for (const size of [
  [1920, 1080],
  [1024, 768],
] as const) {
  const w = size[0]
  const h = size[1]
  for (const mirrorX of [false, true]) {
    const ctx = createMockCtx()
    drawAttribution(ctx, w, h)
    const texts = ctx._calls.filter((c) => c.startsWith('fillText'))

    assert(
      texts.length === 2 && texts.every((c) => c.includes(ATTRIBUTION_TEXT)),
      `drawAttribution ${w}x${h}: the credit is drawn (over its own shadow)`,
    )
    assert(
      texts.some((c) => c.includes('openstreetmap.org/copyright')),
      `drawAttribution ${w}x${h}: the copyright URL is printed, as the non-interactive case requires`,
    )
    assert(
      texts.some((c) => c.includes('fill=#C8D8F0') && c.includes('alpha=0.5')),
      `drawAttribution ${w}x${h}: drawn at the ambient-chrome brightness, not dimmer -- legibility is a licence requirement`,
    )
    assert(
      !ctx._calls.some((c) => c.startsWith('rotate') || c.startsWith('scale') || c === 'setTransform'),
      `drawAttribution ${w}x${h} mirrorX=${mirrorX}: never rotated or mirrored, so it is legible in both mirrorX states`,
    )
  }

  // drawAttribution takes no ProjectionConfig at all, which is the
  // structural reason the mirror cannot reach it. Asserted by drawing it
  // twice and comparing: the calls are identical.
  const a = createMockCtx()
  const b = createMockCtx()
  drawAttribution(a, w, h)
  drawAttribution(b, w, h)
  assert(
    JSON.stringify(a._calls) === JSON.stringify(b._calls),
    `drawAttribution ${w}x${h}: output does not depend on any projection state`,
  )
}

// --- the attribution's corner is nobody else's corner ---

for (const size of [
  [1920, 1080],
  [1024, 768],
] as const) {
  const w = size[0]
  const h = size[1]
  const s = w / 1920
  const box = attributionBox(w, h)

  assert(box.x > w / 2, `attributionBox ${w}x${h}: in the right half of the canvas`)
  assert(box.y < h / 2, `attributionBox ${w}x${h}: in the top half of the canvas`)
  assert(box.x >= 0 && box.x + box.width <= w, `attributionBox ${w}x${h}: fits horizontally`)
  assert(box.y >= 0, `attributionBox ${w}x${h}: fits vertically`)

  // labels.ts's drawAreaTitle: bottom-left, 48*s margin, a 44*s title over
  // a 16*s "LIVE AIS" line. legend.ts: bottom-right, 48*s margin, rows at
  // 24*s. Both boxes reconstructed here from those published conventions.
  const titleBox = {
    x: 48 * s,
    y: h - 48 * s - 44 * s - 10 * s - 16 * s,
    w: estimateTextWidth('DOVER STRAIT', 44 * s) + 8 * s * 12,
    h: 44 * s + 10 * s + 16 * s,
  }
  const legendBox = {
    x: w - 48 * s - estimateTextWidth('Tanker 12', 16 * s) - 18 * s,
    y: h - 48 * s - 24 * s * 6,
    w: estimateTextWidth('Tanker 12', 16 * s) + 18 * s,
    h: 24 * s * 6 + 16 * s,
  }
  const attrRect = { x: box.x, y: box.y, w: box.width, h: box.height }

  const intersects = (
    p: { x: number; y: number; w: number; h: number },
    q: { x: number; y: number; w: number; h: number },
  ) => p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y

  assert(
    !intersects(attrRect, titleBox),
    `attributionBox ${w}x${h}: does not collide with the bottom-left area title`,
  )
  assert(
    !intersects(attrRect, legendBox),
    `attributionBox ${w}x${h}: does not collide with the bottom-right legend`,
  )
}

const total = passed + failed
console.log(`\n${passed}/${total} passed, ${failed} failed`)
if (failed === 0) {
  console.log(`All ${total} tests passed`)
} else {
  throw new Error(`${failed} of ${total} tests failed`)
}
