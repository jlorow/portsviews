import { basemapZoom } from './basemap.ts'
import { mapProject } from './projection.ts'
import {
  PAN_FRACTION,
  RADIUS_STEPS_NM,
  WHEEL_STEP_MIN_INTERVAL_MS,
  clampPanToFeed,
  panCenter,
  panKeyAction,
  radiusStepsFor,
  stepRadius,
  wheelZoomAction,
  zoomKeyAction,
  type ZoomKeyEvent,
} from './zoom.ts'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    console.log(`[Pass] ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}`)
  }
}

function keyEvent(key: string, overrides: Partial<ZoomKeyEvent> = {}): ZoomKeyEvent {
  return {
    key,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    targetIsEditable: false,
    ...overrides,
  }
}

// --- radius steps ---------------------------------------------------------

assert(
  JSON.stringify(RADIUS_STEPS_NM) === JSON.stringify([1, 2, 5, 10, 20, 40, 80]),
  `RADIUS_STEPS_NM is [1,2,5,10,20,40,80] (got ${JSON.stringify(RADIUS_STEPS_NM)})`,
)
assert(
  JSON.stringify(radiusStepsFor(20)) === JSON.stringify([1, 2, 5, 10, 20]),
  `radiusStepsFor(20) = [1,2,5,10,20] (got ${JSON.stringify(radiusStepsFor(20))})`,
)
assert(
  JSON.stringify(radiusStepsFor(25)) === JSON.stringify([1, 2, 5, 10, 20, 25]),
  `radiusStepsFor(25) includes the unlisted default in order (got ${JSON.stringify(radiusStepsFor(25))})`,
)
assert(
  JSON.stringify(radiusStepsFor(80)) === JSON.stringify([1, 2, 5, 10, 20, 40, 80]),
  `radiusStepsFor(80) is the whole list (got ${JSON.stringify(radiusStepsFor(80))})`,
)
assert(
  !radiusStepsFor(40).includes(80),
  'radiusStepsFor(40): steps above the default stay excluded (the feed box only covers the default area)',
)

const allSteps = radiusStepsFor(80)
assert(stepRadius(allSteps, 1, 'in') === 1, 'stepRadius: zoom-in at the smallest step is a no-op')
assert(stepRadius(allSteps, 80, 'out') === 80, 'stepRadius: zoom-out at the largest step is a no-op')
assert(stepRadius(allSteps, 20, 'in') === 10, 'stepRadius: zoom-in selects the next smaller radius')
assert(stepRadius(allSteps, 20, 'out') === 40, 'stepRadius: zoom-out selects the next larger radius')
assert(stepRadius(allSteps, 8, 'in') === 10, 'stepRadius: an unlisted radius snaps to the nearest step')
assert(stepRadius(allSteps, 1, 'out') === 2, 'stepRadius: one step up from 1 nm is 2 nm')

// --- basemapZoom at the new close radii ----------------------------------

// Hardcoded expected values, never read back from basemapZoom itself.
const doverZoom2 = basemapZoom(1920, 1080, 51.1, 2)
const doverZoom1 = basemapZoom(1920, 1080, 51.1, 1)
const sydneyZoom2 = basemapZoom(1920, 1080, -33.93, 2)
const sydneyZoom1 = basemapZoom(1920, 1080, -33.93, 1)
assert(Math.abs(doverZoom2 - 12.8043) < 0.001, `basemapZoom dover 2nm: ${doverZoom2.toFixed(4)}`)
assert(Math.abs(doverZoom1 - 13.8043) < 0.001, `basemapZoom dover 1nm: ${doverZoom1.toFixed(4)}`)
assert(Math.abs(sydneyZoom2 - 13.2067) < 0.001, `basemapZoom sydney 2nm: ${sydneyZoom2.toFixed(4)}`)
assert(Math.abs(sydneyZoom1 - 14.2067) < 0.001, `basemapZoom sydney 1nm: ${sydneyZoom1.toFixed(4)}`)

// --- panCenter round trip -------------------------------------------------

