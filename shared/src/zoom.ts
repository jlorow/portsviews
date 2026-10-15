import type { ProjectionConfig } from './projection.ts'

export const RADIUS_STEPS_NM = [1, 2, 5, 10, 20, 40, 80] as const

/**
 * How far one arrow key or one wheel step moves the view, as a fraction of
 * the current radius. 0.2 of the radius is one fifth of the visible circle,
 * which is a clear move that never jumps a landmark out of view.
 */
export const PAN_FRACTION = 0.2

export function radiusStepsFor(defaultRadiusNm: number): number[] {
  const steps: number[] = RADIUS_STEPS_NM.filter((radiusNm) => radiusNm <= defaultRadiusNm)
  // Steps above the default are excluded because the live feed box only covers the default area, so zooming out past it would show empty margins.
  if (!steps.includes(defaultRadiusNm)) steps.push(defaultRadiusNm)
  return steps.sort((a, b) => a - b)
}

export function stepRadius(steps: readonly number[], current: number, direction: 'in' | 'out'): number {
  if (steps.length === 0) return current

  const index = steps.indexOf(current)
  if (index === -1) {
    return steps.reduce((nearest, radiusNm) =>
      Math.abs(radiusNm - current) < Math.abs(nearest - current) ? radiusNm : nearest,
    )
  }

  const nextIndex = direction === 'in' ? index - 1 : index + 1
  return steps[nextIndex] ?? current
}

export interface ZoomKeyEvent {
  key: string
  repeat: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  targetIsEditable: boolean
}

export function zoomKeyAction(event: ZoomKeyEvent): 'in' | 'out' | 'reset' | null {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.targetIsEditable) return null

  switch (event.key) {
    case '=':
    case '+':
      return 'in'
    case '-':
    case '_':
      return 'out'
    case '0':
      return 'reset'
    default:
      return null
  }
}

export type PanDirection = 'up' | 'down' | 'left' | 'right'

export interface PanCenterResult {
  centerLat: number
  centerLon: number
}

/**
 * Move the view centre so the picture slides by PAN_FRACTION x radiusNm in
 * the requested SCREEN direction.
 *
 * This is the exact inverse of mapProjectUnclipped's own arithmetic
 * (shared/src/projection.ts), which is:
 *
 *   latOffsetNm = (lat  - centerLat) * 60
 *   lonOffsetNm = (lon  - centerLon) * 60 * cos(centerLat * PI / 180)
 *   scale       = min(width, height) / 2 / radiusNm
 *   x           = width  / 2 + lonOffsetNm * scale
 *   y           = height / 2 - latOffsetNm * scale
 *   if mirrorX  x = width - x
 *   then rotate (x, y) about the canvas centre by rotationDeg
 *
 * A pan to the RIGHT moves the camera right, so the OLD centre must end up
 * LEFT of the canvas centre by exactly PAN_FRACTION * min(width, height) / 2
 * pixels -- and so on for the other three directions, with "up" putting the
 * old centre BELOW the canvas centre because screen y grows downward.
 *
 * Working backwards from that required screen displacement v (in pixels):
 * undo the rotation (R(-rotationDeg)), undo the mirror (negate x), and the
 * result is the offset in PRE-transform pixels u. Its nm components are
 * u * radiusNm / (min(width, height) / 2) = u * PAN_FRACTION, because v is
 * already scaled by PAN_FRACTION * radiusNm:
 *
 *   offsetXnm = ax * PAN_FRACTION * radiusNm
 *   offsetYnm = ay * PAN_FRACTION * radiusNm
 *   centerLat = lat + offsetYnm / 60
 *   centerLon = lon - offsetXnm / (60 * cos(centerLat))
 *
 * The cosine is taken on the NEW centre latitude, which is what mapProject
 * will use, so the round trip is exact rather than approximate.
 */
