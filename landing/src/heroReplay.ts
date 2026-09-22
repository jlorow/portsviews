/**
 * LANDING-HERO — the replay driver behind the marketing page's hero.
 *
 * It contains NO rendering and NO look-alike of one. Its whole job is to
 * hand recorded BroadcastMessages to the display's own client code at the
 * right moments; everything visible is drawn by apps/display's real
 * modules, called from hero.ts.
 *
 * The recorded messages are the literal wire payloads a connected display
 * would have received (built by server/src/tools/buildHeroReplay.ts from
 * the real server pipeline), and they are applied through
 * handleIncomingData -- the same function wakeSocket.ts's onmessage
 * handler calls, given the same JSON string. The only thing this module
 * does to a message is stamp its fix with the clock, for the reason
 * server/src/replayCore.ts's rewriteFixTimestamp exists: capture stamps
 * are from 14 September, and fed raw against a real clock every vessel is
 * instantly past removeSec and nothing renders.
 *
 * Deliberately relative imports rather than a Vite alias. The tests run
 * under tsx and the bundle is built by Vite; an alias would resolve in one
 * and not the other, which is the shape of trap CLAUDE.md's "a command
 * that runs nothing is not a pass" section exists to stop.
 */
import { handleIncomingData, type VesselStateMap } from '../../apps/display/src/wakeSocket'
import { onFixArrived, type TrackedVesselMap } from '../../apps/display/src/vesselTracker'
import type { VesselFix } from '@wake/shared'

export interface HeroReplayRecord {
  /** Milliseconds from the start of the source capture. */
  t: number
  /** The BroadcastMessage the server produced, verbatim. */
  m: unknown
}

export interface HeroReplayData {
  areaKey: string
  sourceCapture: string
  captureSpanMs: number
  /**
   * Capture offset the loop starts at. Everything before it is applied in
   * one step at load, so the first painted frame already carries a full
   * fleet rather than the empty sea the capture genuinely opens on.
   */
  primeMs: number
  records: HeroReplayRecord[]
}

export interface HeroReplayOptions {
  data: HeroReplayData
  tracked: TrackedVesselMap
  clientState: VesselStateMap
}

/**
 * Wall-clock time of a capture offset, given the wall-clock time the loop
 * began. ONE formula covers both the instant prime and live playback:
 * during playback `t - primeMs` is simply the elapsed time, so a record
 * played live is stamped with the current clock, exactly as replay mode
 * stamps it; a primed record is stamped with the past time it actually
 * happened at. That is what makes a vessel whose last fix is 800s old at
 * the prime point render dim, and one 900s old get pruned, instead of the
 * whole cumulative-discovery list appearing uniformly fresh.
 */
export function wallTimeForOffset(offsetMs: number, primeMs: number, originWallMs: number): number {
  return originWallMs + (offsetMs - primeMs)
}

export class HeroReplay {
  private readonly data: HeroReplayData
  private readonly tracked: TrackedVesselMap
  private readonly clientState: VesselStateMap
  private cursor = 0
  private originWallMs = 0
  /** Passes completed; 0 until the first loop boundary is crossed. */
  private loops = 0

  constructor(options: HeroReplayOptions) {
    this.data = options.data
    this.tracked = options.tracked
    this.clientState = options.clientState
  }

  get passCount(): number {
    return this.loops
  }

  /** Capture offset currently being shown. */
  offsetAt(nowMs: number): number {
    return this.data.primeMs + (nowMs - this.originWallMs)
  }

  /**
   * Applies everything up to and including primeMs and anchors the loop
   * at nowMs. Clears both maps first, so calling it again at a loop
   * boundary is a genuine restart rather than a merge onto stale state --
   * a vessel that left the scene during the previous pass must not linger
   * into the next one.
   */
  prime(nowMs: number): void {
    this.tracked.clear()
    this.clientState.clear()
    this.cursor = 0
    this.originWallMs = nowMs
    this.applyThrough(this.data.primeMs)
  }

  /**
   * Advances to whatever capture offset nowMs corresponds to, looping back
   * to the primed state when the capture runs out.
   */
  advance(nowMs: number): void {
    const offset = this.offsetAt(nowMs)
    if (offset > this.data.captureSpanMs) {
      this.loops++
      this.prime(nowMs)
      return
    }
    this.applyThrough(offset)
  }

  private applyThrough(offsetMs: number): void {
    const { records, primeMs } = this.data
    while (this.cursor < records.length && records[this.cursor].t <= offsetMs) {
      const record = records[this.cursor]
      this.cursor++
      const stamped = stampRecord(record, wallTimeForOffset(record.t, primeMs, this.originWallMs))
      handleIncomingData(this.clientState, stamped, (fix: VesselFix) => onFixArrived(this.tracked, fix))
    }
  }
}

/**
 * Returns the record's message as the JSON string the socket would have
 * received, with a position message's fix timestamp set to wallMs. The
 * asset ships every timestamp as 0 (buildHeroReplay.ts zeroes them), so
 * this is the only place a real time enters the replay.
 */
export function stampRecord(record: HeroReplayRecord, wallMs: number): string {
  const message = record.m as { kind?: string; fix?: Record<string, unknown> }
  if (message.kind === 'position' && message.fix) {
    return JSON.stringify({ ...message, fix: { ...message.fix, timestamp: wallMs } })
  }
  return JSON.stringify(message)
}