// Every pan direction, both mirror states, rotation off and on. The claim
// under test: after panning, the OLD centre projects to a fixed distance
// from the canvas centre in the OPPOSITE screen direction -- exactly
// PAN_FRACTION x min(width, height) / 2 pixels, which is PAN_FRACTION x
// radiusNm on screen. "up" puts it BELOW the canvas centre (screen y grows
// downward). Recomputed through the real mapProject, not from panCenter.
function assertRoundTrip(mirrorX: boolean, rotationDeg: number, direction: 'up' | 'down' | 'left' | 'right'): void {
  const canvasWidth = 1920
  const canvasHeight = 1080
  const radiusNm = 20
  const oldLat = 51.1
  const oldLon = 1.45
  const expectedPx = PAN_FRACTION * (Math.min(canvasWidth, canvasHeight) / 2)
  const config = { mirrorX, rotationDeg }

  const panned = panCenter(oldLat, oldLon, direction, radiusNm, config)
  const projected = mapProject(
    oldLat,
    oldLon,
    panned.centerLat,
    panned.centerLon,
    radiusNm,
    config,
    canvasWidth,
    canvasHeight,
  )

  const expectedX =
    canvasWidth / 2 + (direction === 'right' ? -expectedPx : direction === 'left' ? expectedPx : 0)
  const expectedY =
    canvasHeight / 2 + (direction === 'up' ? expectedPx : direction === 'down' ? -expectedPx : 0)

  if (projected === null) {
    assert(false, `panCenter ${direction} mirror=${mirrorX} rot=${rotationDeg}: old centre projected to null`)
    return
  }
  const dx = Math.abs(projected.x - expectedX)
  const dy = Math.abs(projected.y - expectedY)
  assert(
    dx < 1e-6 && dy < 1e-6,
    `panCenter ${direction} mirror=${mirrorX} rot=${rotationDeg}: old centre at (${projected.x.toFixed(4)}, ${projected.y.toFixed(4)}), expected (${expectedX.toFixed(4)}, ${expectedY.toFixed(4)})`,
  )
}

for (const mirrorX of [false, true]) {
  for (const rotationDeg of [0, 30]) {
    for (const direction of ['right', 'left', 'up', 'down'] as const) {
      assertRoundTrip(mirrorX, rotationDeg, direction)
    }
  }
}

// The distance itself, stated as the signed pixel offset rather than a
// distance, so a pan that moved the view the wrong way cannot pass by
// symmetry.
{
  const canvasWidth = 1920
  const canvasHeight = 1080
  const radiusNm = 20
  const config = { mirrorX: true, rotationDeg: 0 }
  const panned = panCenter(51.1, 1.45, 'right', radiusNm, config)
  const projected = mapProject(51.1, 1.45, panned.centerLat, panned.centerLon, radiusNm, config, canvasWidth, canvasHeight)
  const expectedOffsetPx = -PAN_FRACTION * (canvasHeight / 2)
  assert(
    projected !== null && Math.abs(projected.x - (canvasWidth / 2 + expectedOffsetPx)) < 1e-6,
    `panCenter right is a SIGNED move: old centre x - canvas centre = ${projected === null ? 'null' : (projected.x - canvasWidth / 2).toFixed(4)} px, expected ${expectedOffsetPx.toFixed(4)}`,
  )
}

// Zoom changes how far a pan is, proportionally: at 5 nm the same key moves
// a quarter of the pixels 20 nm does.
{
  const config = { mirrorX: false, rotationDeg: 0 }
  const at20 = panCenter(51.1, 1.45, 'right', 20, config)
  const at5 = panCenter(51.1, 1.45, 'right', 5, config)
  const move20 = (at20.centerLon - 1.45) * 60 * Math.cos((51.1 * Math.PI) / 180)
  const move5 = (at5.centerLon - 1.45) * 60 * Math.cos((51.1 * Math.PI) / 180)
  assert(
    Math.abs(move20 - PAN_FRACTION * 20) < 1e-9 && Math.abs(move5 - PAN_FRACTION * 5) < 1e-9,
    `panCenter moves PAN_FRACTION x radiusNm of ground: ${move20.toFixed(4)} nm at 20nm, ${move5.toFixed(4)} nm at 5nm`,
  )
}

// --- clampPanToFeed -------------------------------------------------------

// Reimplemented here from the raw box corners, never from clampPanToFeed.
function expectClampedAxis(panDelta: number, halfExtentNm: number, radiusNm: number): number {
  const limit = Math.max(0, halfExtentNm - radiusNm)
  if (limit <= 0) return 0
  return Math.max(-limit, Math.min(limit, panDelta))
}

