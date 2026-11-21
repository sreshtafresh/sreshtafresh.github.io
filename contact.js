/* Footer and contact details on the pages outside the main shop: contact, policies, payment.
 * They're edited in edit mode on the main page (footer) and published with the rest of the site content.
 * Shows the copy the main page saved in this browser straight away, then the latest from the shop.
 * [data-contact="address|phone|email"] → text "contact.<name>"; [data-contact="footer.tagline"] → that key as is.
 * a[data-tel] / a[data-mail] / a[data-wa] get call, email and WhatsApp links from the phone and email text. */
(function () {
  function plain(s) { var d = document.createElement('div'); d.innerHTML = String(s); return (d.textContent || '').trim(); }
  function apply(text) {
    text = text || {};
    [].forEach.call(document.querySelectorAll('[data-contact]'), function (el) {
      var k = el.dataset.contact, v = text[k.indexOf('.') < 0 ? 'contact.' + k : k];
      if (v != null && plain(v)) el.textContent = plain(v);
    });
    links();
  }
  function links() {
    var ph = document.querySelector('[data-contact="phone"]'), em = document.querySelector('[data-contact="email"]');
    var digits = ph ? ph.textContent.replace(/\D/g, '') : '';
    if (digits.length === 10) digits = '91' + digits;
    [].forEach.call(document.querySelectorAll('a[data-tel]'), function (a) { if (digits) a.href = 'tel:+' + digits; });
    [].forEach.call(document.querySelectorAll('a[data-wa]'), function (a) { if (digits) a.href = 'https://wa.me/' + digits; });
    [].forEach.call(document.querySelectorAll('a[data-mail]'), function (a) { if (em && /@/.test(em.textContent)) a.href = 'mailto:' + em.textContent.trim(); });
  }
  try { var s = JSON.parse(localStorage.getItem('sf_site')); apply(s && s.text); } catch (e) { /* nothing saved */ }
  var api = (window.SF_CONFIG || {}).API_URL;
  if (!api || api === 'local' || /PASTE_/.test(api) || !window.fetch) return;
  fetch(api + (api.indexOf('?') < 0 ? '?' : '&') + 'api=catalog').then(function (r) { return r.json(); }).then(function (r) {
    var site = (r && r.data && r.data.site) || (r && r.site);
    if (site) apply(site.text);
  }).catch(function () { /* keep what's shown */ });
})();
