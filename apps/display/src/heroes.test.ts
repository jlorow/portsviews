import type { VesselType } from '@wake/shared'
import {
  createHeroState,
  updateHeroes,
  type HeroCandidate,
  type HeroState,
} from './heroes'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    console.log(`[Pass] ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}`)
  }
}

function candidate(mmsi: string, vesselType: VesselType, sogKn: number): HeroCandidate {
  return { mmsi, vesselType, sogKn }
}

function mmsisOf(state: HeroState): string[] {
  return state.slots.map((s) => s.mmsi)
}

// Scenario: 6 eligible typed moving vessels -> the top 4 by size, then
// speed. V2 and V3 are both cargo (same size) with different sogKn to
// prove the speed tiebreak, not just the size ranking. Two ineligible
// candidates (unknown type, sub-threshold speed) ride along to prove
// they never displace an eligible one even though V8 shares V2/V3's size.
{
  const candidates: HeroCandidate[] = [
    candidate('V1', 'cruise', 5), // size 130
    candidate('V2', 'cargo', 15), // size 120, faster
    candidate('V3', 'cargo', 5), // size 120, slower
    candidate('V4', 'tanker', 20), // size 110
    candidate('V5', 'ferry', 8), // size 90
    candidate('V6', 'tugboat', 25), // size 70
    candidate('V7', 'unknown', 10), // ineligible: type
    candidate('V8', 'cargo', 0.4), // ineligible: below HERO_MIN_SOG_KN
  ]

  const result = updateHeroes(createHeroState(), candidates, 0)

  assert(
    JSON.stringify(mmsisOf(result)) === JSON.stringify(['V1', 'V2', 'V3', 'V4']),
    `ranking: top 4 by size then speed, in order (got ${JSON.stringify(mmsisOf(result))})`,
  )
  assert(!mmsisOf(result).includes('V7'), 'eligibility: unknown-type vessel never becomes a hero')
  assert(!mmsisOf(result).includes('V8'), 'eligibility: sogKn 0.4 vessel never becomes a hero')
}

// Scenario: a hero whose sogKn drops to 0 leaves at once and the next
// best (by rank, among the still-eligible non-heroes) fills the slot.
{
  const before = updateHeroes(
    createHeroState(),
    [
      candidate('V1', 'cruise', 5),
      candidate('V2', 'cargo', 15),
      candidate('V3', 'cargo', 5),
      candidate('V4', 'tanker', 20),
      candidate('V5', 'ferry', 8),
      candidate('V6', 'tugboat', 25),
    ],
    0,
  )
  assert(mmsisOf(before).includes('V4'), 'setup: V4 is a hero before it stops')

  const after = updateHeroes(
    before,
    [
      candidate('V1', 'cruise', 5),
      candidate('V2', 'cargo', 15),
      candidate('V3', 'cargo', 5),
      candidate('V4', 'tanker', 0), // stopped -- now ineligible
      candidate('V5', 'ferry', 8),
      candidate('V6', 'tugboat', 25),
    ],
    1000,
  )

  assert(!mmsisOf(after).includes('V4'), 'stopped hero: V4 leaves at once')
  assert(mmsisOf(after).includes('V5'), 'stopped hero: V5 (next best by rank) fills the freed slot')
  assert(after.slots.length === 4, 'stopped hero: still exactly 4 heroes')
}

