// Discount coupons (e.g. FIRST10). The discount is always worked out here, on
// the server, from the coupons table; the browser only sends the code.
// A coupon takes money off the items (not delivery): kind "percent" (value 1-90,
// optional max_discount in paise) or "amount" (value in paise). Optional rules:
// min_subtotal (paise), starts_at / ends_at (ISO time), max_uses (paid orders),
// once_per_customer (one paid order per email or mobile number), active.
// used_count goes up when an order with the coupon is paid (worker.js finalize).

export const CODE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;

export function normCode(raw) {
  const code = (typeof raw === 'string' ? raw : '').trim().toUpperCase();
  return CODE.test(code) ? code : '';
}

export class CouponError extends Error {
  constructor(reason, extra = {}) { super(reason); this.reason = reason; this.extra = extra; }
}

const MESSAGES = {
  unknown: 'This coupon code is not valid.',
  paused: 'This coupon is not active right now.',
  not_started: 'This coupon is not active yet.',
  expired: 'This coupon has expired.',
  used_up: 'This coupon has been used up.',
  min_subtotal: 'Add more items to use this coupon.',
  once: 'This coupon can be used only once per customer.'
};
export const couponMessage = reason => MESSAGES[reason] || MESSAGES.unknown;

export function discountFor(c, subtotal) {
  if (c.kind === 'percent') {
    let d = Math.floor(subtotal * c.value / 100);
    if (c.max_discount) d = Math.min(d, c.max_discount);
    return Math.max(0, Math.min(d, subtotal));
  }
  return Math.max(0, Math.min(c.value, subtotal));
}

// Checks a code for this cart. customer (email, phone) is checked for
// once_per_customer when given; checkout always gives it.
export async function applyCoupon(env, rawCode, subtotal, customer, nowIso = new Date().toISOString()) {
  const code = normCode(rawCode);
  if (!code) throw new CouponError('unknown');
  const c = await env.DB.prepare('SELECT * FROM coupons WHERE code = ?').bind(code).first();
  if (!c) throw new CouponError('unknown');
  if (!c.active) throw new CouponError('paused');
  if (c.starts_at && nowIso < c.starts_at) throw new CouponError('not_started');
  if (c.ends_at && nowIso > c.ends_at) throw new CouponError('expired');
  if (c.max_uses != null && c.used_count >= c.max_uses) throw new CouponError('used_up');
  if (c.min_subtotal && subtotal < c.min_subtotal) throw new CouponError('min_subtotal', { min_subtotal: c.min_subtotal });
  if (c.once_per_customer && customer && (customer.email || customer.phone)) {
    const used = await env.DB.prepare(`SELECT id FROM orders WHERE coupon_code = ? AND paid_at IS NOT NULL
      AND (json_extract(customer, '$.email') = ? OR json_extract(customer, '$.phone') = ?) LIMIT 1`)
      .bind(code, customer.email || '-', customer.phone || '-').first();
    if (used) throw new CouponError('once');
  }
  return { code, discount: discountFor(c, subtotal), coupon: c };
}

// Spreads the discount over the order lines in proportion to their value, so
// each line's GST is worked out on what was really paid. Whole paise; the last
// line takes the rounding remainder.
export function spreadDiscount(grosses, discount) {
  const total = grosses.reduce((t, g) => t + g, 0);
  if (!discount || !total) return grosses.map(() => 0);
  let left = discount;
  return grosses.map((g, i) => {
    if (i === grosses.length - 1) return left;
    const share = Math.floor(discount * g / total);
    left -= share;
    return share;
  });
}

// ---------- admin ----------
const int = v => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN));
const isoOrNull = v => {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

// Validates an admin's coupon form. Money fields arrive in paise.
export function couponFromAdmin(b) {
  const bad = {};
  const code = normCode(b.code);
  if (!code) bad.code = 'Use 3 to 24 capital letters, digits, - or _.';
  const kind = b.kind === 'amount' ? 'amount' : b.kind === 'percent' ? 'percent' : '';
  if (!kind) bad.kind = 'Choose % off or ₹ off.';
  const value = int(b.value);
  if (kind === 'percent' && !(value >= 1 && value <= 90)) bad.value = 'Percent must be 1 to 90.';
  if (kind === 'amount' && !(value >= 100 && value <= 10000000)) bad.value = 'Amount must be ₹1 or more.';
  const opt = (k, min) => {
    if (b[k] == null || b[k] === '') return null;
    const n = int(b[k]);
    if (!(n >= min)) { bad[k] = 'Must be a whole number.'; return null; }
    return n;
  };
  const min_subtotal = opt('min_subtotal', 0) || 0;
  const max_discount = kind === 'percent' ? opt('max_discount', 100) : null;
  const max_uses = opt('max_uses', 1);
  const starts_at = isoOrNull(b.starts_at), ends_at = isoOrNull(b.ends_at);
  if (starts_at === undefined) bad.starts_at = 'Not a valid date.';
  if (ends_at === undefined) bad.ends_at = 'Not a valid date.';
  if (starts_at && ends_at && ends_at <= starts_at) bad.ends_at = 'End must be after start.';
  return {
    bad,
    coupon: { code, kind, value, min_subtotal, max_discount, max_uses, starts_at: starts_at || null, ends_at: ends_at || null, once_per_customer: b.once_per_customer ? 1 : 0, active: b.active === false ? 0 : 1 }
  };
}
