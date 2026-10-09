import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // pdf.ts's worker entry (src/lib/pdfWorkerEntry.ts) uses a top-level
  // await (to guarantee its Map.prototype.getOrInsertComputed polyfill
  // installs before pdf.worker.mjs's own module body runs inside the
  // worker - see mapUpsertPolyfill.ts) - only supported in the 'es' worker
  // output format, not Vite's default 'iife'. pdf.js's own worker is
  // already a real ES module (.mjs) in a {type:'module'} Worker, so this
  // matches what it already needs regardless.
  worker: { format: 'es' },
})
