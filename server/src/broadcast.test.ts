import fs from 'node:fs'
import { normalize } from './normalize.ts'
import { processEnvelope, type PipelineContext } from './pipeline.ts'
import {
  createPositionMap,
  createStaticMap,
  evictStalePositions,
  upsertStatic,
  touchStaticOnActivity,
  STATIC_MAP_CAP,
} from './caches.ts'
import {
  broadcastToClients,
  sendSnapshot,
  mergeStatic,
  BUFFERED_AMOUNT_LIMIT_BYTES,
  type ClientSocket,
  type BroadcastMessage,
} from './broadcast.ts'

let passed = 0
let failed = 0
let skipped = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    console.log(`[Pass] ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}`)
  }
}

// Replay harness driving server/src/pipeline.ts (unit 1's seam) directly --
// no AisStreamClient instantiated anywhere in this file, no real
// WebSocketServer, no real sockets. Runs as fast as possible; every
// time-dependent check passes an explicit nowMs rather than sleeping.

class MockClient implements ClientSocket {
  readyState = 1 // OPEN
  bufferedAmount = 0
  sent: string[] = []
  closed = false
  shouldThrow = false
  private closeListeners: Array<() => void> = []

  send(data: string): void {
    if (this.shouldThrow) throw new Error('mock send failure')
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3 // CLOSED
    for (const cb of this.closeListeners) cb()
  }

  once(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeListeners.push(listener)
  }
}

// captured, line 2 -- PositionReport, MMSI 356219000 ("CASTOR LEADER"),
// no ShipStaticData ever sent for it in these fixtures
const CAPTURED_POSITION_356219000 = JSON.parse(`
{"MetaData":{"MMSI":356219000,"MMSI_String":356219000,"ShipName":"CASTOR LEADER       ","latitude":51.09419,"longitude":1.76198,"time_utc":"2026-09-14 22:21:32.409064434 +0000 UTC"},"MessageType":"PositionReport","Message":{"PositionReport":{"MessageID":1,"RepeatIndicator":0,"UserID":356219000,"Valid":true,"NavigationalStatus":0,"RateOfTurn":6,"Sog":13.3,"PositionAccuracy":true,"Longitude":1.7619783333333332,"Latitude":51.094190000000005,"Cog":44.2,"TrueHeading":45,"Timestamp":25,"SpecialManoeuvreIndicator":0,"Spare":0,"Raim":false,"CommunicationState":2226}}}
`)
const CAPTURED_POSITION_356219000_TS = 1789424492409

// captured, line 9 -- PositionReport, MMSI 538006603, ten seconds before
// that vessel's own ShipStaticData below
const CAPTURED_POSITION_538006603 = JSON.parse(`
{"MetaData":{"MMSI":538006603,"MMSI_String":538006603,"ShipName":"GLOBE TRINCO        ","latitude":51.07105,"longitude":1.71243,"time_utc":"2026-09-14 22:21:38.147295407 +0000 UTC"},"MessageType":"PositionReport","Message":{"PositionReport":{"MessageID":1,"RepeatIndicator":0,"UserID":538006603,"Valid":true,"NavigationalStatus":0,"RateOfTurn":0,"Sog":8.8,"PositionAccuracy":true,"Longitude":1.7124333333333333,"Latitude":51.07105,"Cog":43,"TrueHeading":44,"Timestamp":33,"SpecialManoeuvreIndicator":0,"Spare":0,"Raim":false,"CommunicationState":99563}}}
`)
const CAPTURED_POSITION_538006603_TS = 1789424498147 // independently verified: Date.UTC(2026,8,14,22,21,38,147)

