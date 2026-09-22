import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize } from '../normalize.ts'
import { parseCaptureLines, type CaptureRecord } from '../replayCore.ts'
import { DOVER_BOX, PRESET_BOXES } from './capacityCore.ts'

// Offline, no network. Reads a capture directory produced by
// capacityCapture.ts (A.ndjson, B.ndjson, events.ndjson) and reports the
// numbers the RISK-1 PASS/FAIL/INCONCLUSIVE decision needs. Never called
// from any test file with real files from a live run in this session --
// see the self-check at the bottom of this file's companion script,
// which is what risk1-review.txt actually runs.

// --- Parsing ---------------------------------------------------------------

export interface EnvelopeMeta {
  mmsi: string // raw MetaData.MMSI_String, stringified -- not zero-padded, matching the envelope literally
  messageType: string
  timeUtcRaw: string | undefined
  lat: number | undefined
  lon: number | undefined
  kind: 'position' | 'static' | 'other'
  // Inner Message.<MessageType> fields, position messages only -- RISK-1
  // safety fix #4's loose key. The strict key (MMSI + MessageType + raw
  // MetaData.time_utc) assumes both connections stamp the same time_utc
  // for the same physical AIS message; if AISstream instead timestamps
  // per-connection (undocumented either way), strict overlap would
  // collapse into a false FAIL even though the same messages arrived on
  // both. The inner AIS message's own Latitude/Longitude/Timestamp fields
  // are part of the original 6-minute-resolution AIS transmission itself,
  // not anything AISstream adds on receipt, so they should agree across
  // connections regardless of when each one received the message.
  innerLat: number | undefined
  innerLon: number | undefined
  innerTimestamp: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads exactly what normalize() reads (MetaData.MMSI_String,
 * MetaData.latitude/longitude, MetaData.time_utc, MessageType) so this
 * tool can never disagree with normalize about where a message's position
 * is, per this file's own instruction ("A message's position: MetaData
 * latitude/longitude, read exactly as normalize reads it"). `kind` reuses
 * normalize's own classification rather than re-deriving it.
 */
export function extractMeta(envelope: unknown): EnvelopeMeta | undefined {
  if (!isRecord(envelope)) return undefined
  const messageType = envelope.MessageType
  const metaData = envelope.MetaData
  if (typeof messageType !== 'string' || !isRecord(metaData)) return undefined

  const mmsiRaw = metaData.MMSI_String
  if (typeof mmsiRaw !== 'number' && typeof mmsiRaw !== 'string') return undefined

  const lat = typeof metaData.latitude === 'number' ? metaData.latitude : undefined
  const lon = typeof metaData.longitude === 'number' ? metaData.longitude : undefined
  const timeUtcRaw = typeof metaData.time_utc === 'string' ? metaData.time_utc : undefined

  const normalized = normalize(envelope)
  const kind: EnvelopeMeta['kind'] = normalized?.kind ?? 'other'

  let innerLat: number | undefined
  let innerLon: number | undefined
  let innerTimestamp: number | undefined
  if (kind === 'position' && (messageType === 'PositionReport' || messageType === 'StandardClassBPositionReport')) {
    const message = envelope.Message
    const inner = isRecord(message) ? message[messageType] : undefined
    if (isRecord(inner)) {
      innerLat = typeof inner.Latitude === 'number' ? inner.Latitude : undefined
      innerLon = typeof inner.Longitude === 'number' ? inner.Longitude : undefined
      innerTimestamp = typeof inner.Timestamp === 'number' ? inner.Timestamp : undefined
    }
  }

  return { mmsi: String(mmsiRaw), messageType, timeUtcRaw, lat, lon, kind, innerLat, innerLon, innerTimestamp }
}

/** Strict key: MMSI + MessageType + raw MetaData.time_utc, exactly as this file's instruction specifies. */
export function dedupeKey(meta: EnvelopeMeta): string {
  return `${meta.mmsi}|${meta.messageType}|${meta.timeUtcRaw ?? ''}`
}

/**
 * Loose key (RISK-1 safety fix #4): MMSI + MessageType + the inner
 * message's own Latitude/Longitude/Timestamp -- position messages only,
 * since static messages have no such inner fields. Undefined when any
 * required inner field is missing, so a message that can't form a loose
 * key is simply absent from the loose comparison rather than colliding
 * with other equally-incomplete messages under an empty-string fallback.
 */
export function looseDedupeKey(meta: EnvelopeMeta): string | undefined {
  if (meta.kind !== 'position') return undefined
  if (meta.innerLat === undefined || meta.innerLon === undefined || meta.innerTimestamp === undefined) return undefined
  return `${meta.mmsi}|${meta.messageType}|${meta.innerLat}|${meta.innerLon}|${meta.innerTimestamp}`
}

export interface ProcessedConnection {
  records: CaptureRecord[]
  metas: Array<EnvelopeMeta | undefined>
  keyCounts: Map<string, number>
  malformedCount: number
}

export function processConnection(records: CaptureRecord[], malformedCount: number): ProcessedConnection {
  const metas = records.map((r) => extractMeta(r.envelope))
  const keyCounts = new Map<string, number>()
  for (const meta of metas) {
    if (!meta) continue
    const key = dedupeKey(meta)
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
  }
  return { records, metas, keyCounts, malformedCount }
}

/** Number of EXTRA occurrences beyond the first for each duplicated key (0 if none). */
export function duplicateCount(keyCounts: Map<string, number>): number {
  let dup = 0
  for (const count of keyCounts.values()) {
    if (count > 1) dup += count - 1
  }
  return dup
}

// --- Geometry ----------------------------------------------------------

export function inBox(lat: number, lon: number, corners: number[][]): boolean {
  const [[lat1, lon1], [lat2, lon2]] = corners
  const minLat = Math.min(lat1, lat2)
  const maxLat = Math.max(lat1, lat2)
  const minLon = Math.min(lon1, lon2)
  const maxLon = Math.max(lon1, lon2)
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon
}

// --- Per-box stats -----------------------------------------------------

export interface BoxStats {
  name: string
  messages: number
  positionMessages: number
  staticMessages: number
  uniqueVessels: number
  msgsPerVesselPerMin: number
}

/** CLAUDE.md's Correction 4 definition: total messages / duration-in-minutes / cumulative unique vessels. */
export function computeBoxStats(name: string, box: number[][], conn: ProcessedConnection, durationMin: number): BoxStats {
  const vessels = new Set<string>()
  let messages = 0
  let positionMessages = 0
  let staticMessages = 0

  for (const meta of conn.metas) {
    if (!meta || meta.lat === undefined || meta.lon === undefined) continue
    if (meta.kind === 'other') continue
    if (!inBox(meta.lat, meta.lon, box)) continue

    messages++
    if (meta.kind === 'position') positionMessages++
    if (meta.kind === 'static') staticMessages++
    vessels.add(meta.mmsi)
  }

  const msgsPerVesselPerMin = vessels.size > 0 && durationMin > 0 ? messages / vessels.size / durationMin : 0
  return { name, messages, positionMessages, staticMessages, uniqueVessels: vessels.size, msgsPerVesselPerMin }
}

// --- Dover comparison ----------------------------------------------------

export interface DoverComparison {
  aCount: number
  bCount: number
  aKeysInB: number // count of A's keys also present in B
  bKeysInA: number
  aOverlapShare: number // aKeysInB / aCount -- the PASS/FAIL number
  bOverlapShare: number
}

function keysInDoverBox(conn: ProcessedConnection, keyFn: (meta: EnvelopeMeta) => string | undefined): Set<string> {
  const keys = new Set<string>()
  for (const meta of conn.metas) {
    if (!meta || meta.lat === undefined || meta.lon === undefined) continue
    if (meta.kind === 'other') continue
    if (!inBox(meta.lat, meta.lon, DOVER_BOX)) continue
    const key = keyFn(meta)
    if (key !== undefined) keys.add(key)
  }
  return keys
}

function compareKeysInDoverBox(
  connA: ProcessedConnection,
  connB: ProcessedConnection,
  keyFn: (meta: EnvelopeMeta) => string | undefined,
): DoverComparison {
  const aKeys = keysInDoverBox(connA, keyFn)
  const bKeys = keysInDoverBox(connB, keyFn)

  let aKeysInB = 0
  for (const key of aKeys) if (bKeys.has(key)) aKeysInB++
  let bKeysInA = 0
  for (const key of bKeys) if (aKeys.has(key)) bKeysInA++

  return {
    aCount: aKeys.size,
    bCount: bKeys.size,
    aKeysInB,
    bKeysInA,
    aOverlapShare: aKeys.size > 0 ? aKeysInB / aKeys.size : 0,
    bOverlapShare: bKeys.size > 0 ? bKeysInA / bKeys.size : 0,
  }
}

/** Strict comparison -- MMSI + MessageType + raw MetaData.time_utc. */
export function compareDover(connA: ProcessedConnection, connB: ProcessedConnection): DoverComparison {
  return compareKeysInDoverBox(connA, connB, dedupeKey)
}

/**
 * Loose comparison (RISK-1 safety fix #4) -- MMSI + MessageType + the
 * inner AIS message's own Latitude/Longitude/Timestamp, position messages
 * only. Guards against the strict key's assumption that time_utc is
 * identical across connections: if AISstream stamps each connection
 * separately, this comparison still agrees even though the strict one
 * would not.
 */
export function compareDoverLoose(connA: ProcessedConnection, connB: ProcessedConnection): DoverComparison {
  return compareKeysInDoverBox(connA, connB, looseDedupeKey)
}

// --- Latency -------------------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

// Only position-kind messages carry a parsed time_utc through normalize()
// (VesselFix.timestamp) -- static messages normalize to a shape with no
// exposed timestamp. Latency here is therefore computed over position
// messages only; this is a real constraint of reusing the real normalize,
// not an arbitrary restriction, and is reported as such in the summary.
function latenciesMs(conn: ProcessedConnection): number[] {
  const out: number[] = []
  for (const record of conn.records) {
    const normalized = normalize(record.envelope)
    if (normalized?.kind === 'position') {
      out.push(record.receivedAtMs - normalized.fix.timestamp)
    }
  }
  return out
}

export interface LatencyStats {
  overall: { median: number; p95: number; n: number }
  byWindow: Array<{ windowStart: number; median: number; p95: number; n: number }>
}

/** 10-minute windows, indexed from a shared captureStartMs so A and B's windows line up in real time. */
export function computeLatencyStats(conn: ProcessedConnection, captureStartMs: number): LatencyStats {
  const WINDOW_MS = 10 * 60_000
  const byWindow = new Map<number, number[]>()
  const overall: number[] = []

  for (const record of conn.records) {
    const normalized = normalize(record.envelope)
    if (normalized?.kind !== 'position') continue
    const latency = record.receivedAtMs - normalized.fix.timestamp
    overall.push(latency)
    const windowIndex = Math.floor((record.receivedAtMs - captureStartMs) / WINDOW_MS)
    const arr = byWindow.get(windowIndex) ?? []
    arr.push(latency)
    byWindow.set(windowIndex, arr)
  }

  const byWindowSorted = [...byWindow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([windowIndex, values]) => ({
      windowStart: captureStartMs + windowIndex * WINDOW_MS,
      median: median(values),
      p95: p95(values),
      n: values.length,
    }))

  return {
    overall: { median: median(overall), p95: p95(overall), n: overall.length },
    byWindow: byWindowSorted,
  }
}

// --- B throughput --------------------------------------------------------

export interface ThroughputStats {
  medianMsgsPerSec: number
  maxMsgsPerSec: number
  perMinute: number[]
}

export function computeThroughput(conn: ProcessedConnection, captureStartMs: number): ThroughputStats {
  const perMinuteCounts = new Map<number, number>()
  for (const record of conn.records) {
    const minuteIndex = Math.floor((record.receivedAtMs - captureStartMs) / 60_000)
    perMinuteCounts.set(minuteIndex, (perMinuteCounts.get(minuteIndex) ?? 0) + 1)
  }
  const perMinute = [...perMinuteCounts.entries()].sort(([a], [b]) => a - b).map(([, count]) => count)
  const perSecond = perMinute.map((count) => count / 60)

  return {
    medianMsgsPerSec: median(perSecond),
    maxMsgsPerSec: perSecond.length > 0 ? Math.max(...perSecond) : 0,
    perMinute,
  }
}

// --- Events ----------------------------------------------------------------

export interface CapacityEvent {
  receivedAtMs: number
  type: string
  conn?: 'A' | 'B'
  [key: string]: unknown
}

export function parseEventLines(lines: string[]): CapacityEvent[] {
  const events: CapacityEvent[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (isRecord(parsed) && typeof parsed.receivedAtMs === 'number' && typeof parsed.type === 'string') {
        events.push(parsed as CapacityEvent)
      }
    } catch {
      // malformed event line -- skipped, not thrown, same idiom as parseCaptureLines
    }
  }
  return events
}

