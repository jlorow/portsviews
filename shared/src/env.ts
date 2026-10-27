// Client-safe: no Node imports, so the browser bundle can use these too.
// Every optional setting in .env can be present with an empty value (the
// template ships that way on purpose). An empty string is NOT "unset" to
// `??`, `Number('')` is 0, and 0 is a real value both here (a random
// ephemeral port) and in arithmetic (a replay speed of 0 divides by zero),
// so blank has to be decided in ONE place and treated as unset.

/**
 * The broadcast port both sides fall back to when the setting is blank.
 * Lives here so the server's WAKE_BROADCAST_PORT and the display's
 * VITE_WAKE_BROADCAST_PORT can never drift apart.
 */
export const DEFAULT_BROADCAST_PORT = 8080

/**
 * True when raw is undefined, '', or whitespace only.
 *
 * The type predicate is what makes the false branch a plain `string` for
 * callers: "not blank" is exactly "a value is actually set".
 */
export function isBlank(raw: string | undefined): raw is undefined | '' {
  return raw === undefined || raw.trim() === ''
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

// Digits only -- no sign, no decimal point, no exponent, no surrounding
// spaces. Number() alone would accept '1e3' and ' 8080 ', which are not
// ports anybody meant to type.
const DIGITS_ONLY = /^\d+$/
const POSITIVE_NUMBER = /^(\d+(\.\d+)?|\.\d+)$/

/**
 * Parse a TCP port. Blank/undefined gives `fallback`; anything else must be
 * an integer from 1 to 65535 with no other characters. The error names the
 * variable and the rule and echoes nothing else -- no value, no input.
 */
export function parsePort(raw: string | undefined, fallback: number, name: string): ParseResult<number> {
  if (isBlank(raw)) {
    return { ok: true, value: fallback }
  }
  // Tested against raw, not a trimmed copy: a padded or suffixed value is
  // not a port ("8080abc" and " 8080 " are both refused), and the caller
  // never silently gets a number nobody typed.
  const value = Number(raw)
  if (!DIGITS_ONLY.test(raw) || !Number.isInteger(value) || value < 1 || value > 65535) {
    return {
      ok: false,
      error: `${name} must be a whole number from 1 to 65535, or blank for ${fallback}.`,
    }
  }
  return { ok: true, value }
}

/**
 * What VITE_WAKE_SERVER_URL asks for. Shared by the build (which refuses an
 * invalid value and prints which kind it got) and the browser (which falls
 * back to the default with a warning).
 * - blank: the default, ws://<page hostname>:<port>
 * - same-origin: the page's own host, path /ws (for one-address hosting)
 * - url: a full ws:// or wss:// address with no username or password
 */
export type ServerUrlSetting =
  | { kind: 'default' }
  | { kind: 'same-origin' }
  | { kind: 'url'; url: string }
  | { kind: 'invalid' }

export function classifyServerUrlSetting(raw: string | undefined): ServerUrlSetting {
  if (isBlank(raw)) return { kind: 'default' }
  const trimmed = raw.trim()
  if (trimmed.toLowerCase() === 'same-origin') return { kind: 'same-origin' }
  if (!/^wss?:\/\//i.test(trimmed)) return { kind: 'invalid' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { kind: 'invalid' }
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return { kind: 'invalid' }
  if (parsed.username !== '' || parsed.password !== '') return { kind: 'invalid' }
  if (parsed.hostname === '') return { kind: 'invalid' }
  return { kind: 'url', url: trimmed }
}

export const SERVER_URL_WARNING =
  'VITE_WAKE_SERVER_URL must be blank, same-origin, or a ws:// or wss:// address; using the default.'

/**
 * The WebSocket address the display dials. Pure and browser-safe: the
 * caller passes the page location in. The warning names the setting and
 * never echoes the value.
 */
export function resolveServerUrl(
  rawSetting: string | undefined,
  port: number,
  loc: { protocol: string; hostname: string; host: string },
): { url: string; warning?: string } {
  const fallback = `ws://${loc.hostname}:${port}`
  const setting = classifyServerUrlSetting(rawSetting)
  switch (setting.kind) {
    case 'default':
      return { url: fallback }
    case 'same-origin':
      return { url: `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws` }
    case 'url':
      return { url: setting.url }
    case 'invalid':
      return { url: fallback, warning: SERVER_URL_WARNING }
  }
}

/**
 * Parse a positive setting such as WAKE_REPLAY_SPEED. Blank/undefined gives
 * `fallback`; otherwise digits with an optional decimal part, greater than
 * zero. Same error discipline as parsePort: name and rule only.
 */
export function parsePositiveNumber(
  raw: string | undefined,
  fallback: number,
  name: string,
): ParseResult<number> {
  if (isBlank(raw)) {
    return { ok: true, value: fallback }
  }
  const value = Number(raw)
  if (!POSITIVE_NUMBER.test(raw) || !Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      error: `${name} must be a number greater than 0, or blank for ${fallback}.`,
    }
  }
  return { ok: true, value }
}
