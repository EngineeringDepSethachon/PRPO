import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

import { visualizer } from 'rollup-plugin-visualizer';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isGas = mode === 'gas' || process.env.BUILD_GAS === 'true';
  // ONE definition of "this is a Cloudflare build", shared with src/services/authService.js IS_CLOUDFLARE_BUILD :
  // `--mode cloudflare` (npm run build:cf) OR VITE_BACKEND_MODE=cloudflare from the shell / the .env files Vite loads for this mode.
  // Always build production with `npm run build:cf`.
  const envFileMode = loadEnv(mode, process.cwd(), 'VITE_').VITE_BACKEND_MODE;
  const isCloudflare = mode === 'cloudflare' || String(process.env.VITE_BACKEND_MODE || envFileMode || '').trim().toLowerCase() === 'cloudflare';

  return {
    plugins: [
      react(),
      isGas && viteSingleFile(),
      visualizer({ filename: 'stats.html', template: 'treemap' }),
    ].filter(Boolean),

    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },

    define: {
      ...(isGas ? { 'import.meta.env.VITE_USE_GAS': JSON.stringify('true') } : {}),
      ...(isCloudflare ? { 'import.meta.env.VITE_BACKEND_MODE': JSON.stringify('cloudflare') } : {}),
    },

    build: {
      outDir: isGas ? 'dist-gas' : 'dist',
      emptyOutDir: true,
      target: 'es2020',
      minify: 'esbuild',
      esbuild: isGas
        ? {
            drop: ['console', 'debugger'],
          }
        : undefined,
      cssCodeSplit: !isGas,
      assetsInlineLimit: isGas ? 10240 : 4096,
      chunkSizeWarningLimit: 10000,
      // the production (Cloudflare) bundle ships without source maps (they would publish the readable source, incl. the test-account code paths) ;
      // every other mode keeps them exactly as before
      sourcemap: isCloudflare ? false : true,
    },
  };
});
