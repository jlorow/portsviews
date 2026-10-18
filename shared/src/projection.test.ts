import { mapProject, skyProject, screenHeadingDeg } from './projection.ts'
import { parseMirrorParam } from './mirrorParam.ts'

let passCount = 0
let failCount = 0

function test(name: string, condition: boolean, details?: string) {
  if (condition) {
    passCount++
    console.log(`[Pass] ${name}`)
  } else {
    failCount++
    console.log(`[FAIL] ${name}${details ? ' — ' + details : ''}`)
  }
}

// Common setup
const centerLat = 51.0
const centerLon = 1.0
const radiusNm = 50
const canvasWidth = 1920
const canvasHeight = 1080

// ── mapProject tests ──

// Test 1 — center point maps to canvas center
const t1 = mapProject(51.0, 1.0, centerLat, centerLon, radiusNm, { mirrorX: false, rotationDeg: 0 }, canvasWidth, canvasHeight)
test(
  'mapProject center point',
  t1 !== null && Math.abs(t1.x - 960) <= 1 && Math.abs(t1.y - 540) <= 1,
  t1 ? `got {x: ${t1.x.toFixed(2)}, y: ${t1.y.toFixed(2)}}` : 'got null',
)

// Test 2 — point directly north by 25nm maps to top half
const t2 = mapProject(51.4167, 1.0, centerLat, centerLon, radiusNm, { mirrorX: false, rotationDeg: 0 }, canvasWidth, canvasHeight)
test(
  'mapProject 25nm north y < 540',
  t2 !== null && t2.y < 540,
  t2 ? `got y=${t2.y.toFixed(2)}` : 'got null',
)
test(
  'mapProject 25nm north x ≈ 960',
  t2 !== null && Math.abs(t2.x - 960) <= 1,
  t2 ? `got x=${t2.x.toFixed(2)}` : 'got null',
)

// Test 3 — point outside radius returns null
const t3 = mapProject(52.0, 5.0, centerLat, centerLon, radiusNm, { mirrorX: false, rotationDeg: 0 }, canvasWidth, canvasHeight)
test(
  'mapProject outside radius returns null',
  t3 === null,
  t3 ? `got {x: ${t3.x.toFixed(2)}, y: ${t3.y.toFixed(2)}}` : 'got null',
)

// Test 4 — mirrorX=true flips x around canvas center
const t4Center = mapProject(51.0, 1.0, centerLat, centerLon, radiusNm, { mirrorX: true, rotationDeg: 0 }, canvasWidth, canvasHeight)
test(
  'mapProject mirrorX center unchanged',
  t4Center !== null && Math.abs(t4Center.x - 960) <= 1 && Math.abs(t4Center.y - 540) <= 1,
  t4Center ? `got {x: ${t4Center.x.toFixed(2)}, y: ${t4Center.y.toFixed(2)}}` : 'got null',
)

// Point east of center: 0.5 deg east
const t4EastNoMirror = mapProject(51.0, 1.5, centerLat, centerLon, radiusNm, { mirrorX: false, rotationDeg: 0 }, canvasWidth, canvasHeight)
const t4EastMirror = mapProject(51.0, 1.5, centerLat, centerLon, radiusNm, { mirrorX: true, rotationDeg: 0 }, canvasWidth, canvasHeight)
const x1 = t4EastNoMirror?.x ?? 0
const x2 = t4EastMirror?.x ?? 0
test(
  'mapProject mirrorX flips east point',
  t4EastNoMirror !== null && t4EastMirror !== null && Math.abs(x1 + x2 - 1920) <= 1,
  `x1=${x1.toFixed(2)}, x2=${x2.toFixed(2)}, sum=${(x1 + x2).toFixed(2)}`,
)

// Test 8 — isotropic scale: equal real-world distances east-west and
// north-south project to equal pixel distances, on a deliberately
// non-square canvas. This is the exact shape the S1.8 diagnostic found
// broken (47.625 vs 22.225 px/nm at 1905x889) -- the prior 10 assertions
// never varied width and height independently, which is why it was
// invisible.
const wideCanvasW = 1905
const wideCanvasH = 889
const wideRadiusNm = 20

// 5nm east and 5nm north of center, in degrees.
const nmToLatDeg = 5 / 60
const nmToLonDeg = 5 / (60 * Math.cos((centerLat * Math.PI) / 180))

const eastOrigin = mapProject(centerLat, centerLon, centerLat, centerLon, wideRadiusNm, { mirrorX: false, rotationDeg: 0 }, wideCanvasW, wideCanvasH)
const eastPoint = mapProject(centerLat, centerLon + nmToLonDeg, centerLat, centerLon, wideRadiusNm, { mirrorX: false, rotationDeg: 0 }, wideCanvasW, wideCanvasH)
const northPoint = mapProject(centerLat + nmToLatDeg, centerLon, centerLat, centerLon, wideRadiusNm, { mirrorX: false, rotationDeg: 0 }, wideCanvasW, wideCanvasH)

