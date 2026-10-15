import {
  FPS_PENDING,
  FPS_WINDOW_MS,
  applyTuneKey,
  formatFps,
  formatView,
  tuneOverlayText,
  type TuneKeyEvent,
} from './tuneOverlay'
import {
  DEFAULT_CONFIG,
  HERO_SCALES,
  LABEL_SIZES,
  LAND_LEVELS,
  SWEEP_PERIODS,
  UNKNOWN_SCALES,
  type DisplayConfig,
} from '@wake/shared'

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

const press = (key: string): TuneKeyEvent => ({ key, repeat: false })
const held = (key: string): TuneKeyEvent => ({ key, repeat: true })

// Every key the overlay documents, and the config field each one owns.
const KEYS: [string, keyof DisplayConfig][] = [
  ['h', 'heroesEnabled'],
  ['w', 'glowEnabled'],
  ['r', 'rangeRingsEnabled'],
  ['j', 'heroScale'],
  ['l', 'labelSize'],
  ['t', 'areaTitleEnabled'],
  ['u', 'unknownScale'],
  ['b', 'sweepPeriodSec'],
  ['d', 'stoppedAsDot'],
  ['k', 'legendEnabled'],
  ['g', 'glyphScale'],
  ['m', 'basemapEnabled'],
  ['f', 'basemapLand'],
  ['n', 'placeNamesEnabled'],
]

// --- THE REPEAT GUARD: a held key acts once per physical press ---
//
// This is the defect the VIS-9 ceiling look hit. An OS key auto-repeat
// delivers a stream of keydown events with repeat: true; every earlier
// version of this handler acted on all of them, so holding F rebuilt the
// whole MapLibre style once per frame.

for (const [key, field] of KEYS) {
  // One press, then a burst of repeats, exactly as the OS delivers it.
  let config = DEFAULT_CONFIG
  config = applyTuneKey(config, press(key))
  const afterFirstPress = config
  for (let i = 0; i < 40; i++) {
    config = applyTuneKey(config, held(key))
  }

  assert(
    config === afterFirstPress,
    `'${key}' held for 40 repeat events: the config object is UNCHANGED after the first press (field ${String(field)})`,
  )
  assert(
    config[field] === applyTuneKey(DEFAULT_CONFIG, press(key))[field],
    `'${key}' held: ${String(field)} ends where ONE press leaves it, not 41 presses`,
  )
  assert(
    config[field] !== DEFAULT_CONFIG[field],
    `'${key}' held: the single press did still take effect (${String(field)} moved off its default)`,
  )
}

// A repeat event is a no-op even when it is the very first event seen --
// the guard is on the event, not on any remembered key state.
for (const [key] of KEYS) {
  assert(
    applyTuneKey(DEFAULT_CONFIG, held(key)) === DEFAULT_CONFIG,
    `'${key}' repeat event with no prior press: returns the same object, unchanged`,
  )
}

// Press, release, press again: two physical presses act twice. The guard
// must not swallow a genuine second press.
{
  let config: DisplayConfig = DEFAULT_CONFIG
  config = applyTuneKey(config, press('f'))
  config = applyTuneKey(config, held('f'))
  config = applyTuneKey(config, held('f'))
  config = applyTuneKey(config, press('f'))
  const twice = applyTuneKey(applyTuneKey(DEFAULT_CONFIG, press('f')), press('f'))
  assert(
    config.basemapLand === twice.basemapLand,
    `'f' pressed, held, then pressed again: land advances exactly twice (got ${config.basemapLand}, expected ${twice.basemapLand})`,
  )
}

// --- the mapping itself, so extracting it changed nothing ---

for (const [key, field] of KEYS) {
  const next = applyTuneKey(DEFAULT_CONFIG, press(key))
  assert(next !== DEFAULT_CONFIG, `'${key}' press: returns a new config object`)
  const changed = (Object.keys(next) as (keyof DisplayConfig)[]).filter((k) => next[k] !== DEFAULT_CONFIG[k])
  assert(
    changed.length === 1 && changed[0] === field,
    `'${key}' press: changes exactly one field, ${String(field)} (changed: ${changed.join(', ') || 'none'})`,
  )
}

assert(
  applyTuneKey(DEFAULT_CONFIG, press('F')).basemapLand === applyTuneKey(DEFAULT_CONFIG, press('f')).basemapLand,
  'keys are case-insensitive: shift-F behaves as f',
)
for (const key of ['q', 'z', '1', 'Escape', ' ']) {
  assert(
    applyTuneKey(DEFAULT_CONFIG, press(key)) === DEFAULT_CONFIG,
    `'${key}' is not a tune key: returns the same object, unchanged`,
  )
}

