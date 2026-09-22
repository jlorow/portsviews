/**
 * LANDING-HERO-2 — bakes the marketing hero's coastline out of the VIS-9
 * Dover PMTiles archive at build time.
 *
 * WHY THIS EXISTS AT ALL, in one paragraph, because it is the whole
 * argument of the story: VIS-9's basemap style
 * (apps/display/src/basemap/basemapStyle.ts) keeps exactly three stock
 * layers and adds one. Of those, `background` is black and `water` is
 * ALSO black — over a black canvas the water fill is a visual no-op. So
 * everything the basemap actually shows comes from ONE source-layer,
 * `earth`: a fill in LAND_LEVELS[level].earth and a 1px stroke of the
 * same polygons' boundary in LAND_LEVELS[level].coast. That is a shape,
 * not a map engine. Shipping maplibre-gl (338.6 kB gzipped) and streaming
 * vector tiles to a marketing page to draw one polygon layer is a cost
 * with no matching benefit, so the polygons are decoded once, here, and
 * shipped as coordinates.
 *
 * Nothing about the LOOK is re-invented: heroBasemap.ts draws them with
 * LAND_LEVELS itself, through mapProject, which is strictly closer to
 * VIS-9's intent than the MapLibre path is — the mirror comes from the
 * same ProjectionConfig the ships use instead of from a CSS transform on
 * a separate element that has to be kept in step with it.
 *
 * Build-time only, run with tsx. Offline: it reads a local archive and
 * opens no connection. The archive is gitignored, so this is re-run only
 * when the crop or the archive changes; its OUTPUT is committed.
 *
 *   npx tsx landing/tools/buildHeroBasemap.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import { DEMO_AREAS, basemapAreaFor } from '@wake/shared'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

const ARCHIVE =
  process.env.HERO_BASEMAP_ARCHIVE ??
  path.join(REPO_ROOT, 'apps', 'display', 'public', 'tiles', 'dover-z11.pmtiles')
const OUT_PATH = process.env.HERO_BASEMAP_OUT ?? path.join(__dirname, '..', 'src', 'heroBasemap.data.json')

const AREA = DEMO_AREAS.dover

/**
 * The zoom the geometry is taken from.
 *
 * The hero's canvas is at most 1100 CSS px wide at device pixel ratio 2,
 * so basemapZoom lands at 9.40; MapLibre would have requested z9 tiles and
 * drawn those. Baking z10 therefore gives the page MORE detail than the
 * MapLibre route ever would have at this size, not less. It was chosen by
 * measurement, not preference — z7 and z8 drop whole harbour features
 * (max deviation from z10 of 371 px and 368 px respectively at the hero's
 * 25.5 px/nm, against 218 px for z9). The archive's own maxzoom is 11.
 */
const BAKE_ZOOM = 10

/**
 * The hero canvas's fixed aspect (hero.ts's HERO_ASPECT), plus 5% margin
 * so nothing pops in at the edge if that ratio is nudged.
 */
const HERO_ASPECT = 1920 / 890
const CROP_MARGIN = 1.05

/** Coordinates are rounded to this many decimals. */
const COORD_DP = 4

type Ring = [number, number][]

// --- the crop -------------------------------------------------------------
// mapProject's vertical half-extent is exactly radiusNm on any landscape
// canvas (pxPerNm is min(w,h)/2/radiusNm), and the horizontal half-extent
// is that times the aspect. Both are independent of pixel size, so the
// geographic crop is the same at every canvas width.
const halfLatDeg = ((AREA.radiusNm * CROP_MARGIN) / 60)
const halfLonDeg = (AREA.radiusNm * HERO_ASPECT * CROP_MARGIN) / (60 * Math.cos((AREA.centerLat * Math.PI) / 180))
const CROP = {
  minLon: AREA.centerLon - halfLonDeg,
  maxLon: AREA.centerLon + halfLonDeg,
  minLat: AREA.centerLat - halfLatDeg,
  maxLat: AREA.centerLat + halfLatDeg,
}

