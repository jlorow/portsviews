import type { BasemapPlace, ProjectionConfig } from '@wake/shared'
import { ATTRIBUTION_TEXT, DARK_OUTLINE_COLOR, mapProject } from '@wake/shared'
import { estimateTextWidth } from './labels'

// VIS-9 — every piece of basemap text, drawn on Wake's own 2D canvas.
//
// It is not in the MapLibre style, and that is the whole point. The
// ceiling projector flips the image; VIS-9 delivers that flip as a CSS
// transform on the map container, which flips the map's own labels with
// it and shows every town name backwards. Wake's canvas carries no such
// transform — mapProject flips COORDINATES and the text is then drawn
// unflipped at the flipped position, exactly as VIS-7's hero labels and
// area title already do. So these read correctly from the bed in both
// mirrorX states, and MapLibre never has to render a glyph.
//
// Styling follows labels.ts's AMBIENT CHROME convention, not its hero
// label convention: 16px * s Inter Light in #C8D8F0, the same values
// drawAreaTitle uses for "LIVE AIS" and legend.ts uses for every row. A
// town is orientation, like the area title — not an identified object,
// like a hero.

const FONT_PX = 16
const TEXT_COLOR = '#C8D8F0'
const PLACE_ALPHA = 0.5
const PLACE_LETTER_SPACING = 2

// labels.ts's shadow treatment, by the same numbers (its LABEL_SHADOW_*
// constants are module-private there). Place names sit ON the land fill
// rather than over black, so they need the edge for the same reason a
// hero label crossing a hull does.
const SHADOW_ALPHA = 0.6
const SHADOW_OFFSET = 1

// The attribution's own corner. Wake owns bottom-left (area title) and
// bottom-right (legend and the connection dot); ?tune=1 owns top-left.
// Top-right is the one corner nothing else uses.
const ATTRIBUTION_MARGIN = 48
const ATTRIBUTION_ALPHA = 0.5

export interface ProjectedPlace {
  name: string
  x: number
  y: number
}

/**
 * Pure: which places are on screen and where. A place outside the view
 * radius projects to null and is dropped — Boulogne-sur-Mer is 23.25 nm
 * from the Dover centre and so is culled at every landscape window size,
 * which is a property of the list, not a bug.
 *
 * Positions come from mapProject itself, so place names move with the
 * mirror exactly like vessels do; there is no second projection here.
 */
export function projectPlaces(
  places: readonly BasemapPlace[],
  centerLat: number,
  centerLon: number,
  radiusNm: number,
  config: ProjectionConfig,
  canvasWidth: number,
  canvasHeight: number,
): ProjectedPlace[] {
  const out: ProjectedPlace[] = []
  for (const place of places) {
    const projected = mapProject(
      place.lat,
      place.lon,
      centerLat,
      centerLon,
      radiusNm,
      config,
      canvasWidth,
      canvasHeight,
    )
    if (projected === null) continue
    out.push({ name: place.name.toUpperCase(), x: projected.x, y: projected.y })
  }
  return out
}

function drawShadowedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  s: number,
  color: string,
  alpha: number,
): void {
  const offset = SHADOW_OFFSET * s
  ctx.fillStyle = DARK_OUTLINE_COLOR
  ctx.globalAlpha = SHADOW_ALPHA
  ctx.fillText(text, x + offset, y + offset)

  ctx.fillStyle = color
  ctx.globalAlpha = alpha
  ctx.fillText(text, x, y)
}

/**
 * Town names, centred on their own projected position. Drawn by the caller
 * BEFORE renderFrame, so every trail, glyph, glow and label sits on top of
 * them — a place name is the bottom of the drawn stack, immediately above
 * the basemap itself.
 *
 * An empty list draws nothing at all (0 fillText calls).
 */
export function drawPlaceNames(
  ctx: CanvasRenderingContext2D,
  places: readonly BasemapPlace[],
  centerLat: number,
  centerLon: number,
  radiusNm: number,
  config: ProjectionConfig,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const projected = projectPlaces(
    places,
    centerLat,
    centerLon,
    radiusNm,
    config,
    canvasWidth,
    canvasHeight,
  )
  if (projected.length === 0) return

  const s = canvasWidth / 1920
  const fontPx = FONT_PX * s

  ctx.save()
  ctx.textAlign = 'center'
  ctx.font = `300 ${fontPx}px Inter, sans-serif`
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${PLACE_LETTER_SPACING * s}px`

  for (const place of projected) {
    drawShadowedText(ctx, place.name, place.x, place.y, s, TEXT_COLOR, PLACE_ALPHA)
  }

  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px'
  ctx.restore()
}

/**
 * The box the attribution occupies, in canvas pixels. Exported so the test
 * can check it against the area title's and the legend's own corners
 * rather than eyeballing three sets of margins.
 */
export function attributionBox(
  canvasWidth: number,
  _canvasHeight: number,
): { x: number; y: number; width: number; height: number } {
  const s = canvasWidth / 1920
  const margin = ATTRIBUTION_MARGIN * s
  const fontPx = FONT_PX * s
  const width = estimateTextWidth(ATTRIBUTION_TEXT, fontPx)
  const height = fontPx * 1.15
  return {
    x: canvasWidth - margin - width,
    y: margin - fontPx,
    width,
    height,
  }
}

/**
 * The OpenStreetMap credit, top-right, drawn by the caller AFTER
 * renderFrame so nothing can paint over it.
 *
 * Text, not a link: this display is fixed and non-interactive, which puts
 * it under the OSM Foundation's printed/non-interactive case, where the
 * copyright URL has to be printed rather than hyperlinked. It is never
 * rotated or mirrored — it is drawn straight onto the unflipped canvas —
 * so it is legible in both mirrorX states by construction, the same
 * property VIS-7 relies on for hero labels.
 *
 * Alpha and font are the ambient-chrome values "LIVE AIS" and the legend
 * already use, deliberately not dimmer: legibility is a licence
 * requirement here, not a taste question.
 */
export function drawAttribution(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  _canvasHeight: number,
): void {
  const s = canvasWidth / 1920
  const margin = ATTRIBUTION_MARGIN * s
  const fontPx = FONT_PX * s

  ctx.save()
  ctx.textAlign = 'right'
  ctx.font = `300 ${fontPx}px Inter, sans-serif`
  drawShadowedText(ctx, ATTRIBUTION_TEXT, canvasWidth - margin, margin, s, TEXT_COLOR, ATTRIBUTION_ALPHA)
  ctx.restore()
}
