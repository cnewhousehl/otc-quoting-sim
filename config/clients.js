// config/clients.js
//
// Named counterparty roster (PLAN.md §1.4, M6). Each client maps to an archetype
// — sharp (informed/toxic), mid, or soft (uninformed). On Easy the handle
// telegraphs the archetype; on Hard the names are masked so students must infer
// toxicity from size, asset, and recent flow.
//
// Names are INVENTED desk-style handles only — no real-firm framing in
// student-facing copy (course non-compete rule).

// archetype: 'sharp' | 'mid' | 'soft'
// size: { medianX, sigmaLN } — LogNormal clip-size profile (median notional, log-σ)
// tell: the Easy-mode hint baked into the handle ('toxic' | 'neutral' | 'soft')
export const ROSTER = [
  { id: 'helix', handle: 'Helix Quant', archetype: 'sharp', tell: 'toxic', size: { medianX: 8, sigmaLN: 0.7 } },
  { id: 'tachyon', handle: 'Tachyon Systematic', archetype: 'sharp', tell: 'toxic', size: { medianX: 12, sigmaLN: 0.8 } },
  { id: 'vertex', handle: 'Vertex Flow', archetype: 'sharp', tell: 'toxic', size: { medianX: 6, sigmaLN: 0.6 } },
  { id: 'meridian', handle: 'Meridian Treasury', archetype: 'mid', tell: 'neutral', size: { medianX: 10, sigmaLN: 0.9 } },
  { id: 'atlas', handle: 'Atlas Macro', archetype: 'mid', tell: 'neutral', size: { medianX: 15, sigmaLN: 1.0 } },
  { id: 'moonlad', handle: 'MoonLad', archetype: 'soft', tell: 'soft', size: { medianX: 3, sigmaLN: 0.5 } },
  { id: 'diamond', handle: 'DiamondHands_99', archetype: 'soft', tell: 'soft', size: { medianX: 4, sigmaLN: 0.6 } },
  { id: 'tulip', handle: 'TulipFOMO', archetype: 'soft', tell: 'soft', size: { medianX: 2.5, sigmaLN: 0.45 } },
]

const ARCHETYPE_LABEL = { sharp: 'Sharp', mid: 'Flow', soft: 'Retail' }

// How a client is presented to the student, given the difficulty transparency:
//   'full'      → real handle (Easy: the name telegraphs toxicity)
//   'archetype' → handle + archetype label (Medium: hinted)
//   'hidden'    → masked id, archetype concealed (Hard: infer it)
export function presentClient(entry, transparency) {
  switch (transparency) {
    case 'full':
      return { displayName: entry.handle, archetypeShown: entry.archetype }
    case 'archetype':
      return { displayName: `${entry.handle} · ${ARCHETYPE_LABEL[entry.archetype]}`, archetypeShown: entry.archetype }
    case 'hidden':
    default:
      return { displayName: `Client ${entry.id.toUpperCase().slice(0, 4)}`, archetypeShown: null }
  }
}

export function clientById(id) {
  return ROSTER.find((c) => c.id === id) ?? null
}
