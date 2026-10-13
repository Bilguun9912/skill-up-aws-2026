/// <reference types="vitest/config" />
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
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
  // `npm run dev:local`: everything (incl. /config.json and the local token endpoint) goes to the
  // local api server in backend/local/server.ts.
  const localBackend = env.VITE_LOCAL_BACKEND === '1';
  const localTarget = env.VITE_LOCAL_API ?? 'http://localhost:3001';
  let proxy: Record<string, ProxyOptions> | undefined;
  if (localBackend) {
    proxy = Object.fromEntries(
      ['/api', '/local', '/config.json'].map((p) => [p, { target: localTarget, changeOrigin: true }]),
    );
  } else if (apiTarget) {
    proxy = { '/api': { target: apiTarget, changeOrigin: true, secure: true } };
  }

  return {
    plugins: [react(), dropLocalConfig()],
    server: {
      port: 5173,
      strictPort: true,
      proxy,
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
