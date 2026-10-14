import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEMO_AREAS, DEFAULT_RADIUS_NM, MAX_CUSTOM_RADIUS_NM, MIN_CUSTOM_RADIUS_NM, extractBboxFor, parseLocalAreas, slugify, type LocalAreasFile, type LocalAreaRecord, type LocalBasemapRecord } from '@wake/shared'

export interface MakeAreaArgs {
  mode?: 'interactive' | 'custom' | 'builtin' | 'source' | 'help'
  name?: string
  lat?: number
  lon?: number
  radius?: number
  builtin?: string
  source?: string
  buildDate?: string
  overwrite?: boolean
  dryRun?: boolean
  help?: boolean
}

export interface BinaryLookupDeps {
  existsSync: (filePath: string) => boolean
  spawnSync: (command: string, args?: readonly string[], options?: { encoding?: BufferEncoding; shell?: boolean }) => {
    status: number | null
    error?: Error
    stdout?: string | Uint8Array | Buffer
    stderr?: string | Uint8Array | Buffer
  }
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.length > 0
  } catch {
    return false
  }
}

function isExistingFile(source: string): boolean {
  try {
    return fs.statSync(source).isFile()
  } catch {
    return false
  }
}

export function parseMakeAreaArgs(args: readonly string[]): { ok: true; value: MakeAreaArgs } | { ok: false; errors: string[] } {
  if (args.length === 0) {
    return { ok: true, value: { mode: 'interactive' } }
  }

  const value: MakeAreaArgs = {}
  const errors: string[] = []
  const seen = new Set<string>()

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (seen.has(arg) && arg !== '--dry-run' && arg !== '--overwrite') {
      errors.push(`Duplicate option ${JSON.stringify(arg)}.`)
      continue
    }
    seen.add(arg)
    if (arg === '--help') {
      value.help = true
      value.mode = 'help'
      continue
    }
    if (arg === '--overwrite') {
      value.overwrite = true
      continue
    }
    if (arg === '--dry-run') {
      value.dryRun = true
      continue
    }
    if (arg === '--name') {
      const next = args[i + 1]
      if (!next || next.startsWith('--')) {
        errors.push('Missing value for --name.')
      } else {
        value.name = next
        i += 1
      }
      continue
    }
    if (arg === '--lat') {
      const next = args[i + 1]
      if (!next || next.startsWith('--')) {
        errors.push('Missing value for --lat.')
      } else {
        const parsed = Number(next)
        if (!Number.isFinite(parsed)) errors.push(`Invalid latitude ${JSON.stringify(next)}.`)
        value.lat = parsed
        i += 1
      }
      continue
    }
    if (arg === '--lon') {
      const next = args[i + 1]
      if (!next || next.startsWith('--')) {
        errors.push('Missing value for --lon.')
      } else {
        const parsed = Number(next)
        if (!Number.isFinite(parsed)) errors.push(`Invalid longitude ${JSON.stringify(next)}.`)
        value.lon = parsed
        i += 1
      }
      continue
    }
    if (arg === '--radius') {
      const next = args[i + 1]
      if (!next || next.startsWith('--')) {
        errors.push('Missing value for --radius.')
      } else {
        const parsed = Number(next)
        if (!Number.isFinite(parsed)) errors.push(`Invalid radius ${JSON.stringify(next)}.`)
        value.radius = parsed
        i += 1
      }
      continue
    }
    if (arg === '--builtin') {
      const next = args[i + 1]
      if (!next || next.startsWith('--')) {
        errors.push('Missing value for --builtin.')
      } else {
        value.builtin = next
        value.mode = 'builtin'
        i += 1
      }
      continue
    }
    if (arg === '--source') {
      const next = args[i + 1]
      if (!next || next.startsWith('--')) {
        errors.push('Missing value for --source.')
      } else {
        value.source = next
        value.mode = 'source'
        i += 1
      }
      continue
    }
    if (arg === '--build-date') {
      const next = args[i + 1]
      if (!next || next.startsWith('--')) {
        errors.push('Missing value for --build-date.')
      } else if (!isValidDateCode(next)) {
        errors.push(`Invalid build date ${JSON.stringify(next)}; expected a real date in YYYYMMDD format.`)
      } else {
        value.buildDate = next
        i += 1
      }
      continue
    }
    errors.push(`Unknown argument ${JSON.stringify(arg)}.`)
  }

  if (errors.length > 0) return { ok: false, errors }

  if (value.help) {
    if (args.length !== 1) {
      return { ok: false, errors: ['--help cannot be combined with other options.'] }
    }
    return { ok: true, value }
  }

  if (value.name !== undefined) {
    const trimmedName = value.name.trim()
    const error = validateAreaName(value.name)
    if (error) return { ok: false, errors: [error] }
    value.name = trimmedName
  }

  if (value.source !== undefined) {
    const error = validateSourceArgument(value.source)
    if (error) return { ok: false, errors: [error] }
  }

  if (value.source && value.buildDate) {
    return { ok: false, errors: ['Choose either --source or --build-date, not both.'] }
  }

  if (value.builtin) {
    if (!Object.prototype.hasOwnProperty.call(DEMO_AREAS, value.builtin)) {
      return { ok: false, errors: [`Unknown built-in area ${JSON.stringify(value.builtin)}.`] }
    }
    if (value.name !== undefined || value.lat !== undefined || value.lon !== undefined || value.radius !== undefined) {
      return { ok: false, errors: ['--builtin cannot be combined with custom area coordinates.'] }
    }
    return { ok: true, value: { ...value, mode: 'builtin' } }
  }

  if (value.name || value.lat !== undefined || value.lon !== undefined || value.radius !== undefined) {
    if (!value.name || value.lat === undefined || value.lon === undefined) {
      return { ok: false, errors: ['Custom areas require --name, --lat and --lon.'] }
    }
    const radius = value.radius ?? DEFAULT_RADIUS_NM
    if (!Number.isFinite(radius) || radius < MIN_CUSTOM_RADIUS_NM || radius > MAX_CUSTOM_RADIUS_NM) {
      return { ok: false, errors: [`Radius must be between ${MIN_CUSTOM_RADIUS_NM} and ${MAX_CUSTOM_RADIUS_NM}.`] }
    }
    if (!Number.isFinite(value.lat) || value.lat < -80 || value.lat > 80) {
      return { ok: false, errors: ['Latitude must be between -80 and 80.'] }
    }
    if (!Number.isFinite(value.lon) || value.lon < -180 || value.lon > 180) {
      return { ok: false, errors: ['Longitude must be between -180 and 180.'] }
    }
    return { ok: true, value: { ...value, mode: 'custom', radius, lat: value.lat, lon: value.lon } }
  }

  if (value.source || value.buildDate) {
    return { ok: false, errors: ['--source and --build-date must be used with --builtin or a complete custom area (--name, --lat and --lon).'] }
  }

  return { ok: true, value: { ...value, mode: 'interactive' } }
}

