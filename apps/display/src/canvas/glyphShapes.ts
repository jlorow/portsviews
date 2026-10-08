import type { VesselType } from '@wake/shared'

export const TIER2_MIN_PX = 60
export const TIER3_MIN_PX = 100

const TONE_DARK_MIX = 0.55
const TONE_LIGHT_MIX = 0.28
const BACKGROUND = '#05070A'

type TypedVesselType = Exclude<VesselType, 'unknown'>
type GlyphTier = 1 | 2 | 3

export interface TypedGlyphShape {
  hull: Path2D
  dark: Path2D
  light: Path2D
  cutout: Path2D
  tier: GlyphTier
}

const BEAM_RATIOS: Record<TypedVesselType, number> = {
  cargo: 4.5,
  tanker: 3.7,
  cruise: 5.3,
  ferry: 2.7,
  tugboat: 2.7,
  naval: 7.8,
}

const HALF_LENGTH_RATIOS: Record<TypedVesselType, number> = {
  cargo: 0.5,
  tanker: 0.475,
  cruise: 0.55,
  ferry: 0.4,
  tugboat: 0.31,
  naval: 0.575,
}

const HULL_MAX_WIDTH_RATIOS: Record<TypedVesselType, number> = {
  cargo: 1,
  tanker: 1,
  cruise: 1,
  ferry: 1,
  tugboat: 1,
  naval: 0.67,
}

const shapes = new Map<TypedVesselType, Map<GlyphTier, TypedGlyphShape>>()

export function tierFor(drawnLengthPx: number): GlyphTier {
  if (drawnLengthPx >= TIER3_MIN_PX) return 3
  if (drawnLengthPx >= TIER2_MIN_PX) return 2
  return 1
}

export function getTypedGlyphShape(type: TypedVesselType, tier: GlyphTier): TypedGlyphShape {
  let byTier = shapes.get(type)
  if (byTier === undefined) {
    byTier = new Map()
    shapes.set(type, byTier)
  }

  let shape = byTier.get(tier)
  if (shape === undefined) {
    const hull = makeHull(type)
    const details = makeRingAndDetails(type, tier, hull)
    shape = { hull, ...details, tier }
    byTier.set(tier, shape)
  }
  return shape
}

export function typedHalfLengthRatio(type: TypedVesselType): number {
  return HALF_LENGTH_RATIOS[type]
}

export function typedHalfWidthRatio(type: TypedVesselType): number {
  return beamFor(type) * HALF_LENGTH_RATIOS[type] * HULL_MAX_WIDTH_RATIOS[type]
}

export function mixedGlyphColors(color: string): { dark: string; light: string } {
  let cached = mixedColors.get(color)
  if (cached === undefined) {
    cached = {
      dark: mix(color, BACKGROUND, TONE_DARK_MIX),
      light: mix(color, '#FFFFFF', TONE_LIGHT_MIX),
    }
    mixedColors.set(color, cached)
  }
  return cached
}

const mixedColors = new Map<string, { dark: string; light: string }>()

function beamFor(type: TypedVesselType): number {
  const sheetBeam = 1 / BEAM_RATIOS[type]
  const currentTugBeam = 0.21 / 0.31
  if (type === 'tugboat' && sheetBeam < currentTugBeam * 0.55) return currentTugBeam
  return Math.min(1 / 2.7, Math.max(1 / 7.8, sheetBeam))
}

function makePath(build: (path: Path2D) => void): Path2D {
  const path = new Path2D()
  build(path)
  return path
}

function addRect(path: Path2D, x: number, y: number, width: number, height: number): void {
  path.rect(x, y, width, height)
  path.closePath()
}

function addRoundRect(path: Path2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2)
  path.moveTo(x + r, y)
  path.lineTo(x + width - r, y)
  path.quadraticCurveTo(x + width, y, x + width, y + r)
  path.lineTo(x + width, y + height - r)
  path.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  path.lineTo(x + r, y + height)
  path.quadraticCurveTo(x, y + height, x, y + height - r)
  path.lineTo(x, y + r)
  path.quadraticCurveTo(x, y, x + r, y)
  path.closePath()
}

function addEllipse(path: Path2D, x: number, y: number, radiusX: number, radiusY: number): void {
  const oval = new Path2D()
  oval.moveTo(x + radiusX, y)
  oval.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2)
  oval.closePath()
  path.addPath(oval)
}

