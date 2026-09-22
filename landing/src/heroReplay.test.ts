/**
 * LANDING-HERO A1 tests — the replay driver, and the parity claim.
 *
 * The parity claim is the point of this file: that the hero's shipped
 * asset, replayed through the hero driver, puts the renderer in EXACTLY
 * the state the real display reaches when the same capture is fed through
 * the real server pipeline and the real socket handler. Not "looks the
 * same" -- the same recorded stream of CanvasRenderingContext2D calls,
 * compared string for string, which is the measurement CLAUDE.md's
 * evidence rules ask for in place of a guess.
 *
 * The reference path imports server/, which the SHIPPED bundle never
 * does: hero.ts's import graph is heroReplay.ts, apps/display's renderer
 * and @wake/shared, and heroBundle.test.ts proves the built artifact
 * carries no socket, fetch or key.
 *
 * Run: npx tsx landing/src/heroReplay.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, DEMO_AREAS, basemapAreaFor, type ProjectionConfig } from '@wake/shared'
import { parseCaptureLines, rewriteFixTimestamp } from '../../server/src/replayCore'
import { processEnvelope, type PipelineContext } from '../../server/src/pipeline'
import { createPositionMap, createStaticMap } from '../../server/src/caches'
import type { ClientSocket } from '../../server/src/broadcast'
import { handleIncomingData, type VesselStateMap } from '../../apps/display/src/wakeSocket'
import { createTrackedVesselMap, onFixArrived, renderFrame } from '../../apps/display/src/vesselTracker'
import { drawAttribution, drawPlaceNames } from '../../apps/display/src/canvas/placeNames'
import { HeroReplay, stampRecord, wallTimeForOffset, type HeroReplayData } from './heroReplay'

let passed = 0
let failed = 0
let skipped = 0

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
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const CAPTURE_PATH = path.join(REPO_ROOT, 'server', 'server', 'captures', 'dover-30min.ndjson')
const ASSET_PATH = path.join(__dirname, 'heroReplay.data.json')

// --- a recording 2D context ---------------------------------------------
// Records every call and every style assignment as a string, so two
// renders can be compared exactly. A Proxy rather than a hand-listed mock:
// renderFrame reaches glyphs, trails, glow, sweep, rings, labels and the
// legend, and a missing method would throw rather than quietly differ.

function createRecordingCtx(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = []
  const gradient = {
    addColorStop: (offset: number, color: string) => {
      calls.push(`gradient.addColorStop(${offset},${color})`)
    },
  }
  const target: Record<string, unknown> = {}
  const proxy = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === '_calls') return calls
      if (prop === 'canvas') return undefined
      return (...args: unknown[]) => {
        calls.push(
          `${prop}(${args.map((a) => (typeof a === 'object' && a !== null ? '[obj]' : String(a))).join(',')})`,
        )
        if (prop === 'createRadialGradient' || prop === 'createLinearGradient' || prop === 'createConicGradient') {
          return gradient
        }
        if (prop === 'measureText') return { width: 0 }
        return undefined
      }
    },
    set(_t, prop: string, value: unknown) {
      calls.push(`${prop}=${String(value)}`)
      return true
    },
  })
  return { ctx: proxy as unknown as CanvasRenderingContext2D, calls }
}

// --- shared render arguments --------------------------------------------

const AREA = DEMO_AREAS.dover
const BASEMAP_AREA = basemapAreaFor('dover')
const PROJ_CONFIG: ProjectionConfig = { mirrorX: DEFAULT_CONFIG.mirrorX, rotationDeg: DEFAULT_CONFIG.rotationDeg }
const CANVAS_W = 2104
const CANVAS_H = 976
const ORIGIN = 1_700_000_000_000

/**
 * One frame's worth of drawing, exactly as hero.ts issues it.
 *
 * Note for anyone reading the op counts below: a SINGLE frame draws no
 * vessel at all. VIS-7's radar sweep reveals a vessel the first time the
 * leading edge crosses its bearing, and beamCrossed returns false when
 * there is no previous frame angle -- so frame one legitimately shows
 * rings, sweep, title, legend and place names and nothing else. An
 * earlier version of this test compared one frame, passed parity, and
 * tripped its own "the reference frame really drew something" guard at 92
 * ops. Hence drawSequence: parity is compared over a full sweep period.
 */
