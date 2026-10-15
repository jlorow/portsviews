import { fileURLToPath } from 'node:url'
import { parseLocalAreas } from '@wake/shared'
import {
  DEFAULT_MAX_ZOOM,
  buildBasemapRecord,
  buildCustomAreaRecord,
  buildExtractArgs,
  candidateBuildDates,
  detailedZoomWarning,
  findPmtilesBinary,
  isDetailedZoom,
  mergeLocalAreaRecord,
  needsDetailedZoomConfirmation,
  parseMakeAreaArgs,
  pmtilesFileName,
  pmtilesUrlFor,
  runPmtiles,
  withPmtilesDryRun,
} from './makeAreaCore.ts'

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

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

function assertParseError(args: string[], expected: string, label: string): void {
  const result = parseMakeAreaArgs(args)
  assert(result.ok === false && result.errors.some((error) => error.includes(expected)), label)
}

assertEqual(parseMakeAreaArgs([]), { ok: true, value: { mode: 'interactive' } }, 'arguments: no options selects interactive prompts')
assertEqual(parseMakeAreaArgs(['--help']), { ok: true, value: { help: true, mode: 'help' } }, 'arguments: help mode')
assertEqual(parseMakeAreaArgs(['--overwrite', '--dry-run']), { ok: true, value: { overwrite: true, dryRun: true, mode: 'interactive' } }, 'arguments: interactive mode preserves overwrite and dry-run flags')

