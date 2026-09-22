import { drawTrail } from './trails'
import { TrackPoint, VesselType, ProjectionConfig, mapProject } from '@wake/shared'

function createMockCtx() {
  let strokeCount = 0
  let pathCount = 0
  const alphas: number[] = []
  let currentAlpha = 1
  const moves: { x: number; y: number }[] = []
  const lines: { x: number; y: number }[] = []
  let currentStrokeStyle = ''
  let currentLineWidth = 0
  let currentLineCap = ''

  const mockCtx = {
    save: () => {},
    restore: () => {},
    beginPath: () => { pathCount++ },
    moveTo: (x: number, y: number) => { moves.push({ x, y }) },
    lineTo: (x: number, y: number) => { lines.push({ x, y }) },
    stroke: () => { strokeCount++ },
    get strokeStyle() { return currentStrokeStyle },
    set strokeStyle(v: string) { currentStrokeStyle = v },
    get lineWidth() { return currentLineWidth },
    set lineWidth(v: number) { currentLineWidth = v },
    get lineCap() { return currentLineCap },
    set lineCap(v: string) { currentLineCap = v },
    get globalAlpha() { return currentAlpha },
    set globalAlpha(v: number) {
      currentAlpha = v
      alphas.push(v)
    },
    _strokeCount: () => strokeCount,
    _pathCount: () => pathCount,
    _alphas: () => alphas,
    _moves: () => moves,
    _lines: () => lines,
    _strokeStyle: () => currentStrokeStyle,
    _lineWidth: () => currentLineWidth,
    _lineCap: () => currentLineCap,
  }

  return mockCtx as unknown as CanvasRenderingContext2D & {
    _strokeCount: () => number
    _pathCount: () => number
    _alphas: () => number[]
    _moves: () => { x: number; y: number }[]
    _lines: () => { x: number; y: number }[]
    _strokeStyle: () => string
    _lineWidth: () => number
    _lineCap: () => string
  }
}

// Standing in for mapProject: same real math, plus a call counter. Passed
// as drawTrail's injectable projectFn -- production code never sets this,
// it always defaults to the real mapProject.
function createMapProjectSpy() {
  let calls = 0
  const spy: typeof mapProject = (...args) => {
    calls++
    return mapProject(...args)
  }
  return { spy, calls: () => calls }
}

function point(lat: number, lon: number, timestamp: number): TrackPoint {
  return { lat, lon, timestamp }
}

const PROJ: ProjectionConfig = { mirrorX: false, rotationDeg: 0 }

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

// Test 1 — stopped vessel draws no trail
{
  const pts: TrackPoint[] = Array.from({ length: 10 }, (_, i) =>
    point(51.0, 1.0, 1000 + i * 1000),
  )
  const ctx = createMockCtx()
  drawTrail(ctx, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'cargo' as VesselType, 1.0)
  assert(ctx._strokeCount() === 0, 'stopped vessel draws no trail')
}

// Test 2 — moving vessel draws trail segments
{
  const pts: TrackPoint[] = Array.from({ length: 5 }, (_, i) =>
    point(51.0 + i * 0.02, 1.0, 1000 + i * 1000),
  )
  const ctx = createMockCtx()
  drawTrail(ctx, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'cargo' as VesselType, 1.0)
  assert(ctx._strokeCount() >= 3, 'moving vessel draws at least 3 segments')
}

// Test 3 — trail length short uses last 20 points
{
  const pts: TrackPoint[] = Array.from({ length: 40 }, (_, i) =>
    point(51.0 + i * 0.01, 1.0, 1000 + i * 1000),
  )
  const ctx = createMockCtx()
  drawTrail(ctx, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'cargo' as VesselType, 1.0, 'short')
  // 20 points → 19 segments; some may project to null but should be around 19
  assert(ctx._strokeCount() <= 19, 'short trail uses at most 19 segments')
  assert(ctx._strokeCount() >= 10, 'short trail draws a reasonable number of segments')
}

// Test 4 — trail length long uses last 120 points from 150-point array
{
  const pts: TrackPoint[] = Array.from({ length: 150 }, (_, i) =>
    point(51.0 + i * 0.005, 1.0, 1000 + i * 1000),
  )
  const ctx = createMockCtx()
  drawTrail(ctx, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'cargo' as VesselType, 1.0, 'long')
  // 120 points → 119 segments max
  assert(ctx._strokeCount() <= 119, 'long trail uses at most 119 segments')
  assert(ctx._strokeCount() >= 50, 'long trail draws many segments')
}

// Test 5 — oldest segments have lower alpha than newest
{
  const pts: TrackPoint[] = Array.from({ length: 5 }, (_, i) =>
    point(51.0 + i * 0.05, 1.0, 1000 + i * 1000),
  )
  const ctx = createMockCtx()
  drawTrail(ctx, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'cargo' as VesselType, 1.0)
  const alphas = ctx._alphas()
  assert(alphas.length > 0, 'alphas were recorded')
  if (alphas.length > 1) {
    assert(alphas[0] < alphas[alphas.length - 1], 'oldest alpha < newest alpha')
  } else {
    assert(false, 'not enough alphas recorded for comparison')
  }
}

// Test 6 — all points project to null: no throw, zero strokes
{
  const pts: TrackPoint[] = Array.from({ length: 5 }, (_, i) =>
    point(51.0 + i * 0.02, 1.0, 1000 + i * 1000),
  )
  const ctx = createMockCtx()
  let threw = false
  try {
    drawTrail(ctx, pts, PROJ, 0, 0, 1, 1920, 1080, 'cargo' as VesselType, 1.0)
  } catch {
    threw = true
  }
  assert(!threw, 'drawTrail does not throw when all points project to null')
  assert(ctx._strokeCount() === 0, 'zero strokes when all points project to null')
}

