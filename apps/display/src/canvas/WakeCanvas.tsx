import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_BROADCAST_PORT,
  DEFAULT_CONFIG,
  DEMO_AREAS,
  clampPanToFeed,
  handlePanKeydown,
  applyWheelAtPointer,
  applyDrag,
  parseLocalAreas,
  parsePort,
  radiusStepsFor,
  resolveArea,
  basemapFor,
  stepRadius,
  zoomKeyAction,
  type DemoAreaKey,
  type DisplayConfig,
  type LocalAreasFile,
} from '@wake/shared'
import ConnectionIndicator from '../ConnectionIndicator'
import {
  WakeConnection,
  type ConnectionStatus,
  type VesselStateMap,
  type WakeSocketLike,
} from '../wakeSocket'
import { createTrackedVesselMap, onFixArrived, renderFrame } from '../vesselTracker'
import { mountBasemap, type BasemapHandle } from '../basemap/basemapMount'
import { drawAttribution, drawPlaceNames } from './placeNames'
import { FPS_WINDOW_MS, applyTuneKey, tuneOverlayText } from './tuneOverlay'
import { createCoalescedRunner } from './resizeCoalescer'

let localAreas: LocalAreasFile | null = null
try {
  const rawLocal = import.meta.env.WAKE_LOCAL_AREAS
  if (rawLocal && rawLocal !== 'undefined') {
    const parsed = JSON.parse(rawLocal)
    const result = parseLocalAreas(parsed)
    if (!result.ok) {
      console.warn(`[Wake] Ignoring invalid WAKE_LOCAL_AREAS: ${result.errors.join('; ')}`)
    } else {
      localAreas = result.value
    }
  }
} catch (error) {
  console.warn(`[Wake] Failed to parse WAKE_LOCAL_AREAS: ${(error as Error).message}`)
}

// DEMO-1: view centre and radius come from DEMO_AREAS (@wake/shared) for
// the area key injected from the repo-root .env — vite.config.ts defines
// import.meta.env.WAKE_AREA and nothing else from that file. Unset/blank
// means dover; an invalid key falls back to dover with ONE console
// warning at module load.
const RESOLVED_AREA = resolveArea(import.meta.env.WAKE_AREA, localAreas)
if (RESOLVED_AREA === null) {
  console.warn(
    `[Wake] Invalid WAKE_AREA ${JSON.stringify(import.meta.env.WAKE_AREA)} -- expected one of: ${[...Object.keys(DEMO_AREAS), ...(localAreas?.areas ? Object.keys(localAreas.areas) : [])].join(', ')}. Using dover.`,
  )
}
const areaKey = RESOLVED_AREA?.key ?? 'dover'
const AREA = RESOLVED_AREA?.area ?? DEMO_AREAS[areaKey as DemoAreaKey]

// VIS-9: the basemap for this area, or undefined if no tile extract exists
// for it. Only dover ships one; every other area draws exactly what it
// drew before that story -- pure black, no MapLibre context created at all.
const BASEMAP_AREA = basemapFor(areaKey, localAreas)

// The area's own centre and radius. These are the CONSTANTS a reset returns
// to and the reference the ?tune=1 overlay measures the view's offset
// against; the LIVE view is viewRef, below, and nothing draws from these.
// AREA.boundingBoxes is the box the live feed covers, which is what
// clampPanToFeed keeps the view inside.
const AREA_CENTRE_LAT = AREA.centerLat
const AREA_CENTRE_LON = AREA.centerLon
const AREA_RADIUS_NM = AREA.radiusNm
const FEED_BOX = AREA.boundingBoxes

// VIS-9: ONE projection config, read by mapProject (through renderFrame),
// by the place-name text, and by the basemap container's CSS transform.
// The mirror is not a second flag the basemap keeps in step with
// DEFAULT_CONFIG -- it is the same object, and basemapContainerTransform
// derives `scaleX(-1)` from the same `mirrorX` mapProject reads.
const PROJ_CONFIG = { mirrorX: DEFAULT_CONFIG.mirrorX, rotationDeg: DEFAULT_CONFIG.rotationDeg }

// VIS-6: ?tune=1 enables an on-screen toggle overlay for heroes/glow/
// rings/hero-size, for the ceiling look session. Read once at module
// load, same pattern as AREA_KEY -- this component only ever mounts once.
const TUNE_MODE = new URLSearchParams(globalThis.location.search).get('tune') === '1'

