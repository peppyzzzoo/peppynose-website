// Order emails: stored while sending is off, sent once through Resend when it is
// on, retried up to MAX_ATTEMPTS, never sent twice, with full links in the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { flushOutbox, mailReady, MAX_ATTEMPTS } from '../src/mailer.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, '..', 'db', 'schema.sql'), 'utf8');
const MIGRATION_6 = readFileSync(join(here, '..', 'db', 'auth-migration-006.sql'), 'utf8');
const ON = { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Peppynose <orders@peppynose.com>' };

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

// A fake Resend: records each email, and fails the first `failures` calls.
function fakeResend(failures = 0) {
  const sent = [];
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.headers.authorization, 'Bearer re_test');
    if (calls <= failures) return new Response('{"message":"busy"}', { status: 503 });
    sent.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200 });
  };
  return { sent, fetchImpl, calls: () => calls };
}

function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec(`INSERT INTO settings (key, value) VALUES ('shipping_fee', '4900'), ('free_shipping_above', '49900'), ('next_order_number', '1001'),
    ('seller_email', 'seller@example.com'), ('seller_state', 'Tamil Nadu'), ('seller_name', 'Peppynose'), ('seller_address', 'Musiri'), ('seller_gstin', '');
    INSERT INTO products (slug, category, data, gst_rate, hsn) VALUES ('mat', 'play', '{"name":{"en":"Foam mat"}}', 18, '3921');
    INSERT INTO variants (sku, product_slug, label, price, stock) VALUES ('mat-blue', 'mat', '{"en":"Blue"}', 24900, 25);`);
  return { db, env: { DB: d1(db), ORDER_SECRET: 'unit-test-order-secret', SESSION_SECRET: 'unit-test-session-secret-not-used-in-production', PAYMENT_MODE: 'mock', ...extra } };
}

// Runs the Worker like Cloudflare does, and waits for its after-reply work.
async function call(env, path, body) {
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  const res = await worker.fetch(new Request('http://localhost' + path, {
    method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
  }), env, ctx);
  await Promise.all(waits);
  return { res, data: await res.json().catch(() => null), waited: waits.length };
}

async function paidOrder(env, lang = 'en') {
  const o = (await call(env, '/api/checkout', { items: [{ sku: 'mat-blue', qty: 1 }], lang,
    customer: { name: 'Test Amma', phone: '9876543210', email: 'amma@example.com', address1: '12 Main Street', city: 'Musiri', pincode: '621211', state: 'Tamil Nadu' } })).data;
  const paid = await call(env, '/api/pay/mock', { order: o.order, token: o.token });
  return { o, paid };
}

test('mailReady needs Resend, its key and a from address', () => {
  assert.equal(mailReady(ON), true);
  assert.equal(mailReady({}), false);
  assert.equal(mailReady({ ...ON, EMAIL_PROVIDER: 'off' }), false);
  assert.equal(mailReady({ ...ON, RESEND_API_KEY: '' }), false);
  assert.equal(mailReady({ ...ON, EMAIL_FROM: 'Peppynose' }), false);
});

test('migration 006 only adds the attempts and last_error columns', () => {
  assert.equal(/drop\s+table/i.test(MIGRATION_6), false);
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('ALTER TABLE outbox DROP COLUMN attempts; ALTER TABLE outbox DROP COLUMN last_error;');
  db.exec("INSERT INTO outbox (order_id, kind, to_addr, subject, body, created_at) VALUES ('o', 'k', 'a@example.com', 's', 'b', 'x')");
  db.exec(MIGRATION_6);
  const row = db.prepare('SELECT attempts, last_error, sent_at FROM outbox').get();
  assert.equal(row.attempts, 0);
  assert.equal(row.last_error, null);
  assert.throws(() => db.exec(MIGRATION_6), /duplicate column/);
});

test('while sending is off, a paid order only stores its emails', async () => {
  const fake = fakeResend();
  const { db, env } = makeEnv({ EMAIL_FETCH: fake.fetchImpl });
  const { paid } = await paidOrder(env);
  assert.equal(paid.data.status, 'paid');
  assert.equal(paid.waited, 0);
  assert.equal(fake.calls(), 0);
  const rows = db.prepare('SELECT kind, sent_at, attempts FROM outbox ORDER BY id').all();
  assert.deepEqual(rows.map(r => r.kind), ['order_paid', 'seller_new_order']);
  assert.ok(rows.every(r => r.sent_at === null && r.attempts === 0));
  assert.deepEqual(await flushOutbox(env), { sent: 0, failed: 0 });
});

