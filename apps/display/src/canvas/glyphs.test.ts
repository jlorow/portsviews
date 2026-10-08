import './path2dShim'
import { drawGlyph, GLYPH_DOT_RADIUS_RATIO } from './glyphs'
import { VesselGlyphSpec, VesselType, NOTABLE_COLOR, DARK_OUTLINE_COLOR } from '@wake/shared'
import { getTypedGlyphShape, tierFor, TIER2_MIN_PX, TIER3_MIN_PX } from './glyphShapes'
import { Path2DShim } from './path2dShim'

// Minimal mock CanvasRenderingContext2D that records draw calls
function createMockCtx() {
  const calls: string[] = []
  let currentFillStyle = ''
  let currentStrokeStyle = ''
  let currentShadowBlur = 0
  const fills: { style: string; path: boolean; shadowBlur: number }[] = []

  const mockCtx = {
    save: () => { calls.push('save') },
    restore: () => { calls.push('restore') },
    translate: (x: number, y: number) => { calls.push(`translate(${x},${y})`) },
    rotate: (angle: number) => { calls.push(`rotate(${angle})`) },
    scale: (x: number, y: number) => { calls.push(`scale(${x},${y})`) },
    beginPath: () => { calls.push('beginPath') },
    moveTo: (x: number, y: number) => { calls.push(`moveTo(${x},${y})`) },
    lineTo: (x: number, y: number) => { calls.push(`lineTo(${x},${y})`) },
    bezierCurveTo: (cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) => {
      calls.push(`bezierCurveTo(${cp1x},${cp1y},${cp2x},${cp2y},${x},${y})`)
    },
    arc: (x: number, y: number, r: number, s: number, e: number) => {
      calls.push(`arc(${x},${y},${r},${s},${e})`)
    },
    closePath: () => { calls.push('closePath') },
    fill: (pathOrRule?: Path2D | CanvasFillRule) => {
      const path = pathOrRule instanceof Path2D
      fills.push({ style: currentFillStyle, path, shadowBlur: currentShadowBlur })
      calls.push(path ? `fill(path:${currentFillStyle})` : `fill(${currentFillStyle})`)
    },
    rect: (x: number, y: number, w: number, h: number) => {
      calls.push(`rect(${x},${y},${w},${h})`)
    },
    roundRect: (x: number, y: number, w: number, h: number, r: number[]) => {
      calls.push(`roundRect(${x},${y},${w},${h},${JSON.stringify(r)})`)
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      calls.push(`fillRect(${x},${y},${w},${h})`)
    },
    // VIS-8 A11: the stopped-vessel dot and the unknown silhouette now
    // stroke a dark outline after their fill. Recorded with its colour, the
    // same way fill records its own, so the outline can be told from any
    // other stroke.
    stroke: (path?: Path2D) => { calls.push(path ? `stroke(path:${currentStrokeStyle})` : `stroke(${currentStrokeStyle})`) },
    get strokeStyle() { return currentStrokeStyle },
    set strokeStyle(v: string) { currentStrokeStyle = v },
    lineWidth: 0,
    get fillStyle() { return currentFillStyle },
    set fillStyle(v: string) {
      currentFillStyle = v
      calls.push(`fillStyle=${v}`)
    },
    get shadowBlur() { return currentShadowBlur },
    set shadowBlur(v: number) { currentShadowBlur = v },
    shadowColor: '',
    globalAlpha: 1,
    _calls: calls,
    _fills: fills,
  }

  return mockCtx as unknown as CanvasRenderingContext2D & {
    _calls: string[]
    _fills: { style: string; path: boolean; shadowBlur: number }[]
  }
}

const ALL_TYPES: VesselType[] = [
  'cargo',
  'tanker',
  'cruise',
  'ferry',
  'tugboat',
  'naval',
  'unknown',
]

function specFor(type: VesselType, overrides?: Partial<VesselGlyphSpec>): VesselGlyphSpec {
  return {
    type,
    baseSize: 28,
    color: '#C8D8F0',
    isNotable: false,
    ...overrides,
  }
}

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

