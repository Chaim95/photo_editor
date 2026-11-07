/* Small UI toolkit: DOM helpers, icons, toasts, modals and confirm dialogs. */
(function (MG) {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function el(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = [].concat(arguments[i]);
      for (const c of kids) {
        if (c == null || c === false) continue;
        n.append(c.nodeType ? c : document.createTextNode(String(c)));
      }
    }
    return n;
  }

  const svg = (body, extra) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '>' + body + '</svg>';
  const ICONS = {
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    images: svg('<rect x="3" y="5" width="14" height="12" rx="2"/><path d="M7 21h12a2 2 0 0 0 2-2V9"/><circle cx="8" cy="9.5" r="1.5"/><path d="M17 14l-4-4-7 7"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    frame: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="7" width="10" height="10" rx="1"/>'),
    printer: svg('<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>'),
    rotL: svg('<path d="M4 4v6h6"/><path d="M4.5 13a8 8 0 1 0 2-8.3L4 10"/>'),
    rotR: svg('<path d="M20 4v6h-6"/><path d="M19.5 13a8 8 0 1 1-2-8.3L20 10"/>'),
    center: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
    reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    zoomIn: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>'),
    zoomOut: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>'),
    chevL: svg('<path d="M15 18l-6-6 6-6"/>'),
    chevR: svg('<path d="M9 18l6-6-6-6"/>'),
    alert: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>'),
    help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>'),
    upload: svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>'),
    swap: svg('<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>'),
    sparkle: svg('<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/>')
  };

  function icon(name) {
    const s = document.createElement('span');
    s.className = 'ico';
    s.innerHTML = ICONS[name] || '';
    return s;
  }

  /* ---------- toasts ---------- */
  function toast(message, kind, ms) {
    const host = $('#toasts');
    if (!host) return;
    const t = el('div', { class: 'toast toast-' + (kind || 'info'), role: 'status' }, message);
    host.append(t);
    requestAnimationFrame(() => t.classList.add('show'));
    const kill = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); };
    const timer = setTimeout(kill, ms || 3800);
    t.addEventListener('click', () => { clearTimeout(timer); kill(); });
  }

  /* ---------- modals ---------- */
  const stack = [];
  function openModal(node, opts) {
    opts = opts || {};
    node.hidden = false;
    node.classList.add('open');
    stack.push({ node, onRequestClose: opts.onRequestClose, restore: document.activeElement });
    document.body.classList.add('modal-open');
    const f = node.querySelector('[data-autofocus]') || node.querySelector('button, [tabindex]');
    if (f) setTimeout(() => f.focus({ preventScroll: true }), 30);
  }
  function closeModal(node) {
    const i = stack.findIndex((m) => m.node === node);
    if (i === -1) return;
    const m = stack.splice(i, 1)[0];
    node.classList.remove('open');
    node.hidden = true;
    if (!stack.length) document.body.classList.remove('modal-open');
    if (m.restore && m.restore.focus && document.contains(m.restore)) m.restore.focus({ preventScroll: true });
  }
  function topModal() {
    return stack.length ? stack[stack.length - 1].node : null;
  }
  function requestClose(entry) {
    if (entry.onRequestClose) entry.onRequestClose(); else closeModal(entry.node);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stack.length) {
      e.preventDefault();
      e.stopPropagation();
      requestClose(stack[stack.length - 1]);
    }
  }, true);
  document.addEventListener('mousedown', (e) => {
    const top = stack[stack.length - 1];
    if (top && e.target === top.node && top.node.dataset.backdropClose !== 'false') requestClose(top);
  });

  /** Promise-based dialog. buttons: [{label, value, variant}] */
  function confirmDialog(o) {
    return new Promise((resolve) => {
      const wrap = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
      const done = (v) => { closeModal(wrap); wrap.remove(); resolve(v); };
      const btns = (o.buttons || [{ label: 'אישור', value: true, variant: 'primary' }]).map((b, i) =>
        el('button', { class: 'btn ' + (b.variant ? 'btn-' + b.variant : ''), 'data-autofocus': i === 0 ? true : null, onclick: () => done(b.value) }, b.label));
      const box = el('div', { class: 'dialog' },
        el('h3', { class: 'dialog-title' }, o.title || ''),
        o.message ? el('div', { class: 'dialog-body' }, o.message) : null,
        el('div', { class: 'dialog-actions' }, btns));
      wrap.append(box);
      document.body.append(wrap);
      openModal(wrap, { onRequestClose: () => done(o.dismissValue === undefined ? null : o.dismissValue) });
    });
  }

  const fmtCm = (mm) => (Math.round(mm) / 10).toFixed(1).replace(/\.0$/, '');
  const plural = (n, one, many) => (n === 1 ? one : n + ' ' + many);

  MG.ui = { $, $$, el, icon, ICONS, toast, openModal, closeModal, topModal, confirmDialog, fmtCm, plural };
})(window.MG = window.MG || {});