function drawWhole(
  ctx: CanvasRenderingContext2D,
  tracked: ReturnType<typeof createTrackedVesselMap>,
  clientState: VesselStateMap,
  nowMs: number,
  deltaMs: number,
): void {
  if (BASEMAP_AREA !== undefined) {
    drawPlaceNames(
      ctx,
      BASEMAP_AREA.places,
      AREA.centerLat,
      AREA.centerLon,
      AREA.radiusNm,
      PROJ_CONFIG,
      CANVAS_W,
      CANVAS_H,
    )
  }
  renderFrame(tracked, clientState, ctx, {
    centerLat: AREA.centerLat,
    centerLon: AREA.centerLon,
    radiusNm: AREA.radiusNm,
    projConfig: PROJ_CONFIG,
    canvasWidth: CANVAS_W,
    canvasHeight: CANVAS_H,
    nowMs,
    deltaMs,
    config: DEFAULT_CONFIG,
    areaDisplayName: AREA.displayName,
  })
  if (BASEMAP_AREA !== undefined) drawAttribution(ctx, CANVAS_W, CANVAS_H)
}

/** 11 seconds at 100ms steps: one full sweepPeriodSec of 10, plus margin. */
const SEQUENCE_FRAMES = 110
const SEQUENCE_STEP_MS = 100

function drawSequence(
  ctx: CanvasRenderingContext2D,
  tracked: ReturnType<typeof createTrackedVesselMap>,
  clientState: VesselStateMap,
  startNowMs: number,
): void {
  for (let i = 0; i < SEQUENCE_FRAMES; i++) {
    drawWhole(ctx, tracked, clientState, startNowMs + i * SEQUENCE_STEP_MS, SEQUENCE_STEP_MS)
  }
}

// --- load the asset and the capture --------------------------------------

const data = JSON.parse(fs.readFileSync(ASSET_PATH, 'utf8')) as HeroReplayData
const PRIME_MS = data.primeMs

assert(fs.existsSync(ASSET_PATH), 'the shipped replay asset exists')
assert(data.records.length > 0, `asset carries records (${data.records.length})`)
assert(data.areaKey === 'dover', `asset area is dover (got ${data.areaKey})`)
assert(
  data.records.every((r) => {
    const m = r.m as { kind?: string; fix?: { timestamp?: number } }
    return m.kind !== 'position' || m.fix?.timestamp === 0
  }),
  'every position message ships with timestamp 0 -- no capture wall-clock on a public page',
)
assert(
  data.records.every((r, i) => i === 0 || r.t >= data.records[i - 1].t),
  'asset records are in non-decreasing capture-offset order',
)

// --- stampRecord / wallTimeForOffset ------------------------------------

assert(wallTimeForOffset(PRIME_MS, PRIME_MS, ORIGIN) === ORIGIN, 'wallTimeForOffset: the prime offset is the origin')
assert(
  wallTimeForOffset(PRIME_MS - 60_000, PRIME_MS, ORIGIN) === ORIGIN - 60_000,
  'wallTimeForOffset: an offset 60s before the prime point is 60s before the origin',
)
assert(
  wallTimeForOffset(PRIME_MS + 30_000, PRIME_MS, ORIGIN) === ORIGIN + 30_000,
  'wallTimeForOffset: an offset 30s after the prime point is 30s after the origin',
)