// Test 1: drawGlyph does not throw for each of the 7 vessel types
ALL_TYPES.forEach((type) => {
  const ctx = createMockCtx()
  let threw = false
  try {
    drawGlyph(ctx, 960, 540, 0, specFor(type), 1920)
  } catch {
    threw = true
  }
  assert(!threw, `drawGlyph does not throw for ${type}`)
  if (type !== 'unknown') {
    assert(ctx._calls.some((call) => call.startsWith('scale(')), `${type} reaches typed unit-path drawing`)
    assert(ctx._fills.some((fill) => fill.path), `${type} fills its cached Path2D hull`)
  }
})

// Test 2: the cargo half-length remains tied to actualSize at each canvas width.
{
  const ctx = createMockCtx()
  drawGlyph(ctx, 960, 540, 0, specFor('cargo'), 1920)
  assert(ctx._calls.includes('scale(14,14)'), 'cargo half-length 14 at 1920 width')
}
{
  const ctx = createMockCtx()
  drawGlyph(ctx, 960, 540, 0, specFor('cargo'), 960)
  assert(ctx._calls.includes('scale(7,7)'), 'cargo half-length 7 at 960 width')
}
{
  const ctx = createMockCtx()
  drawGlyph(ctx, 960, 540, 0, specFor('cargo'), 3840)
  assert(ctx._calls.includes('scale(28,28)'), 'cargo half-length 28 at 3840 width')
}

// Test 3: Notable vessel uses NOTABLE_COLOR
{
  const ctx = createMockCtx()
  drawGlyph(ctx, 960, 540, 0, specFor('cargo', { isNotable: true }), 1920)
  const fillStyleCall = ctx._calls.find((c) => c === `fillStyle=${NOTABLE_COLOR}`)
  assert(fillStyleCall !== undefined, 'notable vessel uses NOTABLE_COLOR')
}

// Test 4: Unknown vessel type draws without throwing, as VIS-8 A7's
// non-rotating silhouette rather than the circle it drew from S1.3 to
// VIS-7. specFor's baseSize is 28 and canvasWidth is 1920, so the circle's
// half-extent would have been 28 * 0.28 = 7.84. A9 redistributes that at
// 1:2.67 without changing the product: half-width 7.84 * sqrt(0.375) =
// 4.800999895855029, half-length 7.84 / sqrt(0.375) = 12.802666388946747.
{
  const ctx = createMockCtx()
  let threw = false
  try {
    drawGlyph(ctx, 960, 540, 0, specFor('unknown'), 1920)
  } catch {
    threw = true
  }
  assert(!threw, 'unknown vessel draws without throwing')

  assert(
    ctx._calls.find((c) => c.startsWith('arc')) === undefined,
    'unknown vessel no longer calls arc -- it is a silhouette, not a circle',
  )
  assert(
    ctx._calls.includes('moveTo(0,-12.802666388946747)'),
    `unknown vessel draws hullPath's bow at half-length 12.802666388946747 (moveTos: ${JSON.stringify(ctx._calls.filter((c) => c.startsWith('moveTo(')))})`,
  )
  assert(
    ctx._calls.filter((c) => c.startsWith('fill(')).length === 1,
    `unknown vessel fills exactly once -- flat, no internal linework (got ${ctx._calls.filter((c) => c.startsWith('fill(')).length})`,
  )
  assert(
    ctx._calls.every((c) => !c.startsWith('fillRect(')),
    `unknown vessel draws no internal detail rectangles (got ${JSON.stringify(ctx._calls.filter((c) => c.startsWith('fillRect(')))})`,
  )
  assert(GLYPH_DOT_RADIUS_RATIO === 0.28, `GLYPH_DOT_RADIUS_RATIO is 0.28 (got ${GLYPH_DOT_RADIUS_RATIO})`)
}

