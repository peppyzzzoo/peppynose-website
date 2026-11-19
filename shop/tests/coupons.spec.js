// Discount coupons in the browser: the owner adds one in the admin, a customer
// applies it at checkout, and the order page shows the discount.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const VARS = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.dev.vars'), 'utf8').trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)));
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe.configure({ mode: 'serial' });

async function fillAddress(page) {
  const f = page.locator('#checkout');
  for (const [k, v] of [['name', 'Coupon Amma'], ['phone', '9811122233'], ['email', 'coupon.amma@example.com'], ['address1', '5 Market Road'], ['city', 'Musiri'], ['pincode', '621211']]) await f.locator(`[name=${k}]`).fill(v);
  await f.locator('[name=state]').selectOption('Tamil Nadu');
}

test('the owner adds a coupon in the admin, and a customer saves with it at checkout', async ({ page }, testInfo) => {
  const code = testInfo.project.name === 'mobile' ? 'MOBILE10' : 'DESK10';
  await page.goto('/shop/admin.html');
  await page.locator('#login [name=password]').fill(VARS.ADMIN_PASSWORD);
  await page.locator('#login button').click();
  await page.getByRole('tab', { name: 'Coupons' }).click();
  const form = page.locator('#coupon-form');
  await form.locator('[name=code]').fill(code.toLowerCase());
  await form.locator('[name=kind]').selectOption('percent');
  await form.locator('[name=value]').fill('10');
  await form.locator('[name=max_discount]').fill('100');
  await form.getByRole('button', { name: 'Save coupon' }).click();
  const row = page.locator(`tr[data-code="${code}"]`);
  await expect(row).toContainText('10% off (up to ₹100)');
  await expect(row).toContainText('0');
  expect(await noSideScroll(page)).toBe(true);

  // Customer: ₹649 gift set, 10% = ₹64.90 off.
  await page.goto('/shop/teether-gift-set.html');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/shop/checkout.html');
  await fillAddress(page);
  await page.locator('#coupon-code').fill('NOTACODE');
  await page.locator('#coupon-apply').click();
  await expect(page.locator('#coupon-err')).toHaveText('This coupon code is not valid.');
  await page.locator('#coupon-code').fill(code.toLowerCase());
  await page.locator('#coupon-apply').click();
  await expect(page.locator('.sh-coupon .sh-ok')).toHaveText(`Coupon ${code} applied. You save ₹64.90.`);
  await expect(page.locator('.sh-disc')).toContainText('−₹64.90');
  await expect(page.locator('.sh-grand')).toContainText('₹584.10');
  expect(await noSideScroll(page)).toBe(true);
  // It stays applied after a reload.
  await page.reload();
  await fillAddress(page);
  await expect(page.locator('.sh-grand')).toContainText('₹584.10');
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(page).toHaveURL(/pay(\.html)?#o=o_/);
  await expect(page.locator('#pay-amount')).toContainText('₹584.10');
  await page.getByRole('button', { name: 'Pay (test: success)' }).click();
  await expect(page.locator('h1')).toHaveText('Thank you! Order confirmed');
  await expect(page.locator('.sh-disc')).toContainText(`Discount (${code})`);
  await expect(page.locator('.sh-grand')).toContainText('₹584.10');

  // The admin counts the paid use.
  await page.goto('/shop/admin.html');
  await page.getByRole('tab', { name: 'Coupons' }).click();
  await expect(page.locator(`tr[data-code="${code}"] td`).nth(3)).toHaveText('1');
  await page.locator(`tr[data-code="${code}"] [data-coupon-active]`).click();
  await expect(page.locator(`tr[data-code="${code}"]`)).toContainText('paused');
});

test('a coupon message in Tamil, and removing a coupon', async ({ page }, testInfo) => {
  await page.goto('/ta/shop/foam-mat.html');
  await page.locator('#buy-form button[type=submit]').click();
  await page.goto('/ta/shop/checkout.html');
  await page.locator('#coupon-code').fill('NOPE');
  await page.locator('#coupon-apply').click();
  await expect(page.locator('#coupon-err')).toHaveText('இந்தக் கூப்பன் குறியீடு செல்லாது.');
  // A paused coupon (from the test above) is refused too.
  await page.locator('#coupon-code').fill(testInfo.project.name === 'mobile' ? 'MOBILE10' : 'DESK10');
  await page.locator('#coupon-apply').click();
  await expect(page.locator('#coupon-err')).toHaveText('இந்தக் கூப்பன் இப்போது செயலில் இல்லை.');
  expect(await noSideScroll(page)).toBe(true);
});
