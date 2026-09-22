import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AisStreamClient, type AisSocket } from '../aisstream.ts'
import { closeSocket, CLOSE_TIMEOUT_MS, type CloseableSocket } from '../shutdown.ts'
import {
  buildSubscriptionA,
  buildSubscriptionB,
  PRESET_BOXES,
  DOVER_BOX,
  RESUBSCRIBE_MINUTES,
  scheduleResubscribes,
  exceedsOutputLimit,
  MAX_OUTPUT_BYTES,
  isAuthOrLimitSignal,
  decideOnClose,
  parseDurationMin,
  isWritable,
  exitAfterStreams,
  runGracefulStop,
  stopExitCode,
  resolveCaptureDir,
  utcTimestampForDirName,
  shouldRefuseStart,
  type CaptureClient,
  type StopReason,
} from './capacityCore.ts'
import { computeVerdict, type VerdictInputs } from './capacityAnalyse.ts'

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

// Same pattern as aisstream.test.ts's MockSocket / broadcast.test.ts's
// MockClient: a plain object satisfying the narrow structural interface,
// no real networking.
class MockSocket implements AisSocket {
  readyState = 1 // OPEN
  sent: string[] = []
  private listeners: Record<string, Array<(...args: any[]) => void>> = {}

  on(event: string, listener: (...args: any[]) => void): void {
    ;(this.listeners[event] ??= []).push(listener)
  }

  once(event: string, listener: (...args: any[]) => void): void {
    this.on(event, listener)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3 // CLOSED -- does NOT fire a 'close' event; scenario 3 needs a socket whose close never completes
  }

  fire(event: string, ...args: any[]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args)
  }
}

function makeClient(
  apiKey: string,
  subscription: ReturnType<typeof buildSubscriptionA>,
  socket: MockSocket,
): AisStreamClient {
  return new AisStreamClient(apiKey, subscription, { onMessage: () => {} }, undefined, () => socket)
}

// Scenario 1a: exact subscription JSON for A, boxes in order.
{
  const socket = new MockSocket()
  const filterMessageTypes = ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData']
  const client = makeClient('test-key', buildSubscriptionA(filterMessageTypes), socket)
  client.connect()
  socket.fire('open')

  const expected =
    '{"APIKey":"test-key","BoundingBoxes":[[[51.4,0.9],[50.8,2]]],"FilterMessageTypes":["PositionReport","StandardClassBPositionReport","ShipStaticData"]}'
  assert(socket.sent[0] === expected, `connection A subscription is Dover-only (got ${socket.sent[0]})`)
  client.stopReconnecting()
}

// Scenario 1b: exact subscription JSON for B -- 7 presets in PRD order,
// then Dover, same filter as A.
{
  const socket = new MockSocket()
  const filterMessageTypes = ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData']
  const client = makeClient('test-key', buildSubscriptionB(filterMessageTypes), socket)
  client.connect()
  socket.fire('open')

  // Hardcoded by hand from PRD §6.1 (wake_prd.md:160-168), PRD row order,
  // Dover appended last.
  const expected =
    '{"APIKey":"test-key","BoundingBoxes":[' +
    '[[50.5,-2],[52,3]],' + // English Channel
    '[[40.9,28.9],[41.3,29.2]],' + // Bosphorus
    '[[1,103],[6,104.5]],' + // Strait of Malacca
    '[[51.8,3.8],[52,4.5]],' + // Rotterdam Approach
    '[[-34,151.1],[-33.7,151.5]],' + // Sydney Heads
    '[[29.9,32.5],[31.3,32.7]],' + // Suez Canal
    '[[1.1,103.6],[1.5,104.1]],' + // Singapore Strait
    '[[51.4,0.9],[50.8,2]]' + // Dover, last
    '],"FilterMessageTypes":["PositionReport","StandardClassBPositionReport","ShipStaticData"]}'
  assert(socket.sent[0] === expected, `connection B subscription is 7 presets + Dover, in order (got ${socket.sent[0]})`)
  assert(PRESET_BOXES.length === 7, `exactly 7 presets defined (got ${PRESET_BOXES.length})`)
  assert(
    JSON.stringify(PRESET_BOXES[PRESET_BOXES.length - 1].box) !== JSON.stringify(DOVER_BOX),
    'Dover is not one of the 7 named presets (it is appended separately)',
  )
  client.stopReconnecting()
}

