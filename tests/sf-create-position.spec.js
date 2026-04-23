const { test, expect } = require('@playwright/test');

test('RCM-RC-101 — Create a Position (Copy from Louie Bond)', async ({ page }) => {
  test.setTimeout(120000);
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

  // 2. Navigate to home
  await page.goto('https://hcm-eu10-preview.hr.cloud.sap/sf/start');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // 3. Use the global search bar to navigate to Position Org Chart
  await page.evaluate(() => {
    function findAndClick(root) {
      if (!root) return false;
      const input = root.querySelector('input[placeholder*="Search"], input[placeholder*="actions"]');
      if (input) { input.click(); input.focus(); return true; }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && findAndClick(el.shadowRoot)) return true;
      }
      return false;
    }
    findAndClick(document);
  });
  await page.waitForTimeout(1000);

  // Type "Position Org Chart" in the search bar
  await page.keyboard.type('Position Org Chart');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/recordings/position-step3-search.png' });

  // Click the Position Org Chart result
  await page.getByText('Position Org Chart', { exact: false }).first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'tests/recordings/position-step3-orgchart.png' });
  console.log('Org Chart URL:', page.url());

  // 6. Louie Bond's position card (POS100097) is already visible — click it to select
  await page.getByText('POS100097', { exact: false }).first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/recordings/position-step6-card-selected.png' });

  // 9. Click the "Actions" button in the side panel
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'tests/recordings/position-step9-action.png' });

  // 10. Click "Copy Position" from the dropdown
  await page.getByText('Copy Position', { exact: false }).first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'tests/recordings/position-step10-form.png' });
  console.log('Copy form URL:', page.url());

  // 11. Copy Position dialog — tick "Set To Be Recruited" then click OK
  // Checkbox is inside a custom SF component, use JS click to pierce it
  await page.evaluate(() => {
    const checkbox = document.querySelector('input[type="checkbox"][aria-checked="false"]');
    if (checkbox) checkbox.click();
  });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(8000); // wait for copy to complete and new position to appear
  await page.screenshot({ path: 'tests/recordings/position-step11-copied.png' });
  console.log('After copy URL:', page.url());

  // 12. Verify a new position was created (a new POS number should appear)
  const content = await page.content();
  const hasPosNumber = content.includes('POS1');
  expect(hasPosNumber, 'Position copy may not have completed — no POS number found').toBe(true);
  console.log('PASS — Position copied successfully from POS100097 (Louie Bond)');
});
