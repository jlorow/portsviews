import { buildBasemapStyle, basemapStyleAudit, VOID } from './basemapStyle'
import { LAND_LEVELS, type LandLevel } from '@wake/shared'

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

const PMTILES = '/tiles/dover-z11.pmtiles'

// --- what the filter kept and dropped, re-derived from the installed
//     package rather than read back from a comment ---

const audit = basemapStyleAudit()
console.log(`\nstock layer count: ${audit.stockCount}`)
console.log(`kept: ${audit.kept.join(', ')}  added: ${audit.added.join(', ')}`)
console.log(`dropped (${audit.dropped.length}): ${audit.dropped.join(', ')}\n`)

assert(audit.stockCount > 50, `Protomaps black flavor emits ${audit.stockCount} layers`)
assert(audit.kept.length === 3, 'kept exactly three stock layers: background, earth, water')
assert(audit.added.length === 1 && audit.added[0] === 'coastline', 'added exactly one layer: coastline')
assert(
  audit.dropped.length === audit.stockCount - audit.kept.length,
  `dropped every other stock layer (${audit.dropped.length})`,
)
assert(
  audit.dropped.includes('places_locality'),
  'places_locality is DROPPED -- a style label would be flipped backwards by the mirror transform',
)
assert(
  audit.dropped.some((id) => id.startsWith('roads_')),
  'the roads_* family is dropped',
)
assert(audit.dropped.includes('buildings'), 'buildings is dropped')
assert(audit.dropped.includes('boundaries'), 'boundaries is dropped')

// --- the built style ---

for (const level of [0, 1, 2] as LandLevel[]) {
  const style = buildBasemapStyle({ pmtilesUrl: PMTILES, landLevel: level })
  const name = LAND_LEVELS[level].name

  assert(style.version === 8, `${name}: style version 8`)
  assert(
    style.layers.map((l) => l.id).join(',') === 'background,earth,water,coastline',
    `${name}: exactly four layers, in order background,earth,water,coastline (got ${style.layers.map((l) => l.id).join(',')})`,
  )

  // The two findings this story exists to resolve, asserted rather than
  // described. No symbol layer means no SDF glyph fetch, so the page has
  // no runtime network dependency at all; no sprite for the same reason.
  assert(
    style.layers.every((l) => l.type !== 'symbol'),
    `${name}: NO symbol layer -- every piece of text draws on Wake's own canvas`,
  )
  const raw = style as unknown as Record<string, unknown>
  assert(raw['glyphs'] === undefined, `${name}: NO glyphs URL -- nothing to fetch from a font CDN`)
  assert(raw['sprite'] === undefined, `${name}: NO sprite URL`)
  assert(
    JSON.stringify(style).indexOf('http') === -1,
    `${name}: the whole style contains no http(s) URL of any kind`,
  )

  assert(
    style.sources['protomaps'].url === 'pmtiles://' + PMTILES,
    `${name}: source points at the local PMTiles archive`,
  )
  assert(
    (style.sources['protomaps'].attribution ?? '').includes('OpenStreetMap'),
    `${name}: the source still carries the OpenStreetMap credit`,
  )

  const paintOf = (id: string) =>
    (style.layers.find((l) => l.id === id) as unknown as { paint: Record<string, string> }).paint

  assert(paintOf('background')['background-color'] === VOID, `${name}: background is pure black`)
  assert(
    paintOf('water')['fill-color'] === VOID,
    `${name}: water is pure black, so a ship over water composites exactly as it does with no basemap`,
  )
  assert(
    paintOf('earth')['fill-color'] === LAND_LEVELS[level].earth,
    `${name}: land is ${LAND_LEVELS[level].earth}`,
  )
  assert(
    paintOf('coastline')['line-color'] === LAND_LEVELS[level].coast,
    `${name}: coastline is ${LAND_LEVELS[level].coast}`,
  )

  const coastline = style.layers.find((l) => l.id === 'coastline') as unknown as {
    type: string
    'source-layer': string
    filter: unknown[]
  }
  assert(
    coastline.type === 'line' && coastline['source-layer'] === 'earth',
    `${name}: the coastline is a LINE on the earth polygon's own boundary -- Protomaps has no coastline source-layer`,
  )
  assert(
    JSON.stringify(coastline.filter) === JSON.stringify(['==', '$type', 'Polygon']),
    `${name}: the coastline filter takes polygons only`,
  )
}

// The three levels must actually differ, or the tune key does nothing.
{
  const low = JSON.stringify(buildBasemapStyle({ pmtilesUrl: PMTILES, landLevel: 0 }))
  const mid = JSON.stringify(buildBasemapStyle({ pmtilesUrl: PMTILES, landLevel: 1 }))
  const high = JSON.stringify(buildBasemapStyle({ pmtilesUrl: PMTILES, landLevel: 2 }))
  assert(low !== mid && mid !== high && low !== high, 'the three land levels produce three different styles')
}

// Rebuilding must not mutate the stock layer objects the package hands
// back -- structuredClone is what stops one build leaking into the next.
{
  const a = buildBasemapStyle({ pmtilesUrl: PMTILES, landLevel: 0 })
  const b = buildBasemapStyle({ pmtilesUrl: PMTILES, landLevel: 2 })
  const earthA = (a.layers.find((l) => l.id === 'earth') as unknown as { paint: Record<string, string> }).paint
  const earthB = (b.layers.find((l) => l.id === 'earth') as unknown as { paint: Record<string, string> }).paint
  assert(
    earthA['fill-color'] === LAND_LEVELS[0].earth && earthB['fill-color'] === LAND_LEVELS[2].earth,
    'building twice at different levels does not let the second build overwrite the first',
  )
}

const total = passed + failed
console.log(`\n${passed}/${total} passed, ${failed} failed`)
if (failed === 0) {
  console.log(`All ${total} tests passed`)
} else {
  throw new Error(`${failed} of ${total} tests failed`)
}