// --- PMTiles v3 -----------------------------------------------------------
// Header is a fixed 127-byte layout and the root directory is a
// gzipped run-length varint block; both are read by hand rather than
// pulling in the pmtiles package, which exists to do HTTP range requests
// at runtime — the one thing this story is removing.

function readVarints(buf: Buffer, n: number, start: number): { out: bigint[]; next: number } {
  const out: bigint[] = []
  let i = start
  for (let k = 0; k < n; k++) {
    let r = 0n
    let shift = 0n
    for (;;) {
      const b = buf[i++]
      r |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7n
    }
    out.push(r)
  }
  return { out, next: i }
}

interface DirEntry {
  tileId: bigint
  runLength: number
  length: number
  offset: number
}

function decodeDirectory(buf: Buffer): DirEntry[] {
  let r = readVarints(buf, 1, 0)
  const n = Number(r.out[0])
  const ids: bigint[] = []
  r = readVarints(buf, n, r.next)
  let last = 0n
  for (const d of r.out) {
    last += d
    ids.push(last)
  }
  const runs: number[] = []
  r = readVarints(buf, n, r.next)
  for (const v of r.out) runs.push(Number(v))
  const lens: number[] = []
  r = readVarints(buf, n, r.next)
  for (const v of r.out) lens.push(Number(v))
  const offs: number[] = []
  r = readVarints(buf, n, r.next)
  for (let i = 0; i < n; i++) {
    const v = Number(r.out[i])
    offs.push(v === 0 && i > 0 ? offs[i - 1] + lens[i - 1] : v - 1)
  }
  return ids.map((id, i) => ({ tileId: id, runLength: runs[i], length: lens[i], offset: offs[i] }))
}

/** Hilbert order, per the PMTiles v3 specification. */
function zxyToTileId(z: number, x: number, y: number): bigint {
  const acc = (4n ** BigInt(z) - 1n) / 3n
  const n = 2 ** z
  let d = 0n
  let s = n / 2
  let tx = x
  let ty = y
  while (s > 0) {
    const rx = (tx & s) > 0 ? 1 : 0
    const ry = (ty & s) > 0 ? 1 : 0
    d += BigInt(s) * BigInt(s) * BigInt((3 * rx) ^ ry)
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx
        ty = s - 1 - ty
      }
      const t = tx
      tx = ty
      ty = t
    }
    s = Math.floor(s / 2)
  }
  return acc + d
}

const file = fs.readFileSync(ARCHIVE)
const header = file.subarray(0, 127)
if (header.toString('ascii', 0, 7) !== 'PMTiles') throw new Error(`not a PMTiles archive: ${ARCHIVE}`)
const u64 = (o: number): number => Number(header.readBigUInt64LE(o))
const ROOT_OFF = u64(8)
const ROOT_LEN = u64(16)
const TILEDATA_OFF = u64(56)
const ARCHIVE_MAXZOOM = header[101]
if (BAKE_ZOOM > ARCHIVE_MAXZOOM) throw new Error(`BAKE_ZOOM ${BAKE_ZOOM} exceeds archive maxzoom ${ARCHIVE_MAXZOOM}`)

const directory = decodeDirectory(zlib.gunzipSync(file.subarray(ROOT_OFF, ROOT_OFF + ROOT_LEN)))

function getTile(z: number, x: number, y: number): Buffer | null {
  const id = zxyToTileId(z, x, y)
  const entry = directory.find((d) => d.tileId <= id && id < d.tileId + BigInt(d.runLength || 1))
  if (entry === undefined || entry.runLength === 0) return null
  return zlib.gunzipSync(file.subarray(TILEDATA_OFF + entry.offset, TILEDATA_OFF + entry.offset + entry.length))
}

// --- tile <-> lon/lat -----------------------------------------------------
const lonToTileX = (lon: number, z: number): number => Math.floor(((lon + 180) / 360) * 2 ** z)
const latToTileY = (lat: number, z: number): number =>
  Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z)
