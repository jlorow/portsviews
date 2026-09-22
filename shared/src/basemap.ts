// VIS-9 — the geographic basemap that sits UNDERNEATH the ship canvas.
//
// Client-safe module, same contract as areas.ts: no Node-only imports, and
// nothing here touches MapLibre. This file holds only the parts that have
// to agree with mapProject — the zoom that makes the two projections line
// up, the container transform that has to be the same flip mapProject
// applies, the per-area extract and place list, and the attribution text.
// Building the MapLibre style lives in apps/display/src/basemap, because
// that is the only place @protomaps/basemaps is a dependency.

import type { DemoAreaKey } from './areas.ts'
import type { LandLevel } from './config.ts'
import type { ProjectionConfig } from './projection.ts'
import { pxPerNm } from './projection.ts'

/**
 * MapLibre's tile size is 512, not the 256 that most zoom-level tables
 * quote. map-proto-review.txt recorded getting this wrong once: ground
 * resolution is EQUATOR_M * cos(lat) / (512 * 2^zoom), half what the
 * 256-tile constant gives at the same numeric zoom, and an earlier note
 * in that file said "about zoom 9.2" where the real answer is 8.16.
 * Named here so the number cannot drift back.
 */
export const MAPLIBRE_TILE_SIZE = 512

/** Arc-minutes in a full circle of longitude: 360 * 60. */
const ARC_MINUTES_PER_TURN = 21600

/**
 * The MapLibre zoom at which Web Mercator and mapProject's
 * equirectangular grid agree.
 *
 * mapProject's x term is exactly `pixels per degree of longitude =
 * 60 * cos(centerLat) * pxPerNm`. MapLibre's is `worldSize / 360` with
 * `worldSize = MAPLIBRE_TILE_SIZE * 2^zoom`. Equating the two and solving
 * for zoom is this formula.
 *
 * map-proto-ships measured both available choices (audit/a1_align.ts):
 * matching ground metres per pixel instead leaves a worst-case error of
 * 2.93 px on the 20 nm circle at 1920x1080, where matching degrees of
 * longitude makes the x error identically zero and leaves 1.96 px. The
 * residual is Mercator's vertical scale growing with latitude, which no
 * single zoom can cancel — the two projections define a nautical mile
 * differently (1852 m against 1855.32 m) and curve differently.
 *
 * Recomputed on every resize rather than pinned to one window size.
 */
export function basemapZoom(
  canvasWidth: number,
  canvasHeight: number,
  centerLat: number,
  radiusNm: number,
): number {
  const scale = pxPerNm(canvasWidth, canvasHeight, radiusNm)
  const worldSize = ARC_MINUTES_PER_TURN * Math.cos((centerLat * Math.PI) / 180) * scale
  return Math.log2(worldSize / MAPLIBRE_TILE_SIZE)
}

/**
 * The CSS transform for the basemap container, derived from the SAME
 * ProjectionConfig mapProject reads — there is no second mirror flag.
 *
 * A MapLibre map cannot be mirrored any other way: it renders north-up
 * Web Mercator and offers no horizontal flip, so the flip has to happen
 * on the element. On a container that is `inset: 0` over the whole page,
 * `scaleX(-1)` flips about the element's own centre, which is exactly
 * mapProject's `x = canvasWidth - x`. A0(b) measured this in a real
 * browser rather than assuming it: a DOM marker inside the container
 * moved from centreX 820.516 to 1099.484 at innerWidth 1920, against
 * 1920 - 820.528 = 1099.472 predicted.
 *
 * Order matters and matches mapProject, which mirrors FIRST and then
 * rotates: CSS applies the rightmost function first, so `rotate(a)
 * scaleX(-1)` is scale-then-rotate. rotationDeg is 0 under DEFAULT_CONFIG
 * and there is no runtime override today; a non-zero value would also
 * leave the container's corners uncovered, which is a separate problem
 * this story does not solve.
 */
export function basemapContainerTransform(config: ProjectionConfig): string {
  const parts: string[] = []
  if (config.rotationDeg !== 0) parts.push(`rotate(${config.rotationDeg}deg)`)
  if (config.mirrorX) parts.push('scaleX(-1)')
  return parts.length === 0 ? 'none' : parts.join(' ')
}