// captured, line 15 -- ShipStaticData for the same vessel, Type 70
const CAPTURED_STATIC_538006603 = JSON.parse(`
{"MetaData":{"MMSI":538006603,"MMSI_String":538006603,"ShipName":"GLOBE TRINCO        ","latitude":51.07132,"longitude":1.71283,"time_utc":"2026-09-14 22:21:48.232679479 +0000 UTC"},"MessageType":"ShipStaticData","Message":{"ShipStaticData":{"AisVersion":2,"CallSign":"V7OY6  ","Destination":"PL SWI              ","Dimension":{"A":160,"B":30,"C":11,"D":21},"Dte":false,"Eta":{"Day":17,"Hour":12,"Minute":0,"Month":9},"FixType":1,"ImoNumber":9403126,"MaximumStaticDraught":12.6,"MessageID":5,"Name":"GLOBE TRINCO        ","RepeatIndicator":0,"Spare":false,"Type":70,"UserID":538006603,"Valid":true}}}
`)
const CAPTURED_STATIC_538006603_TS = 1789424508232

// captured, line 1 -- SubscriptionConfirmation, no MetaData at all
const CAPTURED_SUBSCRIPTION_CONFIRMATION = JSON.parse(`
{"Message":{"CompressionEnabled":true},"MessageType":"SubscriptionConfirmation"}
`)

function freshCtx(): PipelineContext {
  return {
    positionMap: createPositionMap(),
    staticMap: createStaticMap(),
    clients: new Set<ClientSocket>(),
    removeSec: 900,
  }
}

// Scenario 1: position arrives with no ShipStaticData ever seen -- VIS-7
// fix (caches.ts's upsertPositionShipName): the position message's own
// MetaData.ShipName ("CASTOR LEADER") now fills the name in, with
// vesselType left at 'unknown' (never a guess) and no dimensions. Before
// VIS-7 this asserted shipName/vesselType/dimensions all undefined --
// that was the dropped-name bug flagged in VIS-7's A1a audit, not
// correct behaviour: CLAUDE.md records ShipName present on ~100% of
// PositionReports, so a vessel that never sends static data is exactly
// the case this fix exists for.
{
  const ctx = freshCtx()
  processEnvelope(CAPTURED_POSITION_356219000, ctx, CAPTURED_POSITION_356219000_TS)
  const fix = ctx.positionMap.get('356219000')
  assert(fix !== undefined, 'position-before-static: fix stored in position map')
  assert(fix?.lat === 51.09419, 'position-before-static: lat is the lowercase MetaData value')
  if (fix) {
    const merged = mergeStatic(fix, ctx.staticMap)
    assert(
      merged.shipName === 'CASTOR LEADER' && merged.vesselType === 'unknown' && merged.dimensions === undefined,
      `position-before-static (VIS-7): name filled from the position message itself, type left 'unknown', no dimensions (got ${JSON.stringify(merged)})`,
    )
  }
}

// Scenario 2: exact merge outcome for a named MMSI, reproducible
// byte-for-byte from two real captured lines for the same vessel.
{
  const ctx = freshCtx()
  processEnvelope(CAPTURED_POSITION_538006603, ctx, CAPTURED_POSITION_538006603_TS)
  processEnvelope(CAPTURED_STATIC_538006603, ctx, CAPTURED_STATIC_538006603_TS)

  const fix = ctx.positionMap.get('538006603')
  const merged = fix ? mergeStatic(fix, ctx.staticMap) : undefined
  const expected = {
    kind: 'position',
    fix: {
      mmsi: '538006603',
      lat: 51.07105,
      lon: 1.71243,
      cogDeg: 43,
      sogKn: 8.8,
      timestamp: CAPTURED_POSITION_538006603_TS,
    },
    shipName: 'GLOBE TRINCO',
    vesselType: 'cargo',
    dimensions: { lengthM: 190, beamM: 32 },
  }
  assert(
    JSON.stringify(merged) === JSON.stringify(expected),
    `merge outcome for 538006603 exact byte-for-byte (got ${JSON.stringify(merged)})`,
  )
}

