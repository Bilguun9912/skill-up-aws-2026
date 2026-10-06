/// <reference types="vitest/config" />
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Never ship the local runtime config in dist/: the deployed /config.json is written by the
 * Pmbok-Frontend stack (ADR-010), and a stale local copy must not overwrite it.
 */
function dropLocalConfig(): Plugin {
  let outDir = 'dist';
  return {
    name: 'drop-local-config',
    apply: 'build',
    configResolved(cfg) {
      outDir = resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      for (const f of ['config.json', 'config.example.json']) {
        rmSync(resolve(outDir, f), { force: true });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET;

  return {
    plugins: [react(), dropLocalConfig()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: apiTarget
        ? {
            '/api': {
              target: apiTarget,
              changeOrigin: true,
              secure: true,
            },
          }
        : undefined,
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
