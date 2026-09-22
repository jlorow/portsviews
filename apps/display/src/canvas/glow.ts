function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

/**
 * Hero-only radial glow (VIS-6), drawn before the hero's own glyph so the
 * glyph's fill sits on top. Centred on the vessel; type colour fading
 * from alpha 0.35 at the centre to alpha 0 at 0.9 * glyphLength, where
 * glyphLength is the same drawn length glyphs.ts's glyphActualSize
 * computes for that hero -- never a second size formula.
 */
export function drawHeroGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  glyphLength: number,
): void {
  const { r, g, b } = hexToRgb(color)
  const radius = glyphLength * 0.9

  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
  gradient.addColorStop(0, `rgba(${r},${g},${b},0.35)`)
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`)

  ctx.save()
  ctx.fillStyle = gradient
  ctx.globalAlpha = 1.0
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}
