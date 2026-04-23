require('dotenv').config();
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  use: {
    headless: false,          // shows the browser so you can watch
    video: { mode: 'on', size: { width: 1920, height: 1080 } },
    screenshot: 'on',
    viewport: { width: 1920, height: 1080 },
    actionTimeout: 15000,
  },
  outputDir: 'tests/recordings',
  reporter: [['list'], ['html', { outputFolder: 'tests/report', open: 'never' }]],
});
