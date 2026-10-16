import type { VesselFix } from '@wake/shared'
import { normalize } from './normalize.ts'
import type { PositionMap, StaticMap } from './caches.ts'
import {
  upsertPosition,
  upsertStatic,
  touchStaticOnActivity,
  upsertPositionShipName,
  evictStalePositions,
} from './caches.ts'
import { broadcastToClients, mergeStatic, type ClientSocket, type BroadcastMessage } from './broadcast.ts'
import { appendTrackPoint, pruneTracks, type TrackMap } from './trackBuffer.ts'

export interface PipelineContext {
  positionMap: PositionMap
  staticMap: StaticMap
  // The route-history buffer (trackBuffer.ts). Required, not optional:
  // every caller that holds a position map must also hold the tracks
  // that go with it, so a vessel can never be evicted from one and left
  // in the other.
  trackMap: TrackMap
  clients: Set<ClientSocket>
  removeSec: number
}

/**
 * The seam that makes replay possible. Takes a raw envelope and an
 * explicit nowMs -- no AisStreamClient dependency, no internal clock
 * read -- so a replay harness can call this directly with captured
 * envelopes and virtual time, and the live server can call it from
 * AisStreamClient's onMessage with the same function.
 *
 * normalizeFn defaults to the real normalize() and exists only so a test
 * can inject a fault (normalize() is proven not to throw by its own test
 * suite, so the defensive catch below has no real-world trigger to
 * replay against otherwise).
 *
 * rewriteFixTimestamp is undefined on the live path (default, zero
 * behaviour change) and set by replay mode to replace a fix's parsed
 * capture-time timestamp with the real current clock before it is ever
 * stored or broadcast -- replayed capture data is from 14 September;
 * fed raw against a real clock every vessel would read as already past
 * removeSec. Applied only to the 'position' branch: 'static' results
 * carry no timestamp field to rewrite.
 */
export function processEnvelope(
  envelope: unknown,
  ctx: PipelineContext,
  nowMs: number,
  normalizeFn: typeof normalize = normalize,
  rewriteFixTimestamp?: (fix: VesselFix, nowMs: number) => VesselFix,
): void {
  evictStalePositions(ctx.positionMap, nowMs, ctx.removeSec)
  // Same instant, same rule: a vessel whose fix just aged out of the
  // position map loses its history too. Done as a second call rather
  // than folded into evictStalePositions so that function keeps its
  // single-map signature and its own existing tests.
  pruneTracks(ctx.trackMap, ctx.positionMap)

  let result: ReturnType<typeof normalize>
  try {
    result = normalizeFn(envelope)
  } catch (err) {
    console.error('[Wake] normalize() threw on an envelope -- skipping it:', (err as Error).message)
    return
  }

  if (result === undefined) {
    // Expected, tested output for SubscriptionConfirmation and any
    // unrecognized message type. Not an error -- no log, no mutation,
    // no broadcast.
    return
  }

  if (result.kind === 'position') {
    const fix = rewriteFixTimestamp ? rewriteFixTimestamp(result.fix, nowMs) : result.fix
    upsertPosition(ctx.positionMap, fix)
    appendTrackPoint(ctx.trackMap, fix)
    touchStaticOnActivity(ctx.staticMap, fix.mmsi)
    // VIS-7 audit finding (Correction-shaped): a position message's own
    // ShipName was being computed by normalize() and then dropped here --
    // see caches.ts's upsertPositionShipName doc comment.
    upsertPositionShipName(ctx.staticMap, fix.mmsi, result.shipName)
    const message: BroadcastMessage = mergeStatic(fix, ctx.staticMap)
    broadcastToClients(ctx.clients, message)
    return
  }

  upsertStatic(ctx.staticMap, result.mmsi, {
    shipName: result.shipName,
    vesselType: result.vesselType,
    dimensions: result.dimensions,
  })
  const message: BroadcastMessage = {
    kind: 'static',
    mmsi: result.mmsi,
    shipName: result.shipName,
    vesselType: result.vesselType,
    dimensions: result.dimensions,
  }
  broadcastToClients(ctx.clients, message)
}
