/**
 * LANDING-HERO — the marketing page's hero canvas.
 *
 * What is on screen here is Wake's real renderer, not a re-creation of
 * its look: every glyph, trail, hero label, glow, range ring, radar sweep,
 * legend and area title below is drawn by apps/display's own modules,
 * imported and called with different arguments. The vessel data is a real
 * recorded Dover Strait AIS window replayed through the display's own
 * client code (see heroReplay.ts).
 *
 * It opens no socket, reads no key and makes no request of any kind. The
 * recorded window is compiled into this bundle as JSON, so the page needs
 * no server and there is nothing here that could carry a credential.
 *
 * THE COASTLINE (LANDING-HERO-2) is VIS-9's, drawn from geometry baked out
 * of the same PMTiles archive at build time rather than from maplibre-gl
 * streaming tiles at runtime -- see heroBasemap.ts and the review file's
 * B1. The look is VIS-9's own: LAND_LEVELS, the same `earth` layer, the
 * same fill-plus-1px-coastline treatment, projected by the same
 * projection the ships use. The place names and the OpenStreetMap credit
 * are drawn by the display's own functions, unchanged.
 */
import {
  DEFAULT_CONFIG,
  DEMO_AREAS,
  basemapAreaFor,
  type DisplayConfig,
  type ProjectionConfig,
} from '@wake/shared'
import { createTrackedVesselMap, renderFrame } from '../../apps/display/src/vesselTracker'
import type { VesselStateMap } from '../../apps/display/src/wakeSocket'
import { drawAttribution, drawPlaceNames } from '../../apps/display/src/canvas/placeNames'
import { HeroReplay, type HeroReplayData } from './heroReplay'
import { drawHeroBasemap, projectHeroBasemap, type HeroBasemapData, type ProjectedBasemap } from './heroBasemap'
import replayData from './heroReplay.data.json'
import basemapData from './heroBasemap.data.json'

const AREA = DEMO_AREAS.dover
const BASEMAP_AREA = basemapAreaFor('dover')

/**
 * The SAME mirror the display runs with. The ceiling display renders
 * mirrored so the image reads correctly after bouncing off a mirror, and
 * landing/hero-dover.png -- the screenshot this canvas replaces, and the
 * framing the page was written around -- is mirrored too: in it Calais
 * sits left of Dover, where unmirrored it would sit right.
 *
 * So this is geographically flipped, on purpose, because the page's claim
 * is "this is the actual display" and the actual display looks like this.
 * Setting mirrorX to false here is the one-line change if that judgement
 * is ever reversed; nothing else depends on it.
 */
const PROJ_CONFIG: ProjectionConfig = {
  mirrorX: DEFAULT_CONFIG.mirrorX,
  rotationDeg: DEFAULT_CONFIG.rotationDeg,
}

/** The approved screenshot's aspect: 1920 x 890. */
const HERO_ASPECT = 1920 / 890
const MAX_DPR = 2

/**
 * One frame's deltaMs immediately after a prime. smoothingAlpha(0.18,
 * 10000) is 1 - 0.82^599.9, which is 1 to far beyond double precision, so
 * this snaps every vessel from its first primed fix to its current
 * dead-reckoned position in a single frame. Without it the fleet visibly
 * flies across the strait on load: applyFix keeps the PREVIOUS display
 * position when a vessel already exists, so after 15 minutes of fixes
 * applied in one instant, every vessel's drawn position is still where it
 * was at the start of the primed window and would ease forward from there.
 */
const SNAP_DELTA_MS = 10_000

/** A normal frame's delta at 60fps, used for the single reduced-motion frame. */
const ONE_FRAME_MS = 1000 / 60

const config: DisplayConfig = DEFAULT_CONFIG