// Scenario 2: resubscribe fires at minute 20 and minute 40, and at no
// other time. Fake scheduleFn records (fn, delayMs) with no real waiting;
// each recorded fn is invoked manually to simulate elapsed time.
{
  const calls: number[] = []
  const scheduled: Array<{ fn: () => void; delayMs: number }> = []
  const fakeScheduleFn = (fn: () => void, delayMs: number) => {
    scheduled.push({ fn, delayMs })
    return undefined
  }
  const target: CaptureClient = {
    connect: () => {},
    resubscribe: () => calls.push(calls.length),
    getSocket: () => undefined,
    stopReconnecting: () => {},
  }

  const resubscribedMinutes: number[] = []
  scheduleResubscribes(target, fakeScheduleFn, (minute) => resubscribedMinutes.push(minute))

  assert(scheduled.length === 2, `exactly 2 scheduleFn calls for resubscribe (got ${scheduled.length})`)
  assert(
    scheduled[0].delayMs === 20 * 60_000 && scheduled[1].delayMs === 40 * 60_000,
    `delays are exactly minute 20 and minute 40 in ms (got ${scheduled.map((s) => s.delayMs)})`,
  )
  assert(
    JSON.stringify([...RESUBSCRIBE_MINUTES]) === JSON.stringify([20, 40]),
    `RESUBSCRIBE_MINUTES is [20, 40] (got ${JSON.stringify(RESUBSCRIBE_MINUTES)})`,
  )

  for (const { fn } of scheduled) fn()
  assert(calls.length === 2, `resubscribe() called exactly twice total (got ${calls.length})`)
  assert(
    JSON.stringify(resubscribedMinutes) === JSON.stringify([20, 40]),
    `resubscribe fired at minute 20 then minute 40, no other time (got ${JSON.stringify(resubscribedMinutes)})`,
  )
}

// Scenario 3: the duration stop closes both connections and exits at the
// 5s cap even if close never completes. Uses the REAL closeSocket from
// shutdown.ts (not a fake) against a mock socket whose close() never
// fires a 'close' event -- this is the one scenario in this file that
// waits out a real timer (CLOSE_TIMEOUT_MS, 5000ms), because closeSocket
// is not clock-injectable and reusing the Wake server's real close path
// (rather than reimplementing it) is what RISK-1's prompt asked for.
async function scenario3(): Promise<void> {
  const socketA = new MockSocket()
  const socketB = new MockSocket()
  let stopReconnectingCalledA = false
  let stopReconnectingCalledB = false

  const clientA: CaptureClient = {
    connect: () => {},
    resubscribe: () => {},
    getSocket: () => socketA as unknown as CloseableSocket,
    stopReconnecting: () => { stopReconnectingCalledA = true },
  }
  const clientB: CaptureClient = {
    connect: () => {},
    resubscribe: () => {},
    getSocket: () => socketB as unknown as CloseableSocket,
    stopReconnecting: () => { stopReconnectingCalledB = true },
  }

  let exitCode: number | undefined
  const start = Date.now()
  await runGracefulStop({
    clientA,
    clientB,
    closeSocket,
    exit: (code) => { exitCode = code },
    reason: { kind: 'duration' },
  })
  const elapsedMs = Date.now() - start

  assert(stopReconnectingCalledA && stopReconnectingCalledB, 'both clients had stopReconnecting() called')
  assert(exitCode === 0, `duration stop exits 0 (got ${exitCode})`)
  assert(
    elapsedMs >= CLOSE_TIMEOUT_MS - 50 && elapsedMs < CLOSE_TIMEOUT_MS + 3000,
    `resolved at the real ${CLOSE_TIMEOUT_MS}ms close cap, not before and not hanging (got ${elapsedMs}ms)`,
  )
}

// Scenario 4: the 500 MB guard stops with exit 1.
{
  assert(exceedsOutputLimit(MAX_OUTPUT_BYTES) === false, 'exactly 500MB does not exceed the guard')
  assert(exceedsOutputLimit(MAX_OUTPUT_BYTES + 1) === true, '500MB + 1 byte exceeds the guard')
  assert(
    stopExitCode({ kind: 'output-limit', totalBytes: MAX_OUTPUT_BYTES + 1 }) === 1,
    'output-limit stop reason exits 1',
  )
}

// Scenario 5: isAuthOrLimitSignal is a text heuristic only (no longer
// gates whether the tool stops -- see decideOnClose below, RISK-1 safety
// fix #1: ANY unplanned close now stops the tool, auth/limit or not).
{
  assert(isAuthOrLimitSignal('Invalid API key') === true, 'detects an invalid-API-key message')
  assert(isAuthOrLimitSignal('connection limit exceeded') === true, 'detects a connection-limit message')
  assert(isAuthOrLimitSignal('Unauthorized') === true, 'detects an unauthorized message')
  assert(isAuthOrLimitSignal('client shutdown') === false, 'an ordinary close reason is not flagged')
  assert(isAuthOrLimitSignal('1000') === false, 'a bare close code is not flagged')
}

