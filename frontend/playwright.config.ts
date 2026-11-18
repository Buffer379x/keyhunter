import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  use: { baseURL: process.env.KEYHUNTER_E2E_BASE_URL ?? 'http://localhost:38751', browserName: 'chromium', trace: 'off' },
  reporter: 'list',
});