const DOVER_FEED_BOX: number[][][] = [[[51.4, 0.9], [50.8, 2.0]]]
const doverCentreLat = (51.4 + 50.8) / 2
const doverCentreLon = (0.9 + 2.0) / 2
const doverHalfHeightNm = ((51.4 - 50.8) / 2) * 60 // 18 nm
const doverHalfWidthNm = ((2.0 - 0.9) / 2) * 60 * Math.cos((doverCentreLat * Math.PI) / 180) // ~20.72 nm

for (const radiusNm of [20, 10, 1]) {
  const panLat = 5
  const panLon = 5
  const clamped = clampPanToFeed(doverCentreLat + panLat, doverCentreLon + panLon, radiusNm, DOVER_FEED_BOX)
  const expectedLat = doverCentreLat + expectClampedAxis(panLat, doverHalfHeightNm, radiusNm)
  const expectedLon = doverCentreLon + expectClampedAxis(panLon, doverHalfWidthNm, radiusNm)
  assert(
    Math.abs(clamped.centerLat - expectedLat) < 1e-12 && Math.abs(clamped.centerLon - expectedLon) < 1e-12,
    `clampPanToFeed dover ${radiusNm}nm: ${clamped.centerLat.toFixed(6)}, ${clamped.centerLon.toFixed(6)} (expected ${expectedLat.toFixed(6)}, ${expectedLon.toFixed(6)}; lat room ${Math.max(0, doverHalfHeightNm - radiusNm).toFixed(4)} nm, lon room ${Math.max(0, doverHalfWidthNm - radiusNm).toFixed(4)} nm)`,
  )
}

// The dover box's LATITUDE has no room at all at the default 20 nm view
// (half-height 18 nm < 20 nm), so that axis is pinned to the box centre
// whatever the pan is. Its LONGITUDE does have 0.72 nm of room, because the
// box is 1.1 degrees of longitude wide, which is 41.44 nm at 51.1 N.
{
  const clamped = clampPanToFeed(doverCentreLat + 5, doverCentreLon + 5, 20, DOVER_FEED_BOX)
  const lonRoom = doverHalfWidthNm - 20
  assert(
    Math.abs(clamped.centerLat - doverCentreLat) < 1e-12,
    `clampPanToFeed dover 20nm: the latitude axis has no room and stays at the box centre (${clamped.centerLat.toFixed(6)})`,
  )
  assert(
    Math.abs(lonRoom - 0.72) < 0.05,
    `clampPanToFeed dover 20nm: the longitude allowance is about 0.72 nm (got ${lonRoom.toFixed(4)} nm, from a ${(doverHalfWidthNm * 2).toFixed(2)} nm wide box)`,
  )
  assert(
    Math.abs(clamped.centerLon - doverCentreLon - lonRoom) < 1e-12,
    `clampPanToFeed dover 20nm: longitude is clamped to that allowance (${(clamped.centerLon - doverCentreLon).toFixed(6)} deg)`,
  )
}

// A pan SMALLER than the allowance is left completely alone.
{
  const clamped = clampPanToFeed(doverCentreLat, doverCentreLon + 0.1, 20, DOVER_FEED_BOX)
  assert(
    Math.abs(clamped.centerLon - (doverCentreLon + 0.1)) < 1e-12,
    'clampPanToFeed: a pan inside the allowance is not moved at all',
  )
}

// The sydney box, a NEGATIVE-latitude box: half-height 20.04 nm, half-width
// 20.02 nm, so at 20 nm there is almost no room in either axis and at 1 nm
// there is nearly the whole box.
{
  const sydneyBox: number[][][] = [[[-33.596, 150.818], [-34.264, 151.622]]]
  const sydneyCentreLat = (-33.596 + -34.264) / 2
  const sydneyCentreLon = (150.818 + 151.622) / 2
  const sydneyHalfHeightNm = ((Math.abs(-33.596 - -34.264)) / 2) * 60
  const sydneyHalfWidthNm = ((Math.abs(151.622 - 150.818)) / 2) * 60 * Math.cos((sydneyCentreLat * Math.PI) / 180)

  for (const radiusNm of [20, 10, 1]) {
    const clamped = clampPanToFeed(sydneyCentreLat - 5, sydneyCentreLon + 5, radiusNm, sydneyBox)
    const expectedLat = sydneyCentreLat + expectClampedAxis(-5, sydneyHalfHeightNm, radiusNm)
    const expectedLon = sydneyCentreLon + expectClampedAxis(5, sydneyHalfWidthNm, radiusNm)
    assert(
      Math.abs(clamped.centerLat - expectedLat) < 1e-12 && Math.abs(clamped.centerLon - expectedLon) < 1e-12,
      `clampPanToFeed sydney ${radiusNm}nm: ${clamped.centerLat.toFixed(6)}, ${clamped.centerLon.toFixed(6)} (expected ${expectedLat.toFixed(6)}, ${expectedLon.toFixed(6)})`,
    )
  }

  const at1 = clampPanToFeed(sydneyCentreLat - 5, sydneyCentreLon + 5, 1, sydneyBox)
  assert(
    Math.abs(at1.centerLat - (sydneyCentreLat - 5)) < 1e-12 && Math.abs(at1.centerLon - (sydneyCentreLon + 5)) < 1e-12,
    'clampPanToFeed sydney 1nm: a 5 nm pan is inside the box and is not clamped',
  )
}