// Scenario 8 (RISK-1 safety fix #1): decideOnClose.
{
  assert(decideOnClose(true, 'A', 1006, 'anything') === null, 'stopping already in progress -> null, no second stop')

  const notStopping = decideOnClose(false, 'A', 1006, '(no reason given)')
  assert(notStopping?.kind === 'unexpected-close', `not stopping -> unexpected-close (got ${JSON.stringify(notStopping)})`)
  assert(notStopping?.kind === 'unexpected-close' && notStopping.authOrLimit === false, 'unrecognised reason -> authOrLimit false')

  const authClose = decideOnClose(false, 'B', 1008, 'Api Key Is Not Valid')
  assert(
    authClose?.kind === 'unexpected-close' && authClose.authOrLimit === true,
    `auth-shaped reason -> authOrLimit true (got ${JSON.stringify(authClose)})`,
  )
}

// Scenario 9 (RISK-1 safety fix #1/#2): stopExitCode for every reason kind.
{
  const cases: Array<{ reason: StopReason; expected: number }> = [
    { reason: { kind: 'duration' }, expected: 0 },
    { reason: { kind: 'sigint' }, expected: 0 },
    { reason: { kind: 'sighup' }, expected: 0 },
    { reason: { kind: 'output-limit', totalBytes: 1 }, expected: 1 },
    { reason: { kind: 'unexpected-close', conn: 'A', code: 1006, reason: 'x', authOrLimit: false }, expected: 1 },
    { reason: { kind: 'unexpected-reconnect', conn: 'B' }, expected: 1 },
    { reason: { kind: 'crash', message: 'x' }, expected: 1 },
  ]
  for (const { reason, expected } of cases) {
    assert(stopExitCode(reason) === expected, `stopExitCode(${reason.kind}) === ${expected} (got ${stopExitCode(reason)})`)
  }
}

// Scenario 10 (RISK-1 safety fix #3): parseDurationMin.
{
  const cases: Array<[string | undefined, number | null]> = [
    [undefined, 60],
    ['', 60],
    ['  ', 60],
    ['5', 5],
    ['180', 180],
    ['0', null],
    ['181', null],
    ['abc', null],
  ]
  for (const [raw, expected] of cases) {
    const got = parseDurationMin(raw)
    assert(got === expected, `parseDurationMin(${JSON.stringify(raw)}) === ${expected} (got ${got})`)
  }
}

// Scenario 11 (RISK-1 safety fix #4): verdict, synthetic inputs.
{
  const base: VerdictInputs = {
    strictOverlapPct: 99,
    looseOverlapPct: 99,
    latencyOk: true,
    stopReasonKind: 'duration',
    closeBeforeStop: false,
    maxLoopDelayP99Ms: 200,
  }
  assert(computeVerdict(base) === 'PASS', `full-duration clean run -> PASS (got ${computeVerdict(base)})`)

  const earlyStop = { ...base, stopReasonKind: 'unexpected-close' }
  assert(computeVerdict(earlyStop) === 'INCONCLUSIVE', `stopped by an unexpected close -> INCONCLUSIVE (got ${computeVerdict(earlyStop)})`)

  const slowLoop = { ...base, maxLoopDelayP99Ms: 1500 }
  assert(computeVerdict(slowLoop) === 'INCONCLUSIVE', `loop-delay p99 over 1000ms -> INCONCLUSIVE (got ${computeVerdict(slowLoop)})`)

  const lowOverlap = { ...base, strictOverlapPct: 70, looseOverlapPct: 72 }
  assert(computeVerdict(lowOverlap) === 'FAIL', `strict 70 / loose 72 (agreeing, both bad) -> FAIL (got ${computeVerdict(lowOverlap)})`)

  const keyMismatch = { ...base, strictOverlapPct: 50, looseOverlapPct: 99 }
  assert(
    computeVerdict(keyMismatch) === 'INCONCLUSIVE',
    `strict 50 / loose 99 (diverge >10pp) -> INCONCLUSIVE, not FAIL (got ${computeVerdict(keyMismatch)})`,
  )
}

