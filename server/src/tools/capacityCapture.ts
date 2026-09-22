import { config } from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { AisStreamClient, FILTER_MESSAGE_TYPES, type AisStreamMessage } from '../aisstream.ts'
import { closeSocket } from '../shutdown.ts'
import { isLockHeld, acquireLock, releaseLock } from '../lock.ts'
import {
  buildSubscriptionA,
  buildSubscriptionB,
  scheduleResubscribes,
  exceedsOutputLimit,
  decideOnClose,
  runGracefulStop,
  resolveCaptureDir,
  utcTimestampForDirName,
  shouldRefuseStart,
  parseDurationMin,
  isWritable,
  exitAfterStreams,
  type StopReason,
  type CaptureClient,
} from './capacityCore.ts'

// RISK-1 -- offline-authored, never executed in the authoring session (no
// network connection may be opened while writing this file). The human
// runs this directly, in a real terminal, and delivers the single Ctrl+C
// this tool honours.
//
// This file is never imported by capacityCapture.test.ts or anything
// else -- it has top-level side effects (acquires the lock, opens real
// file streams, opens real sockets) the moment it loads, exactly like
// index.ts and replay.ts. Only capacityCore.ts's pure/injectable pieces
// are unit tested.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// server/src/tools -> up 3 levels to the repo root, same reasoning as
// index.ts's own comment: pnpm --filter sets cwd to the package
// directory, so a relative .env lookup must not rely on it.
config({ path: path.resolve(__dirname, '..', '..', '..', '.env') })

const STATUS_INTERVAL_MS = 60_000

const DURATION_MIN = parseDurationMin(process.env.CAPACITY_CAPTURE_DURATION_MIN)
if (DURATION_MIN === null) {
  console.error(
    `[Wake:capacity] CAPACITY_CAPTURE_DURATION_MIN must be blank or a number from 1 to 180 ` +
      `(got ${JSON.stringify(process.env.CAPACITY_CAPTURE_DURATION_MIN)}). Refusing to start.`,
  )
  process.exit(1)
}

const apiKey = process.env.AISSTREAM_API_KEY
if (!apiKey || apiKey.trim() === '') {
  console.error('[Wake:capacity] AISSTREAM_API_KEY is missing or empty. Set it in .env before starting.')
  process.exit(1)
}

// Takes the Wake server's own single-instance lock (server/.aisstream.lock)
// so this tool and a live `pnpm --filter @wake/server start` can never run
// at the same time in either direction -- reuses lock.ts's real check and
// real acquire/release, no new lock mechanism.
if (shouldRefuseStart(isLockHeld)) {
  console.error(
    '[Wake:capacity] The Wake server (or another capacity-capture run) holds the lock. Refusing to start.',
  )
  process.exit(1)
}
acquireLock()

const startedAtMs = Date.now()
const timestamp = utcTimestampForDirName(startedAtMs)
const outputDir = resolveCaptureDir(__dirname, timestamp)
fs.mkdirSync(outputDir, { recursive: true })

const pathA = path.join(outputDir, 'A.ndjson')
const pathB = path.join(outputDir, 'B.ndjson')
const pathEvents = path.join(outputDir, 'events.ndjson')

console.log('[Wake:capacity] Output directory:', outputDir)
console.log('[Wake:capacity] Connection A (Dover only):', pathA)
console.log('[Wake:capacity] Connection B (7 presets + Dover):', pathB)
console.log('[Wake:capacity] Events:', pathEvents)
console.log(`[Wake:capacity] Duration: ${DURATION_MIN} minutes`)

const streamA = fs.createWriteStream(pathA, { flags: 'a' })
const streamB = fs.createWriteStream(pathB, { flags: 'a' })
const streamEvents = fs.createWriteStream(pathEvents, { flags: 'a' })