export function panCenter(
  centerLat: number,
  centerLon: number,
  direction: PanDirection,
  radiusNm: number,
  config: ProjectionConfig,
): PanCenterResult {
  // Required screen displacement of the old centre, in PAN_FRACTION units.
  let vx = 0
  let vy = 0
  switch (direction) {
    case 'right':
      vx = -1
      break
    case 'left':
      vx = 1
      break
    case 'up':
      vy = 1
      break
    case 'down':
      vy = -1
      break
  }

  const theta = (config.rotationDeg * Math.PI) / 180
  const cosTheta = Math.cos(theta)
  const sinTheta = Math.sin(theta)

  // Undo the rotation applied after the mirror in mapProject: R(-theta) v.
  const rotatedX = vx * cosTheta + vy * sinTheta
  const rotatedY = -vx * sinTheta + vy * cosTheta

  // Undo the mirror, which negates x only.
  const offsetXnm = (config.mirrorX ? -rotatedX : rotatedX) * PAN_FRACTION * radiusNm
  const offsetYnm = rotatedY * PAN_FRACTION * radiusNm

  const nextCenterLat = centerLat + offsetYnm / 60
  const lonDegPerNm = 1 / (60 * Math.cos((nextCenterLat * Math.PI) / 180))

  return {
    centerLat: nextCenterLat,
    centerLon: centerLon - offsetXnm * lonDegPerNm,
  }
}

/**
 * Keep the view centre inside the area the live feed actually covers.
 *
 * feedBox is area.boundingBoxes[0]: [[northLat, westLon], [southLat, eastLon]].
 * The box centre is the mean of the two corners in each axis. The box's
 * half-extents in nautical miles (1 nm = 1 arc minute) are:
 *
 *   halfHeightNm = |northLat - southLat| / 2 * 60
 *   halfWidthNm  = |eastLon  - westLon|  / 2 * 60 * cos(boxCentreLat)
 *
 * so the centre may stray at most max(0, halfExtentNm - radiusNm) from the
 * box centre on each axis; when the view circle is wider than the feed box
 * that allowance is zero and the axis is pinned to the box centre.
 */
export function clampPanToFeed(
  centerLat: number,
  centerLon: number,
  radiusNm: number,
  feedBox: number[][][],
): PanCenterResult {
  const box = feedBox[0]
  const boxCentreLat = (box[0][0] + box[1][0]) / 2
  const boxCentreLon = (box[0][1] + box[1][1]) / 2

  const halfHeightNm = (Math.abs(box[0][0] - box[1][0]) / 2) * 60
  const halfWidthNm = ((Math.abs(box[0][1] - box[1][1]) / 2) * 60 * Math.cos((boxCentreLat * Math.PI) / 180))

  const latLimit = Math.max(0, halfHeightNm - radiusNm)
  const lonLimit = Math.max(0, halfWidthNm - radiusNm)

  const clampAxis = (value: number, centre: number, limit: number): number => {
    if (limit <= 0) return centre
    return Math.max(centre - limit, Math.min(centre + limit, value))
  }

  return {
    centerLat: clampAxis(centerLat, boxCentreLat, latLimit),
    centerLon: clampAxis(centerLon, boxCentreLon, lonLimit),
  }
}

/**
 * The pan keys. Key repeat IS allowed here and deliberately not filtered:
 * holding an arrow key should keep the view moving, which is the opposite
 * of TUNE_MODE's one-action-per-physical-press rule (a held F rebuilt the
 * whole MapLibre style once per frame -- CLAUDE.md's Correction 27).
 * Combinations the browser owns (Ctrl, Alt, Cmd) are left alone, as is any
 * editable target.
 */
export interface PanKeyEvent {
  key: string
  repeat?: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  targetIsEditable: boolean
}

export function panKeyAction(event: PanKeyEvent): PanDirection | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.targetIsEditable) return null

  switch (event.key) {
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    default:
      return null
  }
}

export interface WheelZoomEvent {
  deltaY: number
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

export interface WheelZoomActionResult {
  action: 'in' | 'out'
  /** The time this step was taken, for the caller to keep as its lastStepMs. */
  stepAtMs: number
}

/** One wheel step per this many milliseconds; a trackpad's flood is one step. */
export const WHEEL_STEP_MIN_INTERVAL_MS = 300

/**
 * deltaY below 0 is 'in', above 0 is 'out'. A deltaY smaller than 1 in
 * magnitude is noise, not a swipe, and a step is allowed only when
 * nowMs - lastStepMs >= WHEEL_STEP_MIN_INTERVAL_MS; otherwise null and the
 * caller's lastStepMs is left alone. Ctrl, Alt and Cmd combinations belong
 * to the browser (pinch-zoom and page scroll) and are never consumed.
 */
export function wheelZoomAction(
  event: WheelZoomEvent,
  nowMs: number,
  lastStepMs: number,
): WheelZoomActionResult | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (Math.abs(event.deltaY) < 1) return null
  if (nowMs - lastStepMs < WHEEL_STEP_MIN_INTERVAL_MS) return null

  return { action: event.deltaY < 0 ? 'in' : 'out', stepAtMs: nowMs }
}
