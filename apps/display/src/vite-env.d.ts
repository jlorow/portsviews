/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Optional. Port the display connects to for the S3.5 broadcast
  // WebSocketServer. Defaults to 8080 (matching the server's own default)
  // if unset. Must be VITE_-prefixed to be exposed to client code --
  // WAKE_BROADCAST_PORT itself (server-side, in the same .env file) is
  // never visible to the browser bundle.
  readonly VITE_WAKE_BROADCAST_PORT?: string
  // DEMO-1: injected by vite.config.ts's define from the repo-root .env
  // -- and ONLY WAKE_AREA; nothing else from that file reaches the
  // bundle. Unset/blank means dover; an invalid key falls back to dover
  // with one console warning (WakeCanvas).
  readonly WAKE_AREA?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
