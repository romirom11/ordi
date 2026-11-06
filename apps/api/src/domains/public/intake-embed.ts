/**
 * The intake embed loader, served at /api/v1/embed/intake.js (and /embed/…).
 *
 * A site pastes
 *
 *   <div data-ordi-intake="FORM_TOKEN"></div>
 *   <script src="https://ordi.example.com/api/v1/embed/intake.js" async></script>
 *
 * and gets the form in an iframe. The iframe points at the app's own
 * /intake/:token?embed=1 page, whose origin the loader takes from its own
 * src, so one script works for every instance. The page reports its height
 * (and a finished submission) by postMessage. Messages are matched to their
 * iframe by source window and accepted from the app's origin only.
 *
 * Options, as attributes on the container: data-theme (light | dark | auto),
 * data-lang (en | uk), data-min-height (px, before the first resize), and
 * data-title (the iframe's accessible name). The container fires a bubbling
 * `ordi:intake-submitted` event when a request goes through.
 *
 * Prefill: `data-prefill-<key>` attributes (or `values` passed to
 * `ordiIntake.mount(el, { values })`) fill the form's fields – the visitor's
 * name and email from the site's own session, a hidden field's value.
 * `data-lock-prefilled` makes the prefilled visible fields read-only. They
 * travel in the iframe URL's fragment, which never reaches a server or a
 * Referer header. The page's own address goes along too, for a hidden field
 * whose source is the page, and is asked for again at submit time (a
 * single-page site may have moved on since the form loaded).
 *
 * Plain ES5 on purpose: it runs on someone else's page, untranspiled.
 */
export const INTAKE_EMBED_SCRIPT = `(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) {
    var all = document.querySelectorAll('script[src*="/embed/intake.js"]');
    script = all[all.length - 1];
  }
  if (!script) return;
  var origin = new URL(script.src, window.location.href).origin;
  var frames = [];

  function pageAddress() {
    return window.location.href.split('#')[0];
  }

  /** data-prefill-order-id="7" → { orderId: '7' }; the form matches keys loosely. */
  function prefillOf(el, values) {
    var out = {};
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name.indexOf('data-prefill-') !== 0) continue;
      var key = name.slice(13).replace(/-([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
      if (key) out[key] = attrs[i].value;
    }
    if (values && typeof values === 'object') {
      for (var k in values) {
        if (Object.prototype.hasOwnProperty.call(values, k) && values[k] != null) out[k] = String(values[k]);
      }
    }
    return out;
  }

  function fragment(el, values) {
    var parts = [];
    var prefill = prefillOf(el, values);
    for (var key in prefill) {
      if (Object.prototype.hasOwnProperty.call(prefill, key) && key.charAt(0) !== '_') {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(prefill[key]));
      }
    }
    var lock = el.getAttribute('data-lock-prefilled');
    if (lock !== null && lock !== 'false') parts.push('_lock=1');
    parts.push('_page=' + encodeURIComponent(pageAddress()));
    return parts.join('&');
  }

  function mount(el, options) {
    if (el.getAttribute('data-ordi-mounted')) return;
    var token = el.getAttribute('data-ordi-intake');
    if (!token) return;
    el.setAttribute('data-ordi-mounted', '1');
    var params = ['embed=1'];
    var theme = el.getAttribute('data-theme');
    if (theme) params.push('theme=' + encodeURIComponent(theme));
    var lang = el.getAttribute('data-lang');
    if (lang) params.push('lang=' + encodeURIComponent(lang));
    var frame = document.createElement('iframe');
    frame.src = origin + '/intake/' + encodeURIComponent(token) + '?' + params.join('&') + '#' + fragment(el, options && options.values);
    frame.title = el.getAttribute('data-title') || 'Request form';
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('allowtransparency', 'true');
    var minHeight = parseInt(el.getAttribute('data-min-height') || '', 10) || 520;
    frame.style.cssText = 'display:block;width:100%;border:0;background:transparent;overflow:hidden;height:' + minHeight + 'px';
    el.appendChild(frame);
    frames.push({ frame: frame, container: el });
  }

  function mountAll() {
    var nodes = document.querySelectorAll('[data-ordi-intake]');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  /** ordiIntake.mount() – every container; ordiIntake.mount(el or selector, { values }) – that one. */
  function mountApi(target, options) {
    if (!target) return mountAll();
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (el) mount(el, options);
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== origin) return;
    var data = event.data;
    if (!data || data.source !== 'ordi-intake') return;
    for (var i = 0; i < frames.length; i++) {
      var entry = frames[i];
      if (entry.frame.contentWindow !== event.source) continue;
      if (data.type === 'resize' && typeof data.height === 'number' && data.height > 0) {
        entry.frame.style.height = Math.ceil(data.height) + 'px';
      } else if (data.type === 'submitted') {
        var ev;
        try {
          ev = new CustomEvent('ordi:intake-submitted', { bubbles: true });
        } catch (e) {
          ev = document.createEvent('CustomEvent');
          ev.initCustomEvent('ordi:intake-submitted', true, false, null);
        }
        entry.container.dispatchEvent(ev);
      } else if (data.type === 'context-request') {
        entry.frame.contentWindow.postMessage({ source: 'ordi-intake-host', type: 'context', id: data.id, page: pageAddress() }, origin);
      }
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
  window.ordiIntake = { mount: mountApi };
})();
`;
