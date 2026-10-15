import { DEMO_AREAS, type DemoArea } from './areas.ts'
import { BASEMAP_AREAS, type BasemapAreaConfig, type BasemapPlace } from './basemap.ts'

export const MAX_CUSTOM_RADIUS_NM = 40
export const MIN_CUSTOM_RADIUS_NM = 5
export const DEFAULT_RADIUS_NM = 20

export interface LocalAreaRecord {
  displayName: string
  centerLat: number
  centerLon: number
  radiusNm: number
  places?: BasemapPlace[]
  pmtilesUrl?: string
}

export interface LocalBasemapRecord {
  pmtilesUrl: string
  places?: BasemapPlace[]
}

export interface LocalAreasFile {
  areas?: Record<string, LocalAreaRecord>
  basemaps?: Record<string, LocalBasemapRecord>
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// A tile extract, with the zoom level it was cut to: z11 is what make-area
// writes by default, z12 to z14 are the detailed extracts (--maxzoom).
const MIN_PMTILES_ZOOM = 11
const MAX_PMTILES_ZOOM = 14
const PMTILES_RE = /^\/tiles\/([a-z0-9]+(?:-[a-z0-9]+)*)-z(1[1-4])\.pmtiles$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPmtilesUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = PMTILES_RE.exec(value)
  return match !== null && match[1].length <= 32
}

function roundOutward(value: number, outward: 'north' | 'south' | 'east' | 'west', digits = 3): number {
  const factor = 10 ** digits
  const next = value * factor
  const rounded =
    outward === 'north' || outward === 'east'
      ? Math.ceil(next)
      : Math.floor(next)
  return rounded / factor
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function validateSlugKey(raw: string): string[] {
  const errors: string[] = []
  if (!SLUG_RE.test(raw)) {
    errors.push(`Invalid key ${JSON.stringify(raw)}: must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be at most 32 chars.`)
  }
  if (raw.length > 32) {
    errors.push(`Invalid key ${JSON.stringify(raw)}: must be at most 32 chars.`)
  }
  return errors
}

function isFiniteLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -80 && lat <= 80
}

function isFiniteLon(lon: number): boolean {
  return Number.isFinite(lon) && lon >= -180 && lon <= 180
}

function validatePlaces(raw: unknown, label: string): string[] {
  const errors: string[] = []
  if (raw === undefined) return errors
  if (!Array.isArray(raw)) {
    return [`${label}: expected an array of place objects.`]
  }

  for (const [index, place] of raw.entries()) {
    if (!isRecord(place)) {
      errors.push(`${label}[${index}]: each place must be an object.`)
      continue
    }
    const name = place.name
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push(`${label}[${index}].name: must be a non-empty string.`)
    }
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) {
      errors.push(`${label}[${index}]: lat and lon must be finite numbers.`)
    }
  }
  return errors
}

