const path = require('node:path');

const project = path.resolve(__dirname, '..');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

module.exports = {
  chromium,
  runtime: path.resolve(process.env.BLW_TEST_OUTPUT || path.join(project, 'test-results')),
  extension: path.join(project, 'extension'),
  browserOptions: process.env.BLW_BROWSER_PATH
    ? { executablePath: path.resolve(process.env.BLW_BROWSER_PATH) }
    : { channel: 'chromium' },
};
