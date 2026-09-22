import path from 'node:path'
import type { SubscriptionConfig } from '../aisstream.ts'
import type { CloseableSocket } from '../shutdown.ts'
import type { ScheduleFn, ClockFn } from '../replayCore.ts'

export type { ScheduleFn, ClockFn }

// Dover box, identical to aisstream.ts's BOUNDING_BOXES default -- kept as
// its own literal here (not imported) so connection A's subscription is
// visibly independent of whatever the Wake server happens to export,
// matching the RISK-1 prompt's "connection A: the Wake server's Dover box
// only" as a value, not a live coupling to index.ts's own defaults.
export const DOVER_BOX: number[][] = [
  [51.4, 0.9],
  [50.8, 2.0],
]

// PRD §6.1 preset table, wake_prd.md:160-168, in PRD order.
export interface PresetBox {
  name: string
  box: number[][]
}

export const PRESET_BOXES: PresetBox[] = [
  { name: 'English Channel', box: [[50.5, -2.0], [52.0, 3.0]] },
  { name: 'Bosphorus', box: [[40.9, 28.9], [41.3, 29.2]] },
  { name: 'Strait of Malacca', box: [[1.0, 103.0], [6.0, 104.5]] },
  { name: 'Rotterdam Approach', box: [[51.8, 3.8], [52.0, 4.5]] },
  { name: 'Sydney Heads', box: [[-34.0, 151.1], [-33.7, 151.5]] },
  { name: 'Suez Canal', box: [[29.9, 32.5], [31.3, 32.7]] },
  { name: 'Singapore Strait', box: [[1.1, 103.6], [1.5, 104.1]] },
]

export function buildSubscriptionA(filterMessageTypes: string[]): SubscriptionConfig {
  return { boundingBoxes: [DOVER_BOX], filterMessageTypes }
}

// 7 presets first (PRD order), Dover last -- matches the prompt's "B: the
// 7 PRD presets plus the Dover box" ordering exactly.
export function buildSubscriptionB(filterMessageTypes: string[]): SubscriptionConfig {
  return {
    boundingBoxes: [...PRESET_BOXES.map((p) => p.box), DOVER_BOX],
    filterMessageTypes,
  }
}

// --- Resubscribe schedule -------------------------------------------------

export const RESUBSCRIBE_MINUTES: readonly number[] = [20, 40]

export interface ResubscribeTarget {
  resubscribe(): void
}

/**
 * Schedules B's two resubscribes (RISK-1's re-send-the-identical-
 * subscription-at-minute-20-and-40 design). Uses the same injectable
 * ScheduleFn/ClockFn shape replayCore.ts already established for
 * fast-forwardable tests -- no real waiting required to prove this fires
 * at exactly 20 and 40 minutes and at no other time.
 */
export function scheduleResubscribes(
  target: ResubscribeTarget,
  scheduleFn: ScheduleFn,
  onResubscribe?: (minute: number) => void,
): void {
  for (const minute of RESUBSCRIBE_MINUTES) {
    scheduleFn(() => {
      target.resubscribe()
      onResubscribe?.(minute)
    }, minute * 60_000)
  }
}

// --- Stop conditions -------------------------------------------------------

export const DEFAULT_DURATION_MIN = 60
export const MIN_DURATION_MIN = 1
export const MAX_DURATION_MIN = 180
export const MAX_OUTPUT_BYTES = 500 * 1024 * 1024

// RISK-1 safety fix #1: an unplanned close used to only stop the tool if
// the close text matched the auth/limit regex -- anything else fell
// through to AisStreamClient's normal backoff-and-reconnect loop, which
// would retry against the live account for the whole planned run (~120
// attempts at a 30s-capped backoff over 60 minutes). 'unexpected-close'
// now covers ANY unplanned close, auth/limit or not; authOrLimit is kept
// as diagnostic information, not a gate on whether to stop.
// 'unexpected-reconnect' is a backstop that should never actually fire --
// stopReconnecting() on both clients runs synchronously inside
// runGracefulStop(), which runs synchronously up to its first await, so
// by the time aisstream.ts's own close handler reaches its
// `if (this.stopped) return` check (immediately after calling onClose),
// stopped is already true and scheduleReconnect() is never reached. If a
// reconnect attempt is ever observed anyway, something has gone wrong
// with that ordering and the tool stops rather than trusting it.
export type StopReason =
  | { kind: 'duration' }
  | { kind: 'sigint' }
  | { kind: 'sighup' }
  | { kind: 'output-limit'; totalBytes: number }
  | { kind: 'unexpected-close'; conn: 'A' | 'B'; code: number; reason: string; authOrLimit: boolean }
  | { kind: 'unexpected-reconnect'; conn: 'A' | 'B' }
  | { kind: 'crash'; message: string }

/** duration/sigint/sighup are planned, clean stops and exit 0; everything else needs human investigation and exits 1. */
export function stopExitCode(reason: StopReason): number {
  return reason.kind === 'duration' || reason.kind === 'sigint' || reason.kind === 'sighup' ? 0 : 1
}

export function exceedsOutputLimit(totalBytes: number): boolean {
  return totalBytes > MAX_OUTPUT_BYTES
}

// AISstream does not document the exact wire-level signal for an auth or
// connection-limit rejection (CLAUDE.md's AISstream section records
// "a 4th [connection] is rejected" but not how). This is a heuristic over
// close-reason/error-message text, not a confirmed protocol fact --
// flagged in risk1-review.txt for verification against the real live run.
// It no longer gates whether the tool stops (see StopReason's comment
// above) -- only whether the stop is labelled authOrLimit for the human
// reading events.ndjson afterward.
const AUTH_OR_LIMIT_PATTERN = /(auth|api[ -]?key|unauthor|forbidden|\blimit\b|reject|too many)/i

