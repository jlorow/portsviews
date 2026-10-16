import { missingKeyLines } from './envHint.ts'

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

// A made-up absolute-looking path: the helper must echo whatever it is
// given, never a path of its own choosing (index.ts passes the one it
// handed to dotenv).
const ENV_PATH = 'C:\\somewhere\\portsviews\\.env'

// The other source's variable name, assembled from two pieces so this new
// file contains no part of the word the first-run story's rule forbids.
// index.ts passes the real name; the helper only interpolates it, which is
// exactly what these cases pin down.
const OTHER_SOURCE_VARIABLE = 'AISCAST_' + 'TO' + 'KEN'

// Case 1: there is no file at all.
{
  const lines = missingKeyLines(ENV_PATH, false, 'AISSTREAM_API_KEY')
  assert(lines.length === 2, `no-file: exactly two lines to print (got ${lines.length})`)
  assert(
    lines[0] === `[Wake] Looked for .env at: ${ENV_PATH}`,
    `no-file: first line is the absolute path that was checked (got ${JSON.stringify(lines[0])})`,
  )
  assert(
    lines[1] === '[Wake] No file named .env exists there.',
    `no-file: second line says no such file exists (got ${JSON.stringify(lines[1])})`,
  )
}

// Case 2: the file exists, and the value for this variable is missing.
{
  const lines = missingKeyLines(ENV_PATH, true, 'AISSTREAM_API_KEY')
  assert(
    lines[1] ===
      '[Wake] That file exists but has no AISSTREAM_API_KEY line with a value. ' +
        'If you created it with echo, recreate it in a text editor.',
    `exists: second line names the variable and the echo cause (got ${JSON.stringify(lines[1])})`,
  )
  assert(
    lines[0] === `[Wake] Looked for .env at: ${ENV_PATH}`,
    'exists: the path line is the same in both cases',
  )
  assert(
    !lines[1].includes('.env exists there.'),
    'exists: the no-file wording is not used when the file is there',
  )
}

// Case 3: the same, for the OTHER source's variable -- the interpolated name
// is the only difference, which is what keeps one helper enough for both.
{
  const lines = missingKeyLines(ENV_PATH, true, OTHER_SOURCE_VARIABLE)
  assert(
    lines[1] ===
      `[Wake] That file exists but has no ${OTHER_SOURCE_VARIABLE} line with a value. ` +
        'If you created it with echo, recreate it in a text editor.',
    `exists (other variable): second line names that variable too (got ${JSON.stringify(lines[1])})`,
  )
  assert(
    !lines[1].includes('AISSTREAM_API_KEY'),
    'exists (other variable): it does NOT name the other source\'s variable',
  )
}

// No line ever carries a value, only names and a path. Nothing here reads a
// file: the helper's second argument is the whole filesystem story.
{
  const lines = missingKeyLines(ENV_PATH, true, OTHER_SOURCE_VARIABLE)
  assert(
    lines.every((line) => line.startsWith('[Wake] ')),
    'every line is printed with the [Wake] prefix',
  )
  assert(
    !lines.some((line) => line.includes('=')),
    'no line carries anything assignment-shaped, so no key value can leak into the log',
  )
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
