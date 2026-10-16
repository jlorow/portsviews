// DEMO-1 — demo areas and AIS source selection.
//
// Client-safe module: imported by both the display (WakeCanvas, via the
// @wake/shared alias) and the server (index.ts, replay.ts). No Node-only
// imports here.

/**
 * The AISstream endpoint. Defined here (shared) so the server's client
 * and resolveSourceConfig cannot drift apart; server/src/aisstream.ts
 * re-exports it. Value unchanged from the pre-DEMO-1 constant.
 */
export const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream'

/**
 * aiscast (Open Waters) speaks AISstream's protocol: same subscribe
 * message and same frames; the aiscast token goes in APIKey.
 */
export const AISCAST_URL = 'wss://ais.openwaters.io/v0/stream'

export interface DemoArea {
  centerLat: number
  centerLon: number
  radiusNm: number
  /**
   * Bounding box in AISstream subscription format, corner order NW first,
   * SE second (matches the documented example and the server defaults).
   */
  boundingBoxes: number[][][]
  /** VIS-7: faint on-screen area title, e.g. "DOVER STRAIT". */
  displayName: string
}

// For the three areas added in DEMO-1, the box is centre ± radius/60 in
// latitude and centre ± radius/(60 × cos(centerLat)) in longitude,
// rounded outward to 3 decimals and hardcoded below. NOTE: these centres
// are approximate and may be adjusted after the first look.
export const DEMO_AREAS = {
  // dover equals the display's previous hardcoded constants (centre
  // 51.1, 1.45 · radius 20nm) and the server's BOUNDING_BOXES default
  // exactly.
  dover: {
    centerLat: 51.1,
    centerLon: 1.45,
    radiusNm: 20,
    boundingBoxes: [
      [
        [51.4, 0.9],
        [50.8, 2.0],
      ],
    ],
    displayName: 'DOVER STRAIT',
  },
  istanbul: {
    centerLat: 40.93,
    centerLon: 29.0,
    radiusNm: 20,
    boundingBoxes: [
      [
        [41.264, 28.558],
        [40.596, 29.442],
      ],
    ],
    displayName: 'SEA OF MARMARA',
  },
  portsaid: {
    centerLat: 31.35,
    centerLon: 32.35,
    radiusNm: 20,
    boundingBoxes: [
      [
        [31.684, 31.959],
        [31.016, 32.741],
      ],
    ],
    displayName: 'PORT SAID',
  },
  sydney: {
    centerLat: -33.93,
    centerLon: 151.22,
    radiusNm: 20,
    boundingBoxes: [
      [
        [-33.596, 150.818],
        [-34.264, 151.622],
      ],
    ],
    displayName: 'SYDNEY',
  },
} satisfies Record<string, DemoArea>

export type DemoAreaKey = keyof typeof DEMO_AREAS

/**
 * undefined or blank → 'dover' (the default); an exact key → that key;
 * anything else → null (the caller decides warn vs refuse). Exact match
 * only — no trimming, no case-folding — so 'Istanbul' is invalid.
 */
export function parseDemoArea(raw: string | undefined): DemoAreaKey | null {
  if (raw === undefined || raw === '') return 'dover'
  // hasOwnProperty, not `raw in DEMO_AREAS`: `in` does not narrow a string
  // to the key union under TS 5.7 (display typechecks under lib ES2020, so
  // Object.hasOwn is not available either). The cast is the documented
  // consequence of the guard, not a bypass of it.
  if (Object.prototype.hasOwnProperty.call(DEMO_AREAS, raw)) {
    return raw as DemoAreaKey
  }
  return null
}

export type AisSource = 'aisstream' | 'aiscast'

/**
 * undefined or blank → 'aisstream' (the default); an exact key → that
 * key; anything else → null. Exact match only.
 */
export function parseAisSource(raw: string | undefined): AisSource | null {
  if (raw === undefined || raw === '') return 'aisstream'
  if (raw === 'aisstream' || raw === 'aiscast') return raw
  return null
}

export interface ResolvedSourceConfig {
  url: string
  apiKey: string
}

export interface SourceEnv {
  aisstreamApiKey?: string
  aiscastToken?: string
}

/**
 * Resolve which endpoint and credential to use for the chosen source.
 * Missing or blank keys are an error naming the VARIABLE — never its
 * value. Blank ('  ') counts as missing, matching
 * createAisStreamClient's existing trim() check.
 */
export function resolveSourceConfig(
  env: SourceEnv,
  source: AisSource,
): ResolvedSourceConfig | { error: string } {
  if (source === 'aisstream') {
    const apiKey = env.aisstreamApiKey
    if (!apiKey || apiKey.trim() === '') {
      return {
        // First-run fix: a stranger's first error says what to DO, not just
        // what is wrong -- which file, where it goes, and the exact one-line
        // shape, with "your-key" standing in for the value. The value is
        // never echoed, only the variable's name.
        error:
          'AISSTREAM_API_KEY is missing or empty. Create a file named .env next to package.json (copy .env.example) and put one line in it: AISSTREAM_API_KEY=your-key (the name first, then =, then your key, no quotes). See the README, "Getting a free AISstream key".',
      }
    }
    return { url: AISSTREAM_URL, apiKey }
  }
  const apiKey = env.aiscastToken
  if (!apiKey || apiKey.trim() === '') {
    return {
      // Same shape as the AISstream message above, for aiscast's own
      // variable; the source requirement it always carried is kept.
      error:
        'AISCAST_TOKEN is missing or empty. Create a file named .env next to package.json (copy .env.example) and put one line in it: AISCAST_TOKEN=your-key (the name first, then =, then your key, no quotes). Required when WAKE_AIS_SOURCE=aiscast. See the README, "Getting a free AISstream key".',
    }
  }
  return { url: AISCAST_URL, apiKey }
}
