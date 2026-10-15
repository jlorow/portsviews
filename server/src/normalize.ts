import type { VesselFix, VesselType } from '@wake/shared'

export type NormalizedMessage =
  | { kind: 'position'; fix: VesselFix; shipName?: string }
  | {
      kind: 'static'
      mmsi: string
      shipName?: string
      vesselType: VesselType
      dimensions?: { lengthM: number; beamM: number }
    }

const SOG_SENTINEL = 102.3
const COG_SENTINEL = 360

// Go's time.Time default string format, e.g.
// "2026-09-14 22:21:32.409064434 +0000 UTC". Nanosecond precision does not
// survive a JS Date, so only the first 3 fractional digits are used.
const TIME_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\d* ([+-])(\d{2})(\d{2}) UTC$/

function parseTimeUtc(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = TIME_UTC_PATTERN.exec(value)
  if (!match) return undefined

  const [, year, month, day, hour, minute, second, millis, sign, offHour, offMin] = match
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millis),
  )
  const offsetMs = (Number(offHour) * 60 + Number(offMin)) * 60_000 * (sign === '-' ? -1 : 1)
  return ms - offsetMs
}

function toMmsi(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const str = String(value)
  if (!/^\d+$/.test(str)) return undefined
  return str.padStart(9, '0')
}

function cleanShipName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function mapShipTypeCode(code: unknown): VesselType {
  if (typeof code !== 'number') return 'unknown'
  if (code === 31 || code === 32 || code === 50 || code === 52 || code === 53) return 'tugboat'
  if (code === 35 || code === 51 || code === 54 || code === 55 || code === 59) return 'naval'
  if ((code >= 40 && code <= 49) || (code >= 60 && code <= 69)) return 'ferry'
  if (code >= 70 && code <= 79) return 'cargo'
  if (code >= 80 && code <= 89) return 'tanker'
  return 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizePosition(
  metaData: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  messageType: 'PositionReport' | 'StandardClassBPositionReport',
): NormalizedMessage | undefined {
  const mmsi = toMmsi(metaData.MMSI_String)
  const lat = metaData.latitude
  const lon = metaData.longitude
  const timestamp = parseTimeUtc(metaData.time_utc)

  if (mmsi === undefined || typeof lat !== 'number' || typeof lon !== 'number' || timestamp === undefined) {
    return undefined
  }

  const inner = isRecord(message) ? message[messageType] : undefined
  const rawSog = isRecord(inner) ? inner.Sog : undefined
  const rawCog = isRecord(inner) ? inner.Cog : undefined
  const rawHeading = isRecord(inner) ? inner.TrueHeading : undefined

  const sogValid = typeof rawSog === 'number' && Number.isFinite(rawSog) && rawSog !== SOG_SENTINEL
  const cogValid = typeof rawCog === 'number' && Number.isFinite(rawCog) && rawCog !== COG_SENTINEL
  const headingDeg =
    typeof rawHeading === 'number' && Number.isFinite(rawHeading) && rawHeading >= 0 && rawHeading <= 359
      ? rawHeading
      : undefined

  const sogKn = sogValid && cogValid ? (rawSog as number) : 0
  const cogDeg = sogValid && cogValid ? (rawCog as number) : 0

  const fix: VesselFix = { mmsi, lat, lon, cogDeg, sogKn, ...(headingDeg === undefined ? {} : { headingDeg }), timestamp }
  const shipName = cleanShipName(metaData.ShipName)
  return { kind: 'position', fix, shipName }
}

function normalizeStatic(
  metaData: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
): NormalizedMessage | undefined {
  const mmsi = toMmsi(metaData.MMSI_String)
  if (mmsi === undefined) return undefined

  const inner = isRecord(message) ? message.ShipStaticData : undefined
  const vesselType = mapShipTypeCode(isRecord(inner) ? inner.Type : undefined)
  const shipName = cleanShipName(isRecord(inner) ? inner.Name : undefined) ?? cleanShipName(metaData.ShipName)

  const dim = isRecord(inner) ? inner.Dimension : undefined
  let dimensions: { lengthM: number; beamM: number } | undefined
  if (
    isRecord(dim) &&
    typeof dim.A === 'number' &&
    typeof dim.B === 'number' &&
    typeof dim.C === 'number' &&
    typeof dim.D === 'number'
  ) {
    dimensions = { lengthM: dim.A + dim.B, beamM: dim.C + dim.D }
  }

  return { kind: 'static', mmsi, shipName, vesselType, dimensions }
}

export function normalize(envelope: unknown): NormalizedMessage | undefined {
  if (!isRecord(envelope)) return undefined

  const messageType = envelope.MessageType
  const metaData = envelope.MetaData
  const message = envelope.Message

  if (typeof messageType !== 'string' || !isRecord(metaData)) return undefined

  if (messageType === 'PositionReport' || messageType === 'StandardClassBPositionReport') {
    return normalizePosition(metaData, isRecord(message) ? message : undefined, messageType)
  }

  if (messageType === 'ShipStaticData') {
    return normalizeStatic(metaData, isRecord(message) ? message : undefined)
  }

  return undefined
}
