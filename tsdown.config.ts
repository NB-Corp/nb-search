import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/cli.ts', './src/mcp.ts', './src/worker.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  deps: {
    alwaysBundle: [/^@modelcontextprotocol\/sdk(?:\/|$)/, /^zod(?:\/|$)/],
  },
});