test('when on, a paid order sends both emails right away, once, with a full order link', async () => {
  const fake = fakeResend();
  const { db, env } = makeEnv({ ...ON, EMAIL_FETCH: fake.fetchImpl });
  const { o, paid } = await paidOrder(env, 'ta');
  assert.equal(paid.waited, 1);
  assert.equal(fake.sent.length, 2);
  const customer = fake.sent.find(m => m.to[0] === 'amma@example.com');
  assert.equal(customer.from, ON.EMAIL_FROM);
  assert.equal(customer.subject, `Peppynose order ${o.number} confirmed`);
  assert.ok(customer.text.includes(`https://api.peppynose.com/ta/shop/order.html#o=${o.order}&t=${o.token}`));
  assert.ok(fake.sent.some(m => m.to[0] === 'seller@example.com'));
  assert.ok(db.prepare('SELECT sent_at FROM outbox').all().every(r => r.sent_at));
  // Later runs (the 10-minute schedule) send nothing again.
  assert.deepEqual(await flushOutbox(env), { sent: 0, failed: 0 });
  assert.equal(fake.sent.length, 2);
});

test('SHOP_URL changes the link host', async () => {
  const fake = fakeResend();
  const { env } = makeEnv({ ...ON, EMAIL_FETCH: fake.fetchImpl, SHOP_URL: 'https://shop.example.com/' });
  const { o } = await paidOrder(env);
  assert.ok(fake.sent[0].text.includes(`https://shop.example.com/shop/order.html#o=${o.order}`));
});

test('a failed send is retried by the schedule, then given up after the limit', async () => {
  const fake = fakeResend(2);   // the first two calls fail
  const { db, env } = makeEnv({ ...ON, EMAIL_FETCH: fake.fetchImpl });
  await paidOrder(env);   // both emails fail once
  let rows = db.prepare('SELECT sent_at, attempts, last_error FROM outbox ORDER BY id').all();
  assert.ok(rows.every(r => r.sent_at === null && r.attempts === 1 && /Resend 503/.test(r.last_error)));
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  rows = db.prepare('SELECT sent_at, attempts, last_error FROM outbox ORDER BY id').all();
  assert.ok(rows.every(r => r.sent_at && r.attempts === 2 && r.last_error === null));
  assert.equal(fake.sent.length, 2);

  // An address that always fails stops at MAX_ATTEMPTS.
  const always = fakeResend(1000);
  const e2 = makeEnv({ ...ON, EMAIL_FETCH: always.fetchImpl });
  e2.db.exec("INSERT INTO outbox (order_id, kind, to_addr, subject, body, created_at) VALUES ('o', 'k', 'bad@example.com', 's', 'b', 'x')");
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) await flushOutbox(e2.env);
  assert.equal(always.calls(), MAX_ATTEMPTS);
  assert.equal(e2.db.prepare('SELECT attempts FROM outbox').get().attempts, MAX_ATTEMPTS);
});

test('two runs at the same time send each email once', async () => {
  const fake = fakeResend();
  const { db, env } = makeEnv({ ...ON, EMAIL_FETCH: fake.fetchImpl });
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO outbox (order_id, kind, to_addr, subject, body, created_at) VALUES ('o', 'k', ?, 's', 'b', 'x')").run(`m${i}@example.com`);
  await Promise.all([flushOutbox(env), flushOutbox(env), flushOutbox(env)]);
  assert.equal(fake.sent.length, 5);
  assert.equal(new Set(fake.sent.map(m => m.to[0])).size, 5);
});

test('an email with no address is never tried', async () => {
  const fake = fakeResend();
  const { db, env } = makeEnv({ ...ON, EMAIL_FETCH: fake.fetchImpl });
  db.exec("INSERT INTO outbox (order_id, kind, to_addr, subject, body, created_at) VALUES ('o', 'seller_new_order', '', 's', 'b', 'x')");
  await flushOutbox(env);
  assert.equal(fake.calls(), 0);
});

test('the admin Messages list shows whether sending is on and each email state', async () => {
  const fake = fakeResend(1);
  const { env } = makeEnv({ ...ON, EMAIL_FETCH: fake.fetchImpl, ADMIN_PASSWORD: 'admin-password-123' });
  await paidOrder(env);
  const login = await worker.fetch(new Request('http://localhost/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pn-admin': '1' }, body: JSON.stringify({ password: 'admin-password-123' })
  }), env, { waitUntil() {} });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const list = await (await worker.fetch(new Request('http://localhost/api/admin/outbox', { headers: { cookie, 'x-pn-admin': '1' } }), env, { waitUntil() {} })).json();
  assert.equal(list.sending, true);
  assert.equal(list.max_attempts, MAX_ATTEMPTS);
  assert.equal(list.messages.length, 2);
  assert.equal(list.messages.filter(m => m.sent_at).length, 1);
  assert.ok(list.messages.some(m => !m.sent_at && m.attempts === 1 && /503/.test(m.last_error)));
});
