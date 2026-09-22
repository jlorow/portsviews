/**
 * LANDING-5 A1 tests — the Resend signup endpoint.
 *
 * NO LIVE CALL IS MADE. The real global fetch is replaced with a function
 * that throws before any test runs, so a request that escaped the injected
 * fetch would fail the suite rather than quietly reach the internet. No
 * real key is read: every test supplies its own obviously-fake value, and
 * `.env` is never opened.
 *
 * The request shape is asserted against Resend's live documentation, read
 * during this story rather than remembered:
 *   POST https://api.resend.com/contacts
 *   Authorization: Bearer <key>, Content-Type: application/json
 *   body { email, segments: [{ id }] }      success: HTTP 200
 *          { "object": "contact", "id": "479e3145-dd38-476b-932c-529ceb705947" }
 * and the error names come from Resend's errors reference (missing_api_key,
 * restricted_api_key, suspended_api_key, validation_error,
 * missing_required_field, rate_limit_exceeded, not_found,
 * application_error, service_unavailable).
 *
 * Run: npx tsx landing/src/subscribe.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RESEND_CONTACTS_URL,
  buildContactRequest,
  classifyResendResponse,
  handleSubscribe,
  isEmailValidationFailure,
  isValidEmail,
  looksLikeListIdProblem,
  readConfig,
  truncateForLog,
  LOG_BODY_LIMIT,
  resendLegacyAudienceUrl,
  type FetchLike,
  type SubscribeEnv,
} from './subscribe'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    console.log(`[Pass] ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}`)
  }
}

// --- nothing may reach the network ---------------------------------------
let realFetchAttempts = 0
;(globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
  realFetchAttempts++
  throw new Error(`LANDING-5: a real network call was attempted: ${String(args[0])}`)
}

// Obviously fake, and shaped nothing like a real credential.
const FAKE_KEY = 'test-key-not-a-real-credential'
const FAKE_LIST = '00000000-0000-4000-8000-000000000000'
const ENV: SubscribeEnv = { RESEND_API_KEY: FAKE_KEY, RESEND_AUDIENCE_ID: FAKE_LIST }

interface Recorded {
  url: string
  init: { method: string; headers: Record<string, string>; body: string }
}

function mockFetch(status: number, body: unknown, recorder?: Recorded[]): FetchLike {
  return async (url, init) => {
    recorder?.push({ url, init })
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
  }
}

// --- readConfig -----------------------------------------------------------

{
  const ok = readConfig(ENV)
  assert(ok.ok === true, 'readConfig: a complete environment is accepted')
  assert(ok.ok === true && ok.config.legacy === false, 'readConfig: segments mode by default, not the deprecated audience path')
  assert(
    readConfig({ ...ENV, RESEND_USE_LEGACY_AUDIENCE: '1' }).ok === true &&
      (readConfig({ ...ENV, RESEND_USE_LEGACY_AUDIENCE: '1' }) as { config: { legacy: boolean } }).config.legacy === true,
    'readConfig: RESEND_USE_LEGACY_AUDIENCE switches to the legacy audience endpoint',
  )

  const noKey = readConfig({ RESEND_AUDIENCE_ID: FAKE_LIST })
  assert(noKey.ok === false && noKey.missing.includes('RESEND_API_KEY'), 'readConfig: a missing RESEND_API_KEY is named')
  const noList = readConfig({ RESEND_API_KEY: FAKE_KEY })
  assert(noList.ok === false && noList.missing.includes('RESEND_AUDIENCE_ID'), 'readConfig: a missing RESEND_AUDIENCE_ID is named')
  const neither = readConfig({})
  assert(
    neither.ok === false && neither.missing.length === 2,
    'readConfig: BOTH missing variables are named, not just the first',
  )
  const blank = readConfig({ RESEND_API_KEY: '   ', RESEND_AUDIENCE_ID: FAKE_LIST })
  assert(blank.ok === false, 'readConfig: a blank value counts as missing, same as unset')
}

// --- isValidEmail ---------------------------------------------------------

for (const good of ['a@b.co', 'someone@example.com', 'first.last+tag@sub.example.co.uk']) {
  assert(isValidEmail(good), `isValidEmail: accepts ${good}`)
}
for (const bad of ['', '   ', 'nope', 'no-at-sign.com', 'two@@at.com', 'trailing@dot.', 'user@localhost', 'a b@c.com', 'x'.repeat(250) + '@b.com']) {
  assert(!isValidEmail(bad), `isValidEmail: rejects ${JSON.stringify(bad.length > 40 ? bad.slice(0, 20) + '...' : bad)}`)
}
assert(!isValidEmail(undefined) && !isValidEmail(null) && !isValidEmail(42), 'isValidEmail: rejects non-strings')

// --- buildContactRequest, against the documented shape --------------------

{
  const req = buildContactRequest(' someone@example.com ', { apiKey: FAKE_KEY, listId: FAKE_LIST, legacy: false })
  assert(req.url === 'https://api.resend.com/contacts', `URL is Resend's documented contacts endpoint (${req.url})`)
  assert(req.url === RESEND_CONTACTS_URL, 'the exported constant and the built URL agree')
  assert(req.method === 'POST', 'method is POST')
  assert(req.headers['Authorization'] === `Bearer ${FAKE_KEY}`, 'Authorization is "Bearer <key>", exactly as documented')
  assert(req.headers['Content-Type'] === 'application/json', 'Content-Type is application/json')

  const body = JSON.parse(req.body) as { email: string; segments: { id: string }[] }
  assert(body.email === 'someone@example.com', 'the email is trimmed before it is sent')
  assert(Array.isArray(body.segments) && body.segments.length === 1, 'body carries a segments array')
  assert(body.segments[0].id === FAKE_LIST, 'the segment id is RESEND_AUDIENCE_ID\'s value')
  assert(Object.keys(body).sort().join(',') === 'email,segments', `body has only the documented fields (${Object.keys(body).join(',')})`)

  // The credential must live in exactly one place.
  assert(!req.url.includes(FAKE_KEY), 'the key is NOT in the URL')
  assert(!req.body.includes(FAKE_KEY), 'the key is NOT in the body')
  const headerUses = Object.values(req.headers).filter((v) => v.includes(FAKE_KEY)).length
  assert(headerUses === 1, `the key appears in exactly one header (${headerUses})`)
}

{
  const req = buildContactRequest('someone@example.com', { apiKey: FAKE_KEY, listId: FAKE_LIST, legacy: true })
  assert(
    req.url === `https://api.resend.com/audiences/${FAKE_LIST}/contacts`,
    `legacy mode uses the audience-scoped endpoint (${req.url})`,
  )
  assert(req.url === resendLegacyAudienceUrl(FAKE_LIST), 'the legacy URL helper and the built URL agree')
  const body = JSON.parse(req.body) as Record<string, unknown>
  assert(Object.keys(body).join(',') === 'email', 'legacy body carries email only -- the audience is in the path')
}

// --- classifyResendResponse, against documented statuses ------------------

{
  // Resend's documented success body.
  const ok = classifyResendResponse(200, { object: 'contact', id: '479e3145-dd38-476b-932c-529ceb705947' })
  assert(ok.status === 200 && ok.code === 'subscribed', 'HTTP 200 with a contact object is a successful signup')

  const created = classifyResendResponse(201, { object: 'contact', id: 'x' })
  assert(created.code === 'subscribed', 'any 2xx counts as success, not only the documented 200')

  // THE DUPLICATE CASE. Resend documents no conflict error for contacts and
  // appears to upsert, so both readings are covered.
  const upsert = classifyResendResponse(200, { object: 'contact', id: 'already-there' })
  assert(upsert.status === 200, 'a duplicate that comes back 200 is handled as success, not a crash')
  const conflict = classifyResendResponse(409, { statusCode: 409, name: 'conflict', message: 'Contact already exists' })
  assert(
    conflict.status === 200 && conflict.code === 'already_subscribed',
    'a 409 is reported as already subscribed, and does not crash',
  )
  const byMessage = classifyResendResponse(422, { statusCode: 422, name: 'validation_error', message: 'Contact already exists.' })
  assert(byMessage.code === 'already_subscribed', 'a 4xx whose message says the contact already exists is read the same way')
}

{
  // Documented credential failures -> the visitor is told it is our fault,
  // and the operator gets a line naming the variable.
  for (const [status, name] of [
    [401, 'missing_api_key'],
    [401, 'restricted_api_key'],
    [403, 'suspended_api_key'],
    [403, 'invalid_permission'],
  ] as [number, string][]) {
    const out = classifyResendResponse(status, { statusCode: status, name, message: 'x' })
    assert(out.status === 500 && out.code === 'not_configured', `HTTP ${status} ${name} -> 500 not_configured for the visitor`)
    assert(
      (out.logLine ?? '').includes('RESEND_API_KEY'),
      `HTTP ${status} ${name} -> the log line names RESEND_API_KEY so a human can act on it`,
    )
    assert(!(out.message + (out.logLine ?? '')).includes(FAKE_KEY), `HTTP ${status} ${name} -> neither message nor log contains the key`)
  }

  const notFound = classifyResendResponse(404, { statusCode: 404, name: 'not_found', message: 'The requested endpoint does not exist.' })
  assert(notFound.code === 'not_configured' && (notFound.logLine ?? '').includes('RESEND_AUDIENCE_ID'), '404 points at RESEND_AUDIENCE_ID')

  const validation = classifyResendResponse(422, { statusCode: 422, name: 'missing_required_field', message: 'The request body is missing one or more required fields.' })
  assert(
    validation.status === 502 && validation.code === 'upstream_error',
    'A2: a 422 that says nothing about the address is OUR fault, not the visitor input',
  )
  assert(
    !/address|email/i.test(validation.message),
    `A2: and the visitor is not told to check their address (got: "${validation.message}")`,
  )

  const rate = classifyResendResponse(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests. Please limit the number of requests per second.' })
  assert(rate.status === 429 && rate.code === 'rate_limited', '429 rate_limit_exceeded -> rate limited, with an honest message')

  for (const [status, name] of [[500, 'application_error'], [503, 'service_unavailable']] as [number, string][]) {
    const out = classifyResendResponse(status, { statusCode: status, name, message: 'x' })
    assert(out.status === 502 && out.code === 'upstream_error', `HTTP ${status} ${name} -> 502 upstream_error`)
  }

  const garbage = classifyResendResponse(418, null)
  assert(garbage.code === 'upstream_error', 'an undocumented status with no body still classifies, and does not throw')
}

// --- LANDING-6 A2: only blame the address when Resend blames the address --

{
  // Shapes that DO point at the email field.
  for (const body of [
    { statusCode: 422, name: 'validation_error', message: 'The `email` must be a valid email address.' },
    { statusCode: 422, name: 'invalid_parameter', message: 'The `email` must be a valid email.' },
    { statusCode: 400, name: 'validation_error', message: 'Invalid email address' },
    { statusCode: 422, name: 'missing_required_field', message: 'The email field is required.' },
  ]) {
    assert(isEmailValidationFailure(body), `isEmailValidationFailure: true for ${JSON.stringify(body.message)}`)
    const out = classifyResendResponse(body.statusCode, body)
    assert(
      out.status === 400 && out.code === 'invalid_email',
      `A2: an email-specific 422 still shows the email message (${JSON.stringify(body.message)})`,
    )
    assert(/address/i.test(out.message), 'A2: ...and that message does mention the address')
  }
}

{
  // Shapes that DO NOT. These are our request being wrong, not their input.
  // The first is the shape a segment-id mismatch is expected to produce,
  // which is what LANDING-6 exists for.
  for (const body of [
    { statusCode: 422, name: 'invalid_parameter', message: 'The `segments.0.id` must be a valid UUID.' },
    { statusCode: 422, name: 'validation_error', message: 'Segment not found' },
    { statusCode: 422, name: 'missing_required_field', message: 'The request body is missing one or more required fields.' },
    { statusCode: 422, name: 'invalid_parameter', message: 'The `audience_id` must be a valid UUID.' },
    { statusCode: 400, name: 'validation_error', message: 'An error was found with one or more fields in the request.' },
  ]) {
    assert(!isEmailValidationFailure(body), `isEmailValidationFailure: false for ${JSON.stringify(body.message)}`)
    const out = classifyResendResponse(body.statusCode, body)
    assert(
      out.code === 'upstream_error',
      `A2: a non-email 422 shows the GENERIC message (${JSON.stringify(body.message)})`,
    )
    assert(
      !/address|check it|your email/i.test(out.message),
      `A2: ...and never blames the visitor's input (got: "${out.message}")`,
    )
    assert(/our end/i.test(out.message), 'A2: ...it says the problem is on our end')
  }
}

{
  // A message naming BOTH is treated as ours, on purpose: the failure
  // direction is biased away from blaming someone who typed a good address.
  const both = { statusCode: 422, name: 'validation_error', message: 'email invalid for segment 123' }
  assert(!isEmailValidationFailure(both), 'A2: a message naming both the email and a segment is read as OUR fault')
  // And an error with no usable text at all is not pinned on the visitor.
  assert(!isEmailValidationFailure(null), 'A2: an empty body is not an email failure')
  assert(!isEmailValidationFailure({ statusCode: 422 }), 'A2: a body with no message is not an email failure')
  assert(classifyResendResponse(422, null).code === 'upstream_error', 'A2: a 422 with no body at all is generic')
}

// --- LANDING-6 A0: the raw body is logged on every non-2xx ----------------

{
  assert(truncateForLog('') === '<empty body>', 'truncateForLog: an empty body says so')
  assert(truncateForLog('short') === 'short', 'truncateForLog: a short body is untouched')
  const long = 'x'.repeat(LOG_BODY_LIMIT + 500)
  const cut = truncateForLog(long)
  assert(cut.length < long.length && cut.includes('truncated'), 'truncateForLog: a long body is cut and says so')
  assert(cut.includes(String(long.length)), 'truncateForLog: ...and reports the real size')
}

{
  const raw = '{"statusCode":422,"name":"invalid_parameter","message":"The `segments.0.id` must be a valid UUID."}'
  const logs: string[] = []
  const out = await handleSubscribe('someone@example.com', ENV, {
    fetchImpl: async () => ({ status: 422, text: async () => raw }),
    logError: (line) => logs.push(line),
  })
  const joined = logs.join(String.fromCharCode(10))
  assert(joined.includes(raw), 'A0: the FULL raw Resend body is logged verbatim on a non-2xx')
  assert(joined.includes('HTTP 422'), 'A0: the status is logged with it')
  assert(joined.includes(RESEND_CONTACTS_URL), 'A0: so is the endpoint that was called')
  assert(!joined.includes(FAKE_KEY), 'A0: and the log contains no credential')
  assert(out.code === 'upstream_error', 'A0: this exact body classifies as ours, not the visitor input')
  assert(!joined.toLowerCase().includes('authorization'), 'A0: request headers are not logged')
}

{
  // A 2xx must stay quiet -- the log is for failures.
  const logs: string[] = []
  await handleSubscribe('someone@example.com', ENV, {
    fetchImpl: mockFetch(200, { object: 'contact', id: 'abc' }),
    logError: (line) => logs.push(line),
  })
  assert(logs.length === 0, 'A0: a successful signup logs nothing')
}

// --- handleSubscribe end to end (no network) -----------------------------

{
  const seen: Recorded[] = []
  const out = await handleSubscribe('someone@example.com', ENV, {
    fetchImpl: mockFetch(200, { object: 'contact', id: 'abc' }, seen),
    logError: () => {},
  })
  assert(out.code === 'subscribed', 'handleSubscribe: a good address on a configured deployment subscribes')
  assert(seen.length === 1, 'handleSubscribe: exactly one request was made')
  assert(seen[0].url === RESEND_CONTACTS_URL, 'handleSubscribe: it went to the documented endpoint')
}

{
  // A MISSING ENVIRONMENT VARIABLE MUST FAIL LOUDLY.
  const logs: string[] = []
  const seen: Recorded[] = []
  const out = await handleSubscribe('someone@example.com', {}, {
    fetchImpl: mockFetch(200, { object: 'contact', id: 'abc' }, seen),
    logError: (line) => logs.push(line),
  })
  assert(out.status === 500 && out.code === 'not_configured', 'missing env: the visitor gets a 500, never a fake success')
  assert(seen.length === 0, 'missing env: no request is made at all')
  assert(logs.length === 1, 'missing env: exactly one error line is logged')
  assert(
    logs[0].includes('RESEND_API_KEY') && logs[0].includes('RESEND_AUDIENCE_ID'),
    'missing env: the log names BOTH missing variables',
  )
  assert(logs[0].includes('NOT CONFIGURED'), 'missing env: the log is unmistakable, not a debug whisper')
  assert(out.message !== '' && !out.message.includes('RESEND_'), 'missing env: the visitor is told plainly, without internals')
}

{
  // A malformed address must not cost an API call.
  const seen: Recorded[] = []
  const out = await handleSubscribe('not-an-email', ENV, { fetchImpl: mockFetch(200, {}, seen), logError: () => {} })
  assert(out.status === 400 && out.code === 'invalid_email', 'malformed address: 400 invalid_email')
  assert(seen.length === 0, 'malformed address: no request is made, so it costs no quota')
}

{
  // A thrown fetch (DNS, timeout) is not a crash.
  const logs: string[] = []
  const out = await handleSubscribe('someone@example.com', ENV, {
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND api.resend.com')
    },
    logError: (line) => logs.push(line),
  })
  assert(out.status === 502 && out.code === 'upstream_error', 'a network failure becomes a 502, not an unhandled rejection')
  assert(logs.length === 1 && logs[0].includes('threw'), 'and it is logged')
}

{
  // A non-JSON error body must not break classification.
  const logs: string[] = []
  const out = await handleSubscribe('someone@example.com', ENV, {
    fetchImpl: async () => ({ status: 503, text: async () => '<html>502 Bad Gateway</html>' }),
    logError: (line) => logs.push(line),
  })
  assert(out.code === 'upstream_error', 'a body that will not parse as JSON still classifies from the status')
  assert(
    logs.join(String.fromCharCode(10)).includes('<html>502 Bad Gateway</html>'),
    'A0: and the unparseable body is still logged verbatim -- the case where seeing it matters most',
  )
}

// --- LANDING-6 A1: the list-id shape is settled at runtime ---------------

{
  for (const [status, body] of [
    [404, { name: 'not_found', message: 'The requested endpoint does not exist.' }],
    [422, { name: 'invalid_parameter', message: 'The `segments.0.id` must be a valid UUID.' }],
    [422, { name: 'validation_error', message: 'Segment not found' }],
    [400, { name: 'validation_error', message: 'Audience does not exist' }],
  ] as [number, unknown][]) {
    assert(looksLikeListIdProblem(status, body), `looksLikeListIdProblem: true for HTTP ${status} ${JSON.stringify(body)}`)
  }
  for (const [status, body] of [
    [422, { name: 'validation_error', message: 'The `email` must be a valid email address.' }],
    [401, { name: 'missing_api_key', message: 'Missing API key in the authorization header.' }],
    [429, { name: 'rate_limit_exceeded', message: 'Too many requests.' }],
    [500, { name: 'application_error', message: 'An unexpected error occurred.' }],
  ] as [number, unknown][]) {
    assert(!looksLikeListIdProblem(status, body), `looksLikeListIdProblem: false for HTTP ${status} ${JSON.stringify(body)}`)
  }
}

function scriptedFetch(steps: { status: number; body: unknown }[], seen: Recorded[]): FetchLike {
  let i = 0
  return async (url, init) => {
    seen.push({ url, init })
    const step = steps[Math.min(i, steps.length - 1)]
    i++
    return { status: step.status, text: async () => JSON.stringify(step.body) }
  }
}

{
  // The signature LANDING-6 exists for: segments rejected, audience accepts.
  const seen: Recorded[] = []
  const logs: string[] = []
  const out = await handleSubscribe('someone@example.com', ENV, {
    fetchImpl: scriptedFetch(
      [
        { status: 422, body: { statusCode: 422, name: 'invalid_parameter', message: 'The `segments.0.id` must be a valid UUID.' } },
        { status: 200, body: { object: 'contact', id: 'abc' } },
      ],
      seen,
    ),
    logError: (line) => logs.push(line),
  })
  const joined = logs.join(String.fromCharCode(10))
  assert(out.code === 'subscribed', 'A1: a segments rejection falls back to the audience endpoint and the visitor is subscribed')
  assert(seen.length === 2, `A1: exactly two requests, not a loop (${seen.length})`)
  assert(seen[0].url === RESEND_CONTACTS_URL, 'A1: the first attempt is the current segments endpoint')
  assert(seen[1].url === resendLegacyAudienceUrl(FAKE_LIST), 'A1: the second is the legacy audience endpoint')
  assert(joined.includes('RESEND_USE_LEGACY_AUDIENCE=1'), 'A1: the log tells the operator exactly how to make it permanent')
  assert(joined.includes('Audience id, not a Segment id'), 'A1: ...and says what the id actually is')
  assert(!joined.includes(FAKE_KEY), 'A1: no credential in any of it')
}

{
  // An email rejection must NOT trigger a retry -- nothing about the list.
  const seen: Recorded[] = []
  const out = await handleSubscribe('someone@example.com', ENV, {
    fetchImpl: scriptedFetch([{ status: 422, body: { name: 'validation_error', message: 'The `email` must be a valid email address.' } }], seen),
    logError: () => {},
  })
  assert(seen.length === 1, `A1: an address rejection makes ONE request, no fallback (${seen.length})`)
  assert(out.code === 'invalid_email', 'A1: ...and is still reported as an address problem')
}

{
  // Already on the legacy path: never retry, or it would double-post.
  const seen: Recorded[] = []
  await handleSubscribe('someone@example.com', { ...ENV, RESEND_USE_LEGACY_AUDIENCE: '1' }, {
    fetchImpl: scriptedFetch([{ status: 404, body: { name: 'not_found', message: 'not found' } }], seen),
    logError: () => {},
  })
  assert(seen.length === 1, `A1: configured legacy mode never falls back to itself (${seen.length})`)
}

{
  // Both shapes refused: report the second, and say so.
  const seen: Recorded[] = []
  const logs: string[] = []
  const out = await handleSubscribe('someone@example.com', ENV, {
    fetchImpl: scriptedFetch([{ status: 404, body: { name: 'not_found', message: 'not found' } }], seen),
    logError: (line) => logs.push(line),
  })
  assert(seen.length === 2, 'A1: both shapes are tried')
  assert(out.status >= 400, 'A1: and the failure is still reported as a failure')
  assert(
    logs.join(String.fromCharCode(10)).includes('wrong for BOTH shapes'),
    'A1: the log says the id is wrong either way rather than leaving it ambiguous',
  )
}

{
  // A success on the first attempt must never make a second request.
  const seen: Recorded[] = []
  await handleSubscribe('someone@example.com', ENV, {
    fetchImpl: scriptedFetch([{ status: 200, body: { object: 'contact', id: 'abc' } }], seen),
    logError: () => {},
  })
  assert(seen.length === 1, 'A1: the happy path is still exactly one request')
}

// --- nothing reached the real network, and nothing leaked to the browser --

assert(realFetchAttempts === 0, `no test touched the real network (attempts: ${realFetchAttempts})`)

{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const bundlePath = path.join(__dirname, '..', 'hero', 'hero.js')
  const bundle = fs.readFileSync(bundlePath, 'utf8')
  for (const token of ['resend', 'Resend', 'RESEND', 'api.resend.com', 'Authorization', 'Bearer ']) {
    assert(!bundle.includes(token), `the public hero bundle contains no "${token}"`)
  }
}

{
  // The adapter must not be reachable from the browser bundle's entry.
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const heroSource = fs.readFileSync(path.join(__dirname, 'hero.ts'), 'utf8')
  assert(!heroSource.includes('subscribe'), 'hero.ts does not import the subscribe module, so Vite cannot bundle it')
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
