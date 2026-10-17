import fs from 'node:fs'
import path from 'node:path'
import { isBlank } from '@wake/shared'

export interface CaptureLogger {
  write(envelope: unknown): void
  close(): Promise<void>
}

const CLOSE_TIMEOUT_MS = 2000

/**
 * Blank (undefined, '', or whitespace only) means capture is OFF, decided
 * by the shared isBlank() so this setting follows the same rule as every
 * other optional one. A path that is not blank is used as written.
 */
export function resolveCapturePath(raw: string | undefined): string | undefined {
  return isBlank(raw) ? undefined : raw
}

/**
 * Off unless AIS_CAPTURE_PATH is set. When set, every raw envelope the
 * socket receives is appended verbatim (wrapped with a local receipt
 * timestamp) so S3.3's normalize step has real data to test against
 * instead of AISstream's docs, which are already known wrong about field
 * casing on this exact message.
 */
export function createCaptureLogger(): CaptureLogger | undefined {
  const capturePath = resolveCapturePath(process.env.AIS_CAPTURE_PATH)

  if (!capturePath || capturePath.trim() === '') {
    return undefined
  }

  try {
    fs.mkdirSync(path.dirname(capturePath), { recursive: true })
  } catch (err) {
    console.error(
      `[Wake] Could not create directory for AIS_CAPTURE_PATH (${capturePath}), capture disabled:`,
      (err as Error).message,
    )
    return undefined
  }

  const stream = fs.createWriteStream(capturePath, { flags: 'a' })

  stream.on('error', (err) => {
    console.error('[Wake] AIS capture write error:', err.message)
  })

  console.log(`[Wake] AIS raw capture enabled — appending to ${capturePath}`)

  return {
    write(envelope: unknown): void {
      const line = JSON.stringify({ receivedAtMs: Date.now(), envelope })
      stream.write(line + '\n')
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.log(`[Wake] Capture stream close timed out after ${CLOSE_TIMEOUT_MS}ms`)
          resolve()
        }, CLOSE_TIMEOUT_MS)

        stream.end(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}
