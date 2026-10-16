import type { TrackPoint, VesselFix, VesselType } from '@wake/shared'
import { isExpired, MAX_TRACK_POINTS } from '@wake/shared'

// Same values as server/src/aisstream.ts -- duplicated, not imported.
// That file pulls in the Node-only `ws` package, and apps/display has no
// package relationship with server/ at all (only @wake/shared is shared
// between the two); importing it would either break Vite's browser
// bundle resolution or require inventing a cross-app dependency this
// monorepo doesn't otherwise have. Keep these in sync by hand if the
// server-side values ever change.
export const BASE_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 30000
export const JITTER_MAX_MS = 1000
export const HEALTHY_RESET_MS = 60000

// A real browser WebSocket satisfies this structurally with no adapter
// (property-assignment handlers, not EventEmitter -- native browser
// WebSocket, unlike Node's `ws` package, doesn't have .on()). A plain
// mock object can implement it with no real networking, which is what
// makes the test suite able to drive connection/reconnect logic under
// tsx with no DOM.
export interface WakeSocketLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: (() => void) | null
  onerror: ((event: unknown) => void) | null
  close(): void
  readonly readyState: number
}

export type SocketFactory = (url: string) => WakeSocketLike
export type ScheduleFn = (fn: () => void, delayMs: number) => unknown
export type CancelFn = (handle: unknown) => void

export interface ClientVesselEntry {
  fix?: VesselFix
  shipName?: string
  vesselType?: VesselType
  dimensions?: { lengthM: number; beamM: number }
}

export type VesselStateMap = Map<string, ClientVesselEntry>

// Message shapes mirrored from server/src/broadcast.ts's BroadcastMessage
// union. Not imported -- same cross-app boundary as the backoff
// constants above; @wake/shared is the only package this app may depend
// on, and server/src/broadcast.ts imports the real `ws` library too.
interface PositionBroadcastMessage {
  kind: 'position'
  fix: VesselFix
  shipName?: string
  vesselType?: VesselType
  dimensions?: { lengthM: number; beamM: number }
}
interface StaticBroadcastMessage {
  kind: 'static'
  mmsi: string
  shipName?: string
  vesselType: VesselType
  dimensions?: { lengthM: number; beamM: number }
}
// Route history v1: a snapshot vessel is a position message plus the
// server's recent positions for it, [latitude, longitude, timestamp in
// ms], oldest first. Mirrored from server/src/broadcast.ts's
// SnapshotVesselMessage/TrackMessage. Kept on its own interface rather
// than on PositionBroadcastMessage, because a LIVE position message never
// carries this field and the type should say so.
interface SnapshotVesselMessage extends PositionBroadcastMessage {
  track?: unknown
}
interface SnapshotMessage {
  kind: 'snapshot'
  vessels: SnapshotVesselMessage[]
}
type IncomingMessage = PositionBroadcastMessage | StaticBroadcastMessage | SnapshotMessage

function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'position' || kind === 'static' || kind === 'snapshot'
}

// Merges fields additively: a defined value in the incoming message
// wins, but an absent (undefined) field never clobbers a value already
// held. A position message that (per the server's own design) always
// carries whatever static fields it currently knows still can't erase
// good data with absence if messages ever arrive out of order.
function mergeVesselFields(
  existing: ClientVesselEntry | undefined,
  incoming: { shipName?: string; vesselType?: VesselType; dimensions?: { lengthM: number; beamM: number } },
  fix: VesselFix | undefined,
): ClientVesselEntry {
  return {
    fix: fix ?? existing?.fix,
    shipName: incoming.shipName ?? existing?.shipName,
    vesselType: incoming.vesselType ?? existing?.vesselType,
    dimensions: incoming.dimensions ?? existing?.dimensions,
  }
}