const tileXToLon = (x: number, z: number): number => (x / 2 ** z) * 360 - 180
const tileYToLat = (y: number, z: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI

// --- clipping -------------------------------------------------------------
// Sutherland-Hodgman against the tile's own rectangle. Vector tiles carry
// geometry a little BEYOND their bounds (the MVT buffer), so neighbouring
// tiles overlap; clipping to the exact rectangle makes them abut instead.
// The clip also tells us which edges are artificial: an edge produced by
// clipping lies exactly on a tile boundary, and must be filled but never
// stroked, or the map grows a grid of straight fake coastlines.

type Edge = 'minLon' | 'maxLon' | 'minLat' | 'maxLat'
interface Rect {
  minLon: number
  maxLon: number
  minLat: number
  maxLat: number
}

function inside(p: [number, number], edge: Edge, rect: Rect): boolean {
  if (edge === 'minLon') return p[0] >= rect.minLon
  if (edge === 'maxLon') return p[0] <= rect.maxLon
  if (edge === 'minLat') return p[1] >= rect.minLat
  return p[1] <= rect.maxLat
}

function intersect(a: [number, number], b: [number, number], edge: Edge, rect: Rect): [number, number] {
  if (edge === 'minLon' || edge === 'maxLon') {
    const x = edge === 'minLon' ? rect.minLon : rect.maxLon
    const t = (x - a[0]) / (b[0] - a[0])
    return [x, a[1] + t * (b[1] - a[1])]
  }
  const y = edge === 'minLat' ? rect.minLat : rect.maxLat
  const t = (y - a[1]) / (b[1] - a[1])
  return [a[0] + t * (b[0] - a[0]), y]
}

function clipRing(ring: Ring, rect: Rect): Ring {
  let output: Ring = ring
  for (const edge of ['minLon', 'maxLon', 'minLat', 'maxLat'] as Edge[]) {
    const input = output
    output = []
    if (input.length === 0) break
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]
      const prev = input[(i + input.length - 1) % input.length]
      const curIn = inside(cur, edge, rect)
      const prevIn = inside(prev, edge, rect)
      if (curIn) {
        if (!prevIn) output.push(intersect(prev, cur, edge, rect))
        output.push(cur)
      } else if (prevIn) {
        output.push(intersect(prev, cur, edge, rect))
      }
    }
  }
  return output
}

const ON_EDGE_EPS = 1e-9

function onRectEdge(p: [number, number], rect: Rect): Edge | null {
  if (Math.abs(p[0] - rect.minLon) < ON_EDGE_EPS) return 'minLon'
  if (Math.abs(p[0] - rect.maxLon) < ON_EDGE_EPS) return 'maxLon'
  if (Math.abs(p[1] - rect.minLat) < ON_EDGE_EPS) return 'minLat'
  if (Math.abs(p[1] - rect.maxLat) < ON_EDGE_EPS) return 'maxLat'
  return null
}

/** A segment is artificial when both ends sit on the SAME tile boundary. */
function isTileSeam(a: [number, number], b: [number, number], rect: Rect): boolean {
  const ea = onRectEdge(a, rect)
  return ea !== null && ea === onRectEdge(b, rect)
}

/**
 * The indices of a ring's artificial edges — edge i being the segment
 * from vertex i to vertex i+1 (wrapping). Only these are recorded, not a
 * second copy of the geometry: there are 73 of them against 5,065 ring
 * points, so listing the exceptions costs about a kilobyte where shipping
 * the stroke as its own point list doubled the whole file.
 */
function seamEdgeIndices(ring: Ring, rect: Rect): number[] {
  const seams: number[] = []
  for (let i = 0; i < ring.length; i++) {
    if (isTileSeam(ring[i], ring[(i + 1) % ring.length], rect)) seams.push(i)
  }
  return seams
}

// --- bake -----------------------------------------------------------------

const round = (v: number): number => Number(v.toFixed(COORD_DP))
const roundRing = (r: Ring): Ring => r.map(([lo, la]) => [round(lo), round(la)] as [number, number])

const x0 = lonToTileX(CROP.minLon, BAKE_ZOOM)
const x1 = lonToTileX(CROP.maxLon, BAKE_ZOOM)
const y0 = latToTileY(CROP.maxLat, BAKE_ZOOM)
const y1 = latToTileY(CROP.minLat, BAKE_ZOOM)

