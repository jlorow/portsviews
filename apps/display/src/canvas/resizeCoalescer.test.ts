import { createCoalescedRunner, type FrameScheduler } from './resizeCoalescer'

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

// A hand-cranked frame clock: request queues, flush runs what is queued.
function createFakeFrames(): FrameScheduler & { flush(): void; pending(): number; cancelled(): number[] } {
  let nextId = 1
  const queue = new Map<number, () => void>()
  const cancelled: number[] = []
  return {
    request(callback) {
      const id = nextId++
      queue.set(id, callback)
      return id
    },
    cancel(id) {
      cancelled.push(id)
      queue.delete(id)
    },
    flush() {
      const callbacks = [...queue.values()]
      queue.clear()
      for (const callback of callbacks) callback()
    },
    pending: () => queue.size,
    cancelled: () => cancelled,
  }
}

{
  const frames = createFakeFrames()
  let runs = 0
  const runner = createCoalescedRunner(() => runs++, frames)

  runner.schedule()
  runner.schedule()
  runner.schedule()
  assert(frames.pending() === 1, `coalesce: three asks in one frame request one frame (got ${frames.pending()})`)
  assert(runs === 0, `coalesce: nothing runs before the frame (got ${runs})`)

  frames.flush()
  assert(runs === 1, `coalesce: one run per frame however many asks (got ${runs})`)

  runner.schedule()
  assert(frames.pending() === 1, `coalesce: an ask after the run requests a new frame (got ${frames.pending()})`)
  frames.flush()
  assert(runs === 2, `coalesce: and runs again on that frame (got ${runs})`)
}

{
  const frames = createFakeFrames()
  let runs = 0
  const runner = createCoalescedRunner(() => runs++, frames)

  runner.schedule()
  runner.dispose()
  assert(frames.cancelled().length === 1, `dispose: a pending frame is cancelled (got ${frames.cancelled().length})`)
  frames.flush()
  assert(runs === 0, `dispose: the cancelled run never happens (got ${runs})`)

  runner.schedule()
  assert(frames.pending() === 0, `dispose: asks after dispose request nothing (got ${frames.pending()})`)
}

{
  // A frame already handed to the browser cannot always be cancelled in
  // time; a run that fires after dispose must still do nothing.
  let captured: (() => void) | null = null
  let runs = 0
  const runner = createCoalescedRunner(() => runs++, {
    request(callback) {
      captured = callback
      return 1
    },
    cancel() {},
  })
  runner.schedule()
  runner.dispose()
  ;(captured as (() => void) | null)?.()
  assert(runs === 0, `dispose: a frame that fires anyway after dispose does not run (got ${runs})`)
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
