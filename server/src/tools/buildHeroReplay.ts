/**
 * LANDING-HERO — builds the marketing hero's replay asset from a real
 * recorded AIS capture.
 *
 * Build-time only, run with tsx. It opens no socket and reads no key: it
 * takes an on-disk NDJSON capture and runs it through THE SERVER'S OWN
 * pipeline (parseCaptureLines -> processEnvelope -> normalize ->
 * mergeStatic -> broadcastToClients), collecting the BroadcastMessage
 * stream a real connected display would have received, and writes that
 * stream out as JSON.
 *
 * It lives here, in server/src/tools/ beside capacityCapture.ts, and not
 * in landing/, for one reason: normalize.ts and pipeline.ts belong to
 * @wake/server, and the landing package deliberately has no dependency on
 * them (the same boundary apps/display keeps -- see wakeSocket.ts's
 * comment on why the backoff constants are duplicated rather than
 * imported). Running the real pipeline HERE and shipping its output means
 * the browser bundle never has to.
 *
 * The emitted messages carry no timestamp of their own. Every fix's
 * timestamp is rewritten to the real clock at the moment it is applied,
 * exactly as server/src/replayCore.ts's rewriteFixTimestamp does for
 * replay mode and for the same reason: capture stamps are from 14
 * September, and fed raw against a real clock every vessel is instantly
 * past removeSec and nothing renders. `t` is therefore a millisecond
 * OFFSET from the start of the capture, not a wall-clock time.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCaptureLines } from '../replayCore.ts'
import { processEnvelope, type PipelineContext } from '../pipeline.ts'
import { createPositionMap, createStaticMap } from '../caches.ts'
import type { ClientSocket } from '../broadcast.ts'
import { DEFAULT_CONFIG } from '@wake/shared'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

const CAPTURE_PATH =
  process.env.HERO_CAPTURE_PATH ?? path.join(REPO_ROOT, 'server', 'server', 'captures', 'dover-30min.ndjson')
const OUT_PATH = process.env.HERO_OUT_PATH ?? path.join(REPO_ROOT, 'landing', 'src', 'heroReplay.data.json')

/**
 * Where the loop starts. The capture opens cold -- AISstream's own
 * discovery takes minutes to plateau (CLAUDE.md: "Cumulative discovery is
 * not population"), so a hero that started at t=0 would open on an empty
 * sea. Everything before this offset is applied instantly at page load,
 * so the first painted frame already carries a full fleet; the loop then
 * plays forward from here in real time and returns here when it ends.
 *
 * 900_000 is removeSec's own window (DEFAULT_CONFIG.removeSec, 900s),
 * which is the window the project's concurrent-population figure of ~92
 * vessels is measured over -- so priming to exactly it is priming to a
 * full, measured population rather than an arbitrary head start.
 */
const PRIME_MS = Number(process.env.HERO_PRIME_MS ?? DEFAULT_CONFIG.removeSec * 1000)

export interface HeroReplayRecord {
  /** Milliseconds from the start of the capture. */
  t: number
  /** The BroadcastMessage the server produced, verbatim. */
  m: unknown
}

export interface HeroReplayData {
  areaKey: string
  sourceCapture: string
  captureSpanMs: number
  primeMs: number
  records: HeroReplayRecord[]
}

function collectBroadcastStream(capturePath: string): { records: HeroReplayRecord[]; spanMs: number; malformed: number } {
  const content = fs.readFileSync(capturePath, 'utf8')
  const { records: captured, malformedCount } = parseCaptureLines(content.split('\n'))
  if (captured.length === 0) throw new Error(`capture produced no records: ${capturePath}`)

  const captureStartMs = Math.min(...captured.map((r) => r.receivedAtMs))
  const captureEndMs = Math.max(...captured.map((r) => r.receivedAtMs))

  const out: HeroReplayRecord[] = []

  // A ClientSocket that records instead of sending. readyState 1 is OPEN
  // (ws's own constant); bufferedAmount 0 keeps it under
  // BUFFERED_AMOUNT_LIMIT_BYTES so trySend never drops it as a slow
  // consumer.
  let currentOffsetMs = 0
  const recorder: ClientSocket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string) {
      out.push({ t: currentOffsetMs, m: JSON.parse(data) })
    },
    close() {},
    once() {},
  }

  const ctx: PipelineContext = {
    positionMap: createPositionMap(),
    staticMap: createStaticMap(),
    clients: new Set<ClientSocket>([recorder]),
    removeSec: DEFAULT_CONFIG.removeSec,
  }

  for (const record of captured) {
    currentOffsetMs = record.receivedAtMs - captureStartMs
    // nowMs is synthetic capture time, so evictStalePositions inside
    // processEnvelope sees the same elapsed time the real run saw.
    processEnvelope(record.envelope, ctx, captureStartMs + currentOffsetMs)
  }

  return { records: out, spanMs: captureEndMs - captureStartMs, malformed: malformedCount }
}

function main(): void {
  const { records, spanMs, malformed } = collectBroadcastStream(CAPTURE_PATH)

  // fix.timestamp is rewritten on apply and never read from the asset;
  // zeroing it keeps a stale absolute time out of a shipped file and off
  // a public page.
  for (const record of records) {
    const m = record.m as { kind?: string; fix?: { timestamp?: number } }
    if (m.kind === 'position' && m.fix) m.fix.timestamp = 0
  }

  const data: HeroReplayData = {
    areaKey: 'dover',
    sourceCapture: path.basename(CAPTURE_PATH),
    captureSpanMs: spanMs,
    primeMs: PRIME_MS,
    records,
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(data))

  const positions = records.filter((r) => (r.m as { kind: string }).kind === 'position').length
  const statics = records.length - positions
  const primed = records.filter((r) => r.t <= PRIME_MS).length
  console.log(`[hero] capture      : ${CAPTURE_PATH}`)
  console.log(`[hero] span         : ${(spanMs / 1000).toFixed(1)}s, ${malformed} malformed line(s) skipped`)
  console.log(`[hero] messages     : ${records.length} (${positions} position, ${statics} static)`)
  console.log(`[hero] primed at t<=: ${PRIME_MS}ms -> ${primed} messages applied before the first frame`)
  console.log(`[hero] out          : ${OUT_PATH} (${fs.statSync(OUT_PATH).size} bytes)`)
}

main()
