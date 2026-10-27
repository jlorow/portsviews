import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LOCK_PATH = path.resolve(__dirname, '..', '.aisstream.lock')

/**
 * Asks whether a process exists. Behaves like process.kill(pid, 0):
 * returns if the process exists, throws otherwise. Tests inject a fake.
 */
export type PidProbe = (pid: number) => void

const realProbe: PidProbe = (p) => {
  process.kill(p, 0)
}

let warnedUnknownProbeError = false

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return undefined
}

/**
 * True if a process with this id is running. Uses signal 0, which works
 * the same way on Windows, Linux and macOS: it sends nothing, it only
 * checks. A pid that is not a positive safe integer is never probed,
 * because signal 0 to pid 0 or a negative pid targets a whole process
 * group and always succeeds. Any answer other than a clear "no such
 * process" (ESRCH) counts as running: a lock is never called stale on a
 * guess.
 */
export function isProcessAlive(pid: number, probe: PidProbe = realProbe): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    probe(pid)
    return true
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    if (!warnedUnknownProbeError) {
      warnedUnknownProbeError = true
      console.warn(
        `[Wake] Could not check whether process ${pid} is running (${code ?? 'unknown error'}); treating it as running.`,
      )
    }
    return true
  }
}

/** How far before the last boot a lock may be written and still count. */
export const BOOT_MARGIN_MS = 10 * 60 * 1000

export interface LockOptions {
  lockPath?: string
  probe?: PidProbe
  bootTimeMs?: number
}

export type LockState =
  | { kind: 'absent' }
  | { kind: 'held'; pid: number }
  | { kind: 'stale'; reason: string }

/** Strict parse of a lock file's text: a positive safe integer, or null. */
function parseLockPid(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const pid = Number(trimmed)
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  return pid
}

function isEnoent(err: unknown): boolean {
  return errorCode(err) === 'ENOENT'
}

/**
 * Reads the lock and says whether it is absent, held by a running
 * process, or stale (and why). After an unclean restart (power cut, VM
 * reset) the old lock survives, and Linux hands out the same pids again
 * in the same boot order, so the old number can belong to an unrelated
 * process or to this server itself. The own-pid and boot-time checks stop
 * the service refusing to start after such a restart.
 */
export function readLockState(options?: LockOptions): LockState {
  const lockPath = options?.lockPath ?? LOCK_PATH
  const probe = options?.probe ?? realProbe
  const bootTimeMs = options?.bootTimeMs ?? Date.now() - os.uptime() * 1000

  if (!fs.existsSync(lockPath)) return { kind: 'absent' }

  let text: string
  let mtimeMs: number
  try {
    text = fs.readFileSync(lockPath, 'utf-8')
    mtimeMs = fs.statSync(lockPath).mtimeMs
  } catch (err) {
    if (isEnoent(err)) return { kind: 'absent' }
    throw err
  }

  const pid = parseLockPid(text)
  if (pid === null) return { kind: 'stale', reason: 'it does not hold a valid process id' }
  if (pid === process.pid) {
    return { kind: 'stale', reason: "it holds this process's own id, left from an earlier run" }
  }
  if (mtimeMs < bootTimeMs - BOOT_MARGIN_MS) {
    return { kind: 'stale', reason: 'it was written before this computer last started' }
  }
  if (isProcessAlive(pid, probe)) return { kind: 'held', pid }
  return { kind: 'stale', reason: `pid ${pid} is not running` }
}

/**
 * Read-only check: is the lock currently held by a live process? Extracted
 * from acquireLock() (RISK-1) so a tool that must refuse to start
 * alongside the Wake server -- without itself exiting the process, so
 * tests can inject this as a boolean callback -- can ask the same
 * question acquireLock() asks, with no duplicated process-check logic.
 */
export function isLockHeld(options?: LockOptions): boolean {
  return readLockState(options).kind === 'held'
}

export type AcquireResult = { acquired: true } | { acquired: false; pid: number }

/**
 * Takes the lock unless a running process holds it. A stale lock is
 * removed first. Never exits the process, so tests can call it.
 */
export function tryAcquireLock(options?: LockOptions): AcquireResult {
  const lockPath = options?.lockPath ?? LOCK_PATH
  const state = readLockState(options)

  if (state.kind === 'held') return { acquired: false, pid: state.pid }

  if (state.kind === 'stale') {
    console.log(`[Wake] Stale lock found (${state.reason}). Removing.`)
    try {
      fs.unlinkSync(lockPath)
    } catch (err) {
      if (!isEnoent(err)) throw err
    }
  }

  fs.writeFileSync(lockPath, String(process.pid))
  return { acquired: true }
}

/**
 * AISstream allows only 3 subscribed connections per account/IP, and a
 * stuck ("ghost") connection does not expire for days. This lock is the
 * only thing standing between a second `dev` invocation and a permanent
 * lockout, so it must run before any socket is opened.
 */
export function acquireLock(options?: LockOptions): void {
  const result = tryAcquireLock(options)
  if (!result.acquired) {
    console.error(
      `[Wake] Another server instance is already running (pid ${result.pid}). ` +
        `Refusing to start a second AISstream connection.`,
    )
    process.exit(1)
  }
}

export function releaseLock(options?: { lockPath?: string }): void {
  const lockPath = options?.lockPath ?? LOCK_PATH
  try {
    if (fs.existsSync(lockPath)) {
      const lockedPid = parseLockPid(fs.readFileSync(lockPath, 'utf-8'))
      if (lockedPid === process.pid) {
        fs.unlinkSync(lockPath)
      }
    }
  } catch {
    // Best-effort cleanup on shutdown — nothing more we can do here.
  }
}