function makeHull(type: TypedVesselType, shrink = 1): Path2D {
  const beam = beamFor(type)
  const b = beam * shrink
  return makePath((path) => {
    if (type === 'cargo') {
      path.moveTo(0, -shrink)
      path.lineTo(b * 0.72, -shrink * 0.79)
      path.quadraticCurveTo(b * 0.97, -shrink * 0.73, b, -shrink * 0.63)
      path.lineTo(b, shrink * 0.91)
      path.lineTo(b * 0.91, shrink)
      path.lineTo(-b * 0.91, shrink)
      path.lineTo(-b, shrink * 0.91)
      path.lineTo(-b, -shrink * 0.63)
      path.quadraticCurveTo(-b * 0.97, -shrink * 0.73, -b * 0.72, -shrink * 0.79)
    } else if (type === 'tanker') {
      path.moveTo(0, -shrink)
      path.bezierCurveTo(b * 0.52, -shrink * 0.98, b * 0.92, -shrink * 0.82, b, -shrink * 0.57)
      path.lineTo(b, shrink * 0.68)
      path.bezierCurveTo(b, shrink * 0.89, b * 0.78, shrink, b * 0.5, shrink)
      path.lineTo(-b * 0.5, shrink)
      path.bezierCurveTo(-b * 0.78, shrink, -b, shrink * 0.89, -b, shrink * 0.68)
      path.lineTo(-b, -shrink * 0.57)
      path.bezierCurveTo(-b * 0.92, -shrink * 0.82, -b * 0.52, -shrink * 0.98, 0, -shrink)
    } else if (type === 'cruise') {
      path.moveTo(0, -shrink)
      path.bezierCurveTo(b * 0.28, -shrink * 0.99, b * 0.52, -shrink * 0.78, b * 0.72, -shrink * 0.52)
      path.quadraticCurveTo(b, -shrink * 0.38, b, -shrink * 0.25)
      path.lineTo(b, shrink * 0.58)
      path.bezierCurveTo(b, shrink * 0.82, b * 0.55, shrink, 0, shrink)
      path.bezierCurveTo(-b * 0.55, shrink, -b, shrink * 0.82, -b, shrink * 0.58)
      path.lineTo(-b, -shrink * 0.25)
      path.quadraticCurveTo(-b, -shrink * 0.38, -b * 0.72, -shrink * 0.52)
      path.bezierCurveTo(-b * 0.52, -shrink * 0.78, -b * 0.28, -shrink * 0.99, 0, -shrink)
    } else if (type === 'ferry') {
      path.moveTo(0, -shrink)
      path.quadraticCurveTo(b * 0.65, -shrink * 0.98, b * 0.82, -shrink * 0.84)
      path.quadraticCurveTo(b, -shrink * 0.84, b, -shrink * 0.66)
      path.lineTo(b, shrink * 0.91)
      path.quadraticCurveTo(b, shrink, b * 0.88, shrink)
      path.lineTo(-b * 0.88, shrink)
      path.quadraticCurveTo(-b, shrink, -b, shrink * 0.91)
      path.lineTo(-b, -shrink * 0.66)
      path.quadraticCurveTo(-b, -shrink * 0.84, -b * 0.82, -shrink * 0.84)
      path.quadraticCurveTo(-b * 0.65, -shrink * 0.98, 0, -shrink)
    } else if (type === 'tugboat') {
      path.moveTo(0, -shrink)
      path.bezierCurveTo(b * 0.75, -shrink, b, -shrink * 0.77, b, -shrink * 0.48)
      path.lineTo(b, shrink * 0.48)
      path.bezierCurveTo(b, shrink * 0.77, b * 0.75, shrink, 0, shrink)
      path.bezierCurveTo(-b * 0.75, shrink, -b, shrink * 0.77, -b, shrink * 0.48)
      path.lineTo(-b, -shrink * 0.48)
      path.bezierCurveTo(-b, -shrink * 0.77, -b * 0.75, -shrink, 0, -shrink)
    } else {
      path.moveTo(0, -shrink)
      path.bezierCurveTo(b * 0.32, -shrink * 0.9, b * 0.53, -shrink * 0.68, b * 0.57, -shrink * 0.43)
      path.lineTo(b * 0.48, -shrink * 0.1)
      path.lineTo(b * 0.48, shrink * 0.64)
      path.lineTo(b * 0.67, shrink * 0.88)
      path.lineTo(b * 0.67, shrink)
      path.lineTo(-b * 0.67, shrink)
      path.lineTo(-b * 0.67, shrink * 0.88)
      path.lineTo(-b * 0.48, shrink * 0.64)
      path.lineTo(-b * 0.48, -shrink * 0.1)
      path.lineTo(-b * 0.57, -shrink * 0.43)
      path.bezierCurveTo(-b * 0.53, -shrink * 0.68, -b * 0.32, -shrink * 0.9, 0, -shrink)
    }
    path.closePath()
  })
}

