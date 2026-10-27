import fs from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { DEFAULT_BROADCAST_PORT, classifyServerUrlSetting, parseLocalAreas, parsePort } from '@wake/shared'

// DEMO-1: loads ONLY WAKE_AREA from the repo-root .env and injects it as
// one compile-time constant. The prefix argument restricts loadEnv to
// WAKE_AREA* keys, so no other root-.env variable (AISSTREAM_API_KEY,
// AISCAST_TOKEN, ...) is ever loaded into the config, let alone defined
// into the bundle. Outside this define, import.meta.env carries only
// VITE_-prefixed vars (Vite's own filter) plus MODE/DEV/PROD/BASE_URL.
// Verified after every production build by the story's secret checks
// (grep for the key names, and for any values set in .env, in dist).
//
// The prefix is listed by FULL NAME rather than as a bare 'WAKE_'
// prefix, so a future secret whose name happens to start with WAKE_
// cannot be loaded here at all -- the property DEMO-1 relied on, kept
// deliberately rather than by luck. VITE_WAKE_BROADCAST_PORT is here
// because it is public by construction: it is the address the browser
// dials, and Vite would expose it anyway once it is VITE_-prefixed.
// VITE_WAKE_SERVER_URL is here for the same reason: it is a public
// address the browser dials (blank, same-origin, or a ws/wss URL), not a
// credential. No credential's name is in this list.
const PUBLIC_ENV_PREFIXES = ['WAKE_AREA', 'VITE_WAKE_BROADCAST_PORT', 'VITE_WAKE_SERVER_URL']

export default defineConfig(({ mode, command }) => {
  // __dirname is apps/display; the root .env lives two directories up.
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), PUBLIC_ENV_PREFIXES)
  const localAreasPath = path.resolve(__dirname, '../..', 'areas.local.json')
  let wakeLocalAreas: unknown = null
  if (fs.existsSync(localAreasPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(localAreasPath, 'utf8'))
      const result = parseLocalAreas(parsed)
      if (!result.ok) {
        throw new Error(result.errors.join('\n'))
      }
      wakeLocalAreas = result.value
    } catch (error) {
      throw new Error(`Invalid areas.local.json at ${localAreasPath}: ${(error as Error).message}`)
    }
  }
  // One resolution, shared with the server: blank is unset (not 0), and
  // anything that is not a whole number 1..65535 falls back to 8080 with
  // one warning here rather than producing a URL the browser cannot dial.
  // Injected as a string, the shape import.meta.env always has.
  const portResult = parsePort(env.VITE_WAKE_BROADCAST_PORT, DEFAULT_BROADCAST_PORT, 'VITE_WAKE_BROADCAST_PORT')
  if (!portResult.ok) {
    console.warn(`[Wake] ${portResult.error}`)
  }
  const broadcastPort = portResult.ok ? portResult.value : DEFAULT_BROADCAST_PORT

  // The server address only matters for a build that will be hosted. The
  // dev display (pnpm dev, command 'serve') always gets '' so it keeps
  // dialling ws://<hostname>:<port> exactly as before. A build refuses an
  // invalid value rather than shipping a display that cannot connect.
  let serverUrlSetting = ''
  if (command === 'build') {
    const setting = classifyServerUrlSetting(env.VITE_WAKE_SERVER_URL)
    if (setting.kind === 'invalid') {
      throw new Error(
        'VITE_WAKE_SERVER_URL must be blank, same-origin, or a ws:// or wss:// address with no username or password.',
      )
    }
    const shown = setting.kind === 'url' ? setting.url : setting.kind
    console.log(`[Wake] Display server address: ${shown}`)
    serverUrlSetting = setting.kind === 'default' ? '' : setting.kind === 'url' ? setting.url : 'same-origin'
  }

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@wake/shared': path.resolve(__dirname, '../../shared/src')
      }
    },
    define: {
      // Always a string: unset/blank resolves to '' and parseDemoArea('')
      // is 'dover' (the default), so the browser bundle never sees an
      // undefined variable.
      'import.meta.env.WAKE_AREA': JSON.stringify(env.WAKE_AREA ?? ''),
      'import.meta.env.WAKE_LOCAL_AREAS': JSON.stringify(
        wakeLocalAreas === null ? '' : JSON.stringify(wakeLocalAreas),
      ),
      // Always a valid port string: the same shared constant the server
      // falls back to, so the two can never disagree.
      'import.meta.env.VITE_WAKE_BROADCAST_PORT': JSON.stringify(String(broadcastPort)),
      // '' for pnpm dev; the checked value for a build (see above).
      'import.meta.env.VITE_WAKE_SERVER_URL': JSON.stringify(serverUrlSetting),
    }
  }
})
