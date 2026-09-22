import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// VIS-7: self-hosted Inter (bundled by Vite, no runtime font-CDN request)
// for canvas text -- hero labels and the area title in
// canvas/labels.ts. 300/500/700 are the only weights drawn; @fontsource
// ships one file per weight, so importing exactly these three keeps the
// bundle from carrying every unused weight.
import '@fontsource/inter/300.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/700.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
