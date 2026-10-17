// One window resize can arrive as several events in the same frame: the
// window's resize, the visual viewport's resize, a ResizeObserver entry and
// a devicePixelRatio change under browser zoom. Each one sizing the canvas
// and the MapLibre map again would do the same work up to four times, so
// they all go through this and the work runs once, on the next frame.
//
// The frame scheduler is passed in rather than read from the global, so a
// plain `tsx` test can drive it with no DOM.

export interface FrameScheduler {
  request(callback: () => void): number
  cancel(id: number): void
}

export interface CoalescedRunner {
  /** Ask for one run on the next frame. Extra asks before it runs are merged. */
  schedule(): void
  /** Cancel a pending run; later asks do nothing. For effect cleanup. */
  dispose(): void
}

export function createCoalescedRunner(run: () => void, frames: FrameScheduler): CoalescedRunner {
  let pendingId: number | null = null
  let disposed = false

  return {
    schedule() {
      if (disposed || pendingId !== null) return
      pendingId = frames.request(() => {
        pendingId = null
        if (!disposed) run()
      })
    },
    dispose() {
      disposed = true
      if (pendingId !== null) {
        frames.cancel(pendingId)
        pendingId = null
      }
    },
  }
}