// Test 7 — each point is projected at most once per drawTrail call, not
// 2x(N-1). Regression test for the S1.8 diagnostic finding (10,948
// mapProject calls/frame at 92 vessels with 60-point tracks).
{
  const N = 60
  const pts: TrackPoint[] = Array.from({ length: N }, (_, i) =>
    point(51.0 + i * 0.005, 1.0 + i * 0.005, 1000 + i * 1000),
  )
  const ctx = createMockCtx()
  const { spy, calls } = createMapProjectSpy()
  drawTrail(ctx, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'cargo' as VesselType, 1.0, 'long', spy)
  assert(calls() <= N, `mapProject called at most N=${N} times, got ${calls()}`)
  assert(calls() === N, `mapProject called exactly N=${N} times (one per visible point), got ${calls()}`)
}

// Test 8 — output geometry is unchanged from the pre-fix (2x(N-1)-call)
// behaviour. Independently recompute each segment's projection with the
// real mapProject and compare against what moveTo/lineTo actually
// received, rather than trusting that eliminating the duplicate calls
// left the drawn values alone.
{
  const pts: TrackPoint[] = Array.from({ length: 6 }, (_, i) =>
    point(51.0 + i * 0.03, 1.0 + i * 0.01, 1000 + i * 1000),
  )
  const ctx = createMockCtx()
  drawTrail(ctx, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'cargo' as VesselType, 1.0)

  const expectedMoves: { x: number; y: number }[] = []
  const expectedLines: { x: number; y: number }[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = mapProject(pts[i].lat, pts[i].lon, 51.0, 1.0, 50, PROJ, 1920, 1080)
    const p2 = mapProject(pts[i + 1].lat, pts[i + 1].lon, 51.0, 1.0, 50, PROJ, 1920, 1080)
    if (!p1 || !p2) continue
    expectedMoves.push(p1)
    expectedLines.push(p2)
  }

  const actualMoves = ctx._moves()
  const actualLines = ctx._lines()
  const movesMatch =
    actualMoves.length === expectedMoves.length &&
    actualMoves.every((m, i) => Math.abs(m.x - expectedMoves[i].x) < 1e-9 && Math.abs(m.y - expectedMoves[i].y) < 1e-9)
  const linesMatch =
    actualLines.length === expectedLines.length &&
    actualLines.every((l, i) => Math.abs(l.x - expectedLines[i].x) < 1e-9 && Math.abs(l.y - expectedLines[i].y) < 1e-9)

  assert(movesMatch, `moveTo coordinates match independently-recomputed projections (${actualMoves.length} segments)`)
  assert(linesMatch, `lineTo coordinates match independently-recomputed projections (${actualLines.length} segments)`)
}

// Test 9 — VIS-3 T2 styling: vessel colour, lineWidth 2.0 * canvasWidth/1920,
// lineCap 'round' (unchanged), globalAlpha = (0.35 + 0.45 * fraction) *
// opacity. Three points on one meridian with equal latitude steps so both
// segments are the same length: segment 1's fraction is 0 (cumulative
// distance 0 at its start), segment 2's is exactly 0.5 (half the total
// distance travelled by the time it starts). Hardcoded expected values,
// never computed through drawTrail itself.
{
  const pts: TrackPoint[] = [point(51.0, 1.0, 1000), point(51.02, 1.0, 2000), point(51.04, 1.0, 3000)]

  const ctx1920 = createMockCtx()
  drawTrail(ctx1920, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'cargo' as VesselType, 1.0)
  assert(ctx1920._strokeStyle() === '#0AA0FF', `cargo strokeStyle is #0AA0FF (got ${ctx1920._strokeStyle()})`)
  assert(ctx1920._lineWidth() === 2, `lineWidth is 2 at canvasWidth 1920 (got ${ctx1920._lineWidth()})`)
  assert(ctx1920._lineCap() === 'round', `lineCap is round (got ${ctx1920._lineCap()})`)
  const alphas1920 = ctx1920._alphas()
  assert(alphas1920.length === 2, `2 segment alphas recorded (got ${alphas1920.length})`)
  assert(
    Math.abs(alphas1920[0] - 0.35) < 1e-9 && Math.abs(alphas1920[1] - 0.575) < 1e-9,
    `opacity=1 segment alphas are [0.35, 0.575] (got [${alphas1920[0]}, ${alphas1920[1]}])`,
  )

  const ctx960 = createMockCtx()
  drawTrail(ctx960, pts, PROJ, 51.0, 1.0, 50, 960, 540, 'cargo' as VesselType, 1.0)
  assert(ctx960._lineWidth() === 1, `lineWidth is 1 at canvasWidth 960 (got ${ctx960._lineWidth()})`)

  const ctxDim = createMockCtx()
  drawTrail(ctxDim, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'cargo' as VesselType, 0.2)
  const alphasDim = ctxDim._alphas()
  assert(
    alphasDim.length === 2 && Math.abs(alphasDim[0] - 0.07) < 1e-9 && Math.abs(alphasDim[1] - 0.115) < 1e-9,
    `opacity=0.2 segment alphas are [0.07, 0.115] (got [${alphasDim[0]}, ${alphasDim[1]}])`,
  )

  const ctxUnknown = createMockCtx()
  drawTrail(ctxUnknown, pts, PROJ, 51.0, 1.0, 50, 1920, 1080, 'unknown' as VesselType, 1.0)
  assert(ctxUnknown._strokeStyle() === '#C8D8F0', `unknown strokeStyle is #C8D8F0 (got ${ctxUnknown._strokeStyle()})`)
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
