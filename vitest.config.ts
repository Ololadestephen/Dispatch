import { defineConfig } from 'vitest/config';
import path from 'node:path';

const live = process.env.LIVE_MODEL_TESTS === '1';
const zetaris = process.env.ZETARIS_TESTS === '1';
// Keep in step with tests/support/runRoot.ts: one mutable fixture root per test process.
const runRoot = path.join(process.cwd(), 'tests/.tmp/runs', String(process.pid));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './'),
      '@meterless/world-model-reference': path.resolve(
        import.meta.dirname,
        './vendor/meterless/world-model/reference/src/index.ts'
      )
    }
  },
  test: {
    globals: true,
    environment: 'node',
    // Default runs are deterministic and offline; live model tests are opt-in (npm run test:live).
    include: live
      ? ['tests/live/**/*.test.ts']
      : zetaris
        ? ['tests/zetaris/**/*.test.ts']
        : ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: live || zetaris ? 120_000 : 10_000,
    fileParallelism: false,
    globalSetup: ['./tests/support/globalSetup.ts'],
    env: {
      // Route tests use their own per-run data directory, never the dev database in ./data.
      DISPATCH_DATA_DIR: path.join(runRoot, 'app_data'),
      DISPATCH_EVIDENCE_DIR: path.join(runRoot, 'evidence')
    }
  }
});