// Scenario: stability -- no swap before a 10-minute hold, exactly one
// swap in the 60s after a hold is reached, no second swap inside that
// same 60s window, and a swapped-out vessel cannot return within its
// 10-minute cooldown even when it would otherwise outrank the
// replacement.
{
  const T0 = 0
  const T_FIVE_MIN = 300_000
  const T_JUST_AFTER_FIVE_MIN = 300_001
  const T_TEN_MIN_PLUS_1 = 600_001
  const T_THIRTY_S_LATER = 630_001
  // S-B/S-C/S-D's own sinceMs is 300000 (set in call2) -- they don't
  // individually reach a 10-minute hold until t=900000.
  const T_FIFTEEN_MIN_PLUS_1 = 900_001

  // t0: one eligible vessel (S-A) -- fills the only slot there is.
  const call1 = updateHeroes(createHeroState(), [candidate('S-A', 'cargo', 10)], T0)
  assert(JSON.stringify(mmsisOf(call1)) === JSON.stringify(['S-A']), 'stability setup: S-A alone at t0')

  // t=5min: 3 more eligible vessels arrive; slots fill to 4. S-A's
  // sinceMs (0) is now 5 minutes older than S-B/S-C/S-D's (300000).
  const call2 = updateHeroes(
    call1,
    [
      candidate('S-A', 'cargo', 10),
      candidate('S-B', 'tanker', 10),
      candidate('S-C', 'ferry', 10),
      candidate('S-D', 'tugboat', 10),
    ],
    T_FIVE_MIN,
  )
  assert(
    JSON.stringify(mmsisOf(call2)) === JSON.stringify(['S-A', 'S-B', 'S-C', 'S-D']),
    `stability setup: all 4 slots full (got ${JSON.stringify(mmsisOf(call2))})`,
  )

  // t=5min+1ms: a 5th eligible candidate (S-E) is available, and slots
  // are full, but nobody has held 10 minutes yet -- no swap.
  const call3 = updateHeroes(
    call2,
    [
      candidate('S-A', 'cargo', 10),
      candidate('S-B', 'tanker', 10),
      candidate('S-C', 'ferry', 10),
      candidate('S-D', 'tugboat', 10),
      candidate('S-E', 'naval', 10),
    ],
    T_JUST_AFTER_FIVE_MIN,
  )
  assert(
    JSON.stringify(mmsisOf(call3)) === JSON.stringify(['S-A', 'S-B', 'S-C', 'S-D']),
    `no swap before 10min hold (got ${JSON.stringify(mmsisOf(call3))})`,
  )
  assert(call3.lastSwapMs === null, 'no swap before 10min hold: lastSwapMs still null')

  // t=10min+1ms: S-A has now held for 600001ms (>= 10min); S-B/S-C/S-D
  // have held only 300001ms. S-A is the oldest hero and the only one
  // past the hold -- it swaps for S-E, the best-ranked non-hero.
  const call4 = updateHeroes(
    call3,
    [
      candidate('S-A', 'cargo', 10),
      candidate('S-B', 'tanker', 10),
      candidate('S-C', 'ferry', 10),
      candidate('S-D', 'tugboat', 10),
      candidate('S-E', 'naval', 10),
    ],
    T_TEN_MIN_PLUS_1,
  )
  assert(
    JSON.stringify(mmsisOf(call4).slice().sort()) === JSON.stringify(['S-B', 'S-C', 'S-D', 'S-E'].sort()),
    `swap after 10min hold: S-A replaced by S-E (got ${JSON.stringify(mmsisOf(call4))})`,
  )
  assert(call4.lastSwapMs === T_TEN_MIN_PLUS_1, 'swap after 10min hold: lastSwapMs recorded')

  // t=+30s: a 6th candidate (S-F) is available and S-A is technically
  // back in the pool, but the 60s swap throttle blocks any change.
  const call5 = updateHeroes(
    call4,
    [
      candidate('S-B', 'tanker', 10),
      candidate('S-C', 'ferry', 10),
      candidate('S-D', 'tugboat', 10),
      candidate('S-E', 'naval', 10),
      candidate('S-F', 'cruise', 10),
    ],
    T_THIRTY_S_LATER,
  )
  assert(
    JSON.stringify(mmsisOf(call5).slice().sort()) === JSON.stringify(['S-B', 'S-C', 'S-D', 'S-E'].sort()),
    `no second swap within 60s (got ${JSON.stringify(mmsisOf(call5))})`,
  )
  assert(call5.lastSwapMs === T_TEN_MIN_PLUS_1, 'no second swap within 60s: lastSwapMs unchanged')

  // t=15min+1ms (well past the 60s throttle, well inside S-A's
  // 10-minute cooldown which runs until 1200001). S-B has now held
  // 600001ms (>= 10min) and is the oldest surviving hero, so a swap is
  // otherwise due. Both S-A (cargo, size 120 -- would outrank S-F,
  // tugboat, size 70, if eligible) and S-F are offered as candidates --
  // S-A must be skipped for the cooldown, not because it lost on rank.
  const call6 = updateHeroes(
    call5,
    [
      candidate('S-A', 'cargo', 10), // on cooldown until 1200001
      candidate('S-B', 'tanker', 10),
      candidate('S-C', 'ferry', 10),
      candidate('S-D', 'tugboat', 10),
      candidate('S-E', 'naval', 10),
      candidate('S-F', 'tugboat', 10),
    ],
    T_FIFTEEN_MIN_PLUS_1,
  )
  assert(!mmsisOf(call6).includes('S-A'), 'cooldown: S-A cannot return within its 10-minute cooldown')
  assert(mmsisOf(call6).includes('S-F'), 'cooldown: S-F (not on cooldown) fills the swap instead of S-A')
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
