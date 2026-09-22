import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LOCK_PATH = path.resolve(__dirname, '..', '.aisstream.lock')

function isProcessAlive(pid: number): boolean {
  try {
    const output = execSync(`tasklist /FI "PID eq ${pid}"`, { encoding: 'utf-8' })
    return output.includes(String(pid))
  } catch {
    return false
  }
}

/**
 * Read-only check: is the lock currently held by a live process? Extracted
 * from acquireLock() (RISK-1) so a tool that must refuse to start
 * alongside the Wake server -- without itself exiting the process, so
 * tests can inject this as a boolean callback -- can ask the same
 * question acquireLock() asks, with no duplicated tasklist logic.
 */
export function isLockHeld(): boolean {
  if (!fs.existsSync(LOCK_PATH)) return false
  const existingPid = Number(fs.readFileSync(LOCK_PATH, 'utf-8').trim())
  return !Number.isNaN(existingPid) && isProcessAlive(existingPid)
}

/**
 * AISstream allows only 3 subscribed connections per account/IP, and a
 * stuck ("ghost") connection does not expire for days. This lock is the
 * only thing standing between a second `dev` invocation and a permanent
 * lockout, so it must run before any socket is opened.
 */
export function acquireLock(): void {
  if (fs.existsSync(LOCK_PATH)) {
    const existingPid = Number(fs.readFileSync(LOCK_PATH, 'utf-8').trim())

    if (!Number.isNaN(existingPid) && isProcessAlive(existingPid)) {
      console.error(
        `[Wake] Another server instance is already running (pid ${existingPid}). ` +
          `Refusing to start a second AISstream connection.`,
      )
      process.exit(1)
    }

    console.log(`[Wake] Stale lock found (pid ${existingPid} is not running). Removing.`)
    fs.unlinkSync(LOCK_PATH)
  }

  fs.writeFileSync(LOCK_PATH, String(process.pid))
}

export function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const lockedPid = Number(fs.readFileSync(LOCK_PATH, 'utf-8').trim())
      if (lockedPid === process.pid) {
        fs.unlinkSync(LOCK_PATH)
      }
    }
  } catch {
    // Best-effort cleanup on shutdown — nothing more we can do here.
  }
}
