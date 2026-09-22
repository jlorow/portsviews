/**
 * LANDING-HERO-2 tests — the baked coastline.
 *
 * The claims worth testing are not "it draws something". They are:
 *  - the geometry is really the Dover coast, in the right place (checked
 *    by point-in-polygon against towns and open water, not by eyeballing);
 *  - no tile seam is stroked, so the map has no fake straight coastlines;
 *  - land is NOT culled to the view circle, which is the whole reason
 *    mapProjectUnclipped exists;
 *  - the mirror is the ships' mirror, not a second one;
 *  - the colours are LAND_LEVELS', not copies.
 *
 * Run: npx tsx landing/src/heroBasemap.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, DEMO_AREAS, LAND_LEVELS, mapProject, type ProjectionConfig } from '@wake/shared'
import { drawHeroBasemap, projectHeroBasemap, type HeroBasemapData } from './heroBasemap'

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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_PATH = path.join(__dirname, 'heroBasemap.data.json')
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) as HeroBasemapData

const AREA = DEMO_AREAS.dover
const PROJ: ProjectionConfig = { mirrorX: DEFAULT_CONFIG.mirrorX, rotationDeg: DEFAULT_CONFIG.rotationDeg }
const W = 2200
const H = 1020

// --- the asset -----------------------------------------------------------

assert(data.areaKey === 'dover', `asset is for dover (got ${data.areaKey})`)
assert(data.zoom === 10, `baked at z10 (got z${data.zoom})`)
assert(data.polygons.length > 0, `asset carries land polygons (${data.polygons.length})`)

const ringCount = data.polygons.reduce((n, p) => n + p.length, 0)
const pointCount = data.polygons.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0)
console.log(`[info] ${data.polygons.length} polygons, ${ringCount} rings, ${pointCount} points, ${data.seams.length} seams`)
assert(pointCount > 2000, `geometry is detailed enough to be a coastline, not a box (${pointCount} points)`)
assert(data.polygons.every((p) => p.every((r) => r.length >= 3)), 'every ring has at least 3 points')

// Coordinates live inside the union of the z10 tiles the crop covers,
// which is slightly wider than the crop itself.
const tileXToLon = (x: number, z: number): number => (x / 2 ** z) * 360 - 180
const tileYToLat = (y: number, z: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI
const lonToTileX = (lon: number, z: number): number => Math.floor(((lon + 180) / 360) * 2 ** z)
const latToTileY = (lat: number, z: number): number =>
  Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z)

const x0 = lonToTileX(data.crop.minLon, data.zoom)
const x1 = lonToTileX(data.crop.maxLon, data.zoom)
const y0 = latToTileY(data.crop.maxLat, data.zoom)
const y1 = latToTileY(data.crop.minLat, data.zoom)
const BOUND = {
  minLon: tileXToLon(x0, data.zoom),
  maxLon: tileXToLon(x1 + 1, data.zoom),
  minLat: tileYToLat(y1 + 1, data.zoom),
  maxLat: tileYToLat(y0, data.zoom),
}
const EPS = 1e-3
let outside = 0
for (const poly of data.polygons) {
  for (const ring of poly) {
    for (const [lon, lat] of ring) {
      if (
        lon < BOUND.minLon - EPS ||
        lon > BOUND.maxLon + EPS ||
        lat < BOUND.minLat - EPS ||
        lat > BOUND.maxLat + EPS
      ) {
        outside++
      }
    }
  }
}
assert(outside === 0, `every coordinate is clipped inside the source tiles (${outside} outside)`)

// --- seams ---------------------------------------------------------------

assert(data.seams.length > 0, `tile seams were found and recorded (${data.seams.length})`)
assert(
  data.seams.length < pointCount * 0.05,
  `seams are the exception, not the rule (${data.seams.length} of ${pointCount} edges, ${((data.seams.length / pointCount) * 100).toFixed(2)}%)`,
)
assert(
  data.seams.every(([p, r, e]) => data.polygons[p]?.[r] !== undefined && e < data.polygons[p][r].length),
  'every seam index points at a real edge',
)

// A seam edge must be axis-aligned in lon/lat -- that is what a tile
// boundary is. Real coastline essentially never is.
let nonAxisSeams = 0
for (const [p, r, e] of data.seams) {
  const ring = data.polygons[p][r]
  const a = ring[e]
  const b = ring[(e + 1) % ring.length]
  if (Math.abs(a[0] - b[0]) > 1e-4 && Math.abs(a[1] - b[1]) > 1e-4) nonAxisSeams++
}
assert(nonAxisSeams === 0, `every recorded seam is axis-aligned, as a tile boundary must be (${nonAxisSeams} were not)`)

// And the real test: nothing that WILL be stroked lies along a tile grid
// line. This is what stops the map growing a grid of fake coastlines.
const projected = projectHeroBasemap(data, {
  centerLat: AREA.centerLat,
  centerLon: AREA.centerLon,
  radiusNm: AREA.radiusNm,
  projConfig: PROJ,
  canvasWidth: W,
  canvasHeight: H,
})

const gridLons: number[] = []
for (let x = x0; x <= x1 + 1; x++) gridLons.push(tileXToLon(x, data.zoom))
const gridLats: number[] = []
for (let y = y0; y <= y1 + 1; y++) gridLats.push(tileYToLat(y, data.zoom))

let strokedOnGrid = 0
let strokedEdges = 0
for (const poly of data.polygons) {
  for (const ring of poly) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const isSeam = data.seams.some(
        ([p, r, e]) => data.polygons[p][r] === ring && e === i,
      )
      if (isSeam) continue
      strokedEdges++
      const onLon = gridLons.some((g) => Math.abs(a[0] - g) < 1e-6 && Math.abs(b[0] - g) < 1e-6)
      const onLat = gridLats.some((g) => Math.abs(a[1] - g) < 1e-6 && Math.abs(b[1] - g) < 1e-6)
      if (onLon || onLat) strokedOnGrid++
    }
  }
}
assert(strokedEdges > 1000, `there is a real coastline to stroke (${strokedEdges} edges)`)
assert(strokedOnGrid === 0, `no stroked edge lies on a tile grid line (${strokedOnGrid} did)`)

const coastPoints = projected.coast.reduce((n, l) => n + l.length, 0)
assert(projected.coast.length > 0, `the coastline projects to polylines (${projected.coast.length})`)
assert(coastPoints > 1000, `the coastline carries real detail (${coastPoints} points)`)

// --- is it actually the Dover coast? -------------------------------------
// Even-odd point-in-polygon over a polygon's rings, so holes count.

function inRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function isLand(lon: number, lat: number): boolean {
  for (const poly of data.polygons) {
    let crossings = 0
    for (const ring of poly) if (inRing(lon, lat, ring)) crossings++
    if (crossings % 2 === 1) return true
  }
  return false
}

// The place list VIS-9 curated is all coastal towns, so all of them must
// be on land in this geometry. They are also drawn by placeNames.ts, so
// this pins the two against each other.
for (const place of [
  { name: 'Dover', lat: 51.1251, lon: 1.3129 },
  { name: 'Calais', lat: 50.9524, lon: 1.8539 },
  { name: 'Folkestone', lat: 51.0792, lon: 1.1793 },
  { name: 'Ramsgate', lat: 51.3336, lon: 1.42 },
]) {
  assert(isLand(place.lon, place.lat), `${place.name} falls on land in the baked geometry`)
}

// Boulogne-sur-Mer is the FIFTH name in BASEMAP_AREAS.dover and is
// deliberately absent from the geometry. shared/src/basemap.ts records why:
// it sits 23.25 nm south of the view centre, so mapProject culls it "at
// every landscape window size" and placeNames.ts never draws it. The crop
// this geometry is baked from is the visible frame, so it stops short of
// it. An earlier version of this test asserted Boulogne was on land and
// failed, which is how the crop's southern edge got checked at all.
const BOULOGNE = { lat: 50.726, lon: 1.6116 }
assert(
  BOULOGNE.lat < data.crop.minLat,
  `Boulogne-sur-Mer is south of the baked crop (${BOULOGNE.lat} < ${data.crop.minLat}), exactly as it is south of the view`,
)
assert(
  mapProject(BOULOGNE.lat, BOULOGNE.lon, AREA.centerLat, AREA.centerLon, AREA.radiusNm, PROJ, W, H) === null,
  'and mapProject culls it too, so nothing is drawn there either way',
)

// Mid-Strait, and well clear of both coasts: must be water, or the "land"
// is really just a bounding box.
for (const sea of [
  { name: 'mid-Strait', lat: 51.03, lon: 1.52 },
  { name: 'north of the Goodwin Sands', lat: 51.33, lon: 1.75 },
  { name: 'Channel, south-west of Dover', lat: 50.85, lon: 1.2 },
]) {
  assert(!isLand(sea.lon, sea.lat), `${sea.name} is water, not land`)
}

// --- the cull: a background must not be clipped to the view circle -------

// The claim is specifically: land that is INSIDE THE FRAME and that
// mapProject WOULD HAVE DROPPED. Counting those two populations separately
// says nothing -- an earlier version of this test did exactly that and
// compared them, which is meaningless; it is the intersection that matters.
let onCanvas = 0
let onCanvasButCulled = 0
for (let p = 0; p < data.polygons.length; p++) {
  for (let r = 0; r < data.polygons[p].length; r++) {
    for (let i = 0; i < data.polygons[p][r].length; i++) {
      const [lon, lat] = data.polygons[p][r][i]
      const screen = projected.land[p][r][i]
      const visible = screen.x >= 0 && screen.x <= W && screen.y >= 0 && screen.y <= H
      if (!visible) continue
      onCanvas++
      if (mapProject(lat, lon, AREA.centerLat, AREA.centerLon, AREA.radiusNm, PROJ, W, H) === null) onCanvasButCulled++
    }
  }
}
assert(onCanvas > 1000, `plenty of land lands inside the hero frame (${onCanvas} points)`)
assert(
  onCanvasButCulled > 0,
  `and ${onCanvasButCulled} of those ${onCanvas} points sit outside the ${AREA.radiusNm}nm cull radius -- mapProject would have dropped them, leaving a disc of coastline in a black rectangle`,
)
assert(
  onCanvasButCulled / onCanvas > 0.2,
  `that is a large share of the visible coast, not a rounding artefact (${((onCanvasButCulled / onCanvas) * 100).toFixed(1)}%)`,
)

// --- the mirror is the ships' mirror -------------------------------------

const unmirrored = projectHeroBasemap(data, {
  centerLat: AREA.centerLat,
  centerLon: AREA.centerLon,
  radiusNm: AREA.radiusNm,
  projConfig: { mirrorX: false, rotationDeg: 0 },
  canvasWidth: W,
  canvasHeight: H,
})

let mirrorMismatch = 0
let yMismatch = 0
for (let p = 0; p < projected.land.length; p++) {
  for (let r = 0; r < projected.land[p].length; r++) {
    for (let i = 0; i < projected.land[p][r].length; i++) {
      const a = projected.land[p][r][i]
      const b = unmirrored.land[p][r][i]
      if (Math.abs(a.x - (W - b.x)) > 1e-9) mirrorMismatch++
      if (Math.abs(a.y - b.y) > 1e-9) yMismatch++
    }
  }
}
assert(mirrorMismatch === 0, `mirrorX flips x about the canvas width exactly, as it does for ships (${mirrorMismatch} off)`)
assert(yMismatch === 0, `and leaves y untouched (${yMismatch} off)`)

// A ship and the land under it go through the same projection: project a
// known coastal point both ways and require an exact match.
const dover = mapProject(51.1251, 1.3129, AREA.centerLat, AREA.centerLon, AREA.radiusNm, PROJ, W, H)
const doverViaBasemap = projectHeroBasemap(
  { ...data, polygons: [[[[1.3129, 51.1251], [1.3129, 51.1251], [1.3129, 51.1251]]]], seams: [] },
  { centerLat: AREA.centerLat, centerLon: AREA.centerLon, radiusNm: AREA.radiusNm, projConfig: PROJ, canvasWidth: W, canvasHeight: H },
).land[0][0][0]
assert(dover !== null, 'Dover is inside the view radius (sanity)')
assert(
  dover !== null && Math.abs(dover.x - doverViaBasemap.x) < 1e-9 && Math.abs(dover.y - doverViaBasemap.y) < 1e-9,
  'the basemap and a vessel at the same coordinate land on exactly the same pixel',
)

// --- drawing -------------------------------------------------------------

function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = []
  const proxy = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
          calls.push(`${prop}(${args.join(',')})`)
          return undefined
        }
      },
      set(_t, prop: string, value: unknown) {
        calls.push(`${String(prop)}=${String(value)}`)
        return true
      },
    },
  )
  return { ctx: proxy as unknown as CanvasRenderingContext2D, calls }
}

for (const level of [0, 1, 2] as const) {
  const { ctx, calls } = recordingCtx()
  drawHeroBasemap(ctx, projected, level, W)
  const joined = calls.join('\n')
  assert(joined.includes(`fillStyle=${LAND_LEVELS[level].earth}`), `land level ${level} fills with LAND_LEVELS.earth (${LAND_LEVELS[level].earth})`)
  assert(joined.includes(`strokeStyle=${LAND_LEVELS[level].coast}`), `land level ${level} strokes with LAND_LEVELS.coast (${LAND_LEVELS[level].coast})`)
}

{
  const { ctx, calls } = recordingCtx()
  drawHeroBasemap(ctx, projected, DEFAULT_CONFIG.basemapLand, W)
  const fills = calls.filter((c) => c.startsWith('fill(')).length
  const strokes = calls.filter((c) => c === 'stroke()').length
  assert(fills === projected.land.length, `one fill per polygon (${fills} fills, ${projected.land.length} polygons)`)
  assert(strokes === 1, `the entire coastline is ONE stroke call (got ${strokes})`)
  assert(calls.includes("fill(evenodd)"), 'polygons fill with the even-odd rule, so holes are cut out')
  assert(calls.includes('save()') && calls.includes('restore()'), 'context state is saved and restored')
  assert(
    calls.includes(`lineWidth=${1 * (W / 1920)}`),
    `coastline is 1px scaled by canvasWidth/1920, matching the canvas convention (got ${calls.find((c) => c.startsWith('lineWidth='))})`,
  )
  console.log(`[info] one frame of basemap, drawn directly: ${calls.length} context operations`)
}

// --- default is VIS-9's own, not a new choice -----------------------------

assert(DEFAULT_CONFIG.basemapLand === 0, `hero uses VIS-9's ceiling-chosen land level 'low' (basemapLand ${DEFAULT_CONFIG.basemapLand})`)
assert(DEFAULT_CONFIG.basemapEnabled === true, 'hero uses VIS-9\'s basemapEnabled default')
assert(LAND_LEVELS[DEFAULT_CONFIG.basemapLand].name === 'low', "and that level really is named 'low'")

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