export function isValidDateCode(raw: string): boolean {
  if (!/^\d{8}$/.test(raw)) return false
  const year = Number(raw.slice(0, 4))
  const month = Number(raw.slice(4, 6))
  const day = Number(raw.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function candidateBuildDates(baseDate: Date = new Date()): string[] {
  const out: string[] = []
  for (let i = 0; i < 4; i += 1) {
    const d = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() - i))
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    out.push(`${y}${m}${day}`)
  }
  return out
}

export function buildExtractArgs(
  source: string,
  tempPath: string,
  centerLat: number,
  centerLon: number,
  radiusNm: number,
): string[] {
  const box = extractBboxFor(centerLat, centerLon, radiusNm)
  return [
    'extract',
    source,
    tempPath,
    `--bbox=${box.minLon.toFixed(4)},${box.minLat.toFixed(4)},${box.maxLon.toFixed(4)},${box.maxLat.toFixed(4)}`,
    '--maxzoom=11',
  ]
}

export function findPmtilesBinary(
  repoRoot: string,
  deps: BinaryLookupDeps = {
    existsSync: fs.existsSync,
    spawnSync: (command: string, args?: readonly string[], options?: { encoding?: BufferEncoding; shell?: boolean }) =>
      spawnSync(command, args ?? [], { ...options, shell: false }),
  },
): string | null {
  const pathLookup = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const result = deps.spawnSync(pathLookup, ['pmtiles'], { encoding: 'utf8', shell: false })
    if (result.status === 0) {
      const resolved = (result.stdout ?? '').toString().split(/\r?\n/, 1)[0].trim()
      if (resolved) return resolved
    }
  } catch {
    // Continue with the project-local binary fallback.
  }

  const localBinary = path.join(repoRoot, 'tools', 'pmtiles.exe')
  if (deps.existsSync(localBinary)) return localBinary

  return null
}

