import fs from 'node:fs'
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BROADCAST_PORT,
  DEFAULT_CONFIG,
  DEMO_AREAS,
  isBlank,
  parsePort,
  parseAisSource,
  parseLocalAreas,
  resolveArea,
  resolveSourceConfig,
} from '@wake/shared'
import { acquireLock } from './lock.ts'
import { registerShutdown } from './shutdown.ts'
import { createCaptureLogger } from './capture.ts'
import {
  createAisStreamClient,
  type AisStreamMessage,
  FILTER_MESSAGE_TYPES,
} from './aisstream.ts'
import { createPositionMap, createStaticMap } from './caches.ts'
import { missingKeyLines } from './envHint.ts'
import { createBroadcastServer } from './broadcast.ts'
import { createStaticHandler } from './staticFiles.ts'
import { processEnvelope, type PipelineContext } from './pipeline.ts'
import { createTrackMap } from './trackBuffer.ts'

// pnpm --filter runs this script with cwd set to server/, not the repo
// root, so bare `dotenv/config` (which only checks process.cwd()) would
// never find the root .env. Resolve it explicitly instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// One definition of the .env path, used both by dotenv here and by the
// missing-key hint below, so the hint can never name a different file than
// the one that was actually loaded (first-run fix).
const repoRoot = path.resolve(__dirname, '..', '..')
const envPath = path.join(repoRoot, '.env')
config({ path: envPath })

// DEMO-1: demo area and AIS source come from settings. Invalid values or
// a missing key for the chosen source refuse to start with a clear
// message naming the VARIABLE -- never its value -- and do so BEFORE
// acquireLock(), so a refused start never leaves a stale PID lockfile.
const localAreasPath = path.join(repoRoot, 'areas.local.json')

function readLocalAreas(): import('@wake/shared').LocalAreasFile | null {
  if (!fs.existsSync(localAreasPath)) return null
  try {
    const raw = fs.readFileSync(localAreasPath, 'utf8')
    const parsed = JSON.parse(raw)
    const result = parseLocalAreas(parsed)
    if (!result.ok) {
      console.error(`[Wake] areas.local.json is invalid:`)
      for (const error of result.errors) console.error(`  - ${error}`)
      process.exit(1)
    }
    return result.value
  } catch (error) {
    console.error(`[Wake] Unable to read areas.local.json: ${(error as Error).message}`)
    process.exit(1)
  }
}

const localAreas = readLocalAreas()
const WAKE_AREA_RAW = process.env.WAKE_AREA
const WAKE_AIS_SOURCE_RAW = process.env.WAKE_AIS_SOURCE

const resolvedArea = resolveArea(WAKE_AREA_RAW, localAreas)
const validAreaKeys = [...Object.keys(DEMO_AREAS), ...(localAreas?.areas ? Object.keys(localAreas.areas) : [])]
if (resolvedArea === null) {
  console.error(
    `[Wake] Invalid WAKE_AREA ${JSON.stringify(WAKE_AREA_RAW)} -- expected one of: ${validAreaKeys.join(', ')}. Refusing to start.`,
  )
  process.exit(1)
}
const areaKey = resolvedArea.key

const aisSource = parseAisSource(WAKE_AIS_SOURCE_RAW)
if (aisSource === null) {
  console.error(
    `[Wake] Invalid WAKE_AIS_SOURCE ${JSON.stringify(WAKE_AIS_SOURCE_RAW)} -- expected 'aisstream' or 'aiscast'. Refusing to start.`,
  )
  process.exit(1)
}

const sourceConfig = resolveSourceConfig(
  {
    aisstreamApiKey: process.env.AISSTREAM_API_KEY,
    aiscastToken: process.env.AISCAST_TOKEN,
  },
  aisSource,
)
if ('error' in sourceConfig) {
  // First-run fix: two plain lines before the error. Where .env was looked
  // for, and whether it was there -- fs.existsSync ONLY, so the file is
  // never read, parsed or printed, and no value can reach the log. The
  // lines themselves come from a pure helper (envHint.ts) so a test covers
  // all three cases.
  const missingVariable = aisSource === 'aiscast' ? 'AISCAST_TOKEN' : 'AISSTREAM_API_KEY'
  for (const line of missingKeyLines(envPath, fs.existsSync(envPath), missingVariable)) {
    console.error(line)
  }
  console.error(`[Wake] ${sourceConfig.error}`)
  process.exit(1)
}

