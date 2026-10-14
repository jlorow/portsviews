import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'
import { DEFAULT_RADIUS_NM, DEMO_AREAS, parseLocalAreas, slugify, type LocalAreasFile } from '@wake/shared'
import {
  buildBasemapRecord,
  buildCustomAreaRecord,
  buildExtractArgs,
  candidateBuildDates,
  ensureLocalAreaFileIsValid,
  findPmtilesBinary,
  isValidDateCode,
  mergeLocalAreaRecord,
  parseMakeAreaArgs,
  runPmtiles,
  type MakeAreaArgs,
} from './makeAreaCore.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const localAreasPath = path.join(repoRoot, 'areas.local.json')

function printUsage(): void {
  console.log('Usage: pnpm make-area [--name "Mombasa" --lat -4.0435 --lon 39.6682 [--radius 20]] [--source <url-or-path> | --build-date YYYYMMDD] [--overwrite] [--dry-run]')
  console.log('       pnpm make-area --builtin <dover|istanbul|portsaid|sydney> [--source <url-or-path> | --build-date YYYYMMDD] [--overwrite] [--dry-run]')
  console.log('       pnpm make-area')
  console.log('       pnpm make-area --help')
}

function readLocalFile(): LocalAreasFile | null {
  if (!fs.existsSync(localAreasPath)) return null
  try {
    const raw = fs.readFileSync(localAreasPath, 'utf8')
    const parsed = JSON.parse(raw)
    const result = parseLocalAreas(parsed)
    if (!result.ok) {
      throw new Error(result.errors.join('\n'))
    }
    return result.value
  } catch (err) {
    console.error(`Could not read ${path.basename(localAreasPath)}: ${(err as Error).message}`)
    process.exit(1)
  }
}

async function promptForCustomArea(): Promise<MakeAreaArgs> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('To find coordinates: right-click the spot in Google Maps; the two numbers at the top of the menu are latitude then longitude.')
  const name = (await rl.question('Area name: ')).trim()
  const latText = (await rl.question('Latitude: ')).trim()
  const lonText = (await rl.question('Longitude: ')).trim()
  const radiusText = (await rl.question('Radius in nautical miles [20]: ')).trim() || '20'
  rl.close()

  return {
    mode: 'custom',
    name,
    lat: Number(latText),
    lon: Number(lonText),
    radius: Number(radiusText),
  }
}

function buildSourceUrl(date: string): string {
  return `https://build.protomaps.com/${date}.pmtiles`
}

function tryPmtilesShow(binaryPath: string, source: string): { ok: boolean; stdout?: string; stderr?: string } {
  const result = runPmtiles(binaryPath, ['show', source])
  return {
    ok: result.status === 0,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
}

function printPmtilesMissing(): void {
  console.error('PMTiles is not installed or available in this project.')
  console.error('Download the Windows x86_64 zip from https://github.com/protomaps/go-pmtiles/releases, extract pmtiles.exe, and put it in this project\\tools folder.')
  console.error('On other systems, install pmtiles on the PATH.')
  process.exit(2)
}

function fsAtomicWriteJson(filePath: string, value: LocalAreasFile): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', 'utf8')
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch (cleanupError) {
      throw new Error(`${(error as Error).message}; also could not remove temporary file: ${(cleanupError as Error).message}`)
    }
    throw error
  }
}

function printPlacesNote(): void {
  console.log('No town names are drawn until places are added to areas.local.json by hand, for example:')
  console.log('  "places": [{ "name": "Mombasa", "lat": -4.0435, "lon": 39.6682 }]')
}

function showArchive(binaryPath: string, archivePath: string): boolean {
  const result = runPmtiles(binaryPath, ['show', archivePath])
  if (result.status !== 0) {
    console.error(`Could not inspect the extracted PMTiles archive ${archivePath}.`)
    console.error((result.stderr ?? '').toString() || (result.stdout ?? '').toString() || 'pmtiles show failed.')
    return false
  }
  const output = (result.stdout ?? '').toString().trim()
  console.log('PMTiles archive details:')
  console.log(output || `Archive created at ${archivePath}.`)
  return true
}

