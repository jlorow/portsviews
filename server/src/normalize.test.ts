import { normalize } from './normalize.ts'

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

// All fixtures below marked "captured, line N" are copy-pasted verbatim
// (envelope field only) from server/server/captures/dover-30min.ndjson,
// a 31-minute live AISstream capture over Dover Strait. That file is
// gitignored and never read at test time.
//
// Fixtures marked CONSTRUCTED were built by hand from the same real
// schema because an exhaustive scan of all 1163 captured lines proved
// the combination does not occur there:
//   - Every Sog:102.3 line (5 total) pairs with Cog:360 (both sentinel).
//   - Every Cog:360 line (45 total) pairs with Sog 0 or 102.3, never a
//     real nonzero non-sentinel speed.
//   - No PositionReport/StandardClassBPositionReport line omits Sog/Cog
//     or carries NaN.
//   - No ShipStaticData line carries Type 99 or a blank Name.
// So the single most important scenario in this story — a real nonzero
// Sog paired with a sentinel Cog, the case that would otherwise dead
// reckon a vessel due north at its true speed — cannot be built from
// captured data and is constructed here instead.

// captured, line 2 — PositionReport, 9-digit MMSI, valid Sog/Cog,
// lowercase/capitalised lat & lon diverge (proves lowercase is read)
const CAPTURED_POSITION_VALID = JSON.parse(`
{"MetaData":{"MMSI":356219000,"MMSI_String":356219000,"ShipName":"CASTOR LEADER       ","latitude":51.09419,"longitude":1.76198,"time_utc":"2026-09-14 22:21:32.409064434 +0000 UTC"},"MessageType":"PositionReport","Message":{"PositionReport":{"MessageID":1,"RepeatIndicator":0,"UserID":356219000,"Valid":true,"NavigationalStatus":0,"RateOfTurn":6,"Sog":13.3,"PositionAccuracy":true,"Longitude":1.7619783333333332,"Latitude":51.094190000000005,"Cog":44.2,"TrueHeading":45,"Timestamp":25,"SpecialManoeuvreIndicator":0,"Spare":0,"Raim":false,"CommunicationState":2226}}}
`)

// captured, line 51 — shortest observed MMSI_String (7 digits)
const CAPTURED_POSITION_SHORT_MMSI = JSON.parse(`
{"MetaData":{"MMSI":2278000,"MMSI_String":2278000,"ShipName":"PORT DE CALAIS      ","latitude":50.96705,"longitude":1.84766,"time_utc":"2026-09-14 22:22:43.186308227 +0000 UTC"},"MessageType":"PositionReport","Message":{"PositionReport":{"MessageID":1,"RepeatIndicator":0,"UserID":2278000,"Valid":true,"NavigationalStatus":15,"RateOfTurn":-128,"Sog":0,"PositionAccuracy":true,"Longitude":1.8476633333333334,"Latitude":50.96705,"Cog":260.6,"TrueHeading":511,"Timestamp":42,"SpecialManoeuvreIndicator":0,"Spare":0,"Raim":true,"CommunicationState":34336}}}
`)

// captured, line 314 — StandardClassBPositionReport, both Sog and Cog
// sentinel, MetaData.ShipName blank
const CAPTURED_BOTH_SENTINEL_BLANK_NAME = JSON.parse(`
{"MetaData":{"MMSI":235071785,"MMSI_String":235071785,"ShipName":"","latitude":51.32827,"longitude":1.4206,"time_utc":"2026-09-14 22:29:27.176787709 +0000 UTC"},"MessageType":"StandardClassBPositionReport","Message":{"StandardClassBPositionReport":{"AssignedMode":false,"ClassBBand":true,"ClassBDisplay":false,"ClassBDsc":true,"ClassBMsg22":true,"ClassBUnit":false,"Cog":360,"CommunicationState":85834,"CommunicationStateIsItdma":true,"Latitude":51.328271666666666,"Longitude":1.4206033333333332,"MessageID":18,"PositionAccuracy":false,"Raim":false,"RepeatIndicator":0,"Sog":102.3,"Spare1":0,"Spare2":0,"Timestamp":23,"TrueHeading":511,"UserID":235071785,"Valid":true}}}
`)

