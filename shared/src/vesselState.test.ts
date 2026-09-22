import {
  shortestLonDelta,
  deadReckon,
  smoothingAlpha,
  vesselOpacity,
  isExpired,
  applyFix,
  updateVesselState,
  MAX_TRACK_POINTS,
  VesselFix,
  VesselState,
} from './vesselState.ts'
import { DEFAULT_CONFIG } from './config.ts'

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

function approxEqual(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol
}

function assertApprox(actual: number, expected: number, label: string, tol = 1e-6): void {
  assert(
    approxEqual(actual, expected, tol),
    `${label} (expected ~${expected}, got ${actual})`,
  )
}

function baseFix(overrides?: Partial<VesselFix>): VesselFix {
  return {
    mmsi: '123456789',
    lat: 51.0,
    lon: 1.0,
    cogDeg: 0,
    sogKn: 15,
    timestamp: 0,
    ...overrides,
  }
}

// Test 1: deadReckon due north, 10s elapsed
{
  const result = deadReckon(baseFix(), 10000, 30)
  assertApprox(result.lat, 51.000694444, 'deadReckon due north lat')
  assert(result.lon === 1.0, 'deadReckon due north lon exact')
}

// Test 2: deadReckon due east, 10s elapsed
{
  const result = deadReckon(baseFix({ cogDeg: 90 }), 10000, 30)
  assertApprox(result.lat, 51.0, 'deadReckon due east lat')
  assertApprox(result.lon, 1.001103482, 'deadReckon due east lon')
}

// Test 3: extrapolation cap holds
{
  const result = deadReckon(baseFix(), 60000, 30)
  assertApprox(result.lat, 51.002083333, 'deadReckon cap holds at 30s')
}

// Test 4: zero elapsed returns the fix position exactly
{
  const result = deadReckon(baseFix(), 0, 30)
  assert(result.lat === 51.0, 'zero elapsed lat exact')
  assert(result.lon === 1.0, 'zero elapsed lon exact')
}

// Test 5: negative elapsed clamps to zero
{
  const result = deadReckon(baseFix(), -5000, 30)
  assert(result.lat === 51.0, 'negative elapsed clamps lat exact')
  assert(result.lon === 1.0, 'negative elapsed clamps lon exact')
}

// Test 6: pole guard
{
  const result = deadReckon(baseFix({ lat: 89.95, cogDeg: 90 }), 10000, 30)
  assert(result.lon === 1.0, 'pole guard suppresses dLon exactly')
  assert(Number.isFinite(result.lon), 'pole guard result is finite')
}

// Test 7: smoothingAlpha at one 60fps frame
assertApprox(smoothingAlpha(0.18, 16.67), 0.18, 'smoothingAlpha one frame', 1e-3)

// Test 8: smoothingAlpha at two frames' worth
assertApprox(smoothingAlpha(0.18, 33.33), 0.3276, 'smoothingAlpha two frames', 1e-3)

// Test 9: smoothingAlpha clamps on a huge delta
{
  const alpha = smoothingAlpha(0.18, 600000)
  assert(alpha <= 1.0 && alpha > 0.99, 'smoothingAlpha clamps on huge delta')
}

// Test 10: vesselOpacity fresh
assert(vesselOpacity(baseFix(), 30000, 60, 600) === 1.0, 'vesselOpacity fresh exact 1.0')

// Test 11: vesselOpacity at the stale boundary
assert(vesselOpacity(baseFix(), 60000, 60, 600) === 1.0, 'vesselOpacity stale boundary exact 1.0')

// Test 12: vesselOpacity mid-ramp
assertApprox(vesselOpacity(baseFix(), 330000, 60, 600), 0.6, 'vesselOpacity mid-ramp')

// Test 13: vesselOpacity near removal
assertApprox(vesselOpacity(baseFix(), 599000, 60, 600), 0.201481481481, 'vesselOpacity near removal')

// Test 14: vesselOpacity at removal
assert(vesselOpacity(baseFix(), 600000, 60, 600) === 0, 'vesselOpacity at removal exact 0')

// Test 15: isExpired boundary
{
  assert(isExpired(baseFix(), 599000, 600) === false, 'isExpired boundary false at 599s')
  assert(isExpired(baseFix(), 600000, 600) === true, 'isExpired boundary true at 600s')
}

