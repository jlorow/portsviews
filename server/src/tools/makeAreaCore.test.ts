import {
  buildExtractArgs,
  candidateBuildDates,
  findPmtilesBinary,
  mergeLocalAreaRecord,
  parseMakeAreaArgs,
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

const customDefault = parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4.0435', '--lon', '39.6682'])
assert(customDefault.ok && customDefault.value.mode === 'custom' && customDefault.value.radius === 20, 'arguments: custom mode defaults radius to 20')
const customSource = parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--radius', '25', '--source', 'local.pmtiles'])
assert(customSource.ok && customSource.value.mode === 'custom' && customSource.value.source === 'local.pmtiles', 'arguments: custom mode accepts explicit radius and source')
assertEqual(parseMakeAreaArgs(['--builtin', 'sydney']), { ok: true, value: { builtin: 'sydney', mode: 'builtin' } }, 'arguments: built-in mode')
const builtInSource = parseMakeAreaArgs(['--builtin', 'istanbul', '--build-date', '20261014', '--overwrite', '--dry-run'])
assert(builtInSource.ok && builtInSource.value.mode === 'builtin' && builtInSource.value.overwrite === true && builtInSource.value.dryRun === true, 'arguments: built-in mode accepts date, overwrite and dry-run')
const datedCustom = parseMakeAreaArgs(['--name', 'Port Said', '--lat', '31.35', '--lon', '32.35', '--build-date', '20261014'])
assert(datedCustom.ok && datedCustom.value.mode === 'custom' && datedCustom.value.buildDate === '20261014', 'arguments: custom mode accepts a build date')
assert(parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--overwrite']).ok, 'arguments: overwrite flag')
assert(parseMakeAreaArgs(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--dry-run']).ok, 'arguments: dry-run flag')

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
assertParseError(['--source', 'local.pmtiles'], 'must be used with', 'arguments: source without area')
assertParseError(['--build-date', '20261014'], 'must be used with', 'arguments: date without area')
assertParseError(['--name', 'Mombasa', '--lat', '-4', '--lon', '39', '--build-date', '20260230'], 'Invalid build date', 'arguments: impossible calendar date')
assertParseError(['--source', 'a.pmtiles', '--build-date', '20261014', '--name', 'Area', '--lat', '0', '--lon', '0'], 'either --source or --build-date', 'arguments: mutually exclusive source selectors')
assertParseError(['--builtin', 'sydney', '--name', 'Area', '--lat', '0', '--lon', '0'], 'cannot be combined', 'arguments: built-in and custom definition conflict')
assertParseError(['--name', 'A', '--lat', '0', '--lon', '0', '--name', 'B'], 'Duplicate option', 'arguments: duplicate option')
assertParseError(['--unknown'], 'Unknown argument', 'arguments: unknown option')
assertParseError(['--help', '--dry-run'], 'cannot be combined', 'arguments: help cannot be combined')

assertEqual(
  buildExtractArgs('source.pmtiles', 'temp.pmtiles', 51.1, 1.45, 20),
  ['extract', 'source.pmtiles', 'temp.pmtiles', '--bbox=0.1230,50.6000,2.7770,51.6000', '--maxzoom=11'],
  'extract: exact PMTiles arguments and bounding box',
)

assertEqual(candidateBuildDates(new Date('2026-03-01T00:30:00+08:00')), ['20260228', '20260227', '20260226', '20260225'], 'dates: use UTC and cross month boundary')
assertEqual(candidateBuildDates(new Date('2026-01-01T12:00:00Z')), ['20260101', '20251231', '20251230', '20251229'], 'dates: cross year boundary')

const binaryCalls: string[] = []
const pathBinary = findPmtilesBinary('C:\\repo', {
  existsSync: (filePath) => filePath === 'C:\\repo\\tools\\pmtiles.exe',
  spawnSync: (command, args) => {
    binaryCalls.push(`${command} ${args?.join(' ')}`)
    return { status: command === 'pmtiles' ? 0 : 1 }
  },
})
assertEqual(pathBinary, 'pmtiles', 'binary: PATH binary takes precedence')
assertEqual(binaryCalls, ['pmtiles version'], 'binary: checks PATH before local tools')

const localBinaryCalls: string[] = []
const localBinary = findPmtilesBinary('C:\\repo', {
  existsSync: (filePath) => {
    localBinaryCalls.push(filePath)
    return filePath === 'C:\\repo\\tools\\pmtiles.exe'
  },
  spawnSync: () => ({ status: 1 }),
})
assertEqual(localBinary, 'C:\\repo\\tools\\pmtiles.exe', 'binary: checks tools\\pmtiles.exe before tools\\pmtiles')
assertEqual(localBinaryCalls, ['C:\\repo\\tools\\pmtiles.exe'], 'binary: stops at first local candidate')
const unixBinary = findPmtilesBinary('C:\\repo', {
  existsSync: (filePath) => filePath === 'C:\\repo\\tools\\pmtiles',
  spawnSync: () => ({ status: 1 }),
})
assertEqual(unixBinary, 'C:\\repo\\tools\\pmtiles', 'binary: falls back to tools\\pmtiles')

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