// A write past end/destroy raises 'error' with no listener otherwise --
// an uncaught exception whose own handler would try to write another
// event to the same ended stream (see writeLine's isWritable guard and
// stop()'s exitAfterStreams call below). Log and never throw.
streamA.on('error', (err) => console.error('[Wake:capacity] A.ndjson write error:', err.message))
streamB.on('error', (err) => console.error('[Wake:capacity] B.ndjson write error:', err.message))
streamEvents.on('error', (err) => console.error('[Wake:capacity] events.ndjson write error:', err.message))

let bytesA = 0
let bytesB = 0
let bytesEvents = 0
let messagesA = 0
let messagesB = 0

function writeLine(stream: fs.WriteStream, line: string): number {
  if (!isWritable(stream)) return 0
  const buf = line + '\n'
  stream.write(buf)
  return Buffer.byteLength(buf)
}

function writeEvent(event: Record<string, unknown>): void {
  bytesEvents += writeLine(streamEvents, JSON.stringify({ receivedAtMs: Date.now(), ...event }))
}

function totalOutputBytes(): number {
  return bytesA + bytesB + bytesEvents
}

function closeWriteStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()))
}

// RISK-1 safety fix #3: perf_hooks' own event-loop delay monitor, not a
// hand-rolled one -- nothing else in this file has any way to know
// whether ITS OWN event loop fell behind (e.g. a slow write, GC pause) at
// the same time AISstream was delivering messages, which is exactly the
// "slow consumer" condition CLAUDE.md records AISstream as dropping
// messages for. Enabled once, sampled and reset on each status tick.
const eventLoopDelay = monitorEventLoopDelay()
eventLoopDelay.enable()

let stopping = false
let statusInterval: ReturnType<typeof setInterval> | undefined

async function stop(reason: StopReason): Promise<void> {
  if (stopping) return
  stopping = true
  // First, before anything else in the stop sequence: the periodic status
  // tick itself calls writeEvent(), so it must never fire again once the
  // output streams are about to be told to end.
  clearInterval(statusInterval)

  writeEvent({ type: 'stop', reason })
  console.log('[Wake:capacity] Stopping:', JSON.stringify(reason))

  await runGracefulStop({
    clientA,
    clientB,
    closeSocket,
    exit: (code) => {
      exitAfterStreams({
        endStreams: () =>
          Promise.all([closeWriteStream(streamA), closeWriteStream(streamB), closeWriteStream(streamEvents)]).then(
            () => undefined,
          ),
        releaseLock,
        exit: (exitCode) => process.exit(exitCode),
        code,
        fallbackMs: 3000,
        schedule: (fn, delayMs) => setTimeout(fn, delayMs),
      })
    },
    reason,
  })
}

function checkOutputLimit(): void {
  const total = totalOutputBytes()
  if (exceedsOutputLimit(total)) {
    void stop({ kind: 'output-limit', totalBytes: total })
  }
}

const clientA: CaptureClient = new AisStreamClient(apiKey, buildSubscriptionA(FILTER_MESSAGE_TYPES), {
  onMessage: (message: AisStreamMessage) => {
    if (stopping) return
    messagesA++
    bytesA += writeLine(streamA, JSON.stringify({ conn: 'A', receivedAtMs: Date.now(), envelope: message }))
    checkOutputLimit()
  },
  onOpen: () => writeEvent({ type: 'open', conn: 'A' }),
  onSubscriptionSent: () => writeEvent({ type: 'subscription-sent', conn: 'A' }),
  onSubscribed: () => writeEvent({ type: 'subscription-confirmed', conn: 'A' }),
  // RISK-1 safety fix #1 backstop: this should never actually fire (see
  // decideOnClose's comment in capacityCore.ts for why the ordering
  // already prevents it) -- if it does, something is wrong with that
  // assumption and the tool stops rather than trusting a live reconnect.
  onReconnectAttempt: (delayMs) => {
    writeEvent({ type: 'reconnect-attempt', conn: 'A', delayMs })
    void stop({ kind: 'unexpected-reconnect', conn: 'A' })
  },
  onClose: (code, reason) => {
    writeEvent({ type: 'close', conn: 'A', code, reason })
    const stopReason = decideOnClose(stopping, 'A', code, reason)
    if (stopReason) void stop(stopReason)
  },
  // A close always follows an error on a WebSocket -- onClose decides
  // whether to stop; onError only records that an error happened.
  onError: (err) => {
    writeEvent({ type: 'error', conn: 'A', message: err.message })
  },
})

