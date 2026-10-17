// The radar sweep's on/off switch: the S key, and ?sweep= on the page URL.
// Client-safe and DOM-free, like zoom.ts, so a plain `tsx` test can reach
// every rule. Off is a period of 0, the same value the tune key B cycles
// through, so there is one way for the sweep to be off, not two.

/** The period S brings the sweep back at when nothing earlier is known. */
export const SWEEP_TOGGLE_FALLBACK_SEC = 10

/** The longest period ?sweep= accepts, in seconds. */
export const SWEEP_PARAM_MAX_SEC = 60

export interface SweepKeyEvent {
  key: string
  repeat: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  targetIsEditable: boolean
}

/**
 * 'toggle' for a plain S press, null for anything else. A held key acts
 * once (repeat), and Ctrl, Cmd and Alt combinations stay the browser's --
 * Ctrl+S is "save page" -- the same rules zoomKeyAction applies.
 */
export function sweepKeyAction(event: SweepKeyEvent): 'toggle' | null {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.targetIsEditable) return null
  return event.key === 's' || event.key === 'S' ? 'toggle' : null
}

export interface SweepToggleResult {
  periodSec: number
  lastNonZeroSec: number
}

/**
 * On -> off, remembering the period that was running. Off -> back on at the
 * remembered period, so B's choice survives an S off and on.
 */
export function toggleSweep(
  currentPeriodSec: number,
  lastNonZeroSec: number = SWEEP_TOGGLE_FALLBACK_SEC,
): SweepToggleResult {
  if (currentPeriodSec > 0) {
    return { periodSec: 0, lastNonZeroSec: currentPeriodSec }
  }
  return { periodSec: lastNonZeroSec, lastNonZeroSec }
}

/**
 * The starting period from a page's query string. "off" or "0" is 0;
 * "on" is undefined, meaning the configured default; a number from 1 to
 * SWEEP_PARAM_MAX_SEC is that period. Anything else is ignored (undefined)
 * rather than guessed at.
 */
export function parseSweepParam(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('sweep')
  if (raw === null) return undefined

  const value = raw.trim().toLowerCase()
  if (value === 'off' || value === '0') return 0
  if (value === 'on') return undefined
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined

  const periodSec = Number(value)
  return periodSec >= 1 && periodSec <= SWEEP_PARAM_MAX_SEC ? periodSec : undefined
}
