import type { VesselFix, VesselState, VesselType, ProjectionConfig, DisplayConfig } from '@wake/shared'
import { applyFix, updateVesselState, isExpired, vesselOpacity, mapProject, screenHeadingDeg, VESSEL_BASE_SIZES, VESSEL_COLORS } from '@wake/shared'
import type { ClientVesselEntry } from './wakeSocket'
import { drawGlyph, drawDot, glyphActualSize } from './canvas/glyphs'
import { drawTrail } from './canvas/trails'
import { drawHeroGlow } from './canvas/glow'
import { drawRangeRings } from './canvas/rangeRings'
import { updateHeroes, createHeroStateRef, HERO_MIN_SOG_KN, type HeroCandidate, type HeroStateRef } from './heroes'
import { drawSweep, sweepAngleDeg, beamCrossed } from './canvas/sweep'
import { drawHeroLabels, drawAreaTitle, type HeroLabelInput } from './canvas/labels'
import { buildLegendRows, drawLegend } from './canvas/legend'

// VIS-8: the speed at or above which a vessel draws its hull. Below it,
// the vessel is "stopped" and draws a dot instead (drawDot's own comment
// has the why). This is heroes.ts's HERO_MIN_SOG_KN itself, not a second
// 0.5 literal, and that identity is the point: isEligible requires
// sogKn >= HERO_MIN_SOG_KN and isStoppedForGlyph requires
// sogKn < HERO_MIN_SOG_KN, so the two predicates partition the speed
// axis at one shared boundary and cannot both hold for the same fix.
// "A hero is never drawn as a dot" is therefore true by construction
// rather than by coincidence -- which the trail-distance rule this
// replaces could not offer (see Correction 25 / VIS-8's A1(c) audit).
export const STOPPED_MAX_SOG_KN = HERO_MIN_SOG_KN

