import {
  ATTRIBUTION_TEXT,
  BASEMAP_AREAS,
  LAND_LEVELS,
  MAPLIBRE_TILE_SIZE,
  basemapAreaFor,
  basemapContainerTransform,
  basemapZoom,
  nextLandLevel,
  type LandLevel,
} from './basemap.ts'
import { DEMO_AREAS } from './areas.ts'
import { DEFAULT_CONFIG } from './config.ts'
import { mapProject, pxPerNm } from './projection.ts'

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

const AREA = DEMO_AREAS.dover
const rad = (d: number) => (d * Math.PI) / 180

// --- basemapContainerTransform: the map's flip IS mapProject's flip ---

assert(
  basemapContainerTransform({ mirrorX: true, rotationDeg: 0 }) === 'scaleX(-1)',
  'basemapContainerTransform: mirrorX true -> scaleX(-1)',
)
assert(
  basemapContainerTransform({ mirrorX: false, rotationDeg: 0 }) === 'none',
  'basemapContainerTransform: mirrorX false -> none',
)
assert(
  basemapContainerTransform({ mirrorX: DEFAULT_CONFIG.mirrorX, rotationDeg: DEFAULT_CONFIG.rotationDeg }) ===
    (DEFAULT_CONFIG.mirrorX ? 'scaleX(-1)' : 'none'),
  `basemapContainerTransform: tracks DEFAULT_CONFIG.mirrorX (which is ${DEFAULT_CONFIG.mirrorX})`,
)
// Order matters and must match mapProject, which mirrors and THEN rotates.
// CSS applies the rightmost function first, so scaleX has to come last.
assert(
  basemapContainerTransform({ mirrorX: true, rotationDeg: 90 }) === 'rotate(90deg) scaleX(-1)',
  'basemapContainerTransform: rotation is applied outside the mirror, matching mapProject mirror-then-rotate',
)

// --- basemapZoom: the two projections agree on a real coordinate ---
//
// The required check, stated two ways and computed independently of the
// formula under test. MapLibre renders Web Mercator at basemapZoom and is
// then CSS-flipped; mapProject does its own equirectangular arithmetic and
// flips x itself. The claim is that a real Dover Strait coordinate lands
// in the same place whichever system is asked -- in BOTH mirror states.

function mercatorScreenX(lon: number, canvasWidth: number, zoom: number): number {
  const worldSize = MAPLIBRE_TILE_SIZE * 2 ** zoom
  const px = (l: number) => ((l + 180) / 360) * worldSize
  return canvasWidth / 2 + (px(lon) - px(AREA.centerLon))
}

function mercatorScreenY(lat: number, canvasHeight: number, zoom: number): number {
  const worldSize = MAPLIBRE_TILE_SIZE * 2 ** zoom
  const py = (l: number) => {
    const s = Math.sin(rad(l))
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize
  }
  return canvasHeight / 2 + (py(lat) - py(AREA.centerLat))
}

// Real places inside the Dover view, decoded out of the tile extract
// itself in map-proto-ships's A0(d) -- not looked up, and not invented.
const REAL_POINTS: [string, number, number][] = [
  ['Dover', 51.1251, 1.3129],
  ['Calais', 50.9524, 1.8539],
  ['Folkestone', 51.0792, 1.1793],
  ['Ramsgate', 51.3336, 1.42],
]

