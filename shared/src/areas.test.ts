import {
  AISCAST_URL,
  AISSTREAM_URL,
  DEMO_AREAS,
  parseAisSource,
  parseDemoArea,
  resolveSourceConfig,
} from './areas.ts'

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

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  )
}

// --- parseDemoArea ---

assertEqual(parseDemoArea(undefined), 'dover', 'parseDemoArea: undefined -> dover')
assertEqual(parseDemoArea(''), 'dover', "parseDemoArea: '' -> dover")
assertEqual(parseDemoArea('istanbul'), 'istanbul', "parseDemoArea: 'istanbul' -> istanbul")
assertEqual(parseDemoArea('Istanbul'), null, "parseDemoArea: 'Istanbul' -> null (exact match only)")
assertEqual(parseDemoArea('x'), null, "parseDemoArea: 'x' -> null")
assertEqual(parseDemoArea('dover'), 'dover', "parseDemoArea: 'dover' -> dover")
assertEqual(parseDemoArea('portsaid'), 'portsaid', "parseDemoArea: 'portsaid' -> portsaid")
assertEqual(parseDemoArea('sydney'), 'sydney', "parseDemoArea: 'sydney' -> sydney")
assertEqual(parseDemoArea(' dover'), null, "parseDemoArea: ' dover' -> null (no trimming)")

// --- parseAisSource ---

assertEqual(parseAisSource(undefined), 'aisstream', 'parseAisSource: undefined -> aisstream')
assertEqual(parseAisSource(''), 'aisstream', "parseAisSource: '' -> aisstream")
assertEqual(parseAisSource('aiscast'), 'aiscast', "parseAisSource: 'aiscast' -> aiscast")
assertEqual(parseAisSource('aisstream'), 'aisstream', "parseAisSource: 'aisstream' -> aisstream")
assertEqual(parseAisSource('AISCAST'), null, "parseAisSource: 'AISCAST' -> null")
assertEqual(parseAisSource('x'), null, "parseAisSource: 'x' -> null")

// --- resolveSourceConfig ---

{
  const resolved = resolveSourceConfig({ aiscastToken: 'tok-abc' }, 'aiscast')
  assert(
    !('error' in resolved) && resolved.url === 'wss://ais.openwaters.io/v0/stream' && resolved.apiKey === 'tok-abc',
    "resolveSourceConfig: aiscast with token -> aiscast URL and that token (got " + JSON.stringify(resolved) + ")",
  )
  assert(
    resolved.url === AISCAST_URL,
    'resolveSourceConfig: aiscast URL equals the AISCAST_URL constant',
  )
}

{
  const resolved = resolveSourceConfig({}, 'aiscast')
  // Exact expected message, hardcoded: it names the VARIABLE and never
  // contains any credential value. (An earlier version asserted the
  // message contains no '=' -- wrong on its own terms, since the message
  // legitimately mentions WAKE_AIS_SOURCE=aiscast.)
  assert(
    'error' in resolved &&
      resolved.error ===
        'AISCAST_TOKEN is missing or empty -- required when WAKE_AIS_SOURCE=aiscast. Set it in .env.',
    'resolveSourceConfig: aiscast without token -> exact error naming AISCAST_TOKEN only (got ' + JSON.stringify(resolved) + ')',
  )
}

{
  const resolved = resolveSourceConfig({ aiscastToken: '   ' }, 'aiscast')
  assert(
    'error' in resolved && resolved.error.includes('AISCAST_TOKEN'),
    'resolveSourceConfig: aiscast with a blank token -> error naming AISCAST_TOKEN (blank counts as missing)',
  )
}

{
  const resolved = resolveSourceConfig({}, 'aisstream')
  // Exact expected message, hardcoded: names the variable, no value.
  assert(
    'error' in resolved &&
      resolved.error ===
        'AISSTREAM_API_KEY is missing or empty. Set it in .env before starting the server.',
    'resolveSourceConfig: aisstream without key -> exact error naming AISSTREAM_API_KEY only (got ' + JSON.stringify(resolved) + ')',
  )
}

{
  const resolved = resolveSourceConfig({ aisstreamApiKey: 'key-1' }, 'aisstream')
  assert(
    !('error' in resolved) && resolved.url === 'wss://stream.aisstream.io/v0/stream' && resolved.apiKey === 'key-1',
    "resolveSourceConfig: aisstream with key -> aisstream URL and that key (got " + JSON.stringify(resolved) + ")",
  )
  assert(
    resolved.url === AISSTREAM_URL,
    'resolveSourceConfig: aisstream URL equals the AISSTREAM_URL constant',
  )
}

// --- DEMO_AREAS ---

