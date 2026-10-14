import { DEMO_AREAS } from './areas.ts'
import {
  DEFAULT_RADIUS_NM,
  MAX_CUSTOM_RADIUS_NM,
  MIN_CUSTOM_RADIUS_NM,
  basemapFor,
  extractBboxFor,
  feedBoxFor,
  parseLocalAreas,
  resolveArea,
  slugify,
  type LocalAreasFile,
} from './localAreas.ts'

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
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

// --- feedBoxFor reproduces the built-in rules ---
assertEqual(feedBoxFor(DEMO_AREAS.istanbul.centerLat, DEMO_AREAS.istanbul.centerLon, DEMO_AREAS.istanbul.radiusNm), DEMO_AREAS.istanbul.boundingBoxes, 'feedBoxFor: istanbul matches DEMO_AREAS.istanbul.boundingBoxes exactly')
assertEqual(feedBoxFor(DEMO_AREAS.portsaid.centerLat, DEMO_AREAS.portsaid.centerLon, DEMO_AREAS.portsaid.radiusNm), DEMO_AREAS.portsaid.boundingBoxes, 'feedBoxFor: portsaid matches DEMO_AREAS.portsaid.boundingBoxes exactly')
assertEqual(feedBoxFor(DEMO_AREAS.sydney.centerLat, DEMO_AREAS.sydney.centerLon, DEMO_AREAS.sydney.radiusNm), DEMO_AREAS.sydney.boundingBoxes, 'feedBoxFor: sydney matches DEMO_AREAS.sydney.boundingBoxes exactly')

const doverBox = feedBoxFor(DEMO_AREAS.dover.centerLat, DEMO_AREAS.dover.centerLon, DEMO_AREAS.dover.radiusNm)
assertEqual(doverBox, DEMO_AREAS.dover.boundingBoxes, 'feedBoxFor: dover matches the shipped DEMO_AREAS.dover.boundingBoxes exactly')

// --- extractBboxFor ---
const extracted = extractBboxFor(51.1, 1.45, 20)
assert(Math.abs(extracted.minLat - 50.6) < 0.0005, 'extractBboxFor: minLat is 50.6 within tolerance')
assert(Math.abs(extracted.maxLat - 51.6) < 0.0005, 'extractBboxFor: maxLat is 51.6 within tolerance')
assert(Math.abs(extracted.minLon - 0.1233) < 0.1, 'extractBboxFor: minLon is within 0.1 of 0.2 (rough dover header)')
assert(Math.abs(extracted.maxLon - 2.7767) < 0.1, 'extractBboxFor: maxLon is within 0.1 of 2.8 (rough dover header)')

// --- parseLocalAreas: valid and invalid records ---
const validData = {
  areas: {
    mombasa: {
      displayName: 'Mombasa',
      centerLat: -4.0435,
      centerLon: 39.6682,
      radiusNm: 20,
      places: [{ name: 'Mombasa', lat: -4.0435, lon: 39.6682 }],
      pmtilesUrl: '/tiles/mombasa-z11.pmtiles',
    },
  },
  basemaps: {
    dover: {
      pmtilesUrl: '/tiles/dover-z11.pmtiles',
      places: [{ name: 'Dover', lat: 51.1251, lon: 1.3129 }],
    },
  },
}

const valid = parseLocalAreas(validData)
assert(valid.ok === true, 'parseLocalAreas: accepts a valid local area and built-in basemap entry')
if (valid.ok) {
  assertEqual(valid.value.areas?.mombasa.displayName, 'Mombasa', 'parseLocalAreas: keeps the displayName')
}