export function applyPositionMessage(
  state: VesselStateMap,
  msg: PositionBroadcastMessage,
  onFix?: (fix: VesselFix, track?: TrackPoint[]) => void,
  // Only ever supplied by applySnapshot below. A live delta passes
  // nothing, so track is undefined for every position message that did
  // not come out of a connect snapshot.
  track?: TrackPoint[],
): void {
  const existing = state.get(msg.fix.mmsi)
  state.set(msg.fix.mmsi, mergeVesselFields(existing, msg, msg.fix))
  onFix?.(msg.fix, track)
}

export function applyStaticMessage(state: VesselStateMap, msg: StaticBroadcastMessage): void {
  const existing = state.get(msg.mmsi)
  state.set(msg.mmsi, mergeVesselFields(existing, msg, undefined))
}

const MIN_LATITUDE_DEG = -90
const MAX_LATITUDE_DEG = 90
const MIN_LONGITUDE_DEG = -180
const MAX_LONGITUDE_DEG = 180

/**
 * Validates one snapshot vessel's track off the wire, returning undefined
 * for anything untrustworthy -- an absent field, a non-array, an entry
 * that is not exactly three finite numbers in range, or a timestamp that
 * is not strictly later than the entry before it. Route history v1's
 * decision: one bad entry invalidates the WHOLE track rather than being
 * skipped, because a trail with a hole in the middle silently claims the
 * ship went straight across a leg it did not travel. A rejected track
 * leaves the vessel behaving exactly as it did before this story: its own
 * fixes build its own trail from the next message on.
 *
 * The last MAX_TRACK_POINTS entries are kept, matching the server's own
 * cap, so a server that ever exceeded it cannot grow this client's
 * memory past the same bound.
 */
export function parseTrack(
  raw: unknown,
  maxPoints: number = MAX_TRACK_POINTS,
): TrackPoint[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined

  const points: TrackPoint[] = []
  let previousTimestamp: number | undefined

  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 3) return undefined
    const [lat, lon, timestamp] = entry as unknown[]
    if (typeof lat !== 'number' || typeof lon !== 'number' || typeof timestamp !== 'number') return undefined
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(timestamp)) return undefined
    if (lat < MIN_LATITUDE_DEG || lat > MAX_LATITUDE_DEG) return undefined
    if (lon < MIN_LONGITUDE_DEG || lon > MAX_LONGITUDE_DEG) return undefined
    if (previousTimestamp !== undefined && timestamp <= previousTimestamp) return undefined
    previousTimestamp = timestamp
    points.push({ lat, lon, timestamp })
  }

  return points.length > maxPoints ? points.slice(points.length - maxPoints) : points
}

/**
 * Merges a snapshot into existing state -- updates or adds every vessel
 * the snapshot mentions, but never deletes a vessel the client already
 * held just because this one snapshot omits it. Staleness for an omitted
 * vessel is decided later, independently, by pruneExpiredVessels against
 * its own last-known fix -- exactly as if the server had simply stopped
 * hearing from it, not as a special reconnect case.
 *
 * Route history v1: a vessel's track is validated here, at the one place
 * it can arrive from, and handed to onFix beside the fix it belongs to.
 */
export function applySnapshot(
  state: VesselStateMap,
  msg: SnapshotMessage,
  onFix?: (fix: VesselFix, track?: TrackPoint[]) => void,
): void {
  for (const vessel of msg.vessels) {
    applyPositionMessage(state, vessel, onFix, parseTrack(vessel.track))
  }
}

/**
 * Removes vessels whose last known fix is expired under removeSec.
 * Takes nowMs explicitly, matching vesselOpacity/isExpired/deadReckon --
 * no internal clock read here. A vessel with no fix at all (a
 * static-only resolution with no position ever received) has no age to
 * judge and is left alone. This is isExpired's first application caller
 * -- it has existed since S1.5 with no consumer outside its own test.
 */
export function pruneExpiredVessels(state: VesselStateMap, nowMs: number, removeSec: number): void {
  for (const [mmsi, entry] of state) {
    if (entry.fix && isExpired(entry.fix, nowMs, removeSec)) {
      state.delete(mmsi)
    }
  }
}

