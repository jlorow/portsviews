import { sweepAngleDeg, beamCrossed } from './sweep'

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

// --- sweepAngleDeg ---

assert(sweepAngleDeg(0, 10) === 0, `sweepAngleDeg(0, 10) === 0 (got ${sweepAngleDeg(0, 10)})`)
assert(sweepAngleDeg(2500, 10) === 90, `sweepAngleDeg(2500, 10) === 90 (got ${sweepAngleDeg(2500, 10)})`)
assert(sweepAngleDeg(10000, 10) === 0, `sweepAngleDeg(10000, 10) === 0 (got ${sweepAngleDeg(10000, 10)})`)

// --- beamCrossed ---

// No previous frame -> never reveals by crossing, regardless of angle.
assert(beamCrossed(null, 80, 90) === false, 'beamCrossed: no previous angle -> false')

// Beam at 80, bearing 90: not yet crossed.
assert(beamCrossed(80, 80, 90) === false, 'beamCrossed: beam has not moved -> false')

// Beam moves from 80 to 95, passing 90 -> crossed.
assert(beamCrossed(80, 95, 90) === true, 'beamCrossed: beam moves 80 -> 95, bearing 90 is crossed')

// Beam moves from 80 to 85, not reaching 90 -> not crossed.
assert(beamCrossed(80, 85, 90) === false, 'beamCrossed: beam moves 80 -> 85, bearing 90 not yet crossed')

// Wrap: beam moves from 350 to 10, bearing 5 is crossed.
assert(beamCrossed(350, 10, 5) === true, 'beamCrossed: wrap 350 -> 10 crosses bearing 5')

// Wrap: beam moves from 350 to 10, bearing 200 is NOT crossed (outside the wrapped range).
assert(beamCrossed(350, 10, 200) === false, 'beamCrossed: wrap 350 -> 10 does not cross bearing 200')

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
