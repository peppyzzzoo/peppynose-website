// Discount coupons: the server works out every discount, the rules hold, a use
// counts only when paid, and the GST invoice is worked out after the discount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { discountFor, spreadDiscount, couponFromAdmin, normCode } from '../src/coupons.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8');
const MIGRATION_7 = readFileSync(join(here, '..', 'db', 'auth-migration-007.sql'), 'utf8');
const ADMIN = 'admin-password-123';

function d1(db) {
  return {
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
}

// Two products: a ₹249 mat and a ₹649 gift set. Delivery ₹49, free from ₹499.
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec(`INSERT INTO settings (key, value) VALUES ('shipping_fee', '4900'), ('free_shipping_above', '49900'), ('next_order_number', '1001'),
    ('seller_email', 'seller@example.com'), ('seller_state', 'Tamil Nadu'), ('seller_name', 'Peppynose'), ('seller_address', 'Musiri'), ('seller_gstin', '');
    INSERT INTO products (slug, category, data, gst_rate, hsn) VALUES ('mat', 'play', '{"name":{"en":"Foam mat"}}', 18, '3921'), ('gift', 'teethers', '{"name":{"en":"Gift set"}}', 18, '3926');
    INSERT INTO variants (sku, product_slug, label, price, stock) VALUES ('mat-1', 'mat', '{"en":"36 pieces"}', 24900, 50), ('gift-1', 'gift', '{"en":"Set of 6"}', 64900, 50);`);
  return { db, env: { DB: d1(db), ORDER_SECRET: 'unit-test-order-secret', SESSION_SECRET: 'unit-test-session-secret-not-used-in-production', PAYMENT_MODE: 'mock', ADMIN_PASSWORD: ADMIN } };
}

