import { drawGlyph, GLYPH_DOT_RADIUS_RATIO } from './glyphs'
import { VesselGlyphSpec, VesselType, NOTABLE_COLOR } from '@wake/shared'

// Minimal mock CanvasRenderingContext2D that records draw calls
function createMockCtx() {
  const calls: string[] = []
  let currentFillStyle = ''
  let currentStrokeStyle = ''

  const mockCtx = {
    save: () => { calls.push('save') },
    restore: () => { calls.push('restore') },
    translate: (x: number, y: number) => { calls.push(`translate(${x},${y})`) },
    rotate: (angle: number) => { calls.push(`rotate(${angle})`) },
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
    fill: () => { calls.push(`fill(${currentFillStyle})`) },
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
    stroke: () => { calls.push(`stroke(${currentStrokeStyle})`) },
    get strokeStyle() { return currentStrokeStyle },
    set strokeStyle(v: string) { currentStrokeStyle = v },
    lineWidth: 0,
    get fillStyle() { return currentFillStyle },
    set fillStyle(v: string) {
      currentFillStyle = v
      calls.push(`fillStyle=${v}`)
    },
    globalAlpha: 1,
    _calls: calls,
  }

  return mockCtx as unknown as CanvasRenderingContext2D & { _calls: string[] }
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
})

// Test 2: Size scaling produces expected actualSize
// We verify by checking that roundRect/rect/arc receive scaled dimensions.
// For cargo at 1920: baseSize=28 => size=28. width = 28*0.35 = 9.8
{
  const ctx = createMockCtx()
  drawGlyph(ctx, 960, 540, 0, specFor('cargo'), 1920)
  const call = ctx._calls.find((c) => c.startsWith('moveTo'))
  // cargo bow tip at y = -size/2 = -14
  assert(call === 'moveTo(0,-14)', 'cargo size at 1920 width')
}
{
  const ctx = createMockCtx()
  drawGlyph(ctx, 960, 540, 0, specFor('cargo'), 960)
  const call = ctx._calls.find((c) => c.startsWith('moveTo'))
  // size = 28 * (960/1920) = 14. bow tip = -7
  assert(call === 'moveTo(0,-7)', 'cargo size at 960 width')
}
{
  const ctx = createMockCtx()
  drawGlyph(ctx, 960, 540, 0, specFor('cargo'), 3840)
  const call = ctx._calls.find((c) => c.startsWith('moveTo'))
  // size = 28 * 2 = 56. bow tip = -28
  assert(call === 'moveTo(0,-28)', 'cargo size at 3840 width')
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

// Test 6: VIS-8 A11 -- the dark outline reaches the unknown silhouette and
// nothing else. Every typed hull must emit no stroke at all: that is the
// boundary the reverted "stroke outline on glyphs" correction sits on.
{
  const TYPED: VesselType[] = ['cargo', 'tanker', 'cruise', 'ferry', 'tugboat', 'naval']
  TYPED.forEach((type) => {
    const ctx = createMockCtx()
    drawGlyph(ctx, 960, 540, 45, specFor(type), 1920)
    assert(
      ctx._calls.every((c) => !c.startsWith('stroke(')),
      `${type} hull records no stroke -- A11's outline never reaches a typed hull`,
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

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