export interface EventsSummary {
  closes: CapacityEvent[]
  errors: CapacityEvent[]
  reconnectAttempts: CapacityEvent[]
  resubscribes: CapacityEvent[]
  stop: CapacityEvent | undefined
}

export function summarizeEvents(events: CapacityEvent[]): EventsSummary {
  const closes = events.filter((e) => e.type === 'close')
  const errors = events.filter((e) => e.type === 'error')
  const reconnectAttempts = events.filter((e) => e.type === 'reconnect-attempt')
  const resubscribes = events.filter((e) => e.type === 'resubscribe')
  const stop = events.find((e) => e.type === 'stop')

  return { closes, errors, reconnectAttempts, resubscribes, stop }
}

/** RISK-1 safety fix #4: how many times AISstream confirmed the subscription on this connection. */
export function countSubscriptionConfirmed(events: CapacityEvent[], conn: 'A' | 'B'): number {
  return events.filter((e) => e.type === 'subscription-confirmed' && e.conn === conn).length
}

/** RISK-1 safety fix #3/#4: the worst 60s-window event-loop delay observed over the whole run. */
export function maxLoopDelayP99(events: CapacityEvent[]): number {
  const values = events
    .filter((e) => e.type === 'loop-delay' && typeof e.p99Ms === 'number')
    .map((e) => e.p99Ms as number)
  return values.length > 0 ? Math.max(...values) : 0
}

