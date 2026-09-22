/**
 * LANDING-5 — the signup endpoint's logic, with no I/O of its own.
 *
 * Everything here is pure or takes its fetch as an argument, so the whole
 * thing is testable under tsx with no network and no platform. The
 * serverless adapter (landing/functions/api/subscribe.ts) is a dozen lines
 * that read the environment and hand over to `handleSubscribe`; moving to
 * a different host means writing a different adapter, not rewriting this.
 *
 * NOTHING IN THIS FILE REACHES THE BROWSER. hero.ts does not import it, so
 * Vite never bundles it, and subscribe.test.ts asserts the built
 * hero/hero.js contains no trace of Resend. The API key exists only in the
 * function's environment.
 *
 * WHICH RESEND ENDPOINT, AND WHY IT IS NOT THE AUDIENCE ONE. Checked
 * against the live documentation rather than remembered:
 *
 *   - POST https://api.resend.com/contacts is the current documented way
 *     to create a contact, with `segments: [{ id }]` attaching it to a
 *     list. Success is HTTP 200 with `{ "object": "contact", "id": ... }`.
 *   - The older POST /audiences/{id}/contacts still works, but Resend's
 *     own docs say "Audiences are deprecated in favor of Segments. These
 *     endpoints still work, but will be removed in the future."
 *
 * So the default is the segment shape, and the legacy audience path is
 * kept behind RESEND_USE_LEGACY_AUDIENCE for an account that still has an
 * audience rather than a segment. The environment variable keeps the name
 * the brief specified, RESEND_AUDIENCE_ID, in both cases -- see the review
 * file; renaming an operator's variable out from under them is worse than
 * a slightly dated name.
 */

/** Current documented endpoint. */
export const RESEND_CONTACTS_URL = 'https://api.resend.com/contacts'

/** Deprecated-but-working endpoint, for an account still on audiences. */
export function resendLegacyAudienceUrl(audienceId: string): string {
  return `https://api.resend.com/audiences/${encodeURIComponent(audienceId)}/contacts`
}

export interface SubscribeEnv {
  RESEND_API_KEY?: string
  RESEND_AUDIENCE_ID?: string
  RESEND_USE_LEGACY_AUDIENCE?: string
}

export interface SubscribeConfig {
  apiKey: string
  listId: string
  legacy: boolean
}

export type ConfigResult = { ok: true; config: SubscribeConfig } | { ok: false; missing: string[] }

/**
 * Reads configuration, naming every variable that is absent rather than
 * the first one. A blank string counts as absent: an unset variable and
 * one set to "" are the same misconfiguration and must not behave
 * differently.
 */
export function readConfig(env: SubscribeEnv): ConfigResult {
  const missing: string[] = []
  const apiKey = (env.RESEND_API_KEY ?? '').trim()
  const listId = (env.RESEND_AUDIENCE_ID ?? '').trim()
  if (apiKey === '') missing.push('RESEND_API_KEY')
  if (listId === '') missing.push('RESEND_AUDIENCE_ID')
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    config: { apiKey, listId, legacy: (env.RESEND_USE_LEGACY_AUDIENCE ?? '').trim() !== '' },
  }
}

/**
 * Deliberately conservative rather than RFC-complete. The point is to
 * refuse obvious rubbish before spending an API call on it, not to be the
 * authority on what an address may contain -- Resend validates properly at
 * its end, and a 422 from it is handled below.
 */
export function isValidEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const email = value.trim()
  if (email.length === 0 || email.length > 254) return false
  if (/\s/.test(email)) return false
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(email)
}

export interface ResendRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

/**
 * The exact request Resend's documentation describes. The key appears in
 * the Authorization header and nowhere else -- never in the URL, never in
 * the body, so it cannot end up in a log line that records either.
 */
export function buildContactRequest(email: string, config: SubscribeConfig): ResendRequest {
  const payload = config.legacy
    ? { email: email.trim() }
    : { email: email.trim(), segments: [{ id: config.listId }] }

  return {
    url: config.legacy ? resendLegacyAudienceUrl(config.listId) : RESEND_CONTACTS_URL,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }
}