export function isStoppedForGlyph(sogKn: number): boolean {
  return sogKn < STOPPED_MAX_SOG_KN
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

// Bearing of a screen point from the canvas centre, clockwise from
// screen-up -- same convention as sweep.ts's sweepAngleDeg and
// shared/src/projection.ts's screenHeadingDeg, so the two angles compare
// directly with no unit conversion.
function bearingFromCenterDeg(x: number, y: number, cx: number, cy: number): number {
  return normalizeDeg((Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI)
}

// Deliberately not named VesselStateMap -- wakeSocket.ts already exports
// that name for its own, differently-shaped map (mmsi -> ClientVesselEntry,
// the raw last-received fix plus static fields). This one holds
// shared/src/vesselState.ts's VesselState (eased display position plus
// bounded track history), built by applyFix/updateVesselState. S1.8
// needs both maps at once: this one for what to draw, wakeSocket's for
// vesselType (VesselState itself carries no such field).
export type TrackedVesselMap = Map<string, VesselState>

export function createTrackedVesselMap(): TrackedVesselMap {
  return new Map()
}

/**
 * Wired to WakeConnectionHandlers.onFix -- fires once per genuinely new
 * fix (once per message actually processed), never once per frame. This
 * is the signed-off callback design, not polling: wakeSocket.ts already
 * knows the moment a fix lands, so it signals rather than making the
 * render loop diff state every frame to detect change.
 */
export function onFixArrived(tracked: TrackedVesselMap, fix: VesselFix): void {
  const prev = tracked.get(fix.mmsi)
  tracked.set(fix.mmsi, applyFix(prev, fix))
}

/**
 * Removes vessels whose last known fix is expired under removeSec --
 * same shape as wakeSocket.ts's pruneExpiredVessels and
 * caches.ts's evictStalePositions, now a third instance of the same
 * pattern. Eviction (not just skip-drawing) is deliberate: if a fix
 * later arrives for a re-evicted mmsi, onFixArrived calls applyFix with
 * no previous state, snapping to the new fix rather than easing from a
 * position last true many minutes ago -- the correct behaviour for a
 * vessel that's been gone long enough to fully expire.
 */
export function pruneExpiredTracked(tracked: TrackedVesselMap, nowMs: number, removeSec: number): void {
  for (const [mmsi, state] of tracked) {
    if (isExpired(state.lastFix, nowMs, removeSec)) {
      tracked.delete(mmsi)
    }
  }
}

export interface RenderContext {
  centerLat: number
  centerLon: number
  radiusNm: number
  projConfig: ProjectionConfig
  canvasWidth: number
  canvasHeight: number
  nowMs: number
  deltaMs: number
  config: DisplayConfig
  areaDisplayName: string
}

interface FrameEntry {
  mmsi: string
  eased: VesselState
  vesselType: VesselType
  opacity: number
  heading: number
  projectedX: number
  projectedY: number
  revealed: boolean
}

// VIS-6: hero state lives beside the tracked map, one entry per
// TrackedVesselMap instance rather than a renderFrame parameter every
// caller (including every pre-existing test) would need to thread
// through. A WeakMap means it's discarded automatically with its tracked
// map and never leaks across tests, which each construct their own.
const heroStateRefs = new WeakMap<TrackedVesselMap, HeroStateRef>()

function getHeroStateRef(tracked: TrackedVesselMap): HeroStateRef {
  let ref = heroStateRefs.get(tracked)
  if (ref === undefined) {
    ref = createHeroStateRef()
    heroStateRefs.set(tracked, ref)
  }
  return ref
}

// VIS-7: radar sweep reveal state lives beside the tracked map exactly
// like hero state above -- one entry per TrackedVesselMap, discarded
// automatically via WeakMap when the tracked map itself is. revealed
// mmsis are never removed except when pruneExpiredTracked drops that
// mmsi from the tracked map (a pruned vessel that returns is unrevealed
// again, per CONTEXT). lastAngleDeg is null before the first frame ever
// rendered for this tracked map, and is reset to null whenever
// sweepPeriodSec is 0 -- so resuming the sweep later starts a fresh
// "no previous frame" state rather than crossing a stale wide arc.
interface RevealState {
  revealed: Set<string>
  lastAngleDeg: number | null
}
interface RevealStateRef {
  current: RevealState
}
const revealStateRefs = new WeakMap<TrackedVesselMap, RevealStateRef>()

function getRevealStateRef(tracked: TrackedVesselMap): RevealStateRef {
  let ref = revealStateRefs.get(tracked)
  if (ref === undefined) {
    ref = { current: { revealed: new Set(), lastAngleDeg: null } }
    revealStateRefs.set(tracked, ref)
  }
  return ref
}

/**
 * One frame: prune, ease every tracked vessel toward its dead-reckoned
 * target, project, and draw. A null from mapProject means out of the
 * configured view radius -- skipped, not drawn, not an error.
 * vesselType is looked up from the separate raw-entry map (VesselState
 * carries none); undefined defaults to 'unknown', which VIS-3's palette
 * (shared/src/vessel.ts's VESSEL_COLORS) renders as its own colour,
 * #C8D8F0, distinct from every typed vessel's colour. isNotable is
 * always false; no signal for it exists anywhere in the pipeline yet.
 *
 * State update, projection, opacity and heading are each computed once
 * per vessel per frame in this first pass, regardless of draw order.
 * Trails then draw for every visible vessel, followed by every glyph --
 * previously each vessel drew its own glyph then its own trail in Map
 * insertion order, so a trail painted over its own glyph, and which
 * vessel's glyph sat on top of a neighbour's depended on discovery
 * history. Glyphs now draw largest-hull-first (VESSEL_BASE_SIZES
 * descending, ties broken by MMSI ascending) so stacking is stable
 * frame to frame and independent of when each vessel was first seen.
 */
export function renderFrame(
  tracked: TrackedVesselMap,
  clientState: Map<string, ClientVesselEntry>,
  ctx: CanvasRenderingContext2D,
  render: RenderContext,
): void {
  pruneExpiredTracked(tracked, render.nowMs, render.config.removeSec)

  // VIS-7: a pruned vessel that returns must be revealed again -- drop
  // any revealed mmsi no longer present in tracked.
  const revealStateRef = getRevealStateRef(tracked)
  for (const mmsi of revealStateRef.current.revealed) {
    if (!tracked.has(mmsi)) revealStateRef.current.revealed.delete(mmsi)
  }

  if (render.config.rangeRingsEnabled) {
    drawRangeRings(ctx, render.canvasWidth, render.canvasHeight, render.radiusNm)
  }

  if (render.config.sweepPeriodSec > 0) {
    drawSweep(ctx, render.canvasWidth, render.canvasHeight, render.radiusNm, render.nowMs, render.config.sweepPeriodSec)
  }

  const cx = render.canvasWidth / 2
  const cy = render.canvasHeight / 2
  const sweepOn = render.config.sweepPeriodSec > 0
  const currAngleDeg = sweepOn ? sweepAngleDeg(render.nowMs, render.config.sweepPeriodSec) : null

  const entries: FrameEntry[] = []

  for (const [mmsi, prevState] of tracked) {
    const eased = updateVesselState(prevState, render.nowMs, render.deltaMs, render.config)
    tracked.set(mmsi, eased)

    const projected = mapProject(
      eased.displayLat,
      eased.displayLon,
      render.centerLat,
      render.centerLon,
      render.radiusNm,
      render.projConfig,
      render.canvasWidth,
      render.canvasHeight,
    )
    if (!projected) continue

    const vesselType: VesselType = clientState.get(mmsi)?.vesselType ?? 'unknown'
    const opacity = vesselOpacity(eased.lastFix, render.nowMs, render.config.staleSec, render.config.removeSec)

    // Correction 18: raw cogDeg is the bow's real-world heading, not its
    // on-screen one -- mapProject mirrors and rotates positions, so the
    // glyph's rotation must go through the same transform.
    const heading = screenHeadingDeg(
      eased.displayLat,
      eased.displayLon,
      eased.lastFix.cogDeg,
      render.centerLat,
      render.centerLon,
      render.radiusNm,
      render.projConfig,
      render.canvasWidth,
      render.canvasHeight,
    )

    // VIS-7: radar sweep reveal. Not sweepOn -> every vessel is always
    // revealed. Sweeping -> revealed once (persists after), either by
    // being within 1px of the view centre or by the leading edge having
    // crossed this vessel's bearing between last frame's angle and this
    // one's (see sweep.ts's beamCrossed for the wrap-safe range check).
    let revealed = revealStateRef.current.revealed.has(mmsi)
    if (!revealed) {
      if (!sweepOn) {
        revealed = true
      } else {
        const dx = projected.x - cx
        const dy = projected.y - cy
        if (Math.hypot(dx, dy) < 1) {
          revealed = true
        } else {
          const bearingDeg = bearingFromCenterDeg(projected.x, projected.y, cx, cy)
          revealed = beamCrossed(revealStateRef.current.lastAngleDeg, currAngleDeg as number, bearingDeg)
        }
      }
      if (revealed) revealStateRef.current.revealed.add(mmsi)
    }

    entries.push({
      mmsi,
      eased,
      vesselType,
      opacity,
      heading,
      projectedX: projected.x,
      projectedY: projected.y,
      revealed,
    })
  }

  // Sweeping -> remember this frame's angle for the next frame's
  // crossing check. Off -> reset to null so a later resume starts a
  // fresh "no previous frame" state rather than sweeping a stale arc.
  revealStateRef.current.lastAngleDeg = currAngleDeg

  // VIS-7: an unrevealed vessel draws nothing at all -- no trail, glyph,
  // glow or label -- and is not a hero candidate. Every branch below
  // this point works from `visible`, never the raw `entries`.
  const visible = entries.filter((e) => e.revealed)

  // VIS-6: heroes are chosen from on-screen, not-stale entries only --
  // opacity is exactly 1.0 (not just close to it) while ageSec <=
  // staleSec, per vesselOpacity's own branch, so this is the existing
  // staleness rule, not a second threshold.
  const heroStateRef = getHeroStateRef(tracked)
  let heroMmsis: Set<string>

  if (render.config.heroesEnabled) {
    const candidates: HeroCandidate[] = visible
      .filter((e) => e.opacity === 1.0)
      .map((e) => ({ mmsi: e.mmsi, vesselType: e.vesselType, sogKn: e.eased.lastFix.sogKn }))
    heroStateRef.current = updateHeroes(heroStateRef.current, candidates, render.nowMs)
    heroMmsis = new Set(heroStateRef.current.slots.map((s) => s.mmsi))
  } else {
    heroStateRef.current = { slots: [], lastSwapMs: null, cooldownUntil: new Map() }
    heroMmsis = new Set()
  }

  for (const entry of visible) {
    // drawTrail's own points.length < 2 guard already covers "a vessel
    // with a single track point draws no trail" -- not duplicated here.
    // VIS-7: heroes show where they came from -- a longer trail than
    // everyone else, regardless of config.trailLength.
    drawTrail(
      ctx,
      entry.eased.track,
      render.projConfig,
      render.centerLat,
      render.centerLon,
      render.radiusNm,
      render.canvasWidth,
      render.canvasHeight,
      entry.vesselType,
      entry.opacity,
      heroMmsis.has(entry.mmsi) ? 'long' : render.config.trailLength,
    )
  }

  const byStackOrder = [...visible].sort((a, b) => {
    const sizeDiff = VESSEL_BASE_SIZES[b.vesselType] - VESSEL_BASE_SIZES[a.vesselType]
    if (sizeDiff !== 0) return sizeDiff
    return a.mmsi < b.mmsi ? -1 : a.mmsi > b.mmsi ? 1 : 0
  })

  for (const entry of byStackOrder) {
    if (heroMmsis.has(entry.mmsi)) continue
    // VIS-7: unknown-type circles additionally scale by unknownScale --
    // they currently outshine heroes at ceiling distance. No effect on
    // any typed vessel.
    const isUnknown = entry.vesselType === 'unknown'
    const baseSize =
      VESSEL_BASE_SIZES[entry.vesselType] * render.config.glyphScale * (isUnknown ? render.config.unknownScale : 1)

    // VIS-8: a stopped TYPED vessel draws a dot rather than a hull
    // rotated to a noise bearing. Unknown vessels are excluded because
    // they already draw a circle at this same radius ratio -- routing
    // them through drawDot would silently drop their unknownScale term
    // and change a glyph VIS-7 already settled at the ceiling.
    if (!isUnknown && render.config.stoppedAsDot && isStoppedForGlyph(entry.eased.lastFix.sogKn)) {
      drawDot(
        ctx,
        entry.projectedX,
        entry.projectedY,
        baseSize,
        VESSEL_COLORS[entry.vesselType],
        render.canvasWidth,
      )
      continue
    }

    drawGlyph(
      ctx,
      entry.projectedX,
      entry.projectedY,
      entry.heading,
      // VIS-4: baseSize scaled by render.config.glyphScale. The stack
      // order above deliberately still sorts by the unscaled
      // VESSEL_BASE_SIZES -- a uniform scale factor can't change which
      // type is relatively larger, so it's the same order either way.
      { type: entry.vesselType, baseSize, color: '', isNotable: false },
      render.canvasWidth,
    )
  }

  // Heroes draw last, at heroScale with their full hull detail -- glows
  // for every hero first, then every hero glyph, so no hero's glow
  // paints over a neighbouring hero's already-drawn glyph.
  const heroEntries = byStackOrder.filter((entry) => heroMmsis.has(entry.mmsi))

  if (render.config.glowEnabled) {
    for (const entry of heroEntries) {
      const heroBaseSize = VESSEL_BASE_SIZES[entry.vesselType] * render.config.heroScale
      const length = glyphActualSize(heroBaseSize, render.canvasWidth)
      drawHeroGlow(ctx, entry.projectedX, entry.projectedY, VESSEL_COLORS[entry.vesselType], length)
    }
  }

  const heroLabelInputs: HeroLabelInput[] = []

  for (const entry of heroEntries) {
    const heroBaseSize = VESSEL_BASE_SIZES[entry.vesselType] * render.config.heroScale
    const shadow = render.config.glowEnabled
      ? { blur: glyphActualSize(heroBaseSize, render.canvasWidth) * 0.25, color: VESSEL_COLORS[entry.vesselType] }
      : undefined
    drawGlyph(
      ctx,
      entry.projectedX,
      entry.projectedY,
      entry.heading,
      { type: entry.vesselType, baseSize: heroBaseSize, color: '', isNotable: false },
      render.canvasWidth,
      shadow,
    )
    heroLabelInputs.push({
      mmsi: entry.mmsi,
      x: entry.projectedX,
      y: entry.projectedY,
      length: glyphActualSize(heroBaseSize, render.canvasWidth),
      shipName: clientState.get(entry.mmsi)?.shipName,
      vesselType: entry.vesselType,
      sogKn: entry.eased.lastFix.sogKn,
      typeColor: VESSEL_COLORS[entry.vesselType],
    })
  }

  // VIS-7: hero-only labels draw after every hero glyph.
  drawHeroLabels(ctx, heroLabelInputs, render.canvasWidth, render.canvasHeight, render.config.labelSize)

  // VIS-8: both the header count and the legend are grouped by type over
  // the SAME basis -- the vessels this frame actually drew. `visible` is
  // renderFrame's existing revealed-only array, so this is a reduce over
  // a pass that already ran, not a second walk of the tracked map, and a
  // vessel drawn as a dot counts exactly like any other.
  const countsByType: Partial<Record<VesselType, number>> = {}
  for (const entry of visible) {
    countsByType[entry.vesselType] = (countsByType[entry.vesselType] ?? 0) + 1
  }

  // VIS-7: faint area title, drawn last -- now carrying VIS-8's count.
  if (render.config.areaTitleEnabled) {
    drawAreaTitle(ctx, render.areaDisplayName, render.canvasWidth, render.canvasHeight, visible.length)
  }

  // VIS-8: the palette legend, bottom-right, after the area title.
  if (render.config.legendEnabled) {
    drawLegend(ctx, buildLegendRows(countsByType), render.canvasWidth, render.canvasHeight)
  }
}
