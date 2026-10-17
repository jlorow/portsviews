import {
  SWEEP_TOGGLE_FALLBACK_SEC,
  parseSweepParam,
  sweepKeyAction,
  toggleSweep,
  type SweepKeyEvent,
} from './sweepControl.ts'

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

function keyEvent(key: string, overrides: Partial<SweepKeyEvent> = {}): SweepKeyEvent {
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

// --- sweepKeyAction ---

assert(sweepKeyAction(keyEvent('s')) === 'toggle', "sweepKeyAction: 's' toggles")
assert(sweepKeyAction(keyEvent('S')) === 'toggle', "sweepKeyAction: 'S' (Shift or Caps Lock) toggles")
assert(sweepKeyAction(keyEvent('s', { repeat: true })) === null, 'sweepKeyAction: a held key acts once, repeats are ignored')
assert(sweepKeyAction(keyEvent('s', { ctrlKey: true })) === null, "sweepKeyAction: Ctrl+S is the browser's")
assert(sweepKeyAction(keyEvent('s', { metaKey: true })) === null, "sweepKeyAction: Cmd+S is the browser's")
assert(sweepKeyAction(keyEvent('s', { altKey: true })) === null, "sweepKeyAction: Alt+S is the browser's")
assert(sweepKeyAction(keyEvent('s', { targetIsEditable: true })) === null, 'sweepKeyAction: typing an s into a text field is not a toggle')
assert(sweepKeyAction(keyEvent('b')) === null, "sweepKeyAction: 'b' is the tune key's, not this one's")
assert(sweepKeyAction(keyEvent('d')) === null, "sweepKeyAction: other letters do nothing")

// --- toggleSweep ---

{
  const off = toggleSweep(16, 10)
  assert(off.periodSec === 0, `toggleSweep: on -> off (got ${off.periodSec})`)
  assert(off.lastNonZeroSec === 16, `toggleSweep: off remembers the period that was running (got ${off.lastNonZeroSec})`)

  const on = toggleSweep(off.periodSec, off.lastNonZeroSec)
  assert(on.periodSec === 16, `toggleSweep: off -> on returns the remembered period (got ${on.periodSec})`)
  assert(on.lastNonZeroSec === 16, `toggleSweep: and keeps remembering it (got ${on.lastNonZeroSec})`)
}

{
  const on = toggleSweep(0)
  assert(SWEEP_TOGGLE_FALLBACK_SEC === 10, `SWEEP_TOGGLE_FALLBACK_SEC is 10 (got ${SWEEP_TOGGLE_FALLBACK_SEC})`)
  assert(on.periodSec === 10, `toggleSweep: off with nothing remembered comes back at 10 (got ${on.periodSec})`)

  const off = toggleSweep(10)
  assert(off.periodSec === 0 && off.lastNonZeroSec === 10, `toggleSweep: the default remembered value is replaced by the running one (got ${JSON.stringify(off)})`)
}

// --- parseSweepParam ---

assert(parseSweepParam('?sweep=off') === 0, 'parseSweepParam: off -> 0')
assert(parseSweepParam('?sweep=0') === 0, 'parseSweepParam: 0 -> 0')
assert(parseSweepParam('?sweep=on') === undefined, 'parseSweepParam: on -> undefined (use the default)')
assert(parseSweepParam('?sweep=5') === 5, 'parseSweepParam: 5 -> 5')
assert(parseSweepParam('?sweep=120') === undefined, 'parseSweepParam: 120 is above 60 and is ignored')
assert(parseSweepParam('?sweep=abc') === undefined, 'parseSweepParam: abc is ignored')
assert(parseSweepParam('') === undefined, 'parseSweepParam: no query string -> undefined')
assert(parseSweepParam('?tune=1') === undefined, 'parseSweepParam: no sweep parameter -> undefined')
assert(parseSweepParam('?tune=1&sweep=off') === 0, 'parseSweepParam: read alongside other parameters')
assert(parseSweepParam('?sweep=1') === 1 && parseSweepParam('?sweep=60') === 60, 'parseSweepParam: 1 and 60 are both inside the range')

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
