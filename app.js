/* Sreshta Fresh customer website.
 * Talks to the Google Apps Script web app (see config.js):
 *   GET  ?api=catalog | customer&phone= | orders&phone=
 *   POST {action: placeOrder | cancelOrder | preOrder | cancelPreOrder, ...}
 */
(function () {
  'use strict';

  var CFG = window.SF_CONFIG || {};
  var API = CFG.API_URL || '';
  var CHICKEN = 'Country Chicken';
  var CATS = [['all', 'All', 'Shop Farm Fresh'], ['Veggies', 'Veggies', 'Shop Veggies'], ['Flowers', 'Flowers', 'Shop Flowers'],
    ['Eggs', 'Eggs', 'Shop Country Eggs'], [CHICKEN, 'Country Chicken', 'Shop Country Chicken']];
  var EMOJI = { 'Veggies': '🥬', 'Flowers': '🌼', 'Eggs': '🥚', 'Country Chicken': '🐓' };
  var POLL_MS = 5000;

  var CAT = null;                 // catalog from the server
  var CART = load('sf_cart', {}); // item key -> qty
  var PACK = {};                  // item key -> pack size chosen in the card's dropdown
  var ME = load('sf_me', {});     // phone, name, flat, apartment
  var FILTER = 'all';
  var VIEW = 'shop';
  var LAST = load('sf_last', null);
  var lastOk = 0, fetching = false, lastSig = '', gridDirty = false;
  var PAYING = false;   // our own items are on hold while the Razorpay window is open
  var sheetMode = '';
  var FORM = { fulfilment: 'Pickup', notes: '', pay: 'Online' };
  var PRE = { kg: 1, fulfilment: 'Pickup', notes: '' };
  var MO = { phone: '', data: null, busy: false };

  // ---------- utilities ----------
  function $(id) { return document.getElementById(id); }
  function load(k, d) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : d; } catch (e) { return d; }
  }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function r2(x) { return Math.round(x * 100) / 100; }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function rs(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
  function q(n) { return Number(r3(n || 0)).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
  function newReqId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
  function phone10(v) { var p = String(v || '').replace(/\D/g, ''); if (p.length > 10) p = p.slice(-10); return p.length === 10 ? p : ''; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmtD(ymd) {
    if (!ymd) return '';
    var p = ymd.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return DAYS[d.getUTCDay()] + ' ' + (+p[2]) + ' ' + MON[+p[1] - 1];
  }
  function hourTxt(h) { h = Number(h); return (h % 12 || 12) + (h >= 12 ? ' PM' : ' AM'); }
  function unitTxt(u, n) { return u === 'bunch' ? (n === 1 ? 'bunch' : 'bunches') : u; }
  function catCls(c) { return String(c).replace(/\s+/g, '-'); }
  function shop() { return (CAT && CAT.shop) || { name: CFG.SHOP_NAME, phone: CFG.PHONE, upi: CFG.UPI_ID }; }
  function itemByKey(k) { return CAT ? CAT.items.filter(function (i) { return i.key === k; })[0] : null; }
  function floorStep(v, step) { return r3(Math.floor(r3(v / step) + 1e-9) * step); }

  function toast(msg, err) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.className = 'toast'; }, err ? 5000 : 2600);
  }

  // ---------- API ----------
  function connected() { return API && !/PASTE_/.test(API); }
  function apiGet(params) {
    var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch(API + '?' + qs + '&t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  function apiPost(body) {
    return fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  // ---------- live catalog ----------
  function refresh() {
    if (!connected() || fetching) return Promise.resolve();
    fetching = true;
    return apiGet({ api: 'catalog' }).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'Error');
      setCatalog(r.data, true);
    }).catch(function () {
      $('live').classList.add('off');
    }).then(function () { fetching = false; });
  }

  function setCatalog(d, notify) {
    CAT = d;
    lastOk = Date.now();
    $('live').classList.remove('off');
    tick();
    clampCart(notify);
    var sig = JSON.stringify([d.items, d.chicken, d.shop.afterCutoff, d.banners]);
    if (sig !== lastSig) { lastSig = sig; renderShop(); }
    updateBasketBar();
    if (sheetMode === 'basket') renderBasketLines();
  }

  /** Someone else bought the last of an item: shrink the basket to what's left. */
  function clampCart(notify) {
    // While paying, the stock we see is reduced by our own hold; that isn't someone else buying it.
    if (PAYING) return;
    var msgs = [];
    Object.keys(CART).forEach(function (k) {
      var it = itemByKey(k);
      if (!it || it.left <= 0) { delete CART[k]; msgs.push((it ? it.item : k.split('|')[0]) + ' just sold out'); return; }
      if (CART[k] > it.left + 1e-9) {
        var nq = floorStep(it.left, it.step);
        if (nq > 0) { CART[k] = nq; msgs.push('Only ' + q(it.left) + ' ' + unitTxt(it.unit, it.left) + ' ' + it.item + ' left'); }
        else { delete CART[k]; msgs.push(it.item + ' just sold out'); }
      }
    });
    if (msgs.length) {
      store('sf_cart', CART);
      if (notify) toast(msgs.join(' · ') + '. Basket updated.', true);
    }
  }

  function tick() {
    var el = $('liveTxt');
    if (!connected()) { el.textContent = 'Not connected'; $('live').classList.add('off'); return; }
    if (!lastOk) { el.textContent = 'Connecting…'; return; }
    var s = Math.round((Date.now() - lastOk) / 1000);
    if (s > 30) { $('live').classList.add('off'); el.textContent = 'Reconnecting…'; return; }
    el.textContent = s < 6 ? 'Live stock' : 'Live · ' + s + 's ago';
  }

  // ---------- shop ----------
  function renderShop() {
    var s = CAT.shop;
    $('notice').innerHTML = s.afterCutoff
      ? '<div class="note">🌙 It\'s after ' + hourTxt(s.cutoffHour) + '. Orders placed now will be packed tomorrow morning.</div>' : '';

    var present = {};
    CAT.items.forEach(function (i) { present[i.category] = true; });
    if (FILTER !== 'all' && !present[FILTER]) FILTER = 'all';
    var cats = CATS.filter(function (x) { return x[0] === 'all' || present[x[0]]; });
    if ($('cats')) {
      $('cats').innerHTML = cats.map(function (x) {
        return '<button class="cat' + (FILTER === x[0] ? ' on' : '') + '" data-cat="' + esc(x[0]) + '">' + x[1] + '</button>';
      }).join('');
    }
    // Header links are now the only category filter, so they include "All" to get back.
    $('nav').innerHTML = (cats.length > 2 ? cats : []).map(function (x) {
      return '<button class="' + (FILTER === x[0] ? 'on' : '') + '" data-cat="' + esc(x[0]) + '">' + x[1] + '</button>';
    }).join('');
    $('menuBtn').hidden = cats.length <= 2;
    renderPromo();
    renderGrid();
  }

  // ---------- banner slideshow ----------
  var PROMO = { idx: 0, timer: null, sig: '', paused: false };
  function promoSlides() {
    var list = (CAT.banners || []).slice();
    if (list.length) return list;
    // Nothing set up in the staff app yet: one simple slide, using a product photo if there is one.
    var withPhoto = CAT.items.filter(function (i) { return i.photo; })[0];
    return [{
      kicker: 'From Sreshta Farms', title: 'Farm fresh,', highlight: 'every day',
      text: 'Fresh veggies, flowers and country eggs from our farm, with live stock so you always know what\'s left.',
      button: 'Shop now', link: 'all', photo: withPhoto ? withPhoto.photo : ''
    }];
  }
  function renderPromo() {
    if (!$('promo')) return;   // page without a banner area: just skip it
    var slides = promoSlides();
    var sig = JSON.stringify(slides);
    if (sig === PROMO.sig) return;
    PROMO.sig = sig;
    if (PROMO.idx >= slides.length) PROMO.idx = 0;
    $('promo').innerHTML = '<div class="promo-track">' + slides.map(function (b, i) {
      var bg = b.photo ? ' style="--bg:url(\'' + esc(b.photo) + '\')"' : '';
      return '<div class="slide' + (i === PROMO.idx ? ' on' : '') + (b.photo ? ' has-ph' : '') + '"' + bg + '>' +
        '<div class="slide-txt">' +
        (b.kicker ? '<div class="slide-kicker">' + esc(b.kicker) + '</div>' : '') +
        '<h2>' + (b.title ? '<span>' + esc(b.title) + '</span> ' : '') + (b.highlight ? '<em>' + esc(b.highlight) + '</em>' : '') + '</h2>' +
        (b.text ? '<p>' + esc(b.text) + '</p>' : '') + '</div>' +
        '</div>';
    }).join('') + '</div>' +
      (slides.length > 1 ? '<div class="promo-dots">' + slides.map(function (b, i) {
        return '<button data-slide="' + i + '" class="' + (i === PROMO.idx ? 'on' : '') + '" aria-label="Slide ' + (i + 1) + '"></button>';
      }).join('') + '</div>' : '');
    clearInterval(PROMO.timer);
    if (slides.length > 1) PROMO.timer = setInterval(function () { if (!PROMO.paused && !document.hidden) showSlide(PROMO.idx + 1); }, 6000);
  }
  function showSlide(i) {
    if (!$('promo')) return;
    var s = $('promo').querySelectorAll('.slide'), d = $('promo').querySelectorAll('.promo-dots button');
    if (!s.length) return;
    PROMO.idx = (i + s.length) % s.length;
    [].forEach.call(s, function (el, k) { el.classList.toggle('on', k === PROMO.idx); });
    [].forEach.call(d, function (el, k) { el.classList.toggle('on', k === PROMO.idx); });
  }
  (function promoGestures() {
    var el = $('promo'), x0 = null;
    if (!el) return;
    el.addEventListener('mouseenter', function () { PROMO.paused = true; });
    el.addEventListener('mouseleave', function () { PROMO.paused = false; });
    el.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; PROMO.paused = true; }, { passive: true });
    el.addEventListener('touchend', function (e) {
      PROMO.paused = false;
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) showSlide(PROMO.idx + (dx < 0 ? 1 : -1));
      x0 = null;
    });
  })();

  function renderGrid() {
    // Don't yank the field away while someone is typing a quantity.
    var a = document.activeElement;
    if (a && /INPUT|SELECT/.test(a.tagName) && $('grid').contains(a)) { gridDirty = true; return; }
    gridDirty = false;
    var items = CAT.items.filter(function (i) { return FILTER === 'all' || i.category === FILTER; });
    $('grid').innerHTML = items.length ? items.map(itemCard).join('')
      : '<div class="empty">Nothing in stock right now. Please check back soon 🌱</div>';
  }

  function isLow(it) { return it.left > 0 && it.left <= (it.unit === 'kg' ? 2 : 5); }

  /** Pack sizes offered in the dropdown, limited to what's in stock. */
  function packs(it) {
    var eggs = it.category === 'Eggs';
    var list = it.category === CHICKEN ? [0.5, 1, 1.5, 2, 2.5, 3, 4, 5]
      : it.unit === 'kg' ? [0.25, 0.5, 1, 1.5, 2, 3, 5]
      : eggs ? [12, 30]
      : [1, 2, 3, 4, 5, 6, 8, 10];
    var ok = list.filter(function (p) { return p <= it.left + 1e-9; });
    // Eggs are only sold in packs of 6 / 12 / 30; other items can take whatever is left.
    if (!ok.length && it.left > 0 && !eggs) ok = [floorStep(it.left, it.step)];
    return ok.filter(function (p) { return p > 0; });
  }
  function packLabel(it, p) {
    if (it.unit === 'kg') return p < 1 ? Math.round(p * 1000) + ' g' : q(p) + ' kg';
    if (it.category === 'Eggs') return p === 30 ? '30 Eggs (Tray)' : p + (p === 1 ? ' Egg' : ' Eggs');
    if (it.unit === 'bunch') return p + (p === 1 ? ' bunch' : ' bunches');
    return p + (p === 1 ? ' piece' : ' pieces');
  }
  function chosenPack(it) {
    var opts = packs(it), want = PACK[it.key];
    if (opts.indexOf(want) >= 0) return want;
    var dflt = it.category === CHICKEN ? 1 : it.unit === 'kg' ? 0.5 : it.category === 'Eggs' ? 12 : 1;
    if (opts.indexOf(dflt) >= 0) return dflt;
    return opts.filter(function (p) { return p <= dflt; }).pop() || opts[0] || it.step;
  }
  /** How many more packs of size p still fit in the stock, after what's already in the basket. */
  function maxPacks(it, p) { return Math.floor(r3((it.left - (CART[it.key] || 0)) / p) + 1e-9); }
  /** Basket +/− buttons: eggs move by the dozen so totals stay in packs. */
  function basketStep(it) { return it.category === 'Eggs' ? 12 : it.step; }
  function photoFor(it, p) { return (it.packPhotos && it.packPhotos[String(p)]) || it.photo || ''; }

  function itemCard(it) {
    var opts = packs(it);
    var sold = it.left <= 0 || !opts.length, inCart = CART[it.key] || 0, low = isLow(it);
    var preBook = it.category === CHICKEN && CAT.chicken && !CAT.shop.isSunday;
    var badge = sold ? '' : preBook ? 'Pre-book' : low ? 'Selling fast' : '';
    var stock = sold ? 'Sold out' : (low ? 'Only ' : '') + q(it.left) + ' ' + unitTxt(it.unit, it.left) + ' left';
    var p = chosenPack(it), full = !sold && maxPacks(it, p) < 1, photo = photoFor(it, p);
    return '<div class="item' + (sold ? ' sold' : '') + '" data-key="' + esc(it.key) + '">' +
      '<div class="ph ' + catCls(it.category) + '"><span class="em">' + (EMOJI[it.category] || '🧺') + '</span>' +
      (photo ? '<img src="' + esc(photo) + '" alt="' + esc(it.item) + '" loading="lazy" onerror="this.remove()">' : '') +
      (badge ? '<span class="badge">' + badge + '</span>' : '') +
      (sold ? '<span class="stamp">Out of stock</span>' : '') + '</div>' +
      '<div class="info"><div class="kicker">' + esc(it.category) + '</div>' +
      '<div class="name-row"><div class="name">' + esc(it.item) + '</div>' +
      '<div class="sub' + (sold ? ' out' : low ? ' low' : '') + '">' + stock + '</div></div>' +
      (preBook ? '<div class="sub">Arrives ' + fmtD(CAT.chicken.sunday) + '</div>' : '') +
      '<select class="pack" data-act="pack" aria-label="Pack size"' + (sold ? ' disabled' : '') + '>' +
      (sold ? '<option>' + esc(packLabel(it, it.step)) + '</option>'
        : opts.map(function (o) { return '<option value="' + o + '"' + (o === p ? ' selected' : '') + '>' + packLabel(it, o) + '</option>'; }).join('')) +
      '</select>' +
      '<div class="price"><b>' + rs(r2(it.price * (sold ? 1 : p))) + '</b>' +
      (it.mrp > it.price ? '<s class="mrp" title="Market price">' + rs(r2(it.mrp * (sold ? 1 : p))) + '</s>' : '') +
      (sold ? '<span>/ per ' + (it.unit === 'pcs' ? 'piece' : it.unit) + '</span>' : '') +
      (it.rating ? '<button class="rate" data-act="reviews" aria-label="See reviews"><i>★</i> ' + it.rating.avg.toFixed(1) + ' <span>(' + it.rating.n + ')</span></button>' : '') +
      (it.mrp > it.price ? '<em class="off">' + Math.round((1 - it.price / it.mrp) * 100) + '% off market price</em>' : '') + '</div>' +
      '<div class="acts">' + (sold ? '<button class="btn out wide" disabled>Sold out</button>'
        : '<button class="btn gold" data-act="add"' + (full ? ' disabled' : '') + '>Add</button>') + '</div>' +
      (inCart ? '<button class="in-basket" data-act="basket">✓ ' + packLabel(it, inCart) + ' in basket · View</button>' : '') +
      '</div></div>';
  }

  function stepper(it, qty, light) {
    return '<div class="stepper' + (light ? ' light' : '') + '"><button data-act="dec" aria-label="Less">−</button>' +
      '<input type="number" inputmode="decimal" step="' + it.step + '" min="0" value="' + qty + '" data-act="qty" aria-label="Quantity">' +
      '<span class="u">' + esc(it.unit) + '</span><button data-act="inc" aria-label="More">+</button></div>';
  }

  function addPack(key) {
    var it = itemByKey(key);
    if (!it) return;
    var p = chosenPack(it), before = CART[key] || 0;
    setQty(key, r3(before + p));
    if ((CART[key] || 0) > before) toast('Added ' + packLabel(it, p) + ' ' + it.item + ' to your basket');
  }

  function setQty(key, qty) {
    var it = itemByKey(key);
    if (!it) return;
    qty = floorStep(Math.max(0, qty), it.step);
    if (qty > it.left + 1e-9) { qty = floorStep(it.left, it.step); toast('Only ' + q(it.left) + ' ' + unitTxt(it.unit, it.left) + ' ' + it.item + ' left.', true); }
    if (qty <= 0) delete CART[key]; else CART[key] = qty;
    FORM.reqId = '';   // a changed basket is a new order
    store('sf_cart', CART);
    renderGrid();
    updateBasketBar();
    if (sheetMode === 'basket') renderBasketLines();
  }

  function cartKeys() { return Object.keys(CART).filter(function (k) { return itemByKey(k); }); }
  function cartTotal() {
    return r2(cartKeys().reduce(function (a, k) { return a + r2(CART[k] * itemByKey(k).price); }, 0));
  }
  /** How much less than market price the basket costs (only items with a market price count). */
  function cartSavings() {
    return r2(cartKeys().reduce(function (a, k) {
      var it = itemByKey(k);
      return a + (it.mrp > it.price ? r2(CART[k] * it.mrp) - r2(CART[k] * it.price) : 0);
    }, 0));
  }
  function updateBasketBar() {
    var n = cartKeys().length;
    $('basketBar').hidden = !n || VIEW !== 'shop' || sheetMode !== '';
    $('bbCount').textContent = '🧺 ' + n + ' item' + (n === 1 ? '' : 's') + ' · ' + rs(cartTotal());
  }

  // ---------- bottom sheet ----------
  function showSheet(html) {
    $('sheet').innerHTML = html;
    $('sheetWrap').hidden = false;
    document.body.style.overflow = 'hidden';
    updateBasketBar();
  }
  function closeSheet() {
    sheetMode = '';
    $('sheetWrap').hidden = true;
    document.body.style.overflow = '';
    updateBasketBar();
    if (gridDirty && CAT) renderGrid();
  }

  function custFields(p) {
    return '<div class="field"><label for="' + p + '-phone">Phone number</label><input id="' + p + '-phone" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel" placeholder="10-digit mobile" value="' + esc(ME.phone || '') + '">' +
      '<div class="hint" id="' + p + '-hint"></div></div>' +
      '<div class="field"><label for="' + p + '-name">Name</label><input id="' + p + '-name" autocomplete="name" value="' + esc(ME.name || '') + '"></div>' +
      '<div class="row2"><div class="field"><label for="' + p + '-flat">Flat no.</label><input id="' + p + '-flat" value="' + esc(ME.flat || '') + '"></div>' +
      '<div class="field"><label for="' + p + '-apt">Apartment / block</label><input id="' + p + '-apt" value="' + esc(ME.apartment || '') + '"></div></div>';
  }
  function bindCust(p) {
    var el = $(p + '-phone');
    el.addEventListener('input', function () {
      var ph = phone10(el.value), hint = $(p + '-hint');
      if (!ph) { hint.textContent = ''; return; }
      if (ph === ME.phone && ME.name) return;
      hint.textContent = 'Checking…';
      apiGet({ api: 'customer', phone: ph }).then(function (r) {
        if (phone10(el.value) !== ph) return;
        if (r.ok && r.customer) {
          $(p + '-name').value = r.customer.name;
          $(p + '-flat').value = r.customer.flat;
          $(p + '-apt').value = r.customer.apartment;
          hint.textContent = '✓ Welcome back, ' + r.customer.name.split(' ')[0] + '!';
          hint.className = 'hint ok';
        } else {
          hint.textContent = 'New here? Fill in your details once and we\'ll remember them.';
          hint.className = 'hint';
        }
      }).catch(function () { hint.textContent = ''; });
    });
  }
  function readCust(p) {
    var c = {
      phone: phone10($(p + '-phone').value), name: $(p + '-name').value.trim(),
      flat: $(p + '-flat').value.trim(), apartment: $(p + '-apt').value.trim()
    };
    if (!c.phone) return toast('Please enter your 10-digit phone number.', true), null;
    if (!c.name) return toast('Please enter your name.', true), null;
    if (!c.flat) return toast('Please enter your flat number.', true), null;
    ME = c;
    store('sf_me', ME);
    return c;
  }
  function toggle(obj, name) {
    var f = obj === 'PRE' ? PRE : FORM;
    return '<div class="toggle" data-tg="' + obj + '">' +
      [['Pickup', '🚶 I\'ll pick up'], ['Delivery', '🛵 Please deliver']].map(function (o) {
        return '<button type="button" data-fv="' + o[0] + '" class="' + (f.fulfilment === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>';
  }

  // ---------- payment choice ----------
  function onlinePay() { return !!(CAT && CAT.shop.razorpay) && FORM.pay === 'Online'; }
  function payInfoTxt() {
    return onlinePay() ? '💳 Pay securely now with UPI, card or net banking (Razorpay). Your items are held for ' +
      ((CAT && CAT.shop.holdMinutes) || 5) + ' minutes while you pay.'
      : '💵 No payment now. Pay by Cash or PhonePe when you receive your order.';
  }
  function payToggle() {
    if (!(CAT && CAT.shop.razorpay)) return '';
    return '<label>How would you like to pay?</label><div class="toggle" data-tg="PAY">' +
      [['Online', '💳 Pay now'], ['Delivery', '💵 Pay on delivery']].map(function (o) {
        return '<button type="button" data-fv="' + o[0] + '" class="' + (FORM.pay === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
      (CAT.shop.razorpayTest ? '<div class="hint" style="margin:-4px 0 10px">🧪 Test mode: no real money is taken.</div>' : '');
  }
  function placeLabel() { return (onlinePay() ? 'Pay ' : 'Place order · ') + rs(cartTotal()); }

  function openBasket() {
    sheetMode = 'basket';
    showSheet('<div class="sheet-head"><h2>Your basket</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
      '<div class="card" id="bk-lines"></div>' +
      '<div class="card"><h3 style="margin-bottom:10px">Your details</h3>' + custFields('bk') +
      '<label>Pickup or delivery?</label>' + toggle('FORM') +
      '<div class="field"><label for="bk-notes">Note for us (optional)</label><input id="bk-notes" maxlength="200" value="' + esc(FORM.notes) + '" placeholder="e.g. please call before coming"></div>' +
      payToggle() + '</div>' +
      '<div class="payinfo" id="bk-payinfo">' + payInfoTxt() + '</div>' +
      '<div id="bk-err"></div><button class="btn gold big wide" id="placeBtn" data-act="place">Place order</button>');
    renderBasketLines();
    bindCust('bk');
  }

  function renderBasketLines() {
    var box = $('bk-lines');
    if (!box) return;
    var a = document.activeElement;
    if (a && a.tagName === 'INPUT' && box.contains(a)) return;
    var keys = cartKeys();
    $('placeBtn').disabled = !keys.length;
    if (!keys.length) {
      box.innerHTML = '<div class="empty" style="padding:14px">Your basket is empty.</div>';
      $('placeBtn').textContent = 'Place order';
      return;
    }
    box.innerHTML = keys.map(function (k) {
      var it = itemByKey(k);
      return '<div class="line" data-key="' + esc(k) + '"><div class="grow"><div class="name">' + esc(it.item) + '</div><div class="price">' +
        rs(it.price) + (it.mrp > it.price ? ' <s class="mrp">' + rs(it.mrp) + '</s>' : '') + ' / ' + (it.unit === 'pcs' ? 'piece' : it.unit) + ' · ' + q(it.left) + ' left</div></div>' +
        stepper(it, CART[k], true) + '<div class="amt">' + rs(r2(CART[k] * it.price)) + '</div></div>';
    }).join('') + '<div class="total"><span>Total</span><span>' + rs(cartTotal()) + '</span></div>' +
      (cartSavings() > 0 ? '<div class="saving">🎉 You save ' + rs(cartSavings()) + ' compared to market price</div>' : '');
    $('placeBtn').textContent = placeLabel();
  }

  function placeOrder() {
    var c = readCust('bk');
    if (!c) return;
    FORM.notes = $('bk-notes').value.trim();
    var keys = cartKeys();
    if (!keys.length) return;
    var btn = $('placeBtn');
    if (btn.disabled) return;
    if (onlinePay()) return payOnline(c, keys, btn);
    btn.disabled = true;
    btn.textContent = 'Placing your order…';
    $('bk-err').innerHTML = '';
    // Same code on a retry, so the shop never creates the order twice.
    FORM.reqId = FORM.reqId || newReqId();
    apiPost({
      action: 'placeOrder', reqId: FORM.reqId, phone: c.phone, name: c.name, flat: c.flat, apartment: c.apartment,
      fulfilment: FORM.fulfilment, notes: FORM.notes,
      items: keys.map(function (k) { return { key: k, qty: CART[k] }; })
    }).then(function (r) {
      if (r.ok) {
        LAST = r.order;
        store('sf_last', LAST);
        CART = {};
        store('sf_cart', CART);
        FORM.notes = '';
        FORM.reqId = '';
        closeSheet();
        location.hash = '#done';
        refresh();
        return;
      }
      if (r.catalog) setCatalog(r.catalog, false);
      $('bk-err').innerHTML = '<div class="note err" style="margin:0 0 12px">' + esc(r.error) + '</div>';
      btn.disabled = false;
      renderBasketLines();
    }).catch(function () {
      $('bk-err').innerHTML = '<div class="note err" style="margin:0 0 12px">We couldn\'t reach the shop. Check your internet and try again. ' +
        'If it keeps failing, check <a href="#orders">My orders</a> before ordering again.</div>';
      btn.disabled = false;
      btn.textContent = 'Try again · ' + rs(cartTotal());
    });
  }

  // ---------- Razorpay ----------
  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = res;
      s.onerror = function () { rej(new Error('net')); };
      document.head.appendChild(s);
    });
  }
  function basketError(msg) {
    PAYING = false;
    var box = $('bk-err');
    if (box) box.innerHTML = '<div class="note err" style="margin:0 0 12px">' + msg + '</div>';
    var btn = $('placeBtn');
    if (btn) { btn.disabled = false; btn.textContent = placeLabel(); }
  }
  function orderPlaced(order) {
    PAYING = false;
    LAST = order;
    store('sf_last', LAST);
    CART = {};
    store('sf_cart', CART);
    FORM.notes = '';
    FORM.reqId = '';
    closeSheet();
    location.hash = '#done';
    if (VIEW === 'done') renderDone();
    refresh();
  }

  /** 1) hold the items on the server, 2) open Razorpay, 3) confirm with the server. */
  function payOnline(c, keys, btn) {
    btn.disabled = true;
    btn.textContent = 'Opening secure payment…';
    $('bk-err').innerHTML = '';
    PAYING = true;
    FORM.notes = $('bk-notes').value.trim();
    FORM.reqId = FORM.reqId || newReqId();
    Promise.all([loadRazorpay(), apiPost({
      action: 'startPayment', reqId: FORM.reqId, phone: c.phone, name: c.name, flat: c.flat, apartment: c.apartment,
      fulfilment: FORM.fulfilment, notes: FORM.notes, items: keys.map(function (k) { return { key: k, qty: CART[k] }; })
    })]).then(function (res) {
      var r = res[1];
      if (!r.ok) {
        if (r.catalog) setCatalog(r.catalog, false);
        renderBasketLines();
        return basketError(esc(r.error));
      }
      openCheckout(r.pay, c);
    }).catch(function () {
      basketError('We couldn\'t reach the payment service. Check your internet and try again.');
    });
  }

  function openCheckout(pay, c) {
    var finished = false;
    var rz = new window.Razorpay({
      key: pay.keyId, amount: pay.amount, currency: 'INR', order_id: pay.rzpOrderId,
      name: shop().name || 'Sreshta Fresh', description: 'Order ' + pay.orderId,
      prefill: { name: c.name, contact: '+91' + c.phone },
      notes: { shop_order: pay.orderId }, theme: { color: '#015c30' },
      timeout: Math.max(60, Math.floor((pay.holdUntil - Date.now()) / 1000) - 20),   // close before the hold ends
      handler: function (resp) { finished = true; confirmPaid(pay, resp, 0); },
      modal: { confirm_close: true, ondismiss: function () { if (!finished) abandonPay(pay, c); } }
    });
    rz.on('payment.failed', function (resp) {
      toast('Payment failed: ' + ((resp.error && resp.error.description) || 'please try again') + '. You can try again in the same window.', true);
    });
    rz.open();
  }

  function confirmPaid(pay, resp, attempt) {
    showSheet('<div class="done-top"><div class="tick">⏳</div><h2>Confirming your payment…</h2>' +
      '<div class="oid">Please don\'t close this page.</div></div>');
    sheetMode = 'info';
    apiPost({
      action: 'confirmPayment', orderId: pay.orderId, razorpay_payment_id: resp.razorpay_payment_id,
      razorpay_order_id: resp.razorpay_order_id, razorpay_signature: resp.razorpay_signature
    }).then(function (r) {
      if (r.ok) return orderPlaced(r.order);
      paidButUnconfirmed(pay, r.error);
    }).catch(function () {
      if (attempt < 3) return setTimeout(function () { confirmPaid(pay, resp, attempt + 1); }, 2000);
      paidButUnconfirmed(pay, '');
    });
  }
  function paidButUnconfirmed(pay, why) {
    showSheet('<div class="done-top"><div class="tick">!</div><h2>Payment received, confirming</h2>' +
      '<div class="oid">Order ' + esc(pay.orderId) + '</div></div>' +
      '<div class="note">' + (why ? esc(why) + ' ' : '') + 'Please <b>don\'t pay again</b>. Our shop checks every payment with Razorpay ' +
      'automatically, and your order will show in <b>My orders</b> shortly. If it doesn\'t, contact us with the order number above.</div>' +
      '<div class="actions" style="margin-top:14px">' + contactButtons('Hi! I paid online for order ' + pay.orderId + ' but it wasn\'t confirmed on the website.') +
      '<a class="btn ghost wide" href="#orders">🧾 My orders</a></div>');
    sheetMode = 'info';
    PAYING = false;
    CART = {};
    store('sf_cart', CART);
    FORM.reqId = '';
  }
  function abandonPay(pay, c) {
    var btn = $('placeBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Releasing your items…'; }
    apiPost({ action: 'abandonPayment', orderId: pay.orderId, phone: c.phone }).then(function (r) {
      if (r.ok && r.order && r.order.status === 'Placed') return orderPlaced(r.order);   // they had paid after all
      FORM.reqId = '';
      // Get the released stock back first (a fresh fetch, not a poll that may still be in flight);
      // only then check whether anything really sold out.
      return apiGet({ api: 'catalog' }).then(function (cr) {
        if (cr.ok) setCatalog(cr.data, false);
      }).catch(function () { /* keep the basket as it is */ }).then(function () {
        PAYING = false;
        clampCart(true);
        basketError('Payment not completed. Your basket is still here. Try again, or choose <b>Pay on delivery</b>.');
        renderBasketLines();
        if (CAT) renderGrid();
      });
    }).catch(function () {
      FORM.reqId = '';
      basketError('Payment not completed. Your basket is still here.');
      renderBasketLines();
    });
  }

  // ---------- chicken pre-order ----------
  function openPre() {
    var c = CAT.chicken;
    sheetMode = 'pre';
    showSheet('<div class="sheet-head"><h2>🐓 Reserve country chicken</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
      '<div class="card"><b>For ' + fmtD(c.sunday) + '</b><div class="hint" style="margin:4px 0 12px">Sold by weight in 0.5 kg steps. The final price depends on the actual weight' +
      (c.lastPrice ? ' (last price ' + rs(c.lastPrice) + '/kg)' : '') + '. Pay when you receive it.</div>' +
      '<label>How much?</label><div class="stepper light" style="max-width:220px"><button data-act="pdec">−</button>' +
      '<input id="pr-kg" type="number" inputmode="decimal" step="0.5" min="0.5" value="' + PRE.kg + '"><span class="u">kg</span><button data-act="pinc">+</button></div></div>' +
      '<div class="card"><h3 style="margin-bottom:10px">Your details</h3>' + custFields('pr') +
      '<label>Pickup or delivery?</label>' + toggle('PRE') +
      '<div class="field" style="margin:0"><label for="pr-notes">Note (optional)</label><input id="pr-notes" maxlength="200" placeholder="e.g. curry cut"></div></div>' +
      '<div id="pr-err"></div><button class="btn gold big wide" id="preBtn" data-act="preSubmit">Reserve chicken</button>');
    bindCust('pr');
  }
  function preKg(delta) {
    var v = Number($('pr-kg').value) || 0;
    v = Math.max(0.5, Math.min(20, Math.round((v + delta) * 2) / 2));
    PRE.kg = v;
    $('pr-kg').value = v;
  }
  function submitPre() {
    var c = readCust('pr');
    if (!c) return;
    var kg = Math.round((Number($('pr-kg').value) || 0) * 2) / 2;
    if (kg < 0.5) return toast('Choose at least 0.5 kg.', true);
    var btn = $('preBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Reserving…';
    if (PRE.reqKg !== kg) { PRE.reqId = newReqId(); PRE.reqKg = kg; }
    apiPost({
      action: 'preOrder', reqId: PRE.reqId, phone: c.phone, name: c.name, flat: c.flat, apartment: c.apartment,
      kg: kg, fulfilment: PRE.fulfilment, notes: $('pr-notes').value.trim()
    }).then(function (r) {
      if (!r.ok) {
        $('pr-err').innerHTML = '<div class="note err" style="margin:0 0 12px">' + esc(r.error) + '</div>';
        btn.disabled = false;
        btn.textContent = 'Reserve chicken';
        return;
      }
      PRE.reqId = ''; PRE.reqKg = null;
      closeSheet();
      showSheet('<div class="done-top"><div class="tick">✓</div><h2>Chicken reserved!</h2><div class="oid">' + q(r.preorder.kg) + ' kg for ' + fmtD(r.preorder.sunday) + '</div></div>' +
        '<div class="payinfo">We\'ll weigh it on Sunday and send you the bill. Pay by Cash or PhonePe when you receive it.</div>' +
        '<div class="actions">' + contactButtons('Hi! I reserved ' + q(r.preorder.kg) + ' kg country chicken for ' + fmtD(r.preorder.sunday) + ' (' + r.preorder.id + ').') +
        '<button class="btn ghost wide" data-act="close">Done</button></div>');
      sheetMode = 'info';
    }).catch(function () {
      $('pr-err').innerHTML = '<div class="note err" style="margin:0 0 12px">We couldn\'t reach the shop. Check your internet and try again.</div>';
      btn.disabled = false;
      btn.textContent = 'Reserve chicken';
    });
  }

  // ---------- order placed ----------
  function contactButtons(msg) {
    var ph = shop().phone || CFG.PHONE;
    return '<div class="row2"><a class="btn wa big" href="https://wa.me/91' + ph + '?text=' + encodeURIComponent(msg) + '" target="_blank" rel="noopener">💬 WhatsApp</a>' +
      '<a class="btn ghost big" href="tel:+91' + ph + '">📞 Call</a></div>';
  }
  function payUrl(o) { return 'pay.html?o=' + encodeURIComponent(o.id) + '&a=' + o.total; }
  function track(o) {
    if (o.status === 'Cancelled') return '<div style="margin:10px 0 2px"><span class="chip cancel">Cancelled</span></div>';
    var steps = [['Placed', 'Placed'], ['Packed', 'Packed & ready'], ['Completed', 'Received']];
    var at = Math.max(0, steps.map(function (s) { return s[0]; }).indexOf(o.status));
    return '<div class="track">' + steps.map(function (s, i) {
      return '<div class="st' + (i <= at ? ' on' : '') + (i === at ? ' now' : '') + '">' + s[1] + '</div>';
    }).join('') + '</div>';
  }
  function orderLines(o) {
    return o.items.map(function (i) {
      return '<div class="line"><div class="grow"><div class="name">' + esc(i.item) + '</div><div class="price">' + q(i.qty) + ' ' + esc(unitTxt(i.unit, i.qty)) + ' × ' + rs(i.price) + '</div></div>' +
        '<div class="amt">' + rs(i.lineTotal) + '</div></div>';
    }).join('') + '<div class="total"><span>Total</span><span>' + rs(o.total) + '</span></div>';
  }

  function renderDone() {
    var o = LAST;
    if (!o) { location.hash = ''; return; }
    var s = shop();
    var head = { Placed: 'Order placed!', Packed: 'Packed & ready! 📦', Completed: 'Received. Thank you! 🌿', Cancelled: 'Order cancelled' }[o.status] || 'Order placed!';
    var hasChicken = o.items.some(function (i) { return i.category === CHICKEN; });
    var msg = {
      Placed: hasChicken && !s.isSunday ? 'Your chicken arrives on Sunday. We\'ll message you on WhatsApp when it\'s packed and ready.'
        : 'We\'ll message you on WhatsApp when it\'s packed and ready.',
      Packed: 'Your order is ready for pickup. If you can\'t come, we\'ll deliver it.',
      Completed: 'Hope you enjoy it!',
      Cancelled: 'This order was cancelled.'
    }[o.status] || '';
    $('view-done').innerHTML = '<div class="done-top"><div class="tick"' + (o.status === 'Cancelled' ? ' style="background:var(--red)">✕' : '>✓') + '</div><h2>' + head + '</h2><div class="oid">Order ' + esc(o.id) + '</div></div>' +
      (s.afterCutoff && o.status === 'Placed' ? '<div class="note">🌙 It\'s late, so we\'ll pack this tomorrow morning.</div>' : '') +
      '<div class="card">' + track(o) + '<div class="hint" style="text-align:center;margin-bottom:8px">' + msg + '</div>' + orderLines(o) + '</div>' +
      '<div class="payinfo">' + (o.payment === 'Razorpay' ? '✅ Paid online. Nothing more to pay.'
        : o.payment === 'Refunded' ? '↩️ Your payment has been refunded. It reaches your account in 5–7 working days.'
        : '💵 Pay by Cash or PhonePe when you receive it.') + '</div>' +
      '<div class="actions">' + contactButtons('Hi! I just placed order ' + o.id + ' (' + rs(o.total) + ') on the website.') +
      (o.payment === 'Pending' ? '<a class="btn ghost big wide" href="' + payUrl(o) + '">Pay now by PhonePe / UPI (optional)</a>' : '') +
      '<div class="row2"><a class="btn big" href="#orders">🧾 My orders</a><a class="btn big" href="#">🛒 Shop more</a></div></div>';
  }

  /** Keeps the "Order placed" page in step with the shop (Placed → Packed → Received). */
  var doneBusy = false;
  function pollDone() {
    if (doneBusy || !LAST || !LAST.phone) return;
    doneBusy = true;
    apiGet({ api: 'orders', phone: LAST.phone }).then(function (r) {
      var o = r.ok && r.data.orders.filter(function (x) { return x.id === LAST.id; })[0];
      if (o && (o.status !== LAST.status || o.payment !== LAST.payment)) {
        LAST = o;
        store('sf_last', LAST);
        if (VIEW === 'done') renderDone();
      }
    }).catch(function () { /* try again next tick */ }).then(function () { doneBusy = false; });
  }

  // ---------- my orders ----------
  function showOrders() {
    var inp = $('mo-phone');
    if (!inp.value && ME.phone) inp.value = ME.phone;
    if (phone10(inp.value)) loadMyOrders(false);
    else $('mo-list').innerHTML = '<div class="empty">Enter the phone number you ordered with.</div>';
  }
  function loadMyOrders(quiet) {
    var ph = phone10($('mo-phone').value);
    if (!ph) return toast('Please enter your 10-digit phone number.', true);
    if (MO.busy) return;
    MO.busy = true;
    if (!quiet) $('mo-list').innerHTML = '<div class="empty">Loading your orders…</div>';
    apiGet({ api: 'orders', phone: ph }).then(function (r) {
      if (!r.ok) throw new Error(r.error);
      MO.phone = ph;
      var sig = JSON.stringify(r.data);
      if (quiet && sig === MO.sig) return;
      MO.sig = sig;
      MO.data = r.data;
      renderMyOrders();
    }).catch(function (e) {
      if (!quiet) $('mo-list').innerHTML = '<div class="note err">' + esc((e && e.message) || 'Could not load your orders. Check your internet.') + '</div>';
    }).then(function () { MO.busy = false; });
  }
  function renderMyOrders() {
    var d = MO.data, h = '';
    if (!d.orders.length && !d.preorders.length) {
      $('mo-list').innerHTML = '<div class="empty">No orders yet for this number.</div>';
      return;
    }
    d.preorders.forEach(function (p) {
      var cls = p.status === 'Open' ? 'pending' : p.status === 'Delivered' ? '' : 'cancel';
      h += '<div class="card"><div class="ord-head"><div><b>🐓 Chicken pre-order · ' + q(p.kg) + ' kg</b><div class="ord-items">For ' + fmtD(p.sunday) + '</div></div>' +
        '<span class="chip ' + cls + '">' + (p.status === 'Open' ? 'Reserved' : esc(p.status)) + '</span></div>' +
        (p.status === 'Open' ? '<div class="actions" style="margin-top:10px"><button class="btn danger" data-act="cancelPre" data-id="' + esc(p.id) + '">Cancel reservation</button></div>' : '') + '</div>';
    });
    d.orders.forEach(function (o) {
      var open = o.status === 'Placed' || o.status === 'Packed';
      var unpaid = o.payment === 'Pending' && o.status !== 'Cancelled';
      var rv = o.review && o.review.items ? o.review : null;
      h += '<div class="card"><div class="ord-head"><div><b>' + fmtD(o.date) + ' · ' + esc(o.time) + '</b><div class="ord-items">' +
        esc(o.items.map(function (i) { return i.item + ' ' + q(i.qty) + ' ' + unitTxt(i.unit, i.qty); }).join(', ')) + '</div></div>' +
        '<div style="text-align:right"><b>' + rs(o.total) + '</b><br>' +
        (o.payment === 'Refunded' ? '<span class="chip cancel">Refunded</span>'
          : o.status === 'Cancelled' ? '<span class="chip cancel">Cancelled</span>'
          : unpaid ? '<span class="chip pending">To pay</span>'
          : '<span class="chip">' + (o.payment === 'Razorpay' ? 'Paid online' : 'Paid · ' + esc(o.payment)) + '</span>') +
        '</div></div>' + (o.type === 'Online' ? track(o) : '') +
        ((unpaid || open) ? '<div class="actions" style="margin-top:10px">' +
          (unpaid ? '<a class="btn gold" href="' + payUrl(o) + '">Pay ' + rs(o.total) + ' by PhonePe / UPI</a>' : '') +
          (open ? '<button class="btn danger" data-act="cancelOrder" data-id="' + esc(o.id) + '" data-paid="' + (o.payment === 'Razorpay' ? o.total : '') + '">Cancel order</button>' : '') + '</div>' : '') +
        (rv ? (rv.rated < rv.items
          ? '<div class="actions" style="margin-top:10px"><button class="btn gold" data-act="rate" data-id="' + esc(o.id) + '">⭐ Rate your items</button></div>'
          : '<button class="in-basket" data-act="rate" data-id="' + esc(o.id) + '">✓ Thanks for rating · Edit</button>') : '') +
        '</div>';
    });
    h += '<div class="actions" style="margin-top:4px">' + contactButtons('Hi! I have a question about my order.') + '</div>';
    $('mo-list').innerHTML = h;
  }
  function cancelOrder(id, paid) {
    if (!confirm(paid ? 'Cancel this order? ' + rs(paid) + ' will be refunded to your account (5–7 working days).' : 'Cancel this order?')) return;
    apiPost({ action: 'cancelOrder', orderId: id, phone: MO.phone }).then(function (r) {
      if (!r.ok) return toast(r.error, true);
      toast(paid ? 'Order cancelled. Your refund has been started.' : 'Order cancelled.');
      loadMyOrders(true);
      refresh();
    }).catch(function () { toast('Could not reach the shop. Try again.', true); });
  }
  function cancelPre(id) {
    if (!confirm('Cancel your chicken reservation?')) return;
    apiPost({ action: 'cancelPreOrder', id: id, phone: MO.phone }).then(function (r) {
      if (!r.ok) return toast(r.error, true);
      toast('Reservation cancelled.');
      loadMyOrders(true);
    }).catch(function () { toast('Could not reach the shop. Try again.', true); });
  }

  // ---------- reviews ----------
  function starRow(n) { return '<span class="stars">' + '★★★★★'.slice(0, n) + '<i>' + '★★★★★'.slice(0, 5 - n) + '</i></span>'; }

  /** Everyone's reviews of one item (tap the ★ rating on a card). */
  function openReviews(key) {
    var it = itemByKey(key);
    if (!it) return;
    sheetMode = 'info';
    showSheet('<div class="sheet-head"><h2>' + esc(it.item) + ' reviews</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
      '<div id="rv-list"><div class="empty">Loading reviews…</div></div>');
    apiGet({ api: 'reviews', item: it.item }).then(function (r) {
      if (!r.ok) throw new Error(r.error);
      var d = r.data, box = $('rv-list');
      if (!box) return;
      box.innerHTML = (d.rating ? '<div class="rv-sum"><b>' + d.rating.avg.toFixed(1) + '</b>' + starRow(Math.round(d.rating.avg)) +
        '<span>' + d.rating.n + ' review' + (d.rating.n === 1 ? '' : 's') + ' from customers who bought it</span></div>' : '') +
        (d.reviews.length ? d.reviews.map(function (v) {
          return '<div class="card rv"><div class="rv-head">' + starRow(v.stars) + '<span>' + fmtD(v.date) + '</span></div>' +
            (v.comment ? '<p>' + esc(v.comment) + '</p>' : '') +
            '<div class="rv-who">' + esc(v.name || 'Customer') + (v.apartment ? ', ' + esc(v.apartment) : '') + ' · ✓ Verified buyer</div></div>';
        }).join('') : '<div class="empty">No reviews yet.</div>');
    }).catch(function (e) {
      if ($('rv-list')) $('rv-list').innerHTML = '<div class="note err">' + esc((e && e.message) || 'Could not load reviews.') + '</div>';
    });
  }

  /** Rate the items of a completed order: from the WhatsApp link (#review-ID), My orders, or the reminder. */
  var RV = null;
  function openRate(orderId, phone) {
    phone = phone10(phone || MO.phone || ME.phone);
    sheetMode = 'info';
    if (!phone) {
      showSheet('<div class="sheet-head"><h2>⭐ Rate your order</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
        '<div class="card"><label for="rv-phone">The phone number you ordered with</label>' +
        '<div class="inline"><input id="rv-phone" type="tel" inputmode="numeric" maxlength="14" placeholder="10-digit mobile">' +
        '<button class="btn dark" data-act="ratePhone" data-id="' + esc(orderId) + '">Continue</button></div></div>');
      return;
    }
    showSheet('<div class="sheet-head"><h2>⭐ Rate your order</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
      '<div class="empty">Loading your order…</div>');
    apiGet({ api: 'review', order: orderId, phone: phone }).then(function (r) {
      if (!r.ok) throw new Error(r.error);
      RV = { id: orderId, phone: phone, items: r.data.items };
      if (!ME.phone) { ME.phone = phone; store('sf_me', ME); }
      showSheet('<div class="sheet-head"><h2>⭐ How was it' + (r.data.order.name ? ', ' + esc(r.data.order.name) : '') + '?</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
        '<div class="hint" style="margin-bottom:10px">Your order from ' + fmtD(r.data.order.date) + '. Tap the stars; a comment is optional.</div>' +
        RV.items.map(function (x, i) {
          return '<div class="card rate-row" data-i="' + i + '"><div class="name">' + esc(x.item) + '</div>' +
            '<div class="star-pick">' + [1, 2, 3, 4, 5].map(function (v) {
              return '<button data-act="star" data-v="' + v + '" class="' + (v <= x.stars ? 'on' : '') + '" aria-label="' + v + ' star' + (v > 1 ? 's' : '') + '">★</button>';
            }).join('') + '</div>' +
            '<textarea rows="2" maxlength="300" data-rc="' + i + '" placeholder="Fresh? Tasty? Tell others (optional)">' + esc(x.comment) + '</textarea></div>';
        }).join('') +
        '<button class="btn gold big wide" data-act="rateSend" id="rv-send">Submit review</button>');
    }).catch(function (e) {
      showSheet('<div class="sheet-head"><h2>⭐ Rate your order</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
        '<div class="note err">' + esc((e && e.message) || 'Could not load your order. Check your internet.') + '</div>');
    });
  }
  function pickStar(t) {
    var row = t.closest('.rate-row'), v = Number(t.dataset.v);
    RV.items[Number(row.dataset.i)].stars = v;
    [].forEach.call(row.querySelectorAll('[data-act="star"]'), function (b) { b.classList.toggle('on', Number(b.dataset.v) <= v); });
  }
  function sendRate() {
    var ratings = RV.items.map(function (x, i) {
      var c = document.querySelector('[data-rc="' + i + '"]');
      return { item: x.item, stars: x.stars, comment: c ? c.value : '' };
    }).filter(function (x) { return x.stars > 0; });
    if (!ratings.length) return toast('Tap the stars to rate at least one item.', true);
    var btn = $('rv-send');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    apiPost({ action: 'review', orderId: RV.id, phone: RV.phone, ratings: ratings }).then(function (r) {
      if (!r.ok) throw new Error(r.error);
      skipAsk(RV.id);
      showSheet('<div class="done-top"><div class="tick">✓</div><h2>Thank you! 🌿</h2><div class="oid">Your review helps other families choose.</div></div>' +
        '<div class="actions"><button class="btn gold big wide" data-act="close">Back to shop</button></div>');
      refresh();
      if (VIEW === 'orders' && MO.phone) loadMyOrders(true);
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = 'Submit review';
      toast((e && e.message) || 'Could not send. Check your internet.', true);
    });
  }

  /** Returning customer with an unrated completed order: a small reminder on the shop page. */
  function skipAsk(id) {
    var s = load('sf_rv_skip', []);
    if (s.indexOf(id) < 0) { s.push(id); store('sf_rv_skip', s.slice(-30)); }
    var el = $('reviewAsk');
    if (el && el.dataset.id === id) el.innerHTML = '';
  }
  function checkReviewAsk() {
    var ph = phone10(ME.phone);
    if (!ph || !$('reviewAsk')) return;
    apiGet({ api: 'orders', phone: ph }).then(function (r) {
      if (!r.ok) return;
      var skip = load('sf_rv_skip', []);
      var o = r.data.orders.filter(function (x) { return x.review && x.review.items && !x.review.rated && skip.indexOf(x.id) < 0; })[0];
      var el = $('reviewAsk');
      if (!o) { el.innerHTML = ''; return; }
      var names = o.items.map(function (i) { return i.item; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
      el.dataset.id = o.id;
      el.innerHTML = '<div class="rv-ask"><span>⭐ How was your order from ' + fmtD(o.date) + ' (' + esc(names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '')) + ')?</span>' +
        '<button class="btn gold" data-act="rate" data-id="' + esc(o.id) + '">Rate it</button>' +
        '<button class="x" data-act="rateSkip" data-id="' + esc(o.id) + '" aria-label="Not now">×</button></div>';
    }).catch(function () { /* just skip the reminder */ });
  }

  // ---------- routing ----------
  function route() {
    var h = location.hash;
    var rate = /^#review-(.+)$/.exec(h);
    VIEW = h === '#orders' ? 'orders' : h === '#done' ? 'done' : 'shop';
    ['shop', 'orders', 'done'].forEach(function (v) { $('view-' + v).classList.toggle('on', v === VIEW); });
    if (sheetMode) closeSheet();
    if (VIEW === 'orders') showOrders();
    if (VIEW === 'done') renderDone();
    if (rate) {
      // Open the review form over the shop, and drop the #review link so a reload doesn't reopen it.
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* old browser */ }
      openRate(decodeURIComponent(rate[1]));
    }
    updateBasketBar();
    window.scrollTo(0, 0);
  }

  // ---------- events ----------
  // Phone side menu with the category links.
  function showNav(open) {
    document.body.classList.toggle('nav-open', open);
    $('menuBtn').setAttribute('aria-expanded', String(open));
  }
  $('menuBtn').addEventListener('click', function () { showNav(!document.body.classList.contains('nav-open')); });
  $('navShade').addEventListener('click', function () { showNav(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') showNav(false); });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-cat],[data-fv],[data-slide]');
    if (t && t.dataset.slide) { showSlide(Number(t.dataset.slide)); return; }
    if (!t) {
      if (e.target === $('sheetWrap')) closeSheet();
      return;
    }
    if (t.dataset.cat) {
      showNav(false);
      FILTER = t.dataset.cat;
      if (VIEW !== 'shop') location.hash = '';
      if (CAT) renderShop();
      if (t.dataset.promo || t.classList.contains('gold')) $('grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (t.dataset.fv) {
      var tg = t.parentNode.dataset.tg;
      if (tg === 'PAY') {
        FORM.pay = t.dataset.fv;
        $('bk-payinfo').textContent = payInfoTxt();
        if (!$('placeBtn').disabled) $('placeBtn').textContent = placeLabel();
      } else {
        (tg === 'PRE' ? PRE : FORM).fulfilment = t.dataset.fv;
      }
      [].forEach.call(t.parentNode.children, function (b) { b.classList.toggle('on', b === t); });
      return;
    }
    var act = t.dataset.act, holder = t.closest('[data-key]'), key = holder && holder.dataset.key;
    if (act === 'add') addPack(key);
    else if (act === 'basket') openBasket();
    else if (act === 'inc') { var a = itemByKey(key); if (a) setQty(key, (CART[key] || 0) + basketStep(a)); }
    else if (act === 'dec') { var b = itemByKey(key); if (b) setQty(key, (CART[key] || 0) - basketStep(b)); }
    else if (act === 'close') closeSheet();
    else if (act === 'place') placeOrder();
    else if (act === 'pre') openPre();
    else if (act === 'pinc') preKg(0.5);
    else if (act === 'pdec') preKg(-0.5);
    else if (act === 'preSubmit') submitPre();
    else if (act === 'cancelOrder') cancelOrder(t.dataset.id, Number(t.dataset.paid) || 0);
    else if (act === 'cancelPre') cancelPre(t.dataset.id);
    else if (act === 'reviews') openReviews(key);
    else if (act === 'rate') openRate(t.dataset.id);
    else if (act === 'ratePhone') {
      var rp = phone10($('rv-phone').value);
      if (!rp) return toast('Please enter your 10-digit phone number.', true);
      openRate(t.dataset.id, rp);
    }
    else if (act === 'star') pickStar(t);
    else if (act === 'rateSend') sendRate();
    else if (act === 'rateSkip') skipAsk(t.dataset.id);
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.act === 'pack') {
      var card = t.closest('[data-key]');
      PACK[card.dataset.key] = Number(t.value);
      t.blur();
      renderGrid();
      return;
    }
    if (t.dataset && t.dataset.act === 'qty') {
      var holder = t.closest('[data-key]');
      t.blur();
      if (holder) setQty(holder.dataset.key, Number(t.value) || 0);
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sheetMode) closeSheet();
    if (e.key === 'Enter' && e.target.id === 'mo-phone') loadMyOrders(false);
  });
  $('openBasket').addEventListener('click', openBasket);
  $('mo-go').addEventListener('click', function () { loadMyOrders(false); });
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });

  // ---------- start ----------
  if (!connected()) {
    $('grid').innerHTML = '<div class="empty">The shop isn\'t connected yet. (Owner: paste the Apps Script URL into config.js.)</div>';
  }
  route();
  refresh();
  if (connected()) checkReviewAsk();
  setInterval(function () {
    if (document.hidden) return;
    refresh();
    if (VIEW === 'orders' && MO.phone) loadMyOrders(true);
    if (VIEW === 'done') pollDone();
  }, POLL_MS);
  setInterval(tick, 1000);
})();
