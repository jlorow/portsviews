// The left-right mirror's switch: ?mirror= on the page URL. The display is
// built to be bounced off a mirror onto a ceiling, so the picture is flipped
// by default; a wall screen or a screen lying flat on a table wants it the
// right way round. Client-safe and DOM-free, like sweepControl.ts, so a plain
// `tsx` test can reach every rule.

import { DEFAULT_CONFIG } from './config.ts'

/**
 * The mirrorX a page should use, from the raw ?mirror= value
 * (URLSearchParams.get, so null when the parameter is missing). "off", "0"
 * or "false" turn the mirror off; "on", "1", "true", missing, empty or
 * anything unreadable keep DEFAULT_CONFIG's, rather than guessing.
 */
export function parseMirrorParam(value: string | null): boolean {
  if (value === null) return DEFAULT_CONFIG.mirrorX

  const normalized = value.trim().toLowerCase()
  if (normalized === 'off' || normalized === '0' || normalized === 'false') return false
  return DEFAULT_CONFIG.mirrorX
}
