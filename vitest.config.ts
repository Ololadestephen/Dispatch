import { defineConfig } from 'vitest/config';
import path from 'node:path';

const live = process.env.LIVE_MODEL_TESTS === '1';
const zetaris = process.env.ZETARIS_TESTS === '1';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './')
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
    env: {
      // Route tests use their own data directory, never the dev database in ./data.
      DISPATCH_DATA_DIR: path.resolve(import.meta.dirname, 'tests/.tmp/app_data'),
      DISPATCH_EVIDENCE_DIR: path.resolve(import.meta.dirname, 'tests/.tmp/evidence')
    }
  }
});