/**
 * Land brightness. Water stays pure black so a ship over water composites
 * exactly as it does without a basemap; land is a faint blue-black lift
 * and the coastline one step above it.
 *
 * For scale, the faintest things Wake itself draws are a trail tail
 * (vessel colour at alpha 0.35 — cargo #0AA0FF over black is Rec.709 luma
 * ~47) and VIS-6's range rings (#C8D8F0 at alpha 0.12, luma ~24). Every
 * land value sits under the trail; `high`'s coastline is level with it.
 * Those are arithmetic. WHICH of the three is right through a projector
 * is a judgement no code can make, which is why there are three and a
 * tune key.
 *
 * Values are map-proto-ships's, unchanged.
 */
export const LAND_LEVELS = [
  { name: 'low', earth: '#080C11', coast: '#101923' }, // luma ~11 / ~23
  { name: 'mid', earth: '#0E141A', coast: '#18232E' }, // luma ~19 / ~33
  { name: 'high', earth: '#141D26', coast: '#22303E' }, // luma ~27 / ~45
] as const

// LandLevel itself is declared in config.ts, where DisplayConfig needs it,
// so this module can depend on config.ts rather than the other way round
// and the shared graph stays acyclic.
export type { LandLevel }

export function nextLandLevel(current: LandLevel): LandLevel {
  return (((current + 1) % LAND_LEVELS.length) as LandLevel)
}

export interface BasemapPlace {
  name: string
  lat: number
  lon: number
}

export interface BasemapAreaConfig {
  /** Served from apps/display/public, so this is a site-absolute path. */
  pmtilesUrl: string
  /**
   * The curated place list. These are NOT looked-up coordinates: every one
   * was decoded out of this same extract's own `places` layer in
   * map-proto-ships's A0(d), confirmed as kind=locality, and is reproduced
   * here rather than re-derived.
   *
   * Drawn on Wake's canvas through mapProject, never as a MapLibre symbol
   * layer — a style label would be flipped backwards by the mirror
   * transform along with the rest of the map, and would also drag in the
   * SDF glyph CDN as a runtime network dependency.
   */
  places: BasemapPlace[]
}

/**
 * Areas that have a basemap extract. DELIBERATELY PARTIAL: only dover has
 * one today, and an area with no entry draws no basemap at all and keeps
 * the pure-black canvas byte for byte. Adding istanbul, portsaid or sydney
 * is a tile extract plus a row here plus its own curated place list — see
 * the VIS-9 review file for the exact command.
 */
export const BASEMAP_AREAS: Partial<Record<DemoAreaKey, BasemapAreaConfig>> = {
  dover: {
    pmtilesUrl: '/tiles/dover-z11.pmtiles',
    places: [
      { name: 'Dover', lat: 51.1251, lon: 1.3129 },
      { name: 'Calais', lat: 50.9524, lon: 1.8539 },
      { name: 'Folkestone', lat: 51.0792, lon: 1.1793 },
      // 23.25 nm south of the view centre, so mapProject culls it at every
      // landscape window size (the vertical half-extent is exactly
      // radiusNm whenever width >= height). Kept so the list does not
      // silently depend on window shape; it costs one null projection.
      { name: 'Boulogne-sur-Mer', lat: 50.726, lon: 1.6116 },
      { name: 'Ramsgate', lat: 51.3336, lon: 1.42 },
    ],
  },
}

export function basemapAreaFor(key: DemoAreaKey): BasemapAreaConfig | undefined {
  return BASEMAP_AREAS[key]
}

/**
 * Required attribution, drawn as canvas text.
 *
 * The Protomaps basemap is distributed as an Open Database License
 * Produced Work and states "OpenStreetMap attribution required"; the OSM
 * Foundation's attribution guidelines accept "(c) OpenStreetMap
 * contributors" as the credit. This display is NOT a browsable map — it is
 * fixed, non-interactive, and often mirrored onto a ceiling — so it falls
 * under the guidelines' printed/non-interactive case, where a clickable
 * link is impossible and "the URL to openstreetmap.org/copyright must be
 * printed out". Hence the URL as literal text rather than an anchor.
 */
export const ATTRIBUTION_TEXT = '© OpenStreetMap contributors · openstreetmap.org/copyright'