// The runtime view: where the display is looking and how far out. One ref,
// read every frame by every consumer, so a pan or a zoom needs no React
// re-render and no second copy of the centre anywhere.
interface WakeView {
  centerLat: number
  centerLon: number
  radiusNm: number
}

// window.location.hostname rather than a hardcoded 'localhost' -- the
// display and the server are not guaranteed to be the same machine.
// Port is read from an env var, not hardcoded. The default is the SAME
// shared constant the server falls back to (DEFAULT_BROADCAST_PORT), so
// the two ends can never disagree: blank is unset, and an invalid value
// warns once and takes the default instead of building a URL with it.
function buildServerUrl(): string {
  const portResult = parsePort(
    import.meta.env.VITE_WAKE_BROADCAST_PORT,
    DEFAULT_BROADCAST_PORT,
    'VITE_WAKE_BROADCAST_PORT',
  )
  if (!portResult.ok) {
    console.warn(`[Wake] ${portResult.error}`)
  }
  const port = portResult.ok ? portResult.value : DEFAULT_BROADCAST_PORT
  return `ws://${globalThis.location.hostname}:${port}`
}

// The real browser WebSocket satisfies WakeSocketLike structurally --
// no adapter needed, only the type assertion TypeScript requires because
// the global lib.dom.d.ts type isn't literally the same declaration.
function createBrowserSocket(url: string): WakeSocketLike {
  return new WebSocket(url) as unknown as WakeSocketLike
}

// A key event aimed at a text field belongs to that field, not to us.
// Extracted because three listeners now share this rule.
function targetIsEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

