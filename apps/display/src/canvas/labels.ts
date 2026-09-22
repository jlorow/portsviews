import type { VesselType } from '@wake/shared'
import { DARK_OUTLINE_COLOR } from '@wake/shared'

// VIS-7: hero-only labels (name/type/speed) and the faint area title.
// Reuses glyphs.ts's own glyphActualSize for "drawn length" (the same
// convention glow.ts already established for hero glow radius) -- never
// a second size formula.

const TYPE_LABELS: Record<Exclude<VesselType, 'unknown'>, string> = {
  cargo: 'Cargo',
  tanker: 'Tanker',
  cruise: 'Cruise',
  ferry: 'Ferry',
  tugboat: 'Tug',
  naval: 'Naval',
}

/**
 * Cleans a raw ShipName for display: strips '@' (AIS pads unused fixed-
 * width characters with it in some captures), trims, and collapses
 * internal whitespace runs. Empty after cleaning -> null, the caller's
 * signal to fall back to the type label.
 */
export function formatShipName(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null
  const cleaned = raw.replace(/@/g, '').trim().replace(/\s+/g, ' ')
  return cleaned === '' ? null : cleaned
}

export function typeLabel(type: VesselType): string {
  return type === 'unknown' ? 'Unknown' : TYPE_LABELS[type]
}

export function heroLabelLines(
  shipName: string | undefined,
  type: VesselType,
  sogKn: number,
): [string, string] {
  const name = formatShipName(shipName)
  const line1 = name ?? typeLabel(type)
  const line2 = `${typeLabel(type)} · ${sogKn.toFixed(1)} kn`
  return [line1, line2]
}

// Rough monospace-ish width estimate -- there is no ctx.measureText call
// anywhere in this codebase yet, and placeLabels must stay a pure
// geometry function testable with no canvas at all. Only used to size
// the label's own collision box, never to lay out individual glyphs, so
// an approximation is enough for placement purposes.
const AVG_CHAR_WIDTH_FACTOR = 0.58

// Exported for VIS-8's legend, which needs the same estimate to place a
// swatch beside right-aligned text. Still the only width estimate in the
// codebase -- legend.ts calls this rather than carrying a second copy.
export function estimateTextWidth(text: string, fontPx: number): number {
  return text.length * fontPx * AVG_CHAR_WIDTH_FACTOR
}

export interface LabelBoxSize {
  width: number
  height: number
}

/**
 * Box size for one hero's two-line label at a given scale (s =
 * canvasWidth / 1920) and labelSize. Padding included on all sides.
 */
export function measureLabelBox(
  line1: string,
  line2: string,
  labelSize: 'S' | 'M' | 'L',
  s: number,
): LabelBoxSize {
  const font1 = LABEL_FONT_PX[labelSize] * s
  const font2 = font1 * 0.7
  const padding = 8 * s
  const lineGap = 4 * s
  const width = Math.max(estimateTextWidth(line1, font1), estimateTextWidth(line2, font2)) + padding * 2
  const height = font1 * 1.15 + lineGap + font2 * 1.15 + padding * 2
  return { width, height }
}

export const LABEL_FONT_PX: Record<'S' | 'M' | 'L', number> = { S: 22, M: 30, L: 38 }

// VIS-8: hero labels cross ordinary ships. In the merged VIS-7 result a
// hero's name sat directly on top of another vessel's hull, and placement
// cannot fix it -- placeLabels already dodges other labels and every
// hero's own bounding circle, but non-hero vessels are not, and cannot
// reasonably be, in that collision set. This is a contrast fix instead:
// each line draws once in a near-black behind itself, offset by 1*s, so
// the text keeps an edge whatever it happens to be sitting on.
//
// VIS-8 A11 moved this value to @wake/shared's DARK_OUTLINE_COLOR, where
// the stopped-vessel dot and the unknown silhouette now share it. It is
// slightly blue-black rather than pure black, which reads as a shadow
// rather than as a second outline.
const LABEL_SHADOW_ALPHA = 0.6
const LABEL_SHADOW_OFFSET = 1

/**
 * One label line: its shadow first, then the line itself on top. Style is
 * set explicitly on both draws rather than relying on save/restore, so
 * the real text's colour and alpha are never whatever the shadow left
 * behind.
 */
function drawShadowedLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  s: number,
  font: string,
  color: string,
  alpha: number,
): void {
  const offset = LABEL_SHADOW_OFFSET * s

  ctx.font = font
  ctx.fillStyle = DARK_OUTLINE_COLOR
  ctx.globalAlpha = LABEL_SHADOW_ALPHA
  ctx.fillText(text, x + offset, y + offset)

  ctx.fillStyle = color
  ctx.globalAlpha = alpha
  ctx.fillText(text, x, y)
}

