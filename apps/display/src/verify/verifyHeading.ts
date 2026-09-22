// Dev-only harness for VIS-1 Part C/D. Feeds synthetic vessels with known
// COGs through the REAL renderFrame/mapProject/drawGlyph (imported from
// source, never reimplemented) so glyph heading can be verified within a
// single rendered bitmap -- unaffected by cropping or uniform scaling,
// unlike Part B's two-screenshot displacement method, which failed its
// pass bar at this view's vessel density.
//
// Part D: the ring radius is sized so every glyph's own drawn silhouette,
// not just its centre point, stays on-canvas and within the projectable
// radius -- Part C sized the ring by vessel centres alone, which let the
// COG 0/180 vessels' bow tips land off-canvas at 1920x911 and read a
// false 180-degree bow angle from the visible stern taper.
//
// Never referenced by index.html/main.tsx or any file reachable from
// them, so it is excluded from the production build by Vite's default
// single-entry behaviour (verified in the VIS-1 report's dist/ listing)
// -- not wired into the real app in any way.

import {
  DEFAULT_CONFIG,
  mapProject,
  rotatePoint,
  deadReckon,
  VESSEL_BASE_SIZES,
  type DisplayConfig,
  type ProjectionConfig,
  type VesselFix,
  type VesselState,
  type VesselType,
} from '@wake/shared'
import type { ClientVesselEntry } from '../wakeSocket'
import { createTrackedVesselMap, renderFrame, type TrackedVesselMap } from '../vesselTracker'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const legendEl = document.getElementById('legend') as HTMLDivElement
const errorEl = document.getElementById('error') as HTMLDivElement

const maybeCtx = canvas.getContext('2d')
if (!maybeCtx) throw new Error('2D context unavailable')
const ctx = maybeCtx

function showError(message: string): void {
  errorEl.textContent = message
  errorEl.style.display = 'block'
  console.error('[VIS-1 harness]', message)
}

// Same view centre/radius WakeCanvas.tsx uses in production (Dover box,
// 20nm) -- duplicated here deliberately since those are component-local
// constants there, not a shared export.
const CENTER_LAT = 51.1
const CENTER_LON = 1.45
const RADIUS_NM = 20

const mirrorParam = new URLSearchParams(location.search).get('mirror')
const mirrorX = mirrorParam === '0' ? false : DEFAULT_CONFIG.mirrorX
const projConfig: ProjectionConfig = { mirrorX, rotationDeg: DEFAULT_CONFIG.rotationDeg }
// VIS-7: sweepPeriodSec off -- this harness re-renders the SAME frozen
// nowMs every animation frame (see FROZEN_NOW_MS below), so the radar
// sweep's beam angle would never advance between frames and a vessel
// would only ever reveal via the 1px-from-centre special case, never by
// a crossing. Irrelevant to what this harness verifies (heading), so
// it's switched off rather than left to silently hide every vessel.
const config: DisplayConfig = { ...DEFAULT_CONFIG, mirrorX, sweepPeriodSec: 0 }
const fileSuffix = mirrorX ? 'mirror-on' : 'mirror-off'

const FROZEN_NOW_MS = 1_726_000_000_000 // arbitrary fixed epoch, never advanced -- see renderLoop()
const COGS = [0, 45, 90, 135, 180, 225, 270, 315]
const SOG_KN = 12
const TRACK_POINTS = 60
const TRACK_LENGTH_NM = 6

interface Placement {
  cog: number
  screenX: number
  screenY: number
}

// 8 points around a circle, COG ascending clockwise from 12 o'clock --
// same "degrees clockwise from screen-up" convention screenHeadingDeg
// uses (dx = sin(theta), dy = -cos(theta)).
function computeRingPlacements(canvasWidth: number, canvasHeight: number, radiusPx: number): Placement[] {
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2
  return COGS.map((cog, k) => {
    const angleRad = (k * 45 * Math.PI) / 180
    return {
      cog,
      screenX: cx + radiusPx * Math.sin(angleRad),
      screenY: cy - radiusPx * Math.cos(angleRad),
    }
  })
}

interface RingGeometry {
  H: number // half the cargo glyph's drawn length at this canvas width
  D: number // largest on-screen distance from centre mapProject still accepts (shared/src/projection.ts, distanceNm > radiusNm -> null)
  R: number // ring radius
}

// H depends only on canvasWidth, matching drawGlyph's own actualSize
// scaling (glyphs.ts: baseSize * (canvasWidth / 1920)) -- canvasHeight
// plays no part in glyph size, only in D via the smaller-dimension rule.
function computeRingGeometry(canvasWidth: number, canvasHeight: number): RingGeometry {
  const H = (VESSEL_BASE_SIZES.cargo * canvasWidth) / 1920 / 2
  const D = Math.min(canvasWidth, canvasHeight) / 2
  const R = Math.min(D, Math.min(canvasWidth, canvasHeight) / 2 - H - 12)
  return { H, D, R }
}