// dover must equal the display's previous hardcoded constants and the
// server's previous BOUNDING_BOXES default EXACTLY (hardcoded expected
// values, not a reference to anything in server/):
//   WakeCanvas: DOVER_CENTER_LAT 51.1, DOVER_CENTER_LON 1.45, DOVER_RADIUS_NM 20
//   aisstream.ts: BOUNDING_BOXES = [[[51.4, 0.9], [50.8, 2.0]]]
assertEqual(DEMO_AREAS.dover.centerLat, 51.1, 'DEMO_AREAS.dover.centerLat equals the WakeCanvas constant')
assertEqual(DEMO_AREAS.dover.centerLon, 1.45, 'DEMO_AREAS.dover.centerLon equals the WakeCanvas constant')
assertEqual(DEMO_AREAS.dover.radiusNm, 20, 'DEMO_AREAS.dover.radiusNm equals the WakeCanvas constant')
assertEqual(
  DEMO_AREAS.dover.boundingBoxes,
  [[[51.4, 0.9], [50.8, 2.0]]],
  'DEMO_AREAS.dover.boundingBoxes equals the previous BOUNDING_BOXES exactly',
)

// istanbul / portsaid / sydney: the box must contain the view circle's
// north, south, east and west extreme points. The circle's extreme in a
// direction is centre + radius * (unit vector), with longitude degrees
// converted the same way mapProject inverts them:
//   north/south: centreLat ± radiusNm / 60
//   east/west:   centreLon ± radiusNm / (60 * cos(centerLat))
const extremesInside = (centerLat: number, centerLon: number, radiusNm: number, box: number[][]): boolean => {
  const [[lat1, lon1], [lat2, lon2]] = box
  const minLat = Math.min(lat1, lat2)
  const maxLat = Math.max(lat1, lat2)
  const minLon = Math.min(lon1, lon2)
  const maxLon = Math.max(lon1, lon2)
  const latSpan = radiusNm / 60
  const lonSpan = radiusNm / (60 * Math.cos((centerLat * Math.PI) / 180))
  const points: Array<[number, number]> = [
    [centerLat + latSpan, centerLon], // north
    [centerLat - latSpan, centerLon], // south
    [centerLat, centerLon + lonSpan], // east
    [centerLat, centerLon - lonSpan], // west
  ]
  return points.every(
    ([lat, lon]) => lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon,
  )
}

assert(
  extremesInside(DEMO_AREAS.istanbul.centerLat, DEMO_AREAS.istanbul.centerLon, DEMO_AREAS.istanbul.radiusNm, DEMO_AREAS.istanbul.boundingBoxes[0]),
  `istanbul box contains the view circle's N/S/E/W extremes (box ${JSON.stringify(DEMO_AREAS.istanbul.boundingBoxes[0])})`,
)
assert(
  extremesInside(DEMO_AREAS.portsaid.centerLat, DEMO_AREAS.portsaid.centerLon, DEMO_AREAS.portsaid.radiusNm, DEMO_AREAS.portsaid.boundingBoxes[0]),
  `portsaid box contains the view circle's N/S/E/W extremes (box ${JSON.stringify(DEMO_AREAS.portsaid.boundingBoxes[0])})`,
)
assert(
  extremesInside(DEMO_AREAS.sydney.centerLat, DEMO_AREAS.sydney.centerLon, DEMO_AREAS.sydney.radiusNm, DEMO_AREAS.sydney.boundingBoxes[0]),
  `sydney box contains the view circle's N/S/E/W extremes (box ${JSON.stringify(DEMO_AREAS.sydney.boundingBoxes[0])})`,
)

// The three new areas' centres and radii as specified (hardcoded):
assertEqual(DEMO_AREAS.istanbul.centerLat, 40.93, 'istanbul centre latitude as specified')
assertEqual(DEMO_AREAS.istanbul.centerLon, 29.0, 'istanbul centre longitude as specified')
assertEqual(DEMO_AREAS.portsaid.centerLat, 31.35, 'portsaid centre latitude as specified')
assertEqual(DEMO_AREAS.portsaid.centerLon, 32.35, 'portsaid centre longitude as specified')
assertEqual(DEMO_AREAS.sydney.centerLat, -33.93, 'sydney centre latitude as specified')
assertEqual(DEMO_AREAS.sydney.centerLon, 151.22, 'sydney centre longitude as specified')
assertEqual(DEMO_AREAS.istanbul.radiusNm, 20, 'istanbul radius as specified')
assertEqual(DEMO_AREAS.portsaid.radiusNm, 20, 'portsaid radius as specified')
assertEqual(DEMO_AREAS.sydney.radiusNm, 20, 'sydney radius as specified')

// --- VIS-7 displayName ---

assertEqual(DEMO_AREAS.dover.displayName, 'DOVER STRAIT', 'dover displayName')
assertEqual(DEMO_AREAS.istanbul.displayName, 'SEA OF MARMARA', 'istanbul displayName')
assertEqual(DEMO_AREAS.portsaid.displayName, 'PORT SAID', 'portsaid displayName')
assertEqual(DEMO_AREAS.sydney.displayName, 'SYDNEY', 'sydney displayName')

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
