import { createAisStreamClient, AisStreamClient, type AisSocket } from './aisstream.ts'

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

// Mirrors broadcast.test.ts's MockClient: a plain object satisfying the
// narrow AisSocket interface, no real networking, no `ws` module involved
// at all. Captures every send() call and lets the test fire 'open' itself
// instead of a real handshake completing -- constructing a real
// `ws.WebSocket` against AISSTREAM_URL would attempt a genuine network
// connection, forbidden in this session.
class MockSocket implements AisSocket {
  readyState = 1 // OPEN
  sent: string[] = []
  closed = false
  private listeners: Record<string, Array<(...args: any[]) => void>> = {}

  on(event: string, listener: (...args: any[]) => void): void {
    ;(this.listeners[event] ??= []).push(listener)
  }

  once(event: string, listener: (...args: any[]) => void): void {
    this.on(event, listener)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3 // CLOSED
  }

  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) listener(...args)
  }
}

// This hardcoded JSON is copied by hand from aisstream.ts's exported
// BOUNDING_BOXES / FILTER_MESSAGE_TYPES constants (the Wake server's
// defaults, unchanged by the RISK-1 refactor):
//   BOUNDING_BOXES = [[[51.4, 0.9], [50.8, 2.0]]]
//   FILTER_MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData']
// JSON.stringify drops the trailing ".0" on 2.0 (numbers, not decimal
// literals, survive stringify), so the expected string uses `2`, not `2.0`.
//
// Confirmed byte-identical to what the pre-refactor aisstream.ts sent:
// this exact string was asserted against dc36953's code (module-level
// BOUNDING_BOXES/FILTER_MESSAGE_TYPES read directly inside connect(), no
// SubscriptionConfig existed yet) before the refactor in this commit, with
// only the minimal socket-factory injection point added -- see
// risk1-review.txt for that run's pasted output. This is the "must pass
// unchanged apart from passing the defaults" test the RISK-1 prompt asked
// for; passing the defaults explicitly is the only delta from that run.
const EXPECTED_DEFAULT_SUBSCRIPTION =
  '{"APIKey":"test-key","BoundingBoxes":[[[51.4,0.9],[50.8,2]]],"FilterMessageTypes":["PositionReport","StandardClassBPositionReport","ShipStaticData"]}'