// --- panKeyAction ---------------------------------------------------------

assert(panKeyAction({ key: 'ArrowUp', ctrlKey: false, metaKey: false, altKey: false, targetIsEditable: false }) === 'up', 'panKeyAction: ArrowUp -> up')
assert(panKeyAction({ key: 'ArrowDown', ctrlKey: false, metaKey: false, altKey: false, targetIsEditable: false }) === 'down', 'panKeyAction: ArrowDown -> down')
assert(panKeyAction({ key: 'ArrowLeft', ctrlKey: false, metaKey: false, altKey: false, targetIsEditable: false }) === 'left', 'panKeyAction: ArrowLeft -> left')
assert(panKeyAction({ key: 'ArrowRight', ctrlKey: false, metaKey: false, altKey: false, targetIsEditable: false }) === 'right', 'panKeyAction: ArrowRight -> right')
assert(
  panKeyAction({ key: 'ArrowUp', repeat: true, ctrlKey: false, metaKey: false, altKey: false, targetIsEditable: false }) === 'up',
  'panKeyAction: key repeat IS allowed -- holding an arrow keeps panning',
)
assert(panKeyAction({ key: 'ArrowUp', ctrlKey: true, metaKey: false, altKey: false, targetIsEditable: false }) === null, 'panKeyAction: ctrlKey -> null')
assert(panKeyAction({ key: 'ArrowUp', ctrlKey: false, metaKey: true, altKey: false, targetIsEditable: false }) === null, 'panKeyAction: metaKey -> null')
assert(panKeyAction({ key: 'ArrowUp', ctrlKey: false, metaKey: false, altKey: true, targetIsEditable: false }) === null, 'panKeyAction: altKey -> null')
assert(panKeyAction({ key: 'ArrowUp', ctrlKey: false, metaKey: false, altKey: false, targetIsEditable: true }) === null, 'panKeyAction: editable target -> null')
assert(panKeyAction({ key: 'a', ctrlKey: false, metaKey: false, altKey: false, targetIsEditable: false }) === null, 'panKeyAction: a non-arrow key -> null')
assert(panKeyAction({ key: 'ArrowUp', repeat: true, ctrlKey: true, metaKey: false, altKey: false, targetIsEditable: false }) === null, 'panKeyAction: a repeated Ctrl+Arrow is still the browser\'s')

// --- wheelZoomAction ------------------------------------------------------

const noModifiers = { ctrlKey: false, metaKey: false, altKey: false }
const wheelIn = wheelZoomAction({ deltaY: -5, ...noModifiers }, 10000, 0)
assert(wheelIn !== null && wheelIn.action === 'in', 'wheelZoomAction: deltaY below 0 is a zoom in')
const wheelOut = wheelZoomAction({ deltaY: 5, ...noModifiers }, 10000, 0)
assert(wheelOut !== null && wheelOut.action === 'out', 'wheelZoomAction: deltaY above 0 is a zoom out')
assert(wheelIn !== null && wheelIn.stepAtMs === 10000, `wheelZoomAction: returns the step time (got ${wheelIn === null ? 'null' : wheelIn.stepAtMs})`)
assert(wheelZoomAction({ deltaY: 0.5, ...noModifiers }, 10000, 0) === null, 'wheelZoomAction: |deltaY| below 1 is null')
assert(wheelZoomAction({ deltaY: -0.5, ...noModifiers }, 10000, 0) === null, 'wheelZoomAction: a negative sub-1 delta is null too')
assert(wheelZoomAction({ deltaY: -1, ...noModifiers }, 10000, 0) !== null, 'wheelZoomAction: exactly -1 is a real step')

