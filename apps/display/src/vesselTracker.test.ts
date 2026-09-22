import type { VesselFix, VesselState, VesselType, TrackPoint, DisplayConfig } from '@wake/shared'
import { DEFAULT_CONFIG, GLYPH_SCALES, LABEL_SIZES, UNKNOWN_SCALES, SWEEP_PERIODS, nextGlyphScale } from '@wake/shared'
import type { ClientVesselEntry } from './wakeSocket'
import {
  createTrackedVesselMap,
  onFixArrived,
  renderFrame,
  isStoppedForGlyph,
  STOPPED_MAX_SOG_KN,
  type RenderContext,
  type TrackedVesselMap,
} from './vesselTracker'
import { HERO_MIN_SOG_KN } from './heroes'
import { GLYPH_DOT_RADIUS_RATIO } from './canvas/glyphs'
import { buildLegendRows, drawLegend, legendLabel, LEGEND_ORDER, type LegendRow } from './canvas/legend'
import { liveAisText, estimateTextWidth } from './canvas/labels'

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

// Combined mock CanvasRenderingContext2D -- covers everything both
// drawGlyph and drawTrail call, matching glyphs.test.ts's and
// trails.test.ts's existing mock patterns (no DOM either way).
function createMockCtx() {
  const calls: string[] = []
  let fillCount = 0
  let arcCount = 0
  let bezierCount = 0
  let strokeCount = 0
  let radialGradientCount = 0
  let conicGradientCount = 0
  let fillTextCount = 0
  let clipCount = 0

  const translates: { x: number; y: number }[] = []
  const fillTexts: { text: string; x: number; y: number; fillStyle: string; globalAlpha: number; font: string }[] = []

  // VIS-8: fillStyle/globalAlpha/font become tracked values so a draw's
  // colour and alpha can be asserted, not just its geometry. Deliberately
  // recorded into their own arrays and NOT into `calls` -- two existing
  // scenarios assert ctx._calls.length === 0, and pushing style changes
  // into that log would break them.
  const fills: { fillStyle: string; globalAlpha: number }[] = []
  // VIS-8 A11: strokes record their colour and width too. Trail segments
  // stroke in the vessel's own type colour; the new outline strokes in
  // DARK_OUTLINE_COLOR, so scenarios counting trail segments can exclude it
  // instead of silently counting one extra per glyph.
  const strokes: { strokeStyle: string; lineWidth: number }[] = []
  let currentStrokeStyle = ''
  let currentLineWidth = 0
  let currentFillStyle = ''
  let currentAlpha = 1
  let currentFont = ''

  const mockCtx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    translate: (x: number, y: number) => {
      translates.push({ x, y })
      calls.push(`translate(${x},${y})`)
    },
    rotate: (a: number) => calls.push(`rotate(${a})`),
    beginPath: () => calls.push('beginPath'),
    moveTo: (x: number, y: number) => calls.push(`moveTo(${x},${y})`),
    lineTo: (x: number, y: number) => calls.push(`lineTo(${x},${y})`),
    bezierCurveTo: (...args: number[]) => {
      bezierCount++
      calls.push(`bezierCurveTo(${args.join(',')})`)
    },
    arc: (...args: number[]) => {
      arcCount++
      calls.push(`arc(${args.join(',')})`)
    },
    closePath: () => calls.push('closePath'),
    fill: () => {
      fillCount++
      fills.push({ fillStyle: currentFillStyle, globalAlpha: currentAlpha })
      calls.push('fill')
    },
    fillRect: (x: number, y: number, w: number, h: number) => calls.push(`fillRect(${x},${y},${w},${h})`),
    stroke: () => {
      strokeCount++
      strokes.push({ strokeStyle: currentStrokeStyle, lineWidth: currentLineWidth })
      calls.push('stroke')
    },
    // VIS-6: range rings use setLineDash, hero glow uses
    // createRadialGradient plus ctx.shadowBlur/shadowColor -- none of
    // these existed on this mock before VIS-6, and every renderFrame
    // call now reaches setLineDash via drawRangeRings (rangeRingsEnabled
    // defaults true), so without these the mock would throw, not just
    // under-report.
    setLineDash: (segments: number[]) => calls.push(`setLineDash(${JSON.stringify(segments)})`),
    createRadialGradient: (...args: number[]) => {
      radialGradientCount++
      calls.push(`createRadialGradient(${args.join(',')})`)
      return { addColorStop: () => {} } as unknown as CanvasGradient
    },
    // VIS-7: radar sweep uses createConicGradient + clip; hero labels and
    // the area title use fillText/font/textAlign/letterSpacing. None of
    // these existed on this mock before VIS-7 (A1's audit finding).
    createConicGradient: (...args: number[]) => {
      conicGradientCount++
      calls.push(`createConicGradient(${args.join(',')})`)
      return { addColorStop: () => {} } as unknown as CanvasGradient
    },
    clip: () => {
      clipCount++
      calls.push('clip')
    },
    fillText: (text: string, x: number, y: number) => {
      fillTextCount++
      fillTexts.push({ text, x, y, fillStyle: currentFillStyle, globalAlpha: currentAlpha, font: currentFont })
      calls.push(`fillText(${JSON.stringify(text)},${x},${y})`)
    },
    get fillStyle() { return currentFillStyle },
    set fillStyle(v: string) { currentFillStyle = v },
    get strokeStyle() { return currentStrokeStyle },
    set strokeStyle(v: string) { currentStrokeStyle = v },
    get lineWidth() { return currentLineWidth },
    set lineWidth(v: number) { currentLineWidth = v },
    lineCap: '',
    get globalAlpha() { return currentAlpha },
    set globalAlpha(v: number) { currentAlpha = v },
    shadowBlur: 0,
    shadowColor: '',
    get font() { return currentFont },
    set font(v: string) { currentFont = v },
    textAlign: '',
    letterSpacing: '0px',
    _calls: calls,
    _fillCount: () => fillCount,
    _arcCount: () => arcCount,
    _bezierCount: () => bezierCount,
    _strokeCount: () => strokeCount,
    _translates: () => translates,
    _radialGradientCount: () => radialGradientCount,
    _conicGradientCount: () => conicGradientCount,
    _clipCount: () => clipCount,
    _fillTextCount: () => fillTextCount,
    _fillTexts: () => fillTexts,
    _fills: () => fills,
    _strokes: () => strokes,
    // Trail segments only: every stroke that is not VIS-8 A11's outline.
    _trailStrokeCount: () => strokes.filter((v) => v.strokeStyle !== '#0A0E14').length,
  }

  return mockCtx as unknown as CanvasRenderingContext2D & {
    _calls: string[]
    _fillCount: () => number
    _arcCount: () => number
    _bezierCount: () => number
    _strokeCount: () => number
    _translates: () => { x: number; y: number }[]
    _radialGradientCount: () => number
    _conicGradientCount: () => number
    _clipCount: () => number
    _fillTextCount: () => number
    _fillTexts: () => { text: string; x: number; y: number; fillStyle: string; globalAlpha: number; font: string }[]
    _fills: () => { fillStyle: string; globalAlpha: number }[]
    _strokes: () => { strokeStyle: string; lineWidth: number }[]
    _trailStrokeCount: () => number
  }
}

function fix(mmsi: string, lat: number, lon: number, timestamp: number, sogKn = 0, cogDeg = 0): VesselFix {
  return { mmsi, lat, lon, cogDeg, sogKn, timestamp }
}

// VIS-8: a typed vessel below STOPPED_MAX_SOG_KN (0.5kn) now draws a dot
// rather than a hull, and fix()'s own sogKn default is 0. Pre-VIS-8
// scenarios whose subject is hull geometry, glyph stacking or hero-vs-
// non-hero sizing therefore pass stoppedAsDot: false, isolating them from
// a feature they were not written to exercise -- the same convention this
// file already uses with rangeRingsEnabled: false and sweepPeriodSec: 0.
// Giving those fixtures a speed instead would have been wrong: it would
// have made them hero-eligible and changed their drawn size. Scenarios
// about the dot rule itself set their own speeds and leave it on.

// Inside the signed-off 20nm Dover view (center 51.1, 1.45).
const IN_VIEW_LAT = 51.1
const IN_VIEW_LON = 1.45
// Equator/prime-meridian, many thousands of nm from Dover -- outside any
// sane view radius.
const OUT_OF_VIEW_LAT = 0
const OUT_OF_VIEW_LON = 0

// VIS-7: sweepPeriodSec defaults to 0 in this test fixture (not
// DEFAULT_CONFIG's own 10) so every pre-VIS-7 scenario below -- written
// before the radar sweep existed -- keeps its original "every vessel
// draws on the first frame" behaviour. Same rationale as this file's
// existing per-scenario rangeRingsEnabled:false overrides: isolate the
// behaviour actually under test from an unrelated always-on feature.
// Sweep/reveal scenarios override sweepPeriodSec explicitly.
//
// VIS-8 does the same for legendEnabled, for the same reason: the legend
// draws its own arcs, fills and fillTexts on every frame, which every
// scenario counting a vessel's draw calls would otherwise pick up. The
// legend scenarios turn it back on explicitly.
function baseRenderContext(overrides?: Partial<RenderContext>): RenderContext {
  return {
    centerLat: 51.1,
    centerLon: 1.45,
    radiusNm: 20,
    projConfig: { mirrorX: false, rotationDeg: 0 },
    canvasWidth: 1920,
    canvasHeight: 1080,
    nowMs: 1000,
    deltaMs: 16,
    config: { ...DEFAULT_CONFIG, sweepPeriodSec: 0, legendEnabled: false },
    areaDisplayName: 'DOVER STRAIT',
    ...overrides,
  }
}

// Scenario: applyFix fires once per new fix, never per frame.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctx = createMockCtx()

  onFixArrived(tracked, fix('111111111', IN_VIEW_LAT, IN_VIEW_LON, 1000))
  assert(tracked.get('111111111')?.track.length === 1, 'applyFix-once: one track point after one fix')

  for (let i = 0; i < 5; i++) {
    renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 1000 + i * 16, deltaMs: 16 }))
  }
  assert(
    tracked.get('111111111')?.track.length === 1,
    'applyFix-once: still exactly one track point after five frames with no new fix',
  )
}

// Scenario: updateVesselState runs every frame with the real nowMs --
// a moving vessel's eased position advances over successive frames.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctx = createMockCtx()

  onFixArrived(tracked, fix('222222222', 51.1, 1.45, 1000, 20, 90)) // 20kn due east
  const initialLon = tracked.get('222222222')!.displayLon

  renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 1000 + 5000, deltaMs: 5000 }))
  const afterOneFrame = tracked.get('222222222')!.displayLon
  assert(afterOneFrame > initialLon, 'updateVesselState: eased longitude moved east after 5s at 20kn due east')

  renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 1000 + 10000, deltaMs: 5000 }))
  const afterTwoFrames = tracked.get('222222222')!.displayLon
  assert(afterTwoFrames > afterOneFrame, 'updateVesselState: eased longitude kept advancing on the next frame, using the new nowMs')
}

// Scenario: a null mapProject result (out of view) is skipped, not
// drawn -- and the vessel is not evicted, distinct from expiry.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctx = createMockCtx()

  onFixArrived(tracked, fix('333333333', OUT_OF_VIEW_LAT, OUT_OF_VIEW_LON, 1000))
  // rangeRingsEnabled off: this test's arcCount is about the vessel's
  // glyph, not the always-on-regardless-of-vessels range rings (VIS-6),
  // which draw their own arc() calls with rangeRingsEnabled at its true
  // default.
  renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0 } }))

  assert(ctx._fillCount() === 0 && ctx._arcCount() === 0 && ctx._bezierCount() === 0, 'out-of-view: no glyph drawn')
  assert(tracked.has('333333333'), 'out-of-view: vessel still tracked, not evicted -- being off-screen is not expiry')
}

