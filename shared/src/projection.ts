import { deadReckon } from './vesselState.ts'

export interface ProjectionConfig {
  mirrorX: boolean
  rotationDeg: number
}

export function rotatePoint(
  x: number,
  y: number,
  cx: number,
  cy: number,
  angleDeg: number,
): { x: number; y: number } {
  const angleRad = (angleDeg * Math.PI) / 180
  const dx = x - cx
  const dy = y - cy
  return {
    x: cx + dx * Math.cos(angleRad) - dy * Math.sin(angleRad),
    y: cy + dx * Math.sin(angleRad) + dy * Math.cos(angleRad),
  }
}

// One scale for both axes, from the smaller canvas dimension -- same
// convention skyProject already uses for its radius. Guarantees the
// full radiusNm is visible vertically on a wide display; more than
// radiusNm shows horizontally, which is correct for a circular view.
// Exported so a non-vessel screen element (VIS-6's range rings) can share
// mapProject's own scale instead of a second copy of this formula.
export function pxPerNm(canvasWidth: number, canvasHeight: number, radiusNm: number): number {
  return Math.min(canvasWidth, canvasHeight) / 2 / radiusNm
}

/**
 * mapProject's arithmetic WITHOUT its circular cull.
 *
 * mapProject returns null beyond radiusNm, which is exactly right for a
 * vessel — a ship outside the view is not drawn. It is exactly wrong for
 * a full-bleed BACKGROUND layer: the inscribed circle of radius radiusNm
 * touches the top and bottom edges of a landscape canvas but leaves the
 * corners outside it, so land culled this way would render as a disc of
 * coastline floating in black rather than as a map behind the scene.
 * VIS-9 never hit this because MapLibre drew the basemap on its own
 * element, under the canvas, with no cull at all.
 *
 * Extracted rather than copied. mapProject below is unchanged in
 * behaviour and now ends by delegating here, so there is still ONE mirror,
 * ONE rotation and ONE pxPerNm in this codebase and a background layer
 * cannot drift from the ships drawn on top of it.
 */
export function mapProjectUnclipped(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
  radiusNm: number,
  config: ProjectionConfig,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  const latOffsetNm = (lat - centerLat) * 60
  const lonOffsetNm = (lon - centerLon) * 60 * Math.cos((centerLat * Math.PI) / 180)

  const scale = pxPerNm(canvasWidth, canvasHeight, radiusNm)

  let x = canvasWidth / 2 + lonOffsetNm * scale
  const y = canvasHeight / 2 - latOffsetNm * scale

  if (config.mirrorX) {
    x = canvasWidth - x
  }

  const rotated = rotatePoint(x, y, canvasWidth / 2, canvasHeight / 2, config.rotationDeg)

  return { x: rotated.x, y: rotated.y }
}

export function mapProject(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
  radiusNm: number,
  config: ProjectionConfig,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } | null {
  const latOffsetDeg = lat - centerLat
  const lonOffsetDeg = lon - centerLon

  const latOffsetNm = latOffsetDeg * 60
  const lonOffsetNm = lonOffsetDeg * 60 * Math.cos((centerLat * Math.PI) / 180)

  const distanceNm = Math.sqrt(latOffsetNm * latOffsetNm + lonOffsetNm * lonOffsetNm)
  if (distanceNm > radiusNm) {
    return null
  }

  return mapProjectUnclipped(lat, lon, centerLat, centerLon, radiusNm, config, canvasWidth, canvasHeight)
}

// One knot for one second in seconds -- deadReckon's own formula --
// gives exactly 0.01nm of travel, small enough that the great-circle
// approximation it already uses for dead reckoning is not a source of
// error here.
const HEADING_PROBE_NM = 0.01
const HEADING_PROBE_SOG_KN = HEADING_PROBE_NM * 3600
const HEADING_PROBE_ELAPSED_SEC = 1

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * Screen-space heading for a vessel glyph: degrees clockwise from
 * screen-up (matching ctx.rotate's own convention under canvas's
 * y-down coordinate system), derived from where the vessel and a point
 * 0.01nm ahead along cogDeg actually land after mapProject's mirror and
 * rotation. Correction 18: raw cogDeg only equals this when mirrorX is
 * false and rotationDeg is 0 -- neither holds under DEFAULT_CONFIG.
 *
 * Falls back to the config-transformed cogDeg (no projection applied)
 * when either point falls outside the view radius or the two points
 * project to the same pixel -- both cases where the screen vector
 * carries no directional information.
 */
export function screenHeadingDeg(
  lat: number,
  lon: number,
  cogDeg: number,
  centerLat: number,
  centerLon: number,
  radiusNm: number,
  config: ProjectionConfig,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const fallback = () => normalizeDeg((config.mirrorX ? -cogDeg : cogDeg) + config.rotationDeg)

  const origin = mapProject(lat, lon, centerLat, centerLon, radiusNm, config, canvasWidth, canvasHeight)
  if (origin === null) return fallback()

  const ahead = deadReckon(
    { mmsi: '', lat, lon, cogDeg, sogKn: HEADING_PROBE_SOG_KN, timestamp: 0 },
    HEADING_PROBE_ELAPSED_SEC * 1000,
    HEADING_PROBE_ELAPSED_SEC,
  )
  const aheadPoint = mapProject(ahead.lat, ahead.lon, centerLat, centerLon, radiusNm, config, canvasWidth, canvasHeight)
  if (aheadPoint === null) return fallback()

  const dx = aheadPoint.x - origin.x
  const dy = aheadPoint.y - origin.y
  if (Math.hypot(dx, dy) < 1e-9) return fallback()

  return normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI)
}

export function skyProject(
  azimuthDeg: number,
  altitudeDeg: number,
  config: ProjectionConfig,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } | null {
  if (altitudeDeg < 0) {
    return null
  }

  const r = (1 - altitudeDeg / 90) * (Math.min(canvasWidth, canvasHeight) / 2)
  const azimuthRad = (azimuthDeg * Math.PI) / 180

  let x = canvasWidth / 2 + r * Math.sin(azimuthRad)
  const y = canvasHeight / 2 - r * Math.cos(azimuthRad)

  if (config.mirrorX) {
    x = canvasWidth - x
  }

  const rotated = rotatePoint(x, y, canvasWidth / 2, canvasHeight / 2, config.rotationDeg)

  return { x: rotated.x, y: rotated.y }
}