export function validateSourceArgument(
  source: string,
): string | null {
  if (hasControlCharacters(source)) {
    return 'Source must not contain control characters or newlines.'
  }
  if (isHttpsUrl(source) || isExistingFile(source)) return null
  return 'Source must be an HTTPS URL or the path to an existing local file.'
}

export function validateAreaName(name: string): string | null {
  const trimmedName = name.trim()
  if (hasControlCharacters(name) || trimmedName.length < 1 || trimmedName.length > 40) {
    return 'Area name must contain 1 to 40 non-control characters.'
  }
  return null
}

export interface PmtilesRunResult {
  status: number | null
  stdout?: string | Uint8Array | Buffer
  stderr?: string | Uint8Array | Buffer
}

export type PmtilesRunner = (
  binaryPath: string,
  args: readonly string[],
  options: { encoding: 'utf8'; shell: false },
) => PmtilesRunResult

export function runPmtiles(
  binaryPath: string,
  args: readonly string[],
  runner: PmtilesRunner = (binary, argv, options) => spawnSync(binary, [...argv], options),
): PmtilesRunResult {
  return runner(binaryPath, [...args], { encoding: 'utf8', shell: false })
}

export function mergeLocalAreaRecord(
  file: LocalAreasFile | null,
  options: {
    kind: 'custom' | 'builtin'
    key: string
    value: LocalAreaRecord | LocalBasemapRecord
    overwrite?: boolean
  },
): LocalAreasFile {
  const next: LocalAreasFile = file ? JSON.parse(JSON.stringify(file)) : {}

  if (options.kind === 'custom') {
    if (Object.prototype.hasOwnProperty.call(DEMO_AREAS, options.key)) {
      throw new Error(`Refusing to record custom area ${JSON.stringify(options.key)} because it collides with a built-in area.`)
    }
    if (!next.areas) next.areas = {}
    const existing = next.areas[options.key]
    if (existing && !options.overwrite) {
      throw new Error(`Area ${JSON.stringify(options.key)} already exists and --overwrite was not set.`)
    }
    next.areas[options.key] = options.value as LocalAreaRecord
    return next
  }

  if (!Object.prototype.hasOwnProperty.call(DEMO_AREAS, options.key)) {
    throw new Error(`Basemap key ${JSON.stringify(options.key)} must be one of: ${Object.keys(DEMO_AREAS).join(', ')}.`)
  }
  if (!next.basemaps) next.basemaps = {}
  const existing = next.basemaps[options.key]
  if (existing && !options.overwrite) {
    throw new Error(`Basemap ${JSON.stringify(options.key)} already exists and --overwrite was not set.`)
  }
  next.basemaps[options.key] = options.value as LocalBasemapRecord
  return next
}

export function ensureLocalAreaFileIsValid(file: LocalAreasFile): LocalAreasFile {
  const result = parseLocalAreas(file)
  if (!result.ok) {
    throw new Error(result.errors.join('\n'))
  }
  return result.value
}

export function buildCustomAreaRecord(name: string, lat: number, lon: number, radiusNm: number): LocalAreaRecord {
  const key = slugify(name)
  return {
    displayName: name,
    centerLat: lat,
    centerLon: lon,
    radiusNm,
    places: [],
    pmtilesUrl: `/tiles/${key}-z11.pmtiles`,
  }
}

export function buildBasemapRecord(pmtilesUrl: string): LocalBasemapRecord {
  return { pmtilesUrl, places: [] }
}

export function parseRecordFile(raw: string | null | undefined): LocalAreasFile | null {
  if (!raw || raw.trim() === '') return null
  const parsed = JSON.parse(raw)
  const result = parseLocalAreas(parsed)
  if (!result.ok) {
    throw new Error(result.errors.join('\n'))
  }
  return result.value
}