for (const size of [
  [1920, 1080],
  [1024, 768],
] as const) {
  const w = size[0]
  const h = size[1]
  const zoom = basemapZoom(w, h, AREA.centerLat, AREA.radiusNm)

  for (const mirrorX of [false, true]) {
    const config = { mirrorX, rotationDeg: 0 }

    for (const point of REAL_POINTS) {
      const wake = mapProject(
        point[1],
        point[2],
        AREA.centerLat,
        AREA.centerLon,
        AREA.radiusNm,
        config,
        w,
        h,
      )
      if (wake === null) {
        assert(false, `basemapZoom: ${point[0]} unexpectedly culled at ${w}x${h}`)
        continue
      }

      // The map is rendered unmirrored and then the whole container is
      // flipped by CSS about its own centre, which on a full-bleed
      // container is x -> canvasWidth - x. A0(b) measured that law in a
      // real browser (a DOM marker moved 820.516 -> 1099.484 at width
      // 1920, against 1920 - 820.528 predicted).
      const rendered = mercatorScreenX(point[2], w, zoom)
      const mapX = mirrorX ? w - rendered : rendered
      const mapY = mercatorScreenY(point[1], h, zoom)

      const dx = Math.abs(wake.x - mapX)
      const dy = Math.abs(wake.y - mapY)

      assert(
        dx < 1e-6,
        `basemapZoom ${w}x${h} mirrorX=${mirrorX}: ${point[0]} x agrees to floating point (|dx| ${dx.toExponential(2)} px)`,
      )
      // The y residual is Mercator's vertical scale growing with latitude
      // against mapProject's linear one -- no single zoom can cancel it,
      // and A0(c) measured the worst case over the whole view at 1.57 px
      // (107 m) at 1920x1080. A budget of 2 px is that measurement plus
      // headroom, not a tolerance chosen to make the test pass.
      assert(
        dy < 2,
        `basemapZoom ${w}x${h} mirrorX=${mirrorX}: ${point[0]} y agrees within the measured Mercator residual (|dy| ${dy.toFixed(4)} px)`,
      )
    }

    // The mirror must add NO error of its own: the disagreement is
    // identical whether or not both systems are flipped.
    const unmirrored = mapProject(51.1251, 1.3129, AREA.centerLat, AREA.centerLon, AREA.radiusNm, { mirrorX: false, rotationDeg: 0 }, w, h)
    const mirrored = mapProject(51.1251, 1.3129, AREA.centerLat, AREA.centerLon, AREA.radiusNm, { mirrorX: true, rotationDeg: 0 }, w, h)
    if (unmirrored !== null && mirrored !== null) {
      assert(
        Math.abs(unmirrored.x + mirrored.x - w) < 1e-9,
        `mapProject ${w}x${h}: mirrored x is exactly canvasWidth - unmirrored x (the same flip the CSS transform applies)`,
      )
      assert(
        Math.abs(unmirrored.y - mirrored.y) < 1e-9,
        `mapProject ${w}x${h}: the mirror does not touch y`,
      )
    }
  }

  // The zoom is derived, not pinned: recomputing it from pxPerNm by hand
  // must give the same number.
  const byHand = Math.log2((21600 * Math.cos(rad(AREA.centerLat)) * pxPerNm(w, h, AREA.radiusNm)) / 512)
  assert(
    Math.abs(byHand - zoom) < 1e-12,
    `basemapZoom ${w}x${h}: matches an independent recomputation (${zoom.toFixed(6)})`,
  )
}

// A wider window must lower the zoom, because pxPerNm is min(w,h)-based:
// widening at fixed height changes nothing, but raising the height scales
// everything up.
assert(
  basemapZoom(1920, 1080, AREA.centerLat, AREA.radiusNm) > basemapZoom(1024, 768, AREA.centerLat, AREA.radiusNm),
  'basemapZoom: a taller canvas means more pixels per nautical mile and so a higher zoom',
)
assert(
  basemapZoom(1920, 1080, AREA.centerLat, AREA.radiusNm) ===
    basemapZoom(3000, 1080, AREA.centerLat, AREA.radiusNm),
  'basemapZoom: widening a landscape canvas does not change the scale (pxPerNm is min(w,h)-based)',
)
assert(MAPLIBRE_TILE_SIZE === 512, 'MAPLIBRE_TILE_SIZE is 512, not the widely quoted 256')

// --- land levels ---

assert(LAND_LEVELS.length === 3, 'LAND_LEVELS: three brightnesses')
assert(
  LAND_LEVELS.map((l) => l.name).join(',') === 'low,mid,high',
  'LAND_LEVELS: ordered low, mid, high',
)
assert(
  DEFAULT_CONFIG.basemapLand === 0,
  `DEFAULT_CONFIG.basemapLand is 0 = '${LAND_LEVELS[0].name}', chosen at the ceiling look on 20 September 2026 (was 1 = 'mid' as a placeholder)`,
)
assert(nextLandLevel(0) === 1 && nextLandLevel(1) === 2 && nextLandLevel(2) === 0, 'nextLandLevel: cycles and wraps')