/**
 * RISK-1 safety fix #1/#4: PASS requires no close before the stop event.
 * The deliberate closes that ARE PART OF a graceful stop happen strictly
 * after the stop event is written (stop() writes it, then awaits
 * runGracefulStop's closeSocket calls), so they never count here -- only
 * a close that happened before anything decided to stop does. No stop
 * event at all (a run that never finished) makes this vacuously false;
 * the missing/non-'duration' stopReasonKind already fails PASS in that
 * case regardless.
 */
export function hasCloseBeforeStop(events: CapacityEvent[], stopEvent: CapacityEvent | undefined): boolean {
  if (!stopEvent) return false
  return events.some((e) => e.type === 'close' && e.receivedAtMs < stopEvent.receivedAtMs)
}

// --- Resubscribe windows -------------------------------------------------

export interface ResubscribeWindow {
  minute: number
  before: { a: number; b: number }
  after: { a: number; b: number }
}

function doverMessageTimestamps(conn: ProcessedConnection): number[] {
  const out: number[] = []
  for (let i = 0; i < conn.records.length; i++) {
    const meta = conn.metas[i]
    if (!meta || meta.lat === undefined || meta.lon === undefined || meta.kind === 'other') continue
    if (!inBox(meta.lat, meta.lon, DOVER_BOX)) continue
    out.push(conn.records[i].receivedAtMs)
  }
  return out
}