// The throttle. A step taken 299 ms ago is refused; one taken exactly 300 ms
// ago is allowed; a step with no previous one at all is allowed.
assert(wheelZoomAction({ deltaY: -5, ...noModifiers }, 10000, 9701) === null, 'wheelZoomAction: 299ms after the last step -> null')
assert(
  wheelZoomAction({ deltaY: -5, ...noModifiers }, 10000, 9700) !== null,
  `wheelZoomAction: exactly ${WHEEL_STEP_MIN_INTERVAL_MS}ms after the last step is allowed`,
)
// The boundary itself is inclusive of the interval and exclusive below it,
// so nowMs === lastStepMs is refused. The display starts its ref at 0 and
// feeds it a real clock, where the difference is the whole session.
assert(wheelZoomAction({ deltaY: -5, ...noModifiers }, 0, 0) === null, 'wheelZoomAction: nowMs === lastStepMs is inside the window -> null')
assert(wheelZoomAction({ deltaY: -5, ...noModifiers }, 1_700_000_000_000, 0) !== null, 'wheelZoomAction: the first step of a real session (ref still 0) is allowed')
// "stepAtMs unchanged" means the CALLER's ref is untouched: a refused wheel
// returns null and carries no new time to store.
{
  let lastStepMs = 9701
  const refused = wheelZoomAction({ deltaY: -5, ...noModifiers }, 10000, lastStepMs)
  if (refused !== null) lastStepMs = refused.stepAtMs
  assert(refused === null && lastStepMs === 9701, `wheelZoomAction: a refused step leaves the caller's lastStepMs at ${lastStepMs}`)
}
assert(wheelZoomAction({ deltaY: -5, ctrlKey: true, metaKey: false, altKey: false }, 10000, 0) === null, 'wheelZoomAction: ctrlKey -> null (browser pinch-zoom)')
assert(wheelZoomAction({ deltaY: -5, ctrlKey: false, metaKey: true, altKey: false }, 10000, 0) === null, 'wheelZoomAction: metaKey -> null')
assert(wheelZoomAction({ deltaY: -5, ctrlKey: false, metaKey: false, altKey: true }, 10000, 0) === null, 'wheelZoomAction: altKey -> null')

// --- zoomKeyAction is unchanged ------------------------------------------

assert(zoomKeyAction(keyEvent('=')) === 'in', "zoomKeyAction: '=' still zooms in")
assert(zoomKeyAction(keyEvent('+')) === 'in', "zoomKeyAction: '+' still zooms in")
assert(zoomKeyAction(keyEvent('-')) === 'out', "zoomKeyAction: '-' still zooms out")
assert(zoomKeyAction(keyEvent('_')) === 'out', "zoomKeyAction: '_' still zooms out")
assert(zoomKeyAction(keyEvent('0')) === 'reset', "zoomKeyAction: '0' is still reset (which now resets zoom AND pan)")
assert(zoomKeyAction(keyEvent('=' , { repeat: true })) === null, 'zoomKeyAction: auto-repeat still ignored')
assert(zoomKeyAction(keyEvent('=', { ctrlKey: true })) === null, 'zoomKeyAction: Ctrl shortcuts still ignored')
assert(zoomKeyAction(keyEvent('=', { metaKey: true })) === null, 'zoomKeyAction: Cmd shortcuts still ignored')
assert(zoomKeyAction(keyEvent('=', { altKey: true })) === null, 'zoomKeyAction: Alt shortcuts still ignored')
assert(zoomKeyAction(keyEvent('=', { targetIsEditable: true })) === null, 'zoomKeyAction: editable targets still ignored')
assert(zoomKeyAction(keyEvent('ArrowUp')) === null, 'zoomKeyAction: arrows are panKeyAction\'s business, not this one\'s')

// --- unproject round-trip -----------------------------------------------
// unproject(project(p)) must recover the original lat/lon within 1e-6 deg.

import { mapProjectUnclipped } from './projection.ts'
import {
  applyDrag,
  applyWheelAtPointer,
  dragPanView,
  handlePanKeydown,
  panKeyMultiplier,
  unproject,
  zoomAtPoint,
  type PointerView,
} from './zoom.ts'

const DOVER_BOX: number[][][] = [[[51.4, 0.9], [50.8, 2.0]]]
const SYDNEY_BOX: number[][][] = [[[-33.596, 150.818], [-34.264, 151.622]]]