console.log(`[Wake] Area: ${areaKey} · ${resolvedArea.area.displayName} · Source: ${aisSource}`)

const area = resolvedArea.area

// WAKE_STATIC_DIR: blank means the WebSocket-only server, exactly as
// before. Set, it is the built display folder (relative to the repo root,
// like .env), served on the same port as the live feed. A missing folder
// or index.html refuses to start here, before the lock is taken.
const WAKE_STATIC_DIR_RAW = process.env.WAKE_STATIC_DIR
let staticDir: string | null = null
if (!isBlank(WAKE_STATIC_DIR_RAW)) {
  const resolvedStaticDir = path.resolve(repoRoot, WAKE_STATIC_DIR_RAW.trim())
  const indexPath = path.join(resolvedStaticDir, 'index.html')
  const isFolder = fs.existsSync(resolvedStaticDir) && fs.statSync(resolvedStaticDir).isDirectory()
  const hasIndex = isFolder && fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()
  if (!hasIndex) {
    console.error(
      `[Wake] WAKE_STATIC_DIR points to ${resolvedStaticDir}, which is not a folder with an index.html. Refusing to start.`,
    )
    process.exit(1)
  }
  staticDir = resolvedStaticDir
}

acquireLock()

const HEARTBEAT_MS = 60000
// A blank WAKE_BROADCAST_PORT is unset, not 0: `??` never fires for '',
// and Number('') is 0, which would bind a random ephemeral port the
// display cannot know about.
const portResult = parsePort(process.env.WAKE_BROADCAST_PORT, DEFAULT_BROADCAST_PORT, 'WAKE_BROADCAST_PORT')
if (!portResult.ok) {
  console.error(`[Wake] ${portResult.error}`)
  process.exit(1)
}
const BROADCAST_PORT = portResult.value
if (staticDir !== null) {
  console.log(`[Wake] Serving the display from ${staticDir} on port ${BROADCAST_PORT}`)
}

