// Blank settings tests, plain tsx style like the other shared tests.
//
// The story: a stranger copies .env.example to .env, which lists every
// optional setting with an EMPTY value. '' is not undefined, `??` does not
// fire for it, and Number('') is 0, so "unset" has to be recognised before
// any number conversion happens. isBlank() is that one place, and parsePort
// / parsePositiveNumber are the only two conversions built on it.
import {
  DEFAULT_BROADCAST_PORT,
  isBlank,
  parsePort,
  parsePositiveNumber,
  resolveServerUrl,
} from './env.ts'

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

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  )
}

const FALLBACK = DEFAULT_BROADCAST_PORT

// --- isBlank ---

assertEqual(DEFAULT_BROADCAST_PORT, 8080, 'DEFAULT_BROADCAST_PORT is 8080 (the documented default)')

assertEqual(isBlank(undefined), true, 'isBlank: undefined -> true')
assertEqual(isBlank(''), true, "isBlank: '' -> true")
assertEqual(isBlank('   '), true, "isBlank: '   ' (spaces only) -> true")
assertEqual(isBlank('\t\n'), true, 'isBlank: tab/newline only -> true')
assertEqual(isBlank('0'), false, "isBlank: '0' -> false (zero is a value, not blank)")
assertEqual(isBlank('8080'), false, "isBlank: '8080' -> false")
assertEqual(isBlank(' 8080 '), false, "isBlank: ' 8080 ' -> false (has content)")

// --- parsePort: blank and undefined take the fallback ---

const blankCases: Array<[string | undefined, string]> = [
  [undefined, 'undefined'],
  ['', "''"],
  ['   ', "'   '"],
]
for (const [raw, label] of blankCases) {
  const result = parsePort(raw, FALLBACK, 'WAKE_BROADCAST_PORT')
  assert(
    result.ok && result.value === FALLBACK,
    `parsePort(${label}) -> ${FALLBACK}, not 0 (got ${JSON.stringify(result)})`,
  )
}

// The real first-run case: the template's own blank value for both sides.
for (const name of ['WAKE_BROADCAST_PORT', 'VITE_WAKE_BROADCAST_PORT']) {
  const serverSide = parsePort('', DEFAULT_BROADCAST_PORT, name)
  assert(
    serverSide.ok && serverSide.value === 8080,
    `parsePort('', ...) for ${name} -> 8080 (the documented default)`,
  )
}

// --- parsePort: valid values ---

{
  const result = parsePort('8080', FALLBACK, 'WAKE_BROADCAST_PORT')
  assert(result.ok && result.value === 8080, "parsePort: '8080' -> 8080")
}
{
  const result = parsePort('443', FALLBACK, 'WAKE_BROADCAST_PORT')
  assert(result.ok && result.value === 443, "parsePort: '443' -> 443")
}
{
  const result = parsePort('1', FALLBACK, 'WAKE_BROADCAST_PORT')
  assert(result.ok && result.value === 1, "parsePort: '1' -> 1 (lower bound)")
}
{
  const result = parsePort('65535', FALLBACK, 'WAKE_BROADCAST_PORT')
  assert(result.ok && result.value === 65535, "parsePort: '65535' -> 65535 (upper bound)")
}

// --- parsePort: invalid values are errors, never a silent 0 or NaN ---

// ' 8080 ' and '8080 ' are here on purpose: blank is whitespace only, so a
// padded value is NOT blank, and "no other characters" makes it an error
// rather than a silently trimmed port.
const invalidCases = [
  '8080abc',
  '0',
  '65536',
  '-1',
  '80.5',
  ' 8080 ',
  '8080 ',
  'e',
  '1e3',
  '0x50',
  'Infinity',
  'NaN',
]
for (const raw of invalidCases) {
  const result = parsePort(raw, FALLBACK, 'WAKE_BROADCAST_PORT')
  assert(!result.ok, `parsePort(${JSON.stringify(raw)}) -> error, not a port (got ${JSON.stringify(result)})`)
}

// --- the error text names the variable and the rule, and echoes no value ---

{
  const result = parsePort('8080abc', FALLBACK, 'WAKE_BROADCAST_PORT')
  const error = result.ok ? '' : result.error
  assert(error.includes('WAKE_BROADCAST_PORT'), 'port error names the variable')
  assert(error.includes('1 to 65535'), 'port error states the rule')
  assert(error.includes('8080'), 'port error states the default')
  assert(!error.includes('8080abc'), 'port error echoes no input value')
}
{
  const name = 'VITE_WAKE_BROADCAST_PORT'
  const result = parsePort('nope', DEFAULT_BROADCAST_PORT, name)
  const error = result.ok ? '' : result.error
  assert(error.includes(name), 'display-side port error uses the display variable name')
  assert(!error.includes('nope'), 'display-side port error echoes no input value')
  const blank = parsePort('', DEFAULT_BROADCAST_PORT, name)
  assert(blank.ok && blank.value === FALLBACK, 'both sides share one default constant')
}

