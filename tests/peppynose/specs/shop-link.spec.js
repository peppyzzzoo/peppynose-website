// TC-SHOPLINK: "Buy from Peppynose" buttons on the live site (peppynose/shop-link.js).
// They appear only when the shop Worker's /api/catalogue says live: true, only for
// products the shop sells with stock, and they open the shop in the page's language.
// The catalogue is faked here; the real one comes from the shop Worker.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { open } = require('./helpers');

const CATALOGUE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'shop', 'data', 'catalogue.json'), 'utf8'));
const SOLD = CATALOGUE.products.map(p => p.slug);
const OUT_OF_STOCK = 'foam-mat';

async function openWith(page, url, live) {
  const products = CATALOGUE.products.map(p => ({ slug: p.slug, variants: [{ sku: p.slug + '-1', stock: p.slug === OUT_OF_STOCK ? 0 : 5 }] }));
  const r = await open(page, 'index.html');   // installs blockExternal first
  expect(r.res.ok()).toBeTruthy();
  await page.route('**/api/catalogue', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ live, products }) }));
  const calls = [];
  page.on('request', req => { if (/\/api\/catalogue$/.test(req.url())) calls.push(req.url()); });
  await page.goto('/' + url, { waitUntil: 'load' });
  return calls;
}

test('no buttons while the shop is not open', async ({ page }) => {
  const calls = await openWith(page, 'products.html', false);
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(page.locator('.pn-shop-btn')).toHaveCount(0);
  await openWith(page, 'buy/teether-gift-set.html', false);
  await page.waitForTimeout(300);
  await expect(page.locator('.pn-shop-btn')).toHaveCount(0);
});

test('when open: one button per sold product in stock, opening the shop in the page language', async ({ page }) => {
  await openWith(page, 'products.html', true);
  const btns = page.locator('a.pn-shop-btn');
  await expect(btns).toHaveCount(SOLD.length - 1);
  await expect(page.locator(`a.pn-shop-btn[data-shop-slug="${OUT_OF_STOCK}"]`)).toHaveCount(0);
  await expect(page.locator('a.pn-shop-btn[data-shop-slug^="lcd-tablet"]')).toHaveCount(0);   // not sold in the shop
  await expect(btns.first()).toHaveText('Buy from Peppynose');
  await expect(page.locator('a.pn-shop-btn[data-shop-slug="teether-gift-set"]')).toHaveAttribute('href', '/shop/teether-gift-set.html');
  // The Amazon and Flipkart buttons stay.
  await expect(page.locator('a.btn.amazon').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  await openWith(page, 'ta/products.html', true);
  await expect(page.locator('a.pn-shop-btn[data-shop-slug="teether-gift-set"]')).toHaveAttribute('href', '/ta/shop/teether-gift-set.html');
  await expect(page.locator('a.pn-shop-btn').first()).toHaveText('Peppynose-இடம் வாங்கு');
});

test('when open: the buy page gets one big button, except for products not in stock or not sold', async ({ page }) => {
  await openWith(page, 'hi/buy/teether-gift-set.html', true);
  const btn = page.locator('.buy-box a.pn-shop-btn');
  await expect(btn).toHaveCount(1);
  await expect(btn).toHaveText('Peppynose से खरीदें');
  await expect(btn).toHaveAttribute('href', '/hi/shop/teether-gift-set.html');
  await expect(btn).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  await openWith(page, `buy/${OUT_OF_STOCK}.html`, true);
  await page.waitForTimeout(300);
  await expect(page.locator('.pn-shop-btn')).toHaveCount(0);
  await openWith(page, 'buy/lcd-tablet-blue.html', true);
  await page.waitForTimeout(300);
  await expect(page.locator('.pn-shop-btn')).toHaveCount(0);
});

test('pages without products do not ask the shop', async ({ page }) => {
  const calls = await openWith(page, 'about.html', true);
  await page.waitForTimeout(500);
  expect(calls).toHaveLength(0);
});