/** Logs stay readable: a runaway body is cut, and says that it was. */
export const LOG_BODY_LIMIT = 2000

export function truncateForLog(raw: string): string {
  if (raw === '') return '<empty body>'
  if (raw.length <= LOG_BODY_LIMIT) return raw
  return `${raw.slice(0, LOG_BODY_LIMIT)}... <truncated, ${raw.length} bytes total>`
}

export type OutcomeCode =
  | 'subscribed'
  | 'already_subscribed'
  | 'invalid_email'
  | 'not_configured'
  | 'rate_limited'
  | 'upstream_error'

export interface Outcome {
  /** HTTP status the visitor's browser receives. */
  status: number
  code: OutcomeCode
  /** Shown to the visitor verbatim. Never contains anything from the key. */
  message: string
  /** Logged server-side only; never sent to the browser. */
  logLine?: string
}

/** Resend's documented error envelope: statusCode, name, message. */
interface ResendError {
  statusCode?: number
  name?: string
  message?: string
}

function errorNameOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const name = (body as ResendError).name
  return typeof name === 'string' ? name : ''
}

function errorMessageOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const message = (body as ResendError).message
  return typeof message === 'string' ? message : ''
}

/**
 * Does this error actually point at the email address?
 *
 * LANDING-6 A2. Resend's documented 422s are generic -- `invalid_parameter`
 * ("The `parameter` must be a valid UUID."), `missing_required_field`,
 * `missing_required_parameter` -- and the parameter named is whichever one
 * was wrong. So the only honest test is whether the response mentions the
 * email field, and the default when it does not is to blame ourselves.
 *
 * A message naming a segment, audience or contact id is about the LIST even
 * if the word "email" also appears somewhere in it, so those win: the
 * failure direction is deliberately biased towards "our fault".
 */
export function isEmailValidationFailure(body: unknown): boolean {
  const haystack = `${errorNameOf(body)} ${errorMessageOf(body)}`.toLowerCase()
  if (haystack.trim() === '') return false
  if (/segment|audience|contact_id|contact id/.test(haystack)) return false
  return /\bemail\b|\be-mail\b|email_address/.test(haystack)
}

/**
 * Does this failure look like the LIST id rather than anything else?
 *
 * LANDING-6 A1. The brief asked for the real cause to be found from a live
 * run's log before fixing anything, and this agent cannot make that run --
 * it has no browser, cannot use the real key, and is forbidden from reading
 * .dev.vars. So rather than guess which of the two list shapes the
 * deployment is configured with, the code settles it at runtime: a failure
 * that points at the list (a 404, or a 4xx naming a segment, an audience,
 * or an id that is not a valid UUID) is exactly the signature of an
 * Audience id being sent to the segments-based endpoint, and is worth one
 * retry down the legacy path.
 *
 * Resend's documentation does NOT answer whether an Audience id is valid as
 * a Segment id -- its migration page says only that "Contacts API endpoints
 * that previously required an `audience_id` can now be used directly
 * instead" and is silent on the identifiers themselves. That silence is why
 * this is decided by observation instead of by reading.
 */
export function looksLikeListIdProblem(httpStatus: number, body: unknown): boolean {
  if (httpStatus === 404) return true
  if (httpStatus < 400 || httpStatus >= 500) return false
  const haystack = `${errorNameOf(body)} ${errorMessageOf(body)}`.toLowerCase()
  if (isEmailValidationFailure(body)) return false
  return /segment|audience|must be a valid uuid|not found/.test(haystack)
}

/**
 * Maps a Resend response onto something honest to say to a visitor.
 *
 * The error names below are Resend's own documented ones (its errors
 * reference lists missing_api_key and restricted_api_key at 401,
 * restricted_api_key and suspended_api_key and invalid_permission at 403,
 * validation_error at 400/403, missing_required_field and
 * invalid_parameter at 422, rate_limit_exceeded at 429, application_error
 * at 500, service_unavailable at 503).
 *
 * THE DUPLICATE CASE IS NOT DOCUMENTED, and this file does not pretend
 * otherwise. Resend's contacts reference lists no conflict error, and its
 * create-contact endpoint appears to upsert -- an address already on the
 * list comes back 200 like any other. Both readings are handled: a 2xx is
 * success either way (the visitor is on the list, which is all they
 * asked), and a 409, or a 4xx whose message mentions already existing, is
 * reported as already subscribed rather than as a failure. If Resend ever
 * starts returning a real conflict, this already does the right thing.
 */
