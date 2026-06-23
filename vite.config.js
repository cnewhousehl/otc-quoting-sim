import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// `base` is set for GitHub Pages project-site hosting:
//   https://cnewhousehl.github.io/otc-quoting-sim/
export default defineConfig({
  base: '/otc-quoting-sim/',
  plugins: [react()],
  test: {
    // Engine determinism + unit tests live in /test and /engine.
    include: ['test/**/*.test.js', 'engine/**/*.test.js'],
    environment: 'node',
  },
})