export function startHero(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}

  const tracked = createTrackedVesselMap()
  const clientState: VesselStateMap = new Map()
  const replay = new HeroReplay({
    data: replayData as unknown as HeroReplayData,
    tracked,
    clientState,
  })

  // The basemap depends only on canvas size, so it is projected once per
  // resize and then painted from a cached offscreen canvas -- one
  // drawImage per frame instead of replaying ~10,000 path operations.
  // Where no offscreen canvas can be made, the very same drawHeroBasemap
  // runs inline each frame; there is one drawing implementation, and only
  // where its output lands differs.
  let projectedBasemap: ProjectedBasemap | null = null
  let basemapCache: HTMLCanvasElement | null = null

  const rebuildBasemap = () => {
    projectedBasemap = projectHeroBasemap(basemapData as unknown as HeroBasemapData, {
      centerLat: AREA.centerLat,
      centerLon: AREA.centerLon,
      radiusNm: AREA.radiusNm,
      projConfig: PROJ_CONFIG,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    })

    basemapCache = null
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return
    const offscreen = document.createElement('canvas')
    offscreen.width = canvas.width
    offscreen.height = canvas.height
    const offCtx = offscreen.getContext('2d')
    if (!offCtx) return
    drawHeroBasemap(offCtx, projectedBasemap, config.basemapLand, canvas.width)
    basemapCache = offscreen
  }

  // The page's own CSS already sizes this element: `.hero-frame canvas`
  // is width 100% / height auto, exactly as the <img> it replaces was, so
  // the displayed height follows the backing store's aspect and no style
  // is set from here. Only the backing store is touched, at device pixel
  // ratio (capped) so the glyphs are sharp on a retina screen.
  const resize = () => {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR)
    const cssWidth = canvas.clientWidth || canvas.parentElement?.clientWidth || 1100
    canvas.width = Math.round(cssWidth * dpr)
    canvas.height = Math.round((cssWidth / HERO_ASPECT) * dpr)
    rebuildBasemap()
  }

  const drawFrame = (nowMs: number, deltaMs: number) => {
    // WakeCanvas's paintBlack. On the display the basemap lives on its own
    // element UNDER the canvas and this becomes a clearRect; here the
    // basemap is drawn onto the same canvas, so the black stays and the
    // land goes straight on top of it. Water is black in VIS-9's style
    // too, so this fill IS the water.
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    if (config.basemapEnabled) {
      if (basemapCache !== null) {
        ctx.drawImage(basemapCache, 0, 0)
      } else if (projectedBasemap !== null) {
        drawHeroBasemap(ctx, projectedBasemap, config.basemapLand, canvas.width)
      }
    }

    if (BASEMAP_AREA !== undefined && config.placeNamesEnabled) {
      drawPlaceNames(
        ctx,
        BASEMAP_AREA.places,
        AREA.centerLat,
        AREA.centerLon,
        AREA.radiusNm,
        PROJ_CONFIG,
        canvas.width,
        canvas.height,
      )
    }

    renderFrame(tracked, clientState, ctx, {
      centerLat: AREA.centerLat,
      centerLon: AREA.centerLon,
      radiusNm: AREA.radiusNm,
      projConfig: PROJ_CONFIG,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      nowMs,
      deltaMs,
      config,
      areaDisplayName: AREA.displayName,
    })

    if (BASEMAP_AREA !== undefined) {
      drawAttribution(ctx, canvas.width, canvas.height)
    }
  }

  resize()

  const startMs = Date.now()
  replay.prime(startMs)

  const reducedMotion =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (reducedMotion) {
    // One real frame from the real renderer over the real recorded data,
    // and then nothing moves. A still frame of the genuine article is
    // still honest; an animation someone asked not to see is not.
    drawFrame(startMs, SNAP_DELTA_MS)
    drawFrame(Date.now(), ONE_FRAME_MS)
    globalThis.addEventListener('resize', resize)
    return () => globalThis.removeEventListener('resize', resize)
  }

  let animationId = 0
  let running = false
  let lastFrameMs = startMs
  let pendingSnap = true

  const loop = () => {
    const nowMs = Date.now()
    const deltaMs = pendingSnap ? SNAP_DELTA_MS : nowMs - lastFrameMs
    pendingSnap = false
    lastFrameMs = nowMs

    replay.advance(nowMs)
    drawFrame(nowMs, deltaMs)

    animationId = globalThis.requestAnimationFrame(loop)
  }

  const start = () => {
    if (running) return
    running = true
    // A pause of any length leaves lastFrameMs in the past; without this
    // the first frame back would carry the whole paused interval as its
    // delta and snap every vessel forward at once.
    lastFrameMs = Date.now()
    animationId = globalThis.requestAnimationFrame(loop)
  }

  const stop = () => {
    if (!running) return
    running = false
    globalThis.cancelAnimationFrame(animationId)
  }

  // A hero the visitor has scrolled past should not keep a canvas
  // repainting at 60fps. The replay clock is wall-clock, so the scene is
  // simply further along when they scroll back -- exactly as a live
  // display would be.
  let observer: IntersectionObserver | undefined
  if (typeof globalThis.IntersectionObserver === 'function') {
    observer = new globalThis.IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) start()
        else stop()
      }
    })
    observer.observe(canvas)
  } else {
    start()
  }

  globalThis.addEventListener('resize', resize)

  return () => {
    stop()
    observer?.disconnect()
    globalThis.removeEventListener('resize', resize)
  }
}

const canvas = document.getElementById('hero-canvas')
if (canvas instanceof HTMLCanvasElement) {
  startHero(canvas)
}