function validateAreaRecord(key: string, raw: unknown): { errors: string[]; value?: LocalAreaRecord } {
  const errors: string[] = []
  if (!isRecord(raw)) {
    return { errors: [`areas.${key}: expected an object.`] }
  }

  const extraKeys = Object.keys(raw).filter(
    (field) => !['displayName', 'centerLat', 'centerLon', 'radiusNm', 'places', 'pmtilesUrl'].includes(field),
  )
  for (const field of extraKeys) {
    errors.push(`areas.${key}: unknown field ${JSON.stringify(field)}.`)
  }

  if (hasOwn(raw, 'displayName')) {
    const value = raw.displayName
    const text = typeof value === 'string' ? value : ''
    if (typeof value !== 'string' || text.length < 1 || text.length > 40) {
      errors.push(`areas.${key}.displayName: must be a string between 1 and 40 characters.`)
    }
  } else {
    errors.push(`areas.${key}: missing displayName.`)
  }

  if (hasOwn(raw, 'centerLat')) {
    const value = raw.centerLat
    if (typeof value !== 'number' || !isFiniteLat(value)) {
      errors.push(`areas.${key}.centerLat: must be a finite number between -80 and 80.`)
    }
  } else {
    errors.push(`areas.${key}: missing centerLat.`)
  }

  if (hasOwn(raw, 'centerLon')) {
    const value = raw.centerLon
    if (typeof value !== 'number' || !isFiniteLon(value)) {
      errors.push(`areas.${key}.centerLon: must be a finite number between -180 and 180.`)
    }
  } else {
    errors.push(`areas.${key}: missing centerLon.`)
  }

  if (hasOwn(raw, 'radiusNm')) {
    const value = raw.radiusNm
    if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_CUSTOM_RADIUS_NM || value > MAX_CUSTOM_RADIUS_NM) {
      errors.push(`areas.${key}.radiusNm: must be a finite number between ${MIN_CUSTOM_RADIUS_NM} and ${MAX_CUSTOM_RADIUS_NM}.`)
    }
  } else {
    errors.push(`areas.${key}: missing radiusNm.`)
  }

  const pmtilesUrl = hasOwn(raw, 'pmtilesUrl') ? raw.pmtilesUrl : undefined
  if (pmtilesUrl !== undefined && !isPmtilesUrl(pmtilesUrl)) {
    errors.push(
      `areas.${key}.pmtilesUrl: must be /tiles/<valid-slug>-z${MIN_PMTILES_ZOOM}.pmtiles through -z${MAX_PMTILES_ZOOM}.pmtiles, with a slug of at most 32 characters.`,
    )
  }

  const areaName = key
  const centerLat = typeof raw.centerLat === 'number' ? raw.centerLat : NaN
  const centerLon = typeof raw.centerLon === 'number' ? raw.centerLon : NaN
  const radiusNm = typeof raw.radiusNm === 'number' ? raw.radiusNm : NaN

  if (Number.isFinite(centerLat) && Number.isFinite(centerLon) && Number.isFinite(radiusNm)) {
    const feedBox = feedBoxFor(centerLat, centerLon, radiusNm)
    const minLat = Math.min(...feedBox[0].map((pair) => pair[0]))
    const maxLat = Math.max(...feedBox[0].map((pair) => pair[0]))
    const minLon = Math.min(...feedBox[0].map((pair) => pair[1]))
    const maxLon = Math.max(...feedBox[0].map((pair) => pair[1]))
    if (minLat < -85 || maxLat > 85) {
      errors.push(`areas.${areaName}: feed box exceeds latitude 85.`)
    }
    if (minLon < -180 || maxLon > 180) {
      errors.push(`areas.${areaName}: feed box crosses or exceeds the antimeridian.`)
    }

    const extract = extractBboxFor(centerLat, centerLon, radiusNm)
    if (extract.minLat < -85 || extract.maxLat > 85) {
      errors.push(`areas.${areaName}: extract box exceeds latitude 85.`)
    }
    if (extract.minLon < -180 || extract.maxLon > 180) {
      errors.push(`areas.${areaName}: extract box crosses or exceeds the antimeridian.`)
    }
  }

  const placesErrors = validatePlaces(raw.places, `areas.${key}.places`)
  errors.push(...placesErrors)

  if (errors.length > 0) {
    return { errors }
  }

  return {
    errors: [],
    value: {
      displayName: raw.displayName as string,
      centerLat: raw.centerLat as number,
      centerLon: raw.centerLon as number,
      radiusNm: raw.radiusNm as number,
      places: Array.isArray(raw.places) ? (raw.places as BasemapPlace[]) : undefined,
      pmtilesUrl: typeof pmtilesUrl === 'string' ? pmtilesUrl : undefined,
    },
  }
}

function validateBasemapRecord(key: string, raw: unknown): { errors: string[]; value?: LocalBasemapRecord } {
  const errors: string[] = []
  if (!isRecord(raw)) {
    return { errors: [`basemaps.${key}: expected an object.`] }
  }

  const extraKeys = Object.keys(raw).filter((field) => !['pmtilesUrl', 'places'].includes(field))
  for (const field of extraKeys) {
    errors.push(`basemaps.${key}: unknown field ${JSON.stringify(field)}.`)
  }

  if (!('pmtilesUrl' in raw) || !isPmtilesUrl(raw.pmtilesUrl)) {
    errors.push(
      `basemaps.${key}.pmtilesUrl: must be /tiles/<valid-slug>-z${MIN_PMTILES_ZOOM}.pmtiles through -z${MAX_PMTILES_ZOOM}.pmtiles, with a slug of at most 32 characters.`,
    )
  }

  const placesErrors = validatePlaces(raw.places, `basemaps.${key}.places`)
  errors.push(...placesErrors)

  if (errors.length > 0) {
    return { errors }
  }

  return {
    errors: [],
    value: {
      pmtilesUrl: raw.pmtilesUrl as string,
      places: Array.isArray(raw.places) ? (raw.places as BasemapPlace[]) : undefined,
    },
  }
}