export type LabelCorner = 'NE' | 'NW' | 'SE' | 'SW'

export interface LabelBoxSpec {
  mmsi: string
  x: number // hero centre, canvas px
  y: number
  length: number // L, the hero's drawn length (glyphActualSize output)
  box: LabelBoxSize
}

export interface PlacedLabel {
  mmsi: string
  corner: LabelCorner
  boxX: number // top-left
  boxY: number
  boxWidth: number
  boxHeight: number
  anchorX: number // box corner nearest the hero centre -- leader line endpoint
  anchorY: number
}

const CORNER_ORDER: LabelCorner[] = ['NE', 'NW', 'SE', 'SW']
const DIAG = Math.SQRT1_2

function nearestCornerPoint(x: number, y: number, offset: number, corner: LabelCorner): { x: number; y: number } {
  switch (corner) {
    case 'NE':
      return { x: x + offset * DIAG, y: y - offset * DIAG }
    case 'NW':
      return { x: x - offset * DIAG, y: y - offset * DIAG }
    case 'SE':
      return { x: x + offset * DIAG, y: y + offset * DIAG }
    case 'SW':
      return { x: x - offset * DIAG, y: y + offset * DIAG }
  }
}

function boxRectFor(
  corner: LabelCorner,
  nearest: { x: number; y: number },
  box: LabelBoxSize,
): { x: number; y: number; w: number; h: number } {
  switch (corner) {
    case 'NE':
      return { x: nearest.x, y: nearest.y - box.height, w: box.width, h: box.height }
    case 'NW':
      return { x: nearest.x - box.width, y: nearest.y - box.height, w: box.width, h: box.height }
    case 'SE':
      return { x: nearest.x, y: nearest.y, w: box.width, h: box.height }
    case 'SW':
      return { x: nearest.x - box.width, y: nearest.y, w: box.width, h: box.height }
  }
}

function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function rectIntersectsCircle(
  rect: { x: number; y: number; w: number; h: number },
  cx: number,
  cy: number,
  r: number,
): boolean {
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w))
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h))
  const dx = cx - closestX
  const dy = cy - closestY
  return dx * dx + dy * dy < r * r
}

/**
 * Pure placement geometry (CONTEXT/A2's signed-off rule): for each hero
 * in order, try NE/NW/SE/SW; the offset from the hero centre to the
 * box's nearest corner is 0.6*length + 12*s. First corner whose box
 * fits inside the canvas (16*s margin), avoids every earlier box, and
 * avoids every hero's own bounding circle (radius length/2) wins. No
 * corner fits -> NE, unconditionally.
 */
export function placeLabels(
  heroes: LabelBoxSpec[],
  canvasWidth: number,
  canvasHeight: number,
): PlacedLabel[] {
  const s = canvasWidth / 1920
  const margin = 16 * s
  const placed: PlacedLabel[] = []
  const placedRects: { x: number; y: number; w: number; h: number }[] = []

  for (const hero of heroes) {
    const offset = 0.6 * hero.length + 12 * s
    let chosen: { corner: LabelCorner; rect: { x: number; y: number; w: number; h: number }; nearest: { x: number; y: number } } | null = null

    for (const corner of CORNER_ORDER) {
      const nearest = nearestCornerPoint(hero.x, hero.y, offset, corner)
      const rect = boxRectFor(corner, nearest, hero.box)

      const insideCanvas =
        rect.x >= margin &&
        rect.y >= margin &&
        rect.x + rect.w <= canvasWidth - margin &&
        rect.y + rect.h <= canvasHeight - margin
      if (!insideCanvas) continue

      const overlapsEarlier = placedRects.some((r) => rectsIntersect(rect, r))
      if (overlapsEarlier) continue

      const overlapsHero = heroes.some((h) => rectIntersectsCircle(rect, h.x, h.y, h.length / 2))
      if (overlapsHero) continue

      chosen = { corner, rect, nearest }
      break
    }

    if (chosen === null) {
      const corner: LabelCorner = 'NE'
      const nearest = nearestCornerPoint(hero.x, hero.y, offset, corner)
      const rect = boxRectFor(corner, nearest, hero.box)
      chosen = { corner, rect, nearest }
    }

    placedRects.push(chosen.rect)
    placed.push({
      mmsi: hero.mmsi,
      corner: chosen.corner,
      boxX: chosen.rect.x,
      boxY: chosen.rect.y,
      boxWidth: chosen.rect.w,
      boxHeight: chosen.rect.h,
      anchorX: chosen.nearest.x,
      anchorY: chosen.nearest.y,
    })
  }

  return placed
}

export interface HeroLabelInput {
  mmsi: string
  x: number
  y: number
  length: number
  shipName: string | undefined
  vesselType: VesselType
  sogKn: number
  typeColor: string
}

