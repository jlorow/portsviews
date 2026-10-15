import {
  HERO_SCALES,
  LABEL_SIZES,
  LAND_LEVELS,
  SWEEP_PERIODS,
  UNKNOWN_SCALES,
  nextGlyphScale,
  nextLandLevel,
  type DisplayConfig,
} from '@wake/shared'

// VIS-9 part 2 — the ?tune=1 overlay's two halves, lifted out of
// WakeCanvas.tsx so both can be tested. Neither was testable while it
// lived inside a React effect, which is exactly why the two defects below
// shipped. VIS-8 already made this move for one value and said why:
// nextGlyphScale is "exported rather than inlined in WakeCanvas.tsx like
// the other cycling keys precisely so the cycle is testable -- a React key
// handler is not." This finishes that job for the rest of them.

/**
 * The window over which frames are counted for the FPS readout.
 *
 * It was 5,000 ms, and the readout could therefore be up to six seconds
 * behind reality (five for the window, one more for the overlay's own
 * refresh interval). That is most of a look. At 1,000 ms the number tracks
 * what is actually on screen, and the `[Wake] fps:` console line it also
 * writes gains five times the resolution for spotting a transient stall --
 * which is what the VIS-9 ceiling look needed and did not have.
 */
export const FPS_WINDOW_MS = 1000

/**
 * What the readout shows before its first window has closed.
 *
 * This is the whole reason the VIS-9 look reported "FPS 0": the counter
 * started at the number 0 and was only overwritten once a full window
 * completed, so for the first five seconds of every page load the overlay
 * displayed a literal zero that was indistinguishable from a measured
 * zero. A real zero means the display has stopped; "--" means nobody has
 * measured yet. They are different facts and must not share a symbol.
 */
export const FPS_PENDING = '--'

export function formatFps(fps: number | null): string {
  return fps === null ? FPS_PENDING : String(fps)
}

/** Only the fields that are not part of DisplayConfig. */
export interface TuneOverlayStatus {
  /** false when this area has no tile extract, so the basemap reads "n/a". */
  basemapAvailable: boolean
  radiusNm: number
  /** North-positive offset of the view centre from the area centre, in nm. */
  centerOffsetLatNm: number
  /** East-positive offset of the view centre from the area centre, in nm. */
  centerOffsetLonNm: number
  vesselCount: number
  /** null until the first FPS window has closed. */
  fps: number | null
}

/**
 * The view readout: radius, then how far the centre has been panned from
 * the area's own centre, in nautical miles -- "View 5nm N+1.2 E-0.4".
 *
 * The sign is printed for both axes, including the zero case, so the line
 * never reads as two different formats and a pan of 0.04 nm cannot print as
 * "-0.0" after rounding: the ROUNDED value decides the sign.
 */
export function formatView(radiusNm: number, offsetLatNm: number, offsetLonNm: number): string {
  const axis = (offsetNm: number, positive: string, negative: string) => {
    const rounded = Math.round(offsetNm * 10) / 10
    const sign = rounded < 0 ? negative : positive
    return `${sign}${Math.abs(rounded).toFixed(1)}`
  }
  return `View ${radiusNm}nm N${axis(offsetLatNm, '+', '-')} E${axis(offsetLonNm, '+', '-')}`
}

/**
 * The overlay's whole text. Pure, so a test can assert what the ceiling
 * would actually read rather than trusting a template literal buried in a
 * component.
 */
export function tuneOverlayText(config: DisplayConfig, status: TuneOverlayStatus): string {
  const onOff = (value: boolean) => (value ? 'on' : 'off')
  return (
    `${formatView(status.radiusNm, status.centerOffsetLatNm, status.centerOffsetLonNm)} · Heroes ${onOff(config.heroesEnabled)} · Glow ${onOff(config.glowEnabled)} · Rings ${onOff(config.rangeRingsEnabled)}` +
    ` · Hero size ${config.heroScale} · Glyph ${config.glyphScale} · Labels ${config.labelSize}` +
    ` · Title ${onOff(config.areaTitleEnabled)} · Unknown ${config.unknownScale} · Sweep ${config.sweepPeriodSec}s` +
    ` · Dots ${onOff(config.stoppedAsDot)} · Legend ${onOff(config.legendEnabled)}` +
    ` · Basemap ${status.basemapAvailable ? onOff(config.basemapEnabled) : 'n/a'}` +
    ` · Land ${LAND_LEVELS[config.basemapLand].name} · Names ${onOff(config.placeNamesEnabled)}` +
    ` · Vessels ${status.vesselCount} · FPS ${formatFps(status.fps)}`
  )
}

/**
 * The subset of KeyboardEvent this cares about. A real KeyboardEvent
 * satisfies it structurally, so WakeCanvas passes the event straight
 * through and a test can pass a plain object.
 */
export interface TuneKeyEvent {
  key: string
  repeat: boolean
}

function cycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length]
}

/**
 * The next config after one key event, or THE SAME OBJECT REFERENCE when
 * the event changes nothing. Callers and tests can therefore use `===` to
 * ask "did this key do anything at all".
 *
 * HELD KEYS DO NOTHING AFTER THE FIRST PRESS. An OS key auto-repeat
 * delivers a stream of keydown events with `repeat: true`, roughly thirty
 * a second, and every previous version of this handler acted on every one
 * of them. That was harmless while the keys only flipped booleans, and
 * stopped being harmless the moment VIS-9 hung `map.setStyle()` off F:
 * holding it rebuilt the entire MapLibre style once per frame for as long
 * as the key was down. The ceiling look's own console log caught the
 * resulting stall, and it was read as a basemap performance problem rather
 * than as a stuck key — see CLAUDE.md's Correction 27.
 *
 * The guard is on ALL eleven keys, not just F, because the argument is
 * about physical presses rather than about which handler is expensive: one
 * press means one action.
 */
export function applyTuneKey(config: DisplayConfig, event: TuneKeyEvent): DisplayConfig {
  if (event.repeat) return config

  switch (event.key.toLowerCase()) {
    case 'h':
      return { ...config, heroesEnabled: !config.heroesEnabled }
    case 'w':
      return { ...config, glowEnabled: !config.glowEnabled }
    case 'r':
      return { ...config, rangeRingsEnabled: !config.rangeRingsEnabled }
    case 'j':
      return { ...config, heroScale: cycle(HERO_SCALES, config.heroScale) }
    case 'l':
      return { ...config, labelSize: cycle(LABEL_SIZES, config.labelSize) }
    case 't':
      return { ...config, areaTitleEnabled: !config.areaTitleEnabled }
    case 'u':
      return { ...config, unknownScale: cycle(UNKNOWN_SCALES, config.unknownScale) }
    case 'b':
      return { ...config, sweepPeriodSec: cycle(SWEEP_PERIODS, config.sweepPeriodSec) }
    case 'd':
      return { ...config, stoppedAsDot: !config.stoppedAsDot }
    case 'k':
      return { ...config, legendEnabled: !config.legendEnabled }
    case 'g':
      return { ...config, glyphScale: nextGlyphScale(config.glyphScale) }
    // VIS-9: M basemap on/off, F land brightness, N place names. The render
    // loop reconciles the first two onto the MapLibre handle; the third is
    // read straight off the config each frame.
    case 'm':
      return { ...config, basemapEnabled: !config.basemapEnabled }
    case 'f':
      return { ...config, basemapLand: nextLandLevel(config.basemapLand) }
    case 'n':
      return { ...config, placeNamesEnabled: !config.placeNamesEnabled }
    default:
      return config
  }
}
