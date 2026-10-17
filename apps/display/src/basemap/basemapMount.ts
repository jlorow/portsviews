import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  basemapContainerTransform,
  basemapZoom,
  type BasemapAreaConfig,
  type LandLevel,
  type ProjectionConfig,
} from '@wake/shared'
import { buildBasemapStyle } from './basemapStyle'

// VIS-9 — mounting the MapLibre map beneath Wake's canvas.
//
// This is the ONLY module in the display that imports maplibre-gl, and it
// is deliberately thin: everything that has to agree with mapProject (the
// zoom, the mirror transform) lives in @wake/shared's basemap.ts where a
// plain `tsx` test can reach it with no DOM. What is left here is the
// imperative part a test could only assert by mocking MapLibre's whole
// surface, which would assert nothing about the real library.
//
// The camera is north-up, non-interactive and fixed. That mirrors the ship
// display's real wide static view: no rotation, no follow, no pan, no
// zoom. `interactive: false` also removes MapLibre's KeyboardHandler,
// which map-proto-review.txt recorded binding `-` and `=` to zoom and
// colliding with a page's own keys — WakeCanvas's tune keys would be the
// same hazard here.

let protocolRegistered = false

function registerPmtilesProtocol(): void {
  // addProtocol is global to maplibregl, so registering it twice throws.
  // React StrictMode double-mounts in dev (CLAUDE.md's architecture
  // notes), which makes that a real path, not a theoretical one.
  if (protocolRegistered) return
  maplibregl.addProtocol('pmtiles', new Protocol().tile)
  protocolRegistered = true
}

export interface BasemapMountOptions {
  container: HTMLElement
  area: BasemapAreaConfig
  centerLat: number
  centerLon: number
  radiusNm: number
  landLevel: LandLevel
  projConfig: ProjectionConfig
  canvasWidth: number
  canvasHeight: number
}

export interface BasemapHandle {
  /** Re-fit the camera after a window resize, keeping the CURRENT view. */
  resize(canvasWidth: number, canvasHeight: number): void
  /**
   * Move the camera to a view centre and radius, with no animation: the
   * canvas underneath has already jumped, and a MapLibre ease would slide
   * the map out from under the ships for its duration.
   */
  setView(centerLat: number, centerLon: number, radiusNm: number): void
  /** Zoom only, keeping the current centre. A thin wrapper over setView. */
  setRadius(radiusNm: number): void
  /** Swap the land brightness (tune key F). Rebuilds the style. */
  setLandLevel(landLevel: LandLevel): void
  /** Show/hide without tearing the WebGL context down (tune key M). */
  setVisible(visible: boolean): void
  /** Keep the container's flip in step with the projection config. */
  applyProjection(projConfig: ProjectionConfig): void
  destroy(): void
}

export function mountBasemap(options: BasemapMountOptions): BasemapHandle {
  registerPmtilesProtocol()

  const {
    container,
    area,
    centerLat,
    centerLon,
    radiusNm,
    projConfig,
    canvasWidth,
    canvasHeight,
  } = options
  let landLevel = options.landLevel
  // The camera's own copy of the view. It is the ONLY thing resize() reads,
  // so a resize after a pan must keep the panned centre rather than snap
  // back to the area's.
  let currentCenterLat = centerLat
  let currentCenterLon = centerLon
  let currentRadiusNm = radiusNm
  let currentWidth = canvasWidth
  let currentHeight = canvasHeight

  container.style.transform = basemapContainerTransform(projConfig)

  const map = new maplibregl.Map({
    container,
    style: buildBasemapStyle({ pmtilesUrl: area.pmtilesUrl, landLevel }) as never,
    center: [centerLon, centerLat],
    zoom: basemapZoom(canvasWidth, canvasHeight, centerLat, radiusNm),
    bearing: 0,
    pitch: 0,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
  })

  // THE TILE EXTRACT IS GITIGNORED (`**/public/tiles/*.pmtiles`), and a
  // basemap that fails to load looks EXACTLY like a basemap that is
  // switched off: black. On a fresh clone, or after the file is moved,
  // the archive 404s and MapLibre reports it on its error event and
  // nothing else. Without this the display would just look normal and
  // nobody would know the story had silently stopped working -- the same
  // shape as CLAUDE.md's open follow-up 8 about the capture file.
  //
  // Logged once rather than per failed tile, because a missing archive
  // produces one error per tile request.
  let basemapErrorLogged = false
  map.on('error', (event: { error?: { message?: string } }) => {
    if (basemapErrorLogged) return
    basemapErrorLogged = true
    console.error(
      `[Wake] Basemap failed to load from ${area.pmtilesUrl} -- the display will render on black as if the basemap were off. ` +
        `The PMTiles extract is gitignored and is not in a fresh clone; see the VIS-9 review file for the one command that rebuilds it. ` +
        `MapLibre reported: ${event.error?.message ?? 'no message'}`,
    )
  })

  // One place that moves the camera, so setView and setRadius cannot drift
  // apart. jumpTo, not easeTo: no animation.
  const applyView = (nextCenterLat: number, nextCenterLon: number, nextRadiusNm: number): void => {
    currentCenterLat = nextCenterLat
    currentCenterLon = nextCenterLon
    currentRadiusNm = nextRadiusNm
    map.jumpTo({
      center: [currentCenterLon, currentCenterLat],
      zoom: basemapZoom(currentWidth, currentHeight, currentCenterLat, currentRadiusNm),
    })
  }

  return {
    resize(width: number, height: number) {
      currentWidth = width
      currentHeight = height
      // map.resize() FIRST: it re-reads the container's size and the
      // current devicePixelRatio and resizes MapLibre's own canvas to
      // them. The camera is fitted after that, against the new size; done
      // the other way round, the jump was applied to the old size and then
      // re-constrained by the resize.
      map.resize()
      // The zoom depends on the window size AND on the current view, so it
      // is recomputed from the live centre and radius, never from the ones
      // this map was mounted with.
      applyView(currentCenterLat, currentCenterLon, currentRadiusNm)
    },
    setView(nextCenterLat: number, nextCenterLon: number, nextRadiusNm: number) {
      applyView(nextCenterLat, nextCenterLon, nextRadiusNm)
    },
    setRadius(nextRadiusNm: number) {
      // Kept because it is the smaller change for a caller that only zooms.
      applyView(currentCenterLat, currentCenterLon, nextRadiusNm)
    },
    setLandLevel(next: LandLevel) {
      landLevel = next
      map.setStyle(buildBasemapStyle({ pmtilesUrl: area.pmtilesUrl, landLevel }) as never)
    },
    setVisible(visible: boolean) {
      container.style.display = visible ? 'block' : 'none'
    },
    applyProjection(next: ProjectionConfig) {
      container.style.transform = basemapContainerTransform(next)
    },
    destroy() {
      map.remove()
    },
  }
}