const eastPxDist = eastOrigin !== null && eastPoint !== null ? Math.hypot(eastPoint.x - eastOrigin.x, eastPoint.y - eastOrigin.y) : NaN
const northPxDist = eastOrigin !== null && northPoint !== null ? Math.hypot(northPoint.x - eastOrigin.x, northPoint.y - eastOrigin.y) : NaN

test(
  'mapProject isotropic: 5nm east and 5nm north give equal pixel distances on a non-square canvas',
  Number.isFinite(eastPxDist) && Number.isFinite(northPxDist) && Math.abs(eastPxDist - northPxDist) <= 0.01,
  `eastPxDist=${eastPxDist.toFixed(3)}, northPxDist=${northPxDist.toFixed(3)}`,
)

// Test 9 — the full radiusNm fits within the smaller canvas dimension.
// A point just inside radiusNm north (99.9%, to stay clear of float
// rounding exactly at the distanceNm > radiusNm boundary -- the axis
// constrained by the smaller dimension, since wideCanvasH < wideCanvasW)
// must land within the canvas bounds, not clipped off the top.
const edgeNorth = mapProject(centerLat + (wideRadiusNm * 0.999) / 60, centerLon, centerLat, centerLon, wideRadiusNm, { mirrorX: false, rotationDeg: 0 }, wideCanvasW, wideCanvasH)
test(
  'mapProject 20nm radius fits within the smaller (height) dimension on a non-square canvas',
  edgeNorth !== null && edgeNorth.y >= 0 && edgeNorth.y <= 1,
  edgeNorth ? `got y=${edgeNorth.y.toFixed(2)}, canvasHeight=${wideCanvasH}` : 'got null',
)

// Test 10 — a point beyond the radius still returns null on a non-square
// canvas (the distanceNm-vs-radiusNm gate is in real-world nm, computed
// before any pixel scale is applied, so it must be unaffected by the
// isotropic-scale change).
const beyondWide = mapProject(centerLat + 1.0, centerLon + 1.0, centerLat, centerLon, wideRadiusNm, { mirrorX: false, rotationDeg: 0 }, wideCanvasW, wideCanvasH)
test(
  'mapProject beyond radius still returns null on a non-square canvas',
  beyondWide === null,
  beyondWide ? `got {x: ${beyondWide.x.toFixed(2)}, y: ${beyondWide.y.toFixed(2)}}` : 'got null',
)

// ── skyProject tests ──

// Test 5 — zenith maps to canvas center
const t5 = skyProject(0, 90, { mirrorX: false, rotationDeg: 0 }, canvasWidth, canvasHeight)
test(
  'skyProject zenith at center',
  t5 !== null && Math.abs(t5.x - 960) <= 1 && Math.abs(t5.y - 540) <= 1,
  t5 ? `got {x: ${t5.x.toFixed(2)}, y: ${t5.y.toFixed(2)}}` : 'got null',
)

// Test 6 — below horizon returns null
const t6 = skyProject(0, -1, { mirrorX: false, rotationDeg: 0 }, canvasWidth, canvasHeight)
test(
  'skyProject below horizon returns null',
  t6 === null,
  t6 ? `got {x: ${t6.x.toFixed(2)}, y: ${t6.y.toFixed(2)}}` : 'got null',
)

// Test 7 — due north on horizon maps to top edge
const t7 = skyProject(0, 0, { mirrorX: false, rotationDeg: 0 }, canvasWidth, canvasHeight)
test(
  'skyProject north horizon y < 540',
  t7 !== null && t7.y < 540,
  t7 ? `got y=${t7.y.toFixed(2)}` : 'got null',
)
test(
  'skyProject north horizon x ≈ 960',
  t7 !== null && Math.abs(t7.x - 960) <= 1,
  t7 ? `got x=${t7.x.toFixed(2)}` : 'got null',
)

// ── screenHeadingDeg tests ──
// Hardcoded expected values, independently measured against the live
// render path in the VIS-1 round-3 audit (CLAUDE.md Correction 18),
// never derived by calling the function under test. Vessel fixed at the
// view centre; tolerance 0.01deg per the signed-off VIS-1 spec.

const headingCenterLat = 51.0
const headingCenterLon = 1.0
const headingRadiusNm = 50
const headingCanvasWidth = 1920
const headingCanvasHeight = 1080

function testHeading(
  name: string,
  mirrorX: boolean,
  rotationDeg: number,
  cogDeg: number,
  expectedDeg: number,
) {
  const got = screenHeadingDeg(
    headingCenterLat,
    headingCenterLon,
    cogDeg,
    headingCenterLat,
    headingCenterLon,
    headingRadiusNm,
    { mirrorX, rotationDeg },
    headingCanvasWidth,
    headingCanvasHeight,
  )
  test(name, Math.abs(got - expectedDeg) <= 0.01, `got ${got.toFixed(4)}, expected ${expectedDeg}`)
}

// Round 3 table: mirrorX false, rotationDeg 0 -- identity.
testHeading('screenHeadingDeg mirrorX=false rot=0 cog=0', false, 0, 0, 0)
testHeading('screenHeadingDeg mirrorX=false rot=0 cog=45', false, 0, 45, 45)
testHeading('screenHeadingDeg mirrorX=false rot=0 cog=90', false, 0, 90, 90)
testHeading('screenHeadingDeg mirrorX=false rot=0 cog=180', false, 0, 180, 180)
testHeading('screenHeadingDeg mirrorX=false rot=0 cog=270', false, 0, 270, 270)