export function handleIncomingData(
  state: VesselStateMap,
  data: string,
  onFix?: (fix: VesselFix, track?: TrackPoint[]) => void,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    // Malformed payload -- ignored, connection stays up.
    return
  }

  if (!isIncomingMessage(parsed)) {
    // Unrecognized discriminant (or none at all) -- ignored silently,
    // the same "not an error" stance normalize() takes server-side for
    // unrecognized message types.
    return
  }

  if (parsed.kind === 'snapshot') {
    applySnapshot(state, parsed, onFix)
  } else if (parsed.kind === 'position') {
    applyPositionMessage(state, parsed, onFix)
  } else {
    applyStaticMessage(state, parsed)
  }
}

export type ConnectionStatus = 'connected' | 'disconnected'

export interface WakeConnectionHandlers {
  onStatusChange?: (status: ConnectionStatus) => void
  // Fires once per position-bearing message actually processed -- once
  // per delta, and once per vessel inside a snapshot. Not deduplicated
  // against previously-seen fix content; a reconnect snapshot re-sending
  // a fix the client already fully processed fires this again, which
  // only costs one redundant, bounded applyFix call, not correctness.
  // The point this exists to solve is "never fires on a frame with no
  // new fix" (S1.8 wires this to applyFix), not fix-content dedup.
  // Route history v1 adds the second parameter: the server's recent
  // positions for that vessel when the fix came inside a connect
  // snapshot, undefined for every live delta.
  onFix?: (fix: VesselFix, track?: TrackPoint[]) => void
}

/**
 * Owns the socket lifecycle: connect, parse incoming messages into
 * state, and reconnect with the same backoff shape as
 * server/src/aisstream.ts's AisStreamClient. The server not running at
 * page load is not a special case -- a failed initial connection fires
 * onclose exactly like a mid-session drop, and both funnel through the
 * same scheduleReconnect path.
 *
 * socketFactory, scheduleFn and cancelFn are injectable so tests can
 * drive this with a mock socket and a mock timer under tsx, with no real
 * networking and no real waiting -- default scheduleFn/cancelFn are the
 * real setTimeout/clearTimeout for production use.
 */
export class WakeConnection {
  private ws: WakeSocketLike | undefined
  private backoffMs = BASE_BACKOFF_MS
  private healthyTimerHandle: unknown
  private stopped = false

  constructor(
    private readonly url: string,
    private readonly state: VesselStateMap,
    private readonly socketFactory: SocketFactory,
    private readonly scheduleFn: ScheduleFn = (fn, ms) => setTimeout(fn, ms),
    private readonly cancelFn: CancelFn = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    private readonly handlers: WakeConnectionHandlers = {},
  ) {}

  connect(): void {
    if (this.stopped) return

    const ws = this.socketFactory(this.url)
    this.ws = ws

    ws.onopen = () => {
      this.handlers.onStatusChange?.('connected')
      this.healthyTimerHandle = this.scheduleFn(() => {
        this.backoffMs = BASE_BACKOFF_MS
      }, HEALTHY_RESET_MS)
    }

    ws.onmessage = (event) => {
      handleIncomingData(this.state, event.data, this.handlers.onFix)
    }

    ws.onclose = () => {
      if (this.healthyTimerHandle !== undefined) {
        this.cancelFn(this.healthyTimerHandle)
        this.healthyTimerHandle = undefined
      }
      this.handlers.onStatusChange?.('disconnected')
      if (this.stopped) return
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // The WebSocket spec fires close after error, which already runs
      // the reconnect path -- nothing additional needed here.
    }
  }

  private scheduleReconnect(): void {
    const jitter = Math.random() * JITTER_MAX_MS
    const delay = Math.min(this.backoffMs, MAX_BACKOFF_MS) + jitter

    this.scheduleFn(() => {
      if (this.stopped) return
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
      this.connect()
    }, delay)
  }

  stop(): void {
    this.stopped = true
    if (this.healthyTimerHandle !== undefined) {
      this.cancelFn(this.healthyTimerHandle)
      this.healthyTimerHandle = undefined
    }
    this.ws?.close()
  }

  getBackoffMs(): number {
    return this.backoffMs
  }
}