export function classifyResendResponse(httpStatus: number, body: unknown): Outcome {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: 200, code: 'subscribed', message: "You're on the kit list. We'll email you when there's something real to show." }
  }

  const name = errorNameOf(body)
  const message = errorMessageOf(body)

  if (httpStatus === 409 || /already\s+(exists|subscribed|registered)/i.test(message)) {
    return {
      status: 200,
      code: 'already_subscribed',
      message: "You're already on the kit list. Nothing more to do.",
    }
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      status: 500,
      code: 'not_configured',
      message: "Something's wrong at our end, not yours. Please try again later.",
      logLine: `[Portsviews] subscribe: Resend rejected the credential (HTTP ${httpStatus}, ${name || 'no name'}). Check RESEND_API_KEY's value and its permissions.`,
    }
  }

  if (httpStatus === 404) {
    return {
      status: 500,
      code: 'not_configured',
      message: "Something's wrong at our end, not yours. Please try again later.",
      logLine: `[Portsviews] subscribe: Resend returned 404 (${name || 'not_found'}). RESEND_AUDIENCE_ID may not name a list that exists, or the legacy audience path is wrong for this account.`,
    }
  }

  if (httpStatus === 422 || httpStatus === 400) {
    // LANDING-6 A2. A validation failure is NOT automatically the visitor's
    // fault. Resend returns 422 for anything malformed in the request --
    // including a segment id that is not a segment, which is a
    // configuration problem on our side and has nothing to do with the
    // address someone just typed. Telling them to check an address that
    // was perfectly fine is both wrong and unfixable by them, so the
    // address is only blamed when Resend's own response points at it.
    if (isEmailValidationFailure(body)) {
      return {
        status: 400,
        code: 'invalid_email',
        message: "That address didn't look right to our email provider. Could you check it?",
        logLine: `[Portsviews] subscribe: Resend rejected the ADDRESS (HTTP ${httpStatus}, ${name || 'no name'}).`,
      }
    }
    return {
      status: 502,
      code: 'upstream_error',
      message: "Something went wrong on our end. Please try again shortly.",
      logLine: `[Portsviews] subscribe: Resend validation failure that is NOT about the email address (HTTP ${httpStatus}, ${name || 'no name'}) -- this is our request, not the visitor's input. See the raw body logged above.`,
    }
  }

  if (httpStatus === 429) {
    return {
      status: 429,
      code: 'rate_limited',
      message: 'Too many signups at once. Give it a minute and try again.',
      logLine: `[Portsviews] subscribe: rate limited by Resend (${name || 'rate_limit_exceeded'}).`,
    }
  }

  return {
    status: 502,
    code: 'upstream_error',
    message: "We couldn't reach our email provider just now. Please try again later.",
    logLine: `[Portsviews] subscribe: unexpected Resend response (HTTP ${httpStatus}, ${name || 'no name'}).`,
  }
}

/**
 * LANDING-6 A0: `text()` rather than `json()`, because the RAW body is what
 * has to be logged. A body that fails to parse as JSON is exactly the case
 * where seeing it verbatim matters most, and json() throws that away.
 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number
  text: () => Promise<string>
}>

export interface SubscribeDeps {
  fetchImpl: FetchLike
  /** Injected so a test can assert the loud failure actually happens. */
  logError?: (line: string) => void
}

/**
 * The whole endpoint, minus the platform.
 *
 * A misconfigured deployment NEVER returns success. It returns 500 and
 * writes a line naming the missing variable, because the alternative --
 * a signup form that quietly does nothing while looking like it worked --
 * is the worst outcome available here.
 */
