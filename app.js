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
  var CATS = [['all', 'All', '🧺'], ['Veggies', 'Veggies', '🥬'], ['Flowers', 'Flowers', '🌼'], ['Eggs', 'Eggs', '🥚'], [CHICKEN, 'Chicken', '🐓']];
  var EMOJI = { 'Veggies': '🥬', 'Flowers': '🌼', 'Eggs': '🥚', 'Country Chicken': '🐓' };
  var POLL_MS = 5000;

  var CAT = null;                 // catalog from the server
  var CART = load('sf_cart', {}); // item key -> qty
  var ME = load('sf_me', {});     // phone, name, flat, apartment
  var FILTER = 'all';
  var VIEW = 'shop';
  var LAST = load('sf_last', null);
  var lastOk = 0, fetching = false, lastSig = '', gridDirty = false;
  var sheetMode = '';
  var FORM = { fulfilment: 'Pickup', notes: '' };
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
    var sig = JSON.stringify([d.items, d.chicken, d.shop.afterCutoff]);
    if (sig !== lastSig) { lastSig = sig; renderShop(); }
    updateBasketBar();
    if (sheetMode === 'basket') renderBasketLines();
  }

  /** Someone else bought the last of an item: shrink the basket to what's left. */
  function clampCart(notify) {
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
    var s = CAT.shop, c = CAT.chicken;
    $('notice').innerHTML = s.afterCutoff
      ? '<div class="note">🌙 It\'s after ' + hourTxt(s.cutoffHour) + '. Orders placed now will be packed tomorrow morning.</div>' : '';
    var chick = CAT.items.filter(function (i) { return i.category === CHICKEN; });
    var chickLeft = chick.reduce(function (a, i) { return a + i.left; }, 0);
    $('chickenCard').innerHTML = c.online && chick.length
      ? '<div class="chick"><div class="em">🐓</div><div><b>' + (s.isSunday ? 'Country chicken is here today!' : 'Pre-book country chicken for ' + fmtD(c.sunday)) +
        '</b><span>' + (chickLeft > 0 ? q(chickLeft) + ' kg left · sold in 1 kg and ½ kg · pick up or delivery on Sunday' : 'All booked for this week. See you next week!') +
        '</span></div>' + (chickLeft > 0 ? '<button class="btn gold" data-cat="' + CHICKEN + '">Book</button>' : '') + '</div>' : '';

    var present = {};
    CAT.items.forEach(function (i) { present[i.category] = true; });
    if (FILTER !== 'all' && !present[FILTER]) FILTER = 'all';
    $('cats').innerHTML = CATS.filter(function (x) { return x[0] === 'all' || present[x[0]]; }).map(function (x) {
      return '<button class="cat' + (FILTER === x[0] ? ' on' : '') + '" data-cat="' + esc(x[0]) + '">' + x[2] + ' ' + x[1] + '</button>';
    }).join('');
    renderGrid();
  }

  function renderGrid() {
    // Don't yank the field away while someone is typing a quantity.
    var a = document.activeElement;
    if (a && a.tagName === 'INPUT' && $('grid').contains(a)) { gridDirty = true; return; }
    gridDirty = false;
    var items = CAT.items.filter(function (i) { return FILTER === 'all' || i.category === FILTER; });
    if (!items.length) {
      $('grid').innerHTML = '<div class="empty">Nothing in stock right now. Please check back soon 🌱</div>';
      return;
    }
    var h = '', lastCat = '';
    items.forEach(function (it) {
      if (FILTER === 'all' && it.category !== lastCat) {
        lastCat = it.category;
        h += '<div class="sec-title">' + EMOJI[it.category] + ' ' + esc(it.category) + '</div>';
      }
      h += itemCard(it);
    });
    $('grid').innerHTML = h;
  }

  function isLow(it) { return it.left > 0 && it.left <= (it.unit === 'kg' ? 2 : 5); }

  function itemCard(it) {
    var sold = it.left <= 0, inCart = CART[it.key] || 0, low = isLow(it);
    var leftTxt = sold ? 'Sold out' : (low ? 'Only ' : '') + q(it.left) + ' ' + unitTxt(it.unit, it.left) + ' left';
    return '<div class="item' + (sold ? ' sold' : '') + '" data-key="' + esc(it.key) + '">' +
      '<div class="ph ' + catCls(it.category) + '"><span class="em">' + (EMOJI[it.category] || '🧺') + '</span>' +
      (it.photo ? '<img src="' + esc(it.photo) + '" alt="' + esc(it.item) + '" loading="lazy" onerror="this.remove()">' : '') +
      '<span class="left' + (sold ? ' out' : low ? ' low' : '') + '">' + leftTxt + '</span></div>' +
      '<div class="info"><div><div class="name">' + esc(it.item) + '</div><div class="price"><b>' + rs(it.price) + '</b> / ' +
      (it.unit === 'pcs' ? 'piece' : it.unit) + '</div>' +
      (it.category === CHICKEN && CAT.chicken && !CAT.shop.isSunday ? '<div class="price">🗓 Arrives ' + fmtD(CAT.chicken.sunday) + '</div>' : '') + '</div>' +
      (sold ? '<button class="btn add" disabled>Sold out</button>'
        : inCart ? stepper(it, inCart, false) : '<button class="btn green add" data-act="add">Add</button>') +
      '</div></div>';
  }

  function stepper(it, qty, light) {
    return '<div class="stepper' + (light ? ' light' : '') + '"><button data-act="dec" aria-label="Less">−</button>' +
      '<input type="number" inputmode="decimal" step="' + it.step + '" min="0" value="' + qty + '" data-act="qty" aria-label="Quantity">' +
      '<span class="u">' + esc(it.unit) + '</span><button data-act="inc" aria-label="More">+</button></div>';
  }

  function firstQty(it) {
    var want = it.category === CHICKEN ? 1 : it.unit === 'kg' ? 0.5 : 1;
    return Math.min(want, floorStep(it.left, it.step)) || it.step;
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

  function openBasket() {
    sheetMode = 'basket';
    showSheet('<div class="sheet-head"><h2>Your basket</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
      '<div class="card" id="bk-lines"></div>' +
      '<div class="payinfo">💵 No payment now. Pay by Cash or PhonePe when you receive your order.</div>' +
      '<div class="card"><h3 style="margin-bottom:10px">Your details</h3>' + custFields('bk') +
      '<label>Pickup or delivery?</label>' + toggle('FORM') +
      '<div class="field" style="margin:0"><label for="bk-notes">Note for us (optional)</label><input id="bk-notes" maxlength="200" value="' + esc(FORM.notes) + '" placeholder="e.g. please call before coming"></div></div>' +
      '<div id="bk-err"></div><button class="btn green big wide" id="placeBtn" data-act="place">Place order</button>');
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
        rs(it.price) + ' / ' + (it.unit === 'pcs' ? 'piece' : it.unit) + ' · ' + q(it.left) + ' left</div></div>' +
        stepper(it, CART[k], true) + '<div class="amt">' + rs(r2(CART[k] * it.price)) + '</div></div>';
    }).join('') + '<div class="total"><span>Total</span><span>' + rs(cartTotal()) + '</span></div>';
    $('placeBtn').textContent = 'Place order · ' + rs(cartTotal());
  }

  function placeOrder() {
    var c = readCust('bk');
    if (!c) return;
    FORM.notes = $('bk-notes').value.trim();
    var keys = cartKeys();
    if (!keys.length) return;
    var btn = $('placeBtn');
    if (btn.disabled) return;
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
      '<div class="payinfo">💵 Pay by Cash or PhonePe when you receive it.</div>' +
      '<div class="actions">' + contactButtons('Hi! I just placed order ' + o.id + ' (' + rs(o.total) + ') on the website.') +
      '<a class="btn ghost big wide" href="' + payUrl(o) + '">Pay now by PhonePe / UPI (optional)</a>' +
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
      h += '<div class="card"><div class="ord-head"><div><b>' + fmtD(o.date) + ' · ' + esc(o.time) + '</b><div class="ord-items">' +
        esc(o.items.map(function (i) { return i.item + ' ' + q(i.qty) + ' ' + unitTxt(i.unit, i.qty); }).join(', ')) + '</div></div>' +
        '<div style="text-align:right"><b>' + rs(o.total) + '</b><br>' +
        (o.status === 'Cancelled' ? '<span class="chip cancel">Cancelled</span>' : unpaid ? '<span class="chip pending">To pay</span>' : '<span class="chip">Paid · ' + esc(o.payment) + '</span>') +
        '</div></div>' + (o.type === 'Online' ? track(o) : '') +
        ((unpaid || open) ? '<div class="actions" style="margin-top:10px">' +
          (unpaid ? '<a class="btn gold" href="' + payUrl(o) + '">Pay ' + rs(o.total) + ' by PhonePe / UPI</a>' : '') +
          (open ? '<button class="btn danger" data-act="cancelOrder" data-id="' + esc(o.id) + '">Cancel order</button>' : '') + '</div>' : '') +
        '</div>';
    });
    h += '<div class="actions" style="margin-top:4px">' + contactButtons('Hi! I have a question about my order.') + '</div>';
    $('mo-list').innerHTML = h;
  }
  function cancelOrder(id) {
    if (!confirm('Cancel this order?')) return;
    apiPost({ action: 'cancelOrder', orderId: id, phone: MO.phone }).then(function (r) {
      if (!r.ok) return toast(r.error, true);
      toast('Order cancelled.');
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

  // ---------- routing ----------
  function route() {
    var h = location.hash;
    VIEW = h === '#orders' ? 'orders' : h === '#done' ? 'done' : 'shop';
    ['shop', 'orders', 'done'].forEach(function (v) { $('view-' + v).classList.toggle('on', v === VIEW); });
    if (sheetMode) closeSheet();
    if (VIEW === 'orders') showOrders();
    if (VIEW === 'done') renderDone();
    updateBasketBar();
    window.scrollTo(0, 0);
  }

  // ---------- events ----------
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-cat],[data-fv]');
    if (!t) {
      if (e.target === $('sheetWrap')) closeSheet();
      return;
    }
    if (t.dataset.cat) {
      FILTER = t.dataset.cat;
      renderShop();
      if (t.classList.contains('gold')) $('cats').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (t.dataset.fv) {
      var f = t.parentNode.dataset.tg === 'PRE' ? PRE : FORM;
      f.fulfilment = t.dataset.fv;
      [].forEach.call(t.parentNode.children, function (b) { b.classList.toggle('on', b === t); });
      return;
    }
    var act = t.dataset.act, holder = t.closest('[data-key]'), key = holder && holder.dataset.key;
    if (act === 'add') { var it = itemByKey(key); if (it) setQty(key, firstQty(it)); }
    else if (act === 'inc') { var a = itemByKey(key); if (a) setQty(key, (CART[key] || 0) + a.step); }
    else if (act === 'dec') { var b = itemByKey(key); if (b) setQty(key, (CART[key] || 0) - b.step); }
    else if (act === 'close') closeSheet();
    else if (act === 'place') placeOrder();
    else if (act === 'pre') openPre();
    else if (act === 'pinc') preKg(0.5);
    else if (act === 'pdec') preKg(-0.5);
    else if (act === 'preSubmit') submitPre();
    else if (act === 'cancelOrder') cancelOrder(t.dataset.id);
    else if (act === 'cancelPre') cancelPre(t.dataset.id);
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
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
  setInterval(function () {
    if (document.hidden) return;
    refresh();
    if (VIEW === 'orders' && MO.phone) loadMyOrders(true);
    if (VIEW === 'done') pollDone();
  }, POLL_MS);
  setInterval(tick, 1000);
})();
