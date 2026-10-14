import fs from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { parseLocalAreas } from '@wake/shared'

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
// deliberately rather than by luck.
const PUBLIC_ENV_PREFIXES = ['WAKE_AREA']

export default defineConfig(({ mode }) => {
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
      'import.meta.env.WAKE_LOCAL_AREAS': JSON.stringify(wakeLocalAreas),
    }
  }
})
