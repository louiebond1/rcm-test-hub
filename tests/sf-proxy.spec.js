const { test, expect } = require('@playwright/test');

test('LOGIN-102 — Proxy as Alex Brackley', async ({ page }) => {
  const url = process.env.SF_URL;
  const email = process.env.SF_EMAIL;
  const password = process.env.SF_PASSWORD;

  if (!url || !email || !password) {
    throw new Error('Missing SF_URL, SF_EMAIL, or SF_PASSWORD in .env file');
  }

  // 1. Login
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  await page.locator('input[name="j_username"], input[id="username"], input[type="email"]').first().fill(email);
  await page.locator('input[name="j_password"], input[id="password"], input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Sign In")').first().click();
  await page.waitForLoadState('networkidle');
  console.log('Logged in:', page.url());

  // 2. Navigate cleanly to the home page
  await page.goto('https://hcm-eu10-preview.hr.cloud.sap/sf/start');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // 3. Click the "LB" avatar in the top-right using JS to pierce shadow DOM
  await page.evaluate(() => {
    // Walk all shadow roots looking for the profile button
    function findAndClick(root) {
      if (!root) return false;
      // Try known SF profile button selectors
      const btn = root.querySelector(
        '[data-ui5-stable="profile"], [slot="profile"], ui5-avatar, .ui5-shellbar-image-button'
      );
      if (btn) { btn.click(); return true; }
      // Recurse into shadow roots of child custom elements
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && findAndClick(el.shadowRoot)) return true;
      }
      return false;
    }
    findAndClick(document);
  });

  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tests/recordings/proxy-step2-dropdown.png' });

  // 4. Click "Proxy Now" — it's a visible menu item after dropdown opens
  await page.getByText('Proxy Now', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await page.getByText('Proxy Now', { exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tests/recordings/proxy-step3-dialog.png' });
  console.log('Proxy dialog URL:', page.url());

  // 5. Type "Alex Brackley" into the "Select Target User" dialog input
  // Target by label text — the only input in the dialog
  const dialogInput = page.getByLabel('Please enter target user name:');
  await dialogInput.waitFor({ timeout: 10000 });
  await dialogInput.fill('Alex Brackley');
  await page.waitForTimeout(3000); // wait for name suggestions to appear
  await page.screenshot({ path: 'tests/recordings/proxy-step4-search.png' });

  // Select Alex Brackley from the suggestion results that pop up
  await page.getByText('Alex Brackley').first().click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'tests/recordings/proxy-step4b-selected.png' });

  // Click OK to confirm the selection
  await page.getByRole('button', { name: 'OK' }).click();

  // Wait 10 seconds for the proxy login to complete and Alex Brackley's home to load
  await page.waitForTimeout(10000);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'tests/recordings/proxy-step5-final.png' });
  console.log('Final URL after proxy:', page.url());

  // Verify we are now proxied as Alex Brackley — his name should appear on the page
  const content = await page.content();
  const isProxied = content.includes('Alex Brackley');
  expect(isProxied, 'Proxy login failed — Alex Brackley name not found on page').toBe(true);
  console.log('PASS — Proxied as Alex Brackley successfully');
});
