import { defineConfig, devices } from '@playwright/test';

// Playwright enables FORCE_COLOR; remove NO_COLOR to avoid Node warning spam.
delete process.env.NO_COLOR;

const defaultWorkers = process.env.CI ? 2 : 3;
const envWorkers = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? '', 10);
const resolvedWorkers = Number.isFinite(envWorkers) && envWorkers > 0 ? envWorkers : defaultWorkers;
const webServerOutput = process.env.CI ? 'ignore' : 'pipe';
const webServerEnv = { ...process.env };
delete webServerEnv.NO_COLOR;

if (!process.env.E2E_SEED_WORKER_COUNT) {
  process.env.E2E_SEED_WORKER_COUNT = String(resolvedWorkers);
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: resolvedWorkers,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    ...(process.env.CI
      ? [['junit', { outputFile: 'test-results/junit.xml' }] as const]
      : []),
  ],
  use: {
    baseURL: 'http://localhost:3002',
    storageState: 'e2e/.auth/storageState.json',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  globalSetup: require.resolve('./global-setup'),
  globalTeardown: require.resolve('./global-teardown'),
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3002',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: webServerOutput,
    stderr: webServerOutput,
    env: webServerEnv as Record<string, string>,
  },
});