// Round 3 table: mirrorX false, rotationDeg 90.
testHeading('screenHeadingDeg mirrorX=false rot=90 cog=0', false, 90, 0, 90)
testHeading('screenHeadingDeg mirrorX=false rot=90 cog=45', false, 90, 45, 135)
testHeading('screenHeadingDeg mirrorX=false rot=90 cog=90', false, 90, 90, 180)
testHeading('screenHeadingDeg mirrorX=false rot=90 cog=180', false, 90, 180, 270)
testHeading('screenHeadingDeg mirrorX=false rot=90 cog=270', false, 90, 270, 0)

// Round 3 table: mirrorX true, rotationDeg 0 -- DEFAULT_CONFIG's shape.
testHeading('screenHeadingDeg mirrorX=true rot=0 cog=0', true, 0, 0, 0)
testHeading('screenHeadingDeg mirrorX=true rot=0 cog=45', true, 0, 45, 315)
testHeading('screenHeadingDeg mirrorX=true rot=0 cog=90', true, 0, 90, 270)
testHeading('screenHeadingDeg mirrorX=true rot=0 cog=180', true, 0, 180, 180)
testHeading('screenHeadingDeg mirrorX=true rot=0 cog=270', true, 0, 270, 90)

// Round 3 table: mirrorX true, rotationDeg 90.
testHeading('screenHeadingDeg mirrorX=true rot=90 cog=0', true, 90, 0, 90)
testHeading('screenHeadingDeg mirrorX=true rot=90 cog=45', true, 90, 45, 45)
testHeading('screenHeadingDeg mirrorX=true rot=90 cog=90', true, 90, 90, 0)
testHeading('screenHeadingDeg mirrorX=true rot=90 cog=180', true, 90, 180, 270)
testHeading('screenHeadingDeg mirrorX=true rot=90 cog=270', true, 90, 270, 180)

// Non-right-angle rotationDeg, both mirror states, from the prompt spec.
testHeading('screenHeadingDeg mirrorX=false rot=37 cog=10', false, 37, 10, 47)
testHeading('screenHeadingDeg mirrorX=false rot=37 cog=200', false, 37, 200, 237)
testHeading('screenHeadingDeg mirrorX=true rot=37 cog=10', true, 37, 10, 27)
testHeading('screenHeadingDeg mirrorX=true rot=37 cog=200', true, 37, 200, 197)

// Fallback case: vessel already outside radiusNm, so mapProject's origin
// call returns null and screenHeadingDeg must fall back to the
// config-transformed cogDeg rather than projecting anything. Expected:
// normalizeDeg(-45 + 10) = 325 (mirrorX true negates cogDeg first).
const fallbackLat = headingCenterLat + (headingRadiusNm * 2) / 60
const fallbackHeading = screenHeadingDeg(
  fallbackLat,
  headingCenterLon,
  45,
  headingCenterLat,
  headingCenterLon,
  headingRadiusNm,
  { mirrorX: true, rotationDeg: 10 },
  headingCanvasWidth,
  headingCanvasHeight,
)
test(
  'screenHeadingDeg fallback: vessel outside radiusNm falls back to config-transformed cogDeg',
  Math.abs(fallbackHeading - 325) <= 0.01,
  `got ${fallbackHeading.toFixed(4)}`,
)

// ── ?mirror=off: the picture the right way round ──
// The config WakeCanvas builds from ?mirror=off.

const mirrorOff = { mirrorX: parseMirrorParam('off'), rotationDeg: 0 }
test('mirror off: ?mirror=off gives mirrorX false', mirrorOff.mirrorX === false)

const eastOff = mapProject(51.0, 1.5, centerLat, centerLon, radiusNm, mirrorOff, canvasWidth, canvasHeight)
test(
  'mirror off: mapProject puts a point east of centre right of centre (x > 960)',
  eastOff !== null && eastOff.x > canvasWidth / 2,
  eastOff ? `got x=${eastOff.x.toFixed(2)}` : 'got null',
)

const westOff = mapProject(51.0, 0.5, centerLat, centerLon, radiusNm, mirrorOff, canvasWidth, canvasHeight)
test(
  'mirror off: mapProject puts a point west of centre left of centre (x < 960)',
  westOff !== null && westOff.x < canvasWidth / 2,
  westOff ? `got x=${westOff.x.toFixed(2)}` : 'got null',
)

const cog90Off = screenHeadingDeg(centerLat, centerLon, 90, centerLat, centerLon, radiusNm, mirrorOff, canvasWidth, canvasHeight)
test(
  'mirror off: screenHeadingDeg COG 90 points right on screen (90 deg from screen-up)',
  Math.abs(cog90Off - 90) < 0.5,
  `got ${cog90Off.toFixed(4)}`,
)

// ── Summary ──
const total = passCount + failCount
if (failCount === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failCount}/${total} tests failed`)
}
