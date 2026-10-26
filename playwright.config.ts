import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

/**
 * Browser flows run against a production build in explicit mock-extraction mode with
 * their own data directory, so they are deterministic and never touch ./data or the model.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ],
  webServer: {
    command: `next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    env: {
      DISPATCH_EXTRACTION: 'mock',
      DISPATCH_SOURCES: 'local',
      DISPATCH_DATA_DIR: 'tests/.tmp/e2e_data',
      DISPATCH_EVIDENCE_DIR: 'tests/.tmp/e2e_data/evidence'
    }
  }
});