async function call(env, path, body, headers = {}) {
  const res = await worker.fetch(new Request('http://localhost' + path, {
    method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined
  }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json().catch(() => null), res };
}

async function adminCookie(env) {
  const r = await call(env, '/api/admin/login', { password: ADMIN }, { 'x-pn-admin': '1' });
  return { 'x-pn-admin': '1', cookie: r.res.headers.get('set-cookie').split(';')[0] };
}
const addCoupon = async (env, c) => {
  const r = await call(env, '/api/admin/coupon', c, await adminCookie(env));
  assert.equal(r.status, 200, JSON.stringify(r.data));
};

const CUST = { name: 'Test Amma', phone: '9876543210', email: 'amma@example.com', address1: '12 Main Street', city: 'Musiri', pincode: '621211', state: 'Tamil Nadu' };
const MAT = [{ sku: 'mat-1', qty: 1 }], GIFT = [{ sku: 'gift-1', qty: 1 }];
const quote = (env, items, coupon, customer) => call(env, '/api/quote', { items, coupon, customer });
async function buy(env, items, coupon, cust = CUST) {
  const o = await call(env, '/api/checkout', { items, customer: cust, coupon });
  if (o.status !== 200) return o;
  await call(env, '/api/pay/mock', { order: o.data.order, token: o.data.token });
  return o;
}

test('discount maths: percent with a cap, amount never above the items, spread to the paisa', () => {
  assert.equal(discountFor({ kind: 'percent', value: 10 }, 64900), 6490);
  assert.equal(discountFor({ kind: 'percent', value: 10, max_discount: 5000 }, 64900), 5000);
  assert.equal(discountFor({ kind: 'percent', value: 15 }, 999), 149);   // rounds down, never in the customer's disfavour
  assert.equal(discountFor({ kind: 'amount', value: 10000 }, 24900), 10000);
  assert.equal(discountFor({ kind: 'amount', value: 30000 }, 24900), 24900);
  assert.deepEqual(spreadDiscount([24900, 64900], 6490), [1799, 4691]);
  assert.equal(spreadDiscount([100, 100, 101], 100).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(spreadDiscount([500], 0), [0]);
  assert.equal(normCode(' first10 '), 'FIRST10');
  assert.equal(normCode('a!'), '');
});

test('the admin form is checked', () => {
  assert.deepEqual(Object.keys(couponFromAdmin({ code: 'x', kind: 'percent', value: 10 }).bad), ['code']);
  assert.ok(couponFromAdmin({ code: 'BIG', kind: 'percent', value: 95 }).bad.value);
  assert.ok(couponFromAdmin({ code: 'TINY', kind: 'amount', value: 50 }).bad.value);
  assert.ok(couponFromAdmin({ code: 'NOKIND', value: 10 }).bad.kind);
  assert.ok(couponFromAdmin({ code: 'DATES', kind: 'amount', value: 1000, starts_at: '2026-12-10', ends_at: '2026-12-01' }).bad.ends_at);
  const ok = couponFromAdmin({ code: 'first10', kind: 'percent', value: '10', max_discount: 10000, min_subtotal: '', max_uses: '100', once_per_customer: true });
  assert.deepEqual(ok.bad, {});
  assert.equal(ok.coupon.code, 'FIRST10');
  assert.equal(ok.coupon.max_uses, 100);
  assert.equal(ok.coupon.min_subtotal, 0);
  assert.equal(ok.coupon.once_per_customer, 1);
});

test('migration 007 adds coupons and the order columns, dropping nothing', () => {
  assert.equal(/drop\s+table/i.test(MIGRATION_7), false);
  // The database as it was after migration 006: today's schema without what 007 adds.
  const before = SCHEMA
    .replace(/(user_id\s+TEXT),([^\n]*)\n\s*coupon_code[^\n]*\n\s*-- discount[^\n]*\n\s*discount[^\n]*\n/, '$1$2\n')
    .replace(/\n-- Discount coupons[\s\S]*?\n\);\n/, '\n');
  assert.doesNotMatch(before, /coupon_code|CREATE TABLE coupons/);
  const db = new DatabaseSync(':memory:');
  db.exec(before);
  db.exec(`INSERT INTO orders (id, number, token, status, created_at, customer, state, subtotal, shipping, total, payment_mode)
    VALUES ('o_1', 1001, 't', 'paid', '2026-01-01', '{}', 'Tamil Nadu', 1, 0, 1, 'mock')`);
  db.exec(MIGRATION_7);
  const o = db.prepare('SELECT coupon_code, discount FROM orders').get();
  assert.equal(o.coupon_code, null);
  assert.equal(o.discount, 0);
  assert.throws(() => db.exec(MIGRATION_7), /duplicate column/);
});

test('a quote applies a coupon, and free delivery is judged after the discount', async () => {
  const { env } = makeEnv();
  await addCoupon(env, { code: 'FIRST10', kind: 'percent', value: 10 });
  await addCoupon(env, { code: 'FLAT50', kind: 'amount', value: 5000 });
  let q = (await quote(env, GIFT, 'first10')).data;
  assert.deepEqual(q, { subtotal: 64900, discount: 6490, coupon: 'FIRST10', shipping: 0, total: 58410 });
  // ₹649 − ₹200 would be ₹449: below ₹499, so delivery is charged.
  await addCoupon(env, { code: 'BIG200', kind: 'amount', value: 20000 });
  q = (await quote(env, GIFT, 'BIG200')).data;
  assert.equal(q.shipping, 4900);
  assert.equal(q.total, 64900 - 20000 + 4900);
  q = (await quote(env, MAT, 'FLAT50')).data;
  assert.equal(q.total, 24900 - 5000 + 4900);
  // Without a code, the price is unchanged.
  q = (await quote(env, MAT, '')).data;
  assert.deepEqual(q, { subtotal: 24900, discount: 0, coupon: null, shipping: 4900, total: 29800 });
});

test('each rule refuses with its own reason', async () => {
  const { db, env } = makeEnv();
  await addCoupon(env, { code: 'MIN500', kind: 'amount', value: 5000, min_subtotal: 50000 });
  await addCoupon(env, { code: 'OLD', kind: 'amount', value: 5000, ends_at: '2020-01-01T00:00:00+05:30' });
  await addCoupon(env, { code: 'SOON', kind: 'amount', value: 5000, starts_at: '2099-01-01T00:00:00+05:30' });
  await addCoupon(env, { code: 'PAUSED', kind: 'amount', value: 5000 });
  await call(env, '/api/admin/coupon-active', { code: 'PAUSED', active: false }, await adminCookie(env));
  await addCoupon(env, { code: 'ONLY1', kind: 'amount', value: 5000, max_uses: 1 });
  const why = async code => (await quote(env, MAT, code)).data.code;
  assert.equal(await why('NOPE'), 'coupon_unknown');
  assert.equal(await why('bad code!'), 'coupon_unknown');
  assert.equal(await why('OLD'), 'coupon_expired');
  assert.equal(await why('SOON'), 'coupon_not_started');
  assert.equal(await why('PAUSED'), 'coupon_paused');
  const min = (await quote(env, MAT, 'MIN500')).data;
  assert.equal(min.code, 'coupon_min_subtotal');
  assert.equal(min.min_subtotal, 50000);
  assert.equal((await quote(env, GIFT, 'MIN500')).data.discount, 5000);
  // A use counts only when paid: an unpaid order leaves ONLY1 available.
  await call(env, '/api/checkout', { items: MAT, customer: CUST, coupon: 'ONLY1' });
  assert.equal((await quote(env, MAT, 'ONLY1')).data.discount, 5000);
  await buy(env, MAT, 'ONLY1');
  assert.equal(db.prepare("SELECT used_count FROM coupons WHERE code = 'ONLY1'").get().used_count, 1);
  assert.equal(await why('ONLY1'), 'coupon_used_up');
  assert.equal((await call(env, '/api/checkout', { items: MAT, customer: CUST, coupon: 'ONLY1' })).data.code, 'coupon_used_up');
});

test('once per customer: the same email or mobile cannot use it on a second paid order', async () => {
  const { env } = makeEnv();
  await addCoupon(env, { code: 'WELCOME', kind: 'amount', value: 5000, once_per_customer: true });
  assert.equal((await buy(env, MAT, 'WELCOME')).status, 200);
  const sameEmail = await call(env, '/api/checkout', { items: MAT, customer: { ...CUST, phone: '9123456780' }, coupon: 'WELCOME' });
  assert.equal(sameEmail.data.code, 'coupon_once');
  const samePhone = await call(env, '/api/checkout', { items: MAT, customer: { ...CUST, email: 'other@example.com' }, coupon: 'WELCOME' });
  assert.equal(samePhone.data.code, 'coupon_once');
  assert.equal((await quote(env, MAT, 'WELCOME', { email: 'amma@example.com' })).data.code, 'coupon_once');
  const someoneElse = await call(env, '/api/checkout', { items: MAT, customer: { ...CUST, email: 'new@example.com', phone: '9000000001' }, coupon: 'WELCOME' });
  assert.equal(someoneElse.status, 200);
});

test('the order, its page, the admin and the GST invoice all carry the discount', async () => {
  const { db, env } = makeEnv();
  await addCoupon(env, { code: 'FIRST10', kind: 'percent', value: 10 });
  const o = await buy(env, [...MAT, ...GIFT], 'FIRST10');
  assert.equal(o.status, 200);
  const subtotal = 24900 + 64900, discount = 8980, total = subtotal - discount;   // free delivery: ₹808.20 after discount
  assert.equal(o.data.total, total);
  const row = db.prepare('SELECT coupon_code, discount, total, shipping FROM orders').get();
  assert.deepEqual({ ...row }, { coupon_code: 'FIRST10', discount, total, shipping: 0 });

  const view = (await call(env, `/api/order?o=${o.data.order}&t=${o.data.token}`)).data;
  assert.equal(view.discount, discount);
  assert.equal(view.coupon, 'FIRST10');
  assert.equal(view.subtotal, subtotal);
  assert.equal(view.total, total);

  const adm = (await call(env, `/api/admin/order?id=${o.data.order}`, null, await adminCookie(env))).data;
  assert.equal(adm.discount, discount);
  assert.equal(adm.coupon, 'FIRST10');

  const html = await (await worker.fetch(new Request(`http://localhost/api/invoice?o=${o.data.order}&t=${o.data.token}`), env, { waitUntil() {} })).text();
  assert.match(html, /after a discount of ₹89\.80 \(coupon FIRST10\)/);
  // The line totals add up to what was paid, and GST is on the discounted values.
  const [mat, gift] = spreadDiscount([24900, 64900], discount);
  const fmt = p => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.ok(html.includes(fmt(24900 - mat)));
  assert.ok(html.includes(fmt(64900 - gift)));
  assert.ok(html.includes(`<td>${fmt(total)}</td></tr></tfoot>`));
  const taxable = Math.round((24900 - mat) * 100 / 118) + Math.round((64900 - gift) * 100 / 118);
  assert.ok(html.includes(fmt(taxable)));
});

test('admin: list, pause and resume, and saving again keeps the use count', async () => {
  const { db, env } = makeEnv();
  const h = await adminCookie(env);
  assert.equal((await call(env, '/api/admin/coupons', null, { 'x-pn-admin': '1' })).status, 401);
  const bad = await call(env, '/api/admin/coupon', { code: 'X', kind: 'percent', value: 0 }, h);
  assert.equal(bad.status, 400);
  assert.ok(bad.data.fields.code && bad.data.fields.value);
  await addCoupon(env, { code: 'FIRST10', kind: 'percent', value: 10 });
  await buy(env, MAT, 'FIRST10');
  await addCoupon(env, { code: 'FIRST10', kind: 'percent', value: 15 });
  const list = (await call(env, '/api/admin/coupons', null, h)).data.coupons;
  assert.equal(list.length, 1);
  assert.equal(list[0].value, 15);
  assert.equal(list[0].used_count, 1);
  assert.equal(list[0].active, true);
  assert.equal((await call(env, '/api/admin/coupon-active', { code: 'FIRST10', active: false }, h)).status, 200);
  assert.equal((await quote(env, MAT, 'FIRST10')).data.code, 'coupon_paused');
  assert.equal((await call(env, '/api/admin/coupon-active', { code: 'first10', active: true }, h)).status, 200);
  assert.equal((await quote(env, MAT, 'FIRST10')).data.discount, Math.floor(24900 * 15 / 100));
  assert.equal((await call(env, '/api/admin/coupon-active', { code: 'NOPE', active: true }, h)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM coupons').get().n, 1);
});
