import {
  VesselGlyphSpec,
  VESSEL_COLORS,
  NOTABLE_COLOR,
  DARK_OUTLINE_COLOR,
} from '@wake/shared'

// baseSize is a reference size at 1920px canvas width; every other width
// scales proportionally. Exported so VIS-6's hero glow can size itself
// (0.9x / 0.25x of the same drawn length) off the real glyph code's own
// scaling instead of a second copy of this formula.
export function glyphActualSize(baseSize: number, canvasWidth: number): number {
  return baseSize * (canvasWidth / 1920)
}

// Half-extent of a small glyph as a fraction of its drawn size: the
// radius of a circle, or half the width and half the length of the
// unknown silhouette.
//
// The unknown vessel's circle used this ratio from S1.3 until VIS-8
// replaced it with a silhouette; the silhouette takes the same value as
// hw AND hh, so its bounding box is identical to the circle's and the
// density and overlap behaviour VIS-4 measured is unchanged. VIS-8's
// stopped-vessel dot uses it as a radius. One constant, three uses, no
// second copy of the formula.
export const GLYPH_DOT_RADIUS_RATIO = 0.28

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
// VIS-8 A11: a dark edge on the two shapes that are drawn opaque and
// routinely land on top of each other.
//
// At real density stopped vessels of different types sit within a pixel or
// two of each other -- 31 such pairs in the recorded 31-minute Dover
// capture alone -- and because the non-hero draw loop orders by
// VESSEL_BASE_SIZES descending, the SMALLER type is drawn last, on top.
// Its opaque fill then covers most of the larger one, leaving only a thin
// concentric ring of the first colour: a ferry over a naval leaves 2.10px
// all round and hides 81% of it. That ring is what the human's look saw,
// and with no edge between the two fills it reads as one blob with a halo
// rather than as two vessels.
//
// This does not fix the overlap -- VIS-4 already established that
// clustering survives every glyph size -- it only puts a boundary between
// the two fills so the eye can separate them.
//
// Not the reverted "stroke outline on glyphs" correction: that stroked
// hull INTERNAL detail in the same colour as its own fill, which by
// definition produced no edge contrast. This is a contrasting colour, on
// the outer silhouette, and only on shapes that are drawn flat.
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
// have translated to the vessel's centre and set fillStyle already --
// the same contract hullPath and the drawCargo family already work under.
function dotPath(ctx: CanvasRenderingContext2D, size: number): void {
  const r = size * GLYPH_DOT_RADIUS_RATIO
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.closePath()
  ctx.fill()
}

/**
 * VIS-8: draw a vessel as a filled dot rather than a hull silhouette.
 *
 * A stopped vessel's reported COG is noise -- VIS-3 measured p95 116.8
 * degrees of jitter between consecutive fixes at 0kn against 6.0 degrees
 * above 5kn -- so its hull is rotated to a fresh random bearing on every
 * fix. Where several vessels share a berth that reads as a crumple of
 * hulls pointing every way. A circle is rotation-invariant, so it says
 * "here, heading unknown" instead: the same thing the unknown glyph has
 * always said, in the vessel's own type colour.
 *
 * Deliberately NOT a branch inside drawGlyph -- there is no rotation to
 * apply, so there would be a screenHeadingDeg argument to ignore.
 *
 * @param baseSize - reference size at 1920px canvas width, already
 *   scaled by glyphScale by the caller (never by unknownScale, which is
 *   an unknown-type-only setting).
 */
export function drawDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  baseSize: number,
  color: string,
  canvasWidth: number,
): void {
  const actualSize = glyphActualSize(baseSize, canvasWidth)

  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = color
  ctx.globalAlpha = 1.0
  dotPath(ctx, actualSize)
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
 *   IGNORED for the 'unknown' type, which never rotates -- see the
 *   rotation guard below and drawUnknown's own comment.
 * @param spec    - Vessel glyph specification
 * @param canvasWidth - Current canvas width (for size scaling)
 * @param shadow  - VIS-6 hero glow only. When set, applies shadowBlur/
 *   shadowColor for this draw; ctx.restore() below reverts it (shadowBlur
 *   is 0 on every ctx before this ever runs, so restore's snapshot is the
 *   correct "off" state) -- never passed for a non-hero vessel.
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
  const color = spec.isNotable ? NOTABLE_COLOR : VESSEL_COLORS[spec.type]

  ctx.save()
  ctx.translate(x, y)
  // VIS-8: unknown vessels never rotate, at any speed. Their heading data
  // is the least trustworthy in the feed -- TrueHeading disagrees with COG
  // by up to 151.6 degrees for this population against 15.3 degrees for
  // typed vessels, and COG jitter between consecutive fixes reaches a p95
  // of 116.8 degrees at 0kn. VIS-2's ceiling read test rejected a
  // directional shape for exactly this reason and kept an orientationless
  // one at every speed.
  //
  // The rotate call is skipped outright rather than passed a fixed 0, so
  // there is no rotation term in the emitted call sequence at all. This
  // mattered less when the unknown glyph was a circle (rotationally
  // symmetric, so the rotation was computed and silently discarded -- see
  // CLAUDE.md's S1.6a note); with a silhouette it would be visible.
  if (spec.type !== 'unknown') {
    ctx.rotate((screenHeadingDeg * Math.PI) / 180)
  }
  ctx.fillStyle = color
  ctx.globalAlpha = 1.0
  if (shadow) {
    ctx.shadowBlur = shadow.blur
    ctx.shadowColor = shadow.color
  }

  switch (spec.type) {
    case 'cargo':
      drawCargo(ctx, actualSize)
      break
    case 'tanker':
      drawTanker(ctx, actualSize)
      break
    case 'cruise':
      drawCruise(ctx, actualSize)
      break
    case 'ferry':
      drawFerry(ctx, actualSize)
      break
    case 'tugboat':
      drawTugboat(ctx, actualSize)
      break
    case 'naval':
      drawNaval(ctx, actualSize)
      break
    case 'unknown':
      drawUnknown(ctx, actualSize, canvasWidth)
      break
  }

  ctx.restore()
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
  ctx.fill()
}