// Test 4b: the unknown glyph never rotates, whatever heading it is given,
// and the shape it draws is identical at every heading. Typed glyphs still
// rotate -- the guard is type-specific, not a global removal.
{
  function unknownCalls(headingDeg: number): string[] {
    const ctx = createMockCtx()
    drawGlyph(ctx, 960, 540, headingDeg, specFor('unknown'), 1920)
    return ctx._calls
  }

  const atZero = unknownCalls(0)
  const atHeading = unknownCalls(137.5)
  const atNegative = unknownCalls(-42)

  assert(
    JSON.stringify(atZero) === JSON.stringify(atHeading) &&
      JSON.stringify(atZero) === JSON.stringify(atNegative),
    'unknown vessel: identical call sequence at 0, 137.5 and -42 degrees -- orientation is fixed',
  )
  assert(
    atHeading.every((c) => !c.startsWith('rotate(')),
    `unknown vessel: no rotate() call is emitted at all (got ${JSON.stringify(atHeading.filter((c) => c.startsWith('rotate(')))})`,
  )

  const typedCtx = createMockCtx()
  drawGlyph(typedCtx, 960, 540, 137.5, specFor('cargo'), 1920)
  assert(
    typedCtx._calls.some((c) => c.startsWith('rotate(')),
    'typed vessels still rotate -- the no-rotation guard is specific to the unknown type',
  )
}

// Test 5: VESSEL_COLORS P2 palette (VIS-3) -- one hardcoded hex per type,
// never read from the VESSEL_COLORS import itself, so a future accidental
// edit to the constant would be caught here rather than silently agreeing
// with itself.
const P2_HEX_BY_TYPE: [VesselType, string][] = [
  ['cargo', '#0AA0FF'],
  ['tanker', '#FF7A1A'],
  ['cruise', '#00B388'],
  ['ferry', '#8C4CE0'],
  ['tugboat', '#D93B4A'],
  ['naval', '#9C9478'],
  ['unknown', '#C8D8F0'],
]
P2_HEX_BY_TYPE.forEach(([type, hex]) => {
  const ctx = createMockCtx()
  drawGlyph(ctx, 960, 540, 0, specFor(type), 1920)
  const fillStyleCall = ctx._calls.find((c) => c === `fillStyle=${hex}`)
  assert(fillStyleCall !== undefined, `${type} fillStyle is ${hex} (VIS-3 P2 palette)`)
})

// Test 6: the typed hulls and unknown silhouette each use one dark outline.
{
  const TYPED: VesselType[] = ['cargo', 'tanker', 'cruise', 'ferry', 'tugboat', 'naval']
  TYPED.forEach((type) => {
    const ctx = createMockCtx()
    drawGlyph(ctx, 960, 540, 45, specFor(type), 1920)
    assert(
      ctx._calls.filter((c) => c === `stroke(path:${DARK_OUTLINE_COLOR})`).length === 1,
      `${type} hull strokes exactly once in ${DARK_OUTLINE_COLOR}`,
    )
  })

  const ctx = createMockCtx()
  drawGlyph(ctx, 960, 540, 45, specFor('unknown'), 1920)
  const strokeCalls = ctx._calls.filter((c) => c.startsWith('stroke('))
  assert(
    strokeCalls.length === 1 && strokeCalls[0] === 'stroke(#0A0E14)',
    `unknown silhouette strokes once in #0A0E14 (got ${JSON.stringify(strokeCalls)})`,
  )
  assert(
    ctx._calls.indexOf('fill(#C8D8F0)') < ctx._calls.indexOf('stroke(#0A0E14)'),
    `unknown silhouette fills before it strokes (calls: ${JSON.stringify(ctx._calls)})`,
  )
}

// Tier thresholds use the full drawn hull length in canvas pixels.
assert(tierFor(TIER2_MIN_PX - 0.01) === 1, 'tier boundary 59.99 is T1')
assert(tierFor(TIER2_MIN_PX) === 2, 'tier boundary 60 is T2')
assert(tierFor(TIER3_MIN_PX - 0.01) === 2, 'tier boundary 99.99 is T2')
assert(tierFor(TIER3_MIN_PX) === 3, 'tier boundary 100 is T3')

