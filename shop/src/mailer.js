// Sends the shop's stored emails (the outbox table) through Resend.
// Off unless EMAIL_PROVIDER = "resend", with the secret RESEND_API_KEY and
// EMAIL_FROM (an address on a domain verified in Resend, e.g.
// "Peppynose <orders@peppynose.com>"). While off, emails are only stored and
// shown in the shop admin under Messages, as before.
// Each email is claimed before sending, so two runs never send it twice, and is
// tried at most MAX_ATTEMPTS times. worker.js runs flushOutbox right after a
// payment or a status change, and every 10 minutes (wrangler.toml crons).

export const MAX_ATTEMPTS = 5;
const BATCH = 20;

export function mailReady(env) {
  return env.EMAIL_PROVIDER === 'resend' && !!env.RESEND_API_KEY && /@/.test(String(env.EMAIL_FROM || ''));
}

// env.EMAIL_FETCH is for tests; the Worker uses the global fetch.
async function sendResend(env, msg) {
  const doFetch = env.EMAIL_FETCH || fetch;
  const res = await doFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to_addr], subject: msg.subject, text: msg.body })
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* no body */ }
    throw new Error(`Resend ${res.status}${detail ? ': ' + detail : ''}`);
  }
}

// Returns how many emails were sent and how many failed this run.
export async function flushOutbox(env) {
  const out = { sent: 0, failed: 0 };
  if (!mailReady(env)) return out;
  const { results } = await env.DB.prepare(
    "SELECT id, to_addr, subject, body, attempts FROM outbox WHERE sent_at IS NULL AND attempts < ? AND to_addr LIKE '%@%' ORDER BY id LIMIT ?"
  ).bind(MAX_ATTEMPTS, BATCH).all();
  for (const msg of results || []) {
    // Claim it: only the run that moves attempts on from the value it read sends it.
    const claim = await env.DB.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ? AND sent_at IS NULL AND attempts = ?')
      .bind(msg.id, msg.attempts).run();
    if (!claim.meta.changes) continue;
    try {
      await sendResend(env, msg);
      await env.DB.prepare('UPDATE outbox SET sent_at = ?, last_error = NULL WHERE id = ?').bind(new Date().toISOString(), msg.id).run();
      out.sent++;
    } catch (e) {
      await env.DB.prepare('UPDATE outbox SET last_error = ? WHERE id = ?').bind(String(e && e.message || e).slice(0, 300), msg.id).run();
      out.failed++;
    }
  }
  return out;
}