// Scenario: undefined vesselType draws as 'unknown'; a known type draws
// its own hull -- the positive case alongside the required negative one.
// VIS-8 A7 replaced the unknown circle with a silhouette, so both now go
// through hullPath and the arc/bezier split no longer tells them apart.
// They are told apart by drawn half-length instead, read from hullPath's
// own first call, moveTo(0, -hh). A9 then redistributed the unknown
// silhouette's 10.08 half-extent at 1:2.67, so its hh is
// 10.08 / sqrt(0.375) = 16.46057107150296; a typed cargo's is
// 120 * 0.75 * 0.5 = 45.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctxUnknown = createMockCtx()

  onFixArrived(tracked, fix('444444444', IN_VIEW_LAT, IN_VIEW_LON, 1000))
  // clientState has no entry at all for 444444444 -- no static resolution ever seen.
  // rangeRingsEnabled off -- see the out-of-view scenario's comment.
  renderFrame(tracked, clientState, ctxUnknown, baseRenderContext({ nowMs: 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0 } }))
  assert(
    ctxUnknown._calls.includes('moveTo(0,-16.46057107150296)'),
    `undefined-type: renders via drawUnknown's silhouette, half-length 16.46057107150296 (moveTos: ${JSON.stringify(ctxUnknown._calls.filter((c) => c.startsWith('moveTo(0,-')))})`,
  )
  assert(ctxUnknown._arcCount() === 0, 'undefined-type: the unknown glyph is no longer a circle -- no arc drawn')
  assert(
    ctxUnknown._calls.every((c) => !c.startsWith('rotate(')),
    `undefined-type: an unknown vessel records no rotate() call at all (got ${JSON.stringify(ctxUnknown._calls.filter((c) => c.startsWith('rotate(')))})`,
  )

  const ctxCargo = createMockCtx()
  const tracked2 = createTrackedVesselMap()
  onFixArrived(tracked2, fix('555555555', IN_VIEW_LAT, IN_VIEW_LON, 1000))
  clientState.set('555555555', { vesselType: 'cargo' })
  renderFrame(tracked2, clientState, ctxCargo, baseRenderContext({ nowMs: 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0, stoppedAsDot: false } }))
  assert(ctxCargo._bezierCount() > 0, 'known-type: cargo renders via its hull (bezier), not the unknown arc')
  assert(ctxCargo._arcCount() === 0, 'known-type: no unknown-arc drawn for a typed vessel')
}

// Scenario: trail points come from VesselState.track, verified by
// asserting the exact points held and the exact segment count drawn.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctx = createMockCtx()
  const mmsi = '666666666'

  const points = [
    { lat: 51.10, lon: 1.45, ts: 1000 },
    { lat: 51.11, lon: 1.46, ts: 2000 }, // real separation, comfortably over drawTrail's 0.1nm total-distance floor
    { lat: 51.12, lon: 1.47, ts: 3000 },
  ]
  for (const p of points) onFixArrived(tracked, fix(mmsi, p.lat, p.lon, p.ts))

  const state = tracked.get(mmsi)!
  const expectedTrack = points.map((p) => ({ lat: p.lat, lon: p.lon, timestamp: p.ts }))
  assert(
    JSON.stringify(state.track) === JSON.stringify(expectedTrack),
    `trail-source: VesselState.track holds exactly the fed points (got ${JSON.stringify(state.track)})`,
  )

  // rangeRingsEnabled off -- see the out-of-view scenario's comment;
  // range rings stroke() four times regardless of vessel count.
  renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 3000, config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0 } }))
  // VIS-8 A11: trail segments only -- the unknown silhouette now strokes
  // its own dark outline, which is not a trail segment.
  assert(
    ctx._trailStrokeCount() === expectedTrack.length - 1,
    `trail-source: drawTrail drew exactly track.length-1 (${expectedTrack.length - 1}) segments (got ${ctx._trailStrokeCount()})`,
  )
}

// Scenario: a vessel with a single track point draws no trail (a
// stopped/just-discovered vessel), while its glyph still draws.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctx = createMockCtx()

  onFixArrived(tracked, fix('777777777', IN_VIEW_LAT, IN_VIEW_LON, 1000))
  // rangeRingsEnabled off -- see the out-of-view scenario's comment.
  renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0 } }))

  assert(ctx._trailStrokeCount() === 0, 'single-point: no trail segments drawn')
  assert(ctx._fillCount() > 0 || ctx._arcCount() > 0, 'single-point: glyph still drawn for this vessel')
}

// Scenario: an expired vessel is not drawn, and is pruned from tracked.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctx = createMockCtx()
  const removeSec = DEFAULT_CONFIG.removeSec

  onFixArrived(tracked, fix('888888888', IN_VIEW_LAT, IN_VIEW_LON, 0))
  // rangeRingsEnabled off -- see the out-of-view scenario's comment;
  // "nothing drawn" here means nothing drawn for the vessel, and range
  // rings draw regardless of vessel count.
  // areaTitleEnabled off too -- VIS-7's area title draws unconditionally
  // regardless of vessel count, so it would otherwise contaminate this
  // "nothing drawn" check exactly like range rings would.
  renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: removeSec * 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0, areaTitleEnabled: false } }))

  assert(!tracked.has('888888888'), `expired: vessel pruned from tracked at the removeSec (${removeSec}s) boundary`)
  assert(ctx._calls.length === 0, 'expired: nothing drawn for it')
}

// Scenario: zero vessels renders without error.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctx = createMockCtx()
  let threw = false
  try {
    renderFrame(tracked, clientState, ctx, baseRenderContext({ config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0, areaTitleEnabled: false } }))
  } catch {
    threw = true
  }
  assert(!threw, 'zero-vessels: renderFrame does not throw on an empty map')
  assert(ctx._calls.length === 0, 'zero-vessels: nothing drawn (rangeRingsEnabled/areaTitleEnabled off here -- VIS-6 rings-with-zero-vessels and VIS-7 area-title scenarios below cover those on their own)')
}

// Scenario: NaN handling. Conclusion (see report): NaN lat/lon cannot
// arise via any real path -- normalize.ts's own numeric guard plus
// JSON's inability to encode a literal NaN rule it out on the wire, and
// deadReckon's pole guard is the only internal division that could
// otherwise produce one. No guard was added to projection.ts or
// vesselTracker.ts. This test documents the actual, unguarded behaviour
// for a hypothetical corrupted state (bypassing onFixArrived entirely,
// since no real path produces this) rather than asserting a defence
// that was deliberately not built: mapProject returns a non-null
// {x, y: NaN} for it, and drawGlyph/drawTrail's canvas calls with NaN
// coordinates are a silent no-op per the Canvas spec, not a throw.
{
  const tracked: TrackedVesselMap = new Map()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctx = createMockCtx()

  const corrupted: VesselState = {
    mmsi: '999999999',
    lastFix: fix('999999999', IN_VIEW_LAT, IN_VIEW_LON, 1000),
    displayLat: NaN,
    displayLon: IN_VIEW_LON,
    track: [{ lat: IN_VIEW_LAT, lon: IN_VIEW_LON, timestamp: 1000 }],
  }
  tracked.set('999999999', corrupted)

  let threw = false
  try {
    renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 1000 }))
  } catch {
    threw = true
  }
  assert(!threw, 'NaN-coordinates: renderFrame does not throw on a hypothetically corrupted NaN displayLat (no real path produces this; see report)')
}

// Scenario: closes the S1.8 diagnostic's self-identified test-coverage
// gap. Prior tests only checked that displayLon changed across frames --
// never that the EASED position specifically (not the raw lastFix) is
// what reaches mapProject/drawGlyph. Fixtures there kept eased and raw
// numerically close, so a hypothetical raw-fix regression could have
// passed unnoticed. Here, a high-SOG vessel is aged past a large elapsed
// time in one big-deltaMs frame so smoothingAlpha is driven to ~1 --
// eased and raw positions diverge by ~0.83nm (Correction 3's cited
// worst-case drift), far more than floating-point noise.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const ctx = createMockCtx()

  const sogKn = 24.9 // observed legitimate maximum, CLAUDE.md
  const cogDeg = 90 // due east
  const fixLat = 51.1
  const fixLon = 1.45
  const fixTs = 1000
  const centerLat = 51.1
  const centerLon = 1.45
  const radiusNm = 20
  const canvasWidth = 1920
  const canvasHeight = 1080

  onFixArrived(tracked, fix('101010101', fixLat, fixLon, fixTs, sogKn, cogDeg))

  const elapsedMs = 120000 // hits maxExtrapolationSec (120s) exactly
  const nowMs = fixTs + elapsedMs
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    centerLat, centerLon, radiusNm, canvasWidth, canvasHeight,
    nowMs, deltaMs: elapsedMs,
  }))

  const eased = tracked.get('101010101')!
  assert(
    Math.abs(eased.displayLon - fixLon) > 0.001,
    `sanity: updateVesselState actually moved displayLon away from the raw fix (displayLon=${eased.displayLon}, fixLon=${fixLon})`,
  )

  // Independently recompute the dead-reckoned target -- same physics as
  // deadReckon in shared/src/vesselState.ts, reimplemented fresh here
  // rather than imported, per the project's "independently recompute"
  // evidence rule.
  const elapsedSec = Math.min(elapsedMs / 1000, DEFAULT_CONFIG.maxExtrapolationSec)
  const distanceNm = (sogKn * elapsedSec) / 3600
  const cogRad = (cogDeg * Math.PI) / 180
  const expectedTargetLat = fixLat + (distanceNm * Math.cos(cogRad)) / 60
  const expectedTargetLon = fixLon + (distanceNm * Math.sin(cogRad)) / (60 * Math.cos((fixLat * Math.PI) / 180))

  // Invert mapProject's own formula (mirrorX=false, rotationDeg=0, the
  // baseRenderContext default) to recover the lat/lon that actually
  // reached ctx.translate(x, y) in drawGlyph -- the only place the
  // projected canvas position is observable from outside.
  const pxPerNm = Math.min(canvasWidth, canvasHeight) / 2 / radiusNm
  const t = ctx._translates()
  assert(t.length === 1, `exactly one glyph translate() call recorded (got ${t.length})`)
  const { x, y } = t[0]
  const lonOffsetNm = (x - canvasWidth / 2) / pxPerNm
  const latOffsetNm = (canvasHeight / 2 - y) / pxPerNm
  const backLat = centerLat + latOffsetNm / 60
  const backLon = centerLon + lonOffsetNm / (60 * Math.cos((centerLat * Math.PI) / 180))

  assert(
    Math.abs(backLat - expectedTargetLat) < 0.0005 && Math.abs(backLon - expectedTargetLon) < 0.0005,
    `mapProject-input: the position that actually reached drawGlyph matches the independently-recomputed eased/dead-reckoned target (backLat=${backLat}, expectedTargetLat=${expectedTargetLat}, backLon=${backLon}, expectedTargetLon=${expectedTargetLon})`,
  )
  assert(
    Math.abs(backLon - fixLon) > 0.01,
    `mapProject-input: the position that reached drawGlyph is NOT the raw, un-eased fix.lon (backLon=${backLon}, raw fixLon=${fixLon}, diff=${Math.abs(backLon - fixLon)})`,
  )
}

// Scenario: glyph rotation follows the projection (Correction 18), not
// raw cogDeg. Reads the recorded rotate() radians back into degrees and
// compares against the hardcoded expected screen heading -- not derived
// via screenHeadingDeg itself, per the project's independent-recompute
// rule. mirrorX true, rotationDeg 0 (DEFAULT_CONFIG's own shape): a
// vessel travelling due east (COG 90) has its bow drawn at 270 degrees
// clockwise from screen-up. mirrorX false: 90 degrees.
{
  function recordedRotateDeg(ctx: ReturnType<typeof createMockCtx>): number {
    const call = ctx._calls.find((c) => c.startsWith('rotate('))
    if (!call) throw new Error('no rotate() call recorded')
    const rad = Number(call.slice('rotate('.length, -1))
    return (rad * 180) / Math.PI
  }

  const trackedMirrored = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  // VIS-8 A7: both vessels are given a type. Unknown-type vessels no
  // longer rotate at all (their heading data is the least trustworthy in
  // the feed), so an untyped vessel records no rotate() call to read --
  // this scenario is about typed hulls following the projection.
  clientState.set('121212121', { vesselType: 'cargo' })
  clientState.set('131313131', { vesselType: 'cargo' })
  const ctxMirrored = createMockCtx()
  onFixArrived(trackedMirrored, fix('121212121', IN_VIEW_LAT, IN_VIEW_LON, 1000, 15, 90))
  renderFrame(trackedMirrored, clientState, ctxMirrored, baseRenderContext({
    nowMs: 1000,
    projConfig: { mirrorX: true, rotationDeg: 0 },
  }))
  const mirroredDeg = recordedRotateDeg(ctxMirrored)
  assert(
    Math.abs(mirroredDeg - 270) <= 0.01,
    `heading-follows-projection: mirrorX=true COG=90 draws bow at 270deg screen heading (got ${mirroredDeg})`,
  )

  const trackedUnmirrored = createTrackedVesselMap()
  const ctxUnmirrored = createMockCtx()
  onFixArrived(trackedUnmirrored, fix('131313131', IN_VIEW_LAT, IN_VIEW_LON, 1000, 15, 90))
  renderFrame(trackedUnmirrored, clientState, ctxUnmirrored, baseRenderContext({
    nowMs: 1000,
    projConfig: { mirrorX: false, rotationDeg: 0 },
  }))
  const unmirroredDeg = recordedRotateDeg(ctxUnmirrored)
  assert(
    Math.abs(unmirroredDeg - 90) <= 0.01,
    `heading-follows-projection: mirrorX=false COG=90 draws bow at 90deg screen heading (got ${unmirroredDeg})`,
  )
}

