// The .env template test: what a stranger's very first run sees.
//
// The bug this guards against: .env.example shipped every optional setting
// with an EMPTY value, the README says to copy it, and '' is not undefined
// -- so `??` never fired, Number('') was 0, the server bound a random
// ephemeral port and the display never connected until both ports were
// edited to 8080 by hand.
//
// This test reads the REAL repo-root .env.example, takes ONLY the keys it
// defines, adds the one real setting a user must fill in, and resolves
// every optional setting through the SAME functions the server and the
// display actually call. If a future template entry ships a blank that any
// of those functions cannot treat as unset, this fails.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseDotenv } from 'dotenv'
import {
  DEFAULT_BROADCAST_PORT,
  parseAisSource,
  parsePort,
  parsePositiveNumber,
  resolveArea,
  resolveSourceConfig,
} from '@wake/shared'
import { parseDurationMin } from './tools/capacityCore.ts'
import { resolveCapturePath } from './capture.ts'
import { readCaptureFile } from './replayCore.ts'

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

const here = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = path.resolve(here, '..', '..', '.env.example')

function readTemplate(): Record<string, string> {
  assert(fs.existsSync(TEMPLATE_PATH), `.env.example exists at the repo root (${TEMPLATE_PATH})`)
  return parseDotenv(fs.readFileSync(TEMPLATE_PATH, 'utf8'))
}

/**
 * Every optional setting, resolved exactly as the running code resolves it.
 * `label` names the template being checked so a failure says which one.
 */
function assertOptionalSettingsAreDefaults(env: Record<string, string>, label: string): void {
  // server/src/index.ts and server/src/replay.ts
  const serverPort = parsePort(env.WAKE_BROADCAST_PORT, DEFAULT_BROADCAST_PORT, 'WAKE_BROADCAST_PORT')
  assert(
    serverPort.ok && serverPort.value === 8080,
    `${label}: WAKE_BROADCAST_PORT resolves to 8080 (got ${JSON.stringify(serverPort)})`,
  )

  // apps/display/vite.config.ts
  const displayPort = parsePort(
    env.VITE_WAKE_BROADCAST_PORT,
    DEFAULT_BROADCAST_PORT,
    'VITE_WAKE_BROADCAST_PORT',
  )
  assert(
    displayPort.ok && displayPort.value === 8080,
    `${label}: VITE_WAKE_BROADCAST_PORT resolves to 8080, the same default as the server (got ${JSON.stringify(displayPort)})`,
  )

  // shared/src/localAreas.ts resolveArea -- the server refuses on null, and
  // the display would log "Invalid WAKE_AREA" for a blank it should ignore.
  const area = resolveArea(env.WAKE_AREA, null)
  assert(area?.key === 'dover', `${label}: WAKE_AREA resolves to dover (got ${JSON.stringify(area?.key)})`)

  // shared/src/areas.ts parseAisSource -- null makes the server exit 1.
  const source = parseAisSource(env.WAKE_AIS_SOURCE)
  assert(source === 'aisstream', `${label}: WAKE_AIS_SOURCE resolves to aisstream (got ${JSON.stringify(source)})`)

  // shared/src/areas.ts resolveSourceConfig -- the aiscast credential a
  // blank template does NOT provide must be reported missing, never
  // claimed as usable.
  const sourceConfig = resolveSourceConfig(env, 'aiscast')
  assert(
    'error' in sourceConfig,
    `${label}: the blank aiscast credential is reported missing, never used`,
  )

  // server/src/replay.ts -- Number('') was 0, and a speed of 0 divides the
  // captured gaps by zero.
  const speed = parsePositiveNumber(env.WAKE_REPLAY_SPEED, 1, 'WAKE_REPLAY_SPEED')
  assert(
    speed.ok && speed.value === 1,
    `${label}: WAKE_REPLAY_SPEED resolves to 1x, real captured pace (got ${JSON.stringify(speed)})`,
  )

  // server/src/tools/capacityCapture.ts
  const duration = parseDurationMin(env.CAPACITY_CAPTURE_DURATION_MIN)
  assert(
    duration === 60,
    `${label}: CAPACITY_CAPTURE_DURATION_MIN resolves to 60 (got ${JSON.stringify(duration)})`,
  )

  // server/src/capture.ts -- blank means capture is OFF, not a write to ''.
  const capturePath = resolveCapturePath(env.AIS_CAPTURE_PATH)
  assert(
    capturePath === undefined,
    `${label}: no capture path, so capture is off (got ${JSON.stringify(capturePath)})`,
  )

  // server/src/replayCore.ts readCaptureFile -- the real function replay.ts
  // calls; blank must give the "not set" message, not an ENOENT.
  let replayError = ''
  try {
    readCaptureFile(env.WAKE_REPLAY_PATH)
  } catch (error) {
    replayError = (error as Error).message
  }
  assert(
    replayError.startsWith('WAKE_REPLAY_PATH is not set'),
    `${label}: blank WAKE_REPLAY_PATH is "not set", not a failed file read (got ${JSON.stringify(replayError)})`,
  )

  // The key itself is required, and it is the one setting a user must fill
  // in; no default for it is invented here.
  const keyConfig = resolveSourceConfig({ aisstreamApiKey: env.AISSTREAM_API_KEY }, 'aisstream')
  assert(
    !('error' in keyConfig) && keyConfig.apiKey === 'abc',
    `${label}: the filled-in AISSTREAM_API_KEY is accepted, no invented default`,
  )
}

