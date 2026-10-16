import { WebSocketServer, type WebSocket } from 'ws'
import type { TrackPoint, VesselFix, VesselType } from '@wake/shared'
import type { PositionMap, StaticMap } from './caches.ts'
import { getStatic } from './caches.ts'
import type { TrackMap } from './trackBuffer.ts'

// Narrow interface a broadcast target must satisfy. A real `ws.WebSocket`
// satisfies this structurally with no adapter, and a plain mock object
// can implement it with no real networking -- this is what makes the
// replay harness able to drive the broadcast/error-isolation logic below
// without a live socket.
export interface ClientSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  once(event: 'close', listener: () => void): void
}

export interface PositionBroadcastMessage {
  kind: 'position'
  fix: VesselFix
  shipName?: string
  vesselType?: VesselType
  dimensions?: { lengthM: number; beamM: number }
}

export interface StaticBroadcastMessage {
  kind: 'static'
  mmsi: string
  shipName?: string
  vesselType: VesselType
  dimensions?: { lengthM: number; beamM: number }
}

// Route history v1: one vessel entry's recent positions, as it travels on
// the wire -- [latitude, longitude, timestamp in ms], oldest first, at
// most MAX_TRACK_POINTS entries. Latitude and longitude are rounded to 5
// decimals (about 1 m) so the snapshot stays small; the timestamp is the
// full-precision ms value, because it is the identity the display uses to
// tell whether its own live track is already newer than this one.
export type TrackMessage = [number, number, number][]

export interface SnapshotVesselMessage extends PositionBroadcastMessage {
  // Absent for a vessel with no history yet (just discovered, or its
  // track was pruned). A live position message NEVER carries this field --
  // see PositionBroadcastMessage above, which this extends rather than
  // duplicating, so the snapshot entry is still exactly a position message
  // plus an optional extra.
  track?: TrackMessage
}

export interface SnapshotMessage {
  kind: 'snapshot'
  vessels: SnapshotVesselMessage[]
}

export type BroadcastMessage = PositionBroadcastMessage | StaticBroadcastMessage | SnapshotMessage

// Static fields merged at send time, not broadcast as a separate channel.
export function mergeStatic(fix: VesselFix, staticMap: StaticMap): PositionBroadcastMessage {
  const info = getStatic(staticMap, fix.mmsi)
  return {
    kind: 'position',
    fix,
    shipName: info?.shipName,
    vesselType: info?.vesselType,
    dimensions: info?.dimensions,
  }
}

const TRACK_ROUNDING_DECIMALS = 5

function roundCoordinate(value: number): number {
  return Number(value.toFixed(TRACK_ROUNDING_DECIMALS))
}

function toTrackMessage(points: TrackPoint[] | undefined): TrackMessage | undefined {
  if (points === undefined || points.length === 0) return undefined
  return points.map((point) => [
    roundCoordinate(point.lat),
    roundCoordinate(point.lon),
    point.timestamp,
  ])
}

/**
 * The whole current state in one message. trackMap is optional and
 * defaults to empty, so every existing caller -- and every existing test
 * that builds a snapshot from two maps -- keeps working unchanged and
 * simply sends no tracks, exactly as before route history existed.
 */
export function buildSnapshot(
  positionMap: PositionMap,
  staticMap: StaticMap,
  trackMap: TrackMap = new Map(),
): SnapshotMessage {
  const vessels: SnapshotVesselMessage[] = []
  for (const fix of positionMap.values()) {
    const vessel = mergeStatic(fix, staticMap)
    const track = toTrackMessage(trackMap.get(fix.mmsi))
    vessels.push(track === undefined ? vessel : { ...vessel, track })
  }
  return { kind: 'snapshot', vessels }
}

export const BUFFERED_AMOUNT_LIMIT_BYTES = 256 * 1024

function dropClient(clients: Set<ClientSocket>, client: ClientSocket): void {
  clients.delete(client)
  try {
    client.close()
  } catch {
    // best-effort -- the client is already being removed regardless
  }
}

function trySend(clients: Set<ClientSocket>, client: ClientSocket, payload: string): void {
  if (client.bufferedAmount > BUFFERED_AMOUNT_LIMIT_BYTES) {
    console.error(
      `[Wake] Client bufferedAmount exceeded ${BUFFERED_AMOUNT_LIMIT_BYTES} bytes -- dropping`,
    )
    dropClient(clients, client)
    return
  }

  try {
    client.send(payload)
  } catch (err) {
    console.error('[Wake] Send failed, dropping client:', (err as Error).message)
    dropClient(clients, client)
  }
}

/**
 * Broadcasts one already-normalized message to every connected client.
 * Each send is isolated individually -- one client throwing (or being
 * over its buffered-amount limit) never affects delivery to the others.
 */
export function broadcastToClients(clients: Set<ClientSocket>, message: BroadcastMessage): void {
  const payload = JSON.stringify(message)
  for (const client of clients) {
    trySend(clients, client, payload)
  }
}

/**
 * Sends the current full state to one newly-connected client. A failure
 * here is handled identically to any other broken-client send -- a
 * snapshot is one JSON string in one `send()` call, so there is no
 * partial-delivery state to reason about separately.
 */
export function sendSnapshot(
  clients: Set<ClientSocket>,
  client: ClientSocket,
  positionMap: PositionMap,
  staticMap: StaticMap,
  trackMap?: TrackMap,
): void {
  const payload = JSON.stringify(buildSnapshot(positionMap, staticMap, trackMap))
  trySend(clients, client, payload)
}

export interface BroadcastServerHandle {
  clients: Set<ClientSocket>
  close: () => Promise<void>
}

/**
 * The only function in this file that touches a real socket. Everything
 * else above operates on the abstract ClientSocket interface and is
 * exercised by the replay harness with no WebSocketServer involved.
 */
export function createBroadcastServer(
  port: number,
  positionMap: PositionMap,
  staticMap: StaticMap,
  trackMap?: TrackMap,
): BroadcastServerHandle {
  const clients: Set<ClientSocket> = new Set()
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws)
    sendSnapshot(clients, ws, positionMap, staticMap, trackMap)

    ws.on('close', () => {
      clients.delete(ws)
    })
    ws.on('error', () => {
      clients.delete(ws)
    })
  })

  console.log(`[Wake] Broadcast server listening on port ${port}`)

  return {
    clients,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  }
}