// Scenario: draw order is trails-under-glyphs, and glyph stacking is
// stable (largest hull first, ties by MMSI ascending) regardless of
// vessel discovery order. Previously each vessel drew glyph-then-trail
// in Map insertion order, so a trail painted over its own glyph and
// stacking depended on discovery history.
//
// Vessel identity in the recorded call log is read from the hull's own
// moveTo(0, -hh) call -- hullPath's first drawing call, whose y-argument
// is a literal function of baseSize alone (hh = baseSize * a per-type
// constant), independent of screen position or rotation. This avoids
// re-deriving eased/projected coordinates just to tell vessels apart.
{
  const vesselDefs: { mmsi: string; type: VesselType; lat: number; lon: number }[] = [
    { mmsi: '900000001', type: 'ferry', lat: 51.10, lon: 1.45 }, // baseSize 90 -> hh 36
    { mmsi: '900000002', type: 'cargo', lat: 51.12, lon: 1.47 }, // baseSize 120 -> hh 60
    { mmsi: '900000003', type: 'tanker', lat: 51.14, lon: 1.49 }, // baseSize 110 -> hh 52.25
  ]

  function runOrder(insertOrder: typeof vesselDefs) {
    const tracked = createTrackedVesselMap()
    const clientState = new Map<string, ClientVesselEntry>()
    const ctx = createMockCtx()

    for (const v of insertOrder) {
      clientState.set(v.mmsi, { vesselType: v.type })
      onFixArrived(tracked, fix(v.mmsi, v.lat, v.lon, 1000))
      onFixArrived(tracked, fix(v.mmsi, v.lat + 0.01, v.lon + 0.01, 2000))
    }

    // glyphScale: 1 -- this test is about stacking order, not size; keeping
  // scale at 1 keeps the hardcoded hh values below meaningful (they'd
  // otherwise be scaled by DEFAULT_CONFIG.glyphScale's 0.75, VIS-4). 1 is
  // deliberately outside GLYPH_SCALES (no real setting offers "no scale
  // change"), so it needs an explicit cast past the field's literal
  // union -- this override exists only to neutralize scaling for this
  // one order-only test, not to represent an achievable setting.
  renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 2000, config: { ...DEFAULT_CONFIG, legendEnabled: false, glyphScale: 1 as (typeof GLYPH_SCALES)[number], sweepPeriodSec: 0, stoppedAsDot: false } }))
    return ctx
  }

  const ctx1 = runOrder(vesselDefs)
  const ctx2 = runOrder([vesselDefs[2], vesselDefs[0], vesselDefs[1]])

  const hullMoveTos = (ctx: ReturnType<typeof runOrder>) => ctx._calls.filter((c) => c.startsWith('moveTo(0,-'))
  const order1 = hullMoveTos(ctx1)
  const order2 = hullMoveTos(ctx2)
  const expectedOrder = ['moveTo(0,-60)', 'moveTo(0,-52.25)', 'moveTo(0,-36)'] // cargo, tanker, ferry

  assert(order1.length === 3, `draw-order: three hull moveTo calls recorded (got ${order1.length})`)
  assert(
    JSON.stringify(order1) === JSON.stringify(expectedOrder),
    `draw-order: glyphs stack largest-hull-first -- cargo, tanker, ferry (got ${JSON.stringify(order1)})`,
  )
  assert(
    JSON.stringify(order1) === JSON.stringify(order2),
    `draw-order: same glyph stacking order regardless of insertion order (order1=${JSON.stringify(order1)}, order2=${JSON.stringify(order2)})`,
  )

  const lastStrokeIndex = ctx1._calls.lastIndexOf('stroke')
  const firstFillIndex = ctx1._calls.indexOf('fill')
  assert(lastStrokeIndex >= 0, 'draw-order: at least one trail stroke recorded')
  assert(firstFillIndex >= 0, 'draw-order: at least one glyph fill recorded')
  assert(
    lastStrokeIndex < firstFillIndex,
    `draw-order: every trail stroke comes before every glyph fill (lastStroke=${lastStrokeIndex}, firstFill=${firstFillIndex})`,
  )
}

// Scenario: VIS-4 glyph size setting -- the exported constant and default.
{
  assert(DEFAULT_CONFIG.glyphScale === 0.75, `DEFAULT_CONFIG.glyphScale is 0.75 (got ${DEFAULT_CONFIG.glyphScale})`)
  assert(
    JSON.stringify(GLYPH_SCALES) === JSON.stringify([0.75, 0.55, 0.4, 0.3]),
    `GLYPH_SCALES deep-equals [0.75, 0.55, 0.4, 0.3] (got ${JSON.stringify(GLYPH_SCALES)})`,
  )
}

// Scenario: renderFrame scales the baseSize passed to drawGlyph by
// config.glyphScale. One cargo vessel (baseSize 120, hh = baseSize * 0.5
// inside drawCargo) at canvasWidth 1920, so glyphs.ts's own
// canvasWidth/1920 scaling is identity and the recorded hull moveTo's
// y-argument directly reflects 120 * glyphScale * 0.5. Hardcoded expected
// values, tolerance 1e-9 for float rounding.
{
  function hullMoveToRawY(glyphScale: 0.75 | 0.3): number {
    const tracked = createTrackedVesselMap()
    const clientState = new Map<string, ClientVesselEntry>()
    const mmsi = '900000099'
    clientState.set(mmsi, { vesselType: 'cargo' })
    onFixArrived(tracked, fix(mmsi, IN_VIEW_LAT, IN_VIEW_LON, 1000))
    const ctx = createMockCtx()
    renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, glyphScale, stoppedAsDot: false } }))
    const call = ctx._calls.find((c) => c.startsWith('moveTo(0,-'))
    if (!call) throw new Error('no hull moveTo call recorded')
    return Number(call.slice('moveTo(0,'.length, -1)) // e.g. "moveTo(0,-45)" -> -45
  }

  const y75 = hullMoveToRawY(0.75)
  const y30 = hullMoveToRawY(0.3)
  assert(Math.abs(y75 - -45) < 1e-9, `glyphScale 0.75 records hull moveTo(0,-45) (got ${y75})`)
  assert(Math.abs(y30 - -18) < 1e-9, `glyphScale 0.3 records hull moveTo(0,-18) (got ${y30})`)
}

// VIS-6 helper: parses the mock's "arc(x,y,r,start,end)" strings into
// {x,y,r}, ignoring the trailing angle args (Math.PI*2's exact string
// form isn't worth hardcoding).
function parseArcCalls(calls: string[]): { x: number; y: number; r: number }[] {
  return calls
    .filter((c) => c.startsWith('arc('))
    .map((c) => {
      const [x, y, r] = c.slice('arc('.length, -1).split(',').map(Number)
      return { x, y, r }
    })
}

// Scenario: VIS-6 range rings, canvas 1920x1080, radiusNm 20 (27 px/nm).
// Zero vessels, so every arc() call recorded is a ring, in ring-nm order.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()

  const ctxOn = createMockCtx()
  // sweepPeriodSec off here too -- VIS-7's sweep wedge draws its own
  // clip-circle arc() at radius pxPerNm*radiusNm, which at this test's
  // 20nm radius equals the outermost range ring exactly (540) and would
  // otherwise appear as a spurious fifth arc.
  renderFrame(tracked, clientState, ctxOn, baseRenderContext({ config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: true, sweepPeriodSec: 0 } }))
  const arcsOn = parseArcCalls(ctxOn._calls)
  assert(
    JSON.stringify(arcsOn) === JSON.stringify([
      { x: 960, y: 540, r: 135 },
      { x: 960, y: 540, r: 270 },
      { x: 960, y: 540, r: 405 },
      { x: 960, y: 540, r: 540 },
    ]),
    `range-rings: 4 arcs at canvas centre with radii 135/270/405/540 (got ${JSON.stringify(arcsOn)})`,
  )

  const ctxOff = createMockCtx()
  renderFrame(tracked, clientState, ctxOff, baseRenderContext({ config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0 } }))
  assert(ctxOff._arcCount() === 0, `range-rings: rangeRingsEnabled=false draws no arcs (got ${ctxOff._arcCount()})`)
}

// Scenario: VIS-6 hero vs non-hero sizing, at DEFAULT_CONFIG's own
// heroScale (1.0, chosen at the ceiling look 17 Sep 2026) and glyphScale
// (0.75). Two cargo vessels (baseSize 120): 'HERO0000A' moving (sogKn 10,
// eligible, the only eligible candidate -- always the hero) and
// 'NONHERO0A' stopped (sogKn 0, ineligible, drawn at glyphScale instead).
// hh = actualSize * 0.5 inside drawCargo, canvasWidth 1920 so glyphs.ts's
// own scaling is identity: hero 120*1.0*0.5=60, non-hero 120*0.75*0.5=45.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  clientState.set('HERO0000A', { vesselType: 'cargo' })
  clientState.set('NONHERO0A', { vesselType: 'cargo' })
  onFixArrived(tracked, fix('HERO0000A', IN_VIEW_LAT, IN_VIEW_LON, 1000, 10))
  onFixArrived(tracked, fix('NONHERO0A', IN_VIEW_LAT, IN_VIEW_LON, 1000, 0))

  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, stoppedAsDot: false } }))

  assert(ctx._calls.includes('moveTo(0,-60)'), `hero-size: hero cargo (heroScale 1.0) records hull moveTo(0,-60) (calls: ${JSON.stringify(ctx._calls.filter((c) => c.startsWith('moveTo(0,-')))})`)
  assert(ctx._calls.includes('moveTo(0,-45)'), `hero-size: non-hero cargo (glyphScale 0.75) records hull moveTo(0,-45) (calls: ${JSON.stringify(ctx._calls.filter((c) => c.startsWith('moveTo(0,-')))})`)
}

// Scenario: VIS-6 glow -- 5 eligible vessels of 5 distinct types (so
// HERO_COUNT=4 selects exactly 4 of them, whichever 4 rank highest) means
// exactly 4 createRadialGradient calls with glowEnabled true, and 0 with
// it false.
{
  const glowTypes: VesselType[] = ['cargo', 'tanker', 'cruise', 'ferry', 'tugboat']

  function buildFiveEligible(): { tracked: TrackedVesselMap; clientState: Map<string, ClientVesselEntry> } {
    const tracked = createTrackedVesselMap()
    const clientState = new Map<string, ClientVesselEntry>()
    glowTypes.forEach((type, i) => {
      const mmsi = `GLOW00000${i}`
      clientState.set(mmsi, { vesselType: type })
      onFixArrived(tracked, fix(mmsi, IN_VIEW_LAT, IN_VIEW_LON, 1000, 10))
    })
    return { tracked, clientState }
  }

  const on = buildFiveEligible()
  const ctxOn = createMockCtx()
  renderFrame(on.tracked, on.clientState, ctxOn, baseRenderContext({ nowMs: 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, glowEnabled: true } }))
  assert(
    ctxOn._radialGradientCount() === 4,
    `glow: createRadialGradient called exactly 4 times (once per hero) with glowEnabled=true (got ${ctxOn._radialGradientCount()})`,
  )

  const off = buildFiveEligible()
  const ctxOff = createMockCtx()
  renderFrame(off.tracked, off.clientState, ctxOff, baseRenderContext({ nowMs: 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, glowEnabled: false } }))
  assert(
    ctxOff._radialGradientCount() === 0,
    `glow: createRadialGradient never called with glowEnabled=false (got ${ctxOff._radialGradientCount()})`,
  )
}

