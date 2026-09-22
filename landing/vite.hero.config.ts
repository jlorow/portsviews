import { defineConfig } from 'vite'
import path from 'path'

// The hero bundle: one entry, one output file, no HTML processing.
// landing/index.html is hand-written static HTML that must stay
// deployable as-is on free hosting with no build step, so Vite builds
// only the script it references.
//
// One alias, and it is byte-for-byte apps/display/vite.config.ts's, so
// @wake/shared resolves identically in both bundles. There is
// deliberately NO alias for apps/display itself: the hero's source
// reaches the renderer by relative path, which resolves the same way
// under Vite and under tsx, so the tests exercise the same module graph
// the bundle is built from.
export default defineConfig({
  resolve: {
    alias: {
      '@wake/shared': path.resolve(__dirname, '../shared/src')
    }
  },
  build: {
    outDir: 'hero',
    emptyOutDir: true,
    target: 'es2020',
    lib: {
      entry: path.resolve(__dirname, 'src/hero.ts'),
      formats: ['es'],
      fileName: () => 'hero.js'
    }
  }
})
