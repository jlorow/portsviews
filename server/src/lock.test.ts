import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  LOCK_PATH,
  isProcessAlive,
  isLockHeld,
  readLockState,
  releaseLock,
  tryAcquireLock,
  type PidProbe,
} from './lock.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    console.log(`[Pass] ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}`)
  }
}

function codeError(code: string): Error {
  const err = new Error(code) as Error & { code: string }
  err.code = code
  return err
}

/** A probe that records how often it was called and does what it is told. */
function recordingProbe(behaviour: () => void = () => {}): { probe: PidProbe; calls: () => number } {
  let n = 0
  return {
    probe: () => {
      n++
      behaviour()
    },
    calls: () => n,
  }
}

const alwaysAlive: PidProbe = () => {}

function readText(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null
}

async function main(): Promise<void> {
  // The real lock must never be touched. Record it now, compare at the end.
  const realExistedBefore = fs.existsSync(LOCK_PATH)
  const realContentBefore = readText(LOCK_PATH)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-lock-test-'))
  const lockFile = (name: string) => path.join(dir, `${name}.lock`)

  try {
    // T1 runs first, so the once-only warning has not been used yet.
    {
      const originalWarn = console.warn
      let warnCalls = 0
      console.warn = () => {
        warnCalls++
      }
      let first: boolean
      let second: boolean
      try {
        first = isProcessAlive(12345, () => {
          throw codeError('EINVAL')
        })
        second = isProcessAlive(12345, () => {
          throw { code: 'EIO' }
        })
      } finally {
        console.warn = originalWarn
      }
      assert(first === true, 'T1: an EINVAL error counts as running')
      assert(second === true, 'T1: an EIO error counts as running')
      assert(warnCalls === 1, `T1: the warning is printed exactly once (got ${warnCalls})`)
    }

    // T2: how each probe outcome is read.
    {
      assert(isProcessAlive(12345, () => {}) === true, 'T2: a probe that returns means running')
      assert(
        isProcessAlive(12345, () => {
          throw codeError('ESRCH')
        }) === false,
        'T2: ESRCH means not running',
      )
      assert(
        isProcessAlive(12345, () => {
          throw codeError('EPERM')
        }) === true,
        'T2: EPERM means running (owned by someone else)',
      )
      assert(
        isProcessAlive(12345, () => {
          throw 'plain string'
        }) === true,
        'T2: a thrown non-Error counts as running',
      )
    }

    // T3: ids that must never reach the probe.
    {
      const rec = recordingProbe()
      const results = [0, -1, 1.5, NaN].map((pid) => isProcessAlive(pid, rec.probe))
      assert(results.every((r) => r === false), `T3: 0, -1, 1.5, NaN are not running (got ${JSON.stringify(results)})`)
      assert(rec.calls() === 0, `T3: the probe was never called (got ${rec.calls()})`)
    }

    // T4: the real probe on this process.
    assert(isProcessAlive(process.pid) === true, 'T4: this process is running (real probe)')

    // T5: a real child process, alive and then dead.
    {
      const lockPath = lockFile('t5')
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' })
      try {
        await once(child, 'spawn')
        const childPid = child.pid
        assert(typeof childPid === 'number', 'T5: the child has a pid')
        if (typeof childPid === 'number') {
          fs.writeFileSync(lockPath, String(childPid))
          assert(isProcessAlive(childPid) === true, 'T5: the live child is running')
          assert(isLockHeld({ lockPath }) === true, 'T5: a lock holding the live child is held')
          const refused = tryAcquireLock({ lockPath })
          assert(
            refused.acquired === false && refused.pid === childPid,
            `T5: acquire is refused with the child's pid (got ${JSON.stringify(refused)})`,
          )
          assert(readText(lockPath) === String(childPid), 'T5: the refused acquire left the file untouched')

          const exited = once(child, 'exit')
          child.kill()
          await exited

          assert(isProcessAlive(childPid) === false, 'T5: the exited child is not running')
          assert(isLockHeld({ lockPath }) === false, 'T5: a lock holding the exited child is not held')
          const taken = tryAcquireLock({ lockPath })
          assert(taken.acquired === true, `T5: acquire succeeds once the child is gone (got ${JSON.stringify(taken)})`)
          assert(readText(lockPath) === String(process.pid), 'T5: the file now holds this process id')
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }
    }

    // T6: no file at all.
    {
      const lockPath = lockFile('t6')
      assert(isLockHeld({ lockPath }) === false, 'T6: no file means not held')
      const result = tryAcquireLock({ lockPath })
      assert(result.acquired === true, 'T6: acquire succeeds with no file')
      assert(readText(lockPath) === String(process.pid), 'T6: the file holds this process id')
    }

    // T7: contents that are not a valid process id.
    {
      for (const content of ['', '0', '-5', 'abc', '12.5', ' 1e3 ']) {
        const lockPath = lockFile('t7')
        fs.writeFileSync(lockPath, content)
        const rec = recordingProbe()
        const state = readLockState({ lockPath, probe: rec.probe })
        assert(state.kind === 'stale', `T7: ${JSON.stringify(content)} is stale (got ${state.kind})`)
        const result = tryAcquireLock({ lockPath, probe: rec.probe })
        assert(
          result.acquired === true && readText(lockPath) === String(process.pid),
          `T7: ${JSON.stringify(content)} is replaced with this process id`,
        )
        assert(rec.calls() === 0, `T7: ${JSON.stringify(content)} never reached the probe (got ${rec.calls()})`)
      }
    }

    // T8: a lock holding this process's own id is left from an earlier run.
    {
      const lockPath = lockFile('t8')
      fs.writeFileSync(lockPath, String(process.pid))
      assert(readLockState({ lockPath }).kind === 'stale', 'T8: own pid is stale')
      assert(isLockHeld({ lockPath }) === false, 'T8: own pid is not held')
    }

    // T9: a lock written before the last boot is stale even if the pid answers.
    {
      const bootTimeMs = Date.now() - 60 * 60 * 1000
      const otherPid = process.pid + 1
      const minute = 60 * 1000
      const setMtime = (p: string, ms: number) => fs.utimesSync(p, new Date(ms), new Date(ms))

      const oldPath = lockFile('t9-old')
      fs.writeFileSync(oldPath, String(otherPid))
      setMtime(oldPath, bootTimeMs - 11 * minute)
      const oldState = readLockState({ lockPath: oldPath, probe: alwaysAlive, bootTimeMs })
      assert(oldState.kind === 'stale', `T9: 11 minutes before boot is stale (got ${oldState.kind})`)
      const taken = tryAcquireLock({ lockPath: oldPath, probe: alwaysAlive, bootTimeMs })
      assert(taken.acquired === true, 'T9: 11 minutes before boot can be acquired')

      const marginPath = lockFile('t9-margin')
      fs.writeFileSync(marginPath, String(otherPid))
      setMtime(marginPath, bootTimeMs - 5 * minute)
      const marginState = readLockState({ lockPath: marginPath, probe: alwaysAlive, bootTimeMs })
      assert(marginState.kind === 'held', `T9: 5 minutes before boot is held (got ${marginState.kind})`)

      const afterPath = lockFile('t9-after')
      fs.writeFileSync(afterPath, String(otherPid))
      setMtime(afterPath, bootTimeMs + 1 * minute)
      const afterState = readLockState({ lockPath: afterPath, probe: alwaysAlive, bootTimeMs })
      assert(afterState.kind === 'held', `T9: 1 minute after boot is held (got ${afterState.kind})`)
    }

    // T10: releaseLock only removes our own lock, and never throws.
    {
      const ownPath = lockFile('t10-own')
      fs.writeFileSync(ownPath, String(process.pid))
      releaseLock({ lockPath: ownPath })
      assert(!fs.existsSync(ownPath), 'T10: a lock holding this process id is removed')

      const otherPath = lockFile('t10-other')
      fs.writeFileSync(otherPath, String(process.pid + 1))
      releaseLock({ lockPath: otherPath })
      assert(readText(otherPath) === String(process.pid + 1), 'T10: a lock holding another pid is kept')

      let threw = false
      try {
        releaseLock({ lockPath: lockFile('t10-missing') })
      } catch {
        threw = true
      }
      assert(!threw, 'T10: a missing file does not throw')
    }

    // T11: the lock path is unchanged and the Windows-only check is gone.
    {
      assert(
        LOCK_PATH.endsWith(path.join('server', '.aisstream.lock')),
        `T11: LOCK_PATH still ends with server/.aisstream.lock (got ${LOCK_PATH})`,
      )
      const source = fs.readFileSync(path.join(__dirname, 'lock.ts'), 'utf-8')
      assert(!source.includes('tasklist'), 'T11: lock.ts does not mention tasklist')
      assert(!source.includes('child_process'), 'T11: lock.ts does not import child_process')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // T12: the real lock is exactly as it was.
  assert(fs.existsSync(LOCK_PATH) === realExistedBefore, 'T12: the real lock file exists exactly as before')
  assert(readText(LOCK_PATH) === realContentBefore, 'T12: the real lock file content is unchanged')

  const total = passed + failed
  if (failed === 0) {
    console.log(`\nAll ${total} tests passed`)
  } else {
    console.log(`\n${failed} of ${total} tests failed`)
    throw new Error(`${failed} tests failed`)
  }
}

main().catch((err) => {
  console.log(err)
  process.exitCode = 1
})