// Scenario 6: the output directory resolves identically from two
// different working directories -- the exact doubling trap
// (CLAUDE.md's AIS_CAPTURE_PATH / Correction 20) this design avoids by
// never reading process.cwd() at all.
{
  // This test file sits in server/src/tools/ itself, so its own dirname IS
  // the directory capacityCapture.ts passes in real use -- no fabricated
  // path, and nothing machine-specific.
  const toolDirname = path.dirname(fileURLToPath(import.meta.url))
  // Two directories that certainly exist and certainly differ, derived from
  // the same anchor: the repo root and server/.
  const repoRoot = path.resolve(toolDirname, '..', '..', '..')
  const serverDir = path.resolve(toolDirname, '..', '..')
  const timestamp = utcTimestampForDirName(Date.UTC(2026, 8, 16, 14, 5, 0))
  assert(timestamp === '2026-09-16T14-05-00Z', `timestamp formatted for a Windows-safe dirname (got ${timestamp})`)

  const originalCwd = process.cwd()
  process.chdir(repoRoot)
  const fromRepoRoot = resolveCaptureDir(toolDirname, timestamp)
  process.chdir(serverDir)
  const fromServerDir = resolveCaptureDir(toolDirname, timestamp)
  process.chdir(originalCwd)

  assert(fromRepoRoot === fromServerDir, `resolved path is identical regardless of cwd (got ${fromRepoRoot} vs ${fromServerDir})`)
  assert(
    fromRepoRoot.endsWith('server\\captures\\capacity-2026-09-16T14-05-00Z') ||
      fromRepoRoot.endsWith('server/captures/capacity-2026-09-16T14-05-00Z'),
    `resolved path lands under server/captures/, not server/server/captures/ (got ${fromRepoRoot})`,
  )
}

// Scenario 7: refuses to start when the lock is held.
{
  assert(shouldRefuseStart(() => true) === true, 'refuses to start when the injected lock check reports held')
  assert(shouldRefuseStart(() => false) === false, 'proceeds when the injected lock check reports free')
}

// Scenario 12 (no writes after capture streams end): isWritable.
{
  assert(isWritable({ writableEnded: false, destroyed: false }) === true, 'neither ended nor destroyed -> writable')
  assert(isWritable({ writableEnded: true, destroyed: false }) === false, 'ended -> not writable')
  assert(isWritable({ writableEnded: false, destroyed: true }) === false, 'destroyed -> not writable')
}

// Scenario 13 (no writes after capture streams end): exitAfterStreams
// calls exit() exactly once and releaseLock() exactly once, whichever of
// endStreams()/the fallback wins -- with an injected schedule, no real
// timer involved.
async function scenario13(): Promise<void> {
  // Case A: endStreams never resolves -> exit fires when the fallback fires.
  {
    let releaseLockCalls = 0
    const exitCalls: number[] = []
    let fallbackFn: (() => void) | undefined

    exitAfterStreams({
      endStreams: () => new Promise(() => {}), // never resolves
      releaseLock: () => {
        releaseLockCalls++
      },
      exit: (code) => {
        exitCalls.push(code)
      },
      code: 7,
      fallbackMs: 3000,
      schedule: (fn, delayMs) => {
        assert(delayMs === 3000, `fallback scheduled at fallbackMs (got ${delayMs})`)
        fallbackFn = fn
        return undefined
      },
    })

    assert(exitCalls.length === 0, 'exit not called before the fallback fires (endStreams never resolves)')
    fallbackFn?.()
    assert(
      exitCalls.length === 1 && exitCalls[0] === 7,
      `fallback firing -> exit called once with the code (got ${JSON.stringify(exitCalls)})`,
    )
    fallbackFn?.() // a stray second fire must not call exit twice
    assert(exitCalls.length === 1, 'exit still called only once after a second fallback fire')
    assert(releaseLockCalls === 1, `releaseLock called exactly once (got ${releaseLockCalls})`)
  }

  // Case B: endStreams resolves first -> exit fires from that; the
  // fallback firing afterward is a no-op.
  {
    let releaseLockCalls = 0
    const exitCalls: number[] = []
    let fallbackFn: (() => void) | undefined

    exitAfterStreams({
      endStreams: () => Promise.resolve(),
      releaseLock: () => {
        releaseLockCalls++
      },
      exit: (code) => {
        exitCalls.push(code)
      },
      code: 3,
      fallbackMs: 3000,
      schedule: (fn) => {
        fallbackFn = fn
        return undefined
      },
    })

    // Let the already-resolved endStreams() promise's .then(finish) run --
    // it was scheduled as a microtask before these awaits, so it always
    // runs first.
    await Promise.resolve()
    await Promise.resolve()

    assert(
      exitCalls.length === 1 && exitCalls[0] === 3,
      `endStreams resolving -> exit called once with the code (got ${JSON.stringify(exitCalls)})`,
    )
    fallbackFn?.()
    assert(exitCalls.length === 1, 'fallback firing after endStreams already resolved does not call exit again')
    assert(releaseLockCalls === 1, `releaseLock called exactly once (got ${releaseLockCalls})`)
  }
}

async function main(): Promise<void> {
  await scenario3()
  await scenario13()

  const total = passed + failed
  if (failed === 0) {
    console.log(`\nAll ${total} tests passed`)
    process.exit(0)
  } else {
    console.log(`\n${failed} of ${total} tests failed`)
    process.exit(1)
  }
}

void main()
