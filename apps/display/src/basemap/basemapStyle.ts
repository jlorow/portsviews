import { layers, namedFlavor } from '@protomaps/basemaps'
import { LAND_LEVELS, type LandLevel } from '@wake/shared'

// VIS-9 — the basemap style, built from Protomaps' stock `black` flavor
// and then cut down to geometry only.
//
// map-proto-ships already established the whole verdict against the
// installed package rather than against the docs (its A0(c)), and this is
// that result applied rather than a second derivation:
//
//   `black` emits 69 layers across seven source-layers (boundaries,
//   buildings, earth, landuse, places, roads, water). It carries NO pois
//   object and NO landcover object at all, which is why it was the
//   starting point rather than `dark`.
//
//   KEEP  background, earth (land fill), water (water fill)
//   ADD   coastline — Protomaps HAS NO COASTLINE LAYER. There is no such
//         id and no such source-layer: in this schema the coast exists
//         only as the edge between the earth fill and the water fill, so
//         a line layer on the earth polygon's own boundary is the only
//         way to draw one. It is the single layer this style adds and the
//         only cartographic decision in the file.
//   DROP  the other 66, REMOVED FROM THE ARRAY rather than hidden or set
//         to zero opacity, so nothing dropped can be revived by a paint
//         property.
//
// WHAT VIS-9 DOES THAT THE PROTOTYPE DID NOT: places_locality goes too.
// The prototype kept it, name-filtered to five towns, and that is exactly
// what cannot ship — the ceiling projector flips the image, the flip is a
// CSS transform on this map's container, and a style label flips with it
// and comes out backwards. Every place name draws on Wake's own canvas
// instead (canvas/placeNames.ts), through mapProject, unflipped, in Inter
// and in Wake's palette.
//
// Dropping it removes the SDF glyph CDN with it. A style with no symbol
// layer needs no `glyphs` URL, so this style has no `glyphs` key, no
// `sprite` key, and therefore NO runtime network dependency whatsoever:
// land, water and coastline all come from a local PMTiles file read with
// Range requests. That was the prototype's second blocking finding, and
// it is resolved as a side effect of the first.

const KEEP_IDS = ['background', 'earth', 'water']

export const VOID = '#000000'

export interface BasemapStyleOptions {
  pmtilesUrl: string
  landLevel: LandLevel
}

// The MapLibre StyleSpecification type is not imported here: this module
// is deliberately free of any maplibre-gl import so it can be exercised by
// a plain `tsx` test with no DOM and no WebGL.
export interface BasemapStyle {
  version: 8
  sources: Record<string, { type: string; url: string; attribution?: string }>
  layers: { id: string; type: string; source?: string; 'source-layer'?: string }[]
}

export function buildBasemapStyle({ pmtilesUrl, landLevel }: BasemapStyleOptions): BasemapStyle {
  const level = LAND_LEVELS[landLevel]
  const stock = layers('protomaps', namedFlavor('black'), { lang: 'en' })

  const kept = stock
    .filter((layer) => KEEP_IDS.includes(layer.id))
    .map((layer) => structuredClone(layer) as unknown as Record<string, unknown>)

  const byId = (id: string) => {
    const found = kept.find((layer) => layer['id'] === id)
    if (found === undefined) {
      // A Protomaps release that renamed or dropped one of these would
      // otherwise fail silently as a missing fill, which on a black canvas
      // is indistinguishable from "the sea".
      throw new Error(`[Wake] basemap style: Protomaps black flavor has no '${id}' layer`)
    }
    return found
  }

  const background = byId('background')
  ;(background['paint'] as Record<string, unknown>)['background-color'] = VOID

  const earth = byId('earth')
  ;(earth['paint'] as Record<string, unknown>)['fill-color'] = level.earth

  // Water stays pure black: a ship over water then composites exactly as
  // it does with no basemap at all, so nothing about the existing look
  // changes over the 20 nm of sea the vessels actually occupy.
  const water = byId('water')
  ;(water['paint'] as Record<string, unknown>)['fill-color'] = VOID

  const coastline = {
    id: 'coastline',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'earth',
    filter: ['==', '$type', 'Polygon'],
    paint: { 'line-color': level.coast, 'line-width': 1 },
  }

  return {
    version: 8,
    sources: {
      protomaps: {
        type: 'vector',
        url: 'pmtiles://' + pmtilesUrl,
        // MapLibre's AttributionControl is never added (VIS-9 draws the
        // credit on canvas, because a DOM control would be flipped by the
        // mirror transform too). This field is kept anyway so the
        // requirement travels with the source rather than living only in
        // the code that happens to draw it today.
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [background, earth, water, coastline] as BasemapStyle['layers'],
  }
}

/**
 * What the filter kept and dropped, computed from the same stock list the
 * style is built from. Exported for the test and the review file so the
 * verdict is re-derivable rather than a claim in a comment.
 */
export function basemapStyleAudit(): {
  stockCount: number
  kept: string[]
  added: string[]
  dropped: string[]
} {
  const stock = layers('protomaps', namedFlavor('black'), { lang: 'en' })
  return {
    stockCount: stock.length,
    kept: [...KEEP_IDS],
    added: ['coastline'],
    dropped: stock.filter((layer) => !KEEP_IDS.includes(layer.id)).map((layer) => layer.id),
  }
}