for (const mirrorX of [false, true]) {
  for (const rotationDeg of [0, 30]) {
    for (const radiusNm of [1, 5, 20]) {
      for (const [lat, lon, label] of [[51.1, 1.45, 'dover'], [-33.93, 151.22, 'sydney']] as [number, number, string][]) {
        const config = { mirrorX, rotationDeg }
        const w = 1920, h = 1080
        const projected = mapProjectUnclipped(lat, lon, lat, lon, radiusNm, config, w, h)
        const recovered = unproject(projected.x, projected.y, lat, lon, radiusNm, config, w, h)
        assert(
          Math.abs(recovered.lat - lat) < 1e-6 && Math.abs(recovered.lon - lon) < 1e-6,
          `unproject round-trip ${label} r=${radiusNm} mirror=${mirrorX} rot=${rotationDeg}: lat err=${Math.abs(recovered.lat - lat).toExponential(2)} lon err=${Math.abs(recovered.lon - lon).toExponential(2)}`,
        )
      }
    }
  }
}

// --- zoomAtPoint anchor invariance ---------------------------------------
// The point under the pointer must project within 0.5 px of the pointer
// after the zoom (before clamping), for both zoom directions, both mirrors.

const POINTER_POSITIONS = [
  [960, 540],   // centre
  [200, 200],   // top-left
  [1700, 900],  // bottom-right
  [960, 100],   // top-centre
  [100, 540],   // left-centre
] as [number, number][]

for (const mirrorX of [false, true]) {
  const config = { mirrorX, rotationDeg: 0 }
  const w = 1920, h = 1080
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 20 }
  for (const [px, py] of POINTER_POSITIONS) {
    for (const newRadius of [10, 40]) {
      const zoomed = zoomAtPoint(view, newRadius, px, py, config, w, h)
      const reprojected = mapProjectUnclipped(zoomed.centerLat, zoomed.centerLon, zoomed.centerLat, zoomed.centerLon, newRadius, config, w, h)
      // The anchor geographic point under (px,py) in the old view:
      const anchor = unproject(px, py, view.centerLat, view.centerLon, view.radiusNm, config, w, h)
      const afterPx = mapProjectUnclipped(anchor.lat, anchor.lon, zoomed.centerLat, zoomed.centerLon, newRadius, config, w, h)
      const dist = Math.hypot(afterPx.x - px, afterPx.y - py)
      assert(
        dist < 0.5,
        `zoomAtPoint anchor invariance mirror=${mirrorX} ptr=(${px},${py}) r=${view.radiusNm}->${newRadius}: dist=${dist.toFixed(4)}px`,
      )
    }
  }
}

// --- dragPanView anchor invariance ---------------------------------------
// The point under fromX,fromY must project within 0.5 px of toX,toY after.

{
  const config = { mirrorX: false, rotationDeg: 0 }
  const w = 1920, h = 1080
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 20 }
  const from = { x: 400, y: 300 }
  const to = { x: 500, y: 400 }
  const dragged = dragPanView(view, from.x, from.y, to.x, to.y, config, w, h)
  const anchor = unproject(from.x, from.y, view.centerLat, view.centerLon, view.radiusNm, config, w, h)
  const afterPx = mapProjectUnclipped(anchor.lat, anchor.lon, dragged.centerLat, dragged.centerLon, dragged.radiusNm, config, w, h)
  const dist = Math.hypot(afterPx.x - to.x, afterPx.y - to.y)
  assert(dist < 0.5, `dragPanView anchor invariance: dist=${dist.toFixed(4)}px`)
}

// Dragging right by 100 px: the point under the start pixel is under the end pixel.
{
  const config = { mirrorX: true, rotationDeg: 0 }
  const w = 1920, h = 1080
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 20 }
  const from = { x: 800, y: 540 }
  const to = { x: 900, y: 540 }
  const dragged = dragPanView(view, from.x, from.y, to.x, to.y, config, w, h)
  const anchor = unproject(from.x, from.y, view.centerLat, view.centerLon, view.radiusNm, config, w, h)
  const afterPx = mapProjectUnclipped(anchor.lat, anchor.lon, dragged.centerLat, dragged.centerLon, dragged.radiusNm, config, w, h)
  const dist = Math.hypot(afterPx.x - to.x, afterPx.y - to.y)
  assert(dist < 0.5, `dragPanView right 100px mirror=true: dist=${dist.toFixed(4)}px`)
}

// --- panKeyMultiplier ----------------------------------------------------

assert(panKeyMultiplier({ shiftKey: true }) === 5, 'panKeyMultiplier: shiftKey=true -> 5')
assert(panKeyMultiplier({ shiftKey: false }) === 1, 'panKeyMultiplier: shiftKey=false -> 1')