function removeTemp(tempPath: string): string | undefined {
  try {
    fs.rmSync(tempPath, { force: true })
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  const parsed = parseMakeAreaArgs(rawArgs)
  if (!parsed.ok) {
    for (const error of parsed.errors) console.error(error)
    printUsage()
    process.exit(1)
  }

  let args = parsed.value
  if (args.help) {
    printUsage()
    return
  }

  if (!args.mode || args.mode === 'interactive') {
    const prompted = await promptForCustomArea()
    const validated = parseMakeAreaArgs([
      '--name', prompted.name ?? '',
      '--lat', String(prompted.lat),
      '--lon', String(prompted.lon),
      '--radius', String(prompted.radius ?? 20),
    ])
    if (!validated.ok) {
      for (const error of validated.errors) console.error(error)
      process.exit(1)
    }
    args = {
      ...validated.value,
      overwrite: args.overwrite,
      dryRun: args.dryRun,
    }
  }

  const binaryPath = findPmtilesBinary(repoRoot)
  if (binaryPath === null) {
    printPmtilesMissing()
    throw new Error('unreachable')
  }

  const workingFile = readLocalFile()

  let key: string
  let centerLat: number
  let centerLon: number
  let radiusNm: number
  let mergedFile: LocalAreasFile
  if (args.builtin) {
    const area = DEMO_AREAS[args.builtin as keyof typeof DEMO_AREAS]
    if (!area) {
      console.error(`Built-in area ${JSON.stringify(args.builtin)} does not exist. Valid values: ${Object.keys(DEMO_AREAS).join(', ')}.`)
      process.exit(1)
    }
    key = args.builtin
    centerLat = area.centerLat
    centerLon = area.centerLon
    radiusNm = area.radiusNm
    mergedFile = ensureLocalAreaFileIsValid(mergeLocalAreaRecord(workingFile, {
      kind: 'builtin',
      key,
      value: buildBasemapRecord(`/tiles/${key}-z11.pmtiles`),
      overwrite: args.overwrite || args.dryRun,
    }))
  } else {
    const customArgs = args as MakeAreaArgs & { name: string; lat: number; lon: number; radius?: number }
    key = slugify(customArgs.name)
    if (!key) {
      console.error('The area name must produce a valid slug.')
      process.exit(1)
    }
    if (Object.prototype.hasOwnProperty.call(DEMO_AREAS, key)) {
      console.error(`The slug ${JSON.stringify(key)} collides with a built-in area name. Choose a different custom area.`)
      process.exit(1)
    }
    centerLat = customArgs.lat
    centerLon = customArgs.lon
    radiusNm = customArgs.radius ?? 20
    mergedFile = ensureLocalAreaFileIsValid(mergeLocalAreaRecord(workingFile, {
      kind: 'custom',
      key,
      value: buildCustomAreaRecord(customArgs.name, centerLat, centerLon, radiusNm),
      overwrite: args.overwrite || args.dryRun,
    }))
  }

  const tilePath = path.join(repoRoot, 'apps', 'display', 'public', 'tiles', `${key}-z11.pmtiles`)
  if (fs.existsSync(tilePath) && !args.overwrite && !args.dryRun) {
    console.error(`Refusing to overwrite ${tilePath}. Add --overwrite to replace it.`)
    process.exit(1)
  }

  let chosenSource: string | undefined
  if (args.source) {
    chosenSource = args.source
  } else if (args.buildDate) {
    if (!isValidDateCode(args.buildDate)) {
      console.error('The --build-date value must be a real date in YYYYMMDD format.')
      process.exit(1)
    }
    chosenSource = buildSourceUrl(args.buildDate)
  } else {
    const candidates = candidateBuildDates()
    for (const date of candidates) {
      const source = buildSourceUrl(date)
      const result = tryPmtilesShow(binaryPath, source)
      if (result.ok) {
        chosenSource = source
        break
      }
    }
    if (!chosenSource) {
      console.error('No available Protomaps build was reachable from the expected URLs.')
      console.error('The build URL may have changed. See https://docs.protomaps.com/guide/getting-started')
      console.error('Try --build-date YYYYMMDD or --source <url-or-path>.')
      process.exit(3)
    }
  }

  if (args.source || args.buildDate) {
    const sourceCheck = tryPmtilesShow(binaryPath, chosenSource!)
    if (!sourceCheck.ok) {
      console.error(`PMTiles could not read the source ${chosenSource}.`)
      console.error(sourceCheck.stderr || sourceCheck.stdout || '')
      process.exit(3)
    }
  }

  const tempPath = `${tilePath}.${process.pid}.tmp`
  const extractArgs = buildExtractArgs(chosenSource!, tempPath, centerLat, centerLon, radiusNm)
  if (args.dryRun) {
    console.log(`Dry run: would run pmtiles with arguments ${JSON.stringify(extractArgs)}`)
  } else {
    fs.mkdirSync(path.dirname(tilePath), { recursive: true })
    const extraction = runPmtiles(binaryPath, extractArgs)
    if (extraction.status !== 0) {
      const cleanupError = removeTemp(tempPath)
      console.error((extraction.stderr ?? '').toString() || (extraction.stdout ?? '').toString() || 'Extraction failed.')
      if (cleanupError) console.error(`Could not remove temporary extract: ${cleanupError}`)
      process.exit(1)
    }
    if (!showArchive(binaryPath, tempPath)) {
      const cleanupError = removeTemp(tempPath)
      if (cleanupError) console.error(`Could not remove temporary extract: ${cleanupError}`)
      process.exit(1)
    }
    fs.renameSync(tempPath, tilePath)
    fsAtomicWriteJson(localAreasPath, mergedFile)
  }

  const bytes = !args.dryRun && fs.existsSync(tilePath) ? fs.statSync(tilePath).size : 0
  console.log(`File size: ${bytes} bytes`)
  if (radiusNm > DEFAULT_RADIUS_NM) {
    console.warn(`Warning: ${radiusNm} nm is larger than the default 20 nm and may create a substantially larger archive.`)
  }
  console.log(`To use it, put WAKE_AREA=${key} in your .env, then restart BOTH the server and the display.`)
  printPlacesNote()
}

main().catch((err) => {
  console.error((err as Error).message)
  process.exit(1)
})