const samplePosition = data.records.find((r) => (r.m as { kind: string }).kind === 'position')
if (samplePosition === undefined) throw new Error('asset carries no position message')
const stamped = JSON.parse(stampRecord(samplePosition, 12345)) as { fix: { timestamp: number } }
assert(stamped.fix.timestamp === 12345, 'stampRecord writes the wall clock into a position fix')
assert(
  (samplePosition.m as { fix: { timestamp: number } }).fix.timestamp === 0,
  'stampRecord does not mutate the asset record it was given',
)
const sampleStatic = data.records.find((r) => (r.m as { kind: string }).kind === 'static')
if (sampleStatic === undefined) throw new Error('asset carries no static message')
assert(
  JSON.parse(stampRecord(sampleStatic, 999)).kind === 'static',
  'stampRecord passes a static message through unchanged',
)

function buildHeroState(throughOffsetMs: number) {
  const tracked = createTrackedVesselMap()
  const clientState: VesselStateMap = new Map()
  const replay = new HeroReplay({ data, tracked, clientState })
  replay.prime(ORIGIN)
  if (throughOffsetMs > PRIME_MS) {
    replay.advance(wallTimeForOffset(throughOffsetMs, PRIME_MS, ORIGIN))
  }
  return { tracked, clientState, replay }
}

// --- the reference path: capture -> real server pipeline -> real socket ---
//
// Skips gracefully when the gitignored capture file is absent, which is
// true of every fresh clone. The asset-only scenarios above and below run
// either way -- the same pattern server/src/broadcast.test.ts already uses.
if (!fs.existsSync(CAPTURE_PATH)) {
  console.log(
    `[SKIP] capture-vs-asset parity: ${CAPTURE_PATH} not present (gitignored) -- skipping file-dependent assertions`,
  )
  skipped++
} else {
  const captureContent = fs.readFileSync(CAPTURE_PATH, 'utf8')
  const capturedRecords = parseCaptureLines(captureContent.split('\n')).records
  const CAPTURE_START_MS = Math.min(...capturedRecords.map((r) => r.receivedAtMs))

  function buildReferenceState(throughOffsetMs: number) {
    const clientState: VesselStateMap = new Map()
    const tracked = createTrackedVesselMap()

    // The display side of the wire: whatever the server sends goes straight
    // into the same handler wakeSocket.ts's onmessage calls.
    const display: ClientSocket = {
      readyState: 1,
      bufferedAmount: 0,
      send(payload: string) {
        handleIncomingData(clientState, payload, (fix) => onFixArrived(tracked, fix))
      },
      close() {},
      once() {},
    }

    const ctx: PipelineContext = {
      positionMap: createPositionMap(),
      staticMap: createStaticMap(),
      clients: new Set<ClientSocket>([display]),
      removeSec: DEFAULT_CONFIG.removeSec,
    }

    let applied = 0
    for (const record of capturedRecords) {
      const offset = record.receivedAtMs - CAPTURE_START_MS
      if (offset > throughOffsetMs) break
      const nowMs = wallTimeForOffset(offset, PRIME_MS, ORIGIN)
      processEnvelope(record.envelope, ctx, nowMs, undefined, rewriteFixTimestamp)
      applied++
    }
    return { tracked, clientState, applied }
  }

  // Offsets sampled across the loop: the prime point itself, and four
  // points spread through the played window.
  const OFFSETS = [PRIME_MS, PRIME_MS + 120_000, PRIME_MS + 300_000, PRIME_MS + 600_000, data.captureSpanMs]

  for (const offset of OFFSETS) {
    const nowMs = wallTimeForOffset(offset, PRIME_MS, ORIGIN)
    const ref = buildReferenceState(offset)
    const hero = buildHeroState(offset)

    assert(
      ref.tracked.size === hero.tracked.size,
      `t=${offset}ms: tracked vessel count matches the real display path (ref ${ref.tracked.size}, hero ${hero.tracked.size})`,
    )
    assert(
      ref.clientState.size === hero.clientState.size,
      `t=${offset}ms: client vessel-entry count matches (ref ${ref.clientState.size}, hero ${hero.clientState.size})`,
    )
    assert(ref.tracked.size > 40, `t=${offset}ms: the scene is non-trivial (${ref.tracked.size} vessels tracked)`)

    // Positions, before any rendering: every mmsi and its eased lat/lon.
    const refPositions = [...ref.tracked.entries()]
      .map(([mmsi, s]) => `${mmsi}:${s.displayLat.toFixed(9)},${s.displayLon.toFixed(9)}:${s.track.length}`)
      .sort()
    const heroPositions = [...hero.tracked.entries()]
      .map(([mmsi, s]) => `${mmsi}:${s.displayLat.toFixed(9)},${s.displayLon.toFixed(9)}:${s.track.length}`)
      .sort()
    assert(
      refPositions.join('|') === heroPositions.join('|'),
      `t=${offset}ms: every vessel's mmsi, eased position and track length is identical (${refPositions.length} vessels)`,
    )

    // And the frames themselves: the full recorded draw-call stream over a
    // complete sweep period, so every vessel has been revealed and drawn.
    const refCtx = createRecordingCtx()
    const heroCtx = createRecordingCtx()
    drawSequence(refCtx.ctx, ref.tracked, ref.clientState, nowMs)
    drawSequence(heroCtx.ctx, hero.tracked, hero.clientState, nowMs)

    assert(
      refCtx.calls.length > 50_000,
      `t=${offset}ms: the reference sequence really drew the fleet (${refCtx.calls.length} ops over ${SEQUENCE_FRAMES} frames)`,
    )
    assert(
      refCtx.calls.length === heroCtx.calls.length && refCtx.calls.join('\n') === heroCtx.calls.join('\n'),
      `t=${offset}ms: the hero renders the IDENTICAL draw-call stream as the real display path (${refCtx.calls.length} ops over ${SEQUENCE_FRAMES} frames)`,
    )
  }
}