// Scenario: VIS-6 draw order -- every hero glyph fill comes after every
// non-hero glyph fill. Reuses the hero/non-hero cargo pair from the
// hero-size scenario; glowEnabled off isolates glyph fills from the
// glow gradient's own fill() call, which is not under test here.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  clientState.set('HEROB0000', { vesselType: 'cargo' })
  clientState.set('NONHEROB0', { vesselType: 'cargo' })
  onFixArrived(tracked, fix('HEROB0000', IN_VIEW_LAT, IN_VIEW_LON, 1000, 10))
  onFixArrived(tracked, fix('NONHEROB0', IN_VIEW_LAT, IN_VIEW_LON, 1000, 0))

  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({ nowMs: 1000, config: { ...DEFAULT_CONFIG, legendEnabled: false, glowEnabled: false, stoppedAsDot: false } }))

  function fillIndexAfter(calls: string[], marker: string): number {
    const markerIndex = calls.indexOf(marker)
    if (markerIndex < 0) throw new Error(`marker ${marker} not found`)
    return calls.indexOf('fill', markerIndex)
  }

  const nonHeroFillIndex = fillIndexAfter(ctx._calls, 'moveTo(0,-45)')
  const heroFillIndex = fillIndexAfter(ctx._calls, 'moveTo(0,-60)')
  assert(nonHeroFillIndex >= 0 && heroFillIndex >= 0, 'hero-draw-order: both glyph fills recorded')
  assert(
    nonHeroFillIndex < heroFillIndex,
    `hero-draw-order: the non-hero's glyph fill comes before the hero's (nonHero=${nonHeroFillIndex}, hero=${heroFillIndex})`,
  )
}

// Scenario: VIS-7 config defaults and cycle constants.
{
  assert(DEFAULT_CONFIG.labelSize === 'M', `DEFAULT_CONFIG.labelSize is 'M' (got ${DEFAULT_CONFIG.labelSize})`)
  assert(DEFAULT_CONFIG.areaTitleEnabled === true, 'DEFAULT_CONFIG.areaTitleEnabled is true')
  assert(DEFAULT_CONFIG.unknownScale === 0.6, `DEFAULT_CONFIG.unknownScale is 0.6 (chosen at the ceiling look, 17 September 2026) (got ${DEFAULT_CONFIG.unknownScale})`)
  assert(DEFAULT_CONFIG.sweepPeriodSec === 10, `DEFAULT_CONFIG.sweepPeriodSec is 10 (got ${DEFAULT_CONFIG.sweepPeriodSec})`)
  assert(
    JSON.stringify(LABEL_SIZES) === JSON.stringify(['off', 'S', 'M', 'L']),
    `LABEL_SIZES deep-equals ['off','S','M','L'] (got ${JSON.stringify(LABEL_SIZES)})`,
  )
  assert(
    JSON.stringify(UNKNOWN_SCALES) === JSON.stringify([1.0, 0.6, 0.4]),
    `UNKNOWN_SCALES deep-equals [1.0,0.6,0.4] (got ${JSON.stringify(UNKNOWN_SCALES)})`,
  )
  assert(
    JSON.stringify(SWEEP_PERIODS) === JSON.stringify([0, 6, 10, 16]),
    `SWEEP_PERIODS deep-equals [0,6,10,16] (got ${JSON.stringify(SWEEP_PERIODS)})`,
  )
}

// Scenario: VIS-7 unknown-type glyph size. glyphScale 0.75 (default) *
// unknownScale 0.6 * VESSEL_BASE_SIZES.unknown (80) = baseSize 36; at
// canvasWidth 1920 glyphs.ts's own scaling is identity, so the half-extent
// is size * 0.28 = 10.08 exactly.
//
// VIS-8 A7 made that 10.08 the silhouette's hw AND hh; A9 redistributed it
// at 1:2.67 (hw 6.17271415181361, hh 16.46057107150296) with the product,
// and therefore the bounding-box area, unchanged at 406.4256. Read from
// hullPath's own extreme points: moveTo(0, -hh) for the bow, the first
// lineTo(hw, ...) for the beam.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  onFixArrived(tracked, fix('UNKN00001', IN_VIEW_LAT, IN_VIEW_LON, 1000))
  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    nowMs: 1000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, sweepPeriodSec: 0, rangeRingsEnabled: false, unknownScale: 0.6 },
  }))
  assert(ctx._arcCount() === 0, `unknown-size: no circle drawn any more (got ${ctx._arcCount()} arcs)`)

  const bowY = Number(ctx._calls.find((c) => c.startsWith('moveTo(0,-'))!.slice('moveTo(0,'.length, -1))
  assert(
    Math.abs(bowY - -16.46057107150296) < 1e-9,
    `unknown-size: unknownScale 0.6 draws a silhouette of half-length 16.46057107150296 (got ${bowY})`,
  )

  // Half-width, from the first lineTo: hullPath's lineTo(hw, hh * 0.6).
  const beamX = Number(ctx._calls.find((c) => c.startsWith('lineTo('))!.slice('lineTo('.length, -1).split(',')[0])
  assert(
    Math.abs(beamX - 6.17271415181361) < 1e-9,
    `unknown-size: and half-width 6.17271415181361 (got ${beamX})`,
  )
  assert(
    Math.abs(4 * 6.17271415181361 * 16.46057107150296 - 406.4256) < 1e-9,
    'unknown-size: those two multiply back to the circle-era bounding-box area, 406.4256',
  )
}

// Scenario: VIS-7 hero labels -- fillText call counts. Four eligible
// vessels of four distinct types (all HERO_COUNT slots filled), area
// title off so its own 2 fillText calls don't contaminate the count.
{
  function buildFourEligible(): { tracked: TrackedVesselMap; clientState: Map<string, ClientVesselEntry> } {
    const tracked = createTrackedVesselMap()
    const clientState = new Map<string, ClientVesselEntry>()
    const types: VesselType[] = ['cargo', 'tanker', 'ferry', 'naval']
    types.forEach((type, i) => {
      const mmsi = `LBL00000${i}`
      clientState.set(mmsi, { vesselType: type, shipName: `SHIP ${i}` })
      onFixArrived(tracked, fix(mmsi, IN_VIEW_LAT, IN_VIEW_LON, 1000, 10))
    })
    return { tracked, clientState }
  }

  const m = buildFourEligible()
  const ctxM = createMockCtx()
  renderFrame(m.tracked, m.clientState, ctxM, baseRenderContext({
    nowMs: 1000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, sweepPeriodSec: 0, rangeRingsEnabled: false, areaTitleEnabled: false, labelSize: 'M' },
  }))
  // VIS-8: 16, not VIS-7's 8 -- each of the 4 heroes' 2 lines now draws
  // twice, its shadow then itself. The number of LINES is unchanged.
  assert(
    ctxM._fillTextCount() === 16,
    `labels: labelSize 'M' with 4 heroes calls fillText 16 times -- 2 lines each, shadow + real (got ${ctxM._fillTextCount()})`,
  )

  const off = buildFourEligible()
  const ctxOff = createMockCtx()
  renderFrame(off.tracked, off.clientState, ctxOff, baseRenderContext({
    nowMs: 1000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, sweepPeriodSec: 0, rangeRingsEnabled: false, areaTitleEnabled: false, labelSize: 'off' },
  }))
  assert(
    ctxOff._fillTextCount() === 0,
    `labels: labelSize 'off' calls fillText 0 times (got ${ctxOff._fillTextCount()})`,
  )
}

// Scenario: VIS-7 area title -- 2 fillText calls when enabled (title +
// "LIVE AIS"), 0 when disabled, with no heroes involved.
{
  const ctxOn = createMockCtx()
  renderFrame(createTrackedVesselMap(), new Map(), ctxOn, baseRenderContext({
    config: { ...DEFAULT_CONFIG, legendEnabled: false, sweepPeriodSec: 0, rangeRingsEnabled: false, areaTitleEnabled: true },
  }))
  assert(ctxOn._fillTextCount() === 2, `area-title: enabled draws 2 fillText calls (got ${ctxOn._fillTextCount()})`)

  const ctxOff = createMockCtx()
  renderFrame(createTrackedVesselMap(), new Map(), ctxOff, baseRenderContext({
    config: { ...DEFAULT_CONFIG, legendEnabled: false, sweepPeriodSec: 0, rangeRingsEnabled: false, areaTitleEnabled: false },
  }))
  assert(ctxOff._fillTextCount() === 0, `area-title: disabled draws 0 fillText calls (got ${ctxOff._fillTextCount()})`)
}

// Scenario: VIS-7 hero trails -- a hero always draws trailLength 'long'
// (120 points -> 119 segments) regardless of config.trailLength; a
// non-hero uses config.trailLength ('medium' -> 60 points -> 59
// segments). Track built directly on VesselState (bypassing applyFix's
// own 120-point cap) since the spec's fixture is a 150-point track,
// matching this file's existing NaN-scenario pattern for hand-built
// state. Points spread over ~0.15deg of latitude (~9nm), comfortably
// over drawTrail's 0.1nm total-distance floor for both the 120- and
// 60-point windows, and well inside the 20nm view radius.
function buildLongTrack(mmsi: string): { state: VesselState; nowMs: number } {
  const track: TrackPoint[] = []
  for (let i = 0; i < 150; i++) {
    track.push({ lat: 51.0 + i * 0.001, lon: 1.45, timestamp: i * 1000 })
  }
  const last = track[track.length - 1]
  const lastFix: VesselFix = { mmsi, lat: last.lat, lon: last.lon, cogDeg: 0, sogKn: 10, timestamp: last.timestamp }
  const state: VesselState = { mmsi, lastFix, displayLat: last.lat, displayLon: last.lon, track }
  return { state, nowMs: last.timestamp }
}

{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const { state, nowMs } = buildLongTrack('HEROTRAIL')
  tracked.set('HEROTRAIL', state)
  clientState.set('HEROTRAIL', { vesselType: 'cargo' }) // eligible (type != unknown, sogKn 10 >= 0.5) -> the only candidate -> hero

  const ctx = createMockCtx()
  // labelSize 'off' -- a hero's own label leader line is also a stroke()
  // call (labels.ts's drawHeroLabels), which would otherwise inflate
  // this trail-only stroke count by one.
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    nowMs,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, sweepPeriodSec: 0, rangeRingsEnabled: false, trailLength: 'short', labelSize: 'off' },
  }))
  assert(
    ctx._strokeCount() === 119,
    `hero-trail: a hero with a 150-point track draws 119 trail segments regardless of config.trailLength='short' (got ${ctx._strokeCount()})`,
  )
}

{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const { state, nowMs } = buildLongTrack('NONHEROTRL')
  tracked.set('NONHEROTRL', state)
  // No clientState entry -> vesselType defaults 'unknown' -> never hero-eligible.

  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    nowMs,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, sweepPeriodSec: 0, rangeRingsEnabled: false, trailLength: 'medium' },
  }))
  assert(
    ctx._trailStrokeCount() === 59,
    `non-hero-trail: a non-hero with the same track and trailLength 'medium' draws 59 trail segments (got ${ctx._trailStrokeCount()})`,
  )
}

