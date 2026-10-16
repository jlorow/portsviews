import { MAX_TRACK_POINTS, type TrackPoint, type VesselFix } from '@wake/shared'
import type { PositionMap } from './caches.ts'

/**
 * One recent-position buffer per vessel, keyed by mmsi. In memory only --
 * nothing here is written to disk, so a server restart starts every
 * track again (documented as such in the README).
 *
 * The type lives in shared/src/track.ts (TrackPoint) rather than being
 * redeclared here, because the display seeds its own VesselState.track
 * from the very points this file appends, and the two ends must never
 * disagree about a point's shape.
 */
export type TrackMap = Map<string, TrackPoint[]>

/**
 * How much silence ends a track. Deliberately the same window the
 * position map already evicts on (DEFAULT_CONFIG.removeSec, 900 s): a
 * vessel evicted for silence is exactly a vessel whose track should not
 * be joined across that silence either.
 */
export const TRACK_GAP_SEC = 900

export function createTrackMap(): TrackMap {
  return new Map()
}

/**
 * A fix is only usable if all three numbers it contributes are finite.
 * Latitude/longitude come from normalize()'s numeric guard on the wire and
 * timestamp from its own parse, but this buffer is also fed straight from
 * tests and from replay, so it validates rather than assumes.
 */
function isUsableFix(fix: VesselFix): boolean {
  return Number.isFinite(fix.lat) && Number.isFinite(fix.lon) && Number.isFinite(fix.timestamp)
}

function toPoint(fix: VesselFix): TrackPoint {
  return { lat: fix.lat, lon: fix.lon, timestamp: fix.timestamp }
}

/**
 * Appends one fix to a vessel's track, creating the track if this is the
 * vessel's first fix. Points are stored oldest first and capped at
 * maxPoints (oldest dropped first), matching the display's own
 * MAX_TRACK_POINTS cap so a seeded trail and a live one are the same
 * length.
 *
 * Ignored, not thrown, in three cases -- a corrupt fix must never take
 * the whole pipeline down, the same stance normalize() and
 * evictStalePositions already take:
 *   - a fix with a non-finite lat, lon or timestamp;
 *   - a fix whose timestamp is not later than the vessel's last point
 *     (a duplicate or out-of-order message -- the existing point already
 *     holds the newer truth);
 *   - nothing: a gap of more than gapSec since the last point starts a
 *     NEW track, so the trail never draws a straight line across a
 *     silence during which the vessel went somewhere unobserved. The
 *     comparison is strict, so a gap of exactly gapSec still joins.
 */
export function appendTrackPoint(
  trackMap: TrackMap,
  fix: VesselFix,
  maxPoints: number = MAX_TRACK_POINTS,
  gapSec: number = TRACK_GAP_SEC,
): void {
  if (!isUsableFix(fix)) return

  const points = trackMap.get(fix.mmsi)
  const last = points?.[points.length - 1]

  if (points === undefined || last === undefined) {
    trackMap.set(fix.mmsi, [toPoint(fix)])
    return
  }

  if (fix.timestamp <= last.timestamp) return

  if ((fix.timestamp - last.timestamp) / 1000 > gapSec) {
    trackMap.set(fix.mmsi, [toPoint(fix)])
    return
  }

  const next = [...points, toPoint(fix)]
  trackMap.set(fix.mmsi, next.length > maxPoints ? next.slice(next.length - maxPoints) : next)
}

/**
 * Drops the track of every vessel the position map no longer holds. Called
 * immediately after evictStalePositions, so a vessel that ages out of
 * silence takes its history with it -- otherwise the buffer would keep a
 * dead ship's last two hours forever, which is the one way an in-memory
 * map with no other eviction could grow without bound over weeks.
 */
export function pruneTracks(trackMap: TrackMap, positionMap: PositionMap): void {
  for (const mmsi of trackMap.keys()) {
    if (!positionMap.has(mmsi)) trackMap.delete(mmsi)
  }
}
