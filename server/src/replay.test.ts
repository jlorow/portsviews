import fs from 'node:fs'
import path from 'node:path'
import { isExpired } from '@wake/shared'
import { createPositionMap, createStaticMap, type PositionMap, type StaticMap } from './caches.ts'
import type { ClientSocket } from './broadcast.ts'
import type { PipelineContext } from './pipeline.ts'
import {
  parseCaptureLines,
  readCaptureFile,
  rewriteFixTimestamp,
  scheduleReplay,
  type CaptureRecord,
  type ScheduleFn,
} from './replayCore.ts'

let passed = 0
let failed = 0
let skipped = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    console.log(`[Pass] ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}`)
  }
}

function freshCtx(): PipelineContext {
  return {
    positionMap: createPositionMap(),
    staticMap: createStaticMap(),
    clients: new Set<ClientSocket>(),
    removeSec: 900,
  }
}

// Constructed, not captured -- this file tests the replay scheduling and
// timestamp-rewrite layer built on top of normalize(), not normalize()'s
// own parsing correctness (already covered exhaustively, 48 assertions,
// in normalize.test.ts). Real, structurally-valid shape; synthetic MMSI.
function buildEnvelope(mmsi: string, lat: number, lon: number, timeUtc: string) {
  return {
    MetaData: { MMSI: Number(mmsi), MMSI_String: Number(mmsi), ShipName: 'TEST VESSEL', latitude: lat, longitude: lon, time_utc: timeUtc },
    MessageType: 'PositionReport',
    Message: {
      PositionReport: {
        MessageID: 1, RepeatIndicator: 0, UserID: Number(mmsi), Valid: true, NavigationalStatus: 0,
        RateOfTurn: 0, Sog: 5, PositionAccuracy: true, Longitude: lon, Latitude: lat, Cog: 90,
        TrueHeading: 90, Timestamp: 0, SpecialManoeuvreIndicator: 0, Spare: 0, Raim: false, CommunicationState: 0,
      },
    },
  }
}

function trackingScheduler(): { scheduleFn: ScheduleFn; calls: Array<{ fn: () => void; delayMs: number }> } {
  const calls: Array<{ fn: () => void; delayMs: number }> = []
  const scheduleFn: ScheduleFn = (fn, delayMs) => {
    calls.push({ fn, delayMs })
    return calls.length
  }
  return { scheduleFn, calls }
}

// Fires every not-yet-fired call in registration order, including calls
// newly appended by firing an earlier one (e.g. a loop continuation
// scheduling a fresh pass) -- a growing-queue sweep, not a fixed-length
// loop, so it correctly drains everything a run produces.
function drainAll(calls: Array<{ fn: () => void; delayMs: number }>): void {
  let i = 0
  while (i < calls.length) {
    calls[i].fn()
    i++
  }
}

// Scenario: scheduled delays match the real captured gaps exactly, at
// speed 1. File-dependent -- skips gracefully if the gitignored capture
// is absent, matching broadcast.test.ts's own convention.
{
  const capturePath = 'server/server/captures/dover-30min.ndjson'
  if (!fs.existsSync(capturePath)) {
    console.log(`[SKIP] real-gap replay scenarios: ${capturePath} not present (gitignored)`)
    skipped++
  } else {
    const lines = fs.readFileSync(capturePath, 'utf8').split('\n').filter(Boolean)
    const records: CaptureRecord[] = lines.map((l) => JSON.parse(l))
    const captureStartMs = Math.min(...records.map((r) => r.receivedAtMs))

    const { scheduleFn, calls } = trackingScheduler()
    let clockValue = 0
    scheduleReplay({
      records,
      ctx: freshCtx(),
      speed: 1,
      loop: false,
      scheduleFn,
      clock: () => clockValue,
    })

    assert(calls.length === records.length, `real-gap: one scheduled call per record (${records.length})`)
    const allMatch = records.every((r, i) => calls[i].delayMs === r.receivedAtMs - captureStartMs)
    assert(allMatch, 'real-gap: every scheduled delay exactly matches the real captured relative gap at speed 1')
  }
}