// Cycling keys wrap rather than running off the end.
{
  let config: DisplayConfig = DEFAULT_CONFIG
  for (let i = 0; i < LAND_LEVELS.length; i++) config = applyTuneKey(config, press('f'))
  assert(config.basemapLand === DEFAULT_CONFIG.basemapLand, `'f' pressed ${LAND_LEVELS.length} times returns to the default land level`)

  config = DEFAULT_CONFIG
  for (let i = 0; i < HERO_SCALES.length; i++) config = applyTuneKey(config, press('j'))
  assert(config.heroScale === DEFAULT_CONFIG.heroScale, `'j' pressed ${HERO_SCALES.length} times returns to the default hero scale`)

  config = DEFAULT_CONFIG
  for (let i = 0; i < LABEL_SIZES.length; i++) config = applyTuneKey(config, press('l'))
  assert(config.labelSize === DEFAULT_CONFIG.labelSize, `'l' pressed ${LABEL_SIZES.length} times returns to the default label size`)

  config = DEFAULT_CONFIG
  for (let i = 0; i < UNKNOWN_SCALES.length; i++) config = applyTuneKey(config, press('u'))
  assert(config.unknownScale === DEFAULT_CONFIG.unknownScale, `'u' pressed ${UNKNOWN_SCALES.length} times returns to the default unknown scale`)

  config = DEFAULT_CONFIG
  for (let i = 0; i < SWEEP_PERIODS.length; i++) config = applyTuneKey(config, press('b'))
  assert(config.sweepPeriodSec === DEFAULT_CONFIG.sweepPeriodSec, `'b' pressed ${SWEEP_PERIODS.length} times returns to the default sweep period`)
}

// --- THE FPS READOUT: "no data yet" is not a measured zero ---

assert(formatFps(null) === FPS_PENDING, `formatFps(null) is the pending marker ${JSON.stringify(FPS_PENDING)}`)
assert(formatFps(0) === '0', 'formatFps(0) is "0"')
assert(
  formatFps(null) !== formatFps(0),
  `the initial state is DISTINGUISHABLE from a real zero reading (${JSON.stringify(formatFps(null))} vs ${JSON.stringify(formatFps(0))})`,
)
// Widened deliberately: FPS_PENDING's literal type makes the comparison
// tautological to the compiler, but this is a runtime guard against
// someone later setting the marker to '0' or ''.
const pendingMarker: string = FPS_PENDING
assert(pendingMarker !== '0' && pendingMarker !== '', 'the pending marker is neither "0" nor empty')
assert(formatFps(60) === '60' && formatFps(31) === '31', 'formatFps passes a real reading straight through')

// The same distinction, in the string the ceiling actually reads.
{
  const status = { basemapAvailable: true, radiusNm: 20, centerOffsetLatNm: 0, centerOffsetLonNm: 0, vesselCount: 51, fps: null as number | null }
  const pending = tuneOverlayText(DEFAULT_CONFIG, status)
  const zero = tuneOverlayText(DEFAULT_CONFIG, { ...status, fps: 0 })
  const sixty = tuneOverlayText(DEFAULT_CONFIG, { ...status, fps: 60 })

  assert(pending.endsWith(`FPS ${FPS_PENDING}`), `before the first sample the overlay ends "FPS ${FPS_PENDING}" (got ...${pending.slice(-12)})`)
  assert(zero.endsWith('FPS 0'), 'a measured zero still reads "FPS 0"')
  assert(pending !== zero, 'the overlay text for "not measured yet" differs from the text for a measured zero')
  assert(sixty.endsWith('FPS 60'), 'a measured 60 reads "FPS 60"')
  assert(
    !pending.includes('FPS 0'),
    'the pending overlay contains no "FPS 0" anywhere -- which is exactly what the VIS-9 look misread',
  )
  assert(pending.includes('Vessels 51'), 'the vessel count is shown even while FPS has no sample yet (the combination the look reported)')
  assert(pending.includes('View 20nm N+0.0 E+0.0'), 'the tune status line shows the view: the current radius and the centre offset (at the area centre on a fresh load)')
}

// --- the sampling window ---

assert(FPS_WINDOW_MS < 5000, `the FPS window is shorter than the old 5000ms (it is ${FPS_WINDOW_MS}ms)`)
assert(FPS_WINDOW_MS >= 250, `the FPS window is long enough to be a measurement, not noise (${FPS_WINDOW_MS}ms)`)
// Worst case for a change to reach the ceiling: one window plus the
// overlay's own 1000ms refresh interval.
assert(
  FPS_WINDOW_MS + 1000 <= 2000,
  `a real change reaches the overlay within ${FPS_WINDOW_MS + 1000}ms worst case, against 6000ms before`,
)

