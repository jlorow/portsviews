import { DEFAULT_CONFIG } from './config.ts'
import { parseMirrorParam } from './mirrorParam.ts'

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

// --- the default the "keep it" cases fall back to ---

assert(DEFAULT_CONFIG.mirrorX === true, 'DEFAULT_CONFIG.mirrorX is true (ceiling projection)')

// --- off ---

assert(parseMirrorParam('off') === false, 'parseMirrorParam: off -> false')
assert(parseMirrorParam('0') === false, 'parseMirrorParam: 0 -> false')
assert(parseMirrorParam('false') === false, 'parseMirrorParam: false -> false')
assert(parseMirrorParam('OFF') === false, 'parseMirrorParam: OFF is lower-cased -> false')
assert(parseMirrorParam('False') === false, 'parseMirrorParam: False is lower-cased -> false')
assert(parseMirrorParam('  off  ') === false, 'parseMirrorParam: surrounding spaces are trimmed -> false')
assert(parseMirrorParam(' 0\t') === false, 'parseMirrorParam: tab and space around 0 are trimmed -> false')

// --- on, missing or empty: the default ---

assert(parseMirrorParam('on') === true, 'parseMirrorParam: on -> default (true)')
assert(parseMirrorParam('1') === true, 'parseMirrorParam: 1 -> default (true)')
assert(parseMirrorParam('true') === true, 'parseMirrorParam: true -> default (true)')
assert(parseMirrorParam('ON') === true, 'parseMirrorParam: ON -> default (true)')
assert(parseMirrorParam(null) === true, 'parseMirrorParam: missing (null) -> default (true)')
assert(parseMirrorParam('') === true, 'parseMirrorParam: empty -> default (true)')
assert(parseMirrorParam('   ') === true, 'parseMirrorParam: only spaces -> default (true)')

// --- anything else: the default, never a guess ---

assert(parseMirrorParam('no') === true, 'parseMirrorParam: no is not recognised -> default (true)')
assert(parseMirrorParam('2') === true, 'parseMirrorParam: 2 is not recognised -> default (true)')
assert(parseMirrorParam('of') === true, 'parseMirrorParam: of is not recognised -> default (true)')
assert(parseMirrorParam('offf') === true, 'parseMirrorParam: offf is not recognised -> default (true)')

// --- read from a real query string, the way WakeCanvas reads it ---

assert(parseMirrorParam(new URLSearchParams('?mirror=off').get('mirror')) === false, 'parseMirrorParam: ?mirror=off -> false')
assert(parseMirrorParam(new URLSearchParams('?tune=1&mirror=0').get('mirror')) === false, 'parseMirrorParam: read alongside other parameters')
assert(parseMirrorParam(new URLSearchParams('?sweep=off').get('mirror')) === true, 'parseMirrorParam: no mirror parameter -> default (true)')
assert(parseMirrorParam(new URLSearchParams('?mirror=').get('mirror')) === true, 'parseMirrorParam: ?mirror= with no value -> default (true)')

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