// Every land value must sit at or under a trail tail's brightness, which
// is the faintest thing Wake itself draws. Rec.709 luma, recomputed here
// rather than trusting the comment beside the constants.
function luma(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
// cargo #0AA0FF at alpha 0.35 over black.
const TRAIL_TAIL_LUMA = 0.35 * luma('#0AA0FF')
for (const level of LAND_LEVELS) {
  assert(
    luma(level.earth) < TRAIL_TAIL_LUMA,
    `LAND_LEVELS ${level.name}: earth luma ${luma(level.earth).toFixed(1)} is under a trail tail's ${TRAIL_TAIL_LUMA.toFixed(1)}`,
  )
  assert(
    luma(level.coast) <= TRAIL_TAIL_LUMA,
    `LAND_LEVELS ${level.name}: coastline luma ${luma(level.coast).toFixed(1)} is at or under a trail tail's ${TRAIL_TAIL_LUMA.toFixed(1)}`,
  )
  assert(
    luma(level.coast) > luma(level.earth),
    `LAND_LEVELS ${level.name}: coastline is brighter than the land it edges`,
  )
}

// --- areas ---

assert(basemapAreaFor('dover') !== undefined, 'basemapAreaFor: dover has a basemap')
for (const key of ['istanbul', 'portsaid', 'sydney'] as const) {
  assert(
    basemapAreaFor(key) === undefined,
    `basemapAreaFor: ${key} has no extract yet, so it draws no basemap at all`,
  )
}
assert(
  Object.keys(BASEMAP_AREAS).every((key) => Object.prototype.hasOwnProperty.call(DEMO_AREAS, key)),
  'BASEMAP_AREAS: every key is a real DEMO_AREAS key',
)

{
  const dover = basemapAreaFor('dover')
  assert(dover?.pmtilesUrl === '/tiles/dover-z11.pmtiles', 'dover: extract served from the display public dir')
  assert(dover?.places.length === 5, 'dover: five curated places')
  // Every place must lie inside the TILE EXTRACT's own bounding box
  // (0.2,50.6 to 2.8,51.6, map-proto-ships's A1), or the basemap has no
  // geometry under the name.
  for (const place of dover?.places ?? []) {
    assert(
      place.lat >= 50.6 && place.lat <= 51.6 && place.lon >= 0.2 && place.lon <= 2.8,
      `dover place ${place.name}: inside the tile extract's bounding box`,
    )
  }

  // The AIS subscription box is a different box and is NOT the right test:
  // the first draft of this assertion used it and failed, because
  // Boulogne-sur-Mer at 50.726 N is south of the box's 50.8 southern edge.
  // Two separate facts, both worth pinning: the four drawn places sit
  // inside the water Wake subscribes to, and the one culled place does not.
  const box = DEMO_AREAS.dover.boundingBoxes[0]
  const north = box[0][0]
  const west = box[0][1]
  const south = box[1][0]
  const east = box[1][1]
  const insideAisBox = (lat: number, lon: number) =>
    lat <= north && lat >= south && lon >= west && lon <= east
  for (const place of dover?.places ?? []) {
    const expected = place.name !== 'Boulogne-sur-Mer'
    assert(
      insideAisBox(place.lat, place.lon) === expected,
      `dover place ${place.name}: ${expected ? 'inside' : 'outside'} the AIS subscription box, as expected`,
    )
  }
  // Boulogne-sur-Mer is the measured caveat: further from the centre than
  // the view radius, so it is culled at every landscape window size.
  const boulogne = dover?.places.find((p) => p.name === 'Boulogne-sur-Mer')
  if (boulogne !== undefined) {
    const distNm = Math.hypot(
      (boulogne.lat - AREA.centerLat) * 60,
      (boulogne.lon - AREA.centerLon) * 60 * Math.cos(rad(AREA.centerLat)),
    )
    assert(
      distNm > AREA.radiusNm,
      `dover: Boulogne-sur-Mer is ${distNm.toFixed(2)} nm out, beyond the ${AREA.radiusNm} nm radius, so mapProject culls it`,
    )
    assert(
      mapProject(boulogne.lat, boulogne.lon, AREA.centerLat, AREA.centerLon, AREA.radiusNm, { mirrorX: true, rotationDeg: 0 }, 1920, 1080) === null,
      'dover: mapProject really does return null for Boulogne-sur-Mer at 1920x1080',
    )
  }
  // The other four must be on screen, or the list is decorative.
  for (const name of ['Dover', 'Calais', 'Folkestone', 'Ramsgate']) {
    const place = dover?.places.find((p) => p.name === name)
    assert(
      place !== undefined &&
        mapProject(place.lat, place.lon, AREA.centerLat, AREA.centerLon, AREA.radiusNm, { mirrorX: true, rotationDeg: 0 }, 1920, 1080) !== null,
      `dover: ${name} projects onto a 1920x1080 canvas`,
    )
  }
}

// --- attribution ---

assert(ATTRIBUTION_TEXT.includes('OpenStreetMap'), 'ATTRIBUTION_TEXT: credits OpenStreetMap')
assert(
  ATTRIBUTION_TEXT.includes('openstreetmap.org/copyright'),
  'ATTRIBUTION_TEXT: prints the copyright URL, which the non-interactive case requires',
)
assert(!ATTRIBUTION_TEXT.includes('<'), 'ATTRIBUTION_TEXT: plain text, not markup -- it is drawn on a canvas')

// --- the LandLevel type is the config's own ---

const level: LandLevel = DEFAULT_CONFIG.basemapLand
assert(level === 0 || level === 1 || level === 2, 'LandLevel: DisplayConfig.basemapLand is one of the three')

const total = passed + failed
console.log(`\n${passed}/${total} passed, ${failed} failed`)
if (failed === 0) {
  console.log(`All ${total} tests passed`)
} else {
  throw new Error(`${failed} of ${total} tests failed`)
}
