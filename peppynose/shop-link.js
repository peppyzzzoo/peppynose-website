/* "Buy from Peppynose" buttons next to the Amazon.in and Flipkart buttons.
   They appear only when the shop Worker says the shop is open (GET /api/catalogue
   returns live: true, see shop/src/worker.js shopLive), and only for products the
   shop sells. Until then this script changes nothing on the page.
   Products page: one button per product card. Buy pages (buy/<slug>.html): one big
   button above the note. The button opens the same product in the shop, in this
   page's language. The API address comes from auth-config.js (PN_AUTH_API). */
(() => {
  const lang = (document.documentElement.lang || 'en').slice(0, 2);
  const L = ['en', 'ta', 'hi'].includes(lang) ? lang : 'en';
  const T = {
    en: { buy: 'Buy from Peppynose', note: 'Order directly from us. Pay by UPI, card or net banking.' },
    hi: { buy: 'Peppynose से खरीदें', note: 'हमसे सीधे ऑर्डर करें। UPI, कार्ड या नेट बैंकिंग से भुगतान करें।' },
    ta: { buy: 'Peppynose-இடம் வாங்கு', note: 'எங்களிடம் நேரடியாக ஆர்டர் செய்யுங்கள். UPI, கார்டு அல்லது நெட் பேங்கிங் மூலம் பணம் செலுத்தலாம்.' }
  }[L];
  const base = () => {
    if (typeof window.PN_AUTH_API === 'string') return window.PN_AUTH_API.replace(/\/$/, '');
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '' : 'https://api.peppynose.com';
  };
  const shopUrl = slug => base() + (L === 'en' ? '' : '/' + L) + '/shop/' + slug + '.html';
  const track = slug => { if (window.pnTrack) window.pnTrack('shop_click', { product_slug: slug }); };

  function button(slug, cls) {
    const a = document.createElement('a');
    a.className = cls;
    a.href = shopUrl(slug);
    a.textContent = T.buy;
    a.dataset.shopSlug = slug;
    a.addEventListener('click', () => track(slug));
    return a;
  }

  function paint(sold) {
    // Products page: before each card's QR link, like the local test copy does.
    document.querySelectorAll('a.pn-qr[href]').forEach(qr => {
      const m = qr.getAttribute('href').match(/buy\/([a-z0-9-]+)\.html/);
      if (!m || !sold.has(m[1])) return;
      const prev = qr.previousElementSibling;
      if (prev && prev.classList.contains('sh-direct')) return;   // the local test copy already added one
      qr.before(button(m[1], 'btn sh-direct pn-shop-btn'));
    });
    // Buy page: one big button above the "handled by Amazon.in or Flipkart" note.
    const bm = location.pathname.match(/\/buy\/([a-z0-9-]+)\.html$/);
    const box = document.querySelector('.buy-box');
    if (bm && box && sold.has(bm[1]) && !box.querySelector('.pn-shop-btn')) {
      const wrap = document.createElement('div');
      wrap.className = 'pn-shop-direct';
      const note = document.createElement('p');
      note.className = 'buy-note';
      note.textContent = T.note;
      wrap.append(button(bm[1], 'btn pn-shop-btn'), note);
      const anchor = box.querySelector('.buy-note');
      if (anchor) anchor.before(wrap); else box.append(wrap);
    }
  }

  async function start() {
    if (!document.querySelector('a.pn-qr[href], .buy-box')) return;
    let cat;
    try {
      const res = await fetch(base() + '/api/catalogue', { credentials: 'omit' });
      if (!res.ok) return;
      cat = await res.json();
    } catch (e) { return; }
    if (!cat || cat.live !== true || !Array.isArray(cat.products)) return;
    // Sold = in the shop and at least one pack in stock.
    const sold = new Set(cat.products.filter(p => (p.variants || []).some(v => v.stock > 0)).map(p => p.slug));
    paint(sold);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
