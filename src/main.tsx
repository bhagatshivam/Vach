import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@fontsource/literata/400.css'
import '@fontsource/literata/400-italic.css'
import '@fontsource/literata/700.css'
import '@fontsource/literata/700-italic.css'
import '@fontsource/merriweather/400.css'
import '@fontsource/merriweather/400-italic.css'
import '@fontsource/merriweather/700.css'
import '@fontsource/merriweather/700-italic.css'
import '@fontsource/atkinson-hyperlegible/400.css'
import '@fontsource/atkinson-hyperlegible/400-italic.css'
import '@fontsource/atkinson-hyperlegible/700.css'
import '@fontsource/atkinson-hyperlegible/700-italic.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
