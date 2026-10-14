import { basemapZoom } from './basemap.ts'
import { radiusStepsFor, stepRadius, zoomKeyAction, type ZoomKeyEvent } from './zoom.ts'

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

assert(
  JSON.stringify(radiusStepsFor(20)) === JSON.stringify([5, 10, 20]),
  'radiusStepsFor(20): only steps up to the default',
)
assert(
  JSON.stringify(radiusStepsFor(25)) === JSON.stringify([5, 10, 20, 25]),
  'radiusStepsFor(25): includes an unlisted default in ascending order',
)
assert(stepRadius([5, 10, 20], 5, 'in') === 5, 'stepRadius: zoom-in at smallest radius is a no-op')
assert(stepRadius([5, 10, 20], 20, 'out') === 20, 'stepRadius: zoom-out at largest radius is a no-op')
assert(stepRadius([5, 10, 20], 10, 'in') === 5, 'stepRadius: zoom-in selects the next smaller radius')
assert(stepRadius([5, 10, 20], 10, 'out') === 20, 'stepRadius: zoom-out selects the next larger radius')
assert(stepRadius([5, 10, 20], 8, 'in') === 10, 'stepRadius: unlisted radius snaps to nearest step')

assert(zoomKeyAction(keyEvent('=')) === 'in', "zoomKeyAction: '=' zooms in")
assert(zoomKeyAction(keyEvent('+')) === 'in', "zoomKeyAction: '+' zooms in")
assert(zoomKeyAction(keyEvent('-')) === 'out', "zoomKeyAction: '-' zooms out")
assert(zoomKeyAction(keyEvent('_')) === 'out', "zoomKeyAction: '_' zooms out")
assert(zoomKeyAction(keyEvent('0')) === 'reset', "zoomKeyAction: '0' resets")
assert(zoomKeyAction(keyEvent('x')) === null, 'zoomKeyAction: unrelated keys are ignored')
assert(zoomKeyAction(keyEvent('=' , { repeat: true })) === null, 'zoomKeyAction: auto-repeat is ignored')
assert(zoomKeyAction(keyEvent('=', { ctrlKey: true })) === null, 'zoomKeyAction: Ctrl shortcuts are ignored')
assert(zoomKeyAction(keyEvent('=', { metaKey: true })) === null, 'zoomKeyAction: Cmd shortcuts are ignored')
assert(zoomKeyAction(keyEvent('=', { altKey: true })) === null, 'zoomKeyAction: Alt shortcuts are ignored')
assert(
  zoomKeyAction(keyEvent('=', { targetIsEditable: true })) === null,
  'zoomKeyAction: editable targets are ignored',
)

const doverZoom20 = basemapZoom(1920, 1080, 51.1, 20)
const doverZoom10 = basemapZoom(1920, 1080, 51.1, 10)
const doverZoom5 = basemapZoom(1920, 1080, 51.1, 5)
const sydneyZoom5 = basemapZoom(1920, 1080, -33.93, 5)
assert(Math.abs(doverZoom20 - 9.4824) < 0.001, `basemapZoom Dover radius 20: ${doverZoom20.toFixed(4)}`)
assert(Math.abs(doverZoom10 - 10.4824) < 0.001, `basemapZoom Dover radius 10: ${doverZoom10.toFixed(4)}`)
assert(Math.abs(doverZoom5 - 11.4824) < 0.001, `basemapZoom Dover radius 5: ${doverZoom5.toFixed(4)}`)
assert(Math.abs(sydneyZoom5 - 11.8848) < 0.001, `basemapZoom Sydney radius 5: ${sydneyZoom5.toFixed(4)}`)

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