// --- the loop ------------------------------------------------------------

{
  const tracked = createTrackedVesselMap()
  const clientState: VesselStateMap = new Map()
  const replay = new HeroReplay({ data, tracked, clientState })
  replay.prime(ORIGIN)
  const primedSize = tracked.size

  // One millisecond past the end of the capture: the loop turns over.
  replay.advance(wallTimeForOffset(data.captureSpanMs + 1, PRIME_MS, ORIGIN))
  assert(replay.passCount === 1, `crossing the end of the capture completes one pass (got ${replay.passCount})`)
  assert(
    tracked.size === primedSize,
    `looping returns to the primed fleet size (${primedSize} before, ${tracked.size} after)`,
  )
  assert(tracked.size > 0, 'the looped state is populated, not empty')
}

{
  // prime() clears rather than merges.
  const tracked = createTrackedVesselMap()
  const clientState: VesselStateMap = new Map()
  const replay = new HeroReplay({ data, tracked, clientState })
  replay.prime(ORIGIN)
  const first = [...tracked.keys()].sort().join(',')
  replay.advance(wallTimeForOffset(PRIME_MS + 300_000, PRIME_MS, ORIGIN))
  replay.prime(ORIGIN)
  const second = [...tracked.keys()].sort().join(',')
  assert(first === second, 're-priming reproduces exactly the primed fleet, with nothing left over from the pass')
}

// --- staleness is real, not flattened ------------------------------------

{
  const hero = buildHeroState(PRIME_MS)
  const ages = [...hero.tracked.values()].map((s) => (ORIGIN - s.lastFix.timestamp) / 1000)
  const maxAge = Math.max(...ages)
  const minAge = Math.min(...ages)
  assert(
    maxAge > DEFAULT_CONFIG.staleSec,
    `primed vessels carry real ages, so some are genuinely stale (max age ${maxAge.toFixed(1)}s > staleSec ${DEFAULT_CONFIG.staleSec}s)`,
  )
  assert(
    maxAge < DEFAULT_CONFIG.removeSec,
    `nothing older than removeSec survives the prime (max age ${maxAge.toFixed(1)}s < ${DEFAULT_CONFIG.removeSec}s)`,
  )
  assert(minAge >= 0, `no vessel carries a future timestamp (min age ${minAge.toFixed(1)}s)`)
}

const total = passed + failed
if (failed === 0) {
  console.log(`
All ${total} tests passed${skipped > 0 ? ` (${skipped} file-dependent scenario skipped)` : ''}`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