// Scenario: WAKE_REPLAY_SPEED of 2 halves every delay; 0.5 doubles them.
// Synthetic, small, always runs regardless of the capture file.
{
  const t0 = '2026-09-14 22:00:00.000000000 +0000 UTC'
  const t1 = '2026-09-14 22:00:10.000000000 +0000 UTC' // +10s
  const t2 = '2026-09-14 22:00:30.000000000 +0000 UTC' // +30s
  const baseRecords: CaptureRecord[] = [
    { receivedAtMs: 1000, envelope: buildEnvelope('111111111', 51, 1, t0) },
    { receivedAtMs: 11000, envelope: buildEnvelope('111111111', 51, 1, t1) },
    { receivedAtMs: 31000, envelope: buildEnvelope('111111111', 51, 1, t2) },
  ]
  // original relative delays: 0, 10000, 30000

  for (const [speed, expected] of [
    [1, [0, 10000, 30000]],
    [2, [0, 5000, 15000]],
    [0.5, [0, 20000, 60000]],
  ] as const) {
    const { scheduleFn, calls } = trackingScheduler()
    scheduleReplay({ records: baseRecords, ctx: freshCtx(), speed, loop: false, scheduleFn, clock: () => 0 })
    const gotDelays = calls.map((c) => c.delayMs)
    assert(
      JSON.stringify(gotDelays) === JSON.stringify(expected),
      `speed ${speed}x: delays scaled correctly (expected ${JSON.stringify(expected)}, got ${JSON.stringify(gotDelays)})`,
    )
  }
}

// Scenario: a fix's broadcast timestamp equals the simulated Date.now()
// at processing, not the capture's receivedAtMs -- and the same value is
// passed as processEnvelope's nowMs (proven via the eviction scenario
// immediately below, which only passes if nowMs matches the rewrite).
{
  const OLD_CAPTURE_MS = 1000 // a tiny, obviously-not-"now" receivedAtMs
  const SIMULATED_NOW = 5_000_000_000_000 // an arbitrary "current" instant, nowhere near OLD_CAPTURE_MS
  const record: CaptureRecord = {
    receivedAtMs: OLD_CAPTURE_MS,
    envelope: buildEnvelope('222222222', 51, 1, '2026-09-14 22:00:00.000000000 +0000 UTC'),
  }

  const ctx = freshCtx()
  const { scheduleFn, calls } = trackingScheduler()
  scheduleReplay({ records: [record], ctx, speed: 1, loop: false, scheduleFn, clock: () => SIMULATED_NOW })
  calls[0].fn()

  const stored = ctx.positionMap.get('222222222')
  assert(stored !== undefined, 'timestamp-rewrite: vessel stored')
  assert(
    stored?.timestamp === SIMULATED_NOW,
    `timestamp-rewrite: broadcast fix.timestamp equals the simulated clock (${SIMULATED_NOW}), not the raw receivedAtMs (${OLD_CAPTURE_MS}) (got ${stored?.timestamp})`,
  )
}

// Scenario: a vessel processed under rewritten timestamps is NOT expired
// by isExpired immediately -- the regression this design exists to
// prevent (raw capture timestamps read as months old against a real
// clock).
{
  const SIMULATED_NOW = 5_000_000_000_000
  const record: CaptureRecord = {
    receivedAtMs: 1000, // raw capture time, wildly far from SIMULATED_NOW
    envelope: buildEnvelope('333333333', 51, 1, '2026-09-14 22:00:00.000000000 +0000 UTC'),
  }
  const ctx = freshCtx()
  const { scheduleFn, calls } = trackingScheduler()
  scheduleReplay({ records: [record], ctx, speed: 1, loop: false, scheduleFn, clock: () => SIMULATED_NOW })
  calls[0].fn()

  const stored = ctx.positionMap.get('333333333')
  assert(
    stored !== undefined && !isExpired(stored, SIMULATED_NOW, 900),
    'no-instant-expiry: a freshly rewritten fix is not expired at the moment it is stored (the regression this design prevents)',
  )
}

