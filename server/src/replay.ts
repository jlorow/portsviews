import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, DEMO_AREAS, parseDemoArea } from '@wake/shared'
import { registerShutdown } from './shutdown.ts'
import { createPositionMap, createStaticMap } from './caches.ts'
import { createBroadcastServer } from './broadcast.ts'
import type { PipelineContext } from './pipeline.ts'
import { readCaptureFile, scheduleReplay } from './replayCore.ts'

// This file must never import aisstream.ts, directly or transitively --
// that is what makes "replay cannot open an AISstream connection" a
// structural fact about the import graph rather than a runtime check.
//
// lock.ts IS transitively reachable, via shutdown.ts's unconditional
// releaseLock() call -- kept exactly where the live path already has it,
// per "do not reorder or restructure the existing sequence." That is
// fine: acquireLock() is never called here, so replay never checks or
// blocks on the lockfile at startup, and releaseLock() on a lock this
// process never acquired is already a safe no-op by its own design (it
// only removes the file if the PID recorded in it matches process.pid).
// The PID lock exists solely to guard the AISstream ghost-connection
// risk (see lock.ts's own comment), which does not apply here regardless
// of whether the module happens to be on the import graph. Two
// replay/live processes on one port instead fail immediately and
// unambiguously via Node's own EADDRINUSE on the WebSocketServer bind --
// no custom mechanism needed
// to reproduce what the runtime already guarantees.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '..', '.env') })

const BROADCAST_PORT = Number(process.env.WAKE_BROADCAST_PORT ?? 8080)
const REPLAY_SPEED = Number(process.env.WAKE_REPLAY_SPEED ?? 1)
const REPLAY_PATH = process.env.WAKE_REPLAY_PATH
const PROGRESS_LOG_INTERVAL = 100

const BANNER = '='.repeat(60)

// DEMO-1: log the active area at startup, and warn when it is not dover
// -- the only recorded capture is Dover, so any other area setting would
// render an empty ocean from replay. An invalid value falls back to
// 'dover' for logging (replay opens no subscription, so unlike index.ts
// this is informational, not a refusal).
const REPLAY_AREA_RAW = process.env.WAKE_AREA
const REPLAY_AREA_KEY = parseDemoArea(REPLAY_AREA_RAW) ?? 'dover'

function logBanner(recordCount: number, malformedCount: number, spanSec: number): void {
  console.log(BANNER)
  console.log('[Wake:REPLAY] REPLAY MODE -- NOT LIVE AIS DATA')
  console.log(`[Wake:REPLAY] Source: ${REPLAY_PATH}`)
  console.log(`[Wake:REPLAY] Speed: ${REPLAY_SPEED}x   Loop: yes   Port: ${BROADCAST_PORT}`)
  console.log(`[Wake:REPLAY] Area: ${REPLAY_AREA_KEY}`)
  if (REPLAY_AREA_RAW !== undefined && parseDemoArea(REPLAY_AREA_RAW) === null) {
    console.warn(
      `[Wake:REPLAY] Invalid WAKE_AREA ${JSON.stringify(REPLAY_AREA_RAW)} -- expected one of: ${Object.keys(DEMO_AREAS).join(', ')}. Logging dover.`,
    )
  }
  if (REPLAY_AREA_KEY !== 'dover') {
    console.warn(
      "[Wake:REPLAY] Area is not dover -- the only recorded capture is Dover, so vessels outside Dover will not appear.",
    )
  }
  console.log(
    `[Wake:REPLAY] ${recordCount} envelopes, ${spanSec.toFixed(1)}s real capture span` +
      (malformedCount > 0 ? `, ${malformedCount} malformed line(s) skipped` : ''),
  )
  console.log(BANNER)
}

let records: ReturnType<typeof readCaptureFile>['records']
let malformedCount: number
try {
  const result = readCaptureFile(REPLAY_PATH)
  records = result.records
  malformedCount = result.malformedCount
} catch (err) {
  console.error('[Wake:REPLAY]', (err as Error).message)
  process.exit(1)
}

if (records.length === 0) {
  console.error('[Wake:REPLAY] Capture file contains no usable records -- refusing to start empty.')
  process.exit(1)
}

const captureStartMs = Math.min(...records.map((r) => r.receivedAtMs))
const captureEndMs = Math.max(...records.map((r) => r.receivedAtMs))
logBanner(records.length, malformedCount, (captureEndMs - captureStartMs) / 1000)

const positionMap = createPositionMap()
const staticMap = createStaticMap()
const broadcastServer = createBroadcastServer(BROADCAST_PORT, positionMap, staticMap)

const pipelineCtx: PipelineContext = {
  positionMap,
  staticMap,
  clients: broadcastServer.clients,
  removeSec: DEFAULT_CONFIG.removeSec,
}

// No ManagedSocket (no AIS connection exists), no capture logger
// (capturing replayed data as if it were fresh live data would be
// actively misleading). Client sockets still close gracefully on
// shutdown, same as the live path.
registerShutdown(undefined, undefined, broadcastServer.clients)

scheduleReplay({
  records,
  ctx: pipelineCtx,
  speed: REPLAY_SPEED,
  loop: true,
  scheduleFn: (fn, delayMs) => setTimeout(fn, delayMs),
  clock: () => Date.now(),
  onPassStart: (passNumber) => {
    if (passNumber > 1) {
      console.log(`[Wake:REPLAY] Reached end of capture -- looping (pass ${passNumber} starting)`)
    }
  },
  onEnvelopeProcessed: (index, total, passNumber) => {
    if ((index + 1) % PROGRESS_LOG_INTERVAL === 0 || index + 1 === total) {
      console.log(`[Wake:REPLAY] pass ${passNumber}: processed ${index + 1}/${total} envelopes`)
    }
  },
})