const polygons: Ring[][] = []
/** [polygonIndex, ringIndex, edgeIndex] for every artificial edge. */
const seams: [number, number, number][] = []
let tilesRead = 0
let tilesMissing = 0
let featureCount = 0
let seamEdges = 0
let realEdges = 0

for (let x = x0; x <= x1; x++) {
  for (let y = y0; y <= y1; y++) {
    const buf = getTile(BAKE_ZOOM, x, y)
    if (buf === null) {
      tilesMissing++
      continue
    }
    tilesRead++
    const layer = new VectorTile(new Pbf(buf)).layers['earth']
    if (layer === undefined) continue

    const rect: Rect = {
      minLon: tileXToLon(x, BAKE_ZOOM),
      maxLon: tileXToLon(x + 1, BAKE_ZOOM),
      minLat: tileYToLat(y + 1, BAKE_ZOOM),
      maxLat: tileYToLat(y, BAKE_ZOOM),
    }

    for (let i = 0; i < layer.length; i++) {
      const geo = layer.feature(i).toGeoJSON(x, y, BAKE_ZOOM).geometry
      const multi =
        geo.type === 'Polygon'
          ? [geo.coordinates as unknown as Ring[]]
          : geo.type === 'MultiPolygon'
            ? (geo.coordinates as unknown as Ring[][])
            : []
      for (const poly of multi) {
        featureCount++
        const clipped: Ring[] = []
        const clippedSeams: number[][] = []
        for (const ring of poly) {
          const c = clipRing(ring, rect)
          if (c.length < 3) continue
          const found = seamEdgeIndices(c, rect)
          clipped.push(roundRing(c))
          clippedSeams.push(found)
          seamEdges += found.length
          realEdges += c.length - found.length
        }
        if (clipped.length === 0) continue
        const polyIndex = polygons.length
        polygons.push(clipped)
        clippedSeams.forEach((list, ringIndex) => {
          for (const edgeIndex of list) seams.push([polyIndex, ringIndex, edgeIndex])
        })
      }
    }
  }
}

const data = {
  areaKey: 'dover',
  sourceArchive: path.basename(ARCHIVE),
  zoom: BAKE_ZOOM,
  crop: {
    minLon: round(CROP.minLon),
    maxLon: round(CROP.maxLon),
    minLat: round(CROP.minLat),
    maxLat: round(CROP.maxLat),
  },
  polygons,
  seams,
}

fs.writeFileSync(OUT_PATH, JSON.stringify(data))

const ringCount = polygons.reduce((n, p) => n + p.length, 0)
const polyPoints = polygons.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0)
const bytes = fs.statSync(OUT_PATH).size
const gz = zlib.gzipSync(fs.readFileSync(OUT_PATH), { level: 9 }).length

console.log(`[basemap] archive    : ${ARCHIVE} (maxzoom ${ARCHIVE_MAXZOOM})`)
console.log(`[basemap] bake zoom  : ${BAKE_ZOOM}`)
console.log(`[basemap] crop       : lon ${CROP.minLon.toFixed(4)}..${CROP.maxLon.toFixed(4)} lat ${CROP.minLat.toFixed(4)}..${CROP.maxLat.toFixed(4)}`)
console.log(`[basemap] tiles      : x ${x0}..${x1} y ${y0}..${y1} = ${(x1 - x0 + 1) * (y1 - y0 + 1)} (${tilesRead} read, ${tilesMissing} absent)`)
console.log(`[basemap] features   : ${featureCount} earth polygons`)
console.log(`[basemap] fill       : ${polygons.length} polygons, ${ringCount} rings, ${polyPoints} points`)
console.log(`[basemap] coastline  : ${realEdges} edges stroked, ${seamEdges} tile seams recorded and skipped`)
console.log(`[basemap] places     : ${basemapAreaFor('dover')?.places.length ?? 0} (unchanged, drawn by placeNames.ts)`)
console.log(`[basemap] out        : ${OUT_PATH}`)
console.log(`[basemap] size       : ${bytes} B raw, ${gz} B gzip`)