// Part C sized the ring by vessel *centres* only, never accounting for
// how far the glyph's own silhouette extends past its centre point --
// the COG 0/180 vessels' bow tips landed off-canvas at 1920x911, and the
// width-profile bow measurement read the visible stern taper backwards
// (measured exactly 180 degrees wrong). These three checks make that
// unrepresentable instead of re-discoverable only after a screenshot.
function validatePlacements(
  canvasWidth: number,
  canvasHeight: number,
  placements: Placement[],
  { H, D, R }: RingGeometry,
): boolean {
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2

  const allInsideCanvas = placements.every(
    (p) =>
      p.screenX - (H + 4) >= 0 &&
      p.screenX + (H + 4) <= canvasWidth &&
      p.screenY - (H + 4) >= 0 &&
      p.screenY + (H + 4) <= canvasHeight,
  )
  const allWithinD = placements.every((p) => Math.hypot(p.screenX - cx, p.screenY - cy) <= D)
  // Adjacent chord length on a circle of radius R at 45deg spacing is
  // 2*R*sin(22.5deg) -- the actual neighbour-to-neighbour spacing on this
  // 8-point ring, not an approximation.
  const chord = 2 * R * Math.sin((22.5 * Math.PI) / 180)
  const spacingOk = chord >= 2 * H + 40

  if (!allInsideCanvas || !allWithinD || !spacingOk) {
    showError('Window too small — press F11 and reload')
    console.error('[VIS-1 harness] placement validation failed', {
      allInsideCanvas,
      allWithinD,
      spacingOk,
      chord,
      requiredSpacing: 2 * H + 40,
      H,
      D,
      R,
    })
    return false
  }
  return true
}

// Inverts mapProject: given a desired screen point, finds the lat/lon
// that projects there. Reuses the project's own rotatePoint for the
// rotation step rather than re-deriving rotation math. mapProject itself
// is called afterwards (see buildTrackedVessels) to verify the result --
// this inversion is never trusted blind.
function inverseMapProject(
  screenX: number,
  screenY: number,
  centerLat: number,
  centerLon: number,
  radiusNm: number,
  cfg: ProjectionConfig,
  canvasWidth: number,
  canvasHeight: number,
): { lat: number; lon: number } {
  const unrotated = rotatePoint(screenX, screenY, canvasWidth / 2, canvasHeight / 2, -cfg.rotationDeg)
  const x0 = cfg.mirrorX ? canvasWidth - unrotated.x : unrotated.x
  const y0 = unrotated.y

  const pxPerNm = Math.min(canvasWidth, canvasHeight) / 2 / radiusNm
  const lonOffsetNm = (x0 - canvasWidth / 2) / pxPerNm
  const latOffsetNm = (canvasHeight / 2 - y0) / pxPerNm

  return {
    lat: centerLat + latOffsetNm / 60,
    lon: centerLon + lonOffsetNm / (60 * Math.cos((centerLat * Math.PI) / 180)),
  }
}

// A straight track running 6nm back along (cog + 180) from the vessel's
// position, oldest point first, last point exactly at the vessel's
// position -- matches VesselState.track's own convention. Reuses
// deadReckon with a synthetic 1-second fix (the same trick
// screenHeadingDeg uses) so the offset math is the project's own, not
// reimplemented here: sogKn is chosen so sogKn * 1s / 3600 exactly equals
// the desired distance.
function backTrackPoint(lat: number, lon: number, cog: number, distanceBackNm: number): { lat: number; lon: number } {
  const bearing = (cog + 180) % 360
  const sogKn = distanceBackNm * 3600
  const synthetic: VesselFix = { mmsi: '', lat, lon, cogDeg: bearing, sogKn, timestamp: 0 }
  return deadReckon(synthetic, 1000, 1)
}

interface BuiltVessel extends Placement {
  lat: number
  lon: number
  mmsi: string
}

interface Built {
  tracked: TrackedVesselMap
  clientState: Map<string, ClientVesselEntry>
  geometry: RingGeometry
  valid: boolean
  vessels: BuiltVessel[]
}