// Scenario 1: constructed as index.ts does (createAisStreamClient with an
// env-provided API key, then the Wake server's own default subscription),
// with an injected fake socket. Firing 'open' must send exactly today's
// subscription message, unchanged.
{
  process.env.AISSTREAM_API_KEY = 'test-key'
  const mock = new MockSocket()
  const client = createAisStreamClient(
    { boundingBoxes: [[[51.4, 0.9], [50.8, 2.0]]], filterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'] },
    { onMessage: () => {} },
    undefined,
    (_url, _options) => mock,
  )
  client.connect()
  mock.fire('open')

  assert(mock.sent.length === 1, `exactly one message sent on open (got ${mock.sent.length})`)
  assert(mock.sent[0] === EXPECTED_DEFAULT_SUBSCRIPTION,
    `default subscription matches today's constants exactly (got ${mock.sent[0]})`,
  )
  // (DEMO-1 adds URL assertions in Scenario 5 below; this scenario's
  // assertions are unchanged.)
  client.stopReconnecting() // clears the real 60s healthy-reset timer so the process can exit promptly
}

// Scenario 2: a client given other boxes sends exactly those -- proves the
// subscription is genuinely per-instance, not still reading a module
// constant under a different name.
{
  const mock = new MockSocket()
  const client = new AisStreamClient(
    'other-key',
    {
      boundingBoxes: [
        [
          [50.5, -2.0],
          [52.0, 3.0],
        ],
      ],
      filterMessageTypes: ['PositionReport'],
    },
    { onMessage: () => {} },
    undefined,
    (_url, _options) => mock,
  )
  client.connect()
  mock.fire('open')

  const expected =
    '{"APIKey":"other-key","BoundingBoxes":[[[50.5,-2],[52,3]]],"FilterMessageTypes":["PositionReport"]}'
  assert(mock.sent[0] === expected, `different boxes send exactly those (got ${mock.sent[0]})`)
  client.stopReconnecting()
}

// Scenario 3: resubscribe() on an open socket sends an identical message.
{
  const mock = new MockSocket()
  const client = new AisStreamClient(
    'resub-key',
    { boundingBoxes: [[[1, 1], [2, 2]]], filterMessageTypes: ['PositionReport'] },
    { onMessage: () => {} },
    undefined,
    (_url, _options) => mock,
  )
  client.connect()
  mock.fire('open')
  const firstSent = mock.sent[0]
  client.resubscribe()

  assert(mock.sent.length === 2, `resubscribe sends a second message (got ${mock.sent.length})`)
  assert(mock.sent[1] === firstSent, 'resubscribe message is identical to the original subscription')
  client.stopReconnecting()
}

// Scenario 4: resubscribe() does nothing on a closed socket.
{
  const mock = new MockSocket()
  const client = new AisStreamClient(
    'closed-key',
    { boundingBoxes: [[[1, 1], [2, 2]]], filterMessageTypes: ['PositionReport'] },
    { onMessage: () => {} },
    undefined,
    (_url, _options) => mock,
  )
  client.connect()
  mock.fire('open')
  mock.close()
  client.resubscribe()

  assert(mock.sent.length === 1, `resubscribe on a closed socket sends nothing new (got ${mock.sent.length})`)
  client.stopReconnecting()
}

// --- DEMO-1 scenarios: the connection URL ---
//
// The factory signature is (url, options) => socket, so the url each
// scenario hands the real WebSocket constructor is capturable without
// any networking.

// Scenario 5: DEFAULT construction uses today's URL exactly, and the
// default subscription stays byte-identical. This is the
// "default construction uses today's URL" test the DEMO-1 prompt adds
// alongside the unchanged RISK-1 byte-identical subscription test.
{
  process.env.AISSTREAM_API_KEY = 'test-key'
  let capturedUrl: string | undefined
  const mock = new MockSocket()
  const client = createAisStreamClient(
    { boundingBoxes: [[[51.4, 0.9], [50.8, 2.0]]], filterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'] },
    { onMessage: () => {} },
    undefined,
    (url, _options) => {
      capturedUrl = url
      return mock
    },
  )
  client.connect()
  mock.fire('open')

  assert(
    capturedUrl === 'wss://stream.aisstream.io/v0/stream',
    `default construction uses today's URL (got ${capturedUrl})`,
  )
  assert(
    mock.sent[0] === EXPECTED_DEFAULT_SUBSCRIPTION,
    `default subscription still byte-identical with the URL input added (got ${mock.sent[0]})`,
  )
  client.stopReconnecting()
}

// Scenario 6: the class's url constructor input overrides the default
// (aiscast's endpoint goes through exactly this path).
{
  let capturedUrl: string | undefined
  const mock = new MockSocket()
  const client = new AisStreamClient(
    'cast-token',
    { boundingBoxes: [[[51.4, 0.9], [50.8, 2.0]]], filterMessageTypes: ['PositionReport'] },
    { onMessage: () => {} },
    undefined,
    (url, _options) => {
      capturedUrl = url
      return mock
    },
    'wss://ais.openwaters.io/v0/stream',
  )
  client.connect()
  mock.fire('open')

  assert(
    capturedUrl === 'wss://ais.openwaters.io/v0/stream',
    `constructor url input overrides the default (got ${capturedUrl})`,
  )
  const expected =
    '{"APIKey":"cast-token","BoundingBoxes":[[[51.4,0.9],[50.8,2]]],"FilterMessageTypes":["PositionReport"]}'
  assert(
    mock.sent[0] === expected,
    `subscription message unchanged on the overridden URL (got ${mock.sent[0]})`,
  )
  client.stopReconnecting()
}

// Scenario 7: createAisStreamClient's connection override wins over the
// AISSTREAM_API_KEY env var for both key and URL (the aiscast path in
// index.ts), and the env var is not read at all in that case.
{
  process.env.AISSTREAM_API_KEY = 'env-key-should-be-ignored'
  let capturedUrl: string | undefined
  const mock = new MockSocket()
  const client = createAisStreamClient(
    { boundingBoxes: [[[1, 1], [2, 2]]], filterMessageTypes: ['PositionReport'] },
    { onMessage: () => {} },
    undefined,
    (url, _options) => {
      capturedUrl = url
      return mock
    },
    { url: 'wss://example.invalid/v0/stream', apiKey: 'override-key' },
  )
  client.connect()
  mock.fire('open')

  assert(
    capturedUrl === 'wss://example.invalid/v0/stream',
    `connection override url wins over the default (got ${capturedUrl})`,
  )
  const expected =
    '{"APIKey":"override-key","BoundingBoxes":[[[1,1],[2,2]]],"FilterMessageTypes":["PositionReport"]}'
  assert(
    mock.sent[0] === expected,
    `connection override apiKey wins over env (got ${mock.sent[0]})`,
  )
  client.stopReconnecting()
}

// --- D1 scenarios: error replies from the AIS source, and the key trim ---
//
// console.error and console.log are captured while each scenario runs and
// restored before its asserts, so the [Pass] lines still print. Every
// captured line is also kept in allCaptured for the last check (S-g).

const FAKE_KEY = 'fake-key-123'
const REFUSAL_PREFIX = '[Wake] The AIS source refused the subscription: '
const allCaptured: string[] = []

function captureConsole(): { errors: string[]; restore: () => void } {
  const errors: string[] = []
  const originalError = console.error
  const originalLog = console.log
  console.error = (...args: unknown[]) => {
    const line = args.map((arg) => String(arg)).join(' ')
    errors.push(line)
    allCaptured.push(line)
  }
  console.log = (...args: unknown[]) => {
    allCaptured.push(args.map((arg) => String(arg)).join(' '))
  }
  return {
    errors,
    restore: () => {
      console.error = originalError
      console.log = originalLog
    },
  }
}

function refusalLines(errors: string[]): string[] {
  return errors.filter((line) => line.startsWith(REFUSAL_PREFIX))
}

const TEST_SUBSCRIPTION = { boundingBoxes: [[[1, 1], [2, 2]]], filterMessageTypes: ['PositionReport'] }

// S-a: one error reply after 'open' is logged once and never reaches onMessage.
{
  const output = captureConsole()
  const mock = new MockSocket()
  let delivered = 0
  const client = new AisStreamClient(FAKE_KEY, TEST_SUBSCRIPTION, { onMessage: () => delivered++ }, undefined, () => mock)
  client.connect()
  mock.fire('open')
  mock.fire('message', Buffer.from('{"error":"Api Key Is Not Valid"}'))
  client.stopReconnecting()
  output.restore()

  assert(output.errors.length === 1, `S-a: exactly one console.error line (got ${output.errors.length})`)
  assert(
    output.errors[0]?.startsWith(REFUSAL_PREFIX + 'Api Key Is Not Valid') === true,
    `S-a: the line names the refusal (got ${JSON.stringify(output.errors[0])})`,
  )
  assert(delivered === 0, `S-a: onMessage not called (got ${delivered})`)
}

// S-b: twice on one connection is logged once; a new connect() on the same
// client logs it again once. The second connect() is called directly (the
// factory hands out a fresh mock), so no reconnect timer is needed.
{
  const output = captureConsole()
  const mocks: MockSocket[] = []
  const client = new AisStreamClient(FAKE_KEY, TEST_SUBSCRIPTION, { onMessage: () => {} }, undefined, () => {
    const mock = new MockSocket()
    mocks.push(mock)
    return mock
  })
  client.connect()
  mocks[0].fire('message', Buffer.from('{"error":"Api Key Is Not Valid"}'))
  mocks[0].fire('message', Buffer.from('{"error":"Api Key Is Not Valid"}'))
  const afterFirstConnection = refusalLines(output.errors).length
  client.connect()
  mocks[1].fire('message', Buffer.from('{"error":"Api Key Is Not Valid"}'))
  mocks[1].fire('message', Buffer.from('{"error":"Api Key Is Not Valid"}'))
  const afterSecondConnection = refusalLines(output.errors).length
  client.stopReconnecting()
  output.restore()

  assert(afterFirstConnection === 1, `S-b: two replies on one connection log once (got ${afterFirstConnection})`)
  assert(mocks.length === 2, `S-b: the second connect() opened a new socket (got ${mocks.length})`)
  assert(afterSecondConnection === 2, `S-b: a new connect() logs it again, once (total ${afterSecondConnection})`)
}

// S-c: a key echoed back in the error text is masked.
{
  const output = captureConsole()
  const mock = new MockSocket()
  const client = new AisStreamClient(FAKE_KEY, TEST_SUBSCRIPTION, { onMessage: () => {} }, undefined, () => mock)
  client.connect()
  mock.fire('message', Buffer.from(JSON.stringify({ error: `bad key ${FAKE_KEY}` })))
  client.stopReconnecting()
  output.restore()

  const line = refusalLines(output.errors)[0] ?? ''
  assert(line.includes('<key>'), 'S-c: the logged line shows <key> in place of the key')
  assert(!line.includes(FAKE_KEY), 'S-c: the logged line does not contain the key')
}

// S-d: a long error text with line breaks is one line of at most 200 characters.
{
  const output = captureConsole()
  const mock = new MockSocket()
  const client = new AisStreamClient(FAKE_KEY, TEST_SUBSCRIPTION, { onMessage: () => {} }, undefined, () => mock)
  const longText = ('line one\nline two\r\n' + 'x'.repeat(30) + '\r').repeat(12).slice(0, 500)
  client.connect()
  mock.fire('message', Buffer.from(JSON.stringify({ error: longText })))
  client.stopReconnecting()
  output.restore()

  assert(longText.length === 500, `S-d: the test text is 500 characters (got ${longText.length})`)
  const line = refusalLines(output.errors)[0] ?? ''
  const textPart = line.slice(REFUSAL_PREFIX.length)
  assert(line.startsWith(REFUSAL_PREFIX), 'S-d: the refusal was logged')
  assert(textPart.length > 0 && textPart.length <= 200, `S-d: the text part is at most 200 characters (got ${textPart.length})`)
  assert(!/[\r\n]/.test(line), 'S-d: the logged line has no line breaks')
}

// S-e: a padded key, built the way Scenario 1 builds it, is sent trimmed.
{
  const output = captureConsole()
  process.env.AISSTREAM_API_KEY = `  ${FAKE_KEY} \n`
  const mock = new MockSocket()
  const client = createAisStreamClient(
    { boundingBoxes: [[[51.4, 0.9], [50.8, 2.0]]], filterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'] },
    { onMessage: () => {} },
    undefined,
    (_url, _options) => mock,
  )
  client.connect()
  mock.fire('open')
  client.stopReconnecting()
  output.restore()

  const sentKey = (JSON.parse(mock.sent[0] ?? '{}') as { APIKey?: unknown }).APIKey
  assert(sentKey === FAKE_KEY, 'S-e: the subscription carries the key with the padding trimmed')
}

// S-f: ordinary messages, and an "Error" field on a message that has a
// MessageType, still reach onMessage as before.
{
  const output = captureConsole()
  const mock = new MockSocket()
  const delivered: Array<{ MessageType?: unknown }> = []
  const client = new AisStreamClient(
    FAKE_KEY,
    TEST_SUBSCRIPTION,
    { onMessage: (message) => delivered.push(message) },
    undefined,
    () => mock,
  )
  client.connect()
  mock.fire('open')
  mock.fire('message', Buffer.from('{"MessageType":"PositionReport","MetaData":{"MMSI":123456789},"Message":{}}'))
  mock.fire('message', Buffer.from('{"MessageType":"PositionReport","Error":"x"}'))
  client.stopReconnecting()
  output.restore()

  assert(delivered.length === 2, `S-f: both messages reached onMessage (got ${delivered.length})`)
  assert(delivered[0]?.MessageType === 'PositionReport', 'S-f: the PositionReport reached onMessage')
  assert(
    (delivered[1] as { Error?: unknown } | undefined)?.Error === 'x',
    'S-f: the message with a MessageType and an "Error" field reached onMessage',
  )
  assert(refusalLines(output.errors).length === 0, 'S-f: nothing was logged as a refusal')
}

// S-g: the raw key never appeared in any console output captured above.
assert(allCaptured.length > 0, `S-g: console output was captured (${allCaptured.length} lines)`)
assert(!allCaptured.some((line) => line.includes(FAKE_KEY)), 'S-g: the raw key never appears in captured console output')

// Summary comes last so its fail-guard covers every scenario in this
// file, including the DEMO-1 ones above.
const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}

// Every scenario above calls connect(), which schedules a real 60s
// setTimeout (the backoff-healthy-reset timer -- not clock-injectable in
// AisStreamClient today). stopReconnecting() only stops future reconnects,
// not that specific already-armed timer once it's about to fire, but it
// does clear it via clearTimeout when called right after connect() as
// above. Exiting explicitly here is belt-and-braces so a future scenario
// that forgets the stopReconnecting() call doesn't silently make this file
// hang for 60s instead of failing fast.
process.exit(failed === 0 ? 0 : 1)
