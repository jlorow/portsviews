export const RADIUS_STEPS_NM = [5, 10, 20, 40, 80] as const

export function radiusStepsFor(defaultRadiusNm: number): number[] {
  const steps: number[] = RADIUS_STEPS_NM.filter((radiusNm) => radiusNm <= defaultRadiusNm)
  // Steps above the default are excluded because the live feed box only covers the default area, so zooming out past it would show empty margins.
  if (!steps.includes(defaultRadiusNm)) steps.push(defaultRadiusNm)
  return steps.sort((a, b) => a - b)
}

export function stepRadius(steps: readonly number[], current: number, direction: 'in' | 'out'): number {
  if (steps.length === 0) return current

  const index = steps.indexOf(current)
  if (index === -1) {
    return steps.reduce((nearest, radiusNm) =>
      Math.abs(radiusNm - current) < Math.abs(nearest - current) ? radiusNm : nearest,
    )
  }

  const nextIndex = direction === 'in' ? index - 1 : index + 1
  return steps[nextIndex] ?? current
}

export interface ZoomKeyEvent {
  key: string
  repeat: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  targetIsEditable: boolean
}

export function zoomKeyAction(event: ZoomKeyEvent): 'in' | 'out' | 'reset' | null {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.targetIsEditable) return null

  switch (event.key) {
    case '=':
    case '+':
      return 'in'
    case '-':
    case '_':
      return 'out'
    case '0':
      return 'reset'
    default:
      return null
  }
}
