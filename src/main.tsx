import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// woff2-only @font-face rules for the bundled reading fonts (generated: scripts/fonts/).
import './fonts.css'
import App from './App.tsx'
import { applyCachedTheme } from './lib/systemTheme'

// Paint the last-used theme colour before React renders, so launch never flashes white.
applyCachedTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