// --- the overlay text reflects the settings it claims to ---

{
  const status = { basemapAvailable: true, radiusNm: 20, centerOffsetLatNm: 0, centerOffsetLonNm: 0, vesselCount: 7, fps: 42 }
  const text = tuneOverlayText(DEFAULT_CONFIG, status)
  assert(text.includes(`Land ${LAND_LEVELS[DEFAULT_CONFIG.basemapLand].name}`), `the overlay names the default land level (${LAND_LEVELS[DEFAULT_CONFIG.basemapLand].name})`)
  assert(text.includes('Basemap on'), 'basemap available and enabled reads "Basemap on"')
  assert(text.includes('Names on'), 'place names enabled reads "Names on"')
  assert(text.includes('Vessels 7'), 'the vessel count is shown')

  const noArea = tuneOverlayText(DEFAULT_CONFIG, { ...status, basemapAvailable: false })
  assert(
    noArea.includes('Basemap n/a'),
    'an area with no tile extract reads "Basemap n/a", not "off" -- off would imply it could be turned on',
  )

  const off = tuneOverlayText({ ...DEFAULT_CONFIG, basemapEnabled: false, placeNamesEnabled: false }, status)
  assert(off.includes('Basemap off') && off.includes('Names off'), 'both VIS-9 toggles read "off" when off')
}

// --- the defaults the human chose at the ceiling ---
//
// Chosen at VIS-9's ship look on 20 September 2026, and confirmed
// unchanged by a second look the same day -- so these assertions pin a
// replicated result rather than one session's preference.

assert(DEFAULT_CONFIG.basemapEnabled === true, 'DEFAULT_CONFIG.basemapEnabled is true (ceiling look, 20 September 2026)')
assert(DEFAULT_CONFIG.placeNamesEnabled === true, 'DEFAULT_CONFIG.placeNamesEnabled is true (ceiling look)')
assert(DEFAULT_CONFIG.basemapLand === 0, 'DEFAULT_CONFIG.basemapLand is 0 (ceiling look)')
assert(
  LAND_LEVELS[DEFAULT_CONFIG.basemapLand].name === 'low',
  `land level 0 is the one named 'low' (it is '${LAND_LEVELS[DEFAULT_CONFIG.basemapLand].name}')`,
)

// --- the view readout: radius AND where the centre has been panned to ---
//
// The old line opened with a bare "Radius 20nm" and said nothing about
// where the view was looking. Panning makes the centre a live value, so the
// readout now carries it: "View <radius>nm N<lat> E<lon>", both offsets in
// nautical miles from the area's own centre, signed on both axes.

assert(formatView(20, 0, 0) === 'View 20nm N+0.0 E+0.0', `formatView at the area centre (got ${formatView(20, 0, 0)})`)
assert(
  formatView(5, 1.2, -0.4) === 'View 5nm N+1.2 E-0.4',
  `formatView matches the requested example exactly (got ${formatView(5, 1.2, -0.4)})`,
)
assert(
  formatView(2, -0.04, 0.04) === 'View 2nm N+0.0 E+0.0',
  `a pan under half a tenth prints as +0.0, never -0.0 (got ${formatView(2, -0.04, 0.04)})`,
)
assert(
  formatView(10, -3.24, 2.56) === 'View 10nm N-3.2 E+2.6',
  `formatView rounds to one decimal (got ${formatView(10, -3.24, 2.56)})`,
)
assert(
  formatView(1, 0.17, -0.17) === 'View 1nm N+0.2 E-0.2',
  `the sign follows the ROUNDED offset: a negative east offset that rounds away from zero still prints the minus (got ${formatView(1, 0.17, -0.17)})`,
)

{
  const panned = tuneOverlayText(DEFAULT_CONFIG, {
    basemapAvailable: true,
    radiusNm: 5,
    centerOffsetLatNm: 1.2,
    centerOffsetLonNm: -0.4,
    vesselCount: 3,
    fps: 60,
  })
  assert(
    panned.startsWith('View 5nm N+1.2 E-0.4'),
    `the overlay line leads with the view, so a zoomed and panned view is the first thing read at the ceiling (got ...${panned.slice(0, 30)})`,
  )
  assert(
    !panned.includes('Radius'),
    'the old bare "Radius Nnm" segment is gone -- the radius now lives inside the view readout',
  )
  assert(panned.includes('Vessels 3'), 'the rest of the status line still follows the view segment')
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