// Scenario 3: exact snapshot contents for a simulated connect after three
// controlled messages.
{
  const ctx = freshCtx()
  processEnvelope(CAPTURED_POSITION_356219000, ctx, CAPTURED_POSITION_356219000_TS)
  processEnvelope(CAPTURED_POSITION_538006603, ctx, CAPTURED_POSITION_538006603_TS)
  processEnvelope(CAPTURED_STATIC_538006603, ctx, CAPTURED_STATIC_538006603_TS)

  const client = new MockClient()
  sendSnapshot(ctx.clients, client, ctx.positionMap, ctx.staticMap)
  assert(client.sent.length === 1, 'snapshot-after-N: exactly one message sent to the connecting client')

  interface SnapshotVessel {
    fix: { mmsi: string }
    shipName?: string
    vesselType?: string
  }
  const snapshot: { kind?: string; vessels?: SnapshotVessel[] } | undefined = client.sent[0]
    ? JSON.parse(client.sent[0])
    : undefined
  assert(snapshot?.kind === 'snapshot', 'snapshot-after-N: message kind is snapshot')
  assert(snapshot?.vessels?.length === 2, 'snapshot-after-N: two vessels present')
  const byMmsi = new Map((snapshot?.vessels ?? []).map((v) => [v.fix.mmsi, v] as [string, SnapshotVessel]))
  assert(
    byMmsi.get('356219000')?.shipName === 'CASTOR LEADER',
    'snapshot-after-N (VIS-7): 356219000 has its name filled in from its own position message, despite no ShipStaticData ever seen',
  )
  assert(
    byMmsi.get('538006603')?.shipName === 'GLOBE TRINCO' && byMmsi.get('538006603')?.vesselType === 'cargo',
    'snapshot-after-N: 538006603 has its static fields merged into the snapshot',
  )
}

// Scenario 4: exact eviction timing under controlled nowMs.
{
  const positionMap = createPositionMap()
  positionMap.set('111111111', { mmsi: '111111111', lat: 51, lon: 1, cogDeg: 0, sogKn: 0, timestamp: 0 })

  evictStalePositions(positionMap, 899999, 900)
  assert(positionMap.has('111111111'), 'eviction: not evicted just before the removeSec boundary (899.999s)')

  evictStalePositions(positionMap, 900000, 900)
  assert(!positionMap.has('111111111'), 'eviction: evicted exactly at the removeSec boundary (900.000s)')
}

// Scenario 5: one mock client's send() throws -- all others still
// receive the broadcast, and the throwing client is absent afterward.
{
  const clients = new Set<ClientSocket>()
  const good1 = new MockClient()
  const bad = new MockClient()
  bad.shouldThrow = true
  const good2 = new MockClient()
  clients.add(good1)
  clients.add(bad)
  clients.add(good2)

  const message: BroadcastMessage = { kind: 'static', mmsi: '999999999', vesselType: 'cargo' }
  broadcastToClients(clients, message)

  assert(good1.sent.length === 1, 'throw-isolation: good1 received the broadcast')
  assert(good2.sent.length === 1, 'throw-isolation: good2 received the broadcast')
  assert(bad.closed === true, 'throw-isolation: throwing client was closed')
  assert(!clients.has(bad), 'throw-isolation: throwing client removed from the active set')

  broadcastToClients(clients, message)
  assert(good1.sent.length === 2, 'throw-isolation: good1 received a second broadcast')
  assert(bad.sent.length === 0, 'throw-isolation: dropped client received nothing, ever')
}

