// SuccessFactors Login Test — records video to tests/recordings/
// Run with: npx playwright test tests/sf-login.spec.js

const { test, expect } = require('@playwright/test');

test('SF Login', async ({ page }) => {
  const url = process.env.SF_URL;
  const email = process.env.SF_EMAIL;
  const password = process.env.SF_PASSWORD;

  if (!url || !email || !password) {
    throw new Error('Missing SF_URL, SF_EMAIL, or SF_PASSWORD in .env file');
  }

  await page.goto(url);

  // Wait for the login form to appear
  await page.waitForLoadState('networkidle');

  // SuccessFactors login — selectors cover most SF versions
  const emailField = page.locator(
    'input[name="j_username"], input[id="username"], input[type="email"], input[placeholder*="User"], input[placeholder*="Email"]'
  ).first();

  const passwordField = page.locator(
    'input[name="j_password"], input[id="password"], input[type="password"]'
  ).first();

  const loginButton = page.locator(
    'button[id*="login"], input[type="submit"], button[type="submit"], button:has-text("Log In"), button:has-text("Sign In")'
  ).first();

  await emailField.fill(email);
  await passwordField.fill(password);

  // Screenshot before clicking
  await page.screenshot({ path: 'tests/recordings/before-login.png' });

  await loginButton.click();

  // Wait for navigation after login
  await page.waitForLoadState('networkidle');

  // Screenshot after login attempt
  await page.screenshot({ path: 'tests/recordings/after-login.png' });

  // Verify login succeeded — page should NOT still show the login form
  const stillOnLogin = await emailField.isVisible().catch(() => false);
  expect(stillOnLogin, 'Login failed — still on login page').toBe(false);

  console.log('Login successful. Current URL:', page.url());
});