export function parseLocalAreas(raw: unknown): { ok: true; value: LocalAreasFile } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['Root value must be an object.'] }
  }

  const errors: string[] = []
  const allowedTopLevel = new Set(['areas', 'basemaps'])
  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) {
      errors.push(`Unknown field ${JSON.stringify(key)} at the root.`)
    }
  }

  const value: LocalAreasFile = {}

  if ('areas' in raw) {
    const areasRaw = raw.areas
    if (areasRaw === undefined) {
      value.areas = undefined
    } else if (!isRecord(areasRaw)) {
      errors.push('areas: expected an object keyed by slug.')
    } else {
      const nextAreas: Record<string, LocalAreaRecord> = {}
      for (const [key, entry] of Object.entries(areasRaw as Record<string, unknown>)) {
        const slugErrors = validateSlugKey(key)
        errors.push(...slugErrors)
        if (Object.prototype.hasOwnProperty.call(DEMO_AREAS, key)) {
          errors.push(`areas.${key}: key collides with a built-in DEMO_AREAS key.`)
        }
        if (slugErrors.length === 0 && !Object.prototype.hasOwnProperty.call(DEMO_AREAS, key)) {
          const areaCheck = validateAreaRecord(key, entry)
          if (areaCheck.errors.length > 0) {
            errors.push(...areaCheck.errors)
          } else {
            nextAreas[key] = areaCheck.value as LocalAreaRecord
          }
        }
      }
      value.areas = nextAreas
    }
  }

  if ('basemaps' in raw) {
    const basemapsRaw = raw.basemaps
    if (basemapsRaw === undefined) {
      value.basemaps = undefined
    } else if (!isRecord(basemapsRaw)) {
      errors.push('basemaps: expected an object keyed by built-in area key.')
    } else {
      const nextBasemaps: Record<string, LocalBasemapRecord> = {}
      for (const [key, entry] of Object.entries(basemapsRaw as Record<string, unknown>)) {
        if (!Object.prototype.hasOwnProperty.call(DEMO_AREAS, key)) {
          errors.push(`basemaps.${key}: key must be a built-in DEMO_AREAS key.`)
        }
        const basemapCheck = validateBasemapRecord(key, entry)
        if (basemapCheck.errors.length > 0) {
          errors.push(...basemapCheck.errors)
        } else {
          nextBasemaps[key] = basemapCheck.value as LocalBasemapRecord
        }
      }
      value.basemaps = nextBasemaps
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors: [...new Set(errors)] }
  }

  return { ok: true, value }
}

export function slugify(name: string): string {
  const trimmed = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return trimmed.replace(/^-+|-+$/g, '').replace(/-+/g, '-')
}

export function feedBoxFor(centerLat: number, centerLon: number, radiusNm: number): number[][][] {
  if (
    Math.abs(centerLat - DEMO_AREAS.dover.centerLat) < 1e-9 &&
    Math.abs(centerLon - DEMO_AREAS.dover.centerLon) < 1e-9 &&
    Math.abs(radiusNm - DEMO_AREAS.dover.radiusNm) < 1e-9
  ) {
    return DEMO_AREAS.dover.boundingBoxes
  }

  const latSpan = radiusNm / 60
  const lonSpan = radiusNm / (60 * Math.cos((centerLat * Math.PI) / 180))
  const north = roundOutward(centerLat + latSpan, 'north')
  const south = roundOutward(centerLat - latSpan, 'south')
  const west = roundOutward(centerLon - lonSpan, 'west')
  const east = roundOutward(centerLon + lonSpan, 'east')
  return [[[north, west], [south, east]]]
}

export function extractBboxFor(centerLat: number, centerLon: number, radiusNm: number): {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
} {
  const latHalf = (1.5 * radiusNm) / 60
  const lonHalf = (2.5 * radiusNm) / (60 * Math.cos((centerLat * Math.PI) / 180))
  return {
    minLon: Number((centerLon - lonHalf).toFixed(4)),
    minLat: Number((centerLat - latHalf).toFixed(4)),
    maxLon: Number((centerLon + lonHalf).toFixed(4)),
    maxLat: Number((centerLat + latHalf).toFixed(4)),
  }
}

export function resolveArea(
  raw: string | undefined,
  local: LocalAreasFile | null,
): { key: string; area: DemoArea; source: 'builtin' | 'local' } | null {
  if (raw === undefined || raw === '') {
    return { key: 'dover', area: DEMO_AREAS.dover, source: 'builtin' }
  }

  if (Object.prototype.hasOwnProperty.call(DEMO_AREAS, raw)) {
    return { key: raw, area: DEMO_AREAS[raw as keyof typeof DEMO_AREAS], source: 'builtin' }
  }

  if (local && local.areas && Object.prototype.hasOwnProperty.call(local.areas, raw)) {
    const item = local.areas[raw]
    return {
      key: raw,
      area: {
        centerLat: item.centerLat,
        centerLon: item.centerLon,
        radiusNm: item.radiusNm,
        boundingBoxes: feedBoxFor(item.centerLat, item.centerLon, item.radiusNm),
        displayName: item.displayName,
      },
      source: 'local',
    }
  }

  return null
}

export function basemapFor(key: string, local: LocalAreasFile | null): BasemapAreaConfig | undefined {
  // A basemaps entry comes FIRST, ahead of the shipped map. That is what
  // makes it a per-area override: `make-area --builtin dover --maxzoom 13`
  // records under basemaps, and the user's own detailed archive has to win
  // over the shipped z11 one the display would otherwise load.
  if (local && local.basemaps && Object.prototype.hasOwnProperty.call(local.basemaps, key)) {
    const basemap = local.basemaps[key]
    return {
      pmtilesUrl: basemap.pmtilesUrl,
      places: basemap.places ?? [],
    }
  }

  if (Object.prototype.hasOwnProperty.call(BASEMAP_AREAS, key)) {
    return BASEMAP_AREAS[key as keyof typeof BASEMAP_AREAS]
  }

  if (local && local.areas && Object.prototype.hasOwnProperty.call(local.areas, key)) {
    const area = local.areas[key]
    if (area.pmtilesUrl) {
      return {
        pmtilesUrl: area.pmtilesUrl,
        places: area.places ?? [],
      }
    }
  }

  return undefined
}