// Scenario: VIS-7 radar sweep reveal. periodSec 360 makes
// sweepAngleDeg(nowMs, 360) === nowMs/1000 for nowMs < 360000 -- a
// convenient exact-degree clock for these fixtures. mirrorX:false,
// rotationDeg:0 (this file's own projConfig default): a vessel due east
// of centre (same lat, greater lon) has bearing exactly 90 degrees.
// Presence is read via ctx._fillCount() (drawUnknown's own ctx.fill()
// call for this unknown-type vessel), not _arcCount() -- the sweep
// wedge's own clip-circle draws an unrelated arc() every frame it's on
// (sweep.ts's drawSweep), which would otherwise contaminate an arc-count
// check regardless of vessel reveal state. drawSweep never calls
// ctx.fill() (only fillRect and stroke), so fillCount is clean.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  // Due east of centre (51.1, 1.45), ~3nm offset -- comfortably over the
  // 1px-from-centre special case, well inside the 20nm view radius.
  // Stationary (sogKn 0) so its projected position never drifts across
  // frames -- the fixture's exact bearing of 90deg is independent of
  // easing/timing.
  onFixArrived(tracked, fix('SWEEP0001', 51.1, 1.5, 0, 0))

  const ctx1 = createMockCtx()
  renderFrame(tracked, clientState, ctx1, baseRenderContext({
    nowMs: 80000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number] },
  }))
  assert(
    ctx1._fillCount() === 0,
    `sweep-reveal: vessel at bearing 90 not drawn while the beam is at 80 (got ${ctx1._fillCount()} fills)`,
  )

  const ctx2 = createMockCtx()
  renderFrame(tracked, clientState, ctx2, baseRenderContext({
    nowMs: 95000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number] },
  }))
  assert(
    ctx2._fillCount() === 1,
    `sweep-reveal: vessel at bearing 90 is drawn after the beam passes 90 (beam now 95) (got ${ctx2._fillCount()} fills)`,
  )

  // Once revealed, stays drawn even after the sweep is turned off then
  // back on with the beam nowhere near this vessel's bearing.
  const ctx3 = createMockCtx()
  renderFrame(tracked, clientState, ctx3, baseRenderContext({
    nowMs: 96000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0 },
  }))
  assert(ctx3._fillCount() === 1, `sweep-reveal: stays drawn with the sweep turned off (got ${ctx3._fillCount()} fills)`)

  const ctx4 = createMockCtx()
  renderFrame(tracked, clientState, ctx4, baseRenderContext({
    nowMs: 200000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number] },
  }))
  assert(
    ctx4._fillCount() === 1,
    `sweep-reveal: stays drawn once the sweep is turned back on, even with the beam far from bearing 90 (got ${ctx4._fillCount()} fills)`,
  )
}

// Scenario: VIS-7 radar sweep wrap. Beam moves from 350deg to 10deg
// (nowMs 350000 -> 370000 under periodSec 360); a vessel at bearing ~5deg
// (10nm north, 0.875nm east of centre) is revealed by the wrap.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  onFixArrived(tracked, fix('SWEEPWRAP', 51.1 + 10 / 60, 1.45 + 0.8749 / (60 * Math.cos((51.1 * Math.PI) / 180)), 0, 0))

  const ctx1 = createMockCtx()
  renderFrame(tracked, clientState, ctx1, baseRenderContext({
    nowMs: 350000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number] },
  }))
  assert(ctx1._fillCount() === 0, `sweep-wrap: not yet revealed at beam 350 (got ${ctx1._fillCount()} fills)`)

  const ctx2 = createMockCtx()
  renderFrame(tracked, clientState, ctx2, baseRenderContext({
    nowMs: 370000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number] },
  }))
  assert(
    ctx2._fillCount() === 1,
    `sweep-wrap: revealed once the beam wraps from 350 to 10, crossing bearing ~5 (got ${ctx2._fillCount()} fills)`,
  )
}

// Scenario: VIS-7 sweepPeriodSec 0 -> every vessel drawn on the very
// first frame, no crossing required. sweepPeriodSec is 0 here, so
// drawSweep is never called and fillCount is a clean signal (this
// scenario's single unknown vessel is the only thing that fills).
// VIS-8 A7: this read arcCount until the unknown glyph stopped being a
// circle. fillCount is what the other sweep scenarios in this file
// already use, and hullPath fills exactly once like dotPath did.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  onFixArrived(tracked, fix('SWEEPOFF1', 51.1, 1.5, 0, 0)) // ~3nm from centre

  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    nowMs: 1000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 0 },
  }))
  assert(ctx._fillCount() === 1, `sweep-off: sweepPeriodSec 0 draws on the first frame (got ${ctx._fillCount()} fills)`)
}

// Scenario: VIS-7 a pruned vessel that returns must be revealed again.
// Same due-east fixture as the reveal scenario above, in a fresh tracked
// map: reveal it, let it expire (pruned from tracked), then reintroduce
// it with a fresh fix -- it must not be drawn until the beam crosses it
// again, i.e. it does NOT inherit its old revealed status.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  onFixArrived(tracked, fix('SWEEPBACK', 51.1, 1.5, 0, 0))

  // Reveal it (same 80 -> 95 crossing as above).
  renderFrame(tracked, clientState, createMockCtx(), baseRenderContext({
    nowMs: 80000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number] },
  }))
  const ctxRevealed = createMockCtx()
  renderFrame(tracked, clientState, ctxRevealed, baseRenderContext({
    nowMs: 95000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number] },
  }))
  assert(ctxRevealed._fillCount() === 1, 'sweep-reprune: revealed once before expiry')

  // Expire it (removeSec 900s past its fix timestamp of 0).
  const removeSec = DEFAULT_CONFIG.removeSec
  renderFrame(tracked, clientState, createMockCtx(), baseRenderContext({
    nowMs: removeSec * 1000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number] },
  }))
  assert(!tracked.has('SWEEPBACK'), 'sweep-reprune: vessel pruned after removeSec')

  // Reintroduce it with a fresh fix -- must start unrevealed again.
  onFixArrived(tracked, fix('SWEEPBACK', 51.1, 1.5, removeSec * 1000, 0))
  const ctxReturned = createMockCtx()
  renderFrame(tracked, clientState, ctxReturned, baseRenderContext({
    nowMs: removeSec * 1000 + 80000,
    config: { ...DEFAULT_CONFIG, legendEnabled: false, rangeRingsEnabled: false, sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number] },
  }))
  assert(
    ctxReturned._fillCount() === 0,
    `sweep-reprune: a returned vessel is unrevealed again, not drawn immediately (got ${ctxReturned._fillCount()} fills)`,
  )
}

// ===================== VIS-8: stopped vessels draw as a dot ==============
// "Stopped" is lastFix.sogKn < 0.5, NOT trails.ts's totalDistanceNm < 0.1.
// VIS-8's A1(c) audit measured the latter against the recorded 31-minute
// Dover capture: it called 62 of 787 fixes at sogKn >= 3.0 "stopped", 57 of
// them purely because it was that vessel's first fix and no track had
// accumulated yet. See Correction 25.

// Helper: one typed vessel at the view centre at a given speed, one frame,
// everything unrelated turned off. Range rings and the area title draw
// their own arcs and fills; the sweep would withhold the vessel entirely.
function drawOneTypedVessel(
  vesselType: VesselType,
  sogKn: number,
  configOverrides?: Partial<DisplayConfig>,
) {
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const mmsi = 'DOT000001'
  clientState.set(mmsi, { vesselType })
  onFixArrived(tracked, fix(mmsi, IN_VIEW_LAT, IN_VIEW_LON, 1000, sogKn))

  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    nowMs: 1000,
    config: {
      ...DEFAULT_CONFIG,
      rangeRingsEnabled: false,
      sweepPeriodSec: 0,
      areaTitleEnabled: false,
      legendEnabled: false,
      // heroesEnabled off so the hull cases below are drawn by the
      // non-hero path at glyphScale -- the path the dot rule lives in.
      // Hero/dot exclusivity is proved structurally in its own scenario.
      heroesEnabled: false,
      ...configOverrides,
    },
  }))
  return ctx
}

// Third argument of the recorded arc(x,y,r,start,end) call, or null.
function arcRadius(calls: string[]): number | null {
  const call = calls.find((c) => c.startsWith('arc('))
  if (call === undefined) return null
  return Number(call.slice('arc('.length, -1).split(',')[2])
}

// Scenario: a stopped typed vessel draws a dot, at the confirmed radius,
// in its own type colour -- not a rotated hull.
{
  const ctx = drawOneTypedVessel('cargo', 0.3)

  // Hardcoded from VIS-8's A1(b) audit: radius = VESSEL_BASE_SIZES.cargo
  // (120) * glyphScale (0.75) * canvasWidth/1920 (1) * 0.28 = 25.2 px.
  // Tolerance covers binary float representation only.
  const r = arcRadius(ctx._calls)
  assert(r !== null && Math.abs(r - 25.2) < 1e-9, `dot: stopped cargo draws an arc of radius 25.2 (got ${r})`)
  assert(ctx._bezierCount() === 0, `dot: stopped cargo draws no hull bezier (got ${ctx._bezierCount()})`)
  assert(
    ctx._calls.every((c) => !c.startsWith('rotate(')),
    `dot: stopped cargo is never rotated (calls: ${JSON.stringify(ctx._calls.filter((c) => c.startsWith('rotate(')))})`,
  )
  assert(
    JSON.stringify(ctx._fills()) === JSON.stringify([{ fillStyle: '#0AA0FF', globalAlpha: 1 }]),
    `dot: exactly one fill, in cargo's own P2 colour #0AA0FF at alpha 1 (got ${JSON.stringify(ctx._fills())})`,
  )
}

// Scenario: the boundary is exclusive on the stopped side -- < 0.5 is
// stopped, >= 0.5 is not. 0.5 itself draws a hull.
{
  const ctx = drawOneTypedVessel('cargo', 0.5)
  assert(ctx._bezierCount() > 0, `dot-boundary: cargo at exactly 0.5kn draws its hull (bezier count ${ctx._bezierCount()})`)
  assert(ctx._arcCount() === 0, `dot-boundary: cargo at exactly 0.5kn draws no dot arc (got ${ctx._arcCount()})`)

  const below = drawOneTypedVessel('cargo', 0.49999)
  assert(below._arcCount() === 1, `dot-boundary: cargo just below 0.5kn draws a dot (got ${below._arcCount()} arcs)`)
  assert(below._bezierCount() === 0, 'dot-boundary: cargo just below 0.5kn draws no hull')
}

// Scenario: a sentinel-zeroed vessel (S3.3 zeroes BOTH sogKn and cogDeg
// together when either is sentinel) arrives at sogKn 0, so it draws a dot
// with no sentinel-specific logic anywhere in the render path.
{
  const ctx = drawOneTypedVessel('tanker', 0)
  const r = arcRadius(ctx._calls)
  // 110 * 0.75 * 0.28 = 23.1
  assert(r !== null && Math.abs(r - 23.1) < 1e-9, `dot-sentinel: sentinel-zeroed tanker draws a dot of radius 23.1 (got ${r})`)
  assert(
    JSON.stringify(ctx._fills()) === JSON.stringify([{ fillStyle: '#FF7A1A', globalAlpha: 1 }]),
    `dot-sentinel: drawn in tanker's own colour #FF7A1A (got ${JSON.stringify(ctx._fills())})`,
  )
}

// Scenario: an unknown-type stopped vessel is untouched -- its recorded
// draw calls are identical with the dot rule on and off, so it keeps its
// unknownScale term rather than being re-routed through drawDot.
{
  const on = drawOneTypedVessel('unknown', 0, { stoppedAsDot: true })
  const off = drawOneTypedVessel('unknown', 0, { stoppedAsDot: false })
  assert(
    JSON.stringify(on._calls) === JSON.stringify(off._calls),
    `dot-unknown: unknown-type stopped vessel's draw calls unchanged by stoppedAsDot (on=${JSON.stringify(on._calls)}, off=${JSON.stringify(off._calls)})`,
  )
  // 80 * 0.75 * 0.6 (unknownScale) * 0.28 = 10.08. A7 made this a
  // silhouette rather than a circle; A9 redistributed it at 1:2.67, so the
  // half-length is 10.08 / sqrt(0.375) = 16.46057107150296. unknownScale
  // still reaches it -- that is what this scenario is checking.
  const bowY = Number(on._calls.find((c) => c.startsWith('moveTo(0,-'))!.slice('moveTo(0,'.length, -1))
  assert(
    Math.abs(bowY - -16.46057107150296) < 1e-9,
    `dot-unknown: still the unknownScale-sized unknown glyph, half-length 16.46057107150296 (got ${bowY})`,
  )
  assert(on._arcCount() === 0, `dot-unknown: and it is A7's silhouette, not A2's circle (got ${on._arcCount()} arcs)`)
}

// Scenario: stoppedAsDot false restores the rotated hull at any speed
// below the threshold.
{
  for (const sogKn of [0, 0.3, 0.49999]) {
    const ctx = drawOneTypedVessel('ferry', sogKn, { stoppedAsDot: false })
    assert(ctx._bezierCount() > 0, `dot-off: ferry at ${sogKn}kn draws its hull with stoppedAsDot false (bezier ${ctx._bezierCount()})`)
    assert(ctx._arcCount() === 0, `dot-off: ferry at ${sogKn}kn draws no dot with stoppedAsDot false (arcs ${ctx._arcCount()})`)
  }
}