// captured, line 25 — Cog sentinel with a real (but zero) Sog. Real, but
// does not exercise the drift danger since zero speed can't drift either
// way; see CONSTRUCTED_COG_SENTINEL_NONZERO_SOG below for that case.
const CAPTURED_COG_SENTINEL_ZERO_SOG = JSON.parse(`
{"MetaData":{"MMSI":232042999,"MMSI_String":232042999,"ShipName":"CAROUSEL SH298","latitude":51.33015,"longitude":1.41909,"time_utc":"2026-09-14 22:22:07.984058584 +0000 UTC"},"MessageType":"PositionReport","Message":{"PositionReport":{"MessageID":1,"RepeatIndicator":0,"UserID":232042999,"Valid":true,"NavigationalStatus":0,"RateOfTurn":-128,"Sog":0,"PositionAccuracy":false,"Longitude":1.4190883333333335,"Latitude":51.33015,"Cog":360,"TrueHeading":511,"Timestamp":4,"SpecialManoeuvreIndicator":0,"Spare":0,"Raim":true,"CommunicationState":49198}}}
`)

// CONSTRUCTED — the dangerous case: a real nonzero Sog with sentinel Cog.
// Confirmed absent from the capture (see comment above). Shape copied
// from CAPTURED_COG_SENTINEL_ZERO_SOG with Sog changed to 12.5.
const CONSTRUCTED_COG_SENTINEL_NONZERO_SOG = {
  MetaData: {
    MMSI: 232042999,
    MMSI_String: 232042999,
    ShipName: 'CAROUSEL SH298',
    latitude: 51.33015,
    longitude: 1.41909,
    time_utc: '2026-09-14 22:22:07.984058584 +0000 UTC',
  },
  MessageType: 'PositionReport',
  Message: {
    PositionReport: {
      Sog: 12.5,
      Cog: 360,
    },
  },
}

// CONSTRUCTED — Sog sentinel alone with a valid Cog. Confirmed absent:
// every captured Sog:102.3 line pairs with Cog:360.
const CONSTRUCTED_SOG_SENTINEL_VALID_COG = {
  MetaData: {
    MMSI: 232042999,
    MMSI_String: 232042999,
    ShipName: 'CAROUSEL SH298',
    latitude: 51.33015,
    longitude: 1.41909,
    time_utc: '2026-09-14 22:22:07.984058584 +0000 UTC',
  },
  MessageType: 'PositionReport',
  Message: {
    PositionReport: {
      Sog: 102.3,
      Cog: 90,
    },
  },
}

// CONSTRUCTED — Sog/Cog keys entirely absent. Confirmed absent from the
// capture: every position message carries both fields.
const CONSTRUCTED_SOG_COG_ABSENT = {
  MetaData: {
    MMSI: 232042999,
    MMSI_String: 232042999,
    ShipName: 'CAROUSEL SH298',
    latitude: 51.33015,
    longitude: 1.41909,
    time_utc: '2026-09-14 22:22:07.984058584 +0000 UTC',
  },
  MessageType: 'PositionReport',
  Message: {
    PositionReport: {},
  },
}

// CONSTRUCTED — Sog/Cog present but NaN. JSON cannot encode NaN so this
// can only ever be constructed, never captured.
const CONSTRUCTED_SOG_COG_NAN = {
  MetaData: {
    MMSI: 232042999,
    MMSI_String: 232042999,
    ShipName: 'CAROUSEL SH298',
    latitude: 51.33015,
    longitude: 1.41909,
    time_utc: '2026-09-14 22:22:07.984058584 +0000 UTC',
  },
  MessageType: 'PositionReport',
  Message: {
    PositionReport: {
      Sog: NaN,
      Cog: NaN,
    },
  },
}

// captured, line 15 — ShipStaticData, Type 70
const CAPTURED_STATIC_CARGO = JSON.parse(`
{"MetaData":{"MMSI":538006603,"MMSI_String":538006603,"ShipName":"GLOBE TRINCO        ","latitude":51.07132,"longitude":1.71283,"time_utc":"2026-09-14 22:21:48.232679479 +0000 UTC"},"MessageType":"ShipStaticData","Message":{"ShipStaticData":{"AisVersion":2,"CallSign":"V7OY6  ","Destination":"PL SWI              ","Dimension":{"A":160,"B":30,"C":11,"D":21},"Dte":false,"Eta":{"Day":17,"Hour":12,"Minute":0,"Month":9},"FixType":1,"ImoNumber":9403126,"MaximumStaticDraught":12.6,"MessageID":5,"Name":"GLOBE TRINCO        ","RepeatIndicator":0,"Spare":false,"Type":70,"UserID":538006603,"Valid":true}}}
`)

