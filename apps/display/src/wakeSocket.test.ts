import { DEFAULT_CONFIG } from '@wake/shared'
import {
  handleIncomingData,
  pruneExpiredVessels,
  WakeConnection,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  JITTER_MAX_MS,
  HEALTHY_RESET_MS,
  type VesselStateMap,
  type WakeSocketLike,
  type SocketFactory,
  type ScheduleFn,
  type CancelFn,
} from './wakeSocket'

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

// No DOM, no browser -- this suite drives wakeSocket.ts entirely through
// its injected SocketFactory/ScheduleFn/CancelFn, the same style
// glyphs.test.ts and trails.test.ts already use to test canvas code
// under tsx with a mocked CanvasRenderingContext2D.

class MockWakeSocket implements WakeSocketLike {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readyState = 0
  closed = false

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  triggerOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  triggerMessage(data: string): void {
    this.onmessage?.({ data })
  }

  triggerClose(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

function createTrackingSocketFactory(): { factory: SocketFactory; sockets: MockWakeSocket[] } {
  const sockets: MockWakeSocket[] = []
  const factory: SocketFactory = () => {
    const socket = new MockWakeSocket()
    sockets.push(socket)
    return socket
  }
  return { factory, sockets }
}

interface ScheduledCall {
  fn: () => void
  delayMs: number
  handle: number
  cancelled: boolean
}

function createTrackingScheduler(): { scheduleFn: ScheduleFn; cancelFn: CancelFn; calls: ScheduledCall[] } {
  const calls: ScheduledCall[] = []
  let nextHandle = 1
  const scheduleFn: ScheduleFn = (fn, delayMs) => {
    const handle = nextHandle++
    calls.push({ fn, delayMs, handle, cancelled: false })
    return handle
  }
  const cancelFn: CancelFn = (handle) => {
    const call = calls.find((c) => c.handle === handle)
    if (call) call.cancelled = true
  }
  return { scheduleFn, cancelFn, calls }
}

function lastPendingCall(calls: ScheduledCall[]): ScheduledCall {
  const pending = [...calls].reverse().find((c) => !c.cancelled)
  if (!pending) throw new Error('test setup error: no pending scheduled call')
  return pending
}

// Scenario 1: a snapshot populates initial state correctly.
{
  const state: VesselStateMap = new Map()
  const snapshot = {
    kind: 'snapshot',
    vessels: [
      {
        kind: 'position',
        fix: { mmsi: '111111111', lat: 51, lon: 1, cogDeg: 0, sogKn: 5, timestamp: 1000 },
        shipName: 'ALPHA',
        vesselType: 'cargo',
      },
      {
        kind: 'position',
        fix: { mmsi: '222222222', lat: 52, lon: 2, cogDeg: 90, sogKn: 0, timestamp: 2000 },
      },
    ],
  }
  handleIncomingData(state, JSON.stringify(snapshot))
  assert(state.size === 2, 'snapshot: both vessels present')
  assert(state.get('111111111')?.shipName === 'ALPHA', 'snapshot: static fields on the typed vessel')
  assert(state.get('111111111')?.fix?.lat === 51, 'snapshot: fix on the typed vessel')
  assert(state.get('222222222')?.shipName === undefined, 'snapshot: no static fields on the untyped vessel')
}

// Scenario 2: a position delta updates the right vessel by mmsi.
{
  const state: VesselStateMap = new Map()
  handleIncomingData(
    state,
    JSON.stringify({ kind: 'position', fix: { mmsi: '333333333', lat: 10, lon: 20, cogDeg: 1, sogKn: 2, timestamp: 500 } }),
  )
  assert(state.size === 1 && state.get('333333333')?.fix?.lat === 10, 'position delta: initial fix stored')

  handleIncomingData(
    state,
    JSON.stringify({ kind: 'position', fix: { mmsi: '333333333', lat: 11, lon: 21, cogDeg: 1, sogKn: 2, timestamp: 600 } }),
  )
  assert(state.size === 1, 'position delta: updated in place, not duplicated')
  assert(state.get('333333333')?.fix?.lat === 11, 'position delta: fix updated to the newer value')
}

// Scenario 3: a static delta merges name and type into an existing vessel.
{
  const state: VesselStateMap = new Map()
  handleIncomingData(
    state,
    JSON.stringify({ kind: 'position', fix: { mmsi: '444444444', lat: 1, lon: 1, cogDeg: 0, sogKn: 0, timestamp: 100 } }),
  )
  handleIncomingData(state, JSON.stringify({ kind: 'static', mmsi: '444444444', shipName: 'BETA', vesselType: 'tanker' }))

  const entry = state.get('444444444')
  assert(entry?.fix?.lat === 1, 'static merge: existing fix preserved')
  assert(entry?.shipName === 'BETA' && entry?.vesselType === 'tanker', 'static merge: static fields merged in')
}

// Scenario 4: a static delta for an unknown mmsi creates an entry with
// static fields and no fix -- consistent with the server's own static
// map being a genuinely separate concern from the position map.
{
  const state: VesselStateMap = new Map()
  handleIncomingData(state, JSON.stringify({ kind: 'static', mmsi: '555555555', shipName: 'GAMMA', vesselType: 'ferry' }))

  const entry = state.get('555555555')
  assert(entry !== undefined, 'static-for-unknown: entry created')
  assert(entry?.fix === undefined, 'static-for-unknown: no fix -- only static data has ever been seen')
  assert(entry?.shipName === 'GAMMA' && entry?.vesselType === 'ferry', 'static-for-unknown: static fields recorded')
}

// Scenario 5: a position delta for a vessel not in state creates a new
// entry with just the fix.
{
  const state: VesselStateMap = new Map()
  handleIncomingData(
    state,
    JSON.stringify({ kind: 'position', fix: { mmsi: '666666666', lat: 5, lon: 5, cogDeg: 0, sogKn: 1, headingDeg: 217, timestamp: 700 } }),
  )
  const entry = state.get('666666666')
  assert(entry?.fix?.mmsi === '666666666', 'position-for-unknown: entry created with the fix')
  assert(entry?.fix?.headingDeg === 217, 'position-for-unknown: reported heading preserved on the fix')
  assert(entry?.shipName === undefined, 'position-for-unknown: no static data yet')
}

// A later position fix replaces the full fix, including removing a heading
// that is absent from the new report; it must not preserve a stale heading.
{
  const state: VesselStateMap = new Map()
  const fixes: Array<{ headingDeg?: number }> = []
  handleIncomingData(
    state,
    JSON.stringify({ kind: 'position', fix: { mmsi: 'HEAD00001', lat: 5, lon: 5, cogDeg: 0, sogKn: 0, headingDeg: 217, timestamp: 700 } }),
    (fix) => fixes.push(fix),
  )
  assert(state.get('HEAD00001')?.fix?.headingDeg === 217, 'heading-replace: heading kept on initial position and callback fix')
  handleIncomingData(
    state,
    JSON.stringify({ kind: 'position', fix: { mmsi: 'HEAD00001', lat: 5, lon: 5, cogDeg: 0, sogKn: 0, timestamp: 800 } }),
    (fix) => fixes.push(fix),
  )
  const latestFix = state.get('HEAD00001')?.fix
  assert(
    latestFix !== undefined && !Object.prototype.hasOwnProperty.call(latestFix, 'headingDeg'),
    'heading-replace: later fix without heading replaces rather than retains the old heading',
  )
  assert(
    fixes.length === 2 && fixes[0]?.headingDeg === 217 &&
      !Object.prototype.hasOwnProperty.call(fixes[1], 'headingDeg'),
    'heading-replace: applyPositionMessage passes each complete fix through applyFix callback',
  )
}

// Scenario 6: close triggers reconnect with backoff matching
// aisstream.ts's constants exactly -- the server not running at page
// load is the same case: a socket that closes without ever opening
// funnels through this identical path.
{
  const state: VesselStateMap = new Map()
  const { factory, sockets } = createTrackingSocketFactory()
  const { scheduleFn, cancelFn, calls } = createTrackingScheduler()
  const conn = new WakeConnection('ws://test', state, factory, scheduleFn, cancelFn)

  conn.connect()
  assert(sockets.length === 1, 'connect: one socket created')

  sockets[0].triggerClose() // never opened -- "server not running at page load"
  const reconnect = lastPendingCall(calls)
  assert(
    reconnect.delayMs >= BASE_BACKOFF_MS && reconnect.delayMs < BASE_BACKOFF_MS + JITTER_MAX_MS,
    `close-without-open: reconnect delay within [${BASE_BACKOFF_MS}, ${BASE_BACKOFF_MS + JITTER_MAX_MS}) (got ${reconnect.delayMs})`,
  )

  reconnect.fn()
  assert(sockets.length === 2, 'close-without-open: reconnect attempt created a new socket, same path as any other disconnect')
}

// Scenario 7: repeated failures back off up to the cap and no further.
{
  const state: VesselStateMap = new Map()
  const { factory, sockets } = createTrackingSocketFactory()
  const { scheduleFn, cancelFn, calls } = createTrackingScheduler()
  const conn = new WakeConnection('ws://test', state, factory, scheduleFn, cancelFn)
  conn.connect()

  // Expected minimum delay (pre-jitter) at each successive close, given
  // backoff doubles after scheduling and caps at MAX_BACKOFF_MS:
  // 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000
  const expectedMins = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]

  for (let i = 0; i < expectedMins.length; i++) {
    const socket = sockets[sockets.length - 1]
    socket.triggerClose()
    const call = lastPendingCall(calls)
    const expectedMin = expectedMins[i]
    assert(
      call.delayMs >= expectedMin && call.delayMs < expectedMin + JITTER_MAX_MS,
      `backoff step ${i + 1}: delay within [${expectedMin}, ${expectedMin + JITTER_MAX_MS}) (got ${call.delayMs})`,
    )
    call.fn()
  }

  assert(conn.getBackoffMs() === MAX_BACKOFF_MS, `backoff capped at MAX_BACKOFF_MS (${MAX_BACKOFF_MS}) after repeated failures (got ${conn.getBackoffMs()})`)
}

// Scenario 8: a successful reconnect resets backoff, matching the
// server-side pattern -- only after HEALTHY_RESET_MS of sustained
// connection, not immediately on open.
{
  const state: VesselStateMap = new Map()
  const { factory, sockets } = createTrackingSocketFactory()
  const { scheduleFn, cancelFn, calls } = createTrackingScheduler()
  const conn = new WakeConnection('ws://test', state, factory, scheduleFn, cancelFn)
  conn.connect()

  sockets[0].triggerClose()
  const firstReconnect = lastPendingCall(calls)
  firstReconnect.fn() // backoff doubles to 2000, connects socket #2
  assert(conn.getBackoffMs() === 2000, 'reconnect-reset: backoff doubled after one failure')

  sockets[1].triggerOpen()
  const healthyCall = lastPendingCall(calls)
  assert(healthyCall.delayMs === HEALTHY_RESET_MS, `reconnect-reset: healthy-reset scheduled at HEALTHY_RESET_MS (${HEALTHY_RESET_MS})`)
  assert(conn.getBackoffMs() === 2000, 'reconnect-reset: backoff NOT reset immediately on open, matching server pattern')

  healthyCall.fn() // simulate HEALTHY_RESET_MS elapsing while still open
  assert(conn.getBackoffMs() === BASE_BACKOFF_MS, `reconnect-reset: backoff reset to BASE (${BASE_BACKOFF_MS}) after sustained health`)
}

// Scenario 9: a fresh snapshot omitting a held vessel does not delete it.
{
  const state: VesselStateMap = new Map()
  handleIncomingData(
    state,
    JSON.stringify({ kind: 'position', fix: { mmsi: '777777777', lat: 1, lon: 1, cogDeg: 0, sogKn: 0, timestamp: 100 } }),
  )
  handleIncomingData(state, JSON.stringify({ kind: 'snapshot', vessels: [] }))
  assert(state.has('777777777'), 'reconnect-merge: vessel not deleted just because a new snapshot omits it')
}

// Scenario 10: that vessel expires via isExpired at the correct nowMs,
// and not before -- using the existing removeSec, no new threshold.
{
  const state: VesselStateMap = new Map()
  state.set('888888888', { fix: { mmsi: '888888888', lat: 1, lon: 1, cogDeg: 0, sogKn: 0, timestamp: 0 } })
  const removeSec = DEFAULT_CONFIG.removeSec

  pruneExpiredVessels(state, removeSec * 1000 - 1, removeSec)
  assert(state.has('888888888'), `prune: not pruned just before the removeSec boundary (${removeSec}s)`)

  pruneExpiredVessels(state, removeSec * 1000, removeSec)
  assert(!state.has('888888888'), `prune: pruned exactly at the removeSec boundary (${removeSec}s)`)
}

// Scenario 11: malformed JSON does not throw or kill the connection.
{
  const state: VesselStateMap = new Map()
  let threw = false
  try {
    handleIncomingData(state, '{not valid json')
  } catch {
    threw = true
  }
  assert(!threw, 'malformed JSON: handleIncomingData does not throw')
  assert(state.size === 0, 'malformed JSON: no state mutation')

  const { factory, sockets } = createTrackingSocketFactory()
  const conn = new WakeConnection('ws://test', new Map(), factory)
  conn.connect()
  let connectionThrew = false
  try {
    sockets[0].triggerMessage('{not valid json')
  } catch {
    connectionThrew = true
  }
  assert(!connectionThrew, 'malformed JSON: does not throw through the live onmessage handler either')
  assert(!sockets[0].closed, 'malformed JSON: socket is not closed because of it')
}

// Scenario 12: a message with an unrecognized discriminant (or none at
// all) is ignored silently.
{
  const state: VesselStateMap = new Map()
  handleIncomingData(state, JSON.stringify({ kind: 'unknown-type', foo: 'bar' }))
  assert(state.size === 0, 'unrecognized discriminant: no mutation')

  handleIncomingData(state, JSON.stringify({ foo: 'bar' }))
  assert(state.size === 0, 'no discriminant at all: no mutation')
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