// Test 16: anchored vessel survives its reporting interval (regression test)
{
  const fix = baseFix()
  const nowMs = 180000
  assert(isExpired(fix, nowMs, 600) === false, 'anchored vessel not expired at 180s')
  assert(vesselOpacity(fix, nowMs, 60, 600) > 0.2, 'anchored vessel opacity above floor at 180s')
}

// Test 17: applyFix creates initial state
{
  const state = applyFix(undefined, baseFix())
  assert(state.displayLat === 51.0, 'applyFix initial displayLat exact')
  assert(state.displayLon === 1.0, 'applyFix initial displayLon exact')
  assert(state.track.length === 1, 'applyFix initial track length 1')
}

// Test 18: applyFix preserves display position, does not snap
{
  const initial = applyFix(undefined, baseFix())
  const nudged: VesselState = { ...initial, displayLat: 50.0 }
  const updated = applyFix(nudged, baseFix({ lat: 52.0, timestamp: 1000 }))
  assert(updated.displayLat === 50.0, 'applyFix preserves displayLat, does not snap')
  assert(updated.lastFix.lat === 52.0, 'applyFix updates lastFix.lat')
}

// Test 19: applyFix appends one track point per fix
{
  let state: VesselState | undefined = undefined
  for (let i = 0; i < 5; i++) {
    state = applyFix(state, baseFix({ timestamp: i * 1000 }))
  }
  assert(state!.track.length === 5, 'applyFix appends one point per fix (5 fixes)')
}

// Test 20: track caps at MAX_TRACK_POINTS
{
  let state: VesselState | undefined = undefined
  for (let i = 0; i < 130; i++) {
    state = applyFix(state, baseFix({ timestamp: i * 1000 }))
  }
  assert(state!.track.length === MAX_TRACK_POINTS, 'track caps at MAX_TRACK_POINTS after 130 fixes')
  assert(state!.track[0].timestamp === 10 * 1000, 'oldest 10 points dropped, track[0] is the 11th fix')
}

// Test 21: THE CRITICAL TRAP — updateVesselState never appends
{
  let state = applyFix(undefined, baseFix())
  assert(state.track.length === 1, 'critical trap setup: track length 1 before updates')
  const config = { smoothing: 0.18, maxExtrapolationSec: 30 }
  for (let i = 0; i < 1000; i++) {
    state = updateVesselState(state, 10000, 16.67, config)
  }
  assert(state.track.length === 1, 'updateVesselState never appends to track (1000 calls)')
}

// Test 22: updateVesselState eases toward target, does not jump
{
  const fix = baseFix({ lat: 51.0, cogDeg: 0, sogKn: 15, timestamp: 0 })
  const state: VesselState = {
    mmsi: fix.mmsi,
    lastFix: fix,
    displayLat: 51.0,
    displayLon: 1.0,
    track: [],
  }
  const config = { smoothing: 0.18, maxExtrapolationSec: 30 }
  const updated = updateVesselState(state, 10000, 16.67, config)
  assert(
    updated.displayLat > 51.0 && updated.displayLat < 51.000694444,
    'updateVesselState eases toward target without jumping',
  )
}

// Test 23: repeated updates converge toward target
{
  const fix = baseFix({ lat: 51.0, cogDeg: 0, sogKn: 15, timestamp: 0 })
  let state: VesselState = {
    mmsi: fix.mmsi,
    lastFix: fix,
    displayLat: 51.0,
    displayLon: 1.0,
    track: [],
  }
  const config = { smoothing: 0.18, maxExtrapolationSec: 30 }
  for (let i = 0; i < 100; i++) {
    state = updateVesselState(state, 10000, 16.67, config)
  }
  assertApprox(state.displayLat, 51.000694444, 'repeated updates converge to target', 1e-7)
}

// Test 24: antimeridian does not cause a world-crossing jump
{
  assertApprox(shortestLonDelta(179.9, -179.9), 0.2, 'antimeridian delta east-to-west wrap')
  assertApprox(shortestLonDelta(-179.9, 179.9), -0.2, 'antimeridian delta west-to-east wrap')
  assertApprox(shortestLonDelta(10, 20), 10, 'shortestLonDelta plain case')
}

