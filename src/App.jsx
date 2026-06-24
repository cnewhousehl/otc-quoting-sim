import { useState } from 'react'
import Lobby from './components/Lobby.jsx'
import SessionView from './components/SessionView.jsx'
import { resolveActiveTier } from '../config/entitlements.js'
import './App.css'

// Tier comes from the build. Dev/default = full access (instructor); the
// free-to-play production build sets VITE_TIER=free. ?tier=free still lets you
// preview the gated experience.
const TIER = resolveActiveTier({
  urlParam: typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tier') : null,
  env: import.meta.env.VITE_TIER || 'instructor',
  allowUrlOverride: true,
}).id

export default function App() {
  const [startConfig, setStartConfig] = useState(null)
  if (!startConfig) return <Lobby tier={TIER} onStart={setStartConfig} />
  return <SessionView key={startConfig.seed} startConfig={startConfig} onExit={() => setStartConfig(null)} />
}