// Scenario: eviction fires at the correct simulated time under rewritten
// stamps -- and this is also the proof that the SAME clock value used
// for the timestamp rewrite is what processEnvelope's nowMs receives,
// since eviction is driven entirely by nowMs comparing stored (rewritten)
// timestamps.
{
  const removeSec = 900
  let clockValue = 5_000_000_000_000
  const recordA: CaptureRecord = {
    receivedAtMs: 1000,
    envelope: buildEnvelope('444444444', 51, 1, '2026-09-14 22:00:00.000000000 +0000 UTC'),
  }
  const recordB: CaptureRecord = {
    receivedAtMs: 2000,
    envelope: buildEnvelope('555555555', 52, 2, '2026-09-14 22:00:01.000000000 +0000 UTC'),
  }
  const ctx = freshCtx()
  const { scheduleFn, calls } = trackingScheduler()
  scheduleReplay({ records: [recordA, recordB], ctx, speed: 1, loop: false, scheduleFn, clock: () => clockValue })

  calls[0].fn() // processes A at clockValue
  assert(ctx.positionMap.has('444444444'), 'eviction-timing: A stored')

  clockValue += removeSec * 1000 - 1 // just before the boundary
  calls[1].fn() // processes B, which also runs eviction at this nowMs
  assert(ctx.positionMap.has('444444444'), 'eviction-timing: A not yet evicted just before removeSec boundary')

  clockValue += 1 // now exactly at the boundary relative to A's stored (rewritten) timestamp
  // Re-run eviction by processing a third, throwaway envelope at the new clock value.
  const recordC: CaptureRecord = {
    receivedAtMs: 3000,
    envelope: buildEnvelope('666666666', 53, 3, '2026-09-14 22:00:02.000000000 +0000 UTC'),
  }
  const { scheduleFn: sf2, calls: calls2 } = trackingScheduler()
  scheduleReplay({ records: [recordC], ctx, speed: 1, loop: false, scheduleFn: sf2, clock: () => clockValue })
  calls2[0].fn()

  assert(!ctx.positionMap.has('444444444'), 'eviction-timing: A evicted exactly at the removeSec boundary against its rewritten timestamp')
}

// Scenario: loop behaviour at end-of-file. Implemented as: resume from
// record 0 with no state cleared -- caches.ts's upsert-in-place already
// overwrites each vessel's entry on its next update, so the boundary is
// a seamless continuation, matching the merge-not-replace principle
// already established for S1.7's reconnect snapshots.
{
  const t0 = '2026-09-14 22:00:00.000000000 +0000 UTC'
  const t1 = '2026-09-14 22:00:05.000000000 +0000 UTC'
  const records: CaptureRecord[] = [
    { receivedAtMs: 1000, envelope: buildEnvelope('777777777', 51, 1, t0) },
    { receivedAtMs: 6000, envelope: buildEnvelope('888888888', 52, 2, t1) },
  ]
  const ctx = freshCtx()
  const { scheduleFn, calls } = trackingScheduler()
  let clockValue = 10_000_000_000_000
  scheduleReplay({ records, ctx, speed: 1, loop: true, scheduleFn, clock: () => clockValue })

  // pass 1: two message calls + one loop-continuation call
  assert(calls.length === 3, `loop: pass 1 schedules 2 messages + 1 loop-continuation call (got ${calls.length})`)
  assert(calls[2].delayMs === 5000, `loop: continuation scheduled at the pass span (5000ms) (got ${calls[2].delayMs})`)

  calls[0].fn()
  calls[1].fn()
  assert(ctx.positionMap.size === 2, 'loop: both vessels present after pass 1')

  clockValue += 5000
  calls[2].fn() // fires the loop continuation -> schedules pass 2's calls
  assert(calls.length === 6, `loop: pass 2 appended 2 more messages + 1 more continuation (got ${calls.length})`)

  calls[3].fn()
  calls[4].fn()
  assert(ctx.positionMap.size === 2, 'loop: still exactly 2 vessels after pass 2 -- no duplication, no clearing at the boundary')
  assert(
    ctx.positionMap.get('777777777')?.timestamp === clockValue,
    'loop: vessel from pass 1 got a fresh (rewritten) timestamp on its pass-2 re-processing, not a stale one',
  )
}

