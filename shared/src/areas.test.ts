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

// The two "missing key" messages, hardcoded. They are what a stranger sees on
// a first run, so each is asserted EXACTLY (a change to either text must be a
// deliberate change here), and then taken apart piece by piece by
// assertMissingKeyMessage below -- the checks the first-run story asks for.
const AISSTREAM_MISSING_KEY_MESSAGE =
  'AISSTREAM_API_KEY is missing or empty. Create a file named .env next to package.json (copy .env.example) and put one line in it: AISSTREAM_API_KEY=your-key (the name first, then =, then your key, no quotes). See the README, "Getting a free AISstream key".'
const AISCAST_MISSING_KEY_MESSAGE =
  'AISCAST_TOKEN is missing or empty. Create a file named .env next to package.json (copy .env.example) and put one line in it: AISCAST_TOKEN=your-key (the name first, then =, then your key, no quotes). Required when WAKE_AIS_SOURCE=aiscast. See the README, "Getting a free AISstream key".'

/**
 * First-run story: the message must name the variable it is about, mention
 * `.env`, show the placeholder `your-key`, and carry nothing else that could
 * be mistaken for a real credential. That last check is a run of 20+ unbroken
 * letters or digits -- no real key-like string is that short, and every long
 * identifier in these sentences (AISSTREAM_API_KEY, package.json,
 * WAKE_AIS_SOURCE=aiscast) is broken up by an underscore or a dot.
 */
function assertMissingKeyMessage(message: string, variable: string, label: string): void {
  assert(message.includes(variable), `${label}: names ${variable}`)
  assert(message.includes('.env'), `${label}: mentions .env`)
  assert(message.includes('your-key'), `${label}: shows the your-key placeholder`)
  assert(
    !/[A-Za-z0-9]{20,}/.test(message),
    `${label}: contains no key-like run of 20 or more characters, so nothing value-like`,
  )
}

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
  const message = 'error' in resolved ? resolved.error : ''
  // Exact expected message, hardcoded: it names the VARIABLE and never
  // contains any credential value. (An earlier version asserted the
  // message contains no '=' -- wrong on its own terms, since the message
  // legitimately mentions WAKE_AIS_SOURCE=aiscast.)
  assert(
    message === AISCAST_MISSING_KEY_MESSAGE,
    'resolveSourceConfig: aiscast without token -> exact missing-key message (got ' + JSON.stringify(resolved) + ')',
  )
  assertMissingKeyMessage(message, 'AISCAST_TOKEN', 'aiscast missing-key message')
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
  const message = 'error' in resolved ? resolved.error : ''
  // Exact expected message, hardcoded: names the variable, no value.
  assert(
    message === AISSTREAM_MISSING_KEY_MESSAGE,
    'resolveSourceConfig: aisstream without key -> exact missing-key message (got ' + JSON.stringify(resolved) + ')',
  )
  assertMissingKeyMessage(message, 'AISSTREAM_API_KEY', 'aisstream missing-key message')
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