// Scenario: a hero is never drawn as a dot -- STRUCTURAL, not sampled.
// heroes.ts's isEligible requires sogKn >= HERO_MIN_SOG_KN and
// isStoppedForGlyph requires sogKn < STOPPED_MAX_SOG_KN. These assert the
// two constants are the SAME value (so the boundary cannot drift apart in
// a later edit), and that the two predicates partition the speed axis with
// no value satisfying both and none satisfying neither.
{
  assert(
    STOPPED_MAX_SOG_KN === HERO_MIN_SOG_KN,
    `dot-hero: STOPPED_MAX_SOG_KN is HERO_MIN_SOG_KN itself (${STOPPED_MAX_SOG_KN} vs ${HERO_MIN_SOG_KN})`,
  )
  assert(HERO_MIN_SOG_KN === 0.5, `dot-hero: that shared boundary is VIS-3's signed-off 0.5kn (got ${HERO_MIN_SOG_KN})`)

  // Independently restated eligibility predicate -- deliberately NOT
  // imported from heroes.ts, so a change to isEligible's comparison
  // operator shows up here rather than agreeing with itself.
  const heroSpeedEligible = (sogKn: number) => sogKn >= HERO_MIN_SOG_KN

  const probes = [0, 0.1, 0.25, 0.49, 0.49999, 0.5, 0.500001, 0.75, 1, 3, 12.5, 24.9, 102.3]
  const bothHold = probes.filter((v) => heroSpeedEligible(v) && isStoppedForGlyph(v))
  const neitherHolds = probes.filter((v) => !heroSpeedEligible(v) && !isStoppedForGlyph(v))
  assert(bothHold.length === 0, `dot-hero: no speed is both hero-eligible and stopped (offenders: ${JSON.stringify(bothHold)})`)
  assert(neitherHolds.length === 0, `dot-hero: every speed is one or the other (offenders: ${JSON.stringify(neitherHolds)})`)

  // And the dot's radius ratio is glyphs.ts's own exported constant, the
  // same one drawUnknown uses -- one formula, not two.
  assert(GLYPH_DOT_RADIUS_RATIO === 0.28, `dot: GLYPH_DOT_RADIUS_RATIO is 0.28 (got ${GLYPH_DOT_RADIUS_RATIO})`)
}

// Scenario: the shipped default.
{
  assert(DEFAULT_CONFIG.stoppedAsDot === true, `DEFAULT_CONFIG.stoppedAsDot is true (got ${DEFAULT_CONFIG.stoppedAsDot})`)
}

// ===================== VIS-8: legend and live vessel count ==============
// Both the header count and the legend count REVEALED vessels only -- the
// ones this frame actually drew -- grouped by type, dots included.
//
// Fixture, used by every scenario below: periodSec 360 makes
// sweepAngleDeg(nowMs, 360) === nowMs/1000, an exact-degree clock (the
// VIS-7 sweep scenarios above established this). With this file's
// projConfig (mirrorX false, rotationDeg 0), a vessel at the view centre's
// own latitude and a greater longitude sits at bearing exactly 90; a
// lesser longitude puts it at exactly 270. So a first frame at 80s then a
// second at 95s reveals everything east and nothing west, and a third at
// 275s then reveals the west vessel too.
//
// 2 cargo + 1 tanker + 1 unknown east (revealed), 1 ferry west (not yet).
// The tanker is stopped, so it is a dot under A2 and must still count.
function buildLegendFixture(order: 'natural' | 'reversed' = 'natural') {
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()

  const defs: { mmsi: string; type: VesselType | null; lon: number; sogKn: number }[] = [
    { mmsi: 'LEGCARGO1', type: 'cargo', lon: 1.50, sogKn: 5 },
    { mmsi: 'LEGCARGO2', type: 'cargo', lon: 1.52, sogKn: 5 },
    { mmsi: 'LEGTANKR1', type: 'tanker', lon: 1.54, sogKn: 0 },
    { mmsi: 'LEGUNKNW1', type: null, lon: 1.56, sogKn: 0 },
    { mmsi: 'LEGFERRY1', type: 'ferry', lon: 1.40, sogKn: 0 },
  ]
  const ordered = order === 'reversed' ? [...defs].reverse() : defs

  for (const d of ordered) {
    if (d.type !== null) clientState.set(d.mmsi, { vesselType: d.type })
    // cogDeg 90 (due east) keeps a moving vessel on its own bearing line
    // from the centre, so the fixture's exact bearings hold across frames.
    onFixArrived(tracked, fix(d.mmsi, IN_VIEW_LAT, d.lon, 0, d.sogKn, 90))
  }
  return { tracked, clientState }
}

function legendRenderContext(nowMs: number, configOverrides?: Partial<DisplayConfig>): RenderContext {
  return baseRenderContext({
    nowMs,
    config: {
      ...DEFAULT_CONFIG,
      rangeRingsEnabled: false,
      // heroesEnabled off: a hero would add its own label fillText calls,
      // which are not what these scenarios are reading.
      heroesEnabled: false,
      sweepPeriodSec: 360 as (typeof SWEEP_PERIODS)[number],
      ...configOverrides,
    },
  })
}

// Runs the two framing frames (80s then 95s) and returns the second's ctx.
function runLegendFrames(
  fixture: { tracked: TrackedVesselMap; clientState: Map<string, ClientVesselEntry> },
  configOverrides?: Partial<DisplayConfig>,
) {
  renderFrame(fixture.tracked, fixture.clientState, createMockCtx(), legendRenderContext(80000, configOverrides))
  const ctx = createMockCtx()
  renderFrame(fixture.tracked, fixture.clientState, ctx, legendRenderContext(95000, configOverrides))
  return ctx
}

// Legend rows are the fillTexts that are not the area title's own two.
function legendTexts(ctx: ReturnType<typeof createMockCtx>): string[] {
  return ctx
    ._fillTexts()
    .filter((t) => !t.text.startsWith('LIVE AIS') && t.text !== 'DOVER STRAIT')
    .map((t) => t.text)
}

// Scenario: the header counts the four revealed vessels, not the five
// tracked ones.
{
  const ctx = runLegendFrames(buildLegendFixture())
  const header = ctx._fillTexts().find((t) => t.text.startsWith('LIVE AIS'))
  assert(header !== undefined, 'legend-header: a LIVE AIS run was drawn')
  assert(
    header!.text.includes('4 VESSELS'),
    `legend-header: header reads "4 VESSELS", excluding the unrevealed ferry (got ${JSON.stringify(header?.text)})`,
  )
  assert(
    header!.text === liveAisText(4),
    `legend-header: the count rides the existing LIVE AIS run (got ${JSON.stringify(header?.text)})`,
  )
  // Same size, colour and alpha as VIS-7 drew it.
  assert(
    header!.fillStyle === '#C8D8F0' && Math.abs(header!.globalAlpha - 0.5) < 1e-9,
    `legend-header: unchanged colour #C8D8F0 at alpha 0.5 (got ${header?.fillStyle} / ${header?.globalAlpha})`,
  )
  assert(
    header!.font === '300 16px Inter, sans-serif',
    `legend-header: unchanged 16px Inter Light at canvasWidth 1920 (got ${JSON.stringify(header?.font)})`,
  )
}

// Scenario: exactly three legend rows -- Cargo 2, Tanker 1, Other 1. No
// Ferry row, because that vessel is not revealed yet.
{
  const ctx = runLegendFrames(buildLegendFixture())
  assert(
    JSON.stringify(legendTexts(ctx)) === JSON.stringify(['Cargo 2', 'Tanker 1', 'Other 1']),
    `legend-rows: exactly Cargo 2 / Tanker 1 / Other 1, no Ferry row (got ${JSON.stringify(legendTexts(ctx))})`,
  )

  // Rows read top-to-bottom in LEGEND_ORDER: cargo highest on the canvas
  // (smallest y), "Other" pinned at the bottom margin.
  const ys = ctx._fillTexts().filter((t) => legendTexts(ctx).includes(t.text)).map((t) => t.y)
  assert(
    ys.length === 3 && ys[0] < ys[1] && ys[1] < ys[2],
    `legend-rows: rows stack upward, cargo highest (ys ${JSON.stringify(ys)})`,
  )
  // 24px * s row spacing at canvasWidth 1920 (s = 1), hardcoded.
  assert(
    Math.abs(ys[1] - ys[0] - 24) < 1e-9 && Math.abs(ys[2] - ys[1] - 24) < 1e-9,
    `legend-rows: 24px row spacing at s=1 (ys ${JSON.stringify(ys)})`,
  )
  // Bottom row baseline sits 48px * s above the bottom edge.
  assert(Math.abs(ys[2] - (1080 - 48)) < 1e-9, `legend-rows: bottom row baseline at canvasHeight-48 (got ${ys[2]})`)
}

// Scenario: swatch colours and alphas -- "Other" is dimmed, the typed rows
// are not.
{
  const ctx = runLegendFrames(buildLegendFixture())
  // The only ctx.fill() calls at alpha != 1 are the legend swatches: every
  // glyph fill is at alpha 1 (drawGlyph/drawDot both set it), rings are
  // off, the sweep never calls fill(), and heroes are off.
  const swatches = ctx._fills().filter((f) => f.globalAlpha !== 1)
  assert(
    JSON.stringify(swatches) === JSON.stringify([
      { fillStyle: '#0AA0FF', globalAlpha: 0.85 },
      { fillStyle: '#FF7A1A', globalAlpha: 0.85 },
      { fillStyle: '#C8D8F0', globalAlpha: 0.5 },
    ]),
    `legend-swatches: cargo/tanker at 0.85, Other dimmed to 0.5 (got ${JSON.stringify(swatches)})`,
  )
}

// Scenario: row order is fixed, not discovery order.
{
  const natural = legendTexts(runLegendFrames(buildLegendFixture('natural')))
  const reversed = legendTexts(runLegendFrames(buildLegendFixture('reversed')))
  assert(
    JSON.stringify(natural) === JSON.stringify(reversed),
    `legend-order: same row order whichever order the vessels arrived in (natural=${JSON.stringify(natural)}, reversed=${JSON.stringify(reversed)})`,
  )
}

// Scenario: legendEnabled false draws no rows; the header count is
// unaffected.
{
  const ctx = runLegendFrames(buildLegendFixture(), { legendEnabled: false })
  assert(
    legendTexts(ctx).length === 0,
    `legend-off: no legend rows drawn with legendEnabled false (got ${JSON.stringify(legendTexts(ctx))})`,
  )
  const header = ctx._fillTexts().find((t) => t.text.startsWith('LIVE AIS'))
  assert(
    header?.text.includes('4 VESSELS') === true,
    `legend-off: header still reads "4 VESSELS" (got ${JSON.stringify(header?.text)})`,
  )
}

// Scenario: revealing the ferry adds a Ferry row and moves the header to
// 5 VESSELS. Third frame at 275s -- the beam crosses the ferry's bearing
// of 270 between 95 and 275.
{
  const fixture = buildLegendFixture()
  runLegendFrames(fixture)
  const ctx = createMockCtx()
  renderFrame(fixture.tracked, fixture.clientState, ctx, legendRenderContext(275000))

  const header = ctx._fillTexts().find((t) => t.text.startsWith('LIVE AIS'))
  assert(
    header?.text.includes('5 VESSELS') === true,
    `legend-reveal: header reads "5 VESSELS" once the ferry is revealed (got ${JSON.stringify(header?.text)})`,
  )
  assert(
    JSON.stringify(legendTexts(ctx)) === JSON.stringify(['Cargo 2', 'Tanker 1', 'Ferry 1', 'Other 1']),
    `legend-reveal: a Ferry row appears, in LEGEND_ORDER position (got ${JSON.stringify(legendTexts(ctx))})`,
  )
}

// Scenario: buildLegendRows in isolation -- order, zero-skipping, labels.
{
  const rows = buildLegendRows({ unknown: 3, cargo: 1, tugboat: 0, naval: 2 })
  assert(
    JSON.stringify(rows.map((r) => `${r.label} ${r.count}`)) === JSON.stringify(['Cargo 1', 'Naval 2', 'Other 3']),
    `legend-rows-pure: LEGEND_ORDER order, zero counts skipped (got ${JSON.stringify(rows)})`,
  )
  assert(buildLegendRows({}).length === 0, 'legend-rows-pure: no counts -> no rows')
  assert(legendLabel('unknown') === 'Other', `legend-rows-pure: unknown is labelled "Other" (got ${legendLabel('unknown')})`)
  assert(legendLabel('tugboat') === 'Tug', `legend-rows-pure: tugboat reuses labels.ts's own "Tug" (got ${legendLabel('tugboat')})`)
  assert(
    JSON.stringify(LEGEND_ORDER) === JSON.stringify(['cargo', 'tanker', 'ferry', 'naval', 'tugboat', 'unknown']),
    `legend-rows-pure: LEGEND_ORDER is cargo/tanker/ferry/naval/tugboat/unknown (got ${JSON.stringify(LEGEND_ORDER)})`,
  )
}

