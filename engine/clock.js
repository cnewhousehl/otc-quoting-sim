// engine/clock.js
//
// Wall-clock tick driver (PLAN.md §1.1 clock.js, M4). Bridges real time to sim
// ticks at a fixed dt (default 250 ms → dt = 0.25 s, so TTL = 120 ticks = 30 s).
//
// The tick COUNTER is pure; only start()/stop() touch a host timer (setInterval).
// No Math.random / no Date.now — timing comes from the scheduler, not the clock.
// Headless callers can ignore start() and drive step() directly (deterministic).

export function createClock({ dt = 0.25, onTick, scheduler = defaultScheduler }) {
  let n = 0
  let handle = null

  // One sim tick: invoke the callback with the current tick index, then advance.
  function step() {
    onTick(n)
    n += 1
  }

  function start() {
    if (handle) return
    handle = scheduler.start(step, dt * 1000)
  }

  function stop() {
    if (!handle) return
    scheduler.stop(handle)
    handle = null
  }

  function current() {
    return n
  }

  function running() {
    return handle != null
  }

  return { start, stop, step, current, running }
}

// Default host scheduler — setInterval. Injectable so tests/headless runs can
// substitute a manual driver and keep the engine free of real time.
const defaultScheduler = {
  start: (fn, ms) => setInterval(fn, ms),
  stop: (h) => clearInterval(h),
}