// captured, line 58 — ShipStaticData, Type 80
const CAPTURED_STATIC_TANKER = JSON.parse(`
{"MetaData":{"MMSI":305793000,"MMSI_String":305793000,"ShipName":"RHOGAS              ","latitude":51.10095,"longitude":1.51403,"time_utc":"2026-09-14 22:23:02.975592726 +0000 UTC"},"MessageType":"ShipStaticData","Message":{"ShipStaticData":{"AisVersion":1,"CallSign":"V2FT7  ","Destination":"DESTA -> FRDON ;)   ","Dimension":{"A":91,"B":22,"C":6,"D":13},"Dte":false,"Eta":{"Day":16,"Hour":21,"Minute":0,"Month":9},"FixType":1,"ImoNumber":9618848,"MaximumStaticDraught":6.7,"MessageID":5,"Name":"RHOGAS              ","RepeatIndicator":0,"Spare":false,"Type":80,"UserID":305793000,"Valid":true}}}
`)

// captured, line 50 — ShipStaticData, Type 40
const CAPTURED_STATIC_FERRY = JSON.parse(`
{"MetaData":{"MMSI":235114376,"MMSI_String":235114376,"ShipName":"WINDCAT 39          ","latitude":51.3296,"longitude":1.4216,"time_utc":"2026-09-14 22:22:43.184952642 +0000 UTC"},"MessageType":"ShipStaticData","Message":{"ShipStaticData":{"AisVersion":2,"CallSign":"2JAV6  ","Destination":"RAMSGATE><LAOWF     ","Dimension":{"A":8,"B":12,"C":3,"D":3},"Dte":false,"Eta":{"Day":31,"Hour":0,"Minute":0,"Month":1},"FixType":1,"ImoNumber":0,"MaximumStaticDraught":2.2,"MessageID":5,"Name":"WINDCAT 39          ","RepeatIndicator":0,"Spare":false,"Type":40,"UserID":235114376,"Valid":true}}}
`)

// captured, line 97 — ShipStaticData, Type 51
const CAPTURED_STATIC_NAVAL = JSON.parse(`
{"MetaData":{"MMSI":235103844,"MMSI_String":235103844,"ShipName":"BF RANGER           ","latitude":51.32949,"longitude":1.42211,"time_utc":"2026-09-14 22:24:06.96733006 +0000 UTC"},"MessageType":"ShipStaticData","Message":{"ShipStaticData":{"AisVersion":1,"CallSign":"2HID4  ","Destination":"SAR PATROL          ","Dimension":{"A":8,"B":16,"C":5,"D":3},"Dte":false,"Eta":{"Day":14,"Hour":17,"Minute":0,"Month":9},"FixType":1,"ImoNumber":8354627,"MaximumStaticDraught":1.4,"MessageID":5,"Name":"BF RANGER           ","RepeatIndicator":0,"Spare":false,"Type":51,"UserID":235103844,"Valid":true}}}
`)

// captured, line 468 — ShipStaticData, Type 0
const CAPTURED_STATIC_UNKNOWN = JSON.parse(`
{"MetaData":{"MMSI":256274000,"MMSI_String":256274000,"ShipName":"VICTORINE           ","latitude":50.87952,"longitude":1.42184,"time_utc":"2026-09-14 22:34:13.065015922 +0000 UTC"},"MessageType":"ShipStaticData","Message":{"ShipStaticData":{"AisVersion":1,"CallSign":"9HA5776","Destination":"BEZEE               ","Dimension":{"A":21,"B":141,"C":12,"D":13},"Dte":false,"Eta":{"Day":15,"Hour":4,"Minute":0,"Month":9},"FixType":1,"ImoNumber":9184029,"MaximumStaticDraught":5.4,"MessageID":5,"Name":"VICTORINE           ","RepeatIndicator":0,"Spare":false,"Type":0,"UserID":256274000,"Valid":true}}}
`)

// CONSTRUCTED — Type 99, a fallback code not present anywhere in the
// capture (confirmed: only codes 0,30,33,34,37,40,43,51,60,69,70,71,72,
// 74,79,80,81,84,89,90 appear as ShipStaticData.Type).
const CONSTRUCTED_STATIC_TYPE_99 = {
  MetaData: {
    MMSI: 999999999,
    MMSI_String: 999999999,
    ShipName: 'FALLBACK TEST',
    latitude: 51.0,
    longitude: 1.0,
    time_utc: '2026-09-14 22:00:00.000000000 +0000 UTC',
  },
  MessageType: 'ShipStaticData',
  Message: {
    ShipStaticData: {
      Type: 99,
      Name: 'FALLBACK TEST',
    },
  },
}