// --- the shipped template ---

const template = readTemplate()

// The template ships exactly ONE active setting: the key the user must
// supply. Every other variable is switched off behind a leading '#', so a
// copied-and-filled .env leaves the optionals undefined (unset), and the
// documented defaults apply -- and no blank can be read as a real value.
const templateKeys = Object.keys(template).sort()
assert(
  templateKeys.length === 1 && templateKeys[0] === 'AISSTREAM_API_KEY',
  `the template defines exactly one key, AISSTREAM_API_KEY (got ${JSON.stringify(templateKeys)})`,
)
for (const name of [
  'AIS_CAPTURE_PATH',
  'WAKE_BROADCAST_PORT',
  'VITE_WAKE_BROADCAST_PORT',
  'WAKE_REPLAY_PATH',
  'WAKE_REPLAY_SPEED',
  'CAPACITY_CAPTURE_DURATION_MIN',
  'WAKE_AREA',
  'WAKE_AIS_SOURCE',
  'AISCAST_TOKEN',
  'VITE_WAKE_SERVER_URL',
  'WAKE_STATIC_DIR',
  'WAKE_ACCESS_PASSWORD',
]) {
  assert(
    !(name in template),
    `${name} is switched off in the template (commented out), not defined`,
  )
}

// "Take ONLY what it defines": the entry a user must supply is added here,
// exactly as the README tells them to.
const shipped: Record<string, string> = { ...template, AISSTREAM_API_KEY: 'abc' }
assertOptionalSettingsAreDefaults(shipped, '.env.example')

// --- the OLD template, in full, as a synthetic control ---
// Every optional setting present with a blank value -- the exact shape that
// caused the first-run bug. This case must pass too, so the fix does not
// depend on the template being tidy.

const oldTemplate: Record<string, string> = {
  AISSTREAM_API_KEY: 'abc',
  AIS_CAPTURE_PATH: '',
  WAKE_BROADCAST_PORT: '',
  VITE_WAKE_BROADCAST_PORT: '',
  WAKE_REPLAY_PATH: '',
  WAKE_REPLAY_SPEED: '',
  CAPACITY_CAPTURE_DURATION_MIN: '',
  WAKE_AREA: '',
  WAKE_AIS_SOURCE: '',
  AISCAST_TOKEN: '',
}
assertOptionalSettingsAreDefaults(oldTemplate, 'old blank template')

// Whitespace-only values, the other shape "blank" has to cover.
const whitespaceTemplate: Record<string, string> = Object.fromEntries(
  Object.entries(oldTemplate).map(([key, value]) => [key, value === '' ? '   ' : value]),
)
assertOptionalSettingsAreDefaults(whitespaceTemplate, 'whitespace-only template')

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
