import { useState } from 'react'
import { allowedDifficulties, can, getTier } from '../../config/entitlements.js'
import { SCENARIOS } from '../../config/session.js'

// Pre-game setup screen. Choose difficulty + order-book style + a few params,
// then Start. Locked options show why (licensed feature) per the active tier.
const DIFFS = ['easy', 'medium', 'hard']
const BOOK_STYLES = [
  { id: 'parametric', label: 'Parametric book', note: 'Phase 1a — calibrated ladder' },
  { id: 'agent', label: 'Agent-MM LOB', note: 'Licensed · M11 — emergent makers' },
]

export default function Lobby({ tier = 'free', onStart }) {
  const t = getTier(tier)
  const allowed = allowedDifficulties(t)
  const [difficulty, setDifficulty] = useState(allowed.includes('medium') ? 'medium' : allowed[0])
  const [bookStyle, setBookStyle] = useState('parametric')
  const [scenario, setScenario] = useState('calm')
  const [minutes, setMinutes] = useState(Math.min(10, t.maxSessionMinutes))
  const [newsMin, setNewsMin] = useState(3)
  const [seedMode, setSeedMode] = useState('random')
  const [seed, setSeed] = useState(12345)

  const scenarios = Object.keys(SCENARIOS).filter((s) => can(t, 'scenario', s) || s === 'calm')

  function start() {
    const chosenSeed = seedMode === 'fixed' ? Number(seed) : Math.floor(Math.random() * 1_000_000_000)
    onStart({
      seed: chosenSeed,
      difficulty,
      tier,
      bookStyle,
      config: { scenario: can(t, 'scenario', scenario) ? scenario : 'calm', sessionMinutes: Number(minutes), newsIntervalMin: Number(newsMin) },
    })
  }

  return (
    <div className="lobby">
      <header className="lobby-head">
        <h1>OTC Quoting Desk</h1>
        <p className="sub">Crypto perp market-making trainer · tier: <b>{t.label}</b></p>
      </header>

      <section className="lobby-grid">
        <Field label="Difficulty">
          <div className="chips">
            {DIFFS.map((d) => {
              const locked = !allowed.includes(d)
              return (
                <button
                  key={d}
                  className={`chip ${difficulty === d ? 'on' : ''} ${locked ? 'locked' : ''}`}
                  onClick={() => !locked && setDifficulty(d)}
                  title={locked ? 'Hard mode is a licensed feature' : ''}
                >
                  {d}{locked ? ' 🔒' : ''}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="Order-book engine">
          <div className="chips">
            {BOOK_STYLES.map((b) => {
              const locked = b.id === 'agent' && !can(t, 'customConfig')
              return (
                <button
                  key={b.id}
                  className={`chip wide ${bookStyle === b.id ? 'on' : ''} ${locked ? 'locked' : ''}`}
                  onClick={() => !locked && setBookStyle(b.id)}
                  title={locked ? 'Agent-MM LOB is a licensed feature (M11)' : ''}
                >
                  <span>{b.label}{locked ? ' 🔒' : ''}</span>
                  <small>{b.note}</small>
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="Scenario">
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {Object.keys(SCENARIOS).map((s) => (
              <option key={s} value={s} disabled={!scenarios.includes(s)}>
                {s}{!scenarios.includes(s) ? ' 🔒' : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label={`Session length — ${minutes} min`}>
          <input type="range" min="2" max={Number.isFinite(t.maxSessionMinutes) ? t.maxSessionMinutes : 60}
            value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </Field>

        <Field label={`News cadence — every ${newsMin} min`}>
          <input type="range" min="1" max="10" value={newsMin} onChange={(e) => setNewsMin(e.target.value)} />
        </Field>

        <Field label="Seed">
          <div className="chips">
            <button className={`chip ${seedMode === 'random' ? 'on' : ''}`} onClick={() => setSeedMode('random')}>random</button>
            <button className={`chip ${seedMode === 'fixed' ? 'on' : ''}`} onClick={() => setSeedMode('fixed')}>fixed</button>
            {seedMode === 'fixed' && (
              <input className="seed-in" type="number" value={seed} onChange={(e) => setSeed(e.target.value)} />
            )}
          </div>
        </Field>
      </section>

      <button className="start" onClick={start}>▶ Start session</button>
      <p className="lobby-foot">Free tier: Easy/Medium · single scenario · parametric book. Hard mode, agent-MM books, custom params, and replay export are licensed.</p>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  )
}