const invalidCases = [
  { raw: null, label: 'non-object root' },
  { raw: { unexpected: true }, label: 'unknown top-level field' },
  { raw: { areas: [] }, label: 'areas is not an object' },
  { raw: { basemaps: [] }, label: 'basemaps is not an object' },
  { raw: { areas: { 'bad key': { displayName: 'x', centerLat: 0, centerLon: 0, radiusNm: 10 } } }, label: 'slug' },
  { raw: { areas: { Uppercase: { displayName: 'x', centerLat: 0, centerLon: 0, radiusNm: 10 } } }, label: 'uppercase slug' },
  { raw: { areas: { [`${'a'.repeat(33)}`]: { displayName: 'x', centerLat: 0, centerLon: 0, radiusNm: 10 } } }, label: 'slug exceeds 32 chars' },
  { raw: { areas: { Uppercase: { displayName: 'x', centerLat: 0, centerLon: 0, radiusNm: 10 } } }, label: 'uppercase slug' },
  { raw: { areas: { dover: { displayName: 'Dover', centerLat: 0, centerLon: 0, radiusNm: 10 } } }, label: 'collision' },
  { raw: { basemaps: { mombasa: { pmtilesUrl: '/tiles/other-z11.pmtiles' } } }, label: 'basemaps key not built-in' },
  { raw: { basemaps: { toString: { pmtilesUrl: '/tiles/other-z11.pmtiles' } } }, label: 'inherited basemap key' },
  { raw: { areas: { test: { centerLat: 0, centerLon: 0, radiusNm: 10 } } }, label: 'missing displayName' },
  { raw: { areas: { test: { displayName: 'X', centerLon: 0, radiusNm: 10 } } }, label: 'missing centerLat' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, radiusNm: 10 } } }, label: 'missing centerLon' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0 } } }, label: 'missing radiusNm' },
  { raw: { areas: { test: { displayName: '', centerLat: 0, centerLon: 0, radiusNm: 10 } } }, label: 'empty displayName' },
  { raw: { areas: { test: { displayName: 'x'.repeat(41), centerLat: 0, centerLon: 0, radiusNm: 10 } } }, label: 'displayName too long' },
  { raw: { areas: { test: { displayName: 'X', centerLat: Infinity, centerLon: 0, radiusNm: 10 } } }, label: 'lat must be finite' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 90, centerLon: 0, radiusNm: 10 } } }, label: 'lat range' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: NaN, radiusNm: 10 } } }, label: 'lon must be finite' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 181, radiusNm: 10 } } }, label: 'lon range' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 4 } } }, label: 'radius below min' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 41 } } }, label: 'radius above max' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: Infinity } } }, label: 'radius must be finite' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 10, pmtilesUrl: '/tiles/nope.pmtiles' } } }, label: 'bad pmtilesUrl' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 10, pmtilesUrl: 'https://example.com/test-z11.pmtiles' } } }, label: 'pmtilesUrl must be local path' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 10, pmtilesUrl: '/tiles/-invalid-z11.pmtiles' } } }, label: 'pmtilesUrl slug format' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 10, pmtilesUrl: `/tiles/${'a'.repeat(33)}-z11.pmtiles` } } }, label: 'pmtilesUrl slug length' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 10, extra: true } } }, label: 'unknown field' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 10, places: 'not-an-array' } } }, label: 'places is not an array' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 10, places: [{}] } } }, label: 'place missing fields' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 10, places: [{ name: 'Here', lat: 0, lon: Infinity }] } } }, label: 'place coordinates must be finite' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 0, radiusNm: 10, places: [{ name: '  ', lat: 0, lon: 0 }] } } }, label: 'place name must be non-empty' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 0, centerLon: 179.9, radiusNm: 30 } } }, label: 'antimeridian' },
  { raw: { areas: { test: { displayName: 'X', centerLat: 86, centerLon: 0, radiusNm: 10 } } }, label: 'polar' },
  { raw: { basemaps: { dover: { pmtilesUrl: '/tiles/dover-z11.pmtiles', extra: true } } }, label: 'unknown basemap field' },
  { raw: { basemaps: { dover: { places: [] } } }, label: 'basemap requires pmtilesUrl' },
  { raw: { basemaps: { dover: { pmtilesUrl: '/tiles/nope.pmtiles' } } }, label: 'basemap pmtilesUrl pattern' },
  { raw: { basemaps: { dover: { pmtilesUrl: '/tiles/dover-z11.pmtiles', places: [{}] } } }, label: 'basemap places validation' },
]

for (const testCase of invalidCases) {
  const result = parseLocalAreas(testCase.raw)
  assert(result.ok === false, `parseLocalAreas: rejects ${testCase.label}`)
}

