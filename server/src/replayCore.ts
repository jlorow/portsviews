import fs from 'node:fs'
import type { VesselFix } from '@wake/shared'
import { normalize } from './normalize.ts'
import { processEnvelope, type PipelineContext } from './pipeline.ts'

export type ScheduleFn = (fn: () => void, delayMs: number) => unknown
export type ClockFn = () => number

export interface CaptureRecord {
  receivedAtMs: number
  envelope: unknown
}

/**
 * Parses NDJSON capture lines. A malformed line is skipped, not thrown --
 * one corrupt line must not take down the rest of the file, mirroring how
 * normalize() itself never throws on a bad envelope.
 */
export function parseCaptureLines(lines: string[]): { records: CaptureRecord[]; malformedCount: number } {
  const records: CaptureRecord[] = []
  let malformedCount = 0

  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { receivedAtMs?: unknown }).receivedAtMs === 'number' &&
        'envelope' in parsed
      ) {
        records.push({ receivedAtMs: (parsed as CaptureRecord).receivedAtMs, envelope: (parsed as CaptureRecord).envelope })
      } else {
        malformedCount++
      }
    } catch {
      malformedCount++
    }
  }

  return { records, malformedCount }
}

/**
 * Reads and parses a capture file. Throws a clear, specific error if the
 * path is unset, missing, or unreadable -- replay must fail loudly rather
 * than silently starting with zero vessels, which would look identical to
 * "the capture legitimately has nothing in it yet."
 */
export function readCaptureFile(filePath: string | undefined): { records: CaptureRecord[]; malformedCount: number } {
  if (!filePath || filePath.trim() === '') {
    throw new Error(
      'WAKE_REPLAY_PATH is not set. Point it at an NDJSON capture file, e.g. one produced by AIS_CAPTURE_PATH.',
    )
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`WAKE_REPLAY_PATH does not exist: ${filePath}`)
  }

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new Error(`WAKE_REPLAY_PATH could not be read (${filePath}): ${(err as Error).message}`)
  }

  return parseCaptureLines(content.split('\n'))
}

/**
 * Replaces a fix's parsed capture-time timestamp with the real current
 * clock. Applied at the moment of processing, continuously recomputed --
 * not a fixed offset captured once -- so it self-corrects against any
 * scheduling jitter across a long session rather than accumulating drift.
 */
export function rewriteFixTimestamp(fix: VesselFix, nowMs: number): VesselFix {
  return { ...fix, timestamp: nowMs }
}

export interface ReplayDriverOptions {
  records: CaptureRecord[]
  ctx: PipelineContext
  speed: number
  loop: boolean
  scheduleFn: ScheduleFn
  clock: ClockFn
  normalizeFn?: typeof normalize
  onEnvelopeProcessed?: (index: number, total: number, passNumber: number) => void
  onPassStart?: (passNumber: number, total: number) => void
}

/**
 * Paces captured envelopes through processEnvelope at the real relative
 * gaps between their original receivedAtMs values, scaled by speed. Each
 * envelope gets one scheduled call -- not a draining tick -- the same
 * injectable-scheduler shape already proven in server/src/aisstream.ts's
 * backoff and apps/display/src/wakeSocket.ts's reconnect logic, which is
 * what lets a test drive an entire pass with no real waiting.
 *
 * At the moment each envelope is actually processed, nowMs is read from
 * the injected clock once and used both as processEnvelope's nowMs and as
 * the fix's rewritten timestamp, guaranteeing they can never disagree.
 *
 * Looping resumes from record 0 with no state cleared -- the existing
 * upsert-in-place semantics in caches.ts already overwrite each vessel's
 * entry on its next update, so a loop boundary produces a seamless
 * continuation, not a visible reset.
 */
export function scheduleReplay(options: ReplayDriverOptions): void {
  const { records, ctx, speed, loop, scheduleFn, clock, normalizeFn, onEnvelopeProcessed, onPassStart } = options
  if (records.length === 0) return

  const captureStartMs = Math.min(...records.map((r) => r.receivedAtMs))
  const lastRecord = records[records.length - 1]
  const passSpanMs = (lastRecord.receivedAtMs - captureStartMs) / speed

  function runPass(passNumber: number): void {
    onPassStart?.(passNumber, records.length)

    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      const delay = (record.receivedAtMs - captureStartMs) / speed

      scheduleFn(() => {
        const nowMs = clock()
        processEnvelope(record.envelope, ctx, nowMs, normalizeFn, rewriteFixTimestamp)
        onEnvelopeProcessed?.(i, records.length, passNumber)
      }, delay)
    }

    if (loop) {
      scheduleFn(() => runPass(passNumber + 1), passSpanMs)
    }
  }

  runPass(1)
}
