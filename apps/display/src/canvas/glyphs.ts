import type { VesselType } from '@wake/shared'
import {
  VesselGlyphSpec,
  VESSEL_COLORS,
  NOTABLE_COLOR,
  DARK_OUTLINE_COLOR,
} from '@wake/shared'
import {
  getTypedGlyphShape,
  mixedGlyphColors,
  tierFor,
  typedHalfLengthRatio,
  typedHalfWidthRatio,
} from './glyphShapes'

// baseSize is a reference size at 1920px canvas width; every other width
// scales proportionally. Exported so VIS-6's hero glow can size itself
// (0.9x / 0.25x of the same drawn length) off the real glyph code's own
// scaling instead of a second copy of this formula.
export function glyphActualSize(baseSize: number, canvasWidth: number): number {
  return baseSize * (canvasWidth / 1920)
}

// The circle-era radius ratio remains for the unknown silhouette and its
// stopped fallback dot; typed fallback dots derive their radius from hull
// beam instead.
export const STOPPED_DOT_MIN_RADIUS_PX = 6

// Kept at 0.28 for the unknown silhouette and its stopped fallback dot.
export const GLYPH_DOT_RADIUS_RATIO = 0.28

// VIS-9: the smallest a stopped-typed dot may be drawn at, in px at the
// full 1920px canvas. Scaled by canvasWidth/1920 with the same factor as
// every other pixel length in this codebase, so a narrower display never
// draws a stopped dot that reads as a blob. The 1.1 x hullHalfWidth term
// stays above this floor, so the floor only matters on ultra-wide screens
// (or after a future glyphScale change) and never shrinks a dot below the
// beam of the vessel it represents.

// VIS-8's unknown silhouette, as blunt as hullPath allows while still
// reading as a hull rather than a blob. See drawUnknown.
const UNKNOWN_BOW_POINTINESS = 0.2
const UNKNOWN_STERN_WIDTH = 0.88

// Beam as a fraction of length. A7 first shipped this silhouette in a 1:1
// box, measured at exactly 1.000 -- square, which no real hull is: as
// drawn in this file the six typed glyphs run from tugboat's 0.6774
// (1:1.48) to naval's 0.1478 (1:6.76), the range Correction 22 records.
// 0.375 is the ferry's own drawn proportion (1:2.67), mid-range, and the
// right middle value for a silhouette standing in for an unknown mix of
// types rather than for any one of them.
//
// VIS-8 A11: a dark edge on the two shapes that are drawn opaque and
// routinely land on top of each other.
//
// A dark outer edge separates opaque overlapping glyphs, regardless of
// whether their fill comes from the type palette or STOPPED_COLOR.
const OUTLINE_WIDTH = 1

function strokeOutline(ctx: CanvasRenderingContext2D, canvasWidth: number): void {
  ctx.strokeStyle = DARK_OUTLINE_COLOR
  ctx.lineWidth = OUTLINE_WIDTH * (canvasWidth / 1920)
  ctx.stroke()
}

const UNKNOWN_BEAM_TO_LENGTH = 0.375

// Applied as a multiply on one axis and a divide on the other, so hw * hh
// -- and therefore the bounding-box area -- is exactly what it was at 1:1.
// This is a proportion change, not a size change: the same size input
// produces the same footprint area, redistributed.
const UNKNOWN_ASPECT = Math.sqrt(UNKNOWN_BEAM_TO_LENGTH)

// The single circle path both circular glyphs draw. Expects the caller to
// have translated to the vessel's centre and set fillStyle already -- the
// same contract hullPath and the drawCargo family already work under.
function dotPath(ctx: CanvasRenderingContext2D, radius: number): void {
  // GLYPH_DOT_RADIUS_RATIO remains part of the unknown silhouette and
  // fallback-dot sizing; typed fallback dots use their hull beam.
  ctx.beginPath()
  ctx.arc(0, 0, radius, 0, Math.PI * 2)
  ctx.closePath()
  ctx.fill()
}

/**
 * Draw a stopped vessel without a trustworthy heading as a filled dot.
 * The supplied baseSize already includes glyphScale and, for unknown
 * vessels, unknownScale.
 *
 * @param baseSize - reference size at 1920px canvas width, already
 *   scaled by glyphScale by the caller and by unknownScale for unknown
 *   vessels.
 */