export function computeResubscribeWindows(
  events: CapacityEvent[],
  connA: ProcessedConnection,
  connB: ProcessedConnection,
): ResubscribeWindow[] {
  const resubscribes = events.filter((e) => e.type === 'resubscribe')
  const aTimes = doverMessageTimestamps(connA)
  const bTimes = doverMessageTimestamps(connB)
  const WINDOW_MS = 60_000

  return resubscribes.map((event) => {
    const t = event.receivedAtMs
    const countIn = (times: number[], start: number, end: number) => times.filter((ts) => ts >= start && ts < end).length
    return {
      minute: typeof event.minute === 'number' ? event.minute : -1,
      before: { a: countIn(aTimes, t - WINDOW_MS, t), b: countIn(bTimes, t - WINDOW_MS, t) },
      after: { a: countIn(aTimes, t, t + WINDOW_MS), b: countIn(bTimes, t, t + WINDOW_MS) },
    }
  })
}

// --- Verdict ---------------------------------------------------------------

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

/** How far strict and loose A-in-B overlap may diverge before the strict key is treated as unreliable. */
export const KEY_DIVERGENCE_THRESHOLD_PCT = 10
export const LOOP_DELAY_PASS_THRESHOLD_MS = 1000

export interface VerdictInputs {
  strictOverlapPct: number // dover.aOverlapShare * 100
  looseOverlapPct: number // doverLoose.aOverlapShare * 100
  latencyOk: boolean
  stopReasonKind: string | undefined // events.stop's reason.kind, or undefined if the run never recorded a stop
  closeBeforeStop: boolean
  maxLoopDelayP99Ms: number
}

