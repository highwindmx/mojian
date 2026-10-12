(function () {
  'use strict';

  var tip = null;
  var timer = null;
  var current = null;
  var DELAY = 320;

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'mtip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tip);
    return tip;
  }

  function tipText(el) {
    var t = el.getAttribute('data-tip');
    if (t == null || t.trim() === '') return null;
    return t;
  }

  function place(el) {
    var r = el.getBoundingClientRect();
    var box = ensureTip();
    box.textContent = tipText(el);
    box.classList.add('show');
    box.setAttribute('aria-hidden', 'false');
    var tr = box.getBoundingClientRect();
    var x = r.left + r.width / 2 - tr.width / 2;
    var y = r.top - tr.height - 8;
    if (y < 4) y = r.bottom + 8;
    if (x < 4) x = 4;
    if (x + tr.width > window.innerWidth - 4) x = window.innerWidth - tr.width - 4;
    box.style.left = Math.round(x) + 'px';
    box.style.top = Math.round(y) + 'px';
  }

  function show(el) {
    var t = tipText(el);
    if (!t) return;
    hide();
    current = el;
    timer = setTimeout(function () { place(el); }, DELAY);
  }

  function hide() {
    if (timer) { clearTimeout(timer); timer = null; }
    current = null;
    if (tip) { tip.classList.remove('show'); tip.setAttribute('aria-hidden', 'true'); }
  }

  function targetOf(node) {
    while (node && node !== document) {
      if (node.hasAttribute && node.hasAttribute('data-tip')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function init() {
    document.addEventListener('mouseover', function (e) {
      var el = targetOf(e.target);
      if (el) show(el);
    });
    document.addEventListener('mouseout', function (e) {
      var el = targetOf(e.target);
      if (!el) return;
      var to = e.relatedTarget;
      if (to && el.contains(to)) return;
      hide();
    });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) hide();
    });
  }

  window.MJTooltip = { show: show, hide: hide };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