export async function handleSubscribe(
  rawEmail: unknown,
  env: SubscribeEnv,
  deps: SubscribeDeps,
): Promise<Outcome> {
  const log = deps.logError ?? ((line: string) => console.error(line))

  const configResult = readConfig(env)
  if (!configResult.ok) {
    const outcome: Outcome = {
      status: 500,
      code: 'not_configured',
      message: "Signup isn't switched on yet. Please try again later.",
      logLine: `[Portsviews] subscribe: NOT CONFIGURED -- ${configResult.missing.join(' and ')} ${configResult.missing.length === 1 ? 'is' : 'are'} not set in the function's environment. No signup can succeed until ${configResult.missing.length === 1 ? 'it is' : 'they are'} set.`,
    }
    log(outcome.logLine as string)
    return outcome
  }

  // Checked before the request, not after: an obviously malformed address
  // should not cost an API call or a rate-limit slot.
  if (!isValidEmail(rawEmail)) {
    return {
      status: 400,
      code: 'invalid_email',
      message: "That doesn't look like an email address. Could you check it?",
    }
  }

  // ONE attempt, or two: the segments path first, and -- only when the
  // failure points at the list id rather than the address -- the deprecated
  // audience path once. See looksLikeListIdProblem.
  const attempt = async (config: SubscribeConfig): Promise<Outcome> => {
    const request = buildContactRequest(rawEmail as string, config)

    let response: { status: number; text: () => Promise<string> }
    try {
      response = await deps.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      })
    } catch (err) {
      const outcome: Outcome = {
        status: 502,
        code: 'upstream_error',
        message: "We couldn't reach our email provider just now. Please try again later.",
        logLine: `[Portsviews] subscribe: request to Resend threw -- ${(err as Error).message}`,
      }
      log(outcome.logLine as string)
      return outcome
    }

    let raw = ''
    try {
      raw = await response.text()
    } catch (err) {
      raw = `<body could not be read: ${(err as Error).message}>`
    }

    let parsed: unknown = null
    try {
      parsed = raw === '' ? null : JSON.parse(raw)
    } catch {
      parsed = null
    }

    // LANDING-6 A0. On ANY non-2xx, log Resend's full response verbatim
    // before classifying it. The error TYPE was never the missing
    // information; the body is. Server-side only: the visitor gets
    // `outcome.message` and never sees this.
    //
    // Nothing here can leak the credential. `raw` is Resend's response, the
    // request headers are not logged, and `request.url` carries no secret --
    // buildContactRequest puts the key in the Authorization header and
    // nowhere else, which subscribe.test.ts asserts.
    if (response.status < 200 || response.status >= 300) {
      log(
        `[Portsviews] subscribe: Resend returned HTTP ${response.status} from ${request.url}`,
      )
      log(`[Portsviews] subscribe: raw response body: ${truncateForLog(raw)}`)
      lastStatus = response.status
      lastBody = parsed
    }

    const result = classifyResendResponse(response.status, parsed)
    if (result.logLine !== undefined) log(result.logLine)
    return result
  }

  let lastStatus = 0
  let lastBody: unknown = null

  const first = await attempt(configResult.config)
  if (first.status >= 200 && first.status < 300) return first

  if (!configResult.config.legacy && looksLikeListIdProblem(lastStatus, lastBody)) {
    log(
      '[Portsviews] subscribe: that failure points at RESEND_AUDIENCE_ID, not at the address. ' +
        'Retrying ONCE against the deprecated /audiences/{id}/contacts endpoint, in case the id is an Audience id rather than a Segment id.',
    )
    const second = await attempt({ ...configResult.config, legacy: true })
    if (second.status >= 200 && second.status < 300) {
      log(
        '[Portsviews] subscribe: the legacy audience endpoint ACCEPTED it, so RESEND_AUDIENCE_ID holds an Audience id, not a Segment id. ' +
          'Set RESEND_USE_LEGACY_AUDIENCE=1 to go straight there and stop wasting the first call, or migrate the Audience to a Segment in Resend.',
      )
    } else {
      log(
        '[Portsviews] subscribe: the legacy audience endpoint refused it too, so the id is wrong for BOTH shapes. ' +
          'Check RESEND_AUDIENCE_ID against the list in the Resend dashboard.',
      )
    }
    return second
  }

  return first
}