export function drawDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  baseSize: number,
  color: string,
  canvasWidth: number,
  type: VesselType,
): void {
  const actualSize = glyphActualSize(baseSize, canvasWidth)

  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = color
  ctx.globalAlpha = 1.0
  // Radius is the wider of 1.1 x the shape's half-width and the minimum
  // proxy, with both scaled to the canvas width.
  const hullHalfWidth = type === 'unknown'
    ? actualSize * GLYPH_DOT_RADIUS_RATIO * UNKNOWN_ASPECT
    : actualSize * typedHalfWidthRatio(type)
  const dotRadiusPx = Math.max(
    1.1 * hullHalfWidth,
    STOPPED_DOT_MIN_RADIUS_PX * (canvasWidth / 1920),
  )
  // Per the story rule max(1.1 x hullHalfWidth, STOPPED_DOT_MIN_RADIUS_PX x scale).
  dotPath(ctx, dotRadiusPx)
  // A11: the path dotPath just filled is still current, so this strokes
  // the same circle rather than rebuilding it.
  strokeOutline(ctx, canvasWidth)
  ctx.restore()
}

/**
 * Draw a vessel glyph on the canvas at position (x, y).
 * The glyph is a top-down silhouette rotated to match course over ground.
 *
 * @param ctx     - Canvas 2D rendering context
 * @param x       - Canvas X position (already projected)
 * @param y       - Canvas Y position (already projected)
 * @param screenHeadingDeg - Degrees clockwise from screen-up (matching
 *   ctx.rotate's own convention), already carried through mapProject's
 *   mirror and rotation -- NOT the raw AIS cogDeg. Callers project it
 *   with shared/src/projection.ts's screenHeadingDeg(); see Correction 18.
 *   IGNORED for the 'unknown' type unless rotateUnknown is true -- see
 *   the rotation guard below.
 * @param spec    - Vessel glyph specification
 * @param canvasWidth - Current canvas width (for size scaling)
 * @param shadow  - VIS-6 hero glow only. When set, applies
 *   shadowBlur/shadowColor for this draw; ctx.restore() below reverts it
 *   (shadowBlur is 0 on every ctx before this ever runs, so restore's
 *   snapshot is the correct "off" state) -- never passed for a non-hero
 *   vessel.
 */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  screenHeadingDeg: number,
  spec: VesselGlyphSpec,
  canvasWidth: number,
  shadow?: { blur: number; color: string },
): void {
  const actualSize = glyphActualSize(spec.baseSize, canvasWidth)
  const color = spec.color !== '' ? spec.color : spec.isNotable ? NOTABLE_COLOR : VESSEL_COLORS[spec.type]

  ctx.save()
  ctx.translate(x, y)
  // Unknown silhouettes remain orientationless by default; stopped
  // unknowns opt in because they use the ship's reported true heading.
  if (spec.type !== 'unknown' || spec.rotateUnknown === true) {
    ctx.rotate((screenHeadingDeg * Math.PI) / 180)
  }
  ctx.fillStyle = color
  ctx.globalAlpha = 1.0
  if (spec.type === 'unknown') {
    if (shadow) {
      ctx.shadowBlur = shadow.blur
      ctx.shadowColor = shadow.color
    }
    drawUnknown(ctx, actualSize, canvasWidth)
  } else {
    drawTypedGlyph(ctx, spec.type, actualSize, canvasWidth, color, shadow)
  }

  ctx.restore()
}

function drawTypedGlyph(
  ctx: CanvasRenderingContext2D,
  type: Exclude<VesselGlyphSpec['type'], 'unknown'>,
  actualSize: number,
  canvasWidth: number,
  color: string,
  shadow?: { blur: number; color: string },
): void {
  const halfLength = actualSize * typedHalfLengthRatio(type)
  const shape = getTypedGlyphShape(type, tierFor(type, halfLength * 2))
  const tones = mixedGlyphColors(color)

  ctx.scale(halfLength, halfLength)
  if (shadow) {
    ctx.shadowBlur = shadow.blur
    ctx.shadowColor = shadow.color
  }
  ctx.fillStyle = color
  ctx.fill(shape.hull)
  if (shadow) ctx.shadowBlur = 0

  ctx.fillStyle = tones.dark
  ctx.fill(shape.dark, 'evenodd')
  ctx.fillStyle = tones.light
  ctx.fill(shape.light)
  if (shape.tier >= 2) {
    ctx.fillStyle = '#05070A'
    ctx.fill(shape.cutout)
  }

  ctx.strokeStyle = DARK_OUTLINE_COLOR
  ctx.lineWidth = OUTLINE_WIDTH * (canvasWidth / 1920) / halfLength
  ctx.stroke(shape.hull)
}

