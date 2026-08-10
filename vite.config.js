import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// ============================================================================
// The two experiments are two separate pages, each bundled into its own
// self-contained HTML file (MTurk's ExternalQuestion loads exactly one URL).
//
// vite-plugin-singlefile only supports ONE entry point per build, so `npm run
// build` runs vite three times — once per page — into the same dist/ folder:
//
//   vite build --mode landing   →  dist/index.html      →  /
//   vite build --mode realtime  →  dist/realtime.html   →  /realtime
//   vite build --mode social    →  dist/social.html     →  /social
//
// Only the first build in that chain is allowed to wipe dist/.
// ============================================================================
const PAGES = {
  landing:  { input: 'index.html',    emptyOutDir: true },
  realtime: { input: 'realtime.html', emptyOutDir: false },
  social:   { input: 'social.html',   emptyOutDir: false },
};

export default defineConfig(({ command, mode }) => {
  // dev server / preview: all pages are served side by side, nothing to select.
  if (command !== 'build') {
    return { plugins: [viteSingleFile()] };
  }

  const page = PAGES[mode];
  if (!page) {
    throw new Error(
      `vite build needs a page mode. Got "${mode}", expected one of: ${Object.keys(PAGES).join(', ')}. ` +
      `Use "npm run build" to build all pages.`
    );
  }

  return {
    plugins: [viteSingleFile()],
    build: {
      target: 'es2020',
      outDir: 'dist',
      emptyOutDir: page.emptyOutDir,
      assetsInlineLimit: 100_000_000,
      chunkSizeWarningLimit: 100_000_000,
      cssCodeSplit: false,
      rollupOptions: {
        input: page.input,
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  };
});