// Scenario: the shipped default.
{
  assert(DEFAULT_CONFIG.legendEnabled === true, `DEFAULT_CONFIG.legendEnabled is true (got ${DEFAULT_CONFIG.legendEnabled})`)
}

// ===================== VIS-8: label shadow, glyphScale look-key =========

// Scenario: every hero label line draws its shadow first -- same text, at
// +1*s in x and y, in #0A0E14 at alpha 0.6 -- then the real line on top,
// unchanged. One hero, so exactly 2 lines and therefore 4 fillTexts.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  clientState.set('SHADOWHER', { vesselType: 'cargo', shipName: 'TAILWIND' })
  onFixArrived(tracked, fix('SHADOWHER', IN_VIEW_LAT, IN_VIEW_LON, 1000, 12, 90))

  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    nowMs: 1000,
    config: {
      ...DEFAULT_CONFIG,
      legendEnabled: false,
      areaTitleEnabled: false,
      rangeRingsEnabled: false,
      sweepPeriodSec: 0,
      labelSize: 'M',
    },
  }))

  const texts = ctx._fillTexts()
  assert(texts.length === 4, `label-shadow: one hero, two lines, four fillTexts -- shadow then real for each (got ${texts.length}: ${JSON.stringify(texts.map((t) => t.text))})`)

  // canvasWidth 1920 so s = 1 and the offset is exactly 1px.
  const pairs: [number, number, string, string, number][] = [
    [0, 1, 'TAILWIND', '#E8EEF8', 0.95],
    [2, 3, 'Cargo · 12.0 kn', '#0AA0FF', 1.0],
  ]
  for (const [shadowIndex, realIndex, expectedText, realColor, realAlpha] of pairs) {
    const shadow = texts[shadowIndex]
    const real = texts[realIndex]
    assert(
      shadow?.text === expectedText && real?.text === expectedText,
      `label-shadow: line ${realIndex / 2 + 1} is drawn twice with the same text "${expectedText}" (got ${JSON.stringify([shadow?.text, real?.text])})`,
    )
    assert(
      shadow?.fillStyle === '#0A0E14' && Math.abs((shadow?.globalAlpha ?? -1) - 0.6) < 1e-9,
      `label-shadow: shadow is #0A0E14 at alpha 0.6 (got ${shadow?.fillStyle} / ${shadow?.globalAlpha})`,
    )
    assert(
      Math.abs(shadow!.x - real!.x - 1) < 1e-9 && Math.abs(shadow!.y - real!.y - 1) < 1e-9,
      `label-shadow: shadow offset is exactly +1,+1 at s=1 (shadow ${shadow?.x},${shadow?.y} vs real ${real?.x},${real?.y})`,
    )
    assert(
      real?.fillStyle === realColor && Math.abs((real?.globalAlpha ?? -1) - realAlpha) < 1e-9,
      `label-shadow: the real line keeps VIS-7's own ${realColor} at alpha ${realAlpha} (got ${real?.fillStyle} / ${real?.globalAlpha})`,
    )
  }

  // The shadow is a fill, never a stroke: the only strokes this frame are
  // the trail and the label's leader line, unchanged by VIS-8.
  assert(
    texts.every((t) => t.font.includes('Inter')),
    `label-shadow: shadow and real line share the same Inter font (got ${JSON.stringify(texts.map((t) => t.font))})`,
  )
  assert(
    texts[0].font === texts[1].font && texts[2].font === texts[3].font,
    `label-shadow: each shadow uses its own line's font (got ${JSON.stringify(texts.map((t) => t.font))})`,
  )
}

// Scenario: labelSize 'off' still draws nothing at all -- the shadow must
// not sneak a draw past that gate.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  clientState.set('SHADOWOFF', { vesselType: 'cargo', shipName: 'TAILWIND' })
  onFixArrived(tracked, fix('SHADOWOFF', IN_VIEW_LAT, IN_VIEW_LON, 1000, 12, 90))

  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    nowMs: 1000,
    config: {
      ...DEFAULT_CONFIG,
      legendEnabled: false,
      areaTitleEnabled: false,
      rangeRingsEnabled: false,
      sweepPeriodSec: 0,
      labelSize: 'off',
    },
  }))
  assert(ctx._fillTextCount() === 0, `label-shadow-off: labelSize 'off' draws no text at all (got ${ctx._fillTextCount()})`)
}

// Scenario: tune key G cycles glyphScale through VIS-4's four values and
// back. nextGlyphScale is the function the key handler itself calls, so
// this exercises the real cycle rather than a restatement of it. Expected
// sequence hardcoded, not derived from GLYPH_SCALES.
{
  const seen: number[] = [DEFAULT_CONFIG.glyphScale]
  let current = DEFAULT_CONFIG.glyphScale
  for (let i = 0; i < 4; i++) {
    current = nextGlyphScale(current)
    seen.push(current)
  }
  assert(
    JSON.stringify(seen) === JSON.stringify([0.75, 0.55, 0.4, 0.3, 0.75]),
    `glyph-key: G cycles 0.75 -> 0.55 -> 0.4 -> 0.3 -> 0.75 (got ${JSON.stringify(seen)})`,
  )
  assert(
    seen.length - 1 === GLYPH_SCALES.length,
    `glyph-key: the cycle returns to its start after exactly GLYPH_SCALES.length steps (got ${seen.length - 1} vs ${GLYPH_SCALES.length})`,
  )
  assert(
    DEFAULT_CONFIG.glyphScale === 0.75,
    `glyph-key: the default is unchanged at 0.75 -- G is a look aid, not a new default (got ${DEFAULT_CONFIG.glyphScale})`,
  )
}

// ===================== VIS-8 A6: legend left-aligned as one block =======
// The legend first shipped anchoring every row to the right margin
// independently, which left a ragged left edge and put every swatch at a
// different x. drawLegend is called directly here rather than through
// renderFrame: the rows under test are a fixed input, and building a
// fixture of 3 cargo + 1 tanker + 25 unknown vessels to produce them
// would test the counting path over again instead of the layout.
{
  // Three deliberately different text widths. "Cargo 3" is 7 characters;
  // "Tanker 1" and "Other 25" are 8.
  const rows: LegendRow[] = [
    { type: 'cargo', label: 'Cargo', count: 3 },
    { type: 'tanker', label: 'Tanker', count: 1 },
    { type: 'unknown', label: 'Other', count: 25 },
  ]

  const ctx = createMockCtx()
  drawLegend(ctx, rows, 1920, 1080)

  const dotXs = ctx._calls
    .filter((c) => c.startsWith('arc('))
    .map((c) => Number(c.slice('arc('.length, -1).split(',')[0]))
  assert(dotXs.length === 3, `legend-align: one swatch per row (got ${dotXs.length})`)

  // Hardcoded from A6(a)'s computation at canvasWidth 1920 (s = 1):
  // widest row width 74.24; blockLeftX = 1872 - 74.24 - 8 - 10 = 1779.76;
  // dot centre = blockLeftX + dotRadius = 1784.76.
  assert(
    dotXs.every((x) => Math.abs(x - 1784.76) < 1e-9),
    `legend-align: all three swatches share one x, 1784.76 (got ${JSON.stringify(dotXs)})`,
  )
  assert(
    dotXs[0] === dotXs[1] && dotXs[1] === dotXs[2],
    `legend-align: the swatches read as a column, exactly equal x (got ${JSON.stringify(dotXs)})`,
  )

  const textXs = ctx._fillTexts().map((t) => t.x)
  assert(
    textXs.length === 3 && textXs.every((x) => Math.abs(x - 1797.76) < 1e-9),
    `legend-align: all three labels start at one left edge, 1797.76 (got ${JSON.stringify(textXs)})`,
  )

  // The block has not drifted from its corner: the WIDEST row's right
  // edge still lands on the right margin, exactly where the old per-row
  // right anchor put every row. rightX = 1920 - 48 = 1872.
  const widest = Math.max(...ctx._fillTexts().map((t) => estimateTextWidth(t.text, 16)))
  assert(Math.abs(widest - 74.24) < 1e-9, `legend-align: widest row estimates to 74.24px (got ${widest})`)
  assert(
    Math.abs(textXs[0] + widest - 1872) < 1e-9,
    `legend-align: widest row's right edge is still the 1872 right margin (got ${textXs[0] + widest})`,
  )

  // Left-anchored now, not right-anchored -- the canvas itself does the
  // alignment that matters.
  assert(
    ctx._calls.every((c) => c !== "textAlign=right"),
    'legend-align: no row is right-anchored any more',
  )
}

// Scenario: the block still scales with canvasWidth. At 960 every figure
// above halves.
{
  const rows: LegendRow[] = [
    { type: 'cargo', label: 'Cargo', count: 3 },
    { type: 'unknown', label: 'Other', count: 25 },
  ]
  const ctx = createMockCtx()
  drawLegend(ctx, rows, 960, 540)

  const dotXs = ctx._calls
    .filter((c) => c.startsWith('arc('))
    .map((c) => Number(c.slice('arc('.length, -1).split(',')[0]))
  // s = 0.5: rightX = 960 - 24 = 936; fontPx 8; widest "Other 25" = 8*8*0.58
  // = 37.12; blockLeftX = 936 - 37.12 - 4 - 5 = 889.88; dot = +2.5 = 892.38.
  assert(
    dotXs.every((x) => Math.abs(x - 892.38) < 1e-9),
    `legend-align-scale: swatches share one x, 892.38, at canvasWidth 960 (got ${JSON.stringify(dotXs)})`,
  )
}

// ============ VIS-8 A7: unknown silhouette, non-rotating ===============
// The unknown circle read as unfinished at the ceiling. It is now a flat
// silhouette through the same hullPath every typed glyph uses, at a fixed
// orientation and at every speed. VIS-2's ceiling read test ruled out a
// DIRECTIONAL shape for this type -- TrueHeading disagrees with COG by up
// to 151.6 degrees for unknown vessels against 15.3 for typed ones -- and
// A7 does not reopen that: nothing here reads a heading or a speed.

// One unknown-type vessel at a given speed and course, through the real
// render path.
function drawOneUnknownVessel(sogKn: number, cogDeg: number) {
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  // No clientState entry at all -> vesselType resolves to 'unknown'.
  onFixArrived(tracked, fix('UNKA70001', IN_VIEW_LAT, IN_VIEW_LON, 1000, sogKn, cogDeg))

  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    nowMs: 1000,
    config: {
      ...DEFAULT_CONFIG,
      legendEnabled: false,
      areaTitleEnabled: false,
      rangeRingsEnabled: false,
      sweepPeriodSec: 0,
    },
  }))
  return ctx
}

// Scenario: stopped and under way draw the identical shape. Both fixes sit
// at the view centre, so the recorded translate is identical too and the
// whole call sequence can be compared directly.
{
  const stopped = drawOneUnknownVessel(0, 0)
  const moving = drawOneUnknownVessel(15, 90)

  assert(
    JSON.stringify(stopped._calls) === JSON.stringify(moving._calls),
    `a7-speed: an unknown vessel at 0kn and at 15kn draw an identical call sequence (stopped=${JSON.stringify(stopped._calls)}, moving=${JSON.stringify(moving._calls)})`,
  )
  assert(
    stopped._calls.every((c) => !c.startsWith('rotate(')),
    `a7-speed: no rotate() call at either speed (got ${JSON.stringify(stopped._calls.filter((c) => c.startsWith('rotate(')))})`,
  )
}