/**
 * Order matters (RISK-1 safety fix #4): the strict/loose divergence check
 * runs FIRST and, on its own, forces INCONCLUSIVE regardless of how low
 * strict overlap is -- a run where the two keys disagree by more than
 * KEY_DIVERGENCE_THRESHOLD_PCT points cannot distinguish "AISstream
 * genuinely dropped messages on B" from "the strict key's same-time_utc
 * assumption doesn't hold," so it must not report FAIL on that basis.
 * Only once the keys agree does strict overlap alone decide PASS/FAIL.
 */
export function computeVerdict(inputs: VerdictInputs): Verdict {
  if (Math.abs(inputs.strictOverlapPct - inputs.looseOverlapPct) > KEY_DIVERGENCE_THRESHOLD_PCT) {
    return 'INCONCLUSIVE'
  }

  const fullDuration = inputs.stopReasonKind === 'duration'
  const loopOk = inputs.maxLoopDelayP99Ms < LOOP_DELAY_PASS_THRESHOLD_MS

  if (inputs.strictOverlapPct >= 95 && inputs.latencyOk && fullDuration && !inputs.closeBeforeStop && loopOk) {
    return 'PASS'
  }
  if (inputs.strictOverlapPct <= 80) return 'FAIL'
  return 'INCONCLUSIVE'
}

// --- Report ----------------------------------------------------------------

export interface AnalysisReport {
  durationMin: number
  captureStartMs: number
  aTotal: { messages: number; malformed: number; duplicates: number }
  bTotal: { messages: number; malformed: number; duplicates: number }
  dover: DoverComparison
  doverLoose: DoverComparison
  keyDivergent: boolean
  presetsOnB: BoxStats[]
  doverOnA: BoxStats
  doverOnB: BoxStats
  latencyA: LatencyStats
  latencyB: LatencyStats
  throughputB: ThroughputStats
  resubscribeWindows: ResubscribeWindow[]
  events: EventsSummary
  subscriptionConfirmedA: number
  subscriptionConfirmedB: number
  maxLoopDelayP99Ms: number
  verdict: Verdict
}

