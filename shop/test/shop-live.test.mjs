// The shop opens to the public only with SHOP_LIVE=1 and real (Razorpay) payments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker, { shopLive } from '../src/worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8');
const REAL = { SHOP_LIVE: '1', PAYMENT_MODE: 'razorpay', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 'secret' };

test('shopLive needs the switch, Razorpay mode and both keys', () => {
  assert.equal(shopLive(REAL), true);
  assert.equal(shopLive({}), false);
  assert.equal(shopLive({ ...REAL, SHOP_LIVE: 'true' }), false);
  assert.equal(shopLive({ ...REAL, SHOP_LIVE: '0' }), false);
  assert.equal(shopLive({ ...REAL, PAYMENT_MODE: 'mock' }), false);
  assert.equal(shopLive({ ...REAL, RAZORPAY_KEY_ID: '' }), false);
  assert.equal(shopLive({ ...REAL, RAZORPAY_KEY_SECRET: undefined }), false);
});

function env(extra) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec(`INSERT INTO settings (key, value) VALUES ('shipping_fee', '4900'), ('free_shipping_above', '49900'), ('next_order_number', '1001'),
    ('seller_email', 'seller@example.com'), ('seller_state', 'Tamil Nadu'), ('seller_name', 'Peppynose'), ('seller_address', 'Musiri'), ('seller_gstin', '');
    INSERT INTO products (slug, category, data, gst_rate, hsn) VALUES ('mat', 'play', '{"name":{"en":"Foam mat"}}', 18, '3921');
    INSERT INTO variants (sku, product_slug, label, price, stock) VALUES ('mat-blue', 'mat', '{"en":"Blue"}', 24900, 25);`);
  const D1 = {
    prepare(sql) {
      return {
        _sql: sql, _args: [],
        bind(...a) { this._args = a; return this; },
        async first() { const r = db.prepare(sql).get(...this._args); return r === undefined ? null : r; },
        async all() { return { results: db.prepare(sql).all(...this._args) }; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...this._args).changes) } }; }
      };
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => ({ meta: { changes: Number(db.prepare(s._sql).run(...s._args).changes) } })); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
  return { DB: D1, ORDER_SECRET: 'unit-test-order-secret', SESSION_SECRET: 'unit-test-session-secret-not-used-in-production', ...extra };
}

const get = (e, path) => worker.fetch(new Request('http://localhost' + path), e);

test('the catalogue says whether the shop is open', async () => {
  assert.equal((await (await get(env({ PAYMENT_MODE: 'mock' }), '/api/catalogue')).json()).live, false);
  assert.equal((await (await get(env({ ...REAL, SHOP_LIVE: '' }), '/api/catalogue')).json()).live, false);
  assert.equal((await (await get(env(REAL), '/api/catalogue')).json()).live, true);
});

test('the invoice carries the TEST mark until the shop is open', async () => {
  const e = env({ PAYMENT_MODE: 'mock' });
  const o = await (await worker.fetch(new Request('http://localhost/api/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ sku: 'mat-blue', qty: 1 }], customer: { name: 'Test Amma', phone: '9876543210', email: 'a@example.com', address1: '12 Main Street', city: 'Musiri', pincode: '621211', state: 'Tamil Nadu' } })
  }), e)).json();
  await worker.fetch(new Request('http://localhost/api/pay/mock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: o.order, token: o.token }) }), e);
  const path = `/api/invoice?o=${o.order}&t=${o.token}`;
  assert.match(await (await get(e, path)).text(), /TEST INVOICE/);
  // The same paid order, once the owner has turned the shop on.
  Object.assign(e, REAL);
  const live = await (await get(e, path)).text();
  assert.doesNotMatch(live, /TEST INVOICE/);
  assert.match(live, /Tax invoice/);
});