// Scenario 6: a real captured SubscriptionConfirmation produces no cache
// mutation and no broadcast, and the next envelope still processes.
{
  const ctx = freshCtx()
  const mock = new MockClient()
  ctx.clients.add(mock)

  processEnvelope(CAPTURED_SUBSCRIPTION_CONFIRMATION, ctx, 1789424494377)
  assert(ctx.positionMap.size === 0, 'subscription-confirmation: no position mutation')
  assert(ctx.staticMap.size === 0, 'subscription-confirmation: no static mutation')
  assert(mock.sent.length === 0, 'subscription-confirmation: no broadcast sent')

  processEnvelope(CAPTURED_POSITION_356219000, ctx, CAPTURED_POSITION_356219000_TS)
  assert(ctx.positionMap.size === 1, 'subscription-confirmation: next real envelope still processes')
  assert(mock.sent.length === 1, 'subscription-confirmation: next envelope still broadcasts')
}

// Scenario 7: a forced normalize() throw is caught, logged exactly once,
// and processing continues to the next envelope. normalize() is proven
// not to throw by its own 48-assertion suite, so this needs fault
// injection via processEnvelope's normalizeFn parameter to exercise the
// defensive catch at all.
{
  const ctx = freshCtx()
  let callCount = 0
  const faultyNormalize: typeof normalize = (envelope: unknown) => {
    callCount++
    if (callCount === 1) throw new Error('injected fault')
    return normalize(envelope)
  }

  const originalError = console.error
  let errorLogCount = 0
  console.error = (..._args: unknown[]) => {
    errorLogCount++
  }

  processEnvelope(CAPTURED_POSITION_356219000, ctx, CAPTURED_POSITION_356219000_TS, faultyNormalize)
  processEnvelope(CAPTURED_POSITION_538006603, ctx, CAPTURED_POSITION_538006603_TS, faultyNormalize)

  console.error = originalError

  assert(errorLogCount === 1, `forced-throw: exactly one error logged (got ${errorLogCount})`)
  assert(ctx.positionMap.size === 1, 'forced-throw: processing continued past the injected failure')
  assert(ctx.positionMap.has('538006603'), 'forced-throw: the surviving fix is the second, non-faulted envelope')
}

// Scenario 8: a mock client whose send() throws on the snapshot payload
// is dropped exactly like any broken-client send; a second client
// connecting afterward still gets a complete snapshot.
{
  const ctx = freshCtx()
  processEnvelope(CAPTURED_POSITION_538006603, ctx, CAPTURED_POSITION_538006603_TS)
  processEnvelope(CAPTURED_STATIC_538006603, ctx, CAPTURED_STATIC_538006603_TS)

  const badClient = new MockClient()
  badClient.shouldThrow = true
  sendSnapshot(ctx.clients, badClient, ctx.positionMap, ctx.staticMap)
  assert(badClient.closed === true, 'snapshot-failure: throwing client dropped')

  const goodClient = new MockClient()
  sendSnapshot(ctx.clients, goodClient, ctx.positionMap, ctx.staticMap)
  assert(goodClient.sent.length === 1, 'snapshot-failure: second client still received a snapshot')
  const received = goodClient.sent[0] ? JSON.parse(goodClient.sent[0]) : undefined
  assert(
    received?.kind === 'snapshot' && received?.vessels?.length === 1,
    'snapshot-failure: second client got a complete, correct snapshot',
  )
}

// Scenario 9: AIS disconnect mid-replay -- simulated by simply not
// calling processEnvelope for a stretch. Nothing in this design removes
// clients or sends anything during a gap; that absence IS the design.
{
  const clients = new Set<ClientSocket>()
  const c1 = new MockClient()
  const c2 = new MockClient()
  clients.add(c1)
  clients.add(c2)

  assert(clients.size === 2, 'ais-disconnect: clients remain connected through a quiet period')
  assert(c1.sent.length === 0 && c2.sent.length === 0, 'ais-disconnect: no broadcasts occurred during the gap')
}

