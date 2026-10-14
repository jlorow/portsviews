import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_CONFIG,
  DEMO_AREAS,
  parseDemoArea,
  basemapAreaFor,
  radiusStepsFor,
  stepRadius,
  zoomKeyAction,
  type DemoAreaKey,
  type DisplayConfig,
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

const DEFAULT_BROADCAST_PORT = 8080

// DEMO-1: view centre and radius come from DEMO_AREAS (@wake/shared) for
// the area key injected from the repo-root .env — vite.config.ts defines
// import.meta.env.WAKE_AREA and nothing else from that file. Unset/blank
// means dover; an invalid key falls back to dover with ONE console
// warning at module load.
const AREA_KEY = parseDemoArea(import.meta.env.WAKE_AREA)
if (AREA_KEY === null) {
  console.warn(
    `[Wake] Invalid WAKE_AREA ${JSON.stringify(import.meta.env.WAKE_AREA)} -- expected one of: ${Object.keys(DEMO_AREAS).join(', ')}. Using dover.`,
  )
}
const areaKey: DemoAreaKey = AREA_KEY ?? 'dover'
const AREA = DEMO_AREAS[areaKey]

// VIS-9: the basemap for this area, or undefined if no tile extract exists
// for it. Only dover ships one; every other area draws exactly what it
// drew before that story -- pure black, no MapLibre context created at all.
const BASEMAP_AREA = basemapAreaFor(areaKey)

// The area centre is fixed; radiusNmRef below owns the live view radius.
const VIEW = { centerLat: AREA.centerLat, centerLon: AREA.centerLon }

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

// window.location.hostname rather than a hardcoded 'localhost' -- the
// display and the server are not guaranteed to be the same machine.
// Port is read from an env var, not hardcoded, matching the server's own
// WAKE_BROADCAST_PORT default of 8080 if unset.
function buildServerUrl(): string {
  const port = import.meta.env.VITE_WAKE_BROADCAST_PORT || String(DEFAULT_BROADCAST_PORT)
  return `ws://${globalThis.location.hostname}:${port}`
}

// The real browser WebSocket satisfies WakeSocketLike structurally --
// no adapter needed, only the type assertion TypeScript requires because
// the global lib.dom.d.ts type isn't literally the same declaration.
function createBrowserSocket(url: string): WakeSocketLike {
  return new WebSocket(url) as unknown as WakeSocketLike
}

export default function WakeCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const vesselStateRef = useRef<VesselStateMap>(new Map())
  const trackedRef = useRef(createTrackedVesselMap())
  const radiusNmRef = useRef(AREA.radiusNm)
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
        onFix: (fix) => onFixArrived(trackedRef.current, fix),
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
  // This tune-key listener exists only inside ?tune=1; zoom keys are handled
  // by a separate listener below.
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const targetIsEditable =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      const action = zoomKeyAction({
        key: event.key,
        repeat: event.repeat,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        targetIsEditable,
      })
      if (action === null) return

      event.preventDefault()
      const nextRadiusNm =
        action === 'reset'
          ? AREA.radiusNm
          : stepRadius(radiusStepsFor(AREA.radiusNm), radiusNmRef.current, action)
      if (nextRadiusNm === radiusNmRef.current) return

      radiusNmRef.current = nextRadiusNm
      basemapRef.current?.setRadius(nextRadiusNm)
    }

    globalThis.addEventListener('keydown', handleKeyDown)
    return () => globalThis.removeEventListener('keydown', handleKeyDown)
  }, [])

  // VIS-6/VIS-7 tune mode: the overlay text (never drawn on the canvas)
  // refreshes once a second from configRef/fpsRef -- no interval and no
  // DOM node outside ?tune=1.
  useEffect(() => {
    if (!TUNE_MODE) return

    const update = () => {
      const status = {
        basemapAvailable: BASEMAP_AREA !== undefined,
        radiusNm: radiusNmRef.current,
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
      basemapRef.current = mountBasemap({
        container: mapContainer,
        area: BASEMAP_AREA,
        centerLat: VIEW.centerLat,
        centerLon: VIEW.centerLon,
        radiusNm: radiusNmRef.current,
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
      basemapRef.current?.resize(canvas.width, canvas.height)
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

      // VIS-9: town names go UNDER everything renderFrame draws -- they
      // are the bottom of the drawn stack, immediately above the
      // basemap. renderFrame itself is called with exactly the arguments
      // it was called with before this story.
      if (BASEMAP_AREA !== undefined && liveConfig.placeNamesEnabled) {
        drawPlaceNames(
          ctx,
          BASEMAP_AREA.places,
          VIEW.centerLat,
          VIEW.centerLon,
          radiusNmRef.current,
          PROJ_CONFIG,
          canvas.width,
          canvas.height,
        )
      }

      renderFrame(trackedRef.current, vesselStateRef.current, ctx, {
        centerLat: AREA.centerLat,
        centerLon: AREA.centerLon,
        radiusNm: radiusNmRef.current,
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

    resize()
    globalThis.addEventListener('resize', resize)
    animationId = requestAnimationFrame(loop)

    return () => {
      globalThis.removeEventListener('resize', resize)
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
          otherwise. */}
      {BASEMAP_AREA !== undefined && (
        <div
          ref={mapContainerRef}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
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