function buildTrackedVessels(canvasWidth: number, canvasHeight: number): Built {
  const geometry = computeRingGeometry(canvasWidth, canvasHeight)
  const placements = computeRingPlacements(canvasWidth, canvasHeight, geometry.R)
  const tracked = createTrackedVesselMap()
  const clientState = new Map<string, ClientVesselEntry>()
  const vessels: BuiltVessel[] = []

  if (!validatePlacements(canvasWidth, canvasHeight, placements, geometry)) {
    return { tracked, clientState, geometry, valid: false, vessels }
  }

  placements.forEach((p, index) => {
    const mmsi = `900000${String(index).padStart(3, '0')}`
    const { lat, lon } = inverseMapProject(p.screenX, p.screenY, CENTER_LAT, CENTER_LON, RADIUS_NM, projConfig, canvasWidth, canvasHeight)

    // Required self-check: the real mapProject, called from source, must
    // land back on the intended screen centre within 1px.
    const check = mapProject(lat, lon, CENTER_LAT, CENTER_LON, RADIUS_NM, projConfig, canvasWidth, canvasHeight)
    if (!check || Math.hypot(check.x - p.screenX, check.y - p.screenY) > 1) {
      showError(
        `Vessel ${index} (COG ${p.cog}): mapProject round-trip failed. ` +
          `intended=(${p.screenX.toFixed(2)},${p.screenY.toFixed(2)}) ` +
          `got=${check ? `(${check.x.toFixed(2)},${check.y.toFixed(2)})` : 'null'}`,
      )
    }

    const lastFix: VesselFix = { mmsi, lat, lon, cogDeg: p.cog, sogKn: SOG_KN, timestamp: FROZEN_NOW_MS }
    const track = Array.from({ length: TRACK_POINTS }, (_, i) => {
      const frac = i / (TRACK_POINTS - 1)
      const distanceBackNm = TRACK_LENGTH_NM * (1 - frac)
      const pt = backTrackPoint(lat, lon, p.cog, distanceBackNm)
      return { lat: pt.lat, lon: pt.lon, timestamp: FROZEN_NOW_MS }
    })

    const state: VesselState = { mmsi, lastFix, displayLat: lat, displayLon: lon, track }
    tracked.set(mmsi, state)
    clientState.set(mmsi, { vesselType: 'cargo' satisfies VesselType })
    vessels.push({ ...p, lat, lon, mmsi })
  })

  return { tracked, clientState, geometry, valid: true, vessels }
}

function resizeCanvas(): void {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
}

function updateLegend(built: Built): void {
  const { H, D, R } = built.geometry
  errorEl.style.display = built.valid ? 'none' : 'block'
  legendEl.textContent =
    `mirrorX=${mirrorX} rotationDeg=${projConfig.rotationDeg} H=${H.toFixed(1)} D=${D.toFixed(1)} R=${R.toFixed(1)} ` +
    `-- Press S to save PNG`
}

function logPlacements(built: Built): void {
  console.log('[VIS-1 harness] valid:', built.valid, 'geometry:', built.geometry)
  for (const v of built.vessels) {
    console.log(
      `[VIS-1 harness] mmsi=${v.mmsi} cog=${v.cog} screen=(${v.screenX.toFixed(1)},${v.screenY.toFixed(1)}) ` +
        `lat=${v.lat.toFixed(6)} lon=${v.lon.toFixed(6)}`,
    )
  }
}

resizeCanvas()
let built = buildTrackedVessels(canvas.width, canvas.height)
updateLegend(built)
logPlacements(built)

window.addEventListener('resize', () => {
  resizeCanvas()
  // Re-derive geometry and vessel lat/lon for the new canvas size -- H, D
  // and R all depend on canvasWidth/canvasHeight directly, so keeping the
  // old placements could leave vessels outside the new canvas or radius.
  built = buildTrackedVessels(canvas.width, canvas.height)
  updateLegend(built)
  logPlacements(built)
})

function paintBlack(): void {
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

function renderLoop(): void {
  paintBlack()
  renderFrame(built.tracked, built.clientState, ctx, {
    centerLat: CENTER_LAT,
    centerLon: CENTER_LON,
    radiusNm: RADIUS_NM,
    projConfig,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    // Frozen -- every lastFix.timestamp equals this constant, so ageSec is
    // always 0 on every call: deadReckon's target equals the current fix
    // exactly (no easing drift regardless of deltaMs), vesselOpacity never
    // passes staleSec, and isExpired never passes removeSec. Re-rendering
    // this same instant every animation frame is what lets a window
    // resize redraw without anything moving or fading (see C1b).
    nowMs: FROZEN_NOW_MS,
    deltaMs: 16,
    config,
    areaDisplayName: 'DOVER STRAIT',
  })
  requestAnimationFrame(renderLoop)
}

requestAnimationFrame(renderLoop)

window.addEventListener('keydown', (event) => {
  if (event.key !== 's' && event.key !== 'S') return
  const dataUrl = canvas.toDataURL('image/png')
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = `vis1-harness-${fileSuffix}.png`
  document.body.appendChild(link)
  link.click()
  link.remove()
})
