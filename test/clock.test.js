// test/clock.test.js — headless clock with an injected scheduler.
import { describe, it, expect } from 'vitest'
import { createClock } from '../engine/clock.js'

// Manual scheduler: captures the callback so the test drives ticks by hand.
function manualScheduler() {
  let cb = null
  return {
    sched: {
      start: (fn) => {
        cb = fn
        return { id: 1 }
      },
      stop: () => {
        cb = null
      },
    },
    fire: () => cb && cb(),
    isRunning: () => cb != null,
  }
}

describe('clock', () => {
  it('counts ticks in order and advances current()', () => {
    const seen = []
    const c = createClock({ dt: 0.25, onTick: (n) => seen.push(n) })
    c.step()
    c.step()
    c.step()
    expect(seen).toEqual([0, 1, 2])
    expect(c.current()).toBe(3)
  })

  it('start/stop drive via the scheduler and are idempotent', () => {
    const m = manualScheduler()
    const seen = []
    const c = createClock({ dt: 0.25, onTick: (n) => seen.push(n), scheduler: m.sched })
    c.start()
    c.start() // idempotent
    expect(c.running()).toBe(true)
    m.fire()
    m.fire()
    c.stop()
    expect(c.running()).toBe(false)
    expect(m.isRunning()).toBe(false)
    expect(seen).toEqual([0, 1])
  })
})