export function isAuthOrLimitSignal(text: string): boolean {
  return AUTH_OR_LIMIT_PATTERN.test(text)
}

/**
 * Decides what an unplanned close means. Returns null if the tool is
 * already stopping (the deliberate closes that are PART of a graceful
 * stop must not trigger a second one -- see runGracefulStop below, which
 * always calls stopReconnecting() on both clients before this could ever
 * be asked again for the same run).
 */
export function decideOnClose(stopping: boolean, conn: 'A' | 'B', code: number, reason: string): StopReason | null {
  if (stopping) return null
  return { kind: 'unexpected-close', conn, code, reason, authOrLimit: isAuthOrLimitSignal(reason) }
}

/**
 * undefined or blank -> the default (60); a finite number from 1 to 180
 * inclusive -> that number; anything else (empty after trim only counts
 * as blank, not "anything else") -> null, so the caller can refuse to
 * start with a clear message instead of Number('') silently becoming 0
 * (a duration that ends the run immediately) or Number('abc') silently
 * becoming NaN (which propagates into a setTimeout delay of NaN,
 * scheduling nothing and never stopping the run at all).
 */
export function parseDurationMin(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DURATION_MIN
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (n < MIN_DURATION_MIN || n > MAX_DURATION_MIN) return null
  return n
}

// --- Graceful stop -----------------------------------------------------

export interface CaptureClient {
  connect(): void
  resubscribe(): void
  getSocket(): CloseableSocket | undefined
  stopReconnecting(): void
}

export interface GracefulStopParams {
  clientA: CaptureClient
  clientB: CaptureClient
  closeSocket: (ws: CloseableSocket | null | undefined) => Promise<void>
  exit: (code: number) => void
  reason: StopReason
}

/**
 * The single stop path for both a duration timeout and a SIGINT: stop
 * reconnecting on both connections, close both sockets through the same
 * close-then-5s-cap path shutdown.ts already uses for the Wake server
 * (imported, not reimplemented -- closeSocket handles a socket that never
 * completes its close handshake by resolving anyway at CLOSE_TIMEOUT_MS),
 * then exit with the reason's exit code.
 */
export async function runGracefulStop(params: GracefulStopParams): Promise<void> {
  const { clientA, clientB, closeSocket, exit, reason } = params

  clientA.stopReconnecting()
  clientB.stopReconnecting()

  await Promise.all([closeSocket(clientA.getSocket()), closeSocket(clientB.getSocket())])

  exit(stopExitCode(reason))
}

// --- Output directory resolution -------------------------------------------

/**
 * `capacity-<UTC timestamp>`, colons replaced (illegal in Windows paths).
 * e.g. 2026-09-16T14:05:00.000Z -> capacity-2026-09-16T14-05-00Z
 */
export function utcTimestampForDirName(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Resolved from the tool file's own directory (pass import.meta.url's
 * dirname), never from process.cwd() -- the exact doubling trap
 * CLAUDE.md's Correction 20 and the AIS_CAPTURE_PATH section record
 * (`pnpm --filter` sets cwd to the package directory, so a relative path
 * resolves against the wrong root). server/src/tools/capacityCapture.ts's
 * own dirname is two levels below server/, so captures land at
 * server/captures/capacity-<timestamp>/ regardless of cwd.
 */
export function resolveCaptureDir(toolFileDirname: string, timestampForDirName: string): string {
  return path.resolve(toolFileDirname, '..', '..', 'captures', `capacity-${timestampForDirName}`)
}

// --- Safe shutdown writes -------------------------------------------------

/**
 * False once a stream has ended or been destroyed. If AISstream does not
 * acknowledge a close within the 5s cap, messages (or a status tick, or
 * an error/close event) can keep arriving after the output streams have
 * already been told to end -- a write past that point raises 'error' on
 * a stream with no listener, which becomes an uncaught exception; that
 * handler tries to write an event about the crash to the same ended
 * stream, which errors again, potentially forever, keeping process.exit
 * from ever running.
 */
export function isWritable(stream: { writableEnded: boolean; destroyed: boolean }): boolean {
  return !stream.writableEnded && !stream.destroyed
}

export interface ExitAfterStreamsParams {
  endStreams: () => Promise<void>
  releaseLock: () => void
  exit: (code: number) => void
  code: number
  fallbackMs: number
  schedule: ScheduleFn
}

/**
 * Calls releaseLock() once, starts endStreams(), and calls exit(code)
 * exactly once -- whichever happens first, endStreams resolving or
 * fallbackMs elapsing. Bounds how long the process waits on stream.end()
 * callbacks that may never fire (or may be delayed behind a write racing
 * in from a not-yet-fully-closed socket) so a wedged stream can never
 * keep the process from exiting.
 */
export function exitAfterStreams(params: ExitAfterStreamsParams): void {
  const { endStreams, releaseLock, exit, code, fallbackMs, schedule } = params
  let exited = false

  releaseLock()

  const finish = (): void => {
    if (exited) return
    exited = true
    exit(code)
  }

  schedule(finish, fallbackMs)
  void endStreams().then(finish)
}

// --- Lock gate -----------------------------------------------------------

/**
 * True if the tool must refuse to start. Takes the check as a parameter
 * (rather than calling lock.ts's isLockHeld() directly) so a test can
 * inject a fake answer with no real filesystem or tasklist involved --
 * the real capacityCapture.ts passes lock.ts's real isLockHeld.
 */
export function shouldRefuseStart(isHeld: () => boolean): boolean {
  return isHeld()
}