// CONSTRUCTED — a ShipStaticData envelope with both Name and
// MetaData.ShipName blank. No captured ShipStaticData line has a blank
// name (confirmed: all 14 blank-ShipName lines in the capture are
// StandardClassBPositionReport instead — see CAPTURED_BOTH_SENTINEL_BLANK_NAME,
// which covers the real blank-name case for the position variant).
const CONSTRUCTED_STATIC_BLANK_NAME = {
  MetaData: {
    MMSI: 111111111,
    MMSI_String: 111111111,
    ShipName: '',
    latitude: 51.0,
    longitude: 1.0,
    time_utc: '2026-09-14 22:00:00.000000000 +0000 UTC',
  },
  MessageType: 'ShipStaticData',
  Message: {
    ShipStaticData: {
      Type: 70,
      Name: '',
    },
  },
}

// captured, line 1 — SubscriptionConfirmation, no MetaData at all
const CAPTURED_SUBSCRIPTION_CONFIRMATION = JSON.parse(`
{"Message":{"CompressionEnabled":true},"MessageType":"SubscriptionConfirmation"}
`)

// Scenario 1: casing — lowercase MetaData.latitude/longitude used,
// capitalised Message.PositionReport.Latitude/Longitude ignored. The two
// differ in this fixture (51.09419 vs 51.094190000000005 lat,
// 1.76198 vs 1.7619783333333332 lon) which is what makes this provable.
{
  const result = normalize(CAPTURED_POSITION_VALID)
  assert(result?.kind === 'position', 'casing fixture normalizes to a position')
  if (result?.kind === 'position') {
    assert(result.fix.lat === 51.09419, 'lowercase MetaData.latitude used, not capitalised Message.Latitude')
    assert(result.fix.lon === 1.76198, 'lowercase MetaData.longitude used, not capitalised Message.Longitude')
  }
}

// Scenario 1b: position shipName, space-padded (MetaData.ShipName is
// "CASTOR LEADER       ", 20-char AIS field width)
{
  const result = normalize(CAPTURED_POSITION_VALID)
  assert(
    result?.kind === 'position' && result.shipName === 'CASTOR LEADER',
    `padded MetaData.ShipName "CASTOR LEADER       " trims to "CASTOR LEADER" on a position fix (got ${
      result?.kind === 'position' ? JSON.stringify(result.shipName) : 'undefined'
    })`,
  )
}

// Scenario 1c: position shipName, already trimmed in the source data
// (captured, line 25 — MetaData.ShipName is "CAROUSEL SH298", no padding)
{
  const result = normalize(CAPTURED_COG_SENTINEL_ZERO_SOG)
  assert(
    result?.kind === 'position' && result.shipName === 'CAROUSEL SH298',
    'already-trimmed MetaData.ShipName passes through unchanged on a position fix',
  )
}

// TrueHeading is present on both subscribed position message types. Keep
// only finite values in the AIS true-heading range; unavailable and invalid
// values must leave the optional fix property absent.
{
  const messageTypes = ['PositionReport', 'StandardClassBPositionReport'] as const
  const validHeadings = [0, 217, 359]
  const invalidHeadings: unknown[] = [511, 360, -1, Number.NaN, '217', undefined]

  for (const messageType of messageTypes) {
    for (const headingDeg of validHeadings) {
      const result = normalize({
        MetaData: {
          MMSI_String: '123456789',
          latitude: 51,
          longitude: 1,
          time_utc: '2026-09-14 22:21:32.409064434 +0000 UTC',
        },
        MessageType: messageType,
        Message: { [messageType]: { Sog: 0, Cog: 0, ...(headingDeg === undefined ? {} : { TrueHeading: headingDeg }) } },
      })
      assert(
        result?.kind === 'position' && result.fix.headingDeg === headingDeg,
        `${messageType}: valid TrueHeading ${headingDeg} kept`,
      )
    }

    for (const headingDeg of invalidHeadings) {
      const inner = headingDeg === undefined ? { Sog: 0, Cog: 0 } : { Sog: 0, Cog: 0, TrueHeading: headingDeg }
      const result = normalize({
        MetaData: {
          MMSI_String: '123456789',
          latitude: 51,
          longitude: 1,
          time_utc: '2026-09-14 22:21:32.409064434 +0000 UTC',
        },
        MessageType: messageType,
        Message: { [messageType]: inner },
      })
      assert(
        result?.kind === 'position' &&
          !Object.prototype.hasOwnProperty.call(result.fix, 'headingDeg'),
        `${messageType}: invalid/missing TrueHeading ${String(headingDeg)} leaves headingDeg absent`,
      )
    }
  }
}