export default function WakeCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const vesselStateRef = useRef<VesselStateMap>(new Map())
  const trackedRef = useRef(createTrackedVesselMap())
  // One runtime view for the whole display: centre and radius together, so a
  // zoom can also re-clamp the centre (zooming out shrinks the room to pan)
  // and a reset can put both back at once.
  const viewRef = useRef<WakeView>({
    centerLat: AREA_CENTRE_LAT,
    centerLon: AREA_CENTRE_LON,
    radiusNm: AREA_RADIUS_NM,
  })
  // Wheel steps are rate-limited: the last step's time, in the same clock
  // wheelZoomAction is handed. 0 means "no step yet this session".
  const lastWheelStepMsRef = useRef(0)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const isDraggingRef = useRef(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')

  // VIS-6 tune mode: a runtime copy of DEFAULT_CONFIG the H/W/R/J keys
  // mutate directly (never DEFAULT_CONFIG itself, never persisted). A
  // ref, not state -- the render loop reads it every frame already and
  // doesn't need a re-render to pick a change up.
  const configRef = useRef<DisplayConfig>(DEFAULT_CONFIG)
  // VIS-9 part 2: null until the first FPS window has closed, so the
  // overlay can say "--" rather than a literal 0 that reads as a crash.
  const fpsRef = useRef<number | null>(null)
  // FLAGGED as scope beyond VIS-9's prompt, and kept because A0(d) is an
  // FPS measurement: CLAUDE.md's open follow-up 7 records that the VIS-8
  // ceiling look reported FPS 21 with the session's vessel count NOT
  // recorded, which left a denser area as an equally live explanation. One
  // ref, shown beside FPS in the ?tune=1 overlay, so the next look's
  // number is interpretable.
  const vesselCountRef = useRef(0)
  const basemapRef = useRef<BasemapHandle | null>(null)
  const [overlayText, setOverlayText] = useState('')

  useEffect(() => {
    const connection = new WakeConnection(
      buildServerUrl(),
      vesselStateRef.current,
      createBrowserSocket,
      undefined,
      undefined,
      {
        onStatusChange: setConnectionStatus,
        // history is defined only for a fix that arrived inside the
        // connect snapshot (route history v1), and seeds that vessel's
        // trail so a reload shows full wakes immediately.
        onFix: (fix, history) => onFixArrived(trackedRef.current, fix, history),
      },
    )
    connection.connect()

    return () => {
      connection.stop()
    }
  }, [])

  // VIS-6 tune mode: H/W/R toggle heroesEnabled/glowEnabled/rangeRingsEnabled,
  // J cycles heroScale through HERO_SCALES. VIS-7 adds L (labelSize), T
  // (areaTitleEnabled), U (unknownScale), B (sweepPeriodSec). VIS-8 adds
  // D (stoppedAsDot), K (legendEnabled) and G (glyphScale -- a dev-only
  // comparison key for the look, NOT S7.4's planned user-facing toggle).
  // VIS-9 adds M (basemapEnabled), F (basemapLand) and N (placeNamesEnabled).
  // This tune-key listener exists only inside ?tune=1; zoom, pan and wheel
  // keys are handled by separate listeners below.
  //
  // VIS-9 part 2 moved the mapping itself into tuneOverlay.ts's
  // applyTuneKey, which is pure and therefore testable -- a React key
  // handler is not. It also ignores auto-repeat events, so a held key acts
  // once per physical press; see that function's comment and CLAUDE.md's
  // Correction 27 for what a held F key did to the ceiling look.
  useEffect(() => {
    if (!TUNE_MODE) return

    const handleKeyDown = (event: KeyboardEvent) => {
      configRef.current = applyTuneKey(configRef.current, event)
    }

    globalThis.addEventListener('keydown', handleKeyDown)
    return () => globalThis.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Zoom keys, arrow keys and the mouse wheel. All three move viewRef and
  // then push the result to the basemap camera; nothing here re-renders
  // React, because the canvas reads viewRef every frame anyway.
  //
  // Deliberately NOT behind TUNE_MODE: zooming is part of the display, and
  // the same keys are what the README documents.
  useEffect(() => {
    const applyView = () => {
      const view = viewRef.current
      basemapRef.current?.setView(view.centerLat, view.centerLon, view.radiusNm)
    }

    const zoomBy = (direction: 'in' | 'out') => {
      const view = viewRef.current
      const nextRadiusNm = stepRadius(radiusStepsFor(AREA_RADIUS_NM), view.radiusNm, direction)
      // Zooming out takes room away from the centre, so the clamp is
      // re-applied on every step, not only on a pan: zoom out while panning
      // far out and the view must slide back inside the feed box.
      const clamped = clampPanToFeed(view.centerLat, view.centerLon, nextRadiusNm, FEED_BOX)
      viewRef.current = {
        centerLat: clamped.centerLat,
        centerLon: clamped.centerLon,
        radiusNm: nextRadiusNm,
      }
      applyView()
    }

    const handleZoomKeyDown = (event: KeyboardEvent) => {
      const action = zoomKeyAction({
        key: event.key,
        repeat: event.repeat,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        targetIsEditable: targetIsEditable(event.target),
      })
      if (action === null) return

      event.preventDefault()
      if (action === 'reset') {
        // '0' resets zoom AND pan, both halves of the view.
        viewRef.current = {
          centerLat: AREA_CENTRE_LAT,
          centerLon: AREA_CENTRE_LON,
          radiusNm: AREA_RADIUS_NM,
        }
        applyView()
        return
      }
      zoomBy(action)
    }

    // Arrow keys pan. Key repeat is ALLOWED here (panKeyAction passes it
    // through on purpose): holding an arrow keeps the view moving.
    const handlePanKeyDown = (event: KeyboardEvent) => {
      const result = handlePanKeydown(
        viewRef.current,
        {
          key: event.key,
          repeat: event.repeat,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          targetIsEditable: targetIsEditable(event.target),
        },
        FEED_BOX,
        PROJ_CONFIG,
      )
      if (!result.handled) return
      event.preventDefault()
      viewRef.current = result.view
      applyView()
    }

    // passive: false because a wheel step we act on must also be prevented
    // from scrolling the page. A step we ignore (Ctrl/Alt/Cmd, a sub-1
    // delta, or one inside the 300ms window) is never prevented.
    const handleWheel = (event: WheelEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const scaleX = canvas.width / rect.width
      const scaleY = canvas.height / rect.height
      const pointerX = (event.clientX - rect.left) * scaleX
      const pointerY = (event.clientY - rect.top) * scaleY
      const result = applyWheelAtPointer(
        viewRef.current,
        event,
        Date.now(),
        lastWheelStepMsRef.current,
        radiusStepsFor(AREA_RADIUS_NM),
        FEED_BOX,
        PROJ_CONFIG,
        canvas.width,
        canvas.height,
        pointerX,
        pointerY,
      )
      if (result.view === viewRef.current) return
      event.preventDefault()
      lastWheelStepMsRef.current = result.lastStepMs
      viewRef.current = result.view
      applyView()
    }

    const handlePointerDown = (event: PointerEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.button !== 0 && event.pointerType !== 'touch') return
      if (targetIsEditable(event.target)) return
      const rect = canvas.getBoundingClientRect()
      const scaleX = canvas.width / rect.width
      const scaleY = canvas.height / rect.height
      dragRef.current = {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
      }
      isDraggingRef.current = true
      canvas.setPointerCapture(event.pointerId)
      canvas.style.cursor = 'grabbing'
    }

    const handlePointerMove = (event: PointerEvent) => {
      const canvas = canvasRef.current
      if (!canvas || !isDraggingRef.current || dragRef.current === null) return
      const rect = canvas.getBoundingClientRect()
      const scaleX = canvas.width / rect.width
      const scaleY = canvas.height / rect.height
      const to = {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
      }
      const newView = applyDrag(viewRef.current, dragRef.current, to, FEED_BOX, PROJ_CONFIG, canvas.width, canvas.height)
      viewRef.current = newView
      dragRef.current = to
      applyView()
    }

    const handlePointerUp = () => {
      isDraggingRef.current = false
      dragRef.current = null
      const canvas = canvasRef.current
      if (canvas) canvas.style.cursor = ''
    }

    globalThis.addEventListener('keydown', handleZoomKeyDown)
    globalThis.addEventListener('keydown', handlePanKeyDown)
    const canvasEl = canvasRef.current
    if (canvasEl) {
      canvasEl.style.touchAction = 'none'
      canvasEl.addEventListener('wheel', handleWheel, { passive: false })
      canvasEl.addEventListener('pointerdown', handlePointerDown)
      canvasEl.addEventListener('pointermove', handlePointerMove)
      canvasEl.addEventListener('pointerup', handlePointerUp)
      canvasEl.addEventListener('pointercancel', handlePointerUp)
    }

    return () => {
      globalThis.removeEventListener('keydown', handleZoomKeyDown)
      globalThis.removeEventListener('keydown', handlePanKeyDown)
      if (canvasEl) {
        canvasEl.removeEventListener('wheel', handleWheel)
        canvasEl.removeEventListener('pointerdown', handlePointerDown)
        canvasEl.removeEventListener('pointermove', handlePointerMove)
        canvasEl.removeEventListener('pointerup', handlePointerUp)
        canvasEl.removeEventListener('pointercancel', handlePointerUp)
      }
    }
  }, [])

  // VIS-6/VIS-7 tune mode: the overlay text (never drawn on the canvas)
  // refreshes once a second from configRef/fpsRef -- no interval and no
  // DOM node outside ?tune=1.
  useEffect(() => {
    if (!TUNE_MODE) return

    const update = () => {
      const view = viewRef.current
      const status = {
        basemapAvailable: BASEMAP_AREA !== undefined,
        radiusNm: view.radiusNm,
        // Where the view sits relative to the area centre, in nm: 1 nm is
        // one arc minute, and longitude is scaled the same way mapProject
        // scales it, at the AREA centre's latitude.
        centerOffsetLatNm: (view.centerLat - AREA_CENTRE_LAT) * 60,
        centerOffsetLonNm:
          (view.centerLon - AREA_CENTRE_LON) * 60 * Math.cos((AREA_CENTRE_LAT * Math.PI) / 180),
        vesselCount: vesselCountRef.current,
        fps: fpsRef.current,
      }
      setOverlayText(tuneOverlayText(configRef.current, status))
    }
    update()
    const intervalId = globalThis.setInterval(update, 1000)
    return () => globalThis.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    console.log('[Wake] config loaded:', DEFAULT_CONFIG)
    console.log(`[Wake] Layer: ships · Area: ${AREA.displayName} (${AREA.radiusNm}nm)`)

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationId: number
    let frameCount = 0
    let lastFpsLog = performance.now()
    let lastFrameMs = Date.now()

    // VIS-9: the basemap, mounted once beneath this canvas. Only when the
    // area has a tile extract -- otherwise no MapLibre map is constructed
    // at all, no WebGL context exists, and everything below behaves
    // exactly as it did before this story.
    const mapContainer = mapContainerRef.current
    if (BASEMAP_AREA !== undefined && mapContainer !== null && basemapRef.current === null) {
      const view = viewRef.current
      basemapRef.current = mountBasemap({
        container: mapContainer,
        area: BASEMAP_AREA,
        centerLat: view.centerLat,
        centerLon: view.centerLon,
        radiusNm: view.radiusNm,
        landLevel: configRef.current.basemapLand,
        projConfig: PROJ_CONFIG,
        canvasWidth: globalThis.innerWidth,
        canvasHeight: globalThis.innerHeight,
      })
      basemapRef.current.setVisible(configRef.current.basemapEnabled)
    }
    let appliedBasemapEnabled = configRef.current.basemapEnabled
    let appliedLandLevel = configRef.current.basemapLand

    const resize = () => {
      canvas.width = globalThis.innerWidth
      canvas.height = globalThis.innerHeight
      // map.resize() (inside handle.resize), then the camera re-fitted to
      // the CURRENT runtime view at the new size -- after a pan or a zoom
      // that is viewRef, not the area the map was mounted with.
      const handle = basemapRef.current
      if (handle !== null) {
        handle.resize(canvas.width, canvas.height)
        const view = viewRef.current
        handle.setView(view.centerLat, view.centerLon, view.radiusNm)
      }
      clearFrame()
    }

    const paintBlack = () => {
      if (!ctx) return
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }

    // The ONE change the basemap needs on the display side: a canvas
    // filled black every frame would hide the map underneath it. With no
      // basemap this is still paintBlack, byte for byte -- so the three
      // areas with no extract are untouched.
    const clearFrame = () => {
      if (!ctx) return
      if (BASEMAP_AREA === undefined) {
        paintBlack()
        return
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    const loop = (time: number) => {
      frameCount++

      const elapsed = time - lastFpsLog
      if (elapsed >= FPS_WINDOW_MS) {
        const fps = Math.round((frameCount * 1000) / elapsed)
        console.log(`[Wake] fps: ${fps}`)
        fpsRef.current = fps
        frameCount = 0
        lastFpsLog = time
      }

      // VIS-9: reconcile the two basemap settings the tune keys can move
      // onto the live MapLibre handle. Compared against what was last
      // applied, so setStyle is called on a change and not every frame.
      const liveConfig = configRef.current
      const handle = basemapRef.current
      if (handle !== null) {
        if (liveConfig.basemapEnabled !== appliedBasemapEnabled) {
          handle.setVisible(liveConfig.basemapEnabled)
          appliedBasemapEnabled = liveConfig.basemapEnabled
        }
        if (liveConfig.basemapLand !== appliedLandLevel) {
          handle.setLandLevel(liveConfig.basemapLand)
          appliedLandLevel = liveConfig.basemapLand
        }
      }

      clearFrame()

      // Real wall-clock, not requestAnimationFrame's own time base --
      // fix.timestamp from the server is a real epoch ms, and mixing
      // clocks between the delta and the absolute comparison would be
      // exactly the class of bug this project has been bitten by before.
      const nowMs = Date.now()
      const deltaMs = nowMs - lastFrameMs
      lastFrameMs = nowMs

      // The live view, read fresh EVERY frame: a pan or a zoom mutates
      // viewRef only, and the next frame draws the new centre immediately.
      const view = viewRef.current

      // VIS-9: town names go UNDER everything renderFrame draws -- they
      // are the bottom of the drawn stack, immediately above the
      // basemap. renderFrame itself is called with exactly the arguments
      // it was called with before this story.
      if (BASEMAP_AREA !== undefined && liveConfig.placeNamesEnabled) {
        drawPlaceNames(
          ctx,
          BASEMAP_AREA.places,
          view.centerLat,
          view.centerLon,
          view.radiusNm,
          PROJ_CONFIG,
          canvas.width,
          canvas.height,
        )
      }

      renderFrame(trackedRef.current, vesselStateRef.current, ctx, {
        centerLat: view.centerLat,
        centerLon: view.centerLon,
        radiusNm: view.radiusNm,
        projConfig: PROJ_CONFIG,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        nowMs,
        deltaMs,
        config: liveConfig,
        areaDisplayName: AREA.displayName,
      })

      vesselCountRef.current = trackedRef.current.size

      // VIS-9: the OpenStreetMap credit, last, so nothing paints over
      // it. Drawn whenever the basemap layer exists for this area, on or
      // off -- the tiles have been read either way.
      if (BASEMAP_AREA !== undefined) {
        drawAttribution(ctx, canvas.width, canvas.height)
      }

      animationId = requestAnimationFrame(loop)
    }

    // Every way the page's size can change goes through ONE coalesced
    // resize on the next frame. The ResizeObserver on the basemap
    // container (the canvas when there is no basemap) is the primary
    // signal, because it reports the box the map actually has to fill; the
    // window and visual-viewport resize events are fallbacks for browsers
    // that deliver a zoom as one and not the other. Browser zoom also
    // changes devicePixelRatio, and MapLibre reads that only inside
    // map.resize(), so a ratio change with no size change (a window moved
    // to a screen with a different ratio) is watched for as well.
    const resizeRunner = createCoalescedRunner(resize, {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id),
    })
    const scheduleResize = () => resizeRunner.schedule()

    const resizeObserver = new ResizeObserver(scheduleResize)
    resizeObserver.observe(mapContainer ?? canvas)
    const viewport = globalThis.visualViewport

    // A resolution media query matches ONE ratio, so it is re-armed for the
    // new ratio each time it fires.
    let pixelRatioQuery: MediaQueryList | null = null
    const onPixelRatioChange = () => {
      scheduleResize()
      watchPixelRatio()
    }
    const watchPixelRatio = () => {
      pixelRatioQuery?.removeEventListener('change', onPixelRatioChange)
      pixelRatioQuery = globalThis.matchMedia(`(resolution: ${globalThis.devicePixelRatio}dppx)`)
      pixelRatioQuery.addEventListener('change', onPixelRatioChange)
    }

    resize()
    globalThis.addEventListener('resize', scheduleResize)
    viewport?.addEventListener('resize', scheduleResize)
    watchPixelRatio()
    animationId = requestAnimationFrame(loop)

    return () => {
      resizeObserver.disconnect()
      globalThis.removeEventListener('resize', scheduleResize)
      viewport?.removeEventListener('resize', scheduleResize)
      pixelRatioQuery?.removeEventListener('change', onPixelRatioChange)
      resizeRunner.dispose()
      cancelAnimationFrame(animationId)
      basemapRef.current?.destroy()
      basemapRef.current = null
    }
  }, [])

  return (
    <>
      {/* VIS-9: the basemap container sits BEFORE the canvas in the tree
          and carries no z-index of its own -- with both fixed and
          full-bleed, document order puts the canvas on top. The canvas's
          own positioning, sizing and resize handling are unchanged, which
          was the constraint: this adds a sibling underneath rather than
          restructuring how the canvas mounts. Rendered only when this area
          has a tile extract, so nothing extra exists in the DOM
          otherwise. Sized to the viewport by CSS alone (fixed, inset 0,
          100% by 100%), never in pixels, so the box always matches the
          window and the resize effect above only has to tell MapLibre. */}
      {BASEMAP_AREA !== undefined && (
        <div
          ref={mapContainerRef}
          style={{
            position: 'fixed',
            inset: 0,
            width: '100%',
            height: '100%',
            backgroundColor: '#000000',
          }}
        />
      )}
      <canvas
        ref={canvasRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'block',
        }}
      />
      <ConnectionIndicator status={connectionStatus} />
      {TUNE_MODE && (
        <div
          style={{
            position: 'fixed',
            top: 12,
            left: 12,
            color: '#C8D8F0',
            fontFamily: 'monospace',
            fontSize: 13,
            opacity: 0.85,
            // VIS-9: capped so the overlay wraps inside the left of the
            // canvas instead of running under the OpenStreetMap credit in
            // the top-right corner. At 1024x768 it grew long enough to do
            // exactly that, which the wired verification screenshot
            // caught. Dev-only chrome either way -- the credit itself is
            // canvas text and is unobstructed without ?tune=1.
            maxWidth: '60%',
          }}
        >
          {overlayText}
        </div>
      )}
    </>
  )
}
