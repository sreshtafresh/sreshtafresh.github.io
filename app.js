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
  var SEARCH = '';                // text typed in the header search
  var VIEW = 'shop';
  var LAST = load('sf_last', null);
  var lastOk = 0, fetching = false, lastSig = '', gridDirty = false;
  var PAYING = false;   // our own items are on hold while the Razorpay window is open
  var sheetMode = '';
  var FORM = { fulfilment: 'Pickup', notes: '', pay: 'Online', coupon: null };   // coupon: {code, pct} once checked
  var PRE = { kg: 1, fulfilment: 'Pickup', notes: '' };
  var MO = { phone: '', data: null, busy: false };

  // ---------- editable content (text, pictures, colours) published from the website's edit mode ----------
  // SITE = { text: {key: html}, img: {key: url}, color: {key: colour}, order: {…} }. Keys match data-edit="…" /
  // data-color="…" in index.html; anything not in SITE keeps the page's built-in default (remembered in EDIT_DEF).
  var SITE = load('sf_site', {});
  var EDITING = false;   // true while the edit mode is open (step 2), so a poll doesn't overwrite unsaved changes
  var EDIT_DEF = {};
  [].forEach.call(document.querySelectorAll('[data-edit]'), function (el) { EDIT_DEF[el.dataset.edit] = el.innerHTML; });
  function siteText(key, dflt) { return SITE.text && SITE.text[key] != null ? SITE.text[key] : dflt; }
  function siteImg(key, dflt) { return (SITE.img && SITE.img[key]) || dflt; }
  function siteColor(key) { return (SITE.color && SITE.color[key]) || ''; }
  /** The saved tile order for a grid, if it's still exactly the same set of tiles; otherwise the default order. */
  function siteOrder(key, dflt) {
    var o = SITE.order && SITE.order[key];
    return o && o.length === dflt.length && dflt.every(function (x) { return o.indexOf(x) >= 0; }) ? o.slice() : dflt.slice();
  }
  var BENTO_TILES = ['chicken', 'eggs', 'veggies', 'flowers'], BENTO_SLOTS = ['bt-a', 'bt-b', 'bt-c', 'bt-d'];
  var MOSAIC_TILES = ['veg1', 'photo1', 'seed', 'veg2', 'veg3', 'soil', 'care', 'veg4', 'veg5', 'photo2', 'veg6', 'harvest'];
  var MOSAIC_SLOTS = ['mz-a', 'mz-b', 'mz-c', 'mz-d', 'mz-e', 'mz-f', 'mz-g', 'mz-h', 'mz-i', 'mz-j', 'mz-k', 'mz-l'];
  function applySite(site) {
    SITE = site || {};
    if (!EDITING) store('sf_site', SITE);   // next visit shows it straight away (never an unpublished draft)
    [].forEach.call(document.querySelectorAll('[data-edit]'), function (el) {
      var html = siteText(el.dataset.edit, EDIT_DEF[el.dataset.edit]);
      if (html != null && el.innerHTML !== html) el.innerHTML = html;   // the server only lets simple emphasis through
    });
    [].forEach.call(document.querySelectorAll('[data-color]'), function (el) { el.style.background = siteColor('section.' + el.dataset.color); });
    var hero = siteImg('hero.bg', '');
    if (hero) $('hero').style.setProperty('--hero-img', 'url("' + hero.replace(/"/g, '%22') + '")');
    else $('hero').style.removeProperty('--hero-img');
  }
  applySite(SITE);

  // GSAP (loaded from the CDN in index.html). Everything still works, with the plain CSS animations, without it.
  var G = window.gsap || null;
  var CALM = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (G) G.registerPlugin.apply(G, [window.Flip, window.SplitText, window.MotionPathPlugin].filter(Boolean));
  var heroIntro = false;   // the landing cards play their entrance once

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
    if (!EDITING && JSON.stringify(d.site || {}) !== JSON.stringify(SITE)) applySite(d.site || {});   // edits published elsewhere
    var sig = JSON.stringify([d.items, d.chicken, d.shop.afterCutoff, d.banners, SITE]);
    var typing = EDITING && document.activeElement && document.activeElement.isContentEditable;   // don't redraw under the cursor
    if (sig !== lastSig && !typing) { lastSig = sig; renderShop(); }
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
    if (chickenPending()) present[CHICKEN] = true;   // reservable even before this week's stock is entered
    if (FILTER !== 'all' && !present[FILTER]) FILTER = 'all';
    var cats = CATS.filter(function (x) { return x[0] === 'all' || present[x[0]]; });
    if ($('cats')) {
      $('cats').innerHTML = cats.map(function (x) {
        return '<button class="cat' + (FILTER === x[0] ? ' on' : '') + '" data-cat="' + esc(x[0]) + '">' + x[1] + '</button>';
      }).join('');
    }
    // The ☰ menu: categories (with "All" to get back), then the other pages.
    $('nav').innerHTML = '<div class="nav-title">Shop by category</div>' + cats.map(function (x) {
      return '<button class="' + (FILTER === x[0] ? 'on' : '') + '" data-cat="' + esc(x[0]) + '">' + x[1] + '</button>';
    }).join('') +
      '<div class="nav-title more">More</div>' +
      '<a href="#subscribe" data-nav="subscribe">Weekly plans</a>' +
      '<a href="#orders">My orders</a>';
    renderPromo();
    renderBento();
    renderGrid();
    renderSubs();
  }

  // ---------- offer strip (between the landing and "From our fields") ----------
  // Shows the staff app's active banners: kicker, title, highlight (the big offer), text, photo, button, link.
  var PROMO = { idx: 0, timer: null, sig: '', paused: false };
  function promoSlides() {
    var cp = CAT.shop.coupon;
    // The strip shows only the coupon (banners from the staff app are not used on the website); no coupon, no strip.
    if (cp) return [{
      coupon: true, kicker: 'Launch offer', title: 'Use code ' + cp.code + ' at checkout', highlight: cp.pct + '% OFF',
      text: 'On your whole basket: veggies, flowers, country eggs and country chicken.', button: 'Shop now', link: 'all', photo: ''
    }];
    return [];
  }
  /** Banner text, with the coupon code (if mentioned) picked out like a tag. */
  function offerText(t) {
    var cp = CAT.shop.coupon, h = esc(t);
    if (!cp) return h;
    var at = h.toUpperCase().indexOf(cp.code);
    return at < 0 ? h : h.slice(0, at) + '<b>' + h.slice(at, at + cp.code.length) + '</b>' + h.slice(at + cp.code.length);
  }
  function renderPromo() {
    var box = $('offer');
    if (!box) return;
    var slides = promoSlides();
    var sig = JSON.stringify(slides);
    if (sig === PROMO.sig) return;
    PROMO.sig = sig;
    $('offerWrap').hidden = !slides.length;
    if (PROMO.idx >= slides.length) PROMO.idx = 0;
    box.innerHTML = slides.map(function (b, i) {
      return '<div class="of-slide' + (i === PROMO.idx ? ' on' : '') + (b.photo ? ' has-ph' : '') + '">' +
        '<div class="of-txt">' +
        (b.kicker ? '<div class="of-kicker">' + esc(b.kicker) + '</div>' : '') +
        (b.title ? '<h3>' + offerText(b.title) + '</h3>' : '') +
        (b.text ? '<p>' + offerText(b.text) + '</p>' : '') + '</div>' +
        (b.highlight ? '<div class="of-big' + (b.highlight.length > 9 ? ' long' : '') + '">' + esc(b.highlight) + '</div>' : '') +
        (b.photo ? '<div class="of-ph"><img src="' + esc(b.photo) + '" alt="" loading="lazy" onerror="this.parentNode.remove()"></div>' : '') +
        '<button class="btn of-go" data-promo="1" data-cat="' + esc(b.link || 'all') + '">' + esc(b.button || 'Shop now') + ' →</button>' +
        '</div>';
    }).join('') +
      (slides.length > 1 ? '<div class="of-dots">' + slides.map(function (b, i) {
        return '<button data-slide="' + i + '" class="' + (i === PROMO.idx ? 'on' : '') + '" aria-label="Offer ' + (i + 1) + '"></button>';
      }).join('') + '</div>' : '');
    clearInterval(PROMO.timer);
    if (slides.length > 1) PROMO.timer = setInterval(function () { if (!PROMO.paused && !document.hidden) showSlide(PROMO.idx + 1); }, 6000);
  }
  function showSlide(i) {
    var box = $('offer');
    var s = box.querySelectorAll('.of-slide'), d = box.querySelectorAll('.of-dots button');
    if (!s.length) return;
    PROMO.idx = (i + s.length) % s.length;
    [].forEach.call(s, function (el, k) { el.classList.toggle('on', k === PROMO.idx); });
    [].forEach.call(d, function (el, k) { el.classList.toggle('on', k === PROMO.idx); });
  }
  (function promoGestures() {
    var el = $('offer'), x0 = null;
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

  // ---------- shop by category: one big tile and three smaller ones ----------
  /** The category's in-stock items, ones with a photo first. */
  function catItems(cat) {
    return CAT.items.filter(function (i) { return i.category === cat && i.left > 0; })
      .sort(function (a, b) { return (b.photo ? 1 : 0) - (a.photo ? 1 : 0); });
  }
  /** o.cut: a cut-out (transparent PNG) in images/, shown popping out of the tile; if it's missing, the photo shows instead. */
  function bentoTile(cls, o) {
    var name = o.name, bg = siteColor('bento.' + name);
    o.cut = siteImg('bento.' + name, o.cut);   // a picture published from edit mode replaces the default cut-out
    o.title = siteText('bento.' + name + '.title', o.title);
    o.sub = siteText('bento.' + name + '.sub', o.sub);
    return '<div class="bt ' + cls + (o.photo ? ' has-ph' : '') + (o.cut ? ' has-cut' : '') + (o.off ? ' off' : '') + '" data-tile="' + name + '"' +
      (bg ? ' style="background:' + esc(bg) + '"' : '') + '>' +
      (o.photo ? '<div class="bt-ph"><img src="' + esc(o.photo) + '" alt="" loading="lazy" onerror="this.parentNode.remove()"></div>' : '<div class="bt-em">' + o.em + '</div>') +
      // the cut-out sits in its own frame, so a tile can zoom into part of a picture without spilling over the text
      (o.cut ? '<div class="bt-cutbox"><img class="bt-cut" src="' + esc(o.cut) + '" alt="" loading="lazy" onerror="this.closest(\'.bt\').classList.remove(\'has-cut\'); this.remove()"></div>' : '') +
      '<div class="bt-txt">' + (o.tag ? '<span class="bt-tag">' + esc(o.tag) + '</span>' : '') +
      '<h3 data-ek="bento.' + name + '.title">' + esc(o.title) + '</h3>' + (o.sub ? '<p data-ek="bento.' + name + '.sub">' + esc(o.sub) + '</p>' : '') +
      (o.price ? '<div class="bt-price">' + o.price + '</div>' : '') +
      (o.btn ? '<button class="bt-go"' + o.btn + '</button>' : '') + '</div></div>';
  }
  function renderBento() {
    var box = $('bento');
    if (!box) return;
    var ch = catItems(CHICKEN)[0], c = CAT.chicken, eggs = catItems('Eggs'), veg = catItems('Veggies'), flo = catItems('Flowers');
    var chPrice = ch ? ch.price : c && c.lastPrice;
    var pre = chickenPending(), chOpen = ch || (pre && c.preorderOpen);
    var egg = eggs[0], eggPack = egg && packs(egg).indexOf(12) >= 0 ? 12 : egg && chosenPack(egg);
    var count = function (n, one, many) { return n + ' ' + (n === 1 ? one : many) + ' in today'; };
    var T = {};   // the four tiles by name; the saved order (edit mode) decides which slot each one fills
    T.chicken = { name: 'chicken',
      photo: (ch && ch.photo) || (c && c.photo), em: '🐓', cut: 'images/bento-chicken.png',
      tag: c && c.sunday && !CAT.shop.isSunday ? 'Pre-book for ' + fmtD(c.sunday) : 'Fresh this Sunday',
      title: 'Country Chicken', sub: 'From our farm, sold by weight. Pay when you receive it.',
      price: chPrice ? '<b>' + rs(chPrice) + '</b><span>/kg</span>' : '',
      btn: ch ? ' data-cat="' + esc(CHICKEN) + '" data-promo="1">Shop now →' : chOpen ? ' data-act="pre">Reserve now →' : (c ? ' disabled>Opens ' + esc(fmtD(c.opensOn)) : '')
    };
    T.eggs = { name: 'eggs',
      photo: egg && egg.photo, em: '🥚', off: !egg, cut: 'images/bento-eggs.png', tag: egg ? '' : 'Back soon',
      title: 'Country Eggs', sub: egg ? 'From our own hens' : 'Sold out for today',
      price: egg ? '<b>' + rs(r2(egg.price * eggPack)) + '</b><span>' + esc(perPack(egg, eggPack)) + '</span>' : '',
      btn: egg ? ' data-cat="Eggs" data-promo="1">Shop now →' : ''
    };
    T.veggies = { name: 'veggies',
      photo: veg[0] && veg[0].photo, em: '🥬', off: !veg.length, cut: 'images/bento-veggies.png',
      title: 'Veggies', sub: veg.length ? count(veg.length, 'vegetable', 'vegetables') : 'Back soon',
      btn: veg.length ? ' data-cat="Veggies" data-promo="1">Shop →' : ''
    };
    T.flowers = { name: 'flowers',
      photo: flo[0] && flo[0].photo, em: '🌼', off: !flo.length, cut: 'images/bento-flowers.png',
      title: 'Flowers', sub: flo.length ? count(flo.length, 'kind', 'kinds') : 'Back soon',
      btn: flo.length ? ' data-cat="Flowers" data-promo="1">Shop →' : ''
    };
    var html = siteOrder('bento', BENTO_TILES).map(function (n, i) { return bentoTile(BENTO_SLOTS[i], T[n]); }).join('');
    if (BENTO_SIG !== html) { BENTO_SIG = html; box.innerHTML = html; }   // stock polls: redraw only when something changed
  }
  var BENTO_SIG = '';

  function renderGrid() {
    // Don't yank the field away while someone is typing a quantity.
    var a = document.activeElement;
    if (a && /INPUT|SELECT/.test(a.tagName) && $('grid').contains(a)) { gridDirty = true; return; }
    gridDirty = false;
    var s = SEARCH.trim().toLowerCase();
    var items = CAT.items.filter(function (i) {
      return (FILTER === 'all' || i.category === FILTER) && (!s || (i.item + ' ' + i.category).toLowerCase().indexOf(s) >= 0);
    });
    if (REVEAL) [].forEach.call($('grid').querySelectorAll('.item'), function (el) { REVEAL.unobserve(el); });
    var preChick = chickenPending() && (FILTER === 'all' || FILTER === CHICKEN) && (!s || CHICKEN.toLowerCase().indexOf(s) >= 0);
    $('grid').innerHTML = items.length || preChick ? items.map(itemCard).join('') + (preChick ? chickenPreCard() : '')
      : s ? '<div class="empty">Nothing matches “' + esc(SEARCH.trim()) + '”. Try another name 🔍</div>'
      : '<div class="empty">Nothing in stock right now. Please check back soon 🌱</div>';
    [].forEach.call($('grid').querySelectorAll('.item'), function (el, i) { watchReveal(el, (i % 4) * 80); });
    renderHero();
    renderFarmItems();
    renderMosaic();
    if (EDITING) decorate();   // edit mode: put the picture / colour / move controls back on redrawn tiles
  }

  /** After a filter change: cards that stay glide to their new spots, new ones fade and grow in. */
  function shuffleGrid(state) {
    var grid = $('grid');
    grid.classList.add('flipping');   // the CSS glide transitions would fight GSAP while it moves the cards
    Flip.from(state, {
      targets: '#grid .item', duration: .6, ease: 'power2.inOut', scale: true,
      onEnter: function (els) { return G.fromTo(els, { opacity: 0, scale: .85 }, { opacity: 1, scale: 1, duration: .45, delay: .15, ease: 'power2.out', clearProps: 'opacity,transform' }); },
      onComplete: function () { grid.classList.remove('flipping'); }
    });
  }

  // ---------- weekly plans: eggs & chicken, paid in full upfront (the shop re-checks the price) ----------
  var SUB_WEEKS = [4, 8, 12], SUB_OFF = { 4: 3, 8: 5, 12: 7 };   // % off for paying for all weeks upfront
  var SUB_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var SUB = { eggs: { qty: 12, day: 'Sun', weeks: 4 }, chicken: { qty: 1, day: 'Sun', weeks: 4 } };

  function ymdAdd(ymd, n) {
    var p = ymd.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
    return d.toISOString().slice(0, 10);
  }
  function ymdDow(ymd) { var p = ymd.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); }
  /** First delivery on the chosen weekday, from tomorrow (or the day after, if it's past the order cutoff). */
  function firstDelivery(day) {
    var s = CAT.shop, want = (SUB_DAYS.indexOf(day) + 1) % 7, d = ymdAdd(s.today, s.afterCutoff ? 2 : 1);
    while (ymdDow(d) !== want) d = ymdAdd(d, 1);
    return d;
  }
  /** Price per egg / per kg chicken, from what's listed now (locked in when they subscribe). */
  function subUnit(kind) {
    var cat = kind === 'eggs' ? 'Eggs' : CHICKEN;
    var it = CAT.items.filter(function (i) { return i.category === cat; })[0];
    return it ? it.price : kind === 'chicken' ? (CAT.chicken && CAT.chicken.lastPrice) || 0 : 0;
  }
  function subQuote(kind) {
    var s = SUB[kind], weekly = r2(subUnit(kind) * s.qty), total = r2(weekly * s.weeks);
    var pay = Math.round(total * (100 - SUB_OFF[s.weeks]) / 100);
    var first = firstDelivery(kind === 'eggs' ? s.day : 'Sun');
    return { weekly: weekly, total: total, pay: pay, save: r2(total - pay), first: first, last: ymdAdd(first, 7 * (s.weeks - 1)) };
  }
  function subChips(kind, key, opts, label) {
    return '<div class="chips">' + opts.map(function (o) {
      return '<button type="button" data-sk="' + kind + '|' + key + '|' + o + '" class="' + (String(SUB[kind][key]) === String(o) ? 'on' : '') + '">' + label(o) + '</button>';
    }).join('') + '</div>';
  }
  function subCard(kind) {
    var egg = kind === 'eggs', s = SUB[kind], qt = subQuote(kind);
    return '<div class="sub-card">' +
      '<div class="sub-top"><span class="sub-ic">' + (egg ? '🥚' : '🐓') + '</span><div><h3>' + (egg ? 'Country eggs' : 'Country chicken') + '</h3>' +
      '<div class="sub-tag">' + (egg ? 'From our free-roaming hens, every week' : 'Farm-raised, delivered every Sunday') + '</div></div></div>' +
      '<div class="sub-lbl">Each week</div>' +
      subChips(kind, 'qty', egg ? [12, 30] : [0.5, 1, 1.5, 2, 3], function (v) { return egg ? (v === 30 ? '30 eggs · tray' : '12 eggs') : q(v) + ' kg'; }) +
      '<div class="sub-lbl">Delivery day</div>' +
      (egg ? subChips(kind, 'day', SUB_DAYS, String) : '<div class="sub-fixed">🗓️ Sunday, the day our chicken arrives</div>') +
      '<div class="sub-lbl">For how long</div>' +
      subChips(kind, 'weeks', SUB_WEEKS, function (w) { return w + ' weeks<small>save ' + SUB_OFF[w] + '%</small>'; }) +
      '<div class="sub-dates">📅 ' + fmtD(qt.first) + ' → ' + fmtD(qt.last) + ' · ' + s.weeks + ' deliveries</div>' +
      (qt.weekly ? '<div class="sub-sum"><div>' + rs(qt.weekly) + ' a week × ' + s.weeks + ' weeks<span>You save ' + rs(qt.save) + '</span></div>' +
          '<div class="sub-pay"><s>' + rs(qt.total) + '</s><b>' + rs(qt.pay) + '</b></div></div>' +
          '<button class="btn gold big wide" data-act="subGo" data-sub="' + kind + '">Subscribe &amp; pay ' + rs(qt.pay) + '</button>'
        : '<div class="sub-sum"><div>The price shows here once this week\'s ' + (egg ? 'eggs are' : 'chicken is') + ' listed.</div></div>') +
      '</div>';
  }
  function renderSubs() {
    if ($('subGrid') && CAT) $('subGrid').innerHTML = subCard('eggs') + subCard('chicken');
  }
  function openSubscribe(kind) {
    var s = SUB[kind], qt = subQuote(kind), egg = kind === 'eggs';
    sheetMode = 'sub';
    showSheet('<div class="sheet-head"><h2>' + (egg ? '🥚 Egg plan' : '🐓 Chicken plan') + '</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
      '<div class="card"><b>' + (egg ? (s.qty === 30 ? '30 eggs (tray)' : '12 eggs') : q(s.qty) + ' kg country chicken') + ' every ' + (egg ? s.day : 'Sun') + ', for ' + s.weeks + ' weeks</b>' +
      '<div class="hint" style="margin:4px 0 0">' + fmtD(qt.first) + ' to ' + fmtD(qt.last) + ' · price locked for the whole plan · paid in full now · pause up to 2 weeks (added at the end) · plans can\'t be cancelled once paid</div>' +
      '<div class="total"><span>Pay now</span><span>' + rs(qt.pay) + '</span></div></div>' +
      '<div class="card"><h3 style="margin-bottom:10px">Your details</h3>' + custFields('sb') +
      '<label>Pickup or delivery?</label>' + toggle('FORM') + '</div>' +
      '<button class="btn gold big wide" data-act="subPay" data-sub="' + kind + '">Pay ' + rs(qt.pay) + '</button>');
    bindCust('sb');
  }

  // ---------- weekly plan payment: the shop works out the price, Razorpay takes it, the shop checks it ----------
  var PLAN_REQ = { id: '', sig: '' };   // same request id on a retry, so the shop never creates the plan twice
  function payPlan(kind, btn) {
    var c = readCust('sb');
    if (!c || btn.disabled) return;
    if (!(CAT && CAT.shop.razorpay)) return toast('Online payment is not available right now. Please try again later.', true);
    var s = SUB[kind], sig = [kind, s.qty, s.day, s.weeks, c.phone, FORM.fulfilment].join('|');
    if (PLAN_REQ.sig !== sig) { PLAN_REQ.id = newReqId(); PLAN_REQ.sig = sig; }
    btn.disabled = true;
    btn.textContent = 'Opening secure payment…';
    var again = function (msg) { btn.disabled = false; btn.textContent = 'Pay ' + rs(subQuote(kind).pay); if (msg) toast(msg, true); };
    Promise.all([loadRazorpay(), apiPost({
      action: 'startPlan', reqId: PLAN_REQ.id, kind: kind, qty: s.qty, day: s.day, weeks: s.weeks,
      phone: c.phone, name: c.name, flat: c.flat, apartment: c.apartment, fulfilment: FORM.fulfilment
    })]).then(function (res) {
      var r = res[1];
      if (!r.ok) return again(r.error);
      var finished = false;
      var rz = new window.Razorpay({
        key: r.pay.keyId, amount: r.pay.amount, currency: 'INR', order_id: r.pay.rzpOrderId,
        name: shop().name || 'Sreshta Fresh', description: 'Weekly plan ' + r.pay.planId,
        prefill: { name: c.name, contact: '+91' + c.phone }, notes: { shop_plan: r.pay.planId }, theme: { color: '#015c30' },
        handler: function (resp) { finished = true; confirmPlan(r.pay, resp, 0); },
        modal: { confirm_close: true, ondismiss: function () { if (!finished) again('Payment not completed, so your plan hasn\'t started. You can try again.'); } }
      });
      rz.on('payment.failed', function (resp) {
        toast('Payment failed: ' + ((resp.error && resp.error.description) || 'please try again') + '. You can try again in the same window.', true);
      });
      rz.open();
    }).catch(function () { again('We couldn\'t reach the payment service. Check your internet and try again.'); });
  }
  function confirmPlan(pay, resp, attempt) {
    showSheet('<div class="done-top"><div class="tick">⏳</div><h2>Confirming your payment…</h2><div class="oid">Please don\'t close this page.</div></div>');
    sheetMode = 'info';
    apiPost({
      action: 'confirmPlan', planId: pay.planId, razorpay_payment_id: resp.razorpay_payment_id,
      razorpay_order_id: resp.razorpay_order_id, razorpay_signature: resp.razorpay_signature
    }).then(function (r) {
      if (!r.ok) return planUnconfirmed(pay, r.error);
      PLAN_REQ.sig = '';
      planActive(r.plan);
    }).catch(function () {   // no answer (connection dropped): ask again a few times
      if (attempt < 3) return setTimeout(function () { confirmPlan(pay, resp, attempt + 1); }, 2000);
      planUnconfirmed(pay, '');
    });
  }
  function planUnconfirmed(pay, why) {
    showSheet('<div class="done-top"><div class="tick">!</div><h2>Payment received, confirming</h2><div class="oid">Plan ' + esc(pay.planId) + '</div></div>' +
      '<div class="note">' + (why ? esc(why) + ' ' : '') + 'Please <b>don\'t pay again</b>. Your plan will show in <b>My orders</b> ' +
      'once the payment is confirmed with Razorpay. If it doesn\'t, contact us with the plan number above.</div>' +
      '<div class="actions" style="margin-top:14px">' + contactButtons('Hi! I paid for weekly plan ' + pay.planId + ' but it wasn\'t confirmed.') +
      '<a class="btn ghost wide" href="#orders">🧾 My orders</a></div>');
    sheetMode = 'info';
  }
  function planActive(p) {
    var egg = p.kind === 'eggs', what = egg ? (p.qty === 30 ? '30 eggs (tray)' : p.qty + ' eggs') : q(p.qty) + ' kg country chicken';
    showSheet('<div class="done-top"><div class="tick">✓</div><h2>Your plan is active!</h2><div class="oid">' + esc(p.id) + '</div></div>' +
      '<div class="card"><b>' + esc(what) + ' every ' + esc(p.day) + '</b>' +
      '<div class="hint" style="margin:6px 0 0">First delivery <b>' + fmtD(p.first) + '</b>, last <b>' + fmtD(p.last) + '</b> · ' + p.weeks + ' weeks · ' + esc(p.fulfilment) + '</div>' +
      '<div class="total"><span>Paid</span><span>' + rs(p.paid) + '</span></div></div>' +
      '<div class="payinfo">Each week\'s delivery is already paid for. You can pause up to 2 weeks from <b>My orders</b>; paused weeks are added at the end.</div>' +
      '<div class="actions"><a class="btn gold wide" href="#orders">🧾 See it in My orders</a><button class="btn ghost wide" data-act="close">Done</button></div>');
    sheetMode = 'info';
  }

  // ---------- chicken before this week's stock is entered: reserve instead of add ----------
  /** True when no chicken is listed yet but reservations can still be taken (or will open). */
  function chickenPending() {
    return !!(CAT && CAT.chicken && CAT.chicken.sunday) && !CAT.items.some(function (i) { return i.category === CHICKEN; });
  }
  function chickenPreInfo() {
    var c = CAT.chicken;
    return {
      name: c.item || 'Country Chicken', photo: c.photo || '', price: c.lastPrice || 0, open: !!c.preorderOpen,
      when: c.preorderOpen ? 'For ' + fmtD(c.sunday) : 'Opens ' + fmtD(c.opensOn) + ', ' + hourTxt(c.openHour)
    };
  }
  /** Small landing-page card */
  function heroChickenCard() {
    var c = chickenPreInfo();
    return '<div class="hc">' +
      '<div class="hc-ph Country-Chicken"><span class="em">🐓</span>' +
      (c.photo ? '<img src="' + esc(c.photo) + '" alt="' + esc(c.name) + '" loading="lazy" onerror="this.remove()">' : '') +
      '<span class="hc-off">Pre-book</span></div>' +
      '<div class="hc-body"><div class="hc-name">' + esc(c.name) + '</div>' +
      '<div class="hc-row"><span class="hc-price">' + (c.price ? '<b>' + rs(c.price) + '</b>' : '<b>By weight</b>') + '</span>' +
      '<button class="hc-add hc-res" data-act="pre"' + (c.open ? '' : ' disabled') + '>Reserve</button></div></div></div>';
  }
  /** Full shop card */
  function chickenPreCard() {
    var c = chickenPreInfo();
    return '<div class="item" data-flip-id="chicken-pre">' +
      '<div class="ph Country-Chicken"><span class="em">🐓</span>' +
      (c.photo ? '<img src="' + esc(c.photo) + '" alt="' + esc(c.name) + '" loading="lazy" onerror="this.remove()">' : '') +
      '<span class="badge">Pre-book</span></div>' +
      '<div class="info"><div class="kicker">' + esc(CHICKEN) + '</div>' +
      '<div class="name-row"><div class="name">' + esc(c.name) + '</div><div class="sub">' + esc(c.when) + '</div></div>' +
      '<div class="sub">Reserve now, sold by weight, pay when you receive it on Sunday.</div>' +
      '<div class="buy"><div class="price">' + (c.price ? '<b>' + rs(c.price) + '</b><span>/ kg</span>' : '<b>By weight</b>') + '</div>' +
      '<button class="btn gold" data-act="pre"' + (c.open ? '' : ' disabled') + '>' + (c.open ? 'Reserve' : 'Opens soon') + '</button></div>' +
      '</div></div>';
  }

  /** First-screen picks: up to 6 items in stock (CSS shows 4 on smaller screens).
   *  Country chicken first, then eggs; after that, items with photos, ratings and deals. */
  function heroPicks() {
    var FIRST = {};
    FIRST[CHICKEN] = 2; FIRST.Eggs = 1;
    return CAT.items.filter(function (i) { return i.left > 0 && packs(i).length; })
      .map(function (i, n) {
        var score = (i.photo ? 4 : 0) + (i.rating ? 2 : 0) + (i.mrp > i.price ? 1 : 0);
        return { it: i, first: FIRST[i.category] || 0, score: score, n: n };
      })
      .sort(function (a, b) { return b.first - a.first || b.score - a.score || a.n - b.n; })
      .slice(0, 6).map(function (x) { return x.it; });
  }
  function renderHero() {
    var box = $('heroItems');
    if (!box) return;
    var pre = chickenPending(), picks = heroPicks().slice(0, pre ? 5 : 6);   // the chicken reserve card takes the first spot
    box.innerHTML = (picks.length || pre ? '<div class="hero-grid">' + (pre ? heroChickenCard() : '') + picks.map(function (it) { return smallCard(it, true); }).join('') + '</div>'
      : '<div class="hero-empty">Today\'s produce is loading…</div>');
    // First time the cards arrive while the landing is on screen: they rise in one after another.
    var cards = box.querySelectorAll('.hc');
    if (!heroIntro && cards.length) {
      heroIntro = true;
      if (G && !CALM && box.getBoundingClientRect().top < innerHeight) {
        G.from(cards, { y: 40, opacity: 0, scale: .95, duration: .55, ease: 'power3.out', stagger: .07, delay: .3, clearProps: 'transform,opacity' });
      }
    }
  }
  /** Landing headline: the words rise into place one by one when the page opens. */
  function introHeadline() {
    var h = document.querySelector('.hero-txt h1');
    if (!h || !G || !window.SplitText || CALM) return;
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () {
      var split = SplitText.create(h, { type: 'words', mask: 'words' });
      G.from(split.words, { yPercent: 110, opacity: 0, duration: .9, ease: 'power3.out', stagger: .08, delay: .1 });
    });
  }
  /** Compact card with a quick + button (landing screen and "From our fields").
   *  brief: name and price only, no pack size, so more of the photo shows (landing screen). */
  function smallCard(it, brief) {
    var p = chosenPack(it), photo = photoFor(it, p), inCart = CART[it.key] || 0;
    var off = it.mrp > it.price ? Math.round((1 - it.price / it.mrp) * 100) : 0;
    return '<div class="hc" data-key="' + esc(it.key) + '">' +
      '<div class="hc-ph ' + catCls(it.category) + '"><span class="em">' + (EMOJI[it.category] || '🧺') + '</span>' +
      (photo ? '<img src="' + esc(photo) + '" alt="' + esc(it.item) + '" loading="lazy" onerror="this.remove()">' : '') +
      clipTag(it) +
      (off ? '<span class="hc-off">' + off + '% off</span>' : '') + '</div>' +
      '<div class="hc-body"><div class="hc-name">' + esc(it.item) + '</div>' +
      (brief ? '' : '<div class="hc-pack">' + esc(packLabel(it, p)) + (it.rating ? ' · <i>★</i> ' + it.rating.avg.toFixed(1) : '') + '</div>') +
      '<div class="hc-row"><span class="hc-price"><b>' + rs(r2(it.price * p)) + '</b>' + (off && !brief ? '<s>' + rs(r2(it.mrp * p)) + '</s>' : '') + '</span>' +
      (inCart ? '<button class="hc-add in" data-act="basket" aria-label="In basket, view">✓</button>'
        : '<button class="hc-add" data-act="add" aria-label="Add ' + esc(packLabel(it, p) + ' ' + it.item) + '">+</button>') +
      '</div></div></div>';
  }

  // ---------- "From our fields": one vegetable in the spotlight, thumbnails to switch ----------
  var SPOT = { key: '', list: [], timer: null, auto: true, busy: false };
  var SPOT_MS = 7000;
  /** Up to 5 vegetables in stock, photos first; ones not already on the landing screen come first. */
  function spotPicks() {
    var onHero = {};
    heroPicks().forEach(function (i) { onHero[i.key] = true; });
    return CAT.items.filter(function (i) { return i.category === 'Veggies' && i.left > 0 && packs(i).length; })
      .map(function (i, n) { return { it: i, rank: (i.photo ? 8 : 0) + (onHero[i.key] ? 0 : 4) + (i.rating ? 2 : 0) + (i.mrp > i.price ? 1 : 0), n: n }; })
      .sort(function (a, b) { return b.rank - a.rank || a.n - b.n; })
      .slice(0, 5).map(function (x) { return x.it; });
  }
  /** Where it was grown. Every vegetable comes from our farm for now; this is where a per-vegetable farm or plot,
   *  and a few words about it, will come from once the website text becomes editable. */
  var FARM = {
    name: 'Sreshta Farms', place: 'Yendada, Visakhapatnam',
    about: 'Grown on our own farm, the natural way: no chemical sprays, picked in the morning and packed the same day.'
  };
  function spotFarm(it) { return FARM; }

  /** How each vegetable was grown: seed, soil & compost, pest care, harvest.
   *  SAMPLE WORDING until the farm sends the real details (then this moves into the editable website backend).
   *  Keyed by the item's name in lower case; anything not listed uses `default`. */
  var STORIES = {
    'default': {
      seed: 'Native (desi) seeds, saved from our own harvest',
      soil: 'Cow-dung compost and vermicompost, no chemical fertiliser',
      care: 'Neem-oil spray and hand weeding, no chemical pesticides',
      harvest: 'Hand-picked in the morning, packed the same day'
    }
  };
  var STORY_STEPS = [['seed', '🌱', 'The seed'], ['soil', '🪱', 'Soil & compost'], ['care', '🌿', 'Pest care'], ['harvest', '🧺', 'Harvest']];
  function storyOf(it) { return STORIES[it.item.toLowerCase()] || STORIES['default']; }
  /** Optional real clip: website/images/stories/<name>.mp4 (e.g. bitter-gourd.mp4). Without one, the animated story plays. */
  function storyClip(it) { return 'images/stories/' + it.item.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.mp4'; }
  function spotSwapHtml(it) {
    var p = chosenPack(it), inCart = CART[it.key] || 0, farm = spotFarm(it);
    var off = it.mrp > it.price ? Math.round((1 - it.price / it.mrp) * 100) : 0;
    return '<div class="sp-farm"><span>📍</span><div><small>Grown at</small><b>' + esc(farm.name) + '</b> · ' + esc(farm.place) + '</div></div>' +
      '<h2 class="sp-name">' + esc(it.item) + '</h2>' +
      (it.rating ? '<button class="sp-rate" data-act="reviews" data-key="' + esc(it.key) + '"><i>★</i> ' + it.rating.avg.toFixed(1) + ' <span>(' + it.rating.n + ' reviews)</span></button>' : '') +
      '<ul class="sp-steps">' + STORY_STEPS.map(function (s) {
        return '<li><span>' + s[1] + '</span><div><small>' + s[2] + '</small>' + esc(storyOf(it)[s[0]]) + '</div></li>';
      }).join('') + '</ul>' +
      (G && !CALM ? '<button class="sp-play" data-act="story"><i>▶</i> Watch how it was grown</button>' : '') +
      '<div class="sp-buy" data-key="' + esc(it.key) + '">' +
      '<div class="sp-price"><b>' + rs(r2(it.price * p)) + '</b><span>' + esc(perPack(it, p)) + '</span>' +
      (off ? '<s>' + rs(r2(it.mrp * p)) + '</s><em>' + off + '% off market price</em>' : '') + '</div>' +
      (inCart ? '<button class="btn ghost big" data-act="basket">✓ In basket · View</button>'
        : '<button class="btn gold big" data-act="add">Add to basket</button>') + '</div>';
  }
  function spotPhotoHtml(it) {
    return '<div class="sp-img">' + (it.photo ? '<img src="' + esc(it.photo) + '" alt="' + esc(it.item) + '" onerror="this.remove()">' : '') +
      '<span class="em">' + (EMOJI[it.category] || '🥬') + '</span></div>';
  }
  function renderFarmItems() {
    if (!$('spot')) return;
    var list = SPOT.list = spotPicks();
    if (!list.length) {
      $('spSwap').innerHTML = '<div class="fs-empty">Fresh vegetables are on their way. Check back soon 🌱</div>';
      $('spThumbs').innerHTML = $('spView').innerHTML = '';
      return;
    }
    var it = itemByKey(SPOT.key);
    if (!it || list.indexOf(it) < 0) { it = list[0]; SPOT.key = it.key; $('spView').innerHTML = spotPhotoHtml(it); }
    else if (!$('spView').firstChild) $('spView').innerHTML = spotPhotoHtml(it);
    if (!SPOT.busy) $('spSwap').innerHTML = spotSwapHtml(it);   // price / basket state stay current
    $('spThumbs').innerHTML = list.length > 1 ? list.map(function (x) {
      return '<button class="sp-th' + (x.key === SPOT.key ? ' on' : '') + '" data-spot="' + esc(x.key) + '" aria-label="' + esc(x.item) + '">' +
        (x.photo ? '<img src="' + esc(x.photo) + '" alt="" loading="lazy">' : '<span>' + (EMOJI[x.category] || '🥬') + '</span>') +
        '<small>' + esc(x.item) + '</small></button>';
    }).join('') : '';
    if (!SPOT.timer && list.length > 1) {
      SPOT.timer = setInterval(function () {
        if (!SPOT.auto || document.hidden || SPOT.hover || SPOT.list.length < 2) return;
        var i = SPOT.list.indexOf(itemByKey(SPOT.key));
        showSpot(SPOT.list[(i + 1) % SPOT.list.length].key, 1);   // always forward, even when wrapping to the first
      }, SPOT_MS);
    }
  }
  // ---------- "From our fields" version 2: an uneven grid of vegetables, farm photos and growing details ----------
  // Farm photos for the grid (placeholders from the images folder until real farm photos are added).
  var FARM_PHOTOS = [
    { src: 'images/2a7ea348-bc83-4c41-a1dd-9047a102624c.jpg', cap: 'Our fields, Yendada' },
    { src: 'images/farm-2.jpg', cap: 'Sreshta Farms' }
  ];
  var MOSAIC_SIG = '';
  function mosaicVeg(it, size) {
    var p = chosenPack(it), inCart = CART[it.key] || 0;
    var off = it.mrp > it.price ? Math.round((1 - it.price / it.mrp) * 100) : 0;
    return '<div class="mz mz-veg ' + size + '" data-key="' + esc(it.key) + '">' +
      '<div class="mz-ph">' + (it.photo ? '<img src="' + esc(it.photo) + '" alt="' + esc(it.item) + '" loading="lazy" onerror="this.remove()">' : '') +
      '<span class="em">' + (EMOJI[it.category] || '🥬') + '</span></div>' +
      (off ? '<span class="mz-off">' + off + '% off</span>' : '') +
      '<div class="mz-body"><b>' + esc(it.item) + '</b><div class="mz-row"><span><i>' + rs(r2(it.price * p)) + '</i>' + esc(perPack(it, p)) + '</span>' +
      (inCart ? '<button class="mz-add in" data-act="basket" aria-label="In basket, view">✓</button>'
        : '<button class="mz-add" data-act="add" aria-label="Add ' + esc(packLabel(it, p) + ' ' + it.item) + '">+</button>') + '</div></div></div>';
  }
  /** n = 1 or 2: farm photo tiles; their picture and caption can be changed from edit mode. */
  function mosaicPhoto(n, size) {
    var ph = FARM_PHOTOS[n - 1] || FARM_PHOTOS[0], key = 'mosaic.photo' + n;
    return '<figure class="mz mz-photo ' + size + '" data-tile="photo' + n + '"><img src="' + esc(siteImg(key, ph.src)) + '" alt="" loading="lazy" onerror="this.closest(\'.mz\').remove()">' +
      '<figcaption>📍 <span data-ek="' + key + '.caption">' + esc(siteText(key + '.caption', ph.cap)) + '</span></figcaption></figure>';
  }
  /** How-it's-grown tile. The sample wording is for the local test only; the live site shows the farm's own text
   *  (written in edit mode) or, until then, just the heading. */
  function mosaicFact(step, tone) {
    var key = 'mosaic.' + step[0], sample = API === 'local' ? STORIES['default'][step[0]] : '';
    var txt = siteText(key, sample), bg = siteColor(key);
    return '<div class="mz mz-fact ' + tone + '" data-tile="' + step[0] + '"' + (bg ? ' style="background:' + esc(bg) + '"' : '') + '>' +
      '<span>' + step[1] + '</span><small data-ek="' + key + '.label">' + esc(siteText(key + '.label', step[2])) + '</small>' +
      (txt || EDITING ? '<p data-ek="' + key + '" data-ph="Click to write how it\'s done on your farm">' + esc(txt) + '</p>' : '') + '</div>';
  }
  function renderMosaic() {
    var box = $('mosaic');
    if (!box) return;
    var veg = CAT.items.filter(function (i) { return i.category === 'Veggies' && i.left > 0 && packs(i).length; })
      .sort(function (a, b) { return (b.photo ? 1 : 0) - (a.photo ? 1 : 0); }).slice(0, 6);
    // An empty vegetable slot keeps its place, so the pattern never gets holes.
    var v = function (i, area) {
      return veg[i] ? mosaicVeg(veg[i], area + '" data-tile="veg' + (i + 1))
        : '<div class="mz mz-soon ' + area + '" data-tile="veg' + (i + 1) + '"><span>🌱</span><p>More coming soon</p></div>';
    };
    var f = function (key, tone, area) { return mosaicFact(STORY_STEPS.filter(function (s) { return s[0] === key; })[0], tone + ' ' + area); };
    // The pattern of slots is fixed (see .mosaic in style.css: big · big · smalls on top, mirrored below);
    // which tile sits in which slot follows the saved order (tiles can be dragged in edit mode).
    var build = {
      veg1: function (a) { return v(0, a); }, veg2: function (a) { return v(1, a); }, veg3: function (a) { return v(2, a); },
      veg4: function (a) { return v(3, a); }, veg5: function (a) { return v(4, a); }, veg6: function (a) { return v(5, a); },
      photo1: function (a) { return mosaicPhoto(1, a); }, photo2: function (a) { return mosaicPhoto(2, a); },
      seed: function (a) { return f('seed', 'gold', a); }, soil: function (a) { return f('soil', 'cream', a); },
      care: function (a) { return f('care', 'dark', a); }, harvest: function (a) { return f('harvest', 'gold', a); }
    };
    var html = siteOrder('mosaic', MOSAIC_TILES).map(function (id, i) { return build[id](MOSAIC_SLOTS[i]); }).join('');
    if (html === MOSAIC_SIG) return;   // stock polls: redraw only when something changed
    var first = !MOSAIC_SIG;
    MOSAIC_SIG = html;
    box.innerHTML = html;
    if (first) [].forEach.call(box.querySelectorAll('.mz'), function (el, i) { watchReveal(el, (i % 6) * 70); });
  }

  // ---------- "Watch how it was grown": a short clip over the photo ----------
  var CLIP = { tl: null, box: null };
  function playStory() {
    var it = itemByKey(SPOT.key);
    if (!it || !G) return;
    stopStory();
    SPOT.auto = false;   // stay on this vegetable
    var box = CLIP.box = document.createElement('div');
    box.className = 'sp-clip';
    box.innerHTML = '<div class="sc-bars">' + STORY_STEPS.map(function () { return '<i><b></b></i>'; }).join('') + '</div>' +
      '<button class="sc-x" data-act="storyX" aria-label="Close the story">×</button>';
    $('spPhoto').appendChild(box);
    $('spPhoto').classList.add('playing');   // the photo disappears completely while the film plays
    G.fromTo(box, { opacity: 0, scale: .96 }, { opacity: 1, scale: 1, duration: .4, ease: 'power2.out' });
    // A real clip if the farm has added one; otherwise the animated story.
    var v = document.createElement('video');
    v.className = 'sc-video'; v.muted = true; v.playsInline = true; v.autoplay = true; v.src = storyClip(it);
    v.addEventListener('loadeddata', function () {
      if (CLIP.box !== box) return;
      box.classList.add('has-video');
      v.play().catch(function () { /* autoplay blocked: the poster frame stays */ });
    });
    v.addEventListener('timeupdate', function () {
      if (v.duration) box.querySelector('.sc-bars').style.setProperty('--p', v.currentTime / v.duration);
    });
    v.addEventListener('ended', function () { if (CLIP.box === box) stopStory(); });
    v.addEventListener('error', function () { if (CLIP.box === box && !CLIP.tl) animateStory(box, it); });
    box.insertBefore(v, box.firstChild);
    // No file → error fires quickly; if the browser is slow to say, start the animation anyway.
    setTimeout(function () { if (CLIP.box === box && !CLIP.tl && !box.classList.contains('has-video')) { v.remove(); animateStory(box, it); } }, 1200);
  }
  // The animated film: an illustrated farmer in a field (SVG), animated with GSAP in four scenes.
  var PLANTS_X = [420, 490, 560, 630, 700];   // where the seeds go in, along the middle furrow
  /** How each vegetable grows (plant) and what its produce looks like (shape, colour). First match wins. */
  var VEG_KINDS = [
    [/bitter|karela|kakarakaya/, 'climber', 'bitter', '#3f9a35'],
    [/cluster|gawar|guar|goru/, 'bush', 'cluster', '#5bab3c'],
    [/okra|ladies|bhindi|benda/, 'bush', 'okra', '#5bab3c'],
    [/ridge|bottle|snake|sorakaya|beerakaya|potla|gourd/, 'climber', 'gourd', '#86c45a'],
    [/cucumber|dosakaya/, 'climber', 'cucumber', '#3f8f3a'],
    [/bean|peas?\b|drumstick|moringa|chikkudu/, 'climber', 'pod', '#4caf3a'],
    [/tomato|tamata/, 'bush', 'round', '#e0412f'],
    [/chil+i|mirchi|mirapa/, 'bush', 'chili', '#2f9e3a'],
    [/brinjal|eggplant|aubergine|vankaya/, 'bush', 'brinjal', '#6b3a7a'],
    [/capsicum|bell pepper/, 'bush', 'capsicum', '#3f9a35'],
    [/carrot/, 'root', 'carrot', '#ef8a24'],
    [/radish|mullangi/, 'root', 'carrot', '#f4f1ea'],
    [/beet/, 'root', 'beet', '#8e1f4a'],
    [/potato|onion|sweet potato/, 'root', 'beet', '#c9a46a'],
    [/pumpkin|gummadi/, 'ground', 'pumpkin', '#ef8a24'],
    [/cauliflower/, 'ground', 'head', '#f3ecd6'],
    [/cabbage|lettuce/, 'ground', 'head', '#9fd07a'],
    [/spinach|palak|amaranth|thotakura|\bmethi\b|coriander|\bleaf|\bleaves\b|\bgreens\b|gongura|\bmint\b|\bcurry\b/, 'leafy', 'leaves', '#3f9a35']
  ];
  function vegKind(it) {
    var n = it.item.toLowerCase();
    for (var i = 0; i < VEG_KINDS.length; i++) if (VEG_KINDS[i][0].test(n)) return { plant: VEG_KINDS[i][1], fruit: VEG_KINDS[i][2], c: VEG_KINDS[i][3] };
    return { plant: 'bush', fruit: 'round', c: '#5bb446' };
  }
  /** One piece of produce, hanging from (x, y) (okra points up; roots sit in the soil). */
  function produce(k, x, y, r) {
    var c = k.c, g = '<g class="sc-fruit" transform="translate(' + x + ' ' + y + ') rotate(' + (r || 0) + ')">', s;
    switch (k.fruit) {
      case 'pod': s = '<path d="M0 0 C6 12 6 28 1 42" stroke="' + c + '" stroke-width="6" fill="none" stroke-linecap="round"/>'; break;
      case 'cluster': s = [-16, 0, 16].map(function (a) { return '<path d="M0 0 C3 10 3 22 0 32" stroke="' + c + '" stroke-width="4" fill="none" stroke-linecap="round" transform="rotate(' + a + ')"/>'; }).join(''); break;
      case 'bitter': s = '<path d="M0 0 C10 6 10 32 0 44 C-10 32 -10 6 0 0Z" fill="' + c + '"/>' +
        [[-3, 12], [3, 20], [-3, 28], [3, 34], [0, 8]].map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2" fill="#7fd06a"/>'; }).join(''); break;
      case 'gourd': s = '<path d="M0 0 C9 10 10 44 0 56 C-10 44 -9 10 0 0Z" fill="' + c + '"/><path d="M-2 12 V46" stroke="#c4e8a8" stroke-width="2"/>'; break;
      case 'cucumber': s = '<rect x="-7" y="0" width="14" height="40" rx="7" fill="' + c + '"/><path d="M-2 6 V34 M3 6 V34" stroke="#6fbf5a" stroke-width="1.5"/>'; break;
      case 'okra': s = '<path d="M-5 0 Q0 -36 0 -36 Q0 -36 5 0Z" fill="' + c + '"/><path d="M0 0 V-30" stroke="#4a9a33" stroke-width="1.5"/>'; break;
      case 'chili': s = '<path d="M0 0 C5 10 5 24 -5 32" stroke="' + c + '" stroke-width="5" fill="none" stroke-linecap="round"/><circle r="3" fill="#2f7d32"/>'; break;
      case 'brinjal': s = '<path d="M0 0 C11 4 13 28 0 34 C-13 28 -11 4 0 0Z" fill="' + c + '"/><path d="M-7 3 L0 -3 L7 3 L0 8Z" fill="#3f8f3a"/>'; break;
      case 'capsicum': s = '<path d="M-10 2 Q-12 24 -4 26 Q0 22 4 26 Q12 24 10 2 Q0 -2 -10 2Z" fill="' + c + '"/><path d="M0 0 V-6" stroke="#2f7d32" stroke-width="3"/>'; break;
      case 'carrot': s = '<path d="M-8 0 L8 0 L0 36Z" fill="' + c + '"/>'; break;
      case 'beet': s = '<circle cy="8" r="11" fill="' + c + '"/><path d="M0 19 V27" stroke="' + c + '" stroke-width="2"/>'; break;
      case 'pumpkin': s = '<ellipse cy="-13" rx="20" ry="14" fill="' + c + '"/><path d="M-7 -26 Q-10 -13 -7 0 M7 -26 Q10 -13 7 0" stroke="#d26f15" stroke-width="2" fill="none"/><path d="M0 -26 V-32" stroke="#3f8f3a" stroke-width="4"/>'; break;
      case 'head': s = '<circle cy="-15" r="17" fill="' + c + '"/><path d="M-10 -20 q10 -8 20 0 M-8 -10 q8 -6 16 0" stroke="rgba(0,0,0,.12)" stroke-width="2" fill="none"/>'; break;
      case 'leaves': s = [-30, -10, 10, 30].map(function (a) { return '<ellipse cx="0" cy="-16" rx="7" ry="17" fill="' + c + '" transform="rotate(' + a + ')"/>'; }).join(''); break;
      default: s = '<circle cy="9" r="9" fill="' + c + '"/><path d="M-4 1 l4 -3 l4 3" stroke="#3f8f3a" stroke-width="2" fill="none"/>';
    }
    return g + s + '</g>';
  }
  var LEAF = function (x, y, r, rx) { return '<ellipse cx="' + x + '" cy="' + y + '" rx="' + (rx || 17) + '" ry="7" fill="#4f9e3e" transform="rotate(' + r + ' ' + x + ' ' + y + ')"/>'; };
  /** The grown plant, standing on the soil at its own (0,0), carrying its produce. */
  function grownPlant(k) {
    switch (k.plant) {
      case 'climber':   // on a pole, the vine winding up, produce hanging down
        return '<rect x="-3" y="-160" width="6" height="160" rx="2" fill="#9a6a3c"/>' +
          '<path d="M0 0 C-16 -30 16 -62 -6 -94 S12 -134 0 -156" stroke="#2f7d32" stroke-width="4" fill="none"/>' +
          LEAF(-16, -40, -25) + LEAF(16, -74, 25) + LEAF(-14, -112, -30) + LEAF(14, -142, 20, 14) +
          produce(k, 10, -128, 6) + produce(k, -10, -92, -6) + produce(k, 10, -58, 4);
      case 'root':      // only the leafy tops above the soil; the root shows at the surface
        return produce(k, 0, -4) + [-35, -15, 5, 25].map(function (a) {
          return '<path d="M0 -4 Q' + (a / 2) + ' -30 ' + a + ' -52" stroke="#3f8f3a" stroke-width="4" fill="none"/>' + LEAF(a, -52, a * 2, 10);
        }).join('');
      case 'ground':    // sprawling leaves with the produce sitting on the soil
        return LEAF(-26, -10, -15, 20) + LEAF(26, -10, 15, 20) + LEAF(-12, -22, -40, 16) + LEAF(12, -22, 40, 16) + produce(k, 0, 0);
      case 'leafy':     // the leaves are the harvest
        return produce(k, 0, 0) + produce(k, -14, 4, -20) + produce(k, 14, 4, 20);
      default:          // a bush with produce on its branches
        var up = k.fruit === 'okra';
        return '<path d="M0 0 C-6 -40 6 -70 0 -112" stroke="#2f7d32" stroke-width="6" fill="none"/>' +
          '<path d="M0 -50 Q14 -58 22 -70 M0 -78 Q-14 -86 -22 -98" stroke="#2f7d32" stroke-width="4" fill="none"/>' +
          LEAF(-18, -46, -25) + LEAF(18, -84, 25) + LEAF(-14, -106, -30, 14) +
          produce(k, 22, up ? -70 : -66, 0) + produce(k, -22, up ? -98 : -94, 0) + produce(k, 6, up ? -112 : -40, 0);
    }
  }
  /** The last few that make the basket overflow, for the closing zoom. */
  function basketMore(k) {
    if (k.fruit === 'leaves') return produce(k, 314, 446, -10) + produce(k, 330, 446, 10);
    var flat = { pod: 1, cluster: 1, bitter: 1, gourd: 1, cucumber: 1, chili: 1, carrot: 1, okra: 1 }[k.fruit];
    return flat ? produce(k, 306, 434, -60) + produce(k, 330, 432, -110) + produce(k, 344, 438, -95)
      : produce(k, 314, 428, 0) + produce(k, 330, 428, 0) + produce(k, 298, 438, 0);
  }
  /** What fills the basket: three of the same produce, lying in it. */
  function basketFruit(k) {
    if (k.fruit === 'leaves') return produce(k, 308, 456, -20) + produce(k, 322, 452, 0) + produce(k, 336, 456, 20);
    var flat = { pod: 1, cluster: 1, bitter: 1, gourd: 1, cucumber: 1, chili: 1, carrot: 1, okra: 1 }[k.fruit];
    return flat ? produce(k, 300, 446, -70) + produce(k, 318, 440, -80) + produce(k, 336, 446, -100)
      : produce(k, 306, 442, 0) + produce(k, 322, 438, 0) + produce(k, 338, 442, 0);
  }
  function farmSvg(it) {
    var k = vegKind(it), i, out = [];
    out.push('<svg class="sc-svg" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">',
      '<defs><linearGradient id="scSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffcf7a"/>',
      '<stop offset=".55" stop-color="#ffe9c4"/><stop offset="1" stop-color="#eaf4d8"/></linearGradient></defs>',
      '<rect width="800" height="600" fill="url(#scSky)"/>',
      '<circle class="sc-sun" cx="640" cy="320" r="44" fill="#f8b226"/>',
      '<g class="sc-cloud"><ellipse cx="150" cy="95" rx="50" ry="16" fill="#fff" opacity=".9"/><ellipse cx="178" cy="83" rx="30" ry="17" fill="#fff" opacity=".9"/>',
      '<ellipse cx="520" cy="62" rx="40" ry="13" fill="#fff" opacity=".8"/><ellipse cx="542" cy="52" rx="24" ry="13" fill="#fff" opacity=".8"/></g>',
      '<path d="M0 330 Q150 250 320 318 T650 296 T800 318 V600 H0Z" fill="#9cc865"/>',
      '<path d="M0 366 Q200 312 420 358 T800 346 V600 H0Z" fill="#6aa346"/>',
      '<rect y="400" width="800" height="200" fill="#8a5a36"/>');
    [432, 482, 538].forEach(function (y) {
      out.push('<path d="M0 ' + y + ' Q400 ' + (y - 8) + ' 800 ' + y + '" stroke="#6b4124" stroke-width="10" fill="none" stroke-linecap="round"/>');
    });
    // compost heap with a few worms and leaves in it
    out.push('<g class="sc-compost"><path d="M90 470 Q150 395 210 470Z" fill="#4a2f1c"/><circle cx="140" cy="448" r="5" fill="#6b8f3a"/>',
      '<circle cx="165" cy="456" r="4" fill="#8bb54f"/><path d="M120 460 q6 -6 12 0 t12 0" stroke="#d98c8c" stroke-width="3" fill="none"/></g>');
    // clods kicked up by the hoe, seeds, sprouts, grown plants, water drops
    out.push('<g class="sc-clods">');
    for (i = 0; i < 6; i++) out.push('<circle cx="350" cy="478" r="' + (4 + i % 3) + '" fill="#6b4124"/>');
    out.push('</g>');
    PLANTS_X.forEach(function (x) {
      out.push('<circle class="sc-seed" cx="' + x + '" cy="420" r="5" fill="#f3d9a4" opacity="0"/>',
        '<g transform="translate(' + x + ' 482)"><g class="sc-sprout" transform="scale(0)"><path d="M0 0 V-24" stroke="#3f8f3a" stroke-width="4"/>',
        '<ellipse cx="-9" cy="-24" rx="9" ry="4.5" fill="#5fb446" transform="rotate(-25 -9 -24)"/>',
        '<ellipse cx="9" cy="-27" rx="9" ry="4.5" fill="#5fb446" transform="rotate(25 9 -27)"/></g></g>',
        '<g transform="translate(' + x + ' 482)"><g class="sc-plant" transform="scale(0)">' + grownPlant(k) + '</g></g>');
    });
    out.push('<g class="sc-drops">');
    for (i = 0; i < 8; i++) out.push('<ellipse cx="' + (430 + i * 36) + '" cy="380" rx="3" ry="6" fill="#4aa3e8" opacity="0"/>');
    out.push('</g>');
    // basket for the harvest
    out.push('<g class="sc-basket" opacity="0"><path d="M286 484 H354 L346 450 H294Z" fill="#c8913f"/>',
      '<path d="M294 452 Q320 412 346 452" stroke="#a8742c" stroke-width="5" fill="none"/>',
      '<g class="sc-bfruit">' + basketFruit(k) + '</g><g class="sc-bmore">' + basketMore(k) + '</g></g>');
    // the farmer: feet at (0,0); the upper body bends at the hips; the front arm swings from the shoulder and holds the tool
    out.push('<g class="sc-fm" transform="translate(-90 482)">',
      '<rect x="-14" y="-60" width="10" height="60" rx="5" fill="#a86b45"/><rect x="4" y="-60" width="10" height="60" rx="5" fill="#a86b45"/>',
      '<path d="M-22 -82 H22 L18 -36 H-18Z" fill="#f4efe2"/>',
      '<g transform="translate(0 -76)"><g class="sc-bend" transform="rotate(0)">',
      '<rect x="-20" y="-56" width="10" height="44" rx="5" fill="#25663c"/>',
      '<rect x="-22" y="-64" width="44" height="68" rx="16" fill="#2f7d4a"/>',
      '<circle cx="2" cy="-82" r="16" fill="#a86b45"/><circle cx="10" cy="-85" r="2" fill="#2b1d14"/>',
      '<path d="M6 -76 q6 3 12 -1" stroke="#2b1d14" stroke-width="3" fill="none" stroke-linecap="round"/>',
      '<ellipse cx="2" cy="-92" rx="19" ry="8" fill="#f8b226"/><path d="M-17 -92 Q2 -112 21 -92Z" fill="#f8b226"/>',
      '<g transform="translate(8 -56)"><g class="sc-arm" transform="rotate(12)">',
      '<rect x="-5" y="0" width="10" height="44" rx="5" fill="#2f7d4a"/><circle cy="48" r="6" fill="#a86b45"/>',
      '<g class="sc-hoe"><rect x="-2.5" y="-12" width="5" height="98" rx="2" fill="#7a4e2a"/><path d="M-3 82 h24 l-5 13 h-19z" fill="#8d99a6"/></g>',
      '<g class="sc-pouch" opacity="0"><path d="M-10 46 q10 -9 20 0 l2 17 q-12 7 -24 0z" fill="#b07a3e"/></g>',
      '<g class="sc-can" opacity="0"><rect x="-6" y="46" width="28" height="22" rx="5" fill="#3d8bd0"/><path d="M22 50 l24 -11 v6 l-22 11z" fill="#3d8bd0"/></g>',
      '</g></g></g></g></g>',
      '</svg>');
    return out.join('');
  }
  /** Centre of an element in the SVG's viewBox coordinates (the drawing is scaled to cover the panel, "slice"). */
  function svgPoint(svg, el) {
    var sr = svg.getBoundingClientRect(), er = el.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    var k = Math.max(sr.width / vb.width, sr.height / vb.height);
    var ox = (sr.width - vb.width * k) / 2, oy = (sr.height - vb.height * k) / 2;
    return { x: vb.x + (er.left + er.width / 2 - sr.left - ox) / k, y: vb.y + (er.top + er.height / 2 - sr.top - oy) / k };
  }
  /** Four scenes (soil, seed, care, harvest) and an end card; a caption under each tells that step. */
  function animateStory(box, it) {
    var st = storyOf(it), q = function (s) { return box.querySelectorAll(s); }, one = function (s) { return box.querySelector(s); };
    var steps = [['soil', 'Preparing the soil'], ['seed', 'Sowing the seeds'], ['care', 'Caring the natural way'], ['harvest', 'Harvest day']];
    box.insertAdjacentHTML('afterbegin', farmSvg(it) +
      '<div class="sc-cap"><small></small><b></b><span></span></div>' +
      // the real photo the film dissolves into, and the closing title over it
      (it.photo ? '<img class="sc-real" src="' + esc(it.photo) + '" alt="">' : '') +
      '<div class="sc-end"><b>' + esc(it.item) + '</b><span>From our farm to your kitchen</span></div>');
    var fm = one('.sc-fm'), arm = one('.sc-arm'), bend = one('.sc-bend'), bars = q('.sc-bars b'), cap = one('.sc-cap');
    var S = 4.4;   // seconds per scene
    var tl = CLIP.tl = G.timeline({ onComplete: stopStory });
    var walk = function (from, to, dur, at) {
      tl.fromTo(fm, { attr: { transform: 'translate(' + from + ' 482)' } }, { attr: { transform: 'translate(' + to + ' 482)' }, duration: dur, ease: 'none' }, at);
      tl.to(bend, { attr: { transform: 'rotate(4)' }, duration: .25, yoyo: true, repeat: Math.max(1, Math.round(dur / .25) - 1), ease: 'sine.inOut' }, at);   // a little bob while walking
    };
    var caption = function (i, at) {
      tl.to(cap, { autoAlpha: 0, y: 10, duration: .25 }, at)
        .add(function () {
          cap.querySelector('small').textContent = (i + 1) + ' of 4';
          cap.querySelector('b').textContent = steps[i][1];
          cap.querySelector('span').textContent = st[steps[i][0]];
        }, at + .25)
        .to(cap, { autoAlpha: 1, y: 0, duration: .45, ease: 'power3.out' }, at + .3);
      if (bars[i]) tl.fromTo(bars[i], { scaleX: 0 }, { scaleX: 1, duration: S, ease: 'none' }, at);
    };
    tl.set(cap, { autoAlpha: 0 }, 0)
      .to(one('.sc-sun'), { attr: { cy: 130 }, duration: S * 2, ease: 'power1.out' }, 0)
      .to(one('.sc-cloud'), { x: 70, duration: S * 4 + 3, ease: 'none' }, 0);
    // 1 · soil: walks in past the compost, swings the hoe, clods fly
    caption(0, 0);
    walk(-90, 270, 1.6, 0);
    tl.to(bend, { attr: { transform: 'rotate(10)' }, duration: .3 }, 1.7);
    tl.to(arm, { attr: { transform: 'rotate(-110)' }, duration: .45, ease: 'power2.in', yoyo: true, repeat: 3 }, 1.8);
    [2.25, 3.15].forEach(function (t) {
      tl.fromTo(q('.sc-clods circle'), { x: 0, y: 0, opacity: 1 }, {
        x: function (k) { return 20 + k * 9; }, y: function (k) { return -30 - (k % 3) * 14; }, opacity: 0, duration: .6, ease: 'power2.out'
      }, t);
    });
    // 2 · seed: swaps the hoe for the seed pouch, walks along the furrow dropping seeds
    caption(1, S);
    tl.to(one('.sc-hoe'), { attr: { opacity: 0 }, duration: .2 }, S)
      .to(one('.sc-pouch'), { attr: { opacity: 1 }, duration: .2 }, S + .2)
      .to(arm, { attr: { transform: 'rotate(-35)' }, duration: .4 }, S + .2)
      .to(bend, { attr: { transform: 'rotate(22)' }, duration: .4 }, S + .2);
    tl.fromTo(fm, { attr: { transform: 'translate(270 482)' } }, { attr: { transform: 'translate(640 482)' }, duration: 3.4, ease: 'none' }, S + .5);
    tl.fromTo(q('.sc-seed'), { attr: { cy: 440, opacity: 0 } }, { attr: { cy: 482, opacity: 1 }, duration: .4, stagger: .62, ease: 'power1.in' }, S + .9);
    // 3 · care: watering can; sprouts come up as the water falls
    caption(2, S * 2);
    tl.to(one('.sc-pouch'), { attr: { opacity: 0 }, duration: .2 }, S * 2)
      .to(one('.sc-can'), { attr: { opacity: 1 }, duration: .2 }, S * 2 + .2)
      .to(bend, { attr: { transform: 'rotate(0)' }, duration: .4 }, S * 2 + .2)
      .to(arm, { attr: { transform: 'rotate(-80)' }, duration: .4 }, S * 2 + .2)
      .to(q('.sc-seed'), { attr: { opacity: 0 }, duration: .3 }, S * 2 + .6);
    tl.fromTo(fm, { attr: { transform: 'translate(640 482)' } }, { attr: { transform: 'translate(360 482)' }, duration: 3.2, ease: 'none' }, S * 2 + .5);
    tl.fromTo(q('.sc-drops ellipse'), { attr: { cy: 390, opacity: .9 } }, { attr: { cy: 470, opacity: 0 }, duration: .7, stagger: { each: .12, repeat: 3 }, ease: 'power1.in' }, S * 2 + .6);
    tl.to(q('.sc-sprout'), { attr: { transform: 'scale(1)' }, duration: .7, stagger: .45, ease: 'back.out(2)' }, S * 2 + 1.2);
    // 4 · harvest: plants grow tall with the vegetable; picks them into the basket
    caption(3, S * 3);
    tl.to(one('.sc-can'), { attr: { opacity: 0 }, duration: .2 }, S * 3)
      .to(q('.sc-sprout'), { attr: { opacity: 0 }, duration: .4 }, S * 3 + .2)
      .to(q('.sc-plant'), { attr: { transform: 'scale(1)' }, duration: .9, stagger: .15, ease: 'back.out(1.6)' }, S * 3 + .1)
      .to(one('.sc-basket'), { attr: { opacity: 1 }, duration: .3 }, S * 3 + .9)
      .fromTo(q('.sc-bfruit > .sc-fruit'), { scale: 0, transformOrigin: '50% 100%' }, { scale: 1, duration: .4, stagger: .6, ease: 'back.out(2)' }, S * 3 + 1.6)
      .to(bend, { attr: { transform: 'rotate(18)' }, duration: .35 }, S * 3 + 1.2)
      .to(arm, { attr: { transform: 'rotate(-75)' }, duration: .4, yoyo: true, repeat: 3, ease: 'sine.inOut' }, S * 3 + 1.3);
    // Closing shot: the basket overflows; then the camera zooms into the last vegetable still on its plant and the
    // cartoon dissolves into the real photo of it (photos show the produce on the plant), which stays as the spotlight.
    var svg = one('.sc-svg'), real = one('.sc-real'), plants = q('.sc-plant');
    var target = plants[plants.length - 1].querySelector('.sc-fruit');
    tl.fromTo(q('.sc-bmore > .sc-fruit'), { scale: 0, transformOrigin: '50% 100%' }, { scale: 1, duration: .45, stagger: .25, ease: 'back.out(2.4)' }, S * 4 - .3)
      .to(cap, { autoAlpha: 0, duration: .4 }, S * 4)
      .add(function () {   // where the target is now, in the drawing's own coordinates (the zoom is set up only now, once it's drawn)
        var b = svgPoint(svg, target), w = 150, h = 112.5;
        tl.to(svg, { attr: { viewBox: (b.x - w / 2) + ' ' + (b.y - h / 2) + ' ' + w + ' ' + h }, duration: 2.2, ease: 'power2.in' }, S * 4 + .05);
      }, S * 4);
    if (real) {
      tl.fromTo(real, { autoAlpha: 0, scale: 1.35 }, { autoAlpha: 1, scale: 1, duration: 1.6, ease: 'power2.out' }, S * 4 + 1.7)
        .to(svg, { autoAlpha: 0, duration: .6 }, S * 4 + 2.4);
    }
    tl.fromTo(one('.sc-end'), { autoAlpha: 0 }, { autoAlpha: 1, duration: .5 }, S * 4 + 2.6)
      .fromTo(q('.sc-end b, .sc-end span'), { y: 20, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: .6, stagger: .15, ease: 'power3.out' }, S * 4 + 2.7)
      .to({}, { duration: 2.4 });
  }
  function stopStory() {
    var box = CLIP.box;
    if (CLIP.tl) CLIP.tl.kill();
    CLIP.tl = null; CLIP.box = null;
    $('spPhoto').classList.remove('playing');
    if (!box) return;
    if (G) G.to(box, { opacity: 0, duration: .35, onComplete: function () { box.remove(); } });
    else box.remove();
  }

  /** Switch the spotlight: the text slips out and back in; the photos slide. A vegetable further along the
   *  thumbnails comes in from the right (the old one leaves to the left), an earlier one from the left.
   *  dir forces the direction (the auto-advance always moves forward). */
  function showSpot(key, dir) {
    var it = itemByKey(key);
    if (!it || key === SPOT.key || SPOT.busy) return;
    stopStory();
    var from = SPOT.list.indexOf(itemByKey(SPOT.key)), to = SPOT.list.indexOf(it);
    dir = dir || (to < from ? -1 : 1);
    SPOT.key = key;
    [].forEach.call($('spThumbs').querySelectorAll('.sp-th'), function (b) { b.classList.toggle('on', b.dataset.spot === key); });
    var view = $('spView'), swap = $('spSwap');
    if (!G || CALM) { view.innerHTML = spotPhotoHtml(it); swap.innerHTML = spotSwapHtml(it); return; }
    SPOT.busy = true;
    var old = view.querySelectorAll('.sp-img');
    view.insertAdjacentHTML('beforeend', spotPhotoHtml(it));
    var incoming = view.lastElementChild;
    G.to(old, { xPercent: -100 * dir, duration: .75, ease: 'power3.inOut', onComplete: function () { [].forEach.call(old, function (el) { el.remove(); }); } });
    G.fromTo(incoming, { xPercent: 100 * dir }, { xPercent: 0, duration: .75, ease: 'power3.inOut' });
    // its children move, not #spSwap itself: that one has the scroll glide's CSS transition
    G.to(swap.children, { opacity: 0, y: -14, duration: .25, ease: 'power2.in', stagger: .03, onComplete: function () {
      swap.innerHTML = spotSwapHtml(itemByKey(SPOT.key) || it);
      G.fromTo(swap.children, { opacity: 0, y: 18 }, {
        opacity: 1, y: 0, duration: .45, ease: 'power3.out', stagger: .06, clearProps: 'transform,opacity',
        onComplete: function () { SPOT.busy = false; }
      });
    } });
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
  /** Short pack after a price: "/kg", "/500 g", "/12 eggs", "/pc", "/bunch". */
  function perPack(it, p) {
    if (it.unit === 'kg') return p === 1 ? '/kg' : '/' + packLabel(it, p);
    if (it.category === 'Eggs') return '/' + p + ' eggs';
    if (it.unit === 'bunch') return p === 1 ? '/bunch' : '/' + p + ' bunches';
    return p === 1 ? '/pc' : '/' + p + ' pcs';
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

  // Videos that play over an item's photo while the mouse is on it (item name in lowercase → file).
  var CLIPS = {};   // e.g. { 'cluster beans': '3d/cluster-beans.mp4' }
  var CLIP_SPEED = 1.75;   // 1 = as recorded
  function clipTag(it) {
    var src = CLIPS[it.item.toLowerCase()];
    return src ? '<video class="clip" src="' + esc(src) + '" muted playsinline preload="metadata" aria-hidden="true"></video>' : '';
  }
  function itemCard(it) {
    var opts = packs(it);
    var sold = it.left <= 0 || !opts.length, inCart = CART[it.key] || 0, low = isLow(it);
    var preBook = it.category === CHICKEN && CAT.chicken && !CAT.shop.isSunday;
    var badge = sold ? '' : preBook ? 'Pre-book' : low ? 'Selling fast' : '';
    var stock = sold ? 'Sold out' : (low ? 'Only ' : '') + q(it.left) + ' ' + unitTxt(it.unit, it.left) + ' left';
    var p = chosenPack(it), full = !sold && maxPacks(it, p) < 1, photo = photoFor(it, p);
    return '<div class="item' + (sold ? ' sold' : '') + '" data-key="' + esc(it.key) + '" data-flip-id="' + esc(it.key) + '">' +
      '<div class="ph ' + catCls(it.category) + '"><span class="em">' + (EMOJI[it.category] || '🧺') + '</span>' +
      (photo ? '<img src="' + esc(photo) + '" alt="' + esc(it.item) + '" loading="lazy" onerror="this.remove()">' : '') +
      (sold ? '' : clipTag(it)) +
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
      // price on the left, the Add button beside it
      '<div class="buy"><div class="price"><b>' + rs(r2(it.price * (sold ? 1 : p))) + '</b>' +
      (it.mrp > it.price ? '<s class="mrp" title="Market price">' + rs(r2(it.mrp * (sold ? 1 : p))) + '</s>' : '') +
      (sold ? '<span>/ per ' + (it.unit === 'pcs' ? 'piece' : it.unit) + '</span>' : '') +
      (it.rating ? '<button class="rate" data-act="reviews" aria-label="See reviews"><i>★</i> ' + it.rating.avg.toFixed(1) + ' <span>(' + it.rating.n + ')</span></button>' : '') +
      (it.mrp > it.price ? '<em class="off">' + Math.round((1 - it.price / it.mrp) * 100) + '% off market price</em>' : '') + '</div>' +
      (sold ? '<button class="btn out" disabled>Sold out</button>'
        : '<button class="btn gold" data-act="add"' + (full ? ' disabled' : '') + '>Add</button>') + '</div>' +
      (inCart ? '<button class="in-basket" data-act="basket">✓ ' + packLabel(it, inCart) + ' in basket · View</button>' : '') +
      '</div></div>';
  }

  function stepper(it, qty, light) {
    return '<div class="stepper' + (light ? ' light' : '') + '"><button data-act="dec" aria-label="Less">−</button>' +
      '<input type="number" inputmode="decimal" step="' + it.step + '" min="0" value="' + qty + '" data-act="qty" aria-label="Quantity">' +
      '<span class="u">' + esc(it.unit) + '</span><button data-act="inc" aria-label="More">+</button></div>';
  }

  function addPack(key, btn) {
    var it = itemByKey(key);
    if (!it) return;
    var p = chosenPack(it), before = CART[key] || 0;
    var from = flySource(btn);   // measure before the card is redrawn
    setQty(key, r3(before + p));
    if ((CART[key] || 0) > before) {
      flyToBasket(from);
      toast('Added ' + packLabel(it, p) + ' ' + it.item + ' to your basket');
    }
  }

  // ---------- "jump into the basket" animation ----------
  function flySource(btn) {
    var card = btn && btn.closest('.hc, .item, .spot, .mz');
    var ph = card && card.querySelector('.hc-ph, .ph, .sp-img:last-child, .mz-ph');
    if (!ph) return null;
    var img = ph.querySelector('img');
    return { rect: ph.getBoundingClientRect(), src: img ? img.currentSrc || img.src : '', emoji: (ph.querySelector('.em') || {}).textContent || '🧺' };
  }
  function flyToBasket(from) {
    if (!from || CALM) return;
    if (G && window.MotionPathPlugin) return flyArc(from);
    if (!document.body.animate) return;
    var bar = $('openBasket'), r = from.rect;
    var size = Math.max(56, Math.min(110, Math.min(r.width, r.height) * 0.7));
    var sx = r.left + r.width / 2, sy = r.top + r.height / 2;
    var t = !$('basketBar').hidden && bar ? bar.getBoundingClientRect() : null;
    var bag = t && bar.querySelector('.bag').getBoundingClientRect();   // aim for the mouth of the bag
    var tx = bag ? bag.left + bag.width / 2 : innerWidth - 60, ty = bag ? bag.top + bag.height * 0.35 : innerHeight - 70;
    var f = document.createElement('div');
    f.className = 'fly';
    f.style.cssText = 'width:' + size + 'px;height:' + size + 'px;left:' + (sx - size / 2) + 'px;top:' + (sy - size / 2) + 'px;' +
      (from.src ? 'background-image:url("' + from.src.replace(/"/g, '%22') + '")' : '');
    if (!from.src) f.textContent = from.emoji;
    document.body.appendChild(f);
    var dx = tx - sx, dy = ty - sy;
    f.animate([
      { transform: 'translate(0,0) scale(.6)', opacity: 0 },
      { transform: 'translate(0,-40px) scale(1.15)', opacity: 1, offset: 0.18 },                         // jumps out of the card
      { transform: 'translate(' + dx * 0.55 + 'px,' + (Math.min(dy, 0) * 0.55 - 90) + 'px) scale(.8)', offset: 0.55 },   // arc
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.22)', opacity: 0.7 }                    // into the basket
    ], { duration: 900, easing: 'cubic-bezier(.45,.05,.35,1)' }).onfinish = function () {
      f.remove();
      if (bar) { bar.classList.remove('bump'); void bar.offsetWidth; bar.classList.add('bump'); }
    };
  }

  /** GSAP version: the photo pops out of the card, flies along a smooth curve and drops into the bag,
   *  which then wobbles and its count bounces. */
  function flyArc(from) {
    var bar = $('openBasket'), r = from.rect;
    var size = Math.max(56, Math.min(110, Math.min(r.width, r.height) * 0.7));
    var sx = r.left + r.width / 2, sy = r.top + r.height / 2;
    var bagEl = !$('basketBar').hidden && bar ? bar.querySelector('.bag') : null;
    var bag = bagEl && bagEl.getBoundingClientRect();
    var tx = bag ? bag.left + bag.width / 2 : innerWidth - 60, ty = bag ? bag.top + bag.height * 0.35 : innerHeight - 70;
    var dx = tx - sx, dy = ty - sy, lift = Math.min(dy, 0) - 140;   // peak of the arc, above both ends
    var f = document.createElement('div');
    f.className = 'fly';
    f.style.cssText = 'width:' + size + 'px;height:' + size + 'px;left:' + (sx - size / 2) + 'px;top:' + (sy - size / 2) + 'px;' +
      (from.src ? 'background-image:url("' + from.src.replace(/"/g, '%22') + '")' : '');
    if (!from.src) f.textContent = from.emoji;
    document.body.appendChild(f);
    G.timeline({ onComplete: function () { f.remove(); landInBag(bagEl); } })
      .fromTo(f, { scale: .5, opacity: 0 }, { scale: 1.15, opacity: 1, y: -36, duration: .22, ease: 'back.out(2)' })
      .to(f, {
        duration: .85, ease: 'power1.inOut', rotation: dx > 0 ? 200 : -200, scale: .24,
        motionPath: { path: [{ x: 0, y: -36 }, { x: dx * 0.45, y: lift }, { x: dx, y: dy }], curviness: 1.25 }
      });
  }
  function landInBag(bagEl) {
    if (!bagEl) return;
    G.fromTo(bagEl, { rotation: 0 }, { keyframes: { rotation: [-14, 10, -6, 3, 0] }, scale: 1, duration: .7, ease: 'power1.out', clearProps: 'transform' });
    var n = $('bbN');
    if (n) G.fromTo(n, { scale: 1.6 }, { scale: 1, duration: .6, ease: 'elastic.out(1, .4)', clearProps: 'transform' });
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
    $('bbN').textContent = n;
    $('bbCount').textContent = n + ' item' + (n === 1 ? '' : 's') + ' · ' + rs(cartTotal());
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
  function placeLabel() { return (onlinePay() ? 'Pay ' : 'Place order · ') + rs(payTotal()); }

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
    }).join('') +
      (FORM.coupon ? '<div class="sub-line"><span>Items</span><span>' + rs(cartTotal()) + '</span></div>' +
        '<div class="sub-line cp-off"><span>Coupon ' + esc(FORM.coupon.code) + ' (' + FORM.coupon.pct + '% off)' +
        ' <button class="cp-x" data-act="couponX" aria-label="Remove coupon">×</button></span><span>−' + rs(couponOff()) + '</span></div>' : '') +
      '<div class="total"><span>Total</span><span>' + rs(payTotal()) + '</span></div>' +
      (FORM.coupon ? '' : '<div class="coupon"><input id="bk-cp" placeholder="Coupon code" maxlength="20" autocapitalize="characters" autocomplete="off">' +
        '<button class="btn ghost" data-act="coupon">Apply</button></div><div id="cp-err"></div>') +
      (cartSavings() > 0 ? '<div class="saving">🎉 You save ' + rs(cartSavings() + couponOff()) + ' compared to market price</div>' : '');
    $('placeBtn').textContent = placeLabel();
  }

  // ---------- coupon (the shop checks the code again when the order is placed) ----------
  function couponOff() { return FORM.coupon ? Math.round(cartTotal() * FORM.coupon.pct / 100) : 0; }
  function payTotal() { return r2(cartTotal() - couponOff()); }
  function applyCoupon(btn) {
    var code = ($('bk-cp').value || '').trim();
    var err = function (m) { $('cp-err').innerHTML = '<div class="note err" style="margin:8px 0 0">' + esc(m) + '</div>'; };
    if (!code) return err('Type a coupon code first.');
    btn.disabled = true;
    apiGet({ api: 'coupon', code: code }).then(function (r) {
      btn.disabled = false;
      if (!r.ok || !r.coupon) return err(r.error || 'That coupon code isn\'t valid.');
      FORM.coupon = r.coupon;
      FORM.reqId = '';   // a different total is a new order
      $('bk-cp').blur();   // the list doesn't redraw while its field has the cursor
      renderBasketLines();
      toast('🎉 ' + r.coupon.code + ' applied: ' + r.coupon.pct + '% off your basket');
    }).catch(function () { btn.disabled = false; err('We couldn\'t check the code. Check your internet and try again.'); });
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
      fulfilment: FORM.fulfilment, notes: FORM.notes, coupon: FORM.coupon ? FORM.coupon.code : '',
      items: keys.map(function (k) { return { key: k, qty: CART[k] }; })
    }).then(function (r) {
      if (r.ok) {
        LAST = r.order;
        store('sf_last', LAST);
        CART = {};
        store('sf_cart', CART);
        FORM.notes = '';
        FORM.reqId = '';
        FORM.coupon = null;
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
      btn.textContent = 'Try again · ' + rs(payTotal());
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
    FORM.coupon = null;
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
      fulfilment: FORM.fulfilment, notes: FORM.notes, coupon: FORM.coupon ? FORM.coupon.code : '',
      items: keys.map(function (k) { return { key: k, qty: CART[k] }; })
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
    var d = MO.data, h = '', plans = d.plans || [];
    if (!d.orders.length && !d.preorders.length && !plans.length) {
      $('mo-list').innerHTML = '<div class="empty">No orders yet for this number.</div>';
      return;
    }
    plans.forEach(function (p) { h += planCard(p); });
    d.preorders.forEach(function (p) {
      var cls = p.status === 'Open' ? 'pending' : p.status === 'Delivered' ? '' : 'cancel';
      h += '<div class="card"><div class="ord-head"><div><b>🐓 Chicken pre-order · ' + q(p.kg) + ' kg</b><div class="ord-items">For ' + fmtD(p.sunday) + '</div></div>' +
        '<span class="chip ' + cls + '">' + (p.status === 'Open' ? 'Reserved' : esc(p.status)) + '</span></div>' +
        (p.status === 'Open' ? '<div class="actions" style="margin-top:10px"><button class="btn danger" data-act="cancelPre" data-id="' + esc(p.id) + '">Cancel reservation</button></div>' : '') + '</div>';
    });
    d.orders.forEach(function (o) {
      var open = (o.status === 'Placed' || o.status === 'Packed') && !o.planId;   // plan deliveries can't be cancelled
      var unpaid = o.payment === 'Pending' && o.status !== 'Cancelled';
      var rv = o.review && o.review.items ? o.review : null;
      h += '<div class="card"><div class="ord-head"><div><b>' + fmtD(o.date) + ' · ' + esc(o.time) + '</b><div class="ord-items">' +
        esc(o.items.map(function (i) { return i.item + ' ' + q(i.qty) + ' ' + unitTxt(i.unit, i.qty); }).join(', ')) + '</div></div>' +
        '<div style="text-align:right"><b>' + rs(o.total) + '</b><br>' +
        (o.payment === 'Refunded' ? '<span class="chip cancel">Refunded</span>'
          : o.status === 'Cancelled' ? '<span class="chip cancel">Cancelled</span>'
          : unpaid ? '<span class="chip pending">To pay</span>'
          : '<span class="chip">' + (o.planId ? 'Weekly plan · prepaid' : o.payment === 'Razorpay' ? 'Paid online' : 'Paid · ' + esc(o.payment)) + '</span>') +
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
  /** A weekly plan in My orders: what, when, how many weeks are left. */
  function planCard(p) {
    var egg = p.kind === 'eggs', what = egg ? (p.qty === 30 ? '30 eggs (tray)' : p.qty + ' eggs') : q(p.qty) + ' kg country chicken';
    var chip = p.status === 'Active' ? '<span class="chip">Active</span>' : p.status === 'Completed' ? '<span class="chip">Completed</span>'
      : '<span class="chip pending">' + esc(p.status) + '</span>';
    return '<div class="card plan-card"><div class="ord-head"><div><b>' + (egg ? '🥚' : '🐓') + ' Weekly plan · ' + esc(what) + '</b>' +
      '<div class="ord-items">Every ' + esc(p.day) + ' · ' + fmtD(p.first) + ' to ' + fmtD(p.last) + ' · ' + esc(p.fulfilment) + '</div></div>' +
      '<div style="text-align:right"><b>' + rs(p.paid) + '</b><br>' + chip + '</div></div>' +
      '<div class="plan-weeks"><span style="--done:' + (p.weeks ? p.weeksDone / p.weeks : 0) + '"></span></div>' +
      '<div class="ord-items">' + p.weeksDone + ' of ' + p.weeks + ' deliveries done · paid in full</div>' +
      (p.status === 'Active' ? planWeeks(p) : '') + '</div>';
  }
  /** Coming weeks, each with Pause (or Undo for a paused one) until 9 PM the night before. */
  function planWeeks(p) {
    var coming = (p.schedule || []).filter(function (w) { return w.state !== 'done'; }).slice(0, 5);
    if (!coming.length) return '';
    return '<div class="plan-sched"><div class="plan-sched-h">Coming deliveries <span>' +
      (p.pausesLeft ? p.pausesLeft + ' of 2 pauses left' : 'no pauses left') + '</span></div>' +
      coming.map(function (w) {
        var paused = w.state === 'paused';
        var btn = !w.canChange ? '<small>' + (paused ? 'Paused' : 'On its way') + '</small>'
          : paused ? '<button class="btn ghost" data-act="planResume" data-id="' + esc(p.id) + '" data-date="' + w.date + '">Undo pause</button>'
          : p.pausesLeft ? '<button class="btn ghost" data-act="planPause" data-id="' + esc(p.id) + '" data-date="' + w.date + '">Pause</button>' : '';
        return '<div class="plan-wk' + (paused ? ' paused' : '') + '"><span>' + fmtD(w.date) + (paused ? ' · paused, added at the end' : '') + '</span>' + btn + '</div>';
      }).join('') + '<div class="hint" style="margin-top:6px">Changes close at 9 PM the night before a delivery.</div></div>';
  }
  function changePlanWeek(t, pause) {
    if (pause && !confirm('Pause the delivery on ' + fmtD(t.dataset.date) + '? It will be added at the end of your plan. You can pause 2 weeks per plan.')) return;
    t.disabled = true;
    apiPost({ action: pause ? 'pausePlan' : 'resumePlan', planId: t.dataset.id, date: t.dataset.date, phone: MO.phone }).then(function (r) {
      if (!r.ok) { t.disabled = false; return toast(r.error, true); }
      toast(pause ? '⏸️ Paused. Your plan now ends ' + fmtD(r.plan.last) + '.' : '▶️ Delivery on ' + fmtD(t.dataset.date) + ' is back on.');
      loadMyOrders(true);
    }).catch(function () { t.disabled = false; toast('We couldn\'t reach the shop. Check your internet and try again.', true); });
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

  // ---------- glide in/out on scroll ----------
  // Landing content glides into place each time it scrolls into view and fades out when it leaves the screen:
  // upward out of the top when scrolling down, downward out of the bottom when scrolling up.
  // Items in the same group follow each other with a short delay.
  var REVEAL = null;
  /** Adds an element drawn later (product cards) to the glide. One that is already on screen just appears. */
  function watchReveal(el, delay) {
    if (!REVEAL) return;
    var r = el.getBoundingClientRect();
    el.classList.add('rv');
    if (r.bottom < 0) el.classList.add('above');
    else if (r.top < innerHeight * 0.92) el.classList.add('in');
    el.style.setProperty('--rv-d', delay + 'ms');
    REVEAL.observe(el);
  }
  function setupReveal() {
    // The hero's item cards are redrawn when stock changes, so their container glides as one piece.
    var groups = ['.hero-txt > *', '#heroItems', '#landing .sec-head', '#view-shop .sec-head', '.subs .sec-head', '#subGrid', '#offer', '#bento', '.sp-txt > *', '.sp-photo'];
    if (!('IntersectionObserver' in window)) return;   // very old browser: everything just shows
    var io = REVEAL = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var el = e.target;
        if (e.isIntersecting) { el.classList.add('in'); el.classList.remove('above'); return; }
        el.classList.remove('in');
        el.classList.toggle('above', e.boundingClientRect.top < 0);   // left through the top → waits above
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    groups.forEach(function (sel) {
      [].forEach.call(document.querySelectorAll(sel), function (el, i) {
        el.classList.add('rv');
        el.style.setProperty('--rv-d', (sel === '.hero-txt > *' || sel === '.sp-txt > *' ? i * 90 : sel === '.sp-photo' ? 200
          : 0) + 'ms');
        io.observe(el);
      });
    });
  }

  // ---------- product videos: play while the mouse is over the card ----------
  // Cards are redrawn often, so this listens on the page and works for whichever card is under the mouse.
  function setupHoverClips() {
    if (!window.matchMedia || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    var card = null;
    function stop() {
      var v = card && card.querySelector('video.clip');
      if (v) { v.pause(); v.classList.remove('on'); setTimeout(function () { if (!v.classList.contains('on')) v.currentTime = 0; }, 300); }
      card = null;
    }
    document.addEventListener('pointermove', function (e) {
      var c = e.target.closest && e.target.closest('.hc, .item');
      if (c === card) return;
      stop();
      var v = c && c.querySelector('video.clip');
      if (!v) return;
      card = c;
      v.playbackRate = CLIP_SPEED;
      v.classList.add('on');
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* not loaded yet; the photo stays */ });
    }, { passive: true });
    document.addEventListener('pointerleave', stop);
  }

  // ---------- farm photos & videos: full-screen viewer ----------
  var LB = { i: 0, tiles: [] };
  function openGallery(tile) {
    LB.tiles = [].slice.call(document.querySelectorAll('#gallery .g-tile'));
    LB.i = Math.max(0, LB.tiles.indexOf(tile));
    var box = $('lightbox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'lightbox';
      box.className = 'lightbox';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.innerHTML = '<button class="lb-x" data-lb="close" aria-label="Close">×</button>' +
        '<button class="lb-nav prev" data-lb="-1" aria-label="Previous">‹</button><div class="lb-stage" id="lbStage"></div>' +
        '<button class="lb-nav next" data-lb="1" aria-label="Next">›</button>';
      box.addEventListener('click', function (e) {
        var b = e.target.closest('[data-lb]');
        if (b) { b.dataset.lb === 'close' ? closeGallery() : showGallery(LB.i + Number(b.dataset.lb)); }
        else if (e.target === box) closeGallery();
      });
      document.body.appendChild(box);
    }
    box.hidden = false;
    document.body.style.overflow = 'hidden';
    showGallery(LB.i);
  }
  function showGallery(i) {
    var n = LB.tiles.length;
    LB.i = (i + n) % n;
    var t = LB.tiles[LB.i], v = t.querySelector('video'), img = t.querySelector('img'), ph = t.querySelector('.g-ph');
    var cap = t.querySelector('figcaption').textContent;
    $('lbStage').innerHTML = (v ? '<video src="' + esc(v.getAttribute('src')) + '" controls autoplay playsinline></video>'
      : img ? '<img src="' + esc(img.getAttribute('src')) + '" alt="' + esc(cap) + '">'
      : '<div class="lb-ph ' + esc(t.className.replace('g-tile', '')) + '">' + ph.innerHTML + '</div>') +
      '<div class="lb-cap">' + esc(cap) + '<span>' + (LB.i + 1) + ' / ' + n + '</span></div>';
  }
  function closeGallery() {
    var box = $('lightbox');
    if (!box || box.hidden) return;
    box.hidden = true;
    $('lbStage').innerHTML = '';   // stops a playing video
    document.body.style.overflow = '';
  }
  document.addEventListener('keydown', function (e) {
    var box = $('lightbox');
    if (!box || box.hidden) return;
    if (e.key === 'Escape') closeGallery();
    else if (e.key === 'ArrowRight') showGallery(LB.i + 1);
    else if (e.key === 'ArrowLeft') showGallery(LB.i - 1);
  });

  // ---------- header: blends with the section under it ----------
  // Clear over the top of the hero photo; once scrolled, glass in the colour of the section beneath
  // (data-tone="dark" / "light" in index.html), with the light logo over dark sections.
  var headRaf = 0;
  function updateHeader() {
    headRaf = 0;
    var top = $('top');
    if (VIEW !== 'shop') { top.className = 'top solid'; return; }
    var mid = top.offsetHeight / 2, tone = 'dark', under = null;
    var secs = document.querySelectorAll('[data-tone]');
    for (var i = 0; i < secs.length; i++) {
      var r = secs[i].getBoundingClientRect();
      if (r.height && r.top <= mid && r.bottom > mid) { tone = secs[i].dataset.tone; under = secs[i]; break; }
    }
    top.className = 'top' + (tone === 'dark' ? ' dark' : '') + (window.scrollY > 8 ? ' scrolled' : '');
    // Glass in the section's own colour (solid-colour sections; the photo/gradient ones keep the default dark glass)
    var m = under && /^rgb\((\d+), (\d+), (\d+)\)$/.exec(getComputedStyle(under).backgroundColor);
    if (m) top.style.setProperty('--glass', 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',.86)');
    else top.style.removeProperty('--glass');
  }
  function queueHeader() { if (!headRaf) headRaf = requestAnimationFrame(updateHeader); }
  window.addEventListener('scroll', queueHeader, { passive: true });
  window.addEventListener('resize', queueHeader);

  // ---------- routing ----------
  function route() {
    var h = location.hash;
    var rate = /^#review-(.+)$/.exec(h);
    VIEW = h === '#orders' ? 'orders' : h === '#done' ? 'done' : 'shop';
    ['shop', 'orders', 'done'].forEach(function (v) { $('view-' + v).classList.toggle('on', v === VIEW); });
    $('landing').hidden = $('subscribe').hidden = VIEW !== 'shop';
    document.body.dataset.view = VIEW;
    if (sheetMode) closeSheet();
    if (VIEW === 'orders') showOrders();
    if (VIEW === 'done') renderDone();
    if (rate) {
      // Open the review form over the shop, and drop the #review link so a reload doesn't reopen it.
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* old browser */ }
      openRate(decodeURIComponent(rate[1]));
    }
    if (h === '#edit') {   // the owner's way into edit mode (sreshtafresh.com/#edit)
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* old browser */ }
      startEdit();
    }
    updateBasketBar();
    window.scrollTo(0, 0);
    updateHeader();
  }

  // ---------- edit mode (owner only): change text, pictures, colours and tile order right on the page ----------
  // Opened with #edit and the main user's PIN. Changes are a draft (shown live to the owner only) until Publish.
  var ED = { auth: null, published: null, dirty: false, drag: null };
  function clone(o) { return JSON.parse(JSON.stringify(o || {})); }
  function draftSet(kind, key, value) {
    SITE[kind] = SITE[kind] || {};
    if (value === null || value === '') delete SITE[kind][key]; else SITE[kind][key] = value;
    ED.dirty = true;
    edBar();
  }
  function startEdit() {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('sf_edit') || 'null'); } catch (e) { saved = null; }
    if (saved) return apiPost({ action: 'siteLogin', pin: saved.pin, name: saved.name }).then(function (r) {
      if (r.ok) enterEdit(saved); else editLogin(r.error);
    }).catch(function () { editLogin('We couldn\'t reach the shop. Check your internet.'); });
    editLogin('');
  }
  function editLogin(msg) {
    sheetMode = 'edit';
    showSheet('<div class="sheet-head"><h2>✏️ Edit the website</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
      '<div class="card"><div class="hint" style="margin:0 0 12px">For the shop owner. Enter the main user PIN (Google Sheet → Settings → ADMIN_PIN).</div>' +
      '<div class="field"><label for="ed-name">Your name</label><input id="ed-name" autocomplete="name"></div>' +
      '<div class="field"><label for="ed-pin">PIN</label><input id="ed-pin" type="password" inputmode="numeric" autocomplete="off"></div>' +
      (msg ? '<div class="note err" style="margin:0 0 12px">' + esc(msg) + '</div>' : '') + '</div>' +
      '<button class="btn gold big wide" data-act="edGo">Start editing</button>');
    setTimeout(function () { if ($('ed-pin')) $('ed-pin').focus(); }, 50);
  }
  function editLoginGo(btn) {
    var a = { name: $('ed-name').value.trim() || 'Owner', pin: $('ed-pin').value.trim() };
    if (!a.pin) return toast('Enter the PIN.', true);
    btn.disabled = true;
    apiPost({ action: 'siteLogin', pin: a.pin, name: a.name }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) return editLogin(r.error);
      try { sessionStorage.setItem('sf_edit', JSON.stringify(a)); } catch (e) { /* private mode: ask again next time */ }
      enterEdit(a);
    }).catch(function () { btn.disabled = false; toast('We couldn\'t reach the shop. Check your internet.', true); });
  }
  function enterEdit(auth) {
    ED.auth = auth;
    ED.published = clone(SITE);
    EDITING = true;
    ED.dirty = false;
    closeSheet();
    if (VIEW !== 'shop') location.hash = '';
    document.body.classList.add('editing');
    redrawAll();
    edBar();
    toast('✏️ Edit mode: click text to type, use 📷 🎨 ⠿ on pictures and tiles, then Publish.');
  }
  function exitEdit(force) {
    if (ED.dirty && !force && !confirm('You have changes that aren\'t published. Leave edit mode and throw them away?')) return;
    EDITING = false;
    document.body.classList.remove('editing');
    if ($('edBar')) $('edBar').remove();
    [].forEach.call(document.querySelectorAll('.ed-tools'), function (el) { el.remove(); });
    applySite(ED.published);
    redrawAll();
  }
  function redrawAll() {
    applySite(SITE);
    BENTO_SIG = MOSAIC_SIG = '';
    if (CAT) renderShop();
  }
  /** The floating toolbar at the bottom while editing. */
  function edBar() {
    if (!EDITING) return;
    var bar = $('edBar');
    if (!bar) { bar = document.createElement('div'); bar.id = 'edBar'; bar.className = 'ed-bar'; document.body.appendChild(bar); }
    bar.innerHTML = '<span class="ed-st">✏️ Editing' + (ED.dirty ? ' · <b>unpublished changes</b>' : ' · all published') + '</span>' +
      '<button data-act="edHistory">History</button>' +
      '<button data-act="edDiscard"' + (ED.dirty ? '' : ' disabled') + '>Discard</button>' +
      '<button class="pub" data-act="edPublish"' + (ED.dirty ? '' : ' disabled') + '>Publish</button>' +
      '<button data-act="edExit">Exit</button>';
  }
  /** The local test serves uploaded pictures as data: links; the shop stores the real links. */
  function realLinks(o) { return window.SFLocal && SFLocal.unphoto ? JSON.parse(SFLocal.unphoto(JSON.stringify(o))) : o; }
  function edPublish(btn) {
    var note = prompt('Publish these changes to the live website? (optional) What did you change?', '');
    if (note === null) return;
    btn.disabled = true;
    apiPost({ action: 'saveSite', pin: ED.auth.pin, name: ED.auth.name, note: note, content: realLinks(SITE) }).then(function (r) {
      if (!r.ok) { btn.disabled = false; return toast(r.error, true); }
      ED.published = clone(SITE);
      ED.dirty = false;
      edBar();
      toast('✅ Published (' + r.site.version + '). Everyone sees it now.');
    }).catch(function () { btn.disabled = false; toast('We couldn\'t reach the shop. Nothing was published.', true); });
  }
  function edDiscard() {
    if (!confirm('Throw away the changes you haven\'t published?')) return;
    SITE = clone(ED.published);
    ED.dirty = false;
    redrawAll();
    edBar();
  }
  function edHistory() {
    apiPost({ action: 'siteHistory', pin: ED.auth.pin, name: ED.auth.name }).then(function (r) {
      if (!r.ok) return toast(r.error, true);
      sheetMode = 'info';
      showSheet('<div class="sheet-head"><h2>🕘 Published versions</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' +
        '<div class="hint" style="margin:0 0 12px">The newest is live. Going back publishes that version again, so it can be undone too.</div>' +
        (r.history.length ? r.history.map(function (h, i) {
          return '<div class="card ed-ver"><div><b>' + esc(h.savedAt) + '</b>' + (i === 0 ? ' <span class="chip">Live</span>' : '') +
            '<div class="hint" style="margin:2px 0 0">' + esc(h.savedBy) + (h.note ? ' · ' + esc(h.note) : '') + '</div></div>' +
            (i === 0 ? '' : '<button class="btn ghost" data-act="edRestore" data-v="' + esc(h.version) + '">Go back to this</button>') + '</div>';
        }).join('') : '<div class="empty">Nothing published yet.</div>'));
    }).catch(function () { toast('We couldn\'t reach the shop.', true); });
  }
  function edRestore(v) {
    if (ED.dirty && !confirm('This throws away your unpublished changes. Go back to this version?')) return;
    apiPost({ action: 'restoreSite', version: v, pin: ED.auth.pin, name: ED.auth.name }).then(function (r) {
      if (!r.ok) return toast(r.error, true);
      SITE = clone(r.site.content);
      ED.published = clone(SITE);
      ED.dirty = false;
      closeSheet();
      redrawAll();
      edBar();
      toast('↩️ Back to the earlier version. It\'s live now.');
    });
  }

  /** Controls on everything that can change: 📷 picture, 🎨 colour (and ↺ back to default), ⠿ move for tiles. */
  function decorate() {
    var add = function (el, o) {
      if (!el || el.querySelector(':scope > .ed-tools')) return;
      var h = '<div class="ed-tools">';
      if (o.move) h += '<button type="button" class="ed-move" data-ed="move" title="Drag to another spot">⠿ Move</button>';
      if (o.img) h += '<button type="button" data-ed="img" data-k="' + o.img + '" title="Change the picture">📷</button>';
      if (o.color) h += '<label class="ed-col" title="Change the colour">🎨<input type="color" data-ed="color" data-k="' + o.color + '" value="' + edHex(siteColor(o.color)) + '"></label>';
      if ((o.img && siteImg(o.img, '')) || (o.color && siteColor(o.color))) h += '<button type="button" data-ed="reset" data-img="' + (o.img || '') + '" data-col="' + (o.color || '') + '" title="Back to the original">↺</button>';
      el.insertAdjacentHTML('beforeend', h + '</div>');
    };
    add($('hero'), { img: 'hero.bg' });
    [].forEach.call(document.querySelectorAll('[data-color]'), function (el) { add(el, { color: 'section.' + el.dataset.color }); });
    [].forEach.call(document.querySelectorAll('#bento .bt'), function (el) { add(el, { move: 1, img: 'bento.' + el.dataset.tile, color: 'bento.' + el.dataset.tile }); });
    [].forEach.call(document.querySelectorAll('#mosaic .mz'), function (el) {
      var id = el.dataset.tile;
      add(el, { move: 1, img: /^photo/.test(id) ? 'mosaic.' + id : '', color: /^(seed|soil|care|harvest)$/.test(id) ? 'mosaic.' + id : '' });
    });
  }
  function edHex(c) { return /^#[0-9a-f]{6}$/i.test(c) ? c : '#f8b226'; }
  function edRedraw() { BENTO_SIG = MOSAIC_SIG = ''; applySite(SITE); renderShop(); }

  /** Picture: shrink it on the device (keeps PNG see-through backgrounds), upload, and use the new link. */
  function edPickImage(key) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = function () {
      var file = inp.files && inp.files[0];
      if (!file) return;
      var img = new Image(), url = URL.createObjectURL(file), png = /png|webp/.test(file.type);
      img.onload = function () {
        var max = png ? 1400 : 1800, k = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        toast('Uploading the picture…');
        apiPost({ action: 'uploadSiteImage', pin: ED.auth.pin, name: ED.auth.name, file: key,
          dataUrl: png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.86) }).then(function (r) {
          if (!r.ok) return toast(r.error, true);
          draftSet('img', key, r.image.url);
          edRedraw();
          toast('📷 Picture changed. Publish to put it live.');
        }).catch(function () { toast('The picture didn\'t upload. Check your internet.', true); });
      };
      img.src = url;
    };
    inp.click();
  }

  /** Tiles: drag the ⠿ handle onto another tile in the same grid to swap them. */
  function edDragStart(e, handle) {
    var tile = handle.closest('.bt, .mz'), grid = tile && tile.parentNode;
    if (!tile) return;
    e.preventDefault();
    var r = tile.getBoundingClientRect(), ghost = tile.cloneNode(true);
    ghost.className += ' ed-ghost';
    ghost.style.cssText = 'width:' + r.width + 'px;height:' + r.height + 'px;left:' + r.left + 'px;top:' + r.top + 'px';
    document.body.appendChild(ghost);
    tile.classList.add('ed-lifted');
    ED.drag = { tile: tile, grid: grid, ghost: ghost, dx: e.clientX - r.left, dy: e.clientY - r.top, over: null };
  }
  function edDragMove(e) {
    var d = ED.drag;
    if (!d) return;
    d.ghost.style.left = (e.clientX - d.dx) + 'px';
    d.ghost.style.top = (e.clientY - d.dy) + 'px';
    d.ghost.style.visibility = 'hidden';
    var under = document.elementFromPoint(e.clientX, e.clientY);
    d.ghost.style.visibility = '';
    var t = under && under.closest('.bt, .mz');
    t = t && t.parentNode === d.grid && t !== d.tile ? t : null;
    if (d.over !== t) {
      if (d.over) d.over.classList.remove('ed-target');
      if (t) t.classList.add('ed-target');
      d.over = t;
    }
  }
  function edDragEnd() {
    var d = ED.drag;
    if (!d) return;
    ED.drag = null;
    d.ghost.remove();
    d.tile.classList.remove('ed-lifted');
    if (!d.over) return;
    d.over.classList.remove('ed-target');
    var key = d.grid.id === 'bento' ? 'bento' : 'mosaic', order = siteOrder(key, key === 'bento' ? BENTO_TILES : MOSAIC_TILES);
    var a = order.indexOf(d.tile.dataset.tile), b = order.indexOf(d.over.dataset.tile);
    if (a < 0 || b < 0) return;
    order[a] = d.over.dataset.tile; order[b] = d.tile.dataset.tile;
    // The two tiles glide to their new spots (GSAP Flip matches old and new tiles by their name).
    var named = function () { [].forEach.call(d.grid.children, function (el) { el.dataset.flipId = el.dataset.tile; }); };
    named();
    var flip = G && window.Flip && !CALM ? Flip.getState(d.grid.children) : null;
    draftSet('order', key, order);
    edRedraw();
    named();
    if (flip) Flip.from(flip, { targets: d.grid.children, duration: .5, ease: 'power2.inOut' });
  }
  document.addEventListener('pointermove', edDragMove);
  document.addEventListener('pointerup', edDragEnd);

  // Clicking text while editing types into it instead of following the button or link it's in.
  document.addEventListener('click', function (e) {
    if (!EDITING) return;
    var ed = e.target.closest('[data-edit],[data-ek]');
    if (!ed || e.target.closest('.ed-tools')) return;
    e.preventDefault();
    e.stopPropagation();
    if (ed.contentEditable !== 'true') { ed.contentEditable = 'true'; ed.focus(); }
  }, true);
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!EDITING || !el.isContentEditable) return;
    if (el.dataset.edit) draftSet('text', el.dataset.edit, el.innerHTML.replace(/<(?!\/?(em|b|strong|i|br)\s*\/?>)[^>]*>/gi, ''));
    else if (el.dataset.ek) draftSet('text', el.dataset.ek, el.textContent.trim());
  });
  document.addEventListener('focusout', function (e) { if (e.target.isContentEditable) e.target.contentEditable = 'false'; });
  document.addEventListener('keydown', function (e) {
    if (EDITING && e.target.isContentEditable && e.key === 'Enter' && e.target.dataset.ek) { e.preventDefault(); e.target.blur(); }
  });
  document.addEventListener('paste', function (e) {   // paste as plain text, never formatting from other sites
    if (!EDITING || !e.target.isContentEditable) return;
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
  });
  document.addEventListener('pointerdown', function (e) {
    var h = EDITING && e.target.closest('[data-ed="move"]');
    if (h) edDragStart(e, h);
  });
  document.addEventListener('change', function (e) {
    if (EDITING && e.target.dataset.ed === 'color') { draftSet('color', e.target.dataset.k, e.target.value); edRedraw(); }
  });
  document.addEventListener('click', function (e) {
    var b = EDITING && e.target.closest('[data-ed]');
    if (!b || b.dataset.ed === 'move' || b.dataset.ed === 'color') return;
    e.preventDefault();
    e.stopPropagation();
    if (b.dataset.ed === 'img') edPickImage(b.dataset.k);
    if (b.dataset.ed === 'reset') {
      if (b.dataset.img) draftSet('img', b.dataset.img, null);
      if (b.dataset.col) draftSet('color', b.dataset.col, null);
      edRedraw();
    }
  }, true);
  window.addEventListener('beforeunload', function (e) { if (EDITING && ED.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- events ----------
  // Phone side menu with the category links.
  function showNav(open) {
    document.body.classList.toggle('nav-open', open);
    $('menuBtn').setAttribute('aria-expanded', String(open));
  }
  $('menuBtn').addEventListener('click', function () { showNav(!document.body.classList.contains('nav-open')); });
  $('navShade').addEventListener('click', function () { showNav(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { showNav(false); showSearch(false); }
    if (e.key === 'Enter' && e.target.id === 'bk-cp') { e.preventDefault(); applyCoupon(e.target.nextElementSibling); }
  });
  $('nav').addEventListener('click', function (e) {
    var a = e.target.closest('a');
    if (!a) return;
    showNav(false);
    if (a.dataset.nav === 'subscribe') {   // a section of the shop page, not a page of its own
      e.preventDefault();
      if (VIEW !== 'shop') location.hash = '';
      setTimeout(function () { $('subscribe').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
    }
  });

  // ---------- header search: filters the produce list as you type ----------
  function showSearch(open) {
    $('searchForm').classList.toggle('open', open);
    $('searchBtn').setAttribute('aria-expanded', String(open));
    if (open) setTimeout(function () { $('searchIn').focus(); }, 50);
  }
  function runSearch(jump) {
    SEARCH = $('searchIn').value;
    if (VIEW !== 'shop') location.hash = '';
    if (CAT) renderGrid();
    if (jump) $('view-shop').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('searchBtn').addEventListener('click', function () {
    var open = !$('searchForm').classList.contains('open');
    if (!open && $('searchIn').value.trim()) return runSearch(true);   // second tap with text: go to the results
    showSearch(open);
  });
  var searchJumped = false;
  $('searchIn').addEventListener('input', function () {
    runSearch(!searchJumped && !!this.value.trim());   // bring the results into view on the first letter typed
    searchJumped = !!this.value.trim();
  });
  $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); runSearch(true); $('searchIn').blur(); });
  $('searchIn').addEventListener('blur', function () { if (!this.value.trim()) showSearch(false); });

  // ---------- share: the phone's share sheet, or copy the link ----------
  $('shareBtn').addEventListener('click', function () {
    var data = { title: 'Sreshta Fresh', text: 'Fresh veggies, eggs and country chicken from Sreshta Farms', url: location.origin + location.pathname };
    if (navigator.share) { navigator.share(data).catch(function () { /* closed the share sheet */ }); return; }
    var done = function () { toast('Link copied. Paste it anywhere to share.'); };
    if (navigator.clipboard) navigator.clipboard.writeText(data.url).then(done, function () { prompt('Copy this link:', data.url); });
    else prompt('Copy this link:', data.url);
  });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-cat],[data-fv],[data-slide],[data-sk],[data-spot]');
    if (t && t.dataset.slide) { showSlide(Number(t.dataset.slide)); return; }
    if (t && t.dataset.sk) {   // weekly plan choice: kind|key|value
      var sk = t.dataset.sk.split('|');
      SUB[sk[0]][sk[1]] = sk[1] === 'day' ? sk[2] : Number(sk[2]);
      renderSubs();
      return;
    }
    if (!t) {
      if (e.target === $('sheetWrap')) closeSheet();
      return;
    }
    if (t.dataset.spot) { SPOT.auto = false; showSpot(t.dataset.spot); return; }   // picked by hand: stop the auto-advance
    if (t.dataset.cat) {
      showNav(false);
      // Remember where each card is, so after the filter they glide to their new places (GSAP Flip).
      var flipFrom = G && window.Flip && !CALM && VIEW === 'shop' && t.dataset.cat !== FILTER ? Flip.getState('#grid .item') : null;
      FILTER = t.dataset.cat;
      if (VIEW !== 'shop') location.hash = '';
      if (CAT) renderShop();
      if (flipFrom) shuffleGrid(flipFrom);
      if (t.closest('#nav')) $('view-shop').scrollIntoView({ behavior: 'smooth', block: 'start' });   // picked from the menu
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
    if (act === 'add') addPack(key, t);
    else if (act === 'gallery') openGallery(t);
    else if (act === 'subGo') openSubscribe(t.dataset.sub);
    else if (act === 'subPay') payPlan(t.dataset.sub, t);
    else if (act === 'planPause') changePlanWeek(t, true);
    else if (act === 'planResume') changePlanWeek(t, false);
    else if (act === 'shopAll') $('view-shop').scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (act === 'basket') openBasket();
    else if (act === 'inc') { var a = itemByKey(key); if (a) setQty(key, (CART[key] || 0) + basketStep(a)); }
    else if (act === 'dec') { var b = itemByKey(key); if (b) setQty(key, (CART[key] || 0) - basketStep(b)); }
    else if (act === 'close') closeSheet();
    else if (act === 'coupon') applyCoupon(t);
    else if (act === 'edGo') editLoginGo(t);
    else if (act === 'edPublish') edPublish(t);
    else if (act === 'edDiscard') edDiscard();
    else if (act === 'edHistory') edHistory();
    else if (act === 'edRestore') edRestore(t.dataset.v);
    else if (act === 'edExit') exitEdit(false);
    else if (act === 'story') playStory();
    else if (act === 'storyX') stopStory();
    else if (act === 'couponX') { FORM.coupon = null; FORM.reqId = ''; renderBasketLines(); }
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
  setupReveal();
  introHeadline();
  if ($('spot')) {   // the spotlight section is saved for later (commented out in index.html)
    $('spot').addEventListener('mouseenter', function () { SPOT.hover = true; });   // no auto-advance while reading
    $('spot').addEventListener('mouseleave', function () { SPOT.hover = false; });
  }
  setupHoverClips();
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
