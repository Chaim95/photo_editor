/* Per-photo editor: pan, zoom, rotate, fit mode and frame choice, with live preview. */
(function (MG) {
  'use strict';

  const { $, $$ } = MG.ui;
  const E = MG.engine.main;
  const SOURCE_LONG = 2400;
  const CACHE_SIZE = 4;

  const modal = () => $('#editor-modal');
  let cur = null;           // { p, ids, idx }
  const sources = new Map(); // id -> { img, w, h, full }
  let dirty = false;
  let commitTimer = null;
  let rafQueued = false;

  /* ---------- sources (full resolution, downscaled for interactive use) ---------- */
  function cacheSet(id, val) {
    const old = sources.get(id);
    if (old && old !== val && old.img && old.img.close) old.img.close();
    sources.delete(id);
    sources.set(id, val);
    while (sources.size > CACHE_SIZE) {
      const k = sources.keys().next().value;
      if (cur && cur.p.id === k) { const v = sources.get(k); sources.delete(k); sources.set(k, v); continue; }
      const v = sources.get(k);
      if (v.img && v.img.close) v.img.close();
      sources.delete(k);
    }
  }

  async function loadSource(p) {
    const hit = sources.get(p.id);
    if (hit && hit.full) return hit;
    if (!hit && p.preview) {
      try {
        const b = await E.decode(p.preview);
        if (!sources.get(p.id)) cacheSet(p.id, { img: b, w: b.width, h: b.height, full: false });
      } catch (e) { /* preview unavailable */ }
    }
    const bmp = await E.decode(p.file);
    const s = Math.min(1, SOURCE_LONG / Math.max(bmp.width, bmp.height));
    let img = bmp;
    if (s < 1) {
      img = E.scaledSource(bmp, bmp.width, bmp.height, bmp.width * s, bmp.height * s);
      bmp.close();
    }
    const val = { img, w: img.width, h: img.height, full: true };
    cacheSet(p.id, val);
    return val;
  }

  function prefetch(idx) {
    if (!cur) return;
    const id = cur.ids[idx];
    const p = id && MG.app.S.byId.get(id);
    if (p && !(sources.get(id) && sources.get(id).full)) loadSource(p).catch(() => {});
  }

  /* ---------- rendering ---------- */
  function requestDraw() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(() => { rafQueued = false; draw(); });
  }

  function stageGeometry(p) {
    const stage = $('#editor-stage');
    const r = stage.getBoundingClientRect();
    const ar = MG.app.compositeAR(p);
    const maxW = Math.max(50, r.width - 120), maxH = Math.max(50, r.height - 70);
    let w = maxW, h = maxW / ar;
    if (h > maxH) { h = maxH; w = maxH * ar; }
    return { w: Math.round(w), h: Math.round(h) };
  }

  function draw() {
    if (!cur) return;
    const p = cur.p;
    const src = sources.get(p.id);
    const canvas = $('#editor-canvas');
    const g = stageGeometry(p);
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const W = Math.round(g.w * dpr), H = Math.round(g.h * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    canvas.style.width = g.w + 'px';
    canvas.style.height = g.h + 'px';
    const ctx = canvas.getContext('2d');
    if (!src) {
      ctx.fillStyle = '#1b2027';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const fk = MG.app.frameKeyFor(p);
    const frame = fk ? MG.app.S.frames[fk].bitmap : null;
    cur.place = E.renderTo(ctx, src.img, src.w, src.h, p.edit, frame, W, H);
    cur.canvasScale = W / g.w;
  }

  /* ---------- controls sync ---------- */
  function syncControls() {
    if (!cur) return;
    const p = cur.p;
    $('#editor-title').textContent = p.name;
    $('#editor-counter').textContent = (cur.idx + 1) + ' / ' + cur.ids.length;
    const z = Math.round((p.edit.zoom || 1) * 100);
    $('#ed-zoom').value = Math.min(400, z);
    $('#ed-zoom-val').textContent = z + '%';
    $$('#ed-fit button').forEach((b) => b.classList.toggle('active', b.dataset.fit === p.edit.fit));
    const av = MG.app.avail();
    const anyFrame = av.portrait || av.landscape;
    $('#ed-frame-group').hidden = !anyFrame;
    const both = av.portrait && av.landscape;
    const pref = p.edit.frame;
    const effective = pref === 'none' ? 'none'
      : both ? pref
        : (pref === 'auto' || !av[pref] ? (av.portrait ? 'portrait' : 'landscape') : pref);
    $$('#ed-frame button').forEach((b) => {
      const f = b.dataset.frame;
      b.hidden = (f === 'portrait' && !av.portrait) || (f === 'landscape' && !av.landscape) || (f === 'auto' && !both);
      b.classList.toggle('active', f === effective);
    });
    $('#editor-prev').disabled = cur.idx <= 0;
    $('#editor-next').disabled = cur.idx >= cur.ids.length - 1;
    syncSelection();
  }

  function syncSelection() {
    if (!cur) return;
    const p = cur.p;
    const sel = $('#ed-select');
    sel.classList.toggle('active', p.selected);
    sel.lastChild.textContent = p.selected ? 'נבחרה להדפסה' : 'לא נבחרה – לחץ לבחירה';
    $('#ed-copies').textContent = p.selected ? p.copies : 0;
  }

  /* ---------- edit mutations ---------- */
  function change(mut, immediate) {
    if (!cur) return;
    mut(cur.p.edit);
    dirty = true;
    syncControls();
    requestDraw();
    clearTimeout(commitTimer);
    if (immediate) commit(); else commitTimer = setTimeout(commit, 350);
  }

  function commit() {
    clearTimeout(commitTimer);
    if (!cur || !dirty) return;
    dirty = false;
    MG.app.onPhotoEdited(cur.p);
  }

  const clampZoom = (z) => Math.max(1, Math.min(8, z));

  function setZoom(z) {
    change((e) => { e.zoom = clampZoom(z); });
  }

  /** Resolve auto pan before manual dragging so the photo does not jump. */
  function ensurePan(e) {
    if (e.py == null && cur.place) e.py = cur.place.py;
  }

  /* ---------- navigation ---------- */
  async function show(idx) {
    commit();
    if (!cur) return;
    idx = Math.max(0, Math.min(cur.ids.length - 1, idx));
    const p = MG.app.S.byId.get(cur.ids[idx]);
    if (!p) return;
    cur.idx = idx;
    cur.p = p;
    cur.place = null;
    syncControls();
    requestDraw();
    const loading = $('#editor-loading');
    const have = sources.get(p.id);
    loading.hidden = !!(have && have.full);
    try {
      const token = p.id;
      const pr = loadSource(p);
      // Show the preview as soon as it is decoded.
      setTimeout(() => { if (cur && cur.p.id === token) requestDraw(); }, 60);
      await pr;
      if (cur && cur.p.id === token) { loading.hidden = true; requestDraw(); }
    } catch (e) {
      loading.hidden = true;
      MG.ui.toast('לא ניתן לטעון את התמונה בגודל מלא', 'error');
    }
    prefetch(idx + 1);
  }

  function open(id, ids) {
    const list = ids && ids.length ? ids : [id];
    let idx = list.indexOf(id);
    if (idx === -1) { list.unshift(id); idx = 0; }
    cur = { p: MG.app.S.byId.get(id), ids: list, idx };
    MG.ui.openModal(modal(), { onRequestClose: close });
    show(idx);
  }

  function close() {
    commit();
    const p = cur && cur.p;
    cur = null;
    MG.ui.closeModal(modal());
    if (p && p.el) { p.el.focus({ preventScroll: true }); p.el.scrollIntoView({ block: 'nearest' }); }
  }

  /* ---------- pointer interaction ---------- */
  function bindStage() {
    const canvas = $('#editor-canvas');
    const pointers = new Map();
    let start = null;

    canvas.addEventListener('pointerdown', (ev) => {
      if (!cur) return;
      canvas.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      ensurePan(cur.p.edit);
      const pts = Array.from(pointers.values());
      start = {
        px: cur.p.edit.px || 0, py: cur.p.edit.py || 0, zoom: cur.p.edit.zoom || 1,
        pts: pts.map((q) => ({ x: q.x, y: q.y })),
        dist: pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0,
        place: cur.place
      };
      canvas.classList.add('grabbing');
    });

    canvas.addEventListener('pointermove', (ev) => {
      if (!cur || !pointers.has(ev.pointerId) || !start) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const pts = Array.from(pointers.values());
      if (pts.length >= 2 && start.dist > 0) {
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        change((e) => { e.zoom = clampZoom(start.zoom * d / start.dist); });
        return;
      }
      const s0 = start.pts[0];
      const k = cur.canvasScale || 1;
      const dx = (ev.clientX - s0.x) * k, dy = (ev.clientY - s0.y) * k;
      const pl = cur.place || start.place;
      if (!pl) return;
      change((e) => {
        if (pl.slackX > 0) e.px = Math.max(-1, Math.min(1, start.px + dx / pl.slackX));
        if (pl.slackY > 0) e.py = Math.max(-1, Math.min(1, start.py + dy / pl.slackY));
      });
    });

    const end = (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.delete(ev.pointerId);
      if (cur) {
        const pts = Array.from(pointers.values());
        start = pts.length ? {
          px: cur.p.edit.px || 0, py: cur.p.edit.py || 0, zoom: cur.p.edit.zoom || 1,
          pts: pts.map((q) => ({ x: q.x, y: q.y })), dist: 0, place: cur.place
        } : null;
      }
      if (!pointers.size) { canvas.classList.remove('grabbing'); commit(); }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener('wheel', (ev) => {
      if (!cur) return;
      ev.preventDefault();
      const z = (cur.p.edit.zoom || 1) * Math.exp(-ev.deltaY * 0.0015);
      ensurePan(cur.p.edit);
      setZoom(z);
    }, { passive: false });

    new ResizeObserver(() => { if (cur) requestDraw(); }).observe($('#editor-stage'));
  }

  function bindControls() {
    $('#editor-close').addEventListener('click', close);
    $('#ed-done').addEventListener('click', close);
    $('#editor-prev').addEventListener('click', () => show(cur.idx - 1));
    $('#editor-next').addEventListener('click', () => show(cur.idx + 1));

    $('#ed-zoom').addEventListener('input', (e) => { ensurePan(cur.p.edit); setZoom(+e.target.value / 100); });
    $('#ed-zoom-in').addEventListener('click', () => setZoom((cur.p.edit.zoom || 1) * 1.15));
    $('#ed-zoom-out').addEventListener('click', () => setZoom((cur.p.edit.zoom || 1) / 1.15));
    $('#ed-rot-r').addEventListener('click', () => change((e) => { e.rot = (e.rot + 90) % 360; e.px = 0; e.py = null; }, true));
    $('#ed-rot-l').addEventListener('click', () => change((e) => { e.rot = (e.rot + 270) % 360; e.px = 0; e.py = null; }, true));
    $('#ed-center').addEventListener('click', () => change((e) => { e.px = 0; e.py = 0; }, true));
    $('#ed-reset').addEventListener('click', () => change((e) => {
      Object.assign(e, { rot: 0, zoom: 1, px: 0, py: null, fit: 'cover', frame: 'auto' });
    }, true));
    $('#ed-fit').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (b) change((e) => { e.fit = b.dataset.fit; e.zoom = 1; e.px = 0; e.py = null; }, true);
    });
    $('#ed-frame').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (b) change((e) => { e.frame = b.dataset.frame; e.px = 0; e.py = null; }, true);
    });
    $('#ed-select').addEventListener('click', () => MG.app.setSelected(cur.p, !cur.p.selected));
    $('#ed-stepper').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const n = (cur.p.selected ? cur.p.copies : 0) + (b.dataset.act === 'inc' ? 1 : -1);
      MG.app.setCopies(cur.p, n);
    });

    document.addEventListener('keydown', (e) => {
      if (!cur || MG.ui.topModal() !== modal()) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' && e.target.type !== 'range') return;
      const k = e.key;
      if (k === 'ArrowLeft') { e.preventDefault(); show(cur.idx + 1); }
      else if (k === 'ArrowRight') { e.preventDefault(); show(cur.idx - 1); }
      else if (k === ' ') { e.preventDefault(); MG.app.setSelected(cur.p, !cur.p.selected); }
      else if (k === 'r' || k === 'R' || k === 'ר') { e.preventDefault(); (e.shiftKey ? $('#ed-rot-l') : $('#ed-rot-r')).click(); }
      else if (k === '+' || k === '=') { e.preventDefault(); setZoom((cur.p.edit.zoom || 1) * 1.15); }
      else if (k === '-' || k === '_') { e.preventDefault(); setZoom((cur.p.edit.zoom || 1) / 1.15); }
      else if (k === '0') { e.preventDefault(); setZoom(1); }
      else if (k === 'f' || k === 'F' || k === 'כ') { e.preventDefault(); change((ed) => { ed.fit = ed.fit === 'cover' ? 'contain' : 'cover'; ed.zoom = 1; ed.px = 0; ed.py = null; }, true); }
      else if (k === 'Enter' && tag !== 'button') { e.preventDefault(); close(); }
    });
  }

  function init() {
    bindStage();
    bindControls();
  }

  MG.editor = {
    open,
    close,
    isOpenFor: (p) => !!(cur && cur.p === p),
    syncSelection
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.MG = window.MG || {});