// Scenario: a missing or unreadable WAKE_REPLAY_PATH fails with a clear
// message rather than starting empty.
{
  let threwUnset = false
  let unsetMessage = ''
  try {
    readCaptureFile(undefined)
  } catch (err) {
    threwUnset = true
    unsetMessage = (err as Error).message
  }
  assert(threwUnset, 'missing-path: unset WAKE_REPLAY_PATH throws')
  assert(unsetMessage.includes('WAKE_REPLAY_PATH'), `missing-path: error message names WAKE_REPLAY_PATH (got "${unsetMessage}")`)

  let threwMissing = false
  let missingMessage = ''
  const bogusPath = path.join('server', 'src', 'this-file-does-not-exist.ndjson')
  try {
    readCaptureFile(bogusPath)
  } catch (err) {
    threwMissing = true
    missingMessage = (err as Error).message
  }
  assert(threwMissing, 'missing-path: nonexistent file throws')
  assert(missingMessage.includes(bogusPath), `missing-path: error message names the path (got "${missingMessage}")`)
}

// Scenario: a malformed line in the file is skipped without killing
// replay.
{
  const lines = [
    JSON.stringify({ receivedAtMs: 1000, envelope: buildEnvelope('999999999', 51, 1, '2026-09-14 22:00:00.000000000 +0000 UTC') }),
    '{not valid json at all',
    JSON.stringify({ noReceivedAtMs: true, envelope: {} }), // wrong shape, not malformed JSON
    JSON.stringify({ receivedAtMs: 2000, envelope: buildEnvelope('999999999', 52, 2, '2026-09-14 22:00:01.000000000 +0000 UTC') }),
    '',
  ]
  let threw = false
  let result: ReturnType<typeof parseCaptureLines> | undefined
  try {
    result = parseCaptureLines(lines)
  } catch {
    threw = true
  }
  assert(!threw, 'malformed-line: parseCaptureLines does not throw on a corrupt line')
  assert(result?.records.length === 2, `malformed-line: the 2 good lines are still parsed (got ${result?.records.length})`)
  assert(result?.malformedCount === 2, `malformed-line: the 2 bad lines are counted, not silently dropped (got ${result?.malformedCount})`)
}

// Scenario: structural -- replay.ts's transitive import graph never
// includes aisstream.ts. Reads source text and resolves relative import
// specifiers recursively; never actually imports replay.ts as a module
// (which has top-level side effects, same as index.ts).
{
  function collectRelativeImports(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf8')
    const specifiers: string[] = []
    const importRegex = /(?:import|export)\s+(?:[^'";]*\s+from\s+)?['"](\.[^'"]+)['"]/g
    let match: RegExpExecArray | null
    while ((match = importRegex.exec(content))) {
      specifiers.push(match[1])
    }
    return specifiers
  }

  function transitiveImportGraph(entryFile: string): Set<string> {
    const visited = new Set<string>()
    const queue = [path.resolve(entryFile)]
    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined || visited.has(current)) continue
      visited.add(current)
      if (!fs.existsSync(current)) continue
      for (const spec of collectRelativeImports(current)) {
        const resolved = path.resolve(path.dirname(current), spec)
        if (!visited.has(resolved)) queue.push(resolved)
      }
    }
    return visited
  }

  const graph = transitiveImportGraph('server/src/replay.ts')
  const graphList = [...graph].map((f) => path.relative(process.cwd(), f))
  console.log('[Info] replay.ts transitive import graph:', JSON.stringify(graphList))

  assert(graph.size > 1, 'structural: import graph walk actually visited more than just the entry file (sanity check on the walker itself)')
  const touchesAisstream = [...graph].some((f) => f.endsWith('aisstream.ts'))
  assert(!touchesAisstream, 'structural: replay.ts\'s transitive import graph never includes aisstream.ts')
  // lock.ts IS expected on this graph, via shutdown.ts's unconditional
  // releaseLock() call (kept exactly as the live path already has it).
  // That's fine -- see the comment in replay.ts: acquireLock() is never
  // called, so this never gates startup on the lockfile; a stray grep
  // for "lock.ts" on this graph is not evidence of a problem.
  const touchesLock = [...graph].some((f) => f.endsWith(`${path.sep}lock.ts`))
  assert(touchesLock, 'structural: lock.ts is (correctly) reachable via shutdown.ts\'s releaseLock(), which replay.ts intentionally keeps rather than restructuring')
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed${skipped > 0 ? ` (${skipped} file-dependent scenario skipped)` : ''}`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
