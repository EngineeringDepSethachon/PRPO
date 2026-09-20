import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

import { visualizer } from 'rollup-plugin-visualizer';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isGas = mode === 'gas' || process.env.BUILD_GAS === 'true';

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
      sourcemap: true,
    },
  };
});
