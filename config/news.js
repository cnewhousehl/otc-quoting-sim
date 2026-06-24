// config/news.js
//
// Macro / asset-specific news catalysts (AmplifyMe-style). Each fires on a timer
// and pivots the HIDDEN true mid in a direction, by a small/medium/large
// magnitude, over a horizon — so price action is partly narrative-driven, not
// pure noise. Students learn to position/quote ahead of and into catalysts.
//
// scope: 'macro' (all assets) | 'asset' (only `assets`). direction: +1 up / −1 down.
// magnitude: 'small' | 'medium' | 'large'. Add more freely — the engine reads this list.

export const MAGNITUDE = {
  small: { totalReturn: 0.004, horizonSec: 90 }, // ~0.4% over 1.5 min
  medium: { totalReturn: 0.012, horizonSec: 150 }, // ~1.2% over 2.5 min
  large: { totalReturn: 0.035, horizonSec: 240 }, // ~3.5% over 4 min
}

export const NEWS_CATALOGUE = [
  { id: 'fed_hike', headline: 'Fed hikes rates 50bps — risk-off', scope: 'macro', direction: -1, magnitude: 'large' },
  { id: 'fed_cut', headline: 'Fed surprises with a rate cut', scope: 'macro', direction: 1, magnitude: 'large' },
  { id: 'cpi_hot', headline: 'CPI runs hot, inflation reaccelerates', scope: 'macro', direction: -1, magnitude: 'medium' },
  { id: 'soft_landing', headline: 'Soft-landing data, risk appetite returns', scope: 'macro', direction: 1, magnitude: 'medium' },
  { id: 'etf_inflows', headline: 'Spot ETFs see record inflows', scope: 'asset', assets: ['BTC', 'ETH'], direction: 1, magnitude: 'medium' },
  { id: 'exchange_hack', headline: 'Tier-1 exchange exploited, withdrawals halted', scope: 'macro', direction: -1, magnitude: 'large' },
  { id: 'saylor_sells', headline: 'Michael Saylor sells his first bitcoin', scope: 'asset', assets: ['BTC'], direction: -1, magnitude: 'large' },
  { id: 'sovereign_reserve', headline: 'Sovereign wealth fund adds BTC to reserves', scope: 'asset', assets: ['BTC'], direction: 1, magnitude: 'medium' },
  { id: 'sol_halt', headline: 'Solana network halts, validators stall', scope: 'asset', assets: ['SOL'], direction: -1, magnitude: 'medium' },
  { id: 'meme_mania', headline: 'Memecoin mania — WIF goes viral', scope: 'asset', assets: ['WIF'], direction: 1, magnitude: 'large' },
]