function drawCargo(ctx: CanvasRenderingContext2D, size: number): void {
  const hw = size * 0.12, hh = size * 0.50
  hullPath(ctx, hw, hh, 0.85, 0.72)
  // Negative-space detail: container rows + stern superstructure
  ctx.fillStyle = '#000000'
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(-hw * 0.7, -hh * 0.45 + i * hh * 0.28, hw * 1.4, hh * 0.05)
  }
  ctx.fillRect(-hw * 0.8, hh * 0.72, hw * 1.6, hh * 0.09)
}

function drawTanker(ctx: CanvasRenderingContext2D, size: number): void {
  const hw = size * 0.135, hh = size * 0.475
  hullPath(ctx, hw, hh, 0.35, 0.78)
  // Centreline manifold + stern block
  ctx.fillStyle = '#000000'
  ctx.fillRect(-hw * 0.12, -hh * 0.5, hw * 0.24, hh * 1.15)
  ctx.fillRect(-hw * 0.8, hh * 0.70, hw * 1.6, hh * 0.10)
}

function drawCruise(ctx: CanvasRenderingContext2D, size: number): void {
  const hw = size * 0.095, hh = size * 0.55
  hullPath(ctx, hw, hh, 0.90, 0.45)
  // Long twin deck lines
  ctx.fillStyle = '#000000'
  ctx.fillRect(-hw * 0.55, -hh * 0.35, hw * 0.16, hh * 1.25)
  ctx.fillRect(hw * 0.39, -hh * 0.35, hw * 0.16, hh * 1.25)
}

function drawFerry(ctx: CanvasRenderingContext2D, size: number): void {
  const hw = size * 0.15, hh = size * 0.40
  hullPath(ctx, hw, hh, 0.55, 0.85)
  // Wide vehicle-deck band
  ctx.fillStyle = '#000000'
  ctx.fillRect(-hw * 0.85, -hh * 0.05, hw * 1.7, hh * 0.16)
}

function drawTugboat(ctx: CanvasRenderingContext2D, size: number): void {
  const hw = size * 0.21, hh = size * 0.31
  hullPath(ctx, hw, hh, 0.45, 0.70)
  // Aft towing deck
  ctx.fillStyle = '#000000'
  ctx.fillRect(-hw * 0.45, hh * 0.25, hw * 0.9, hh * 0.28)
}

function drawNaval(ctx: CanvasRenderingContext2D, size: number): void {
  const hw = size * 0.085, hh = size * 0.575
  hullPath(ctx, hw, hh, 1.0, 0.35)
  // Thin centreline spine
  ctx.fillStyle = '#000000'
  ctx.fillRect(-hw * 0.18, -hh * 0.25, hw * 0.36, hh * 1.0)
}

/**
 * VIS-8: a flat silhouette rather than the plain circle this drew from
 * S1.3 to VIS-7. The circle read as unfinished at the ceiling; this keeps
 * everything the circle was chosen for and only changes how it looks.
 *
 * Fixed orientation at every speed -- drawGlyph skips its rotate for this
 * type, and nothing here reads a heading, a course or a speed. Gating the
 * shape on sogKn would reintroduce the stopped/moving distinction VIS-2
 * deliberately ruled out for unknown vessels.
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
function drawUnknown(ctx: CanvasRenderingContext2D, size: number, canvasWidth: number): void {
  const halfExtent = size * GLYPH_DOT_RADIUS_RATIO
  hullPath(
    ctx,
    halfExtent * UNKNOWN_ASPECT,
    halfExtent / UNKNOWN_ASPECT,
    UNKNOWN_BOW_POINTINESS,
    UNKNOWN_STERN_WIDTH,
  )
  // A11: hullPath leaves the path it filled current, so this strokes the
  // same outline. canvasWidth is taken rather than derived from size --
  // size already has the canvas scaling folded into it and cannot be
  // divided back out without knowing the baseSize.
  strokeOutline(ctx, canvasWidth)
}