assert(parseLocalAreas({
  areas: {
    [`${'a'.repeat(32)}`]: {
      displayName: 'Area',
      centerLat: 0,
      centerLon: 0,
      radiusNm: MIN_CUSTOM_RADIUS_NM,
      pmtilesUrl: '/tiles/area-z11.pmtiles',
      places: [{ name: 'Place', lat: 0, lon: 0 }],
    },
  },
  basemaps: {
    dover: {
      pmtilesUrl: '/tiles/dover-z11.pmtiles',
      places: [{ name: 'Dover', lat: 51, lon: 1 }],
    },
  },
}).ok, 'parseLocalAreas: accepts boundary slug, minimum radius, valid places and basemap')
assert(parseLocalAreas({
  areas: {
    constructor: {
      displayName: 'Constructor',
      centerLat: 0,
      centerLon: 0,
      radiusNm: 20,
    },
  },
}).ok, 'parseLocalAreas: allows a valid slug that is inherited by Object.prototype')
assert(parseLocalAreas({
  areas: {
    area: {
      displayName: 'Area',
      centerLat: 0,
      centerLon: 0,
      radiusNm: MAX_CUSTOM_RADIUS_NM,
    },
  },
}).ok, 'parseLocalAreas: accepts maximum radius')

// --- slugify and resolution ---
assertEqual(slugify('Mombasa'), 'mombasa', 'slugify: title case and spaces become a slug')
assertEqual(slugify(' Port   Said '), 'port-said', 'slugify: trims and collapses separators')

const localFile: LocalAreasFile = {
  areas: {
    mombasa: {
      displayName: 'Mombasa',
      centerLat: -4.0435,
      centerLon: 39.6682,
      radiusNm: 20,
    },
  },
}

assertEqual(resolveArea(undefined, localFile)?.key, 'dover', 'resolveArea: blank -> dover built-in')
assertEqual(resolveArea('', localFile)?.key, 'dover', 'resolveArea: empty string -> dover built-in')
assertEqual(resolveArea('dover', localFile)?.source, 'builtin', 'resolveArea: exact built-in key wins')
assertEqual(resolveArea('mombasa', localFile)?.source, 'local', 'resolveArea: exact local key resolves as local')
assertEqual(resolveArea('Mombasa', localFile), null, 'resolveArea: wrong case fails exact-match only')
assertEqual(resolveArea('unknown', localFile), null, 'resolveArea: unknown key is null')

assertEqual(basemapFor('dover', localFile)?.pmtilesUrl, '/tiles/dover-z11.pmtiles', 'basemapFor: built-in dover wins')
assertEqual(basemapFor('mombasa', localFile)?.pmtilesUrl, undefined, 'basemapFor: local area without pmtilesUrl has no basemap')

const localWithBasemap: LocalAreasFile = {
  areas: {
    mombasa: {
      displayName: 'Mombasa',
      centerLat: -4.0435,
      centerLon: 39.6682,
      radiusNm: 20,
      pmtilesUrl: '/tiles/mombasa-z11.pmtiles',
      places: [{ name: 'Mombasa', lat: -4.0435, lon: 39.6682 }],
    },
  },
  basemaps: {
    dover: {
      pmtilesUrl: '/tiles/dover-z11.pmtiles',
      places: [{ name: 'Dover', lat: 51.1251, lon: 1.3129 }],
    },
  },
}
assertEqual(basemapFor('mombasa', localWithBasemap)?.pmtilesUrl, '/tiles/mombasa-z11.pmtiles', 'basemapFor: local area pmtilesUrl is used when present')
assertEqual(basemapFor('dover', localWithBasemap)?.pmtilesUrl, '/tiles/dover-z11.pmtiles', 'basemapFor: built-in BasemapAreaConfig has precedence')
const localBasemapFallback = {
  basemaps: {
    mombasa: { pmtilesUrl: '/tiles/other-z11.pmtiles' },
  },
}
assertEqual(basemapFor('mombasa', localBasemapFallback)?.pmtilesUrl, '/tiles/other-z11.pmtiles', 'basemapFor: local basemaps entry is fallback')

console.log(`localAreas tests: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
}
