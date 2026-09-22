import type { VesselFix, VesselType } from '@wake/shared'

export interface StaticInfo {
  shipName?: string
  vesselType: VesselType
  dimensions?: { lengthM: number; beamM: number }
}

export type PositionMap = Map<string, VesselFix>
export type StaticMap = Map<string, StaticInfo>

// Default cap on the static map. Retained indefinitely otherwise -- a
// static record obtained once for a permanent non-responder (see
// CLAUDE.md's heterogeneity finding) is the only type data that vessel
// will ever produce, so it must not share the position map's removeSec
// eviction. The cap exists only to guarantee a hard memory ceiling for a
// display meant to run for weeks, not because 5,000 distinct vessels is
// expected to be reached in normal operation.
export const STATIC_MAP_CAP = 5000
export const STATIC_MAP_ENTRY_BYTES = 189

export function createPositionMap(): PositionMap {
  return new Map()
}

export function createStaticMap(): StaticMap {
  return new Map()
}

export function upsertPosition(map: PositionMap, fix: VesselFix): void {
  map.set(fix.mmsi, fix)
}

/**
 * The first eviction in this project -- removeSec previously had no
 * caller outside vesselOpacity/isExpired (both pure predicates, never
 * wired to an actual delete). Takes nowMs explicitly rather than reading
 * a clock internally, so replay can drive it deterministically.
 */
export function evictStalePositions(map: PositionMap, nowMs: number, removeSec: number): void {
  for (const [mmsi, fix] of map) {
    if ((nowMs - fix.timestamp) / 1000 >= removeSec) {
      map.delete(mmsi)
    }
  }
}

// Map preserves insertion order; deleting and re-setting a key moves it
// to the most-recently-used end. The least-recently-used entry is
// therefore always the first key in iteration order.
function touch(map: StaticMap, mmsi: string): void {
  const value = map.get(mmsi)
  if (value === undefined) return
  map.delete(mmsi)
  map.set(mmsi, value)
}

export function upsertStatic(
  map: StaticMap,
  mmsi: string,
  info: StaticInfo,
  cap: number = STATIC_MAP_CAP,
): void {
  map.delete(mmsi)
  map.set(mmsi, info)

  while (map.size > cap) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) break
    map.delete(oldestKey)
  }
}

/**
 * Marks a vessel as recently active without changing its static record.
 * Called on every position fix for a vessel that already has a static
 * entry, so an actively-transmitting vessel's hard-won static data isn't
 * the one evicted under the cap just because it hasn't sent a NEW static
 * message recently -- only genuinely inactive vessels should age out.
 */
export function touchStaticOnActivity(map: StaticMap, mmsi: string): void {
  touch(map, mmsi)
}

export function getStatic(map: StaticMap, mmsi: string): StaticInfo | undefined {
  return map.get(mmsi)
}

/**
 * VIS-7 audit finding: MetaData.ShipName is present on ~100% of
 * PositionReport messages (CLAUDE.md), but pipeline.ts previously
 * discarded normalize()'s position-branch shipName entirely -- only a
 * name from an actual ShipStaticData message ever reached staticMap, so
 * every one of the ~24 Class A vessels that never send static data
 * rendered with no name at all despite one being available on every fix.
 * Fills in a name for a vessel with none on record without touching an
 * existing shipName (static data's Name field is treated as
 * authoritative once present) or an existing vesselType/dimensions.
 * Reuses upsertStatic's own LRU insert, so this needs no second eviction
 * path -- a name-only entry ages out exactly like any other.
 */
export function upsertPositionShipName(
  map: StaticMap,
  mmsi: string,
  shipName: string | undefined,
  cap: number = STATIC_MAP_CAP,
): void {
  if (shipName === undefined) return
  const existing = map.get(mmsi)
  if (existing?.shipName !== undefined) {
    touch(map, mmsi)
    return
  }
  upsertStatic(
    map,
    mmsi,
    { shipName, vesselType: existing?.vesselType ?? 'unknown', dimensions: existing?.dimensions },
    cap,
  )
}
