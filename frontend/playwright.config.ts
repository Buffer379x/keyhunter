import { defineConfig } from '@playwright/test';

// Two projects: "e2e" (everything except e2e/visual) and "visual" (screenshot comparison, run only through
// deploy/visual-check.sh inside the pinned Playwright image so fonts and rendering are always the same).
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.KEYHUNTER_E2E_BASE_URL ?? 'http://localhost:38751',
    browserName: 'chromium',
    channel: process.env.KEYHUNTER_TEST_BROWSER_CHANNEL,
    trace: 'off',
  },
  reporter: 'list',
  projects: [
    { name: 'e2e', testIgnore: /visual\// },
    // A short WebKit run of the responsive checks (1.0), in the pinned Playwright image only (deploy/browser-check.sh).
    { name: 'webkit', testMatch: /release094-responsive\.spec\.ts/, use: { browserName: 'webkit', channel: undefined } },
    {
      name: 'visual',
      testMatch: /visual\/.*\.spec\.ts/,
      // The image's bundled Chromium, never a host Chrome channel.
      use: { channel: undefined, locale: 'de-DE', timezoneId: 'Europe/Berlin', colorScheme: 'dark', reducedMotion: 'reduce', deviceScaleFactor: 1 },
      expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' } },
    },
  ],
});
