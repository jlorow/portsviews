import type { VesselType } from '@wake/shared'
import { VESSEL_BASE_SIZES } from '@wake/shared'

// VIS-6 signed-off constants (CONTEXT in the story prompt).
export const HERO_COUNT = 4
export const HERO_MIN_HOLD_MS = 600_000
export const HERO_SWAP_INTERVAL_MS = 60_000
export const HERO_REENTRY_COOLDOWN_MS = 600_000
export const HERO_MIN_SOG_KN = 0.5
export const HERO_KEEP_SOG_KN = 0.3
export const HERO_KEEP_MIN_OPACITY = 0.8

// A candidate for hero status: one on-screen, not-stale vessel this
// frame. Staleness and on-screen membership are the caller's job
// (renderFrame already has projection and opacity data this module does
// not) -- updateHeroes applies only the type/speed eligibility rule,
// ranking and stability from CONTEXT.
export interface HeroCandidate {
  mmsi: string
  vesselType: VesselType
  sogKn: number
  opacity: number
}

export interface HeroSlot {
  mmsi: string
  vesselType: VesselType
  sinceMs: number
}

export interface HeroState {
  slots: HeroSlot[]
  lastSwapMs: number | null
  cooldownUntil: Map<string, number>
}

export function createHeroState(): HeroState {
  return { slots: [], lastSwapMs: null, cooldownUntil: new Map() }
}

// A mutable container so a caller (vesselTracker.ts) can hold "the
// current hero state" beside a Map it doesn't otherwise mutate through
// reassignment -- updateHeroes itself stays a pure prev-in/next-out
// function, matching the "pure updateHeroes" contract in CONTEXT.
export interface HeroStateRef {
  current: HeroState
}

export function createHeroStateRef(): HeroStateRef {
  return { current: createHeroState() }
}

function isEligible(candidate: HeroCandidate): boolean {
  // Entry rule: not unknown, above the stopped-hull boundary, and fully
  // opaque. A non-hero may only enter at opacity 1.0 -- a kept slot may
  // drop below 1.0 but a newcomer may not.
  return candidate.vesselType !== 'unknown' && candidate.sogKn >= HERO_MIN_SOG_KN && candidate.opacity === 1.0
}

// An EXISTING hero slot is kept while its candidate is not unknown, is
// at or above HERO_KEEP_SOG_KN, and is at or above HERO_KEEP_MIN_OPACITY.
// This is the softer rule that lets a hero survive a brief slow-down or a
// report gap; it applies only to a slot that already exists.
function isKeptSlotCandidate(candidate: HeroCandidate): boolean {
  return candidate.vesselType !== 'unknown' && candidate.sogKn >= HERO_KEEP_SOG_KN && candidate.opacity >= HERO_KEEP_MIN_OPACITY
}

// Descending by VESSEL_BASE_SIZES, then descending by sogKn, then
// ascending by mmsi -- CONTEXT's ranking rule, verbatim.
function compareRank(a: HeroCandidate, b: HeroCandidate): number {
  const sizeDiff = VESSEL_BASE_SIZES[b.vesselType] - VESSEL_BASE_SIZES[a.vesselType]
  if (sizeDiff !== 0) return sizeDiff
  const sogDiff = b.sogKn - a.sogKn
  if (sogDiff !== 0) return sogDiff
  return a.mmsi < b.mmsi ? -1 : a.mmsi > b.mmsi ? 1 : 0
}

/**
 * One frame of hero selection. Pure: same prev/candidates/nowMs always
 * gives the same result.
 *
 * - An existing hero missing from candidates or no longer eligible
 *   leaves immediately (not a "swap"; does not touch lastSwapMs) and
 *   starts its 10-minute re-entry cooldown.
 * - Freed slots refill at once from the ranking, also not a swap.
 * - With all HERO_COUNT slots full, at most one stability swap per call:
 *   the oldest hero (by sinceMs) that has held the slot for at least
 *   HERO_MIN_HOLD_MS may be replaced by the best-ranked eligible
 *   non-hero, non-cooldown candidate -- gated to at most once per
 *   HERO_SWAP_INTERVAL_MS via lastSwapMs.
 */
export function updateHeroes(prev: HeroState, candidates: HeroCandidate[], nowMs: number): HeroState {
  const byMmsi = new Map(candidates.map((c) => [c.mmsi, c] as const))
  const cooldownUntil = new Map(prev.cooldownUntil)

  // Drop expired cooldown entries so the map doesn't grow unboundedly
  // across a long-running session.
  for (const [mmsi, until] of cooldownUntil) {
    if (until <= nowMs) cooldownUntil.delete(mmsi)
  }

  const slots: HeroSlot[] = []
  for (const slot of prev.slots) {
    const candidate = byMmsi.get(slot.mmsi)
    // An existing slot is kept by the keep rule, not the entry rule.
    if (candidate !== undefined && isKeptSlotCandidate(candidate)) {
      slots.push(slot)
    } else {
      cooldownUntil.set(slot.mmsi, nowMs + HERO_REENTRY_COOLDOWN_MS)
    }
  }

  const heroMmsis = new Set(slots.map((s) => s.mmsi))
  const isOnCooldown = (mmsi: string) => (cooldownUntil.get(mmsi) ?? 0) > nowMs
  const ranking = candidates
    .filter((c) => isEligible(c) && !heroMmsis.has(c.mmsi) && !isOnCooldown(c.mmsi))
    .sort(compareRank)

  while (slots.length < HERO_COUNT && ranking.length > 0) {
    const next = ranking.shift()!
    slots.push({ mmsi: next.mmsi, vesselType: next.vesselType, sinceMs: nowMs })
  }

  let lastSwapMs = prev.lastSwapMs

  if (slots.length === HERO_COUNT && ranking.length > 0) {
    const canSwap = lastSwapMs === null || nowMs - lastSwapMs >= HERO_SWAP_INTERVAL_MS
    if (canSwap) {
      const oldestFirst = [...slots].sort((a, b) => a.sinceMs - b.sinceMs)
      const outSlot = oldestFirst.find((s) => nowMs - s.sinceMs >= HERO_MIN_HOLD_MS)
      if (outSlot !== undefined) {
        const inCandidate = ranking[0]
        const outIndex = slots.findIndex((s) => s.mmsi === outSlot.mmsi)
        slots.splice(outIndex, 1, { mmsi: inCandidate.mmsi, vesselType: inCandidate.vesselType, sinceMs: nowMs })
        cooldownUntil.set(outSlot.mmsi, nowMs + HERO_REENTRY_COOLDOWN_MS)
        lastSwapMs = nowMs
      }
    }
  }

  return { slots, lastSwapMs, cooldownUntil }
}