// --- parsePositiveNumber: blank/unset ---
// WAKE_REPLAY_SPEED: `Number('')` was 0, and a replay speed of 0 divides
// every captured gap by zero. Blank has to mean "real captured pace" (1).

for (const [raw, label] of blankCases) {
  const result = parsePositiveNumber(raw, 1, 'WAKE_REPLAY_SPEED')
  assert(
    result.ok && result.value === 1,
    `parsePositiveNumber(${label}) -> 1, not 0 (got ${JSON.stringify(result)})`,
  )
}
{
  const result = parsePositiveNumber('2', 1, 'WAKE_REPLAY_SPEED')
  assert(result.ok && result.value === 2, "parsePositiveNumber: '2' -> 2")
}
{
  const result = parsePositiveNumber('0.5', 1, 'WAKE_REPLAY_SPEED')
  assert(result.ok && result.value === 0.5, "parsePositiveNumber: '0.5' -> 0.5 (half speed is valid)")
}
for (const raw of ['0', '-1', 'abc', '1e3', 'Infinity']) {
  const result = parsePositiveNumber(raw, 1, 'WAKE_REPLAY_SPEED')
  assert(!result.ok, `parsePositiveNumber(${JSON.stringify(raw)}) -> error (got ${JSON.stringify(result)})`)
}
{
  const result = parsePositiveNumber('nope', 1, 'WAKE_REPLAY_SPEED')
  const error = result.ok ? '' : result.error
  assert(error.includes('WAKE_REPLAY_SPEED'), 'speed error names the variable')
  assert(error.includes('greater than 0'), 'speed error states the rule')
  assert(!error.includes('nope'), 'speed error echoes no input value')
}

// --- CAPACITY_CAPTURE_DURATION_MIN's blank rule is the same one ---
// Its own parser (server/src/tools/capacityCore.ts) takes the default 60 on
// blank and its bound is 1..180. The blank half of that rule is now
// isBlank() itself, asserted above; capacityCapture.test.ts asserts 60 for
// undefined, '' and '  ' against the real parser, and envTemplate.test.ts
// asserts it through the real parser for both templates.

// --- resolveServerUrl: where the display dials ---

{
  const local = { protocol: 'http:', hostname: 'localhost', host: 'localhost:5173' }
  for (const raw of [undefined, '', '   ']) {
    assertEqual(
      resolveServerUrl(raw, 8080, local),
      { url: 'ws://localhost:8080' },
      `resolveServerUrl(${JSON.stringify(raw)}) -> today's default address`,
    )
  }

  const hosted = { protocol: 'https:', hostname: 'live.example.app', host: 'live.example.app' }
  for (const raw of ['same-origin', 'SAME-ORIGIN', '  same-origin  ']) {
    assertEqual(
      resolveServerUrl(raw, 8080, hosted),
      { url: 'wss://live.example.app/ws' },
      `resolveServerUrl(${JSON.stringify(raw)}) on https -> wss on the page's own host`,
    )
  }

  const plainLocal = { protocol: 'http:', hostname: 'localhost', host: 'localhost:8080' }
  assertEqual(
    resolveServerUrl('same-origin', 8080, plainLocal),
    { url: 'ws://localhost:8080/ws' },
    'resolveServerUrl(same-origin) on http -> ws on the page host and port',
  )

  assertEqual(
    resolveServerUrl('wss://a.example/ws', 8080, local),
    { url: 'wss://a.example/ws' },
    'resolveServerUrl: a wss address is used as given',
  )

  const invalid = ['ws://user:pass@a.example', 'http://a.example', 'nonsense']
  for (const raw of invalid) {
    const result = resolveServerUrl(raw, 8080, local)
    assert(
      result.url === 'ws://localhost:8080' && typeof result.warning === 'string',
      `resolveServerUrl(${JSON.stringify(raw)}) -> default plus a warning (got url ${JSON.stringify(result.url)})`,
    )
    const warning = result.warning ?? ''
    assert(warning.includes('VITE_WAKE_SERVER_URL'), `warning for ${JSON.stringify(raw)} names the setting`)
    assert(!warning.includes(raw), `warning for ${JSON.stringify(raw)} does not echo the value`)
  }
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
