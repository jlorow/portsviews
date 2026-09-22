import { pxPerNm } from '@wake/shared'

const RING_NM = [5, 10, 15, 20] as const
const RING_COLOR = '#C8D8F0'
const RING_ALPHA = 0.12

/**
 * Faint, unlabelled range rings centred on the view (VIS-6), at fixed
 * nautical-mile distances regardless of vessel count. Radius in px comes
 * from shared/src/projection.ts's own pxPerNm -- the same scale
 * mapProject uses for every vessel and trail -- never a second copy of
 * that formula.
 */
export function drawRangeRings(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  radiusNm: number,
): void {
  const scale = canvasWidth / 1920
  const px = pxPerNm(canvasWidth, canvasHeight, radiusNm)
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2

  ctx.save()
  ctx.strokeStyle = RING_COLOR
  ctx.globalAlpha = RING_ALPHA
  ctx.lineWidth = 1 * scale
  ctx.setLineDash([6 * scale, 10 * scale])

  for (const ringNm of RING_NM) {
    ctx.beginPath()
    ctx.arc(cx, cy, ringNm * px, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.restore()
}
