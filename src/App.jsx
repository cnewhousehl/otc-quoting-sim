import { useState } from 'react'
import Lobby from './components/Lobby.jsx'
import SessionView from './components/SessionView.jsx'
import { resolveActiveTier } from '../config/entitlements.js'
import './App.css'

// Tier comes from the build; ?tier= is honored only as a demo override.
const TIER = resolveActiveTier({
  urlParam: typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tier') : null,
  allowUrlOverride: true,
}).id

export default function App() {
  const [startConfig, setStartConfig] = useState(null)

  if (!startConfig) {
    return <Lobby tier={TIER} onStart={setStartConfig} />
  }
  return <SessionView key={startConfig.seed} startConfig={startConfig} onExit={() => setStartConfig(null)} />
}