// --- handlePanKeydown -----------------------------------------------------

// Shift+arrow moves exactly 5x as far as plain arrow (unclamped, tolerance 1e-9 deg).
for (const { box, lat, lon, label } of [
  { box: DOVER_BOX, lat: 51.1, lon: 1.45, label: 'dover' },
  { box: SYDNEY_BOX, lat: -33.93, lon: 151.22, label: 'sydney' },
] as { box: number[][][]; lat: number; lon: number; label: string }[]) {
  for (const mirrorX of [false, true]) {
    const config = { mirrorX, rotationDeg: 0 }
    const view: PointerView = { centerLat: lat, centerLon: lon, radiusNm: 5 }
    for (const direction of ['up', 'down', 'left', 'right'] as const) {
      const noShift = handlePanKeydown(
        view,
        { key: `Arrow${direction.charAt(0).toUpperCase() + direction.slice(1)}`, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, targetIsEditable: false },
        box,
        config,
      )
      const withShift = handlePanKeydown(
        view,
        { key: `Arrow${direction.charAt(0).toUpperCase() + direction.slice(1)}`, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, targetIsEditable: false },
        box,
        config,
      )
      const dLatNo = Math.abs(noShift.view.centerLat - lat)
      const dLonNo = Math.abs(noShift.view.centerLon - lon)
      const dLatShift = Math.abs(withShift.view.centerLat - lat)
      const dLonShift = Math.abs(withShift.view.centerLon - lon)
      // Avoid division by zero: up/down change lat, left/right change lon.
      if (direction === 'up' || direction === 'down') {
        assert(
          Math.abs(dLatShift - 5 * dLatNo) < 1e-9,
          `handlePanKeydown ${label} ${direction} mirror=${mirrorX}: shift moves 5x in lat (delta=${(dLatShift - 5 * dLatNo).toExponential(2)})`,
        )
      } else {
        assert(
          Math.abs(dLonShift - 5 * dLonNo) < 1e-9,
          `handlePanKeydown ${label} ${direction} mirror=${mirrorX}: shift moves 5x in lon (delta=${(dLonShift - 5 * dLonNo).toExponential(2)})`,
        )
      }
    }
  }
}

// A shifted press near the feed box edge ends clamped inside the box.
{
  const view: PointerView = { centerLat: -33.929333, centerLon: 151.22, radiusNm: 20 }
  const result = handlePanKeydown(
    view,
    { key: 'ArrowUp', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, targetIsEditable: false },
    SYDNEY_BOX,
    { mirrorX: false, rotationDeg: 0 },
  )
  const clamped = clampPanToFeed(result.view.centerLat, result.view.centerLon, result.view.radiusNm, SYDNEY_BOX)
  assert(
    Math.abs(clamped.centerLat - result.view.centerLat) < 1e-9 && Math.abs(clamped.centerLon - result.view.centerLon) < 1e-9,
    'handlePanKeydown: shifted arrow near box edge is clamped inside the feed box',
  )
}

// ctrl, alt or meta with shift: not handled.
for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 5 }
  const e = { key: 'ArrowRight', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, targetIsEditable: false }
  const r = handlePanKeydown(view, { ...e, [mod]: true }, DOVER_BOX, { mirrorX: false, rotationDeg: 0 })
  assert(r.handled === false, `handlePanKeydown: ${mod} with shift is not handled`)
}

// targetIsEditable with shift: not handled.
{
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 5 }
  const r = handlePanKeydown(
    view,
    { key: 'ArrowRight', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, targetIsEditable: true },
    DOVER_BOX,
    { mirrorX: false, rotationDeg: 0 },
  )
  assert(r.handled === false, 'handlePanKeydown: targetIsEditable with shift is not handled')
}

// Unrelated keys: not handled.
{
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 5 }
  const r = handlePanKeydown(
    view,
    { key: 'a', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, targetIsEditable: false },
    DOVER_BOX,
    { mirrorX: false, rotationDeg: 0 },
  )
  assert(r.handled === false, 'handlePanKeydown: unrelated key with shift is not handled')
}

// Holding (repeat true) is handled.
{
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 5 }
  const r = handlePanKeydown(
    view,
    { key: 'ArrowRight', repeat: true, ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, targetIsEditable: false },
    DOVER_BOX,
    { mirrorX: false, rotationDeg: 0 },
  )
  assert(r.handled === true, 'handlePanKeydown: repeat with shift is handled')
}

