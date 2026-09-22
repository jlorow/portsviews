/**
 * LANDING-HERO-2 — the coastline under the hero's ships.
 *
 * This is VIS-9's basemap, drawn from baked coordinates instead of from
 * streamed vector tiles. It is NOT a re-styling of it: VIS-9's style keeps
 * `background` (black), `earth` (fill in LAND_LEVELS[level].earth) and
 * `water` (also black, therefore a no-op over a black canvas), and adds a
 * 1px `coastline` line on the earth polygons in LAND_LEVELS[level].coast.
 * Every one of those decisions is reproduced here, using LAND_LEVELS
 * itself rather than copied hex values, and the geometry is the same
 * `earth` source-layer out of the same PMTiles archive
 * (landing/tools/buildHeroBasemap.ts does the decoding, once, at build
 * time).
 *
 * THE MIRROR. VIS-9 could not mirror a MapLibre map any other way than by
 * putting `scaleX(-1)` on its container and deriving that flip from the
 * same ProjectionConfig mapProject reads — one source of truth, but two
 * mechanisms that have to agree. Here the land goes through
 * mapProjectUnclipped, the same projection the ships use, so the mirror is
 * not kept in step with the ships: it IS the ships' mirror. There is
 * nothing left to drift.
 *
 * mapProjectUnclipped rather than mapProject because a background must not
 * be culled to the view circle; that function's own comment has the
 * reasoning.
 */
import { LAND_LEVELS, mapProjectUnclipped, type LandLevel, type ProjectionConfig } from '@wake/shared'

export interface HeroBasemapData {
  areaKey: string
  sourceArchive: string
  zoom: number
  crop: { minLon: number; maxLon: number; minLat: number; maxLat: number }
  /** polygon -> rings -> [lon, lat]. Ring 0 is the outer ring. */
  polygons: [number, number][][][]
  /** [polygonIndex, ringIndex, edgeIndex] for every artificial tile-seam edge. */
  seams: [number, number, number][]
}

export interface HeroBasemapView {
  centerLat: number
  centerLon: number
  radiusNm: number
  projConfig: ProjectionConfig
  canvasWidth: number
  canvasHeight: number
}

export interface Point {
  x: number
  y: number
}

export interface ProjectedBasemap {
  /** Filled land: polygon -> rings -> screen points. */
  land: Point[][][]
  /** Stroked coast: the runs of real (non-seam) edges, as polylines. */
  coast: Point[][]
}

/**
 * Projects the baked geometry to screen space once, for a given canvas
 * size. Pure, and deliberately separate from drawing: the result depends
 * only on the canvas size, so hero.ts recomputes it on resize rather than
 * on every frame.
 */
export function projectHeroBasemap(data: HeroBasemapData, view: HeroBasemapView): ProjectedBasemap {
  const project = (lon: number, lat: number): Point =>
    mapProjectUnclipped(
      lat,
      lon,
      view.centerLat,
      view.centerLon,
      view.radiusNm,
      view.projConfig,
      view.canvasWidth,
      view.canvasHeight,
    )

  const seamKeys = new Set(data.seams.map(([p, r, e]) => `${p},${r},${e}`))

  const land: Point[][][] = []
  const coast: Point[][] = []

  data.polygons.forEach((polygon, polygonIndex) => {
    const rings: Point[][] = []
    polygon.forEach((ring, ringIndex) => {
      const projected = ring.map(([lon, lat]) => project(lon, lat))
      rings.push(projected)

      // Walk the closed ring, breaking the stroke wherever an edge was
      // produced by clipping a vector tile to its own bounds. Those edges
      // are straight lines along a tile boundary and are not coastline;
      // stroking them would draw a grid over the map.
      let run: Point[] = []
      for (let i = 0; i < projected.length; i++) {
        const next = projected[(i + 1) % projected.length]
        if (seamKeys.has(`${polygonIndex},${ringIndex},${i}`)) {
          if (run.length >= 2) coast.push(run)
          run = []
        } else {
          if (run.length === 0) run.push(projected[i])
          run.push(next)
        }
      }
      if (run.length >= 2) coast.push(run)
    })
    land.push(rings)
  })

  return { land, coast }
}

/** VIS-9's `coastline` layer is line-width 1; the canvas convention for a
 * 1px feature is 1 x canvasWidth/1920, the same scale rangeRings.ts uses. */
const COAST_LINE_WIDTH = 1
const REFERENCE_CANVAS_WIDTH = 1920

/**
 * Draws land then coastline. One path per polygon so that a polygon's
 * holes are cut out by the even-odd rule, and ONE path for the whole
 * coastline so the entire outline is a single stroke call.
 */
export function drawHeroBasemap(
  ctx: CanvasRenderingContext2D,
  projected: ProjectedBasemap,
  landLevel: LandLevel,
  canvasWidth: number,
): void {
  const level = LAND_LEVELS[landLevel]

  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = level.earth

  for (const polygon of projected.land) {
    ctx.beginPath()
    for (const ring of polygon) {
      if (ring.length < 3) continue
      ctx.moveTo(ring[0].x, ring[0].y)
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y)
      ctx.closePath()
    }
    ctx.fill('evenodd')
  }

  ctx.strokeStyle = level.coast
  ctx.lineWidth = COAST_LINE_WIDTH * (canvasWidth / REFERENCE_CANVAS_WIDTH)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (const line of projected.coast) {
    if (line.length < 2) continue
    ctx.moveTo(line[0].x, line[0].y)
    for (let i = 1; i < line.length; i++) ctx.lineTo(line[i].x, line[i].y)
  }
  ctx.stroke()

  ctx.restore()
}
