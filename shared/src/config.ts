// VIS-4 ceiling session, projector canvas 1024x768: mean share of vessels
// alone in their own blob was 26.8% at 1.00 vs 31.7% at 0.75, and the
// human could still tell types apart down to 0.55. No human-facing
// control exists yet -- that arrives with S7.4 (phone panel); this is the
// fixed default until then.
export const GLYPH_SCALES = [0.75, 0.55, 0.4, 0.3] as const

// VIS-8: the next value in GLYPH_SCALES, wrapping. A1(f) found no runtime
// way to change glyphScale at all, so the ceiling look had no way to
// compare sizes; tune key G calls this. Exported rather than inlined in
// WakeCanvas.tsx like the other cycling keys precisely so the cycle is
// testable -- a React key handler is not. An unrecognised current value
// (indexOf -1) yields the first entry.
export function nextGlyphScale(current: (typeof GLYPH_SCALES)[number]): (typeof GLYPH_SCALES)[number] {
  const index = GLYPH_SCALES.indexOf(current)
  return GLYPH_SCALES[(index + 1) % GLYPH_SCALES.length]
}

// VIS-6: heroScale options, applied to VESSEL_BASE_SIZES in place of
// glyphScale for the (at most 4) hero vessels. Default 1.0, chosen at
// the ceiling look (17 September 2026).
export const HERO_SCALES = [1.0, 1.4, 1.8] as const

// VIS-7: label size options for hero-only name/type/speed labels.
export const LABEL_SIZES = ['off', 'S', 'M', 'L'] as const

// VIS-7: unknown-type circle size, applied on top of glyphScale so the
// unknown glyph (which currently outshines heroes) can shrink without
// affecting any typed vessel.
export const UNKNOWN_SCALES = [1.0, 0.6, 0.4] as const

// VIS-7: radar sweep period in seconds; 0 disables the sweep and reveals
// every vessel immediately.
export const SWEEP_PERIODS = [0, 6, 10, 16] as const

// VIS-9: which of basemap.ts's three land brightnesses the basemap draws.
// Declared here rather than in basemap.ts so DisplayConfig can name it
// without config.ts importing basemap.ts -- basemap.ts needs pxPerNm from
// projection.ts, which needs vesselState.ts, which needs this file, and
// that would close a cycle.
export type LandLevel = 0 | 1 | 2

export interface DisplayConfig {
  mirrorX: boolean          // default: true (ceiling-pointed projection)
  rotationDeg: number       // default: 0
  brightness: number        // default: 100 (0-100)
  theme: 'ocean' | 'chart' | 'minimal'  // default: 'ocean'
  projectionMode: 'map' | 'sky'         // default: 'map'
  smoothing: number         // default: 0.18
  maxExtrapolationSec: number           // sized from measured 67.2s median inter-arrival, Dover Strait box — not theoretical AIS intervals
  staleSec: number          // sized from measured 67.2s median inter-arrival, Dover Strait box — not theoretical AIS intervals
  removeSec: number         // sized from measured 67.2s median inter-arrival, Dover Strait box — not theoretical AIS intervals
  trailLength: 'short' | 'medium' | 'long'  // default: 'medium'
  labelDensity: 'all' | 'nearest' | 'none'  // default: 'all'
  glyphScale: (typeof GLYPH_SCALES)[number]  // default: 0.75 (VIS-4); human-facing control arrives with S7.4
  heroesEnabled: boolean    // default: true (VIS-6)
  glowEnabled: boolean      // default: true (VIS-6)
  rangeRingsEnabled: boolean  // default: true (VIS-6)
  heroScale: (typeof HERO_SCALES)[number]  // default: 1.0 (VIS-6, chosen at the ceiling look)
  labelSize: (typeof LABEL_SIZES)[number]  // default: 'M' (VIS-7)
  areaTitleEnabled: boolean  // default: true (VIS-7)
  unknownScale: (typeof UNKNOWN_SCALES)[number]  // default: 0.6 (VIS-7, chosen at the ceiling look 17 September 2026)
  sweepPeriodSec: (typeof SWEEP_PERIODS)[number]  // default: 10 (VIS-7; 0 = off)
  stoppedAsDot: boolean     // default: true (VIS-8)
  legendEnabled: boolean    // default: true (VIS-8)
  // VIS-9 chose these three at the ship ceiling look on 20 September 2026,
  // and a second look the same day confirmed all three unchanged.
  basemapEnabled: boolean   // default: true (VIS-9); no effect in an area with no tile extract
  basemapLand: LandLevel    // default: 0 = 'low' (VIS-9, chosen at the ceiling look 20 September 2026)
  placeNamesEnabled: boolean  // default: true (VIS-9); town names drawn on Wake's canvas, never in the map style
}

export const DEFAULT_CONFIG: DisplayConfig = {
  mirrorX: true,
  rotationDeg: 0,
  brightness: 100,
  theme: 'ocean',
  projectionMode: 'map',
  smoothing: 0.18,
  maxExtrapolationSec: 120,
  staleSec: 240,
  removeSec: 900,
  trailLength: 'medium',
  labelDensity: 'all',
  glyphScale: 0.75,
  heroesEnabled: true,
  glowEnabled: true,
  rangeRingsEnabled: true,
  heroScale: 1.0,
  labelSize: 'M',
  areaTitleEnabled: true,
  unknownScale: 0.6,
  sweepPeriodSec: 10,
  stoppedAsDot: true,
  legendEnabled: true,
  basemapEnabled: true,
  basemapLand: 0,
  placeNamesEnabled: true,
}