// Test 25: immutability
{
  const fix = baseFix()
  const original: VesselState = {
    mmsi: fix.mmsi,
    lastFix: fix,
    displayLat: 51.0,
    displayLon: 1.0,
    track: [],
  }
  const originalDisplayLat = original.displayLat
  const config = { smoothing: 0.18, maxExtrapolationSec: 30 }
  updateVesselState(original, 10000, 16.67, config)
  assert(original.displayLat === originalDisplayLat, 'updateVesselState does not mutate the original state')
}

// --- Regression tests: thresholds sized from measured Dover Strait delivery ---
// A 10-minute live measurement of the Dover Strait box (S3.1) found what
// AISstream actually delivers, not what ITU-R M.1371 promises: 78 vessels,
// 67.2s median inter-arrival, per-sample maxima of 182-376s. The old
// staleSec=60 dimmed over half the fleet at any moment against that median.

// Test A: measured median is not treated as stale
assert(
  vesselOpacity(baseFix(), 67200, DEFAULT_CONFIG.staleSec, DEFAULT_CONFIG.removeSec) === 1.0,
  'measured median age (67.2s) is not stale under DEFAULT_CONFIG',
)

// Test B: measured maximum gap is still clearly visible
{
  const opacity = vesselOpacity(baseFix(), 376300, DEFAULT_CONFIG.staleSec, DEFAULT_CONFIG.removeSec)
  assertApprox(opacity, 0.834788, 'measured max gap (376.3s) opacity', 1e-5)
  assert(
    isExpired(baseFix(), 376300, DEFAULT_CONFIG.removeSec) === false,
    'measured max gap (376.3s) is not expired',
  )
}

// Test C: staleSec boundary is exact
assert(
  vesselOpacity(baseFix(), 240000, DEFAULT_CONFIG.staleSec, DEFAULT_CONFIG.removeSec) === 1.0,
  'staleSec boundary (240.0s) exact 1.0',
)

// Test D: mid-ramp with new thresholds
assert(
  vesselOpacity(baseFix(), 570000, DEFAULT_CONFIG.staleSec, DEFAULT_CONFIG.removeSec) === 0.6,
  'mid-ramp (570.0s) exact 0.6',
)

// Test E: removal boundary
{
  assert(
    vesselOpacity(baseFix(), 900000, DEFAULT_CONFIG.staleSec, DEFAULT_CONFIG.removeSec) === 0,
    'removeSec boundary (900.0s) exact 0',
  )
  assert(isExpired(baseFix(), 899900, DEFAULT_CONFIG.removeSec) === false, 'isExpired false at 899.9s')
  assert(isExpired(baseFix(), 900000, DEFAULT_CONFIG.removeSec) === true, 'isExpired true at 900.0s')
}

// Test F: extrapolation covers the median gap uncapped
{
  const result = deadReckon(baseFix(), 67200, DEFAULT_CONFIG.maxExtrapolationSec)
  assertApprox(result.lat, 51.004666667, 'median gap (67.2s) extrapolation uncapped', 1e-6)
}

// Test G: extrapolation caps at 120s
{
  const result = deadReckon(baseFix(), 376300, DEFAULT_CONFIG.maxExtrapolationSec)
  assertApprox(result.lat, 51.008333333, 'max gap (376.3s) extrapolation caps at 120s', 1e-6)
}

// Test H: worst-case drift stays acceptable
{
  const result = deadReckon(baseFix({ sogKn: 25 }), 376300, DEFAULT_CONFIG.maxExtrapolationSec)
  const driftNm = (result.lat - 51.0) * 60
  assert(driftNm < 1.0, `worst-case drift at 25kn capped at 120s stays under 1.0nm (got ${driftNm})`)
}

// Test I: anchored vessel is now fully bright, not merely alive
{
  const nowMs = 180000
  assert(
    vesselOpacity(baseFix(), nowMs, DEFAULT_CONFIG.staleSec, DEFAULT_CONFIG.removeSec) === 1.0,
    'moored reporting interval (180s) is fully bright under DEFAULT_CONFIG',
  )
  assert(isExpired(baseFix(), nowMs, DEFAULT_CONFIG.removeSec) === false, 'moored vessel not expired at 180s')
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