// Each typed shape stays within the per-tier fill/stroke budget.
const TYPED_TYPES = ['cargo', 'tanker', 'cruise', 'ferry', 'tugboat', 'naval'] as const
for (const type of TYPED_TYPES) {
  for (const tier of [1, 2, 3] as const) {
    const halfLength = tier === 1 ? 20 : tier === 2 ? 35 : 55
    const baseSize = halfLength / ({ cargo: 0.5, tanker: 0.475, cruise: 0.55, ferry: 0.4, tugboat: 0.31, naval: 0.575 }[type])
    const ctx = createMockCtx()
    drawGlyph(ctx, 0, 0, 0, specFor(type, { baseSize }), 1920)
    const fillCount = ctx._fills.filter((fill) => fill.path).length
    const expectedTier = tierFor(halfLength * 2)
    assert(expectedTier === tier, `${type} tier ${tier} fixture selects T${expectedTier}`)
    assert(fillCount === (tier === 1 ? 3 : 4), `${type} T${tier} uses exactly ${tier === 1 ? 3 : 4} budgeted fills`)
    assert(ctx._calls.filter((call) => call.startsWith('stroke(path:')).length === 1, `${type} T${tier} uses one outline stroke`)
  }
}

function verifyPath(path: Path2DShim): boolean {
  let open = false
  let valid = true
  for (let index = 0; index < path.ops.length; index++) {
    const operation = path.ops[index]
    if (operation.name === 'addPath') {
      if (open) valid = false
      const child = operation.args[0] as Path2DShim
      valid = verifyPath(child) && valid
    } else if (operation.name === 'moveTo') {
      if (open) valid = false
      open = true
    } else if (operation.name === 'rect') {
      if (open) valid = false
      open = true
    } else if (operation.name === 'arc' || operation.name === 'ellipse') {
      if (!open || path.ops[index - 1]?.name !== 'moveTo') valid = false
    } else if (operation.name === 'closePath') {
      if (!open) valid = false
      open = false
    }
  }
  return valid && !open
}

function ellipseRadii(path: Path2DShim): [number, number][] {
  const radii: [number, number][] = []
  for (const operation of path.ops) {
    if (operation.name === 'ellipse') {
      radii.push([operation.args[2] as number, operation.args[3] as number])
    } else if (operation.name === 'addPath') {
      radii.push(...ellipseRadii(operation.args[0] as Path2DShim))
    }
  }
  return radii
}

for (const type of TYPED_TYPES) {
  for (const tier of [1, 2, 3] as const) {
    const shape = getTypedGlyphShape(type, tier)
    for (const path of [shape.hull, shape.dark, shape.light, shape.cutout]) {
      assert(verifyPath(path as unknown as Path2DShim), `${type} T${tier} subpaths are isolated and closed`)
    }
  }
}
const tugboatShape = getTypedGlyphShape('tugboat', 3)
const tugboatEllipses = [
  ...ellipseRadii(tugboatShape.dark as unknown as Path2DShim),
  ...ellipseRadii(tugboatShape.light as unknown as Path2DShim),
]
assert(
  tugboatEllipses.every(([radiusX, radiusY]) => radiusX === radiusY),
  'tugboat round details retain equal radii under the wide-hull fallback',
)

// Hero glow shadows affect the hull only; all subsequent detail fills are unshadowed.
{
  const ctx = createMockCtx()
  drawGlyph(ctx, 0, 0, 0, specFor('cargo'), 1920, { blur: 12, color: '#0AA0FF' })
  const pathFills = ctx._fills.filter((fill) => fill.path)
  assert(pathFills[0]?.shadowBlur === 12, 'hero shadow is applied to the hull fill')
  assert(pathFills.slice(1).every((fill) => fill.shadowBlur === 0), 'detail fills are not shadowed')
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