export function analyse(connA: ProcessedConnection, connB: ProcessedConnection, events: CapacityEvent[]): AnalysisReport {
  const allTimestamps = [...connA.records, ...connB.records].map((r) => r.receivedAtMs)
  const captureStartMs = allTimestamps.length > 0 ? Math.min(...allTimestamps) : 0
  const captureEndMs = allTimestamps.length > 0 ? Math.max(...allTimestamps) : 0
  const durationMin = Math.max((captureEndMs - captureStartMs) / 60_000, 1 / 60)

  const dover = compareDover(connA, connB)
  const doverLoose = compareDoverLoose(connA, connB)
  const presetsOnB = PRESET_BOXES.map((p) => computeBoxStats(p.name, p.box, connB, durationMin))
  const doverOnA = computeBoxStats('DOVER', DOVER_BOX, connA, durationMin)
  const doverOnB = computeBoxStats('DOVER', DOVER_BOX, connB, durationMin)

  const latencyA = computeLatencyStats(connA, captureStartMs)
  const latencyB = computeLatencyStats(connB, captureStartMs)
  const throughputB = computeThroughput(connB, captureStartMs)

  const eventsSummary = summarizeEvents(events)
  const resubscribeWindows = computeResubscribeWindows(events, connA, connB)

  const subscriptionConfirmedA = countSubscriptionConfirmed(events, 'A')
  const subscriptionConfirmedB = countSubscriptionConfirmed(events, 'B')
  const maxLoopDelayP99Ms = maxLoopDelayP99(events)
  const closeBeforeStop = hasCloseBeforeStop(events, eventsSummary.stop)
  const stopReasonKind =
    eventsSummary.stop && isRecord(eventsSummary.stop.reason)
      ? (eventsSummary.stop.reason as { kind?: unknown }).kind
      : undefined

  const strictOverlapPct = dover.aOverlapShare * 100
  const looseOverlapPct = doverLoose.aOverlapShare * 100
  const latencyOk = latencyB.overall.p95 <= latencyA.overall.p95 + 5000
  const keyDivergent = Math.abs(strictOverlapPct - looseOverlapPct) > KEY_DIVERGENCE_THRESHOLD_PCT

  const verdict = computeVerdict({
    strictOverlapPct,
    looseOverlapPct,
    latencyOk,
    stopReasonKind: typeof stopReasonKind === 'string' ? stopReasonKind : undefined,
    closeBeforeStop,
    maxLoopDelayP99Ms,
  })

  return {
    durationMin,
    captureStartMs,
    aTotal: { messages: connA.records.length, malformed: connA.malformedCount, duplicates: duplicateCount(connA.keyCounts) },
    bTotal: { messages: connB.records.length, malformed: connB.malformedCount, duplicates: duplicateCount(connB.keyCounts) },
    dover,
    doverLoose,
    keyDivergent,
    presetsOnB,
    doverOnA,
    doverOnB,
    latencyA,
    latencyB,
    throughputB,
    resubscribeWindows,
    events: eventsSummary,
    subscriptionConfirmedA,
    subscriptionConfirmedB,
    maxLoopDelayP99Ms,
    verdict,
  }
}

// --- I/O ---------------------------------------------------------------

function readNdjson(filePath: string): { records: CaptureRecord[]; malformedCount: number } {
  if (!fs.existsSync(filePath)) return { records: [], malformedCount: 0 }
  const content = fs.readFileSync(filePath, 'utf8')
  return parseCaptureLines(content.split('\n'))
}

function readEvents(filePath: string): CapacityEvent[] {
  if (!fs.existsSync(filePath)) return []
  const content = fs.readFileSync(filePath, 'utf8')
  return parseEventLines(content.split('\n'))
}

export function analyseCaptureDir(captureDir: string): AnalysisReport {
  const a = readNdjson(path.join(captureDir, 'A.ndjson'))
  const b = readNdjson(path.join(captureDir, 'B.ndjson'))
  const events = readEvents(path.join(captureDir, 'events.ndjson'))

  const connA = processConnection(a.records, a.malformedCount)
  const connB = processConnection(b.records, b.malformedCount)

  return analyse(connA, connB, events)
}