const clientB: CaptureClient = new AisStreamClient(apiKey, buildSubscriptionB(FILTER_MESSAGE_TYPES), {
  onMessage: (message: AisStreamMessage) => {
    if (stopping) return
    messagesB++
    bytesB += writeLine(streamB, JSON.stringify({ conn: 'B', receivedAtMs: Date.now(), envelope: message }))
    checkOutputLimit()
  },
  onOpen: () => writeEvent({ type: 'open', conn: 'B' }),
  onSubscriptionSent: () => writeEvent({ type: 'subscription-sent', conn: 'B' }),
  onSubscribed: () => writeEvent({ type: 'subscription-confirmed', conn: 'B' }),
  onReconnectAttempt: (delayMs) => {
    writeEvent({ type: 'reconnect-attempt', conn: 'B', delayMs })
    void stop({ kind: 'unexpected-reconnect', conn: 'B' })
  },
  onClose: (code, reason) => {
    writeEvent({ type: 'close', conn: 'B', code, reason })
    const stopReason = decideOnClose(stopping, 'B', code, reason)
    if (stopReason) void stop(stopReason)
  },
  onError: (err) => {
    writeEvent({ type: 'error', conn: 'B', message: err.message })
  },
})

clientA.connect()
clientB.connect()

scheduleResubscribes(
  clientB,
  (fn, delayMs) => setTimeout(fn, delayMs),
  (minute) => writeEvent({ type: 'resubscribe', conn: 'B', minute }),
)

setTimeout(() => {
  void stop({ kind: 'duration' })
}, DURATION_MIN * 60_000)

process.on('SIGINT', () => {
  void stop({ kind: 'sigint' })
})

// RISK-1 safety fix #2: closing the console window on Windows raises
// SIGHUP, not SIGINT, and the OS kills the process ~10s later if nothing
// has exited by then -- comfortably after the 5s close cap, but only if
// this handler actually runs the same graceful path SIGINT does.
process.on('SIGHUP', () => {
  void stop({ kind: 'sighup' })
})

// RISK-1 safety fix #2: without these, an uncaught exception or an
// unhandled promise rejection exits the process immediately, closing
// neither AISstream connection -- exactly the ghost-connection risk
// CLAUDE.md's hard constraint #1 exists to avoid. The existing `stopping`
// flag (checked inside stop()) makes a second trigger during the stop
// sequence itself a no-op rather than a re-entrant crash.
process.on('uncaughtException', (err) => {
  console.error('[Wake:capacity] Uncaught exception:', err)
  writeEvent({ type: 'crash', message: err.message, stack: err.stack })
  void stop({ kind: 'crash', message: err.message })
})

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error('[Wake:capacity] Unhandled rejection:', reason)
  writeEvent({ type: 'crash', message })
  void stop({ kind: 'crash', message })
})

statusInterval = setInterval(() => {
  const elapsedMin = (Date.now() - startedAtMs) / 60_000
  const elapsedSec = (Date.now() - startedAtMs) / 1000
  const p99Ms = eventLoopDelay.percentile(99) / 1e6
  const maxMs = eventLoopDelay.max / 1e6
  writeEvent({ type: 'loop-delay', p99Ms, maxMs })
  console.log(
    `[Wake:capacity] elapsed ${elapsedMin.toFixed(1)}min` +
      `  A: ${messagesA} msgs (${(messagesA / elapsedSec).toFixed(2)}/s)` +
      `  B: ${messagesB} msgs (${(messagesB / elapsedSec).toFixed(2)}/s)` +
      `  total output: ${(totalOutputBytes() / (1024 * 1024)).toFixed(2)}MB` +
      `  loop p99: ${p99Ms.toFixed(1)}ms`,
  )
  eventLoopDelay.reset()
}, STATUS_INTERVAL_MS)
