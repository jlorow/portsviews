import {
  TrackPoint,
  VesselType,
  ProjectionConfig,
  VESSEL_COLORS,
  mapProject,
} from '@wake/shared'

function trailLengthToPoints(length: 'short' | 'medium' | 'long'): number {
  return { short: 20, medium: 60, long: 120 }[length]
}

function distanceNm(p1: TrackPoint, p2: TrackPoint): number {
  const latDiff = (p2.lat - p1.lat) * 60
  const lonDiff =
    (p2.lon - p1.lon) * 60 * Math.cos((p1.lat * Math.PI) / 180)
  return Math.sqrt(latDiff * latDiff + lonDiff * lonDiff)
}

/**
 * Draw a vessel's wake trail on the canvas, in the vessel's own glyph
 * colour (VIS-3 T2, replacing the fixed #2A4A6A). Trail fades by distance
 * traveled, not by time. A stopped vessel has no trail.
 *
 * @param ctx           - Canvas 2D context
 * @param points        - Ordered track points, oldest first
 * @param projConfig    - mirrorX + rotationDeg from DisplayConfig
 * @param centerLat     - View center latitude
 * @param centerLon     - View center longitude
 * @param radiusNm      - View radius in nautical miles
 * @param canvasWidth   - Current canvas width
 * @param canvasHeight  - Current canvas height
 * @param vesselType    - Selects the stroke colour via VESSEL_COLORS
 * @param opacity       - Vessel opacity (1.0 normal, 0.2 stale)
 * @param trailLength   - Trail length config ('short' | 'medium' | 'long')
 * @param projectFn     - Defaults to the real mapProject. Injectable only
 *                        so a test can spy on call count -- same pattern
 *                        as wakeSocket.ts's SocketFactory/ScheduleFn.
 *                        Never passed explicitly outside tests.
 */
export function drawTrail(
  ctx: CanvasRenderingContext2D,
  points: TrackPoint[],
  projConfig: ProjectionConfig,
  centerLat: number,
  centerLon: number,
  radiusNm: number,
  canvasWidth: number,
  canvasHeight: number,
  vesselType: VesselType,
  opacity: number,
  trailLength: 'short' | 'medium' | 'long' = 'medium',
  projectFn: typeof mapProject = mapProject,
): void {
  if (points.length < 2) return

  const maxPoints = trailLengthToPoints(trailLength)
  const visiblePoints = points.slice(-maxPoints)

  // Compute total distance
  let totalDistanceNm = 0
  for (let i = 0; i < visiblePoints.length - 1; i++) {
    totalDistanceNm += distanceNm(visiblePoints[i], visiblePoints[i + 1])
  }

  if (totalDistanceNm < 0.1) return

  ctx.save()
  ctx.strokeStyle = VESSEL_COLORS[vesselType]
  ctx.lineWidth = 2.0 * (canvasWidth / 1920)
  ctx.lineCap = 'round'

  // Each point projected once, not once per segment it touches -- an
  // interior point was previously mapProject'd twice (as proj2 of one
  // segment, proj1 of the next). Same null-skip and fade behaviour as
  // before: a point outside the view radius leaves its neighbouring
  // segment(s) unstroked and, since the increment below only runs on the
  // drawn branch, its distance excluded from cumulativeDistanceNm exactly
  // as it was pre-fix.
  const projected = visiblePoints.map((p) =>
    projectFn(p.lat, p.lon, centerLat, centerLon, radiusNm, projConfig, canvasWidth, canvasHeight),
  )

  let cumulativeDistanceNm = 0

  for (let i = 0; i < visiblePoints.length - 1; i++) {
    const proj1 = projected[i]
    const proj2 = projected[i + 1]

    if (!proj1 || !proj2) continue

    const fraction = cumulativeDistanceNm / totalDistanceNm

    ctx.globalAlpha = (0.35 + 0.45 * fraction) * opacity
    ctx.beginPath()
    ctx.moveTo(proj1.x, proj1.y)
    ctx.lineTo(proj2.x, proj2.y)
    ctx.stroke()

    cumulativeDistanceNm += distanceNm(visiblePoints[i], visiblePoints[i + 1])
  }

  ctx.restore()
}