// Scenario: no rotation term reaches the draw, whatever cogDeg says.
{
  const courses = [0, 45, 90, 137.5, 180, 270, 359.9]
  const shapes = courses.map((cog) => {
    const calls = drawOneUnknownVessel(12, cog)._calls
    // Drop the translate, which legitimately differs: a vessel dead-
    // reckoned along a different course is at a different place. The path
    // itself must be byte-identical.
    return JSON.stringify(calls.filter((c) => !c.startsWith('translate(')))
  })
  assert(
    shapes.every((shape) => shape === shapes[0]),
    `a7-rotation: identical path at every course in ${JSON.stringify(courses)} -- only position differs`,
  )
  assert(
    !shapes[0].includes('rotate('),
    'a7-rotation: no rotate() term in the path at any course',
  )
}

// ============ VIS-8 A9: the silhouette's proportions ===================
// A7 shipped this shape in a 1:1 box, measured at exactly 1.000 -- square,
// which no real hull is. A9 redistributes the same half-extent at the
// ferry's own drawn 1:2.67, the mid-range of the six typed glyphs.
//
// The bounding box is measured here by FLATTENING every recorded bezier,
// not by reading hw/hh back out of a moveTo: a control point inside the
// box is not on its own proof the curve stays inside, and the point of
// this scenario is the shape that is actually drawn.
{
  const calls = drawOneUnknownVessel(0, 0)._calls

  function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const u = 1 - t
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const see = (x: number, y: number) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  let cx = 0, cy = 0
  for (const call of calls) {
    const move = /^(?:moveTo|lineTo)\(([-0-9.e]+),([-0-9.e]+)\)$/.exec(call)
    if (move) {
      cx = Number(move[1]); cy = Number(move[2]); see(cx, cy)
      continue
    }
    const bez = /^bezierCurveTo\(([-0-9.,e]+)\)$/.exec(call)
    if (bez) {
      const [x1, y1, x2, y2, x3, y3] = bez[1].split(',').map(Number)
      for (let i = 0; i <= 500; i++) {
        const t = i / 500
        see(cubicAt(cx, x1, x2, x3, t), cubicAt(cy, y1, y2, y3, t))
      }
      cx = x3; cy = y3
    }
  }

  const width = maxX - minX
  const length = maxY - minY
  assert(Number.isFinite(width) && width > 0, 'a9-proportion: a path was recorded and flattened')

  // The prompt's own band.
  const ratio = width / length
  assert(
    ratio >= 0.30 && ratio <= 0.45,
    `a9-proportion: drawn beam is 30-45% of drawn length (got ${(ratio * 100).toFixed(2)}%)`,
  )
  // And the specific value chosen: the ferry's drawn 0.375 (1:2.67).
  assert(
    Math.abs(ratio - 0.375) < 1e-9,
    `a9-proportion: that ratio is the ferry's own drawn 0.375 (got ${ratio})`,
  )

  // A proportion change, not a size change: same bounding-box AREA as the
  // pre-A9 square shape at this same size input. baseSize 36, half-extent
  // 36 * 0.28 = 10.08, so the pre-A9 box was 20.16 x 20.16 = 406.4256.
  const area = width * length
  assert(
    Math.abs(area / 406.4256 - 1) < 0.01,
    `a9-proportion: bounding-box area within 1% of the pre-A9 406.4256 (got ${area})`,
  )
  // Hardcoded expected extents, from A9(a)'s measurement of the real path.
  assert(
    Math.abs(width - 12.34542830362722) < 1e-9 && Math.abs(length - 32.92114214300592) < 1e-9,
    `a9-proportion: 12.345px beam by 32.921px length (got ${width} x ${length})`,
  )

  // Still flat: one fill, no stroke, no internal path segments. hullPath
  // emits exactly one subpath -- one beginPath, one moveTo, one closePath.
  assert(calls.filter((c) => c === 'fill').length === 1, `a9-flat: exactly one fill (got ${calls.filter((c) => c === 'fill').length})`)
  // VIS-8 A11 added exactly one stroke -- the dark outline -- after the
  // fill. Still no internal linework, and still a single flat fill.
  assert(
    calls.filter((c) => c === 'stroke').length === 1,
    `a9-flat: exactly one stroke, A11's outline (got ${calls.filter((c) => c === 'stroke').length})`,
  )
  assert(
    calls.every((c) => !c.startsWith('fillRect(')),
    `a9-flat: no internal linework (got ${JSON.stringify(calls.filter((c) => c.startsWith('fillRect(')))})`,
  )
  assert(
    calls.indexOf('fill') < calls.indexOf('stroke'),
    `a9-flat: the outline strokes AFTER the fill (fill at ${calls.indexOf('fill')}, stroke at ${calls.indexOf('stroke')})`,
  )
  assert(
    calls.filter((c) => c === 'beginPath').length === 1 &&
      calls.filter((c) => c.startsWith('moveTo(')).length === 1 &&
      calls.filter((c) => c === 'closePath').length === 1,
    `a9-flat: a single closed subpath, no internal path segments (got ${JSON.stringify(calls)})`,
  )

  // A7's rule is untouched by A9.
  assert(
    calls.every((c) => !c.startsWith('rotate(')),
    `a9-flat: still no rotation term (got ${JSON.stringify(calls.filter((c) => c.startsWith('rotate(')))})`,
  )
}

// Scenario: A2's stopped TYPED vessel is a separate code path and is
// untouched by A7 -- still a plain circle in its own colour, not the new
// silhouette. The full call sequence is hardcoded, so any drift shows up
// here rather than being absorbed by a looser check.
{
  const ctx = drawOneTypedVessel('cargo', 0.3)
  assert(
    JSON.stringify(ctx._calls) === JSON.stringify([
      'save',
      'translate(960,540)',
      'beginPath',
      'arc(0,0,25.200000000000003,0,6.283185307179586)',
      'closePath',
      'fill',
      'stroke',
      'restore',
    ]),
    `a7-typed-dot: a stopped cargo still draws exactly A2's circle at radius 25.2, now with A11's outline (got ${JSON.stringify(ctx._calls)})`,
  )
  assert(
    JSON.stringify(ctx._fills()) === JSON.stringify([{ fillStyle: '#0AA0FF', globalAlpha: 1 }]),
    `a7-typed-dot: still in cargo's own colour at alpha 1 (got ${JSON.stringify(ctx._fills())})`,
  )
  assert(ctx._bezierCount() === 0, `a7-typed-dot: no hullPath bezier -- not the unknown silhouette (got ${ctx._bezierCount()})`)
}

// ============ VIS-8 A11: dark outline on dots and the silhouette =======
// At real density stopped vessels of different types land within a pixel
// or two of each other. A11(a) measured 31 such pairs in the recorded
// 31-minute Dover capture; because the non-hero loop draws by
// VESSEL_BASE_SIZES descending, the SMALLER type draws last and its opaque
// fill covers most of the larger one -- a ferry over a naval hides 81% of
// it and leaves a 2.10px ring. A dark edge separates the two fills. It does
// not fix the overlap, which VIS-4 established no glyph size can.

// Scenario: a stopped typed vessel's dot strokes the outline after its
// fill, in the shared dark colour, at 1 * s.
{
  const ctx = drawOneTypedVessel('cargo', 0.3)
  const strokes = ctx._strokes()
  assert(strokes.length === 1, `a11-dot: exactly one stroke on a stopped dot (got ${strokes.length})`)
  assert(
    strokes[0]?.strokeStyle === '#0A0E14',
    `a11-dot: stroked in the shared DARK_OUTLINE_COLOR #0A0E14 (got ${strokes[0]?.strokeStyle})`,
  )
  assert(
    Math.abs((strokes[0]?.lineWidth ?? -1) - 1) < 1e-9,
    `a11-dot: lineWidth 1 at canvasWidth 1920 (s = 1) (got ${strokes[0]?.lineWidth})`,
  )
  assert(
    ctx._calls.indexOf('fill') < ctx._calls.indexOf('stroke'),
    `a11-dot: the outline strokes AFTER the fill (calls: ${JSON.stringify(ctx._calls)})`,
  )
  // The fill itself is untouched: still the vessel's own colour, opaque.
  assert(
    JSON.stringify(ctx._fills()) === JSON.stringify([{ fillStyle: '#0AA0FF', globalAlpha: 1 }]),
    `a11-dot: the fill is unchanged -- cargo's own colour at alpha 1 (got ${JSON.stringify(ctx._fills())})`,
  )
}

// Scenario: the unknown silhouette gets the same treatment.
{
  const ctx = drawOneUnknownVessel(0, 0)
  const strokes = ctx._strokes()
  assert(strokes.length === 1, `a11-unknown: exactly one stroke on the silhouette (got ${strokes.length})`)
  assert(
    strokes[0]?.strokeStyle === '#0A0E14',
    `a11-unknown: same DARK_OUTLINE_COLOR #0A0E14 (got ${strokes[0]?.strokeStyle})`,
  )
  assert(
    Math.abs((strokes[0]?.lineWidth ?? -1) - 1) < 1e-9,
    `a11-unknown: lineWidth 1 at canvasWidth 1920 (got ${strokes[0]?.lineWidth})`,
  )
  assert(
    ctx._calls.indexOf('fill') < ctx._calls.indexOf('stroke'),
    `a11-unknown: strokes after the fill (calls: ${JSON.stringify(ctx._calls)})`,
  )
  // And it is still non-rotating -- A7's rule survives A11.
  assert(
    ctx._calls.every((c) => !c.startsWith('rotate(')),
    'a11-unknown: still no rotation term',
  )
}

// Scenario: a MOVING, typed vessel's hull is untouched -- no outline at
// all. This is the boundary the reverted "stroke outline on glyphs"
// correction is about; A11 must not reach typed hulls.
{
  const ctx = drawOneTypedVessel('cargo', 12)
  assert(ctx._bezierCount() > 0, `a11-hull: a moving cargo draws its hull (bezier ${ctx._bezierCount()})`)
  assert(
    ctx._strokes().length === 0,
    `a11-hull: a moving typed hull records no stroke whatsoever (got ${JSON.stringify(ctx._strokes())})`,
  )
  assert(
    ctx._calls.every((c) => c !== 'stroke'),
    `a11-hull: and no stroke call in its sequence (got ${JSON.stringify(ctx._calls.filter((c) => c === 'stroke'))})`,
  )
}

// Scenario: the outline scales with the canvas, like every other width in
// this codebase. At canvasWidth 960, s = 0.5.
{
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  clientState.set('A11SCALE1', { vesselType: 'tanker' })
  onFixArrived(tracked, fix('A11SCALE1', IN_VIEW_LAT, IN_VIEW_LON, 1000, 0))

  const ctx = createMockCtx()
  renderFrame(tracked, clientState, ctx, baseRenderContext({
    nowMs: 1000,
    canvasWidth: 960,
    canvasHeight: 540,
    config: {
      ...DEFAULT_CONFIG,
      legendEnabled: false,
      areaTitleEnabled: false,
      rangeRingsEnabled: false,
      sweepPeriodSec: 0,
      heroesEnabled: false,
    },
  }))
  const strokes = ctx._strokes()
  assert(
    strokes.length === 1 && Math.abs(strokes[0].lineWidth - 0.5) < 1e-9,
    `a11-scale: lineWidth 0.5 at canvasWidth 960 (got ${JSON.stringify(strokes)})`,
  )
}

// Scenario: stoppedAsDot false is unaffected -- that vessel draws its
// rotated hull, and a hull takes no outline.
{
  const ctx = drawOneTypedVessel('ferry', 0, { stoppedAsDot: false })
  assert(ctx._bezierCount() > 0, 'a11-off: stoppedAsDot false still draws the hull')
  assert(
    ctx._strokes().length === 0,
    `a11-off: and that hull takes no outline (got ${JSON.stringify(ctx._strokes())})`,
  )
}

// Scenario: legendEnabled false is unaffected -- the legend's own swatches
// are filled, never stroked, and A11 did not change that either way.
{
  const off = runLegendFrames(buildLegendFixture(), { legendEnabled: false })
  const on = runLegendFrames(buildLegendFixture(), { legendEnabled: true })
  const outlineStrokes = (c: ReturnType<typeof createMockCtx>) =>
    c._strokes().filter((v) => v.strokeStyle === '#0A0E14').length
  assert(
    outlineStrokes(on) === outlineStrokes(off),
    `a11-legend: turning the legend on adds no outline strokes (on ${outlineStrokes(on)}, off ${outlineStrokes(off)})`,
  )
  assert(
    outlineStrokes(on) >= 1,
    `a11-legend: and the vessels themselves still carry their outlines (got ${outlineStrokes(on)})`,
  )
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
