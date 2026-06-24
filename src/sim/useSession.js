import { useCallback, useEffect, useRef, useState } from 'react'
import { createSession } from '../../engine/session.js'
import { createClock } from '../../engine/clock.js'

// Drives a live session on the 250 ms clock and re-renders each tick. Also
// tracks per-asset mid direction (for the up/down book coloring).
export function useSession(startConfig) {
  const ref = useRef(null)
  const clockRef = useRef(null)
  const prevMids = useRef({})
  const [state, setState] = useState(null)
  const [dirs, setDirs] = useState({})
  const [running, setRunning] = useState(true)
  const [activeAsset, setActiveAsset] = useState(null)

  useEffect(() => {
    const s = createSession(startConfig)
    ref.current = s
    setActiveAsset(s.assetIds()[0])
    setState(s.getState())

    const clock = createClock({
      dt: s.config.dt,
      onTick: () => {
        if (s.isDone()) return
        s.tick()
        // mid directions from each asset's primary venue
        const nextDirs = {}
        for (const a of s.assetIds()) {
          const vs = s.venuesForAsset(a)
          if (!vs.length) continue
          const m = s.getBookSnapshot(vs[0]).mid
          const prev = prevMids.current[a]
          nextDirs[a] = prev == null ? 'flat' : m > prev ? 'up' : m < prev ? 'down' : 'flat'
          prevMids.current[a] = m
        }
        setDirs(nextDirs)
        setState(s.getState())
      },
    })
    clockRef.current = clock
    clock.start()
    return () => clock.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const togglePause = useCallback(() => {
    const c = clockRef.current
    if (!c) return
    if (c.running()) {
      c.stop()
      setRunning(false)
    } else {
      c.start()
      setRunning(true)
    }
  }, [])

  const refresh = () => setState(ref.current.getState())
  const submitQuote = useCallback((rfqId, ba) => { ref.current.submitQuote(rfqId, ba); refresh() }, [])
  const cancelQuote = useCallback((rfqId) => { ref.current.cancelQuote(rfqId); refresh() }, [])
  const refreshQuote = useCallback((rfqId, ba) => { ref.current.refreshQuote(rfqId, ba); refresh() }, [])
  const hedge = useCallback((order) => { ref.current.hedge(order); refresh() }, [])
  const placeLimitHedge = useCallback((order) => { ref.current.placeLimitHedge(order); refresh() }, [])
  const cancelLimitHedge = useCallback((id) => { ref.current.cancelLimitHedge(id); refresh() }, [])
  const passRfq = useCallback((rfqId) => { ref.current.passRfq(rfqId); refresh() }, [])

  const getBook = useCallback((venueId) => ref.current?.getBookSnapshot(venueId) ?? null, [])
  const venuesForAsset = useCallback((a) => ref.current?.venuesForAsset(a) ?? [], [])
  const venueInfo = useCallback((v) => ref.current?.venueInfo(v), [])

  return {
    session: ref, state, dirs, running, togglePause, activeAsset, setActiveAsset,
    submitQuote, cancelQuote, refreshQuote, hedge, placeLimitHedge, cancelLimitHedge, passRfq,
    getBook, venuesForAsset, venueInfo,
  }
}