// Scenario 2: MMSI zero-padding
{
  const result = normalize(CAPTURED_POSITION_SHORT_MMSI)
  assert(result?.kind === 'position', 'short-MMSI fixture normalizes to a position')
  if (result?.kind === 'position') {
    assert(result.fix.mmsi === '002278000', '7-digit MMSI_String zero-padded to 9 chars')
  }

  const nineDigit = normalize(CAPTURED_POSITION_VALID)
  assert(
    nineDigit?.kind === 'position' && nineDigit.fix.mmsi === '356219000',
    '9-digit MMSI passes through unchanged',
  )
}

// Scenario 3: time_utc parses to the independently-verified epoch ms
{
  const result = normalize(CAPTURED_POSITION_VALID)
  assert(
    result?.kind === 'position' && result.fix.timestamp === 1789424492409,
    `time_utc "2026-09-14 22:21:32.409064434 +0000 UTC" parses to 1789424492409 (got ${
      result?.kind === 'position' ? result.fix.timestamp : 'undefined'
    })`,
  )
}

// Scenario 4: sentinel SOG alone (constructed) -> both fields zero
{
  const result = normalize(CONSTRUCTED_SOG_SENTINEL_VALID_COG)
  assert(result?.kind === 'position', 'Sog-sentinel-alone fixture normalizes to a position')
  if (result?.kind === 'position') {
    assert(result.fix.sogKn === 0, 'Sog sentinel (102.3) with valid Cog zeroes sogKn')
    assert(result.fix.cogDeg === 0, 'Sog sentinel (102.3) with valid Cog also zeroes cogDeg')
  }
}

// Scenario 5: sentinel COG alone (constructed) -> both fields zero. This
// is the case that would otherwise dead reckon a real 12.5kn due north.
{
  const result = normalize(CONSTRUCTED_COG_SENTINEL_NONZERO_SOG)
  assert(result?.kind === 'position', 'Cog-sentinel-alone fixture normalizes to a position')
  if (result?.kind === 'position') {
    assert(result.fix.sogKn === 0, 'Cog sentinel (360) with a real nonzero Sog (12.5) still zeroes sogKn')
    assert(result.fix.cogDeg === 0, 'Cog sentinel (360) zeroes cogDeg')
  }
}

// Scenario 5b: the real captured Cog-sentinel case (Sog happens to be 0)
{
  const result = normalize(CAPTURED_COG_SENTINEL_ZERO_SOG)
  assert(result?.kind === 'position', 'captured Cog-sentinel-with-zero-Sog fixture normalizes to a position')
  if (result?.kind === 'position') {
    assert(result.fix.sogKn === 0, 'captured Cog sentinel with zero Sog: sogKn stays 0')
    assert(result.fix.cogDeg === 0, 'captured Cog sentinel with zero Sog: cogDeg zeroed')
  }
}

// Scenario 6: both sentinel -> both zero. This fixture is also the real
// captured blank-ShipName case (line 314, StandardClassBPositionReport,
// MetaData.ShipName: "") — all 14 blank-ShipName lines in the capture
// are this message type, so this is the real fixture for that rule.
{
  const result = normalize(CAPTURED_BOTH_SENTINEL_BLANK_NAME)
  assert(result?.kind === 'position', 'both-sentinel fixture normalizes to a position')
  if (result?.kind === 'position') {
    assert(result.fix.sogKn === 0, 'both sentinel: sogKn zeroed')
    assert(result.fix.cogDeg === 0, 'both sentinel: cogDeg zeroed')
    assert(
      result.shipName === undefined,
      'blank MetaData.ShipName ("") on a real StandardClassBPositionReport trims to undefined, not ""',
    )
  }
}

// Scenario 7: Sog/Cog absent entirely -> both zero
{
  const result = normalize(CONSTRUCTED_SOG_COG_ABSENT)
  assert(result?.kind === 'position', 'Sog/Cog-absent fixture normalizes to a position')
  if (result?.kind === 'position') {
    assert(result.fix.sogKn === 0, 'absent Sog/Cog: sogKn defaults to 0')
    assert(result.fix.cogDeg === 0, 'absent Sog/Cog: cogDeg defaults to 0')
  }
}

