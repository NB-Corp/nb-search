import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/contracts.ts', './src/cli.ts', './src/mcp.ts', './src/worker.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  banner: '/* Includes guarded-fetch 0.1.5 (Vercel, Apache-2.0), modified for per-target synthetic DNS tokens, and proxy-from-env 2.1.0 (Rob Wu, MIT), adapted to captured environment input. See THIRD_PARTY_NOTICES.md and LICENSES. */',
  deps: {
    alwaysBundle: [/^@modelcontextprotocol\/sdk(?:\/|$)/],
    neverBundle: [/^zod(?:\/|$)/],
  },
});
