import { pxPerNm } from '@wake/shared'

const SWEEP_COLOR_RGB = '200,216,240' // #C8D8F0
const WEDGE_SPAN_DEG = 40

/**
 * Beam angle in degrees, clockwise from screen-up -- same convention as
 * shared/src/projection.ts's screenHeadingDeg and ctx.rotate. Linear in
 * time, one full rotation per periodSec.
 */
export function sweepAngleDeg(nowMs: number, periodSec: number): number {
  const periodMs = periodSec * 1000
  const phase = nowMs % periodMs
  return (phase / periodMs) * 360
}

// Converts this module's "clockwise from screen-up" angle to
// createConicGradient's "clockwise from the positive x-axis" angle.
// screen-up (0) is 90 degrees counter-clockwise from screen-right (the
// conic gradient's zero), i.e. conic = ours - 90.
function toConicRad(deg: number): number {
  return ((deg - 90) * Math.PI) / 180
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * Draws the rotating radar sweep: a faint 40-degree wedge trailing the
 * leading edge, clipped to the view circle, plus the leading edge itself
 * as a thin line. Drawn after range rings and before trails (caller's
 * responsibility). No-op when sweepPeriodSec <= 0 -- the caller's own
 * gate, checked here too so this function is safe to call unconditionally.
 */
export function drawSweep(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  radiusNm: number,
  nowMs: number,
  sweepPeriodSec: number,
): void {
  if (sweepPeriodSec <= 0) return

  const s = canvasWidth / 1920
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2
  const r = pxPerNm(canvasWidth, canvasHeight, radiusNm) * radiusNm

  const leadingDeg = sweepAngleDeg(nowMs, sweepPeriodSec)
  const trailingConicFraction = 0 // trailing edge of the wedge, alpha 0
  const leadingConicFraction = WEDGE_SPAN_DEG / 360 // leading edge, alpha 0.14

  const gradient = ctx.createConicGradient(toConicRad(leadingDeg - WEDGE_SPAN_DEG), cx, cy)
  gradient.addColorStop(trailingConicFraction, `rgba(${SWEEP_COLOR_RGB},0)`)
  gradient.addColorStop(leadingConicFraction, `rgba(${SWEEP_COLOR_RGB},0.14)`)
  gradient.addColorStop(Math.min(leadingConicFraction + 0.001, 1), `rgba(${SWEEP_COLOR_RGB},0)`)

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.clip()
  ctx.fillStyle = gradient
  ctx.globalAlpha = 1.0
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)
  ctx.restore()

  const leadingRad = toRad(leadingDeg)
  ctx.save()
  ctx.strokeStyle = `rgba(${SWEEP_COLOR_RGB},0.35)`
  ctx.globalAlpha = 1.0
  ctx.lineWidth = 1.5 * s
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + r * Math.sin(leadingRad), cy - r * Math.cos(leadingRad))
  ctx.stroke()
  ctx.restore()
}

/**
 * True if the beam swept across bearingDeg while moving from
 * prevAngleDeg to currAngleDeg (clockwise, handling the 360->0 wrap).
 * prevAngleDeg === null (no previous frame yet) never reveals by
 * crossing -- only the "within 1px of centre" case in the caller reveals
 * on a vessel's very first frame.
 */
export function beamCrossed(
  prevAngleDeg: number | null,
  currAngleDeg: number,
  bearingDeg: number,
): boolean {
  if (prevAngleDeg === null) return false
  if (prevAngleDeg === currAngleDeg) return false

  if (prevAngleDeg < currAngleDeg) {
    return bearingDeg > prevAngleDeg && bearingDeg <= currAngleDeg
  }
  // Wrapped past 360 -> 0.
  return bearingDeg > prevAngleDeg || bearingDeg <= currAngleDeg
}
