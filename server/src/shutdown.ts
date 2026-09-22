import WebSocket from 'ws'
import { releaseLock } from './lock.ts'
import type { CaptureLogger } from './capture.ts'
import type { ClientSocket } from './broadcast.ts'

// Deliberately NOT imported from aisstream.ts -- even a type-only import
// would add an edge to replay.test.ts's structural "replay.ts's transitive
// import graph never includes aisstream.ts" check, since that check reads
// source text and does not distinguish `import type` from a value import
// (see CLAUDE.md Correction 15 on type-only imports proving nothing; the
// same non-distinction cuts the other way here -- a type-only import is
// still a real edge for that check's purposes). AisStreamClient.getSocket()
// returns a structurally wider AisSocket (aisstream.ts) that satisfies
// this narrower shape with no import needed -- same duck-typing this file
// already relies on for ClientSocket.
// Exported (RISK-1) so capacityCapture.ts can close its two independent
// AIS connections through the exact same close-then-cap path, instead of
// a second implementation of the same 5s-cap idiom.
export interface CloseableSocket {
  readonly readyState: number
  once(event: 'close', listener: (code: number) => void): void
  close(code?: number, reason?: string): void
}

export interface ManagedSocket {
  getSocket: () => CloseableSocket | undefined | null
  stopReconnecting: () => void
}

let shuttingDown = false

// Exported (RISK-1) alongside closeSocket -- see its comment.
export const CLOSE_TIMEOUT_MS = 5000

// Lower than the AIS socket's cap. That 5000ms exists for a named,
// unique stake -- an unclean AIS close risks a remote ghost connection
// that doesn't self-clear for days. No equivalent exists for local
// display-client sockets: nothing external tracks their state, so a
// shorter, non-critical timeout is safe. All clients share this one
// budget, not one each -- Promise.all composes participants as a
// maximum, so this stays well under the 5000ms overall ceiling.
const CLIENT_CLOSE_TIMEOUT_MS = 2000

export function closeSocket(ws: CloseableSocket | undefined | null): Promise<void> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      console.log(`[Wake] Close timed out after ${CLOSE_TIMEOUT_MS}ms — exiting anyway`)
      resolve()
    }, CLOSE_TIMEOUT_MS)

    ws.once('close', (code) => {
      clearTimeout(timer)
      console.log(`[Wake] Socket closed cleanly (code ${code})`)
      resolve()
    })

    try {
      ws.close(1000, 'client shutdown')
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

/**
 * Closes every connected display-client socket under one shared budget,
 * in parallel with each other (not sequential, and not one timeout per
 * client). A client that never acknowledges its close frame does not
 * block shutdown -- the process exits regardless, the same "exiting
 * anyway" idiom closeSocket already uses, safe here because no remote
 * party is tracking these local sockets' state the way AISstream tracks
 * ours.
 */
function closeAllClientSockets(clients: Set<ClientSocket>): Promise<void> {
  if (clients.size === 0) return Promise.resolve()

  return new Promise((resolve) => {
    let remaining = clients.size
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }

    const timer = setTimeout(() => {
      console.log(`[Wake] Client sockets close timed out after ${CLIENT_CLOSE_TIMEOUT_MS}ms — exiting anyway`)
      finish()
    }, CLIENT_CLOSE_TIMEOUT_MS)

    for (const socket of clients) {
      if (socket.readyState === WebSocket.CLOSED) {
        remaining--
        if (remaining <= 0) finish()
        continue
      }

      socket.once('close', () => {
        remaining--
        if (remaining <= 0) finish()
      })

      try {
        socket.close(1000, 'server shutdown')
      } catch {
        remaining--
        if (remaining <= 0) finish()
      }
    }
  })
}

/**
 * A ghost AISstream connection does not expire for days, so an unclean
 * exit is far more expensive here than in a normal app. shuttingDown
 * makes this idempotent: a second Ctrl+C during the 5s close window must
 * not re-enter this and hang or double-exit.
 */
export function registerShutdown(
  client: ManagedSocket | undefined,
  captureLogger?: CaptureLogger,
  clientSockets?: Set<ClientSocket>,
): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`[Wake] Shutdown started (${signal})`)

    client?.stopReconnecting()
    await Promise.all([
      closeSocket(client?.getSocket()),
      captureLogger?.close() ?? Promise.resolve(),
      closeAllClientSockets(clientSockets ?? new Set()),
    ])

    releaseLock()

    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  process.on('uncaughtException', (err) => {
    console.error('[Wake] Uncaught exception:', err)
    void shutdown('uncaughtException')
  })
}