// Scenario 7b: Sog/Cog present but NaN -> both zero
{
  const result = normalize(CONSTRUCTED_SOG_COG_NAN)
  assert(result?.kind === 'position', 'NaN Sog/Cog fixture normalizes to a position')
  if (result?.kind === 'position') {
    assert(result.fix.sogKn === 0, 'NaN Sog: sogKn zeroed')
    assert(result.fix.cogDeg === 0, 'NaN Cog: cogDeg zeroed')
  }
}

// Scenario 8: a real legitimate pair passes through untouched
{
  const result = normalize(CAPTURED_POSITION_VALID)
  assert(result?.kind === 'position', 'legitimate-pair fixture normalizes to a position')
  if (result?.kind === 'position') {
    assert(result.fix.sogKn === 13.3, 'legitimate Sog (13.3) passes through unchanged')
    assert(result.fix.cogDeg === 44.2, 'legitimate Cog (44.2) passes through unchanged')
  }

  const zeroSpeedPair = normalize(CAPTURED_POSITION_SHORT_MMSI)
  assert(
    zeroSpeedPair?.kind === 'position' && zeroSpeedPair.fix.sogKn === 0 && zeroSpeedPair.fix.cogDeg === 260.6,
    'legitimate Sog:0 (real, not sentinel) paired with valid Cog (260.6) both pass through unchanged',
  )
}

// Scenario 9: ship type mapping, one real captured code per target
{
  const cargo = normalize(CAPTURED_STATIC_CARGO)
  assert(cargo?.kind === 'static' && cargo.vesselType === 'cargo', 'Type 70 maps to cargo')

  const tanker = normalize(CAPTURED_STATIC_TANKER)
  assert(tanker?.kind === 'static' && tanker.vesselType === 'tanker', 'Type 80 maps to tanker')

  const ferry = normalize(CAPTURED_STATIC_FERRY)
  assert(ferry?.kind === 'static' && ferry.vesselType === 'ferry', 'Type 40 maps to ferry')

  const naval = normalize(CAPTURED_STATIC_NAVAL)
  assert(naval?.kind === 'static' && naval.vesselType === 'naval', 'Type 51 maps to naval')

  const unknown = normalize(CAPTURED_STATIC_UNKNOWN)
  assert(unknown?.kind === 'static' && unknown.vesselType === 'unknown', 'Type 0 maps to unknown')

  const fallback = normalize(CONSTRUCTED_STATIC_TYPE_99)
  assert(fallback?.kind === 'static' && fallback.vesselType === 'unknown', 'Type 99 (not in capture) falls back to unknown')
}

// Scenario 10: SubscriptionConfirmation -> undefined
{
  const result = normalize(CAPTURED_SUBSCRIPTION_CONFIRMATION)
  assert(result === undefined, 'SubscriptionConfirmation normalizes to undefined')
}

// Scenario 11: malformed envelope with no MetaData -> undefined, no throw
{
  let threw = false
  let result: unknown
  try {
    result = normalize({ MessageType: 'PositionReport' })
  } catch {
    threw = true
  }
  assert(!threw, 'malformed envelope with no MetaData does not throw')
  assert(result === undefined, 'malformed envelope with no MetaData normalizes to undefined')

  let threw2 = false
  try {
    normalize({})
    normalize(null)
    normalize('garbage')
    normalize(42)
  } catch {
    threw2 = true
  }
  assert(!threw2, 'empty object, null, string, and number inputs do not throw')
}

// Scenario 12: blank ShipName -> shipName: undefined, not ''
{
  const result = normalize(CONSTRUCTED_STATIC_BLANK_NAME)
  assert(result?.kind === 'static', 'blank-name static fixture normalizes to static')
  if (result?.kind === 'static') {
    assert(result.shipName === undefined, 'blank Name and blank MetaData.ShipName both trim to undefined, not ""')
  }
}

// Scenario 13: ShipStaticData produces kind: 'static' with correct
// dimensions from real Dimension values
{
  const result = normalize(CAPTURED_STATIC_CARGO)
  assert(result?.kind === 'static', 'ShipStaticData fixture normalizes to static')
  if (result?.kind === 'static') {
    assert(result.mmsi === '538006603', 'static mmsi matches MMSI_String, already 9 digits')
    assert(result.shipName === 'GLOBE TRINCO', 'padded Name trims to "GLOBE TRINCO"')
    assert(
      result.dimensions?.lengthM === 190 && result.dimensions?.beamM === 32,
      `dimensions from Dimension A=160,B=30,C=11,D=21 -> lengthM=190, beamM=32 (got ${JSON.stringify(result.dimensions)})`,
    )
  }
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
