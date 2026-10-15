import type { VesselType } from '@wake/shared'
import { STOPPED_COLOR, VESSEL_COLORS } from '@wake/shared'
import { estimateTextWidth, typeLabel } from './labels'

// VIS-8: a faint bottom-right key to the palette. Ferry is purple and
// nothing on screen said so.
//
// Row order is fixed, not discovery order or count order, so the block
// does not reshuffle itself as vessels come and go. 'cruise' is absent
// deliberately: no AIS ship-type code maps to it (Correction 8), so it
// cannot be reached from live data, and inventing a row for it would
// advertise a category the feed can never produce. Should a cruise
// vessel ever become reachable, it needs adding here as well as to the
// mapping -- it is counted in the header total either way.
export const LEGEND_ORDER: VesselType[] = ['cargo', 'tanker', 'ferry', 'naval', 'tugboat', 'unknown']

// The area title's own conventions, mirrored from the opposite corner
// (labels.ts's drawAreaTitle): 48*s from both edges, 16px*s Inter Light,
// #C8D8F0 at alpha 0.5. The legend reads as the same ambient layer as
// "LIVE AIS", not as a separate piece of UI.
const MARGIN = 48
const ROW_SPACING = 24
const FONT_PX = 16
const TEXT_COLOR = '#C8D8F0'
const TEXT_ALPHA = 0.5

// The swatch. 5*s radius against a 16*s text is close to the text's own
// cap height, so the row reads as one object rather than a dot with a
// caption.
const DOT_RADIUS = 5
const DOT_GAP = 8
const DOT_ALPHA = 0.85

// #C8D8F0 at 0.85 would sit close to a real unknown glyph's own
// brightness -- the exact problem that made unknown vessels outshine
// heroes in VIS-7. The "Other" swatch is dimmed to match its text.
const OTHER_DOT_ALPHA = 0.5

export interface LegendRow {
  type: VesselType
  label: string
  count: number
}

export function legendLabel(type: VesselType): string {
  return type === 'unknown' ? 'Other' : typeLabel(type)
}

/**
 * Pure: the rows a given set of counts produces, in LEGEND_ORDER, with
 * absent and zero-count types omitted entirely. A type with no vessels on
 * screen right now is not a category worth a line of a ceiling.
 */
export function buildLegendRows(counts: Partial<Record<VesselType, number>>): LegendRow[] {
  const rows: LegendRow[] = []
  for (const type of LEGEND_ORDER) {
    const count = counts[type] ?? 0
    if (count <= 0) continue
    rows.push({ type, label: legendLabel(type), count })
  }
  return rows
}

/**
 * Draws the legend bottom-right. Drawn last, after the area title
 * (caller's responsibility). legendEnabled is the caller's own gate --
 * this function draws type rows and, when enabled, an optional stopped
 * count row.
 *
 * Rows read top-to-bottom in LEGEND_ORDER, and the block grows upward
 * from the bottom margin as rows appear, so the lowest row stays pinned
 * at a fixed distance from the bottom edge.
 *
 * The block has ONE left edge, computed from the widest row, and every
 * row's swatch and text start there. Anchoring each row to the right
 * margin independently (as this first shipped) left a ragged left edge
 * and put each swatch at a different x, so the dots did not read as a
 * column -- the human's look caught it.
 *
 * That left edge is placed so the widest row's right edge lands exactly
 * where the old per-row right anchor put it, so the block's footprint
 * and its distance from both canvas edges are unchanged; only the
 * internal alignment moved.
 *
 * Row width comes from labels.ts's estimate -- there is still no
 * ctx.measureText call anywhere in this codebase. The trade is
 * deliberate: the left edge (the one being fixed) is now exact for every
 * row, and the right edge, which nothing lines up against, absorbs the
 * estimate's error instead.
 */
export function drawLegend(
  ctx: CanvasRenderingContext2D,
  rows: LegendRow[],
  canvasWidth: number,
  canvasHeight: number,
  stoppedCount = 0,
  stoppedAsDot = true,
): void {
  const showStopped = stoppedAsDot && stoppedCount > 0
  if (rows.length === 0 && !showStopped) return

  const s = canvasWidth / 1920
  const margin = MARGIN * s
  const fontPx = FONT_PX * s
  const rowSpacing = ROW_SPACING * s
  const dotRadius = DOT_RADIUS * s
  const dotGap = DOT_GAP * s

  const rightX = canvasWidth - margin
  const bottomBaselineY = canvasHeight - margin

  const displayRows = rows.map((row) => ({
    text: `${row.label} ${row.count}`,
    color: VESSEL_COLORS[row.type],
    alpha: row.type === 'unknown' ? OTHER_DOT_ALPHA : DOT_ALPHA,
  }))
  if (showStopped) {
    displayRows.push({
      text: `Stopped ${stoppedCount}`,
      color: STOPPED_COLOR,
      alpha: DOT_ALPHA,
    })
  }
  const texts = displayRows.map((row) => row.text)
  const rowCount = displayRows.length
  const widestTextWidth = Math.max(...texts.map((text) => estimateTextWidth(text, fontPx)))

  // One left edge for the whole block, set by the widest row. Solving
  // "widest row's right edge === rightX" for the left edge gives this.
  const blockLeftX = rightX - widestTextWidth - dotGap - dotRadius * 2
  const textX = blockLeftX + dotRadius * 2 + dotGap
  const dotCx = blockLeftX + dotRadius

  ctx.save()

  displayRows.forEach((row, index) => {
    const baselineY = bottomBaselineY - (rowCount - 1 - index) * rowSpacing
    const text = texts[index]

    // Roughly the text's own optical centre: a baseline sits at the
    // bottom of the glyphs, so the swatch lifts by about a third of the
    // font size to line up with them.
    const dotCy = baselineY - fontPx * 0.32

    ctx.beginPath()
    ctx.arc(dotCx, dotCy, dotRadius, 0, Math.PI * 2)
    ctx.closePath()
    ctx.fillStyle = row.color
    ctx.globalAlpha = row.alpha
    ctx.fill()

    ctx.textAlign = 'left'
    ctx.font = `300 ${fontPx}px Inter, sans-serif`
    ctx.fillStyle = TEXT_COLOR
    ctx.globalAlpha = TEXT_ALPHA
    ctx.fillText(text, textX, baselineY)
  })

  ctx.restore()
}