interface BoxBounds {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

interface BoxStat {
  label: string
  bounds: BoxBounds
  messages: number
  uniqueMmsis: Set<number>
  typeCounts: Record<string, number>
}

// Corner order in a box list is documentation-convention (NW, SE), not
// guaranteed min/max — normalise here rather than assume which corner is
// which, so attribution doesn't silently break if the convention changes.
// Kept for S3.2's multi-region pool, which will read boxStats directly —
// this story doesn't log per-box numbers.
//
// DEMO-1: boxes come from the ACTIVE area, not a module constant, so
// per-box attribution keeps matching what was actually subscribed (same
// rationale as the defaults note in aisstream.ts). With the default area
// this is identical to the previous BOUNDING_BOXES/BOUNDING_BOX_LABELS.
function buildBoxStats(boxes: number[][][], labels: string[]): BoxStat[] {
  return boxes.map(([[lat1, lon1], [lat2, lon2]], i) => ({
    label: labels[i] ?? `BOX_${i}`,
    bounds: {
      minLat: Math.min(lat1, lat2),
      maxLat: Math.max(lat1, lat2),
      minLon: Math.min(lon1, lon2),
      maxLon: Math.max(lon1, lon2),
    },
    messages: 0,
    uniqueMmsis: new Set<number>(),
    typeCounts: {},
  }))
}

const boxStats: BoxStat[] = buildBoxStats(area.boundingBoxes, [areaKey.toUpperCase()])

const processStartedAt = Date.now()
let messagesThisMinute = 0
const uniqueMmsisSinceStart = new Set<number>()

// Documentation bug: aisstream.io's docs show MetaData.Latitude and
// MetaData.Longitude, capitalised. Live envelopes emit them lowercase —
// "latitude"/"longitude" — instead. Confusingly, the inner
// Message.PositionReport object DOES use the capitalised Latitude/Longitude
// the docs describe: both casings coexist at different nesting levels of
// the same envelope. Detect the real key from live data rather than trust
// either casing.
//
// Also undocumented: MetaData.MMSI_String arrives as an unquoted JSON
// number despite its name, not a pre-converted string — S3.3 must not
// assume otherwise.
const DOCUMENTED_LAT_KEY = 'Latitude'
const DOCUMENTED_LON_KEY = 'Longitude'
const LAT_KEYS = [DOCUMENTED_LAT_KEY, 'latitude', 'LATITUDE', 'lat', 'Lat']
const LON_KEYS = [DOCUMENTED_LON_KEY, 'longitude', 'LONGITUDE', 'lon', 'Lon']
let loggedCoordFieldNames = false

function extractCoords(meta: AisStreamMessage['MetaData']): { lat: number; lon: number } | undefined {
  if (!meta) return undefined

  const latKey = LAT_KEYS.find((k) => typeof meta[k] === 'number')
  const lonKey = LON_KEYS.find((k) => typeof meta[k] === 'number')
  if (latKey === undefined || lonKey === undefined) return undefined

  if (!loggedCoordFieldNames) {
    loggedCoordFieldNames = true
    const matchesDocs = latKey === DOCUMENTED_LAT_KEY && lonKey === DOCUMENTED_LON_KEY
    console.log(
      `[Wake] Coordinate fields confirmed from live data: latitude="${latKey}" longitude="${lonKey}" ` +
        `(matches documented Latitude/Longitude: ${matchesDocs})`,
    )
  }

  return { lat: meta[latKey] as number, lon: meta[lonKey] as number }
}

function findBox(coords: { lat: number; lon: number }): BoxStat | undefined {
  return boxStats.find(
    (box) =>
      coords.lat >= box.bounds.minLat &&
      coords.lat <= box.bounds.maxLat &&
      coords.lon >= box.bounds.minLon &&
      coords.lon <= box.bounds.maxLon,
  )
}

const captureLogger = createCaptureLogger()

const positionMap = createPositionMap()
const staticMap = createStaticMap()
// The route-history buffer. Created here, beside the position map it is
// pruned against and filled by processEnvelope; handed to the broadcast
// server so a connecting display's snapshot carries each ship's history.
const trackMap = createTrackMap()
const broadcastServer = createBroadcastServer(BROADCAST_PORT, positionMap, staticMap, trackMap, {
  staticHandler: staticDir === null ? undefined : createStaticHandler(staticDir),
})

const pipelineCtx: PipelineContext = {
  positionMap,
  staticMap,
  trackMap,
  clients: broadcastServer.clients,
  removeSec: DEFAULT_CONFIG.removeSec,
}

// No onDisconnected handler: display clients stay connected and are
// never closed because of an AIS-side outage. A dropped AIS connection
// simply means onMessage stops firing until aisstream.ts's own backoff
// reconnects it -- broadcasting goes quiet with no new code needed, and
// no explicit "AIS down" state is sent to clients (S1.7's spec only
// distinguishes connected-to-server from disconnected-from-server).
const client = createAisStreamClient({
  boundingBoxes: area.boundingBoxes,
  filterMessageTypes: FILTER_MESSAGE_TYPES,
}, {
  onMessage: (message: AisStreamMessage) => {
    messagesThisMinute++

    const mmsi = message.MetaData?.MMSI
    if (typeof mmsi === 'number') {
      uniqueMmsisSinceStart.add(mmsi)
    }

    const coords = extractCoords(message.MetaData)
    const matchedBox = coords ? findBox(coords) : undefined

    if (matchedBox) {
      matchedBox.messages++
      matchedBox.typeCounts[message.MessageType] = (matchedBox.typeCounts[message.MessageType] ?? 0) + 1
      if (typeof mmsi === 'number') {
        matchedBox.uniqueMmsis.add(mmsi)
      }
    }

    processEnvelope(message, pipelineCtx, Date.now())
  },
}, captureLogger, undefined, { url: sourceConfig.url, apiKey: sourceConfig.apiKey })

registerShutdown(client, captureLogger, broadcastServer.clients)

client.connect()

setInterval(() => {
  const uptimeSec = Math.round((Date.now() - processStartedAt) / 1000)
  console.log(
    `[Wake] alive — vessels: ${uniqueMmsisSinceStart.size}  msgs/min: ${messagesThisMinute}  uptime: ${uptimeSec}s`,
  )
  messagesThisMinute = 0
}, HEARTBEAT_MS)