/**
 * Shared hull outline. Bow points UP (negative Y), centred on (0,0).
 * @param bowPointiness 0 = blunt rounded bow, 1 = sharp point
 * @param sternWidth    fraction of half-width at the transom
 *                      (1 = square stern, 0 = pointed stern)
 */
function hullPath(
  ctx: CanvasRenderingContext2D,
  hw: number,
  hh: number,
  bowPointiness: number,
  sternWidth: number,
): void {
  const bowCp1 = hw * (1 - bowPointiness * 0.6)
  const bowCp1y = -hh * (0.55 + bowPointiness * 0.3)
  const bowCp2y = -hh * (0.30 + bowPointiness * 0.25)
  const sw = hw * sternWidth

  ctx.beginPath()
  ctx.moveTo(0, -hh)
  ctx.bezierCurveTo(bowCp1, bowCp1y, hw, bowCp2y, hw, -hh * 0.15)
  ctx.lineTo(hw, hh * 0.6)
  ctx.bezierCurveTo(hw, hh * 0.88, sw, hh, sw, hh)
  ctx.lineTo(-sw, hh)
  ctx.bezierCurveTo(-sw, hh, -hw, hh * 0.88, -hw, hh * 0.6)
  ctx.lineTo(-hw, -hh * 0.15)
  ctx.bezierCurveTo(-hw, bowCp2y, -bowCp1, bowCp1y, 0, -hh)
  ctx.closePath()
  ctx.fill('evenodd')
}

/**
 * VIS-8: a flat silhouette rather than the plain circle this drew from
 * S1.3 to VIS-7. The circle read as unfinished at the ceiling; this keeps
 * everything the circle was chosen for and only changes how it looks.
 *
 * Moving unknown vessels keep this fixed orientation. Stopped unknowns
 * may opt into rotation using their reported heading via drawGlyph.
 *
 * Half-width and half-length both derive from GLYPH_DOT_RADIUS_RATIO *
 * size, the circle's own radius expression, scaled apart by
 * UNKNOWN_ASPECT in opposite directions. Their product is unchanged, so
 * the bounding-box AREA is still exactly the circle's. The extent is not:
 * an elongated hull at constant area is longer and narrower than the
 * square one A7 shipped -- at default settings, 32.92px long by 12.35px
 * wide against 20.16 square. VIS-4's density figures are stated in glyph
 * LENGTH against mean spacing, so they move with it.
 *
 * The bluntest bow hullPath offers and a near-square stern: the shape has
 * to have SOME asymmetry to read as a silhouette rather than a blob, but
 * every degree of it is a heading this type cannot justify, so it is kept
 * to the minimum. No stroke, no internal linework -- hullPath emits one
 * path and one fill, and the internal detail belongs to the per-type
 * wrappers above, not to hullPath itself.
 */
function drawUnknown(
  ctx: CanvasRenderingContext2D,
  size: number,
  canvasWidth: number,
): void {
  const halfExtent = size * GLYPH_DOT_RADIUS_RATIO
  const halfWidth = halfExtent * UNKNOWN_ASPECT
  const halfLength = halfExtent / UNKNOWN_ASPECT

  hullPath(ctx, halfWidth, halfLength, UNKNOWN_BOW_POINTINESS, UNKNOWN_STERN_WIDTH)
  // A11: hullPath leaves the path it filled current, so this strokes the
  // same outline. canvasWidth is taken rather than derived from size --
  // size already has the canvas scaling folded into it and cannot be
  // divided back out without knowing the baseSize.
  strokeOutline(ctx, canvasWidth)
}