function formatReport(report: AnalysisReport): string {
  const lines: string[] = []
  const push = (s: string) => lines.push(s)

  push(`Duration: ${report.durationMin.toFixed(1)} min`)
  push(`A: ${report.aTotal.messages} messages, ${report.aTotal.malformed} malformed, ${report.aTotal.duplicates} duplicate occurrences`)
  push(`B: ${report.bTotal.messages} messages, ${report.bTotal.malformed} malformed, ${report.bTotal.duplicates} duplicate occurrences`)
  push('')
  push('--- Dover comparison (Dover-box messages only, both connections) ---')
  push('Strict key: MMSI + MessageType + raw MetaData.time_utc')
  push(`  A Dover messages: ${report.dover.aCount}   B Dover messages: ${report.dover.bCount}`)
  push(`  A keys present in B: ${report.dover.aKeysInB} (${(report.dover.aOverlapShare * 100).toFixed(1)}%)`)
  push(`  B keys present in A: ${report.dover.bKeysInA} (${(report.dover.bOverlapShare * 100).toFixed(1)}%)`)
  push('Loose key: MMSI + MessageType + inner message Latitude/Longitude/Timestamp (position only)')
  push(`  A Dover messages: ${report.doverLoose.aCount}   B Dover messages: ${report.doverLoose.bCount}`)
  push(`  A keys present in B: ${report.doverLoose.aKeysInB} (${(report.doverLoose.aOverlapShare * 100).toFixed(1)}%)`)
  push(`  B keys present in A: ${report.doverLoose.bKeysInA} (${(report.doverLoose.bOverlapShare * 100).toFixed(1)}%)`)
  if (report.keyDivergent) {
    push('time_utc differs between connections; strict key unreliable')
  }
  push('')
  push('--- Per-preset stats on B ---')
  for (const p of report.presetsOnB) {
    push(
      `${p.name}: ${p.messages} msgs (${p.positionMessages} position, ${p.staticMessages} static), ` +
        `${p.uniqueVessels} vessels, ${p.msgsPerVesselPerMin.toFixed(3)} msgs/vessel/min`,
    )
  }
  push('')
  push('--- Dover, on A vs on B ---')
  for (const d of [report.doverOnA, report.doverOnB]) {
    push(
      `${d === report.doverOnA ? 'A' : 'B'}: ${d.messages} msgs (${d.positionMessages} position, ${d.staticMessages} static), ` +
        `${d.uniqueVessels} vessels, ${d.msgsPerVesselPerMin.toFixed(3)} msgs/vessel/min`,
    )
  }
  push('')
  push('--- Latency (receivedAtMs - parsed time_utc), position messages only ---')
  push(`A overall: median ${report.latencyA.overall.median.toFixed(0)}ms, p95 ${report.latencyA.overall.p95.toFixed(0)}ms, n=${report.latencyA.overall.n}`)
  push(`B overall: median ${report.latencyB.overall.median.toFixed(0)}ms, p95 ${report.latencyB.overall.p95.toFixed(0)}ms, n=${report.latencyB.overall.n}`)
  push('A by 10-min window:')
  for (const w of report.latencyA.byWindow) push(`  +${((w.windowStart - report.captureStartMs) / 60000).toFixed(0)}min: median ${w.median.toFixed(0)}ms, p95 ${w.p95.toFixed(0)}ms, n=${w.n}`)
  push('B by 10-min window:')
  for (const w of report.latencyB.byWindow) push(`  +${((w.windowStart - report.captureStartMs) / 60000).toFixed(0)}min: median ${w.median.toFixed(0)}ms, p95 ${w.p95.toFixed(0)}ms, n=${w.n}`)
  push('')
  push('--- B throughput (msgs/s per minute) ---')
  push(`median ${report.throughputB.medianMsgsPerSec.toFixed(2)}/s, max ${report.throughputB.maxMsgsPerSec.toFixed(2)}/s`)
  push('')
  push('--- Around each resubscribe (60s before / 60s after, Dover messages) ---')
  for (const w of report.resubscribeWindows) {
    push(`minute ${w.minute}: before A=${w.before.a} B=${w.before.b}   after A=${w.after.a} B=${w.after.b}`)
  }
  push('')
  push('--- Events ---')
  push(`closes: ${report.events.closes.length}  (${report.events.closes.map((c) => `${c.conn}:${c.code}`).join(', ')})`)
  push(`errors: ${report.events.errors.length}`)
  push(`reconnect attempts: ${report.events.reconnectAttempts.length}`)
  push(`resubscribes: ${report.events.resubscribes.length}`)
  push(`subscription confirmations: A=${report.subscriptionConfirmedA} B=${report.subscriptionConfirmedB}`)
  push(`max loop-delay p99: ${report.maxLoopDelayP99Ms.toFixed(1)}ms`)
  push(`stop: ${report.events.stop ? JSON.stringify(report.events.stop.reason) : '(none recorded)'}`)
  push('')
  push(`VERDICT: ${report.verdict}`)

  return lines.join('\n')
}

// --- CLI entry -----------------------------------------------------------

const isMainModule = Boolean(process.argv[1]) && path.resolve(process.argv[1] as string) === fileURLToPath(import.meta.url)

if (isMainModule) {
  const captureDir = process.argv[2]
  if (!captureDir) {
    console.error('Usage: tsx capacityAnalyse.ts <capture-directory>')
    process.exit(1)
  }
  const report = analyseCaptureDir(captureDir)
  console.log(formatReport(report))
}