function makeRingAndDetails(
  type: TypedVesselType,
  tier: GlyphTier,
  hull: Path2D,
): Pick<TypedGlyphShape, 'dark' | 'light' | 'cutout'> {
  const dark = new Path2D()
  if (tier >= 2) {
    dark.addPath(hull)
    dark.addPath(makeHull(type, 0.91))
  }

  const light = new Path2D()
  const cutout = new Path2D()
  const extra = new Path2D()
  const beam = beamFor(type)
  const wide = beam * 0.72

  if (type === 'cargo') {
    const cellLeft = -beam * 0.78
    const cellRight = beam * 0.78
    const columnGap = beam * 0.035
    const cellWidth = (cellRight - cellLeft - columnGap * 3) / 4
    const firstY = -0.70
    const rowStep = 0.116
    const cellHeight = 0.104
    const rows = tier === 1 ? 3 : 10
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < 4; column++) {
        addRect(dark, cellLeft + column * (cellWidth + columnGap), firstY + row * rowStep, cellWidth, cellHeight)
      }
    }
    addRoundRect(dark, -beam * 0.52, 0.58, beam * 1.04, 0.27, beam * 0.06)
    addRoundRect(light, -beam * 0.46, 0.60, beam * 0.92, 0.07, beam * 0.025)
    addRect(cutout, -beam * 0.22, 0.68, beam * 0.44, 0.045)
    if (tier >= 3) {
      for (const y of [-0.15, 0.20]) {
        addRect(light, -beam * 0.94, y, beam * 0.08, 0.15)
        addRect(light, beam * 0.86, y, beam * 0.08, 0.15)
      }
    }
  } else if (type === 'tanker') {
    const domeCenters = tier === 1 ? [-0.28] : [-0.48, -0.22, 0.04, 0.30]
    for (const y of domeCenters) {
      addEllipse(dark, 0, y, beam * 0.39, 0.082)
      addEllipse(light, 0, y - 0.025, beam * 0.18, 0.025)
    }
    if (tier >= 2) {
      addRect(dark, -beam * 0.018, -0.59, beam * 0.036, 0.028)
      addRect(dark, -beam * 0.018, -0.398, beam * 0.036, 0.096)
      addRect(dark, -beam * 0.018, -0.138, beam * 0.036, 0.029)
      addRect(dark, -beam * 0.018, -0.091, beam * 0.036, 0.213)
      addRect(dark, -beam * 0.018, 0.122, beam * 0.036, 0.096)
      addRect(dark, -beam * 0.018, 0.382, beam * 0.036, 0.048)
      addRect(dark, -beam * 0.42, -0.109, beam * 0.395, 0.018)
      addRect(dark, beam * 0.025, -0.109, beam * 0.395, 0.018)
    }
    addRoundRect(dark, -beam * 0.47, 0.59, beam * 0.94, 0.24, beam * 0.05)
    addRoundRect(light, -beam * 0.40, 0.61, beam * 0.80, 0.065, beam * 0.025)
    addRect(cutout, -beam * 0.15, 0.70, beam * 0.30, 0.035)
    if (tier >= 3) addRect(extra, -beam * 0.10, -0.86, beam * 0.20, 0.075)
  } else if (type === 'cruise') {
    const sections = tier === 1
      ? [{ x: -wide * 0.48, y: -0.20, w: wide * 0.96, h: 0.60 }]
      : [
          { x: -wide * 0.52, y: -0.60, w: wide * 1.04, h: 0.40 },
          { x: -wide * 0.70, y: -0.20, w: wide * 1.40, h: 0.47 },
          { x: -wide * 0.54, y: 0.27, w: wide * 1.08, h: 0.43 },
        ]
    for (const section of sections) {
      addRoundRect(dark, section.x, section.y, section.w, section.h, beam * 0.12)
    }
    if (tier >= 2) {
      for (const side of [-1, 1]) {
        for (let row = 0; row < 7; row++) {
          const y = -0.53 + row * 0.16
          addRect(dark, side * beam * 0.75 - beam * 0.02, y, beam * 0.04, 0.035)
        }
      }
    }
    if (tier >= 2) addRoundRect(light, -beam * 0.27, 0.10, beam * 0.54, 0.13, beam * 0.05)
    addEllipse(light, 0, 0.41, beam * 0.15, 0.055)
    addEllipse(light, 0, 0.32, beam * 0.105, 0.022)
    for (let row = 0; row < 4; row++) addRect(cutout, -beam * 0.39, -0.48 + row * 0.15, beam * 0.05, 0.025)
    if (tier >= 3) {
      for (const side of [-1, 1]) {
        for (let row = 0; row < 4; row++) {
          addEllipse(extra, side * beam * 0.83, -0.12 + row * 0.18, beam * 0.035, 0.028)
        }
      }
    }
  } else if (type === 'ferry') {
    addRoundRect(dark, -beam * 0.72, -0.59, beam * 1.44, 0.79, beam * 0.07)
    if (tier >= 2) {
      for (let lane = 0; lane < 3; lane++) {
        addRect(cutout, -beam * 0.66 + lane * beam * 0.45, -0.53, beam * 0.025, 0.65)
      }
    }
    if (tier >= 2) addRect(dark, -beam * 0.12, -0.91, beam * 0.24, 0.13)
    addRoundRect(dark, -beam * 0.48, 0.45, beam * 0.96, 0.36, beam * 0.07)
    addRoundRect(light, -beam * 0.40, 0.48, beam * 0.80, 0.075, beam * 0.03)
    if (tier >= 2) {
      addEllipse(light, -beam * 0.23, 0.38, beam * 0.10, 0.045)
      addEllipse(light, beam * 0.23, 0.38, beam * 0.10, 0.045)
    }
    for (let index = 0; index < 4; index++) {
      addRect(cutout, -beam * 0.31 + index * beam * 0.20, 0.61, beam * 0.08, 0.035)
    }
    if (tier >= 3) {
      for (const side of [-1, 1]) {
        for (let index = 0; index < 3; index++) {
          addEllipse(extra, side * beam * 0.82, -0.35 + index * 0.24, beam * 0.07, 0.035)
        }
      }
    }
  } else if (type === 'tugboat') {
    const funnelRadius = beam * 0.13
    const winchRadius = beam * 0.22
    const bittRadius = beam * 0.10
    addRoundRect(dark, -beam * 0.49, -0.31, beam * 0.98, 0.43, beam * 0.13)
    addRoundRect(light, -beam * 0.40, -0.34, beam * 0.80, 0.11, beam * 0.05)
    addEllipse(dark, 0, 0.22, funnelRadius, funnelRadius)
    if (tier >= 2) {
      addEllipse(dark, 0, 0.76, winchRadius, winchRadius)
      addEllipse(dark, -beam * 0.39, 0.84, bittRadius, bittRadius)
      addEllipse(dark, beam * 0.39, 0.84, bittRadius, bittRadius)
    }
    addRect(cutout, -beam * 0.25, -0.23, beam * 0.50, 0.055)
    if (tier >= 3) addEllipse(light, 0, 0.76, beam * 0.10, beam * 0.10)
  } else {
    addEllipse(dark, 0, -0.60, beam * 0.16, 0.055)
    addRect(dark, -beam * 0.018, -0.75, beam * 0.036, 0.095)
    addRoundRect(dark, -beam * 0.48, -0.30, beam * 0.96, 0.40, beam * 0.06)
    addRoundRect(light, -beam * 0.37, -0.28, beam * 0.74, 0.09, beam * 0.03)
    if (tier >= 2) {
      addRect(dark, -beam * 0.22, 0.20, beam * 0.44, 0.14)
      addEllipse(dark, 0, 0.72, beam * 0.38, 0.12)
    }
    addRect(cutout, -beam * 0.26, -0.19, beam * 0.52, 0.035)
    addRect(cutout, -beam * 0.015, 0.70, beam * 0.03, 0.08)
    addRect(cutout, -beam * 0.20, 0.735, beam * 0.40, 0.025)
    if (tier >= 3) {
      addEllipse(light, 0, -0.60, beam * 0.07, 0.026)
      addRect(light, -beam * 0.025, -0.70, beam * 0.05, 0.08)
    }
  }

  if (tier >= 3) dark.addPath(extra)
  return { dark, light, cutout }
}

function mix(color: string, target: string, amount: number): string {
  const sourceValue = Number.parseInt(color.slice(1), 16)
  const targetValue = Number.parseInt(target.slice(1), 16)
  const channel = (shift: number) => {
    const source = (sourceValue >> shift) & 255
    const destination = (targetValue >> shift) & 255
    return Math.round(source * (1 - amount) + destination * amount)
  }
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`
}
