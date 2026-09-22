import { formatShipName, placeLabels, type LabelBoxSpec } from './labels'

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

// --- formatShipName ---

assert(
  formatShipName('  MSC VIRTUOSA@@@ ') === 'MSC VIRTUOSA',
  `formatShipName: "  MSC VIRTUOSA@@@ " -> "MSC VIRTUOSA" (got ${JSON.stringify(formatShipName('  MSC VIRTUOSA@@@ '))})`,
)
assert(
  formatShipName('@@@') === null,
  `formatShipName: "@@@" -> null (got ${JSON.stringify(formatShipName('@@@'))})`,
)
assert(formatShipName(undefined) === null, 'formatShipName: undefined -> null')
assert(formatShipName('') === null, 'formatShipName: empty string -> null')
assert(
  formatShipName('  MSC   VIRTUOSA  ') === 'MSC VIRTUOSA',
  'formatShipName: collapses internal whitespace runs',
)

// --- placeLabels ---

const FIXED_BOX = { width: 150, height: 80 }

// A hero 20px from the right edge of a 1920-wide canvas: NE (and SE)
// extend the label to the right, which cannot fit inside the 16px
// margin -- the chosen corner must be NW or SW.
{
  const heroes: LabelBoxSpec[] = [
    { mmsi: 'A', x: 1900, y: 540, length: 60, box: FIXED_BOX },
  ]
  const placed = placeLabels(heroes, 1920, 1080)
  assert(placed.length === 1, 'placeLabels: one placement returned for one hero')
  assert(
    placed[0].corner === 'NW' || placed[0].corner === 'SW',
    `placeLabels: hero near the right edge gets NW or SW, not NE (got ${placed[0]?.corner})`,
  )
  assert(placed[0].corner !== 'NE', 'placeLabels: hero near the right edge does not get NE')
}

// Two heroes 40px apart (well inside the canvas): their label boxes must
// not intersect, whichever corners get chosen. Independently
// reimplemented rectangle-intersection check, not imported from
// labels.ts, per the project's "independently recompute" evidence rule.
{
  function intersects(
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  }

  const heroes: LabelBoxSpec[] = [
    { mmsi: 'A', x: 500, y: 500, length: 60, box: FIXED_BOX },
    { mmsi: 'B', x: 540, y: 500, length: 60, box: FIXED_BOX },
  ]
  const placed = placeLabels(heroes, 1920, 1080)
  assert(placed.length === 2, 'placeLabels: two placements returned for two heroes')

  const rectA = { x: placed[0].boxX, y: placed[0].boxY, w: placed[0].boxWidth, h: placed[0].boxHeight }
  const rectB = { x: placed[1].boxX, y: placed[1].boxY, w: placed[1].boxWidth, h: placed[1].boxHeight }
  assert(
    !intersects(rectA, rectB),
    `placeLabels: two heroes 40px apart get non-intersecting label boxes (A=${JSON.stringify(rectA)}, B=${JSON.stringify(rectB)}, corners=${placed[0].corner}/${placed[1].corner})`,
  )
}

// No corner fits at all (a hero pinned into a corner of a tiny canvas)
// -> falls back to NE unconditionally.
{
  const heroes: LabelBoxSpec[] = [
    { mmsi: 'A', x: 10, y: 10, length: 20, box: FIXED_BOX },
  ]
  const placed = placeLabels(heroes, 60, 60)
  assert(placed[0].corner === 'NE', `placeLabels: no corner fits -> NE fallback (got ${placed[0]?.corner})`)
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
