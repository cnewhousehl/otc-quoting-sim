// engine/client.js
//
// Client archetype resolution + toxic-flow realization (PLAN.md §1.1 client.js,
// Q3, M6).
//
// - resolveClient: roster entry + difficulty → the `client` params fill.js needs.
// - sampleToxic: isToxic ~ p_tox, drawn at RFQ CREATION (keyed by rfqId) so the
//   counterfactual is honest and the stream is isolated from student actions.
// - buildDriftPath: the front-loaded post-fill adverse-drift path μ_tox(k).
// - createToxicDrift: tracks active drifts (activated ON FILL) and yields the
//   per-tick return injection into M_t. Superposable across overlapping fills.

import { STREAMS } from './rng.js'

// Roster entry + difficulty → fill.js `client` params. Sharp uses g_sharp
// (softplus pickoff); soft and mid both trade on the soft curve (mid is just a
// soft client with a higher toxic share — see sampleToxic).
export function resolveClient(entry, difficulty) {
  const shape = (difficulty.fillShapes && difficulty.fillShapes[entry.archetype]) || difficulty.fillShapes.soft
  return {
    id: entry.id,
    archetype: entry.archetype,
    lambda: shape.lambda,
    tauReact: difficulty.tauReact,
    fill: { bufferBps: shape.bufferBps, slopeBps: shape.slopeBps, floor: shape.floor },
    relStrength: shape.relStrength ?? 0,
    biasGainBps: difficulty.biasGainBps ?? 30,
  }
}

// isToxic ~ p_tox at RFQ creation. Soft ≈ never toxic; sharp full p_tox; mid half.
export function sampleToxic(rng, rfqId, entry, difficulty) {
  let p
  if (entry.archetype === 'soft') p = 0
  else if (entry.archetype === 'mid') p = difficulty.pTox * 0.5
  else p = difficulty.pTox
  return rng.uniform(STREAMS.rfqSpec, 0, rfqId, 0) < p
}

// μ_tox(k) = δ_tox·σ·ρ^k / Z, k = 0..N−1 — UNSIGNED per-tick adverse drift in
// RETURN space, front-loaded (decreasing in k). Σ_k μ_tox(k) = δ_tox·σ, so the
// total price move ≈ δ_tox·σ_M. The sign χ is applied at activation.
export function buildDriftPath({ deltaTox, N, rho }, sigmaReturn) {
  const weights = []
  let Z = 0
  for (let k = 0; k < N; k++) {
    const wk = Math.pow(rho, k)
    weights.push(wk)
    Z += wk
  }
  return weights.map((wk) => (deltaTox * sigmaReturn * wk) / Z)
}

// Tracks active post-fill toxic drifts and yields the per-asset return injection
// for a tick. Drift only enters M_t once a toxic fill activates it (Q3).
export function createToxicDrift() {
  const active = []
  // χ: explicit `sign` (e.g. the informed client's bias direction) if given,
  // else +1 if the client BOUGHT (student short → adverse up) / −1 if sold.
  function activate({ assetId, path, startTick, sign, clientBuys }) {
    active.push({ assetId, path, startTick, sign: sign ?? (clientBuys ? 1 : -1) })
  }
  function injectionAt(n) {
    const out = {}
    for (const a of active) {
      const k = n - a.startTick
      if (k >= 0 && k < a.path.length) {
        out[a.assetId] = (out[a.assetId] ?? 0) + a.sign * a.path[k]
      }
    }
    return out
  }
  function clear() {
    active.length = 0
  }
  return { activate, injectionAt, clear, _active: active }
}
