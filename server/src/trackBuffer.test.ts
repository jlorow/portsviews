import type { VesselFix } from '@wake/shared'
import { MAX_TRACK_POINTS } from '@wake/shared'
import { createPositionMap, upsertPosition } from './caches.ts'
import { appendTrackPoint, createTrackMap, pruneTracks, TRACK_GAP_SEC } from './trackBuffer.ts'

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

// No sockets, no clock, no server -- pure functions over a Map, the same
// style caches.ts and normalize.ts are already tested in. Every check
// passes an explicit timestamp rather than sleeping.
function fix(mmsi: string, lat: number, lon: number, timestamp: number): VesselFix {
  return { mmsi, lat, lon, cogDeg: 90, sogKn: 5, timestamp }
}

// Scenario 1: the cap. 130 fixes one second apart leave 120 points, the
// ten oldest dropped, still ordered oldest first.
{
  const trackMap = createTrackMap()
  const base = 1_700_000_000_000
  for (let i = 0; i < 130; i++) {
    appendTrackPoint(trackMap, fix('100000001', 51 + i * 0.001, 1.45, base + i * 1000))
  }
  const track = trackMap.get('100000001') ?? []

  assert(
    track.length === MAX_TRACK_POINTS,
    `cap: 130 fixes leave exactly MAX_TRACK_POINTS (${MAX_TRACK_POINTS}) points (got ${track.length})`,
  )
  assert(
    track[0]?.timestamp === base + 10_000 && track[track.length - 1]?.timestamp === base + 129_000,
    `cap: the ten oldest points are the ones dropped (first=${track[0]?.timestamp}, last=${track[track.length - 1]?.timestamp}, expected ${base + 10_000}..${base + 129_000})`,
  )
  const ascending = track.every((p, i) => i === 0 || p.timestamp > track[i - 1].timestamp)
  assert(ascending, 'cap: points stay ordered oldest first (strictly ascending timestamps)')
}

// Scenario 2: the gap rule. Exactly 900 s of silence joins the track;
// 901 s starts a new one and drops everything before it.
{
  const trackMap = createTrackMap()
  const base = 1_700_000_000_000
  appendTrackPoint(trackMap, fix('100000002', 51.0, 1.45, base))
  appendTrackPoint(trackMap, fix('100000002', 51.01, 1.45, base + TRACK_GAP_SEC * 1000))

  assert(
    trackMap.get('100000002')?.length === 2,
    `gap: a gap of exactly TRACK_GAP_SEC (${TRACK_GAP_SEC}s) keeps the track (got ${trackMap.get('100000002')?.length})`,
  )

  // A second vessel, one second past the window: 901 s since its own last
  // point, which starts a new track and drops the one before it.
  appendTrackPoint(trackMap, fix('100000009', 51.0, 1.45, base))
  appendTrackPoint(trackMap, fix('100000009', 51.02, 1.45, base + TRACK_GAP_SEC * 1000 + 1000))

  const afterGap = trackMap.get('100000009') ?? []
  assert(
    afterGap.length === 1 && afterGap[0]?.timestamp === base + TRACK_GAP_SEC * 1000 + 1000,
    `gap: TRACK_GAP_SEC + 1s starts a new track with only the new fix (got ${JSON.stringify(afterGap)})`,
  )
}

// Scenario 3: a duplicate (same timestamp) or an older fix is ignored --
// the point already held is kept untouched.
{
  const trackMap = createTrackMap()
  const base = 1_700_000_000_000
  appendTrackPoint(trackMap, fix('100000003', 51.0, 1.45, base))
  appendTrackPoint(trackMap, fix('100000003', 51.5, 1.55, base))
  appendTrackPoint(trackMap, fix('100000003', 50.0, 1.05, base - 1000))

  const track = trackMap.get('100000003') ?? []
  assert(
    track.length === 1 && track[0]?.lat === 51.0 && track[0]?.lon === 1.45,
    `duplicate/older: the first point stands, neither a same-timestamp nor an older fix is appended (got ${JSON.stringify(track)})`,
  )
}

// Scenario 4: invalid values are ignored -- a fix with a non-finite lat,
// lon or timestamp never creates or extends a track.
{
  const trackMap = createTrackMap()
  const base = 1_700_000_000_000

  appendTrackPoint(trackMap, fix('100000004', Number.NaN, 1.45, base))
  appendTrackPoint(trackMap, fix('100000004', 51.0, Number.POSITIVE_INFINITY, base))
  appendTrackPoint(trackMap, fix('100000004', 51.0, 1.45, Number.NaN))
  assert(
    !trackMap.has('100000004'),
    'invalid: three unusable first fixes create no track at all',
  )

  appendTrackPoint(trackMap, fix('100000004', 51.0, 1.45, base))
  appendTrackPoint(trackMap, fix('100000004', Number.NaN, 1.46, base + 1000))
  appendTrackPoint(trackMap, fix('100000004', 51.01, 1.46, base + 2000))
  const track = trackMap.get('100000004') ?? []
  assert(
    track.length === 2 && track[1]?.lat === 51.01,
    `invalid: an unusable fix is skipped and the next good one still appends (got ${JSON.stringify(track)})`,
  )
}

// Scenario 5: pruning follows the position map. A vessel that has aged
// out of it loses its track; every vessel still in it keeps its own.
{
  const trackMap = createTrackMap()
  const positionMap = createPositionMap()
  const base = 1_700_000_000_000

  for (const mmsi of ['100000005', '100000006']) {
    appendTrackPoint(trackMap, fix(mmsi, 51.0, 1.45, base))
    appendTrackPoint(trackMap, fix(mmsi, 51.01, 1.45, base + 1000))
  }
  upsertPosition(positionMap, fix('100000005', 51.01, 1.45, base + 1000))

  pruneTracks(trackMap, positionMap)

  assert(!trackMap.has('100000006'), 'prune: the evicted vessel\'s track is gone')
  assert(
    trackMap.get('100000005')?.length === 2,
    'prune: the vessel still in the position map keeps its whole track',
  )
}

// Scenario 6: two vessels never share points. Interleaved fixes for two
// mmsis leave two independent, correctly ordered tracks.
{
  const trackMap = createTrackMap()
  const base = 1_700_000_000_000

  for (let i = 0; i < 5; i++) {
    appendTrackPoint(trackMap, fix('100000007', 51 + i * 0.01, 1.4, base + i * 1000))
    appendTrackPoint(trackMap, fix('100000008', 52 + i * 0.01, 2.4, base + i * 1000))
  }

  const a = trackMap.get('100000007') ?? []
  const b = trackMap.get('100000008') ?? []
  assert(
    a.length === 5 && b.length === 5,
    `independent: both vessels hold all five of their own fixes (got ${a.length} and ${b.length})`,
  )
  assert(
    a.every((p) => p.lon === 1.4) && b.every((p) => p.lon === 2.4),
    'independent: neither track contains a point belonging to the other vessel',
  )
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
