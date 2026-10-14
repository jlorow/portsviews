import type { TrackPoint } from './track.ts'
import type { DisplayConfig } from './config.ts'

export interface VesselFix {
  mmsi: string
  lat: number
  lon: number
  cogDeg: number      // course over ground, 0=N 90=E 180=S 270=W
  sogKn: number       // speed over ground in knots
  timestamp: number   // Unix ms when this fix was received
}

export interface VesselState {
  mmsi: string
  lastFix: VesselFix
  displayLat: number  // eased position actually rendered
  displayLon: number
  track: TrackPoint[] // real fixes only, oldest first, max 120
}

export const MAX_TRACK_POINTS = 120

export function shortestLonDelta(from: number, to: number): number {
  let delta = to - from
  if (delta > 180) delta -= 360
  if (delta < -180) delta += 360
  return delta
}

export function deadReckon(
  fix: VesselFix,
  nowMs: number,
  maxExtrapolationSec: number,
): { lat: number; lon: number } {
  const elapsedSec = Math.min(
    Math.max((nowMs - fix.timestamp) / 1000, 0),
    maxExtrapolationSec,
  )
  const distanceNm = (fix.sogKn * elapsedSec) / 3600
  const cogRad = (fix.cogDeg * Math.PI) / 180
  const dLat = (distanceNm * Math.cos(cogRad)) / 60
  const dLon =
    Math.abs(fix.lat) > 89.9
      ? 0
      : (distanceNm * Math.sin(cogRad)) /
        (60 * Math.cos((fix.lat * Math.PI) / 180))

  return { lat: fix.lat + dLat, lon: fix.lon + dLon }
}

export function smoothingAlpha(smoothing: number, deltaMs: number): number {
  const alpha = 1 - Math.pow(1 - smoothing, deltaMs / 16.67)
  return Math.min(Math.max(alpha, 0), 1)
}

export function vesselOpacity(
  fix: VesselFix,
  nowMs: number,
  staleSec: number,
  removeSec: number,
): number {
  const ageSec = (nowMs - fix.timestamp) / 1000
  if (ageSec <= staleSec) return 1.0
  if (ageSec >= removeSec) return 0
  return 1.0 - (0.8 * (ageSec - staleSec)) / (removeSec - staleSec)
}

export function isExpired(
  fix: VesselFix,
  nowMs: number,
  removeSec: number,
): boolean {
  return (nowMs - fix.timestamp) / 1000 >= removeSec
}

export function applyFix(
  prev: VesselState | undefined,
  fix: VesselFix,
): VesselState {
  const newPoint: TrackPoint = {
    lat: fix.lat,
    lon: fix.lon,
    timestamp: fix.timestamp,
  }

  if (prev === undefined) {
    return {
      mmsi: fix.mmsi,
      lastFix: fix,
      displayLat: fix.lat,
      displayLon: fix.lon,
      track: [newPoint],
    }
  }

  const track = [...prev.track, newPoint]
  const cappedTrack =
    track.length > MAX_TRACK_POINTS
      ? track.slice(track.length - MAX_TRACK_POINTS)
      : track

  return {
    mmsi: prev.mmsi,
    lastFix: fix,
    displayLat: prev.displayLat,
    displayLon: prev.displayLon,
    track: cappedTrack,
  }
}

export function updateVesselState(
  state: VesselState,
  nowMs: number,
  deltaMs: number,
  config: Pick<DisplayConfig, 'smoothing' | 'maxExtrapolationSec'>,
): VesselState {
  const target = deadReckon(state.lastFix, nowMs, config.maxExtrapolationSec)
  const alpha = smoothingAlpha(config.smoothing, deltaMs)

  const displayLat = state.displayLat + (target.lat - state.displayLat) * alpha
  const displayLon =
    state.displayLon + shortestLonDelta(state.displayLon, target.lon) * alpha

  return {
    mmsi: state.mmsi,
    lastFix: state.lastFix,
    displayLat,
    displayLon,
    track: state.track,
  }
}
