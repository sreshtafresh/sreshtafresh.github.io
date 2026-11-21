/* Shop contact details (address, phone, email) on the pages outside the main shop: contact, policies, payment.
 * They're edited in edit mode on the main page (footer) and published with the rest of the site content.
 * Shows the copy the main page saved in this browser straight away, then the latest from the shop.
 * Elements: [data-contact="address|phone|email"] get the text; a[data-tel] / a[data-mail] get the links. */
(function () {
  function plain(s) { var d = document.createElement('div'); d.innerHTML = String(s); return (d.textContent || '').trim(); }
  function apply(text) {
    text = text || {};
    ['address', 'phone', 'email'].forEach(function (k) {
      var v = text['contact.' + k];
      if (v == null || !plain(v)) return;
      [].forEach.call(document.querySelectorAll('[data-contact="' + k + '"]'), function (el) { el.textContent = plain(v); });
    });
    links();
  }
  function links() {
    var ph = document.querySelector('[data-contact="phone"]'), em = document.querySelector('[data-contact="email"]');
    var digits = ph ? ph.textContent.replace(/\D/g, '') : '';
    if (digits.length === 10) digits = '91' + digits;
    [].forEach.call(document.querySelectorAll('a[data-tel]'), function (a) { if (digits) a.href = 'tel:+' + digits; });
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
