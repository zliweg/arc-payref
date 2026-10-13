import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 2,
  projects: [
    { name: 'synthetic', testMatch: ['workflows.spec.ts', 'enhancements.spec.ts', 'payment-experience.spec.ts', 'reconciliation.spec.ts', 'inbox-qr.spec.ts', 'scan-recovery.spec.ts'] },
    { name: 'live-readonly', testMatch: 'live.spec.ts' },
  ],
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5188', channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run build && npm run preview -- --port 5188', url: 'http://127.0.0.1:5188', reuseExistingServer: false },
});