// Object built exactly the way the DOM listener builds it.
{
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 5 }
  const r = handlePanKeydown(
    view,
    {
      key: 'ArrowRight',
      repeat: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      targetIsEditable: false,
    },
    DOVER_BOX,
    { mirrorX: false, rotationDeg: 0 },
  )
  assert(r.handled === true, 'handlePanKeydown: DOM-shaped object with shift is handled')
  assert(r.view.centerLon > view.centerLon, 'handlePanKeydown: DOM-shaped object actually pans right')
}

// --- applyWheelAtPointer -------------------------------------------------

const noMod = { ctrlKey: false, metaKey: false, altKey: false }
const steps20 = radiusStepsFor(20)
const steps20s = radiusStepsFor(20) // sydney same default

// Throttle: a second wheel event within 300ms is ignored.
{
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 20 }
  const r1 = applyWheelAtPointer(view, { deltaY: -5, ...noMod }, 10000, 9800, steps20, DOVER_BOX, { mirrorX: false, rotationDeg: 0 }, 1920, 1080, 960, 540)
  assert(r1.view === view && r1.lastStepMs === 9800, 'applyWheelAtPointer: throttle within 300ms returns unchanged view')
}

// ctrl/meta/alt ignored.
{
  const view: PointerView = { centerLat: 51.1, centerLon: 1.45, radiusNm: 20 }
  const rc = applyWheelAtPointer(view, { deltaY: -5, ctrlKey: true, metaKey: false, altKey: false }, 10000, 0, steps20, DOVER_BOX, { mirrorX: false, rotationDeg: 0 }, 1920, 1080, 960, 540)
  assert(rc.view === view, 'applyWheelAtPointer: ctrlKey ignored')
  const rm = applyWheelAtPointer(view, { deltaY: -5, ctrlKey: false, metaKey: true, altKey: false }, 10000, 0, steps20, DOVER_BOX, { mirrorX: false, rotationDeg: 0 }, 1920, 1080, 960, 540)
  assert(rm.view === view, 'applyWheelAtPointer: metaKey ignored')
  const ra = applyWheelAtPointer(view, { deltaY: -5, ctrlKey: false, metaKey: false, altKey: true }, 10000, 0, steps20, DOVER_BOX, { mirrorX: false, rotationDeg: 0 }, 1920, 1080, 960, 540)
  assert(ra.view === view, 'applyWheelAtPointer: altKey ignored')
}

// Centre stays inside feed box after zoom at pointer, for dover and sydney at 1, 5, 20 nm.
for (const [box, view, label] of [
  [DOVER_BOX, { centerLat: 51.1, centerLon: 1.45, radiusNm: 20 }, 'dover'],
  [SYDNEY_BOX, { centerLat: -33.93, centerLon: 151.22, radiusNm: 20 }, 'sydney'],
] as [number[][][], PointerView, string][]) {
  for (const startRadius of [1, 5, 20]) {
    const v: PointerView = { ...view, radiusNm: startRadius }
    const stepsForBox = radiusStepsFor(20)
    const result = applyWheelAtPointer(v, { deltaY: -5, ...noMod }, 10000, 0, stepsForBox, box, { mirrorX: false, rotationDeg: 0 }, 1920, 1080, 960, 540)
    const clamped = clampPanToFeed(result.view.centerLat, result.view.centerLon, result.view.radiusNm, box)
    assert(
      Math.abs(clamped.centerLat - result.view.centerLat) < 1e-9 && Math.abs(clamped.centerLon - result.view.centerLon) < 1e-9,
      `applyWheelAtPointer centre inside feed box: ${label} r=${startRadius}`,
    )
  }
}

// --- old panCenter tests still pass (fraction parameter is optional) -----
// The existing assertRoundTrip calls above already cover this; one extra
// explicit check that the default fraction equals PAN_FRACTION.
{
  const config = { mirrorX: false, rotationDeg: 0 }
  const explicit = panCenter(51.1, 1.45, 'right', 20, config, PAN_FRACTION)
  const implicit = panCenter(51.1, 1.45, 'right', 20, config)
  assert(
    Math.abs(explicit.centerLat - implicit.centerLat) < 1e-12 && Math.abs(explicit.centerLon - implicit.centerLon) < 1e-12,
    'panCenter: explicit PAN_FRACTION matches default (fraction param is backward-compatible)',
  )
}

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