/**
 * Draws every hero's two-line label plus its leader line. labelSize
 * 'off' draws nothing at all (0 fillText calls). Labels draw after hero
 * glyphs (caller's responsibility to call this last); text is never
 * rotated or mirrored -- drawn at the already-projected canvas position
 * with no further transform.
 */
export function drawHeroLabels(
  ctx: CanvasRenderingContext2D,
  heroes: HeroLabelInput[],
  canvasWidth: number,
  canvasHeight: number,
  labelSize: 'off' | 'S' | 'M' | 'L',
): void {
  if (labelSize === 'off' || heroes.length === 0) return

  const s = canvasWidth / 1920
  const font1Px = LABEL_FONT_PX[labelSize] * s
  const font2Px = font1Px * 0.7
  const padding = 8 * s
  const lineGap = 4 * s

  const specs: LabelBoxSpec[] = heroes.map((h) => {
    const [line1, line2] = heroLabelLines(h.shipName, h.vesselType, h.sogKn)
    return {
      mmsi: h.mmsi,
      x: h.x,
      y: h.y,
      length: h.length,
      box: measureLabelBox(line1, line2, labelSize, s),
    }
  })

  const placed = placeLabels(specs, canvasWidth, canvasHeight)
  const byMmsi = new Map(heroes.map((h) => [h.mmsi, h] as const))

  for (const label of placed) {
    const hero = byMmsi.get(label.mmsi)
    if (!hero) continue
    const [line1, line2] = heroLabelLines(hero.shipName, hero.vesselType, hero.sogKn)

    ctx.save()
    ctx.strokeStyle = hero.typeColor
    ctx.globalAlpha = 0.6
    ctx.lineWidth = 1 * s
    ctx.beginPath()
    ctx.moveTo(hero.x, hero.y)
    ctx.lineTo(label.anchorX, label.anchorY)
    ctx.stroke()
    ctx.restore()

    ctx.save()
    ctx.textAlign = 'left'

    // Inter (self-hosted, main.tsx): line 1 is the identifier (ship name
    // or type) -- Bold. Line 2 is metadata (type + speed) -- Light.
    // VIS-8: each line draws over its own shadow; positions, fonts,
    // colours and alphas are otherwise exactly as VIS-7 set them.
    drawShadowedLine(
      ctx,
      line1,
      label.boxX + padding,
      label.boxY + padding + font1Px,
      s,
      `700 ${font1Px}px Inter, sans-serif`,
      '#E8EEF8',
      0.95,
    )

    drawShadowedLine(
      ctx,
      line2,
      label.boxX + padding,
      label.boxY + padding + font1Px * 1.15 + lineGap + font2Px,
      s,
      `300 ${font2Px}px Inter, sans-serif`,
      hero.typeColor,
      1.0,
    )

    ctx.restore()
  }
}

/**
 * VIS-8: the live vessel count rides the existing "LIVE AIS" run rather
 * than becoming a second text object, so the title block's layout is
 * unchanged -- textAlign is already 'left' and the run simply grows
 * rightward from the same x.
 *
 * The count is of revealed vessels only (the caller's own basis), so it
 * matches what is actually on screen while the sweep is still working
 * round for the first time.
 */
export function liveAisText(vesselCount: number): string {
  return `LIVE AIS · ${vesselCount} VESSELS`
}

/**
 * Faint area title, bottom-left. Drawn last (caller's responsibility).
 * areaTitleEnabled is the caller's own gate -- this function always
 * draws when called.
 */
export function drawAreaTitle(
  ctx: CanvasRenderingContext2D,
  displayName: string,
  canvasWidth: number,
  canvasHeight: number,
  vesselCount: number,
): void {
  const s = canvasWidth / 1920
  const margin = 48 * s
  const titleFontPx = 44 * s
  const subFontPx = 16 * s
  const gap = 10 * s

  ctx.save()
  ctx.textAlign = 'left'

  const titleY = canvasHeight - margin
  const subY = titleY - titleFontPx - gap

  // Inter (self-hosted, main.tsx): "LIVE AIS" is metadata -- Light. The
  // area name is the view's identifier -- Medium.
  ctx.font = `300 ${subFontPx}px Inter, sans-serif`
  ctx.fillStyle = '#C8D8F0'
  ctx.globalAlpha = 0.5
  ctx.fillText(liveAisText(vesselCount), margin, subY)

  ctx.font = `500 ${titleFontPx}px Inter, sans-serif`
  ctx.fillStyle = '#C8D8F0'
  ctx.globalAlpha = 0.35
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${8 * s}px`
  ctx.fillText(displayName, margin, titleY)
  ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px'

  ctx.restore()
}
