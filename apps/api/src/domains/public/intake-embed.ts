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

  function mount(el) {
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
    frame.src = origin + '/intake/' + encodeURIComponent(token) + '?' + params.join('&');
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
      }
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
  window.ordiIntake = { mount: mountAll };
})();
`;