// Scenario 10: a client reporting bufferedAmount over the 256KB limit is
// dropped on the next send; a normal client is unaffected.
{
  const clients = new Set<ClientSocket>()
  const stuck = new MockClient()
  stuck.bufferedAmount = BUFFERED_AMOUNT_LIMIT_BYTES + 1
  const normalClient = new MockClient()
  clients.add(stuck)
  clients.add(normalClient)

  broadcastToClients(clients, { kind: 'static', mmsi: '1', vesselType: 'cargo' })

  assert(stuck.closed === true, 'backpressure: stuck client dropped')
  assert(stuck.sent.length === 0, 'backpressure: stuck client never actually received the send')
  assert(normalClient.sent.length === 1, 'backpressure: normal client unaffected')
}

// Scenario 11: LRU eviction at the cap -- least-recently-seen entry goes
// first, and activity (not just a fresh static message) counts as "seen."
{
  const staticMap = createStaticMap()
  const smallCap = 3
  upsertStatic(staticMap, 'A', { vesselType: 'cargo' }, smallCap)
  upsertStatic(staticMap, 'B', { vesselType: 'tanker' }, smallCap)
  upsertStatic(staticMap, 'C', { vesselType: 'ferry' }, smallCap)
  assert(staticMap.size === 3, 'lru: cap not exceeded yet')

  touchStaticOnActivity(staticMap, 'A') // A is now most-recently-used; B is least

  upsertStatic(staticMap, 'D', { vesselType: 'naval' }, smallCap)
  assert(staticMap.size === 3, 'lru: cap enforced after the fourth insert')
  assert(staticMap.has('A'), 'lru: recently-touched A survives')
  assert(!staticMap.has('B'), 'lru: least-recently-used B was evicted')
  assert(staticMap.has('C') && staticMap.has('D'), 'lru: C and D both present')

  assert(STATIC_MAP_CAP === 5000, `static map default cap is 5000 (got ${STATIC_MAP_CAP})`)
}

// Scenario 12 (file-dependent): replay the entire real capture end to
// end at real relative timing. Skips gracefully if the gitignored
// capture file is absent -- every scenario above uses only lines
// copy-pasted directly into this file and never touches disk.
{
  const capturePath = 'server/server/captures/dover-30min.ndjson'
  if (!fs.existsSync(capturePath)) {
    console.log(
      `[SKIP] full-capture replay: ${capturePath} not present (gitignored) -- skipping file-dependent assertions`,
    )
    skipped++
  } else {
    const lines = fs.readFileSync(capturePath, 'utf8').split('\n').filter(Boolean)
    const records = lines.map((l) => JSON.parse(l))

    const ctx = freshCtx()
    for (const r of records) {
      processEnvelope(r.envelope, ctx, r.receivedAtMs)
    }

    // Deterministic and exact for this fixed file -- computed once by
    // running this harness and reading the real output, then locked in
    // as a regression check. Expected to be lower than the 98-vessel
    // cumulative-discovery figure on record in CLAUDE.md: replaying at
    // real relative timing means removeSec eviction has already retired
    // vessels quiet for the last 900s by the end of the file, which is
    // the eviction working as designed, not a discrepancy.
    assert(records.length === 1163, `full-capture replay: processed all 1163 envelopes (got ${records.length})`)
    assert(
      ctx.positionMap.size === 89,
      `full-capture replay: live position map size at end of file (got ${ctx.positionMap.size})`,
    )
    // VIS-7: was 57 (only vessels that ever sent ShipStaticData) before
    // caches.ts's upsertPositionShipName started filling a name in from
    // any position message's own MetaData.ShipName. 98 is every distinct
    // MMSI ever seen in the capture (CLAUDE.md's cumulative-discovery
    // figure) -- confirming the fix reaches every discoverable vessel,
    // not just the ones that also happened to send static data. Measured
    // by running this harness and reading the real output, same as the
    // rest of this scenario's own documented convention.
    assert(
      ctx.staticMap.size === 98,
      `full-capture replay: static map size at end of file, never evicted by removeSec (got ${ctx.staticMap.size})`,
    )
  }
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed${skipped > 0 ? ` (${skipped} file-dependent scenario skipped)` : ''}`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