const customDefault = parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4.0435', '--lon', '39.6682'])
assert(customDefault.ok && customDefault.value.mode === 'custom' && customDefault.value.radius === 20, 'arguments: custom mode defaults radius to 20')
const customSource = parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--radius', '25', '--source', 'https://example.com/local.pmtiles'])
assert(customSource.ok && customSource.value.mode === 'custom' && customSource.value.source === 'https://example.com/local.pmtiles', 'arguments: custom mode accepts explicit radius and source')
const existingLocalSource = fileURLToPath(new URL('./makeAreaCore.ts', import.meta.url))
const customLocalSource = parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--source', existingLocalSource])
assert(customLocalSource.ok && customLocalSource.value.source === existingLocalSource, 'arguments: accepts an existing local source file')
assertEqual(parseMakeAreaArgs(['--builtin', 'sydney']), { ok: true, value: { builtin: 'sydney', mode: 'builtin' } }, 'arguments: built-in mode')
const builtInSource = parseMakeAreaArgs(['--builtin', 'istanbul', '--build-date', '20261014', '--overwrite', '--dry-run'])
assert(builtInSource.ok && builtInSource.value.mode === 'builtin' && builtInSource.value.overwrite === true && builtInSource.value.dryRun === true, 'arguments: built-in mode accepts date, overwrite and dry-run')
const datedCustom = parseMakeAreaArgs(['--name', 'Port Said', '--lat', '31.35', '--lon', '32.35', '--build-date', '20261014'])
assert(datedCustom.ok && datedCustom.value.mode === 'custom' && datedCustom.value.buildDate === '20261014', 'arguments: custom mode accepts a build date')
assert(parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--overwrite']).ok, 'arguments: overwrite flag')
assert(parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--dry-run']).ok, 'arguments: dry-run flag')

// --- --maxzoom and --yes ---
const explicitDefaultZoom = parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--maxzoom', '11'])
assert(
  explicitDefaultZoom.ok && explicitDefaultZoom.value.maxZoom === 11,
  'arguments: --maxzoom 11 is accepted and is what the default build already does',
)
const noZoomGiven = parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4', '--lon', '39'])
assert(
  noZoomGiven.ok && noZoomGiven.value.maxZoom === undefined,
  `arguments: without --maxzoom nothing is recorded, so the build-time default (${DEFAULT_MAX_ZOOM}) is what runs`,
)
for (const zoom of [11, 12, 13, 14]) {
  const parsed = parseMakeAreaArgs(['--builtin', 'sydney', '--maxzoom', String(zoom), '--yes'])
  assert(
    parsed.ok && parsed.value.maxZoom === zoom,
    `arguments: --maxzoom ${zoom} is accepted in built-in mode`,
  )
}
const detailedArgs = parseMakeAreaArgs(['--builtin', 'sydney', '--maxzoom', '13', '--yes'])
assert(
  detailedArgs.ok && detailedArgs.value.mode === 'builtin' && detailedArgs.value.maxZoom === 13 && detailedArgs.value.yes === true,
  'arguments: a detailed built-in build parses with both --maxzoom and --yes',
)
assert(
  parseMakeAreaArgs(['--builtin', 'sydney', '--yes', '--yes']).ok,
  'arguments: repeating --yes is harmless, like --overwrite',
)
assert(
  parseMakeAreaArgs(['--builtin', 'sydney', '--maxzoom', '13']).ok,
  'arguments: --maxzoom 13 parses on its own; the --yes requirement is enforced at build time',
)
assertParseError(['--maxzoom'], 'Missing value for --maxzoom', 'arguments: missing --maxzoom value')
assertParseError(['--builtin', 'sydney', '--maxzoom', '10'], 'use a whole number from 11 to 14', 'arguments: --maxzoom below 11')
assertParseError(['--builtin', 'sydney', '--maxzoom', '15'], 'use a whole number from 11 to 14', 'arguments: --maxzoom above 14')
assertParseError(['--builtin', 'sydney', '--maxzoom', '12.5'], 'use a whole number from 11 to 14', 'arguments: --maxzoom must be a whole number')
assertParseError(['--builtin', 'sydney', '--maxzoom', 'deep'], 'use a whole number from 11 to 14', 'arguments: --maxzoom must be numeric')
assertParseError(['--builtin', 'sydney', '--maxzoom', '13', '--maxzoom', '12'], 'Duplicate option', 'arguments: duplicate --maxzoom')

assertParseError(['--name'], 'Missing value for --name', 'arguments: missing name value')
assertParseError(['--lat'], 'Missing value for --lat', 'arguments: missing latitude value')
assertParseError(['--lon'], 'Missing value for --lon', 'arguments: missing longitude value')
assertParseError(['--radius'], 'Missing value for --radius', 'arguments: missing radius value')
assertParseError(['--builtin'], 'Missing value for --builtin', 'arguments: missing built-in key')
assertParseError(['--source'], 'Missing value for --source', 'arguments: missing source value')
assertParseError(['--build-date'], 'Missing value for --build-date', 'arguments: missing build date')
assertParseError(['--lat', 'north'], 'Invalid latitude', 'arguments: non-numeric latitude')
assertParseError(['--lon', 'east'], 'Invalid longitude', 'arguments: non-numeric longitude')
assertParseError(['--radius', 'wide'], 'Invalid radius', 'arguments: non-numeric radius')
assertParseError(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--radius', '4'], 'Radius must be between', 'arguments: radius below minimum')
assertParseError(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--radius', '41'], 'Radius must be between', 'arguments: radius above maximum')
assertParseError(['--name', 'Mombasa', '--lat', '81', '--lon', '39'], 'Latitude must be between', 'arguments: latitude out of range')
assertParseError(['--name', 'Mombasa', '--lat', '-4', '--lon', '181'], 'Longitude must be between', 'arguments: longitude out of range')
assertParseError(['--lat', '-4'], 'Custom areas require', 'arguments: incomplete custom definition')
assertParseError(['--builtin', 'unknown'], 'Unknown built-in area', 'arguments: unknown built-in key')
assertParseError(['--source', 'https://example.com/local.pmtiles'], 'must be used with', 'arguments: source without area')
assertParseError(['--build-date', '20261014'], 'must be used with', 'arguments: date without area')
assertParseError(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--build-date', '20260230'], 'Invalid build date', 'arguments: impossible calendar date')
assertParseError(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--build-date', '2026-02-28'], 'Invalid build date', 'arguments: build date requires eight digits')
assertParseError(['--name', '', '--lat', '0', '--lon', '0'], 'Missing value for --name', 'arguments: rejects empty name argument')
assertParseError(['--name', '   ', '--lat', '0', '--lon', '0'], 'Area name must contain', 'arguments: rejects whitespace-only name')
assertParseError(['--name', 'a'.repeat(41), '--lat', '0', '--lon', '0'], 'Area name must contain', 'arguments: rejects names longer than 40 characters')
assertParseError(['--name', 'Bad\nName', '--lat', '0', '--lon', '0'], 'Area name must contain', 'arguments: rejects control characters in name')
assertParseError(['--builtin', 'sydney', '--source', 'http://example.com/map.pmtiles'], 'HTTPS URL', 'arguments: rejects non-HTTPS source URLs')
assertParseError(['--builtin', 'sydney', '--source', 'missing-source.pmtiles'], 'existing local file', 'arguments: rejects missing local source files')
assertParseError(['--builtin', 'sydney', '--source', 'https://example.com/map.pmtiles\n--overwrite'], 'control characters', 'arguments: rejects control characters in source')
assertParseError(['--source', 'https://example.com/map.pmtiles', '--build-date', '20261014', '--name', 'Area', '--lat', '0', '--lon', '0'], 'either --source or --build-date', 'arguments: mutually exclusive source selectors')
assertParseError(['--builtin', 'sydney', '--name', 'Area', '--lat', '0', '--lon', '0'], 'cannot be combined', 'arguments: built-in and custom definition conflict')
assertParseError(['--name', 'A', '--lat', '0', '--lon', '0', '--name', 'B'], 'Duplicate option', 'arguments: duplicate option')
assertParseError(['--unknown'], 'Unknown argument', 'arguments: unknown option')
assertParseError(['--help', '--dry-run'], 'cannot be combined', 'arguments: help cannot be combined')

assertEqual(
  buildExtractArgs('source.pmtiles', 'temp.pmtiles', 51.1, 1.45, 20),
  ['extract', 'source.pmtiles', 'temp.pmtiles', '--bbox=0.1230,50.6000,2.7770,51.6000', '--maxzoom=11'],
  'extract: exact PMTiles arguments and bounding box',
)
assertEqual(
  buildExtractArgs('source.pmtiles', 'temp.pmtiles', 51.1, 1.45, 20, 11),
  ['extract', 'source.pmtiles', 'temp.pmtiles', '--bbox=0.1230,50.6000,2.7770,51.6000', '--maxzoom=11'],
  'extract: zoom 11 explicitly is byte for byte the default argument list',
)
assertEqual(
  buildExtractArgs('source.pmtiles', 'temp.pmtiles', 51.1, 1.45, 20, 13),
  ['extract', 'source.pmtiles', 'temp.pmtiles', '--bbox=0.1230,50.6000,2.7770,51.6000', '--maxzoom=13'],
  'extract: zoom 13 changes ONLY the maxzoom argument -- same box, same source',
)
assertEqual(
  withPmtilesDryRun(buildExtractArgs('source.pmtiles', 'temp.pmtiles', 51.1, 1.45, 20, 13)),
  ['extract', 'source.pmtiles', 'temp.pmtiles', '--bbox=0.1230,50.6000,2.7770,51.6000', '--maxzoom=13', '--dry-run'],
  "extract: the size probe appends pmtiles' own --dry-run and changes nothing else",
)

// --- the --yes requirement and the warning that precedes it ---
assert(
  isDetailedZoom(13) && isDetailedZoom(14) && !isDetailedZoom(11) && !isDetailedZoom(12),
  'confirmation: only zoom 13 and 14 count as detailed; 11 and 12 do not prompt',
)
assert(
  needsDetailedZoomConfirmation(13, false) && needsDetailedZoomConfirmation(14, false),
  'confirmation: a detailed extract without --yes has to be refused',
)
assert(
  !needsDetailedZoomConfirmation(13, true) && !needsDetailedZoomConfirmation(11, false) && !needsDetailedZoomConfirmation(12, false),
  'confirmation: --yes clears it, and the shallow zooms never need it',
)
assert(
  detailedZoomWarning(13).includes('zoom-13') && detailedZoomWarning(13).includes('MANY TIMES LARGER'),
  'warning: names the zoom level being built and says how much bigger it is',
)
assert(
  detailedZoomWarning(13).includes('NOT') && detailedZoomWarning(13).includes('dry run'),
  'warning: says the size is NOT measured here and points at the pmtiles dry run instead',
)
assert(
  detailedZoomWarning(13) === detailedZoomWarning(13) && detailedZoomWarning(14) !== detailedZoomWarning(13),
  'warning: is a pure function of the zoom level',
)

// --- file names and the URLs recorded in areas.local.json ---
assertEqual(pmtilesFileName('sydney', 13), 'sydney-z13.pmtiles', 'name: the file name carries the zoom level')
assertEqual(pmtilesFileName('sydney'), 'sydney-z11.pmtiles', `name: with no zoom given the default is ${DEFAULT_MAX_ZOOM}`)
assertEqual(pmtilesUrlFor('dover', 14), '/tiles/dover-z14.pmtiles', 'url: the recorded URL is the file under /tiles')
assertEqual(pmtilesUrlFor('dover'), '/tiles/dover-z11.pmtiles', 'url: the default recorded URL is unchanged from before this story')
assertEqual(
  buildCustomAreaRecord('Mombasa', -4.0435, 39.6682, 20).pmtilesUrl,
  '/tiles/mombasa-z11.pmtiles',
  'record: a custom area with no --maxzoom keeps the zoom-11 URL it always had',
)
assertEqual(
  buildCustomAreaRecord('Mombasa', -4.0435, 39.6682, 20, 13).pmtilesUrl,
  '/tiles/mombasa-z13.pmtiles',
  'record: a custom area with --maxzoom 13 records the detailed URL',
)
assertEqual(
  buildBasemapRecord(pmtilesUrlFor('dover', 13)),
  { pmtilesUrl: '/tiles/dover-z13.pmtiles', places: [] },
  'record: a built-in detailed extract is recorded as a basemaps override, not an areas entry',
)
const detailedMerge = mergeLocalAreaRecord(null, {
  kind: 'builtin',
  key: 'dover',
  value: buildBasemapRecord(pmtilesUrlFor('dover', 13)),
})
assertEqual(
  detailedMerge.basemaps?.dover.pmtilesUrl,
  '/tiles/dover-z13.pmtiles',
  'record: merging writes the detailed URL under basemaps.dover, where it outranks the shipped map',
)
assertEqual(
  detailedMerge.areas,
  undefined,
  'record: merging a built-in extract does NOT also create an areas entry',
)
assert(
  parseLocalAreas(detailedMerge).ok,
  'record: the file this tool writes is one parseLocalAreas accepts (the URL pattern and the precedence agree)',
)

assertEqual(candidateBuildDates(new Date('2026-03-01T00:30:00+08:00')), ['20260228', '20260227', '20260226', '20260225'], 'dates: use UTC and cross month boundary')
assertEqual(candidateBuildDates(new Date('2026-01-01T12:00:00Z')), ['20260101', '20251231', '20251230', '20251229'], 'dates: cross year boundary')

const binaryCalls: string[] = []
const pathBinary = findPmtilesBinary('C:\\repo', {
  existsSync: (filePath) => filePath === 'C:\\repo\\tools\\pmtiles.exe',
  spawnSync: (command, args, options) => {
    binaryCalls.push(`${command} ${args?.join(' ')} shell=${options?.shell}`)
    return {
      status: command === (process.platform === 'win32' ? 'where.exe' : 'which') ? 0 : 1,
      stdout: 'C:\\tools\\pmtiles.exe\r\n',
    }
  },
})
assertEqual(pathBinary, 'C:\\tools\\pmtiles.exe', 'binary: resolves PATH binary to its full path')
assertEqual(binaryCalls, [`${process.platform === 'win32' ? 'where.exe' : 'which'} pmtiles shell=false`], 'binary: uses a shell-free PATH lookup')

const localBinaryCalls: string[] = []
const localBinary = findPmtilesBinary('C:\\repo', {
  existsSync: (filePath) => {
    localBinaryCalls.push(filePath)
    return filePath === 'C:\\repo\\tools\\pmtiles.exe'
  },
  spawnSync: () => ({ status: 1 }),
})
assertEqual(localBinary, 'C:\\repo\\tools\\pmtiles.exe', 'binary: falls back to tools\\pmtiles.exe')
assertEqual(localBinaryCalls, ['C:\\repo\\tools\\pmtiles.exe'], 'binary: stops at first local candidate')

const source = 'https://example.com/map.pmtiles'
const extractArgs = buildExtractArgs(source, 'temp.pmtiles', 51.1, 1.45, 20)
let runnerBinary = ''
let runnerArgs: readonly string[] = []
let runnerShell: boolean | undefined
runPmtiles('C:\\tools\\pmtiles.exe', extractArgs, (binary, argv, options) => {
  runnerBinary = binary
  runnerArgs = argv
  runnerShell = options.shell
  return { status: 0 }
})
assert(runnerBinary === 'C:\\tools\\pmtiles.exe', 'runner: uses the resolved binary path')
assert(Array.isArray(runnerArgs), 'runner: receives an argument array')
assert(runnerArgs[1] === source && runnerArgs[3] === '--bbox=0.1230,50.6000,2.7770,51.6000', 'runner: source and bbox are separate arguments')
assert(runnerShell === false, 'runner: disables shell execution')

const added = mergeLocalAreaRecord(null, {
  kind: 'custom',
  key: 'mombasa',
  value: { displayName: 'Mombasa', centerLat: -4, centerLon: 39, radiusNm: 20 },
})
assert(added.areas?.mombasa.displayName === 'Mombasa', 'merge: adds a custom area')
let collisionRefused = false
try {
  mergeLocalAreaRecord(null, {
    kind: 'custom',
    key: 'dover',
    value: { displayName: 'Dover', centerLat: 0, centerLon: 0, radiusNm: 20 },
  })
} catch (error) {
  collisionRefused = (error as Error).message.includes('collides with a built-in')
}
assert(collisionRefused, 'merge: refuses a built-in key collision')
let overwriteRefused = false
try {
  mergeLocalAreaRecord(added, {
    kind: 'custom',
    key: 'mombasa',
    value: { displayName: 'New Mombasa', centerLat: -4, centerLon: 39, radiusNm: 20 },
  })
} catch (error) {
  overwriteRefused = (error as Error).message.includes('--overwrite')
}
assert(overwriteRefused, 'merge: refuses replacing an existing local record without --overwrite')
const overwritten = mergeLocalAreaRecord(added, {
  kind: 'custom',
  key: 'mombasa',
  value: { displayName: 'New Mombasa', centerLat: -4, centerLon: 39, radiusNm: 20 },
  overwrite: true,
})
assert(overwritten.areas?.mombasa.displayName === 'New Mombasa', 'merge: allows replacement with --overwrite')

console.log(`makeAreaCore tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
