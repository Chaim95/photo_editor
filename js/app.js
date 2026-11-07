/* Main application: state, frames, import, gallery, selection, layout stats. */
(function (MG) {
  'use strict';

  const { $, $$, el, icon, toast, confirmDialog, fmtCm } = MG.ui;
  const E = MG.engine.main;
  const L = MG.layout;

  const THUMB_LONG = 520;
  const PREVIEW_LONG = 1400;
  const RAW_EXT = /\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|dng|pef|srw|x3f|raw|3fr|iiq|erf|kdc|mrw|rwl)$/i;
  const IMG_EXT = /\.(jpe?g|jfif|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;

  const DEFAULTS = {
    mode: 'size', presetId: '6.5x9', customW: 65, customH: 90, count: 9,
    margin: 5, gap: 2, mixed: true, cutLines: true, dpi: 300,
    sort: 'name', thumbSize: 200, autoSelect: false
  };

  const newEdit = () => ({ rot: 0, zoom: 1, px: 0, py: null, fit: 'cover', frame: 'auto' });

  const S = {
    photos: [],
    byId: new Map(),
    keys: new Set(),
    seq: 0,
    frames: { portrait: null, landscape: null },
    frameVer: 0,
    settings: Object.assign({}, DEFAULTS),
    filter: 'all',
    layout: null,
    hi: new Map(),
    anchorId: null,
    importTotal: 0,
    importDone: 0
  };
  let pool = null;

  /* =========================================================
   * Helpers
   * ======================================================= */
  const avail = () => ({ portrait: !!S.frames.portrait, landscape: !!S.frames.landscape });
  const frameDims = () => ({
    portrait: S.frames.portrait ? { w: S.frames.portrait.w, h: S.frames.portrait.h } : null,
    landscape: S.frames.landscape ? { w: S.frames.landscape.w, h: S.frames.landscape.h } : null
  });
  const primaryFrame = () => S.frames.portrait || S.frames.landscape || null;
  const frameRatio = (f) => Math.max(f.w, f.h) / Math.min(f.w, f.h);
  const noFrameRatio = () => (S.layout && S.layout.slotShort > 0 ? S.layout.slotLong / S.layout.slotShort : 1.5);
  const frameKeyFor = (p) => E.chooseFrame(p.edit.frame, p.w, p.h, p.edit.rot, avail());

  function compositeSizeFor(p, longPx) {
    return E.compositeSize(frameKeyFor(p), frameDims(), p.w, p.h, p.edit.rot, noFrameRatio(), longPx);
  }
  function compositeAR(p) {
    const s = compositeSizeFor(p, 4000);
    return s.W / s.H;
  }

  /** Photo orientation does not match its frame and it is still auto-cropped -> worth a look. */
  function needsAttention(p) {
    if (p.status !== 'ready' || p.edited || p.edit.fit !== 'cover') return false;
    const fk = frameKeyFor(p);
    if (!fk) return false;
    const f = S.frames[fk];
    const d = E.rotatedDims(p.w, p.h, p.edit.rot);
    const photoLand = d[0] > d[1] * 1.05, photoPort = d[1] > d[0] * 1.05;
    const frameLand = f.w > f.h;
    return (photoLand && !frameLand) || (photoPort && frameLand);
  }

  function saveSettings() {
    MG.store.saveSettings(S.settings);
  }

  const collator = new Intl.Collator('he', { numeric: true, sensitivity: 'base' });
  function sortedPhotos() {
    const arr = S.photos.slice();
    const sort = S.settings.sort;
    if (sort === 'time') arr.sort((a, b) => a.lastModified - b.lastModified || collator.compare(a.name, b.name));
    else if (sort === 'time-desc') arr.sort((a, b) => b.lastModified - a.lastModified || collator.compare(b.name, a.name));
    else arr.sort((a, b) => collator.compare(a.name, b.name) || a.seq - b.seq);
    return arr;
  }
  function matchesFilter(p, f) {
    switch (f) {
      case 'selected': return p.selected;
      case 'unselected': return !p.selected;
      case 'unprinted': return !p.printed;
      case 'attention': return p.status === 'error' || needsAttention(p);
      default: return true;
    }
  }
  function visiblePhotos() {
    return sortedPhotos().filter((p) => matchesFilter(p, S.filter));
  }

  /* =========================================================
   * Layout
   * ======================================================= */
  function computeLayout() {
    const st = S.settings;
    const pf = primaryFrame();
    const preferPortrait = !(S.frames.landscape && !S.frames.portrait);
    let w, h;
    if (st.mode === 'count') {
      const ratio = pf ? frameRatio(pf) : 1.5;
      const s = L.sizeForCount(st.count, ratio, st.margin, st.gap, st.mixed, preferPortrait);
      w = s.w; h = s.h;
    } else {
      const preset = L.PRESETS.find((x) => x.id === st.presetId);
      if (!preset || preset.id === 'custom') { w = st.customW; h = st.customH; } else { w = preset.w; h = preset.h; }
    }
    const res = L.pack({ margin: st.margin, gap: st.gap, slotW: w, slotH: h, allowMixed: st.mixed, preferPortrait });
    const prevRatio = S.layout ? noFrameRatio() : null;
    S.layout = res;
    if (prevRatio != null && Math.abs(prevRatio - noFrameRatio()) > 1e-4) {
      // Photos without a frame take the magnet's proportions.
      S.photos.forEach((p) => { if (!frameKeyFor(p)) refreshThumb(p, 3); });
    }
  }

  function recompute() {
    computeLayout();
    renderLayoutPanel();
    scheduleStats();
  }

  /* =========================================================
   * Frames
   * ======================================================= */
  async function analyzeFrame(bitmap) {
    const c = MG.engine.mainEnv.createCanvas(64, 64);
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 245) transparent++;
    return transparent / (64 * 64);
  }

  async function loadFrame(file, hint, silent) {
    if (!file || !(/^image\//.test(file.type) || IMG_EXT.test(file.name || ''))) {
      toast('קובץ המסגרת חייב להיות תמונה (מומלץ PNG שקוף)', 'error');
      return;
    }
    let bitmap;
    try {
      bitmap = await E.decode(file);
    } catch (e) {
      toast('לא ניתן לקרוא את קובץ המסגרת', 'error');
      return;
    }
    const orient = bitmap.width > bitmap.height ? 'landscape' : 'portrait';
    if (hint && hint !== orient && !silent) {
      toast(orient === 'landscape' ? 'המסגרת זוהתה כאופקית ושובצה בהתאם' : 'המסגרת זוהתה כאנכית ושובצה בהתאם', 'info');
    }
    const transparency = await analyzeFrame(bitmap);
    const old = S.frames[orient];
    if (old) { E.release(old.bitmap); URL.revokeObjectURL(old.url); }
    S.frames[orient] = {
      blob: file, bitmap, w: bitmap.width, h: bitmap.height,
      url: URL.createObjectURL(file), name: file.name || 'frame.png', transparency
    };
    if (!silent) MG.store.idbSet('frame:' + orient, { blob: file, name: file.name || 'frame.png' });
    framesChanged();
    if (!silent) toast('המסגרת נטענה והולבשה על כל התמונות', 'success');
  }

  function removeFrame(key) {
    const f = S.frames[key];
    if (!f) return;
    E.release(f.bitmap);
    URL.revokeObjectURL(f.url);
    S.frames[key] = null;
    MG.store.idbDel('frame:' + key);
    framesChanged();
  }

  function framesChanged() {
    S.frameVer++;
    pool.setFrames(S.frames.portrait && S.frames.portrait.blob, S.frames.landscape && S.frames.landscape.blob, S.frameVer);
    clearHi();
    renderFramePanel();
    recompute();
    sortedPhotos().forEach((p) => refreshThumb(p, 3));
    S.photos.forEach(updateCard);
    updateFilterCounts();
  }

  async function restoreFrames() {
    for (const key of ['portrait', 'landscape']) {
      const rec = await MG.store.idbGet('frame:' + key);
      if (rec && rec.blob) {
        const file = rec.blob instanceof File ? rec.blob : new File([rec.blob], rec.name || 'frame.png', { type: rec.blob.type || 'image/png' });
        await loadFrame(file, key, true);
      }
    }
  }

  function renderFramePanel() {
    $$('.frame-slot').forEach((slot) => {
      const key = slot.dataset.slot;
      const f = S.frames[key];
      const thumb = slot.querySelector('.frame-thumb');
      const info = slot.querySelector('.frame-info');
      const rm = slot.querySelector('.frame-remove');
      slot.classList.toggle('loaded', !!f);
      thumb.style.backgroundImage = f ? 'url("' + f.url + '")' : '';
      if (f) {
        info.textContent = f.w + '×' + f.h + ' px';
        info.title = f.name;
      } else {
        info.textContent = key === 'portrait' ? 'לחץ או גרור PNG' : 'אופציונלי';
        info.title = '';
      }
      rm.hidden = !f;
    });
    const warn = $('#frame-warning');
    const msgs = [];
    ['portrait', 'landscape'].forEach((k) => {
      const f = S.frames[k];
      if (!f) return;
      const name = k === 'portrait' ? 'האנכית' : 'האופקית';
      if (f.transparency < 0.01) msgs.push('במסגרת ' + name + ' לא זוהה אזור שקוף – התמונה עלולה להיות מוסתרת. יש להשתמש ב־PNG עם רקע שקוף.');
      const needLong = (S.layout ? S.layout.slotLong : 90) / 25.4 * 300;
      if (Math.max(f.w, f.h) < needLong * 0.6) msgs.push('רזולוציית המסגרת ' + name + ' נמוכה (' + f.w + '×' + f.h + ') – ההדפסה עלולה לצאת לא חדה.');
    });
    if (S.frames.portrait && S.frames.landscape) {
      const a = frameRatio(S.frames.portrait), b = frameRatio(S.frames.landscape);
      if (Math.abs(a - b) / a > 0.03) msgs.push('יחסי הגובה־רוחב של שתי המסגרות שונים – מגנטים אופקיים יודפסו עם שוליים לבנים.');
    }
    warn.hidden = !msgs.length;
    warn.textContent = '';
    msgs.forEach((m) => warn.append(el('div', null, m)));
  }

  /* =========================================================
   * Import
   * ======================================================= */
  async function filesFromDataTransfer(dt) {
    const items = dt.items ? Array.from(dt.items) : [];
    const entries = items.map((i) => (i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return Array.from(dt.files || []);
    const out = [];
    const readAll = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));
    async function walk(entry) {
      if (entry.name && entry.name.startsWith('.')) return;
      if (entry.isFile) {
        try { out.push(await new Promise((res, rej) => entry.file(res, rej))); } catch (e) { /* unreadable */ }
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await readAll(reader);
          for (const e of batch) await walk(e);
        } while (batch.length);
      }
    }
    for (const e of entries) await walk(e);
    return out;
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    let raw = 0, other = 0, dup = 0;
    const fresh = [];
    for (const f of files) {
      const name = f.name || '';
      if (name.startsWith('.') || name.startsWith('._')) continue;
      if (RAW_EXT.test(name)) { raw++; continue; }
      if (!(/^image\//.test(f.type) || IMG_EXT.test(name))) { other++; continue; }
      const key = name + '|' + f.size + '|' + f.lastModified;
      if (S.keys.has(key)) { dup++; continue; }
      S.keys.add(key);
      fresh.push(f);
    }
    fresh.sort((a, b) => collator.compare(a.name, b.name));

    const added = fresh.map((f) => {
      const p = {
        id: 'p' + (++S.seq), seq: S.seq, file: f, name: f.name, size: f.size,
        lastModified: f.lastModified || 0, key: f.name + '|' + f.size + '|' + f.lastModified,
        w: 0, h: 0, preview: null, thumbUrl: null, thumbStamp: null, thumbPending: null,
        status: 'pending', error: null, selected: false, copies: 0, printed: 0,
        edit: newEdit(), editVer: 0, edited: false, el: null, removed: false
      };
      S.photos.push(p);
      S.byId.set(p.id, p);
      return p;
    });

    const notes = [];
    if (raw) notes.push(raw + ' קבצי RAW דולגו (יש לייבא JPEG)');
    if (dup) notes.push(dup + ' כפולים דולגו');
    if (other) notes.push(other + ' קבצים שאינם תמונה דולגו');
    if (added.length) toast('נוספו ' + added.length + ' תמונות' + (notes.length ? ' · ' + notes.join(' · ') : ''), 'success');
    else if (notes.length) toast(notes.join(' · '), 'warn');
    if (!added.length) return;

    S.importTotal += added.length;
    updateImportProgress();
    renderGallery();
    added.forEach(ingest);
  }

  function thumbStamp(p) {
    const fk = frameKeyFor(p);
    return S.frameVer + '|' + p.editVer + '|' + (fk ? fk : 'nf' + noFrameRatio().toFixed(4));
  }

  function ingest(p) {
    const stamp = thumbStamp(p);
    pool.run({
      kind: 'ingest', file: p.file, edit: Object.assign({}, p.edit),
      previewLong: PREVIEW_LONG, thumbLong: THUMB_LONG, noFrameRatio: noFrameRatio(), stamp
    }, 4, () => p.removed).then((res) => {
      if (!res || p.removed) return;
      p.w = res.w; p.h = res.h; p.preview = res.preview;
      p.status = 'ready';
      setThumb(p, res.thumb, res.stamp);
      if (S.settings.autoSelect && !p.selected) { p.selected = true; p.copies = 1; }
      if (res.stamp !== thumbStamp(p)) refreshThumb(p, 2);
      updateCard(p);
    }).catch((err) => {
      if (p.removed) return;
      p.status = 'error';
      p.error = /heic|heif/i.test(p.name) ? 'פורמט HEIC לא נתמך בדפדפן זה' : 'לא ניתן לפענח את הקובץ';
      p.selected = false; p.copies = 0;
      console.warn('ingest failed', p.name, err);
      updateCard(p);
    }).finally(() => {
      if (p.removed) return;
      S.importDone++;
      updateImportProgress();
      scheduleStats();
      updateFilterCounts();
    });
  }

  function updateImportProgress() {
    const box = $('#import-progress');
    if (S.importTotal === 0) { box.hidden = true; return; }
    box.hidden = false;
    $('#import-bar').style.width = (100 * S.importDone / S.importTotal).toFixed(1) + '%';
    $('#import-label').textContent = S.importDone >= S.importTotal
      ? 'העיבוד הושלם · ' + S.importTotal + ' תמונות'
      : 'מעבד תמונות ' + S.importDone + ' / ' + S.importTotal;
    if (S.importDone >= S.importTotal) {
      clearTimeout(updateImportProgress.t);
      updateImportProgress.t = setTimeout(() => {
        if (S.importDone >= S.importTotal) { S.importTotal = 0; S.importDone = 0; box.hidden = true; }
      }, 2000);
    }
  }

  function setThumb(p, blob, stamp) {
    if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
    p.thumbUrl = URL.createObjectURL(blob);
    p.thumbStamp = stamp;
    if (p.thumbPending === stamp) p.thumbPending = null;
    updateCard(p);
  }

  function refreshThumb(p, priority) {
    if (p.status !== 'ready' || !p.preview || p.removed) return;
    const stamp = thumbStamp(p);
    if (p.thumbStamp === stamp || p.thumbPending === stamp) return;
    p.thumbPending = stamp;
    const fk = frameKeyFor(p);
    const size = compositeSizeFor(p, THUMB_LONG);
    pool.run({
      kind: 'composite', src: p.preview, edit: Object.assign({}, p.edit), frameKey: fk,
      W: size.W, H: size.H, type: 'image/jpeg', quality: 0.85, stamp
    }, priority == null ? 2 : priority, () => p.removed || thumbStamp(p) !== stamp).then((res) => {
      if (!res || p.removed) return;
      setThumb(p, res.blob, res.stamp);
      if (res.stamp !== thumbStamp(p)) refreshThumb(p, priority);
    }).catch((err) => {
      if (p.thumbPending === stamp) p.thumbPending = null;
      console.warn('thumb failed', p.name, err);
    });
  }

  /* =========================================================
   * High resolution composites (for print)
   * ======================================================= */
  function printLongPx() {
    return Math.round((S.layout.slotLong / 25.4) * S.settings.dpi);
  }
  function hiKey(p) {
    const size = compositeSizeFor(p, printLongPx());
    return { key: p.id + '|' + p.editVer + '|' + S.frameVer + '|' + size.W + 'x' + size.H, size };
  }
  function hiGet(p) {
    const k = hiKey(p).key;
    return S.hi.get(k) || null;
  }
  function ensureHi(p, isStale) {
    const { key, size } = hiKey(p);
    const hit = S.hi.get(key);
    if (hit) return Promise.resolve(hit);
    return pool.run({
      kind: 'composite', src: p.file, edit: Object.assign({}, p.edit), frameKey: frameKeyFor(p),
      W: size.W, H: size.H, type: 'image/jpeg', quality: 0.95, stamp: key
    }, 0, isStale).then((res) => {
      if (!res) return null;
      const url = URL.createObjectURL(res.blob);
      const old = S.hi.get(res.stamp);
      if (old) URL.revokeObjectURL(old);
      S.hi.set(res.stamp, url);
      return url;
    });
  }
  function dropHiFor(p) {
    for (const [k, url] of S.hi) {
      if (k.startsWith(p.id + '|')) { URL.revokeObjectURL(url); S.hi.delete(k); }
    }
  }
  function clearHi() {
    for (const url of S.hi.values()) URL.revokeObjectURL(url);
    S.hi.clear();
  }
  /** Keep only composites that the current job needs (memory hygiene). */
  function pruneHi(keepKeys) {
    for (const [k, url] of S.hi) {
      if (!keepKeys.has(k)) { URL.revokeObjectURL(url); S.hi.delete(k); }
    }
  }

  /* =========================================================
   * Gallery
   * ======================================================= */
  function buildCard(p) {
    const stepper = el('div', { class: 'stepper' },
      el('button', { 'data-act': 'dec', 'aria-label': 'הפחת עותק', title: 'הפחת עותק (−)', tabindex: '-1' }, icon('minus')),
      el('output', { class: 'copies' }, '0'),
      el('button', { 'data-act': 'inc', 'aria-label': 'הוסף עותק', title: 'הוסף עותק (+)', tabindex: '-1' }, icon('plus')));
    const card = el('div', { class: 'card', tabindex: '0', role: 'option', 'data-id': p.id },
      el('div', { class: 'card-media', 'data-act': 'toggle' },
        el('img', { alt: '', draggable: 'false', decoding: 'async' }),
        el('div', { class: 'card-loading' }, el('span', { class: 'spinner' })),
        el('div', { class: 'card-check' }, icon('check')),
        el('div', { class: 'card-qty' }),
        el('div', { class: 'card-badges' }),
        el('div', { class: 'card-tools' },
          el('button', { class: 'tool', 'data-act': 'edit', title: 'עריכה – זום, הזזה, סיבוב (E)', 'aria-label': 'עריכה', tabindex: '-1' }, icon('edit')),
          el('button', { class: 'tool', 'data-act': 'remove', title: 'הסר מהעבודה (Delete)', 'aria-label': 'הסר', tabindex: '-1' }, icon('trash')))),
      el('div', { class: 'card-foot' },
        el('span', { class: 'card-name', title: p.name }, p.name),
        stepper));
    p.el = card;
    return card;
  }

  function updateCard(p) {
    const c = p.el;
    if (!c) return;
    c.classList.toggle('selected', p.selected);
    c.classList.toggle('loading', p.status === 'pending' || (!p.thumbUrl && p.status !== 'error'));
    c.classList.toggle('error', p.status === 'error');
    c.classList.toggle('printed', p.printed > 0);
    c.setAttribute('aria-selected', p.selected ? 'true' : 'false');
    const img = c.querySelector('img');
    if (p.thumbUrl && img.getAttribute('src') !== p.thumbUrl) img.src = p.thumbUrl;
    c.querySelector('.copies').textContent = p.selected ? p.copies : 0;
    const qty = c.querySelector('.card-qty');
    qty.textContent = p.selected && p.copies > 1 ? '×' + p.copies : '';
    qty.hidden = !(p.selected && p.copies > 1);
    const badges = c.querySelector('.card-badges');
    badges.textContent = '';
    if (p.status === 'error') badges.append(el('span', { class: 'badge badge-err', title: p.error }, p.error));
    if (needsAttention(p)) badges.append(el('span', { class: 'badge badge-warn', title: 'כיוון התמונה שונה מכיוון המסגרת – התמונה נחתכה אוטומטית. מומלץ לבדוק.' }, icon('swap'), 'כיוון שונה'));
    if (p.edited) badges.append(el('span', { class: 'badge', title: 'בוצעו התאמות ידניות' }, icon('edit'), 'נערכה'));
    if (p.printed) badges.append(el('span', { class: 'badge badge-ok', title: 'מספר מגנטים שהודפסו מתמונה זו' }, icon('printer'), 'הודפסה' + (p.printed > 1 ? ' ×' + p.printed : '')));
    c.querySelector('[data-act="dec"]').disabled = !p.selected;
    c.querySelector('[data-act="inc"]').disabled = p.status === 'error' || p.copies >= 99;
  }

  function renderGallery() {
    const grid = $('#gallery');
    const list = visiblePhotos();
    const frag = document.createDocumentFragment();
    for (const p of list) {
      if (!p.el) buildCard(p);
      updateCard(p);
      frag.append(p.el);
    }
    grid.textContent = '';
    grid.append(frag);
    $('#empty-state').hidden = S.photos.length > 0;
    $('#filter-empty').hidden = !(S.photos.length > 0 && list.length === 0);
    $('#gallery-wrap').classList.toggle('is-empty', S.photos.length === 0);
    updateFilterCounts();
  }

  function updateFilterCounts() {
    const counts = { all: 0, selected: 0, unselected: 0, unprinted: 0, attention: 0 };
    for (const p of S.photos) {
      counts.all++;
      if (p.selected) counts.selected++; else counts.unselected++;
      if (!p.printed) counts.unprinted++;
      if (p.status === 'error' || needsAttention(p)) counts.attention++;
    }
    for (const k of Object.keys(counts)) {
      const b = $('[data-count="' + k + '"]');
      if (b) b.textContent = counts[k];
    }
    $('#filter-seg [data-filter="attention"]').classList.toggle('has-items', counts.attention > 0);
  }

  /** Re-apply filter after a state change, keeping cards that no longer match visible until the next filter change would be confusing; so we refresh. */
  function refilterIfNeeded(p) {
    if (S.filter === 'all' || !p.el) return;
    const shouldShow = matchesFilter(p, S.filter);
    const shown = p.el.parentNode === $('#gallery');
    if (shouldShow !== shown) {
      clearTimeout(refilterIfNeeded.t);
      refilterIfNeeded.t = setTimeout(renderGallery, 650);
    }
  }

  /* ---------- selection & copies ---------- */
  function setSelected(p, on) {
    if (p.status === 'error') return;
    if (p.selected === on) return;
    p.selected = on;
    p.copies = on ? Math.max(1, p.copies || 1) : 0;
    afterSelectionChange(p);
  }
  function setCopies(p, n) {
    if (p.status === 'error') return;
    n = Math.max(0, Math.min(99, n | 0));
    p.selected = n > 0;
    p.copies = n;
    afterSelectionChange(p);
  }
  function afterSelectionChange(p) {
    updateCard(p);
    updateFilterCounts();
    scheduleStats();
    refilterIfNeeded(p);
    if (MG.editor && MG.editor.isOpenFor(p)) MG.editor.syncSelection();
  }

  function cardAction(p, act, ev) {
    switch (act) {
      case 'toggle':
        if (ev && ev.shiftKey && S.anchorId && S.anchorId !== p.id) {
          const list = visiblePhotos();
          const a = list.findIndex((x) => x.id === S.anchorId), b = list.findIndex((x) => x.id === p.id);
          if (a !== -1 && b !== -1) {
            const on = !p.selected;
            list.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => setSelected(x, on));
            break;
          }
        }
        setSelected(p, !p.selected);
        S.anchorId = p.id;
        break;
      case 'inc': setCopies(p, (p.selected ? p.copies : 0) + 1); break;
      case 'dec': setCopies(p, (p.selected ? p.copies : 0) - 1); break;
      case 'edit': if (p.status === 'ready') MG.editor.open(p.id, visiblePhotos().filter((x) => x.status === 'ready').map((x) => x.id)); break;
      case 'remove': removePhotos([p]); break;
    }
  }

  function removePhotos(list) {
    if (!list.length) return;
    list.forEach((p) => {
      p.removed = true;
      if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
      dropHiFor(p);
      if (p.el) p.el.remove();
      S.byId.delete(p.id);
      S.keys.delete(p.key);
      if (p.status === 'pending') { S.importDone++; }
    });
    const gone = new Set(list.map((p) => p.id));
    S.photos = S.photos.filter((p) => !gone.has(p.id));
    updateImportProgress();
    renderGallery();
    scheduleStats();
  }

  function gridColumns(grid) {
    const cards = grid.children;
    if (!cards.length) return 1;
    const top = cards[0].offsetTop;
    let n = 0;
    while (n < cards.length && cards[n].offsetTop === top) n++;
    return Math.max(1, n);
  }

  function bindGallery() {
    const grid = $('#gallery');
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const p = S.byId.get(card.dataset.id);
      if (!p) return;
      const actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      e.preventDefault();
      cardAction(p, actEl.dataset.act, e);
    });
    grid.addEventListener('dblclick', (e) => {
      const card = e.target.closest('.card');
      if (!card || e.target.closest('.stepper, .card-tools')) return;
      const p = S.byId.get(card.dataset.id);
      if (!p) return;
      // The double click already toggled twice -> state unchanged. Open the editor.
      cardAction(p, 'edit', e);
    });
    grid.addEventListener('keydown', (e) => {
      const card = e.target.closest('.card');
      if (!card || e.target !== card) return;
      const p = S.byId.get(card.dataset.id);
      if (!p) return;
      const k = e.key;
      if (k === ' ' || k === 'Enter') { e.preventDefault(); cardAction(p, 'toggle', e); }
      else if (k === '+' || k === '=' ) { e.preventDefault(); cardAction(p, 'inc'); }
      else if (k === '-' || k === '_') { e.preventDefault(); cardAction(p, 'dec'); }
      else if (/^[0-9]$/.test(k) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setCopies(p, +k); }
      else if (k === 'e' || k === 'E' || k === 'ק') { e.preventDefault(); cardAction(p, 'edit'); }
      else if (k === 'Delete' || k === 'Backspace') {
        e.preventDefault();
        const next = card.nextElementSibling || card.previousElementSibling;
        cardAction(p, 'remove');
        if (next) next.focus();
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k)) {
        e.preventDefault();
        const cards = Array.from(grid.children);
        const i = cards.indexOf(card);
        const cols = gridColumns(grid);
        let j = i;
        if (k === 'ArrowLeft') j = i + 1;          // RTL: left = next
        if (k === 'ArrowRight') j = i - 1;
        if (k === 'ArrowDown') j = i + cols;
        if (k === 'ArrowUp') j = i - cols;
        if (k === 'Home') j = 0;
        if (k === 'End') j = cards.length - 1;
        j = Math.max(0, Math.min(cards.length - 1, j));
        cards[j].focus();
        cards[j].scrollIntoView({ block: 'nearest' });
      }
    });
  }

  /* =========================================================
   * Stats & status bar
   * ======================================================= */
  function jobPhotos() {
    return sortedPhotos().filter((p) => p.selected && p.copies > 0 && p.status !== 'error');
  }
  function totals() {
    const list = jobPhotos();
    let magnets = 0, pending = 0;
    list.forEach((p) => { magnets += p.copies; if (p.status !== 'ready') pending++; });
    const cap = S.layout ? S.layout.capacity : 0;
    const pages = cap && magnets ? Math.ceil(magnets / cap) : 0;
    const last = pages ? magnets - (pages - 1) * cap : 0;
    return { photos: list.length, magnets, pending, cap, pages, last, free: pages ? cap - last : 0 };
  }

  let statsQueued = false;
  function scheduleStats() {
    if (statsQueued) return;
    statsQueued = true;
    requestAnimationFrame(() => { statsQueued = false; renderStats(); });
  }

  function renderStats() {
    const t = totals();
    const main = $('#stat-main');
    const fill = $('#fill-block');
    main.textContent = '';
    fill.textContent = '';
    const btn = $('#btn-preview');
    btn.disabled = !t.magnets || !t.cap;

    if (!t.cap) {
      main.append(el('div', { class: 'stat-warn' }, icon('alert'), 'גודל המגנט שנבחר לא נכנס בדף A4 – בחר גודל קטן יותר'));
      return;
    }
    if (!t.magnets) {
      main.append(el('div', { class: 'stat-empty' }, S.photos.length ? 'לחץ על תמונות כדי לבחור אותן להדפסה' : 'התחל בטעינת מסגרת ותמונות'),
        el('div', { class: 'stat-sub' }, 'בכל דף A4: ' + t.cap + ' מגנטים'));
      return;
    }
    const big = (n, label) => el('div', { class: 'stat' }, el('b', null, String(n)), el('span', null, label));
    main.append(
      big(t.photos, t.photos === 1 ? 'תמונה' : 'תמונות'),
      big(t.magnets, t.magnets === 1 ? 'מגנט' : 'מגנטים'),
      big(t.pages, t.pages === 1 ? 'דף A4' : 'דפי A4'));

    const full = t.last === t.cap;
    const meter = el('div', { class: 'slot-meter', 'aria-hidden': 'true' });
    if (t.cap <= 40) {
      for (let i = 0; i < t.cap; i++) meter.append(el('i', { class: i < t.last ? 'on' : '' }));
    } else {
      meter.classList.add('bar');
      meter.append(el('i', { class: 'on', style: { width: (100 * t.last / t.cap) + '%' } }));
    }
    const text = full
      ? el('div', { class: 'fill-text ok' }, icon('check'), t.pages > 1 ? 'כל הדפים מלאים – ניצול מקסימלי' : 'הדף מלא – ניצול מקסימלי')
      : el('div', { class: 'fill-text warn' },
        el('span', null, 'דף ' + (t.pages > 1 ? 'אחרון' : 'יחיד') + ': ', el('b', null, t.last + ' מתוך ' + t.cap)),
        el('span', { class: 'fill-free' }, 'אפשר להוסיף עוד ' + t.free + ' ' + (t.free === 1 ? 'מגנט' : 'מגנטים') + ' בלי דף נוסף'));
    fill.append(meter, text);
    if (!full) {
      fill.append(el('button', {
        class: 'btn btn-sm btn-ghost', title: 'הצג תמונות שלא נבחרו כדי להשלים את הדף',
        onclick: () => setFilter('unselected')
      }, 'השלם דף'));
    }
    if (t.pending) fill.append(el('span', { class: 'stat-sub' }, t.pending + ' עדיין בעיבוד'));
  }

  /* =========================================================
   * Layout panel (sidebar)
   * ======================================================= */
  function renderLayoutPanel() {
    const st = S.settings;
    $$('#mode-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === st.mode));
    $('#size-mode').hidden = st.mode !== 'size';
    $('#count-mode').hidden = st.mode !== 'count';
    $$('#preset-chips .chip').forEach((b) => b.classList.toggle('active', b.dataset.preset === st.presetId));
    $$('#count-chips .chip').forEach((b) => b.classList.toggle('active', +b.dataset.count === st.count));
    $('#custom-size').hidden = st.presetId !== 'custom';
    $('#custom-w').value = fmtCm(st.customW);
    $('#custom-h').value = fmtCm(st.customH);

    const lay = S.layout;
    const svg = $('#page-diagram');
    const NS = 'http://www.w3.org/2000/svg';
    svg.textContent = '';
    const page = document.createElementNS(NS, 'rect');
    Object.entries({ x: 0, y: 0, width: 210, height: 297, rx: 3, class: 'pg' }).forEach(([k, v]) => page.setAttribute(k, v));
    svg.append(page);
    const mainLand = lay.slots.length ? lay.slots[0].w > lay.slots[0].h : false;
    lay.slots.forEach((s, i) => {
      const r = document.createElementNS(NS, 'rect');
      const rotated = (s.w > s.h) !== mainLand;
      Object.entries({ x: s.x, y: s.y, width: s.w, height: s.h, rx: 1.5, class: 'sl' + (rotated ? ' rot' : '') }).forEach(([k, v]) => r.setAttribute(k, v));
      svg.append(r);
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', s.x + s.w / 2);
      t.setAttribute('y', s.y + s.h / 2 + 5);
      t.setAttribute('class', 'sn');
      t.textContent = i + 1;
      svg.append(t);
    });

    const facts = $('#layout-facts');
    facts.textContent = '';
    if (!lay.capacity) {
      facts.append(el('div', { class: 'fact-err' }, 'הגודל שנבחר לא נכנס בדף A4'));
    } else {
      facts.append(
        el('div', { class: 'fact-big' }, el('b', null, String(lay.capacity)), ' מגנטים בדף'),
        el('div', { class: 'fact' }, 'גודל מגנט: ', el('b', null, fmtCm(lay.slotShort) + ' × ' + fmtCm(lay.slotLong) + ' ס״מ')),
        el('div', { class: 'fact' }, 'ניצול שטח הדף: ', el('b', null, Math.round(lay.utilization * 100) + '%')));
      if (lay.mixed) facts.append(el('div', { class: 'fact fact-note' }, icon('sparkle'), lay.rotatedCount + ' מגנטים משובצים בסיבוב לניצול מירבי'));
    }

    // Frame ratio vs magnet ratio
    const warn = $('#ratio-warning');
    const pf = primaryFrame();
    warn.textContent = '';
    warn.hidden = true;
    if (pf && lay.capacity && st.mode === 'size') {
      const fr = frameRatio(pf), sr = lay.slotLong / lay.slotShort;
      if (Math.abs(fr - sr) / sr > 0.02) {
        const newLong = Math.round(lay.slotShort * fr);
        warn.hidden = false;
        warn.append(
          el('div', null, 'יחס המסגרת שונה מיחס המגנט – יופיעו שוליים לבנים סביב התמונה.'),
          el('button', {
            class: 'btn btn-sm', onclick: () => {
              S.settings.presetId = 'custom';
              S.settings.customW = lay.slotShort;
              S.settings.customH = newLong;
              saveSettings();
              recompute();
              toast('גודל המגנט הותאם למסגרת: ' + fmtCm(lay.slotShort) + ' × ' + fmtCm(newLong) + ' ס״מ', 'success');
            }
          }, 'התאם גודל למסגרת (' + fmtCm(lay.slotShort) + '×' + fmtCm(newLong) + ')'));
      }
    }
    renderFramePanel();
  }

  function buildLayoutControls() {
    const chips = $('#preset-chips');
    L.PRESETS.forEach((p) => chips.append(el('button', { class: 'chip' + (p.id === 'custom' ? ' chip-wide' : ''), 'data-preset': p.id },
      p.id === 'custom' ? p.label : el('span', null, p.label, el('small', null, ' ס״מ')))));
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      S.settings.presetId = b.dataset.preset;
      saveSettings();
      recompute();
    });
    const cc = $('#count-chips');
    L.COUNT_OPTIONS.forEach((n) => cc.append(el('button', { class: 'chip', 'data-count': n }, String(n))));
    cc.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      S.settings.count = +b.dataset.count;
      saveSettings();
      recompute();
    });
    $('#mode-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.settings.mode = b.dataset.mode;
      saveSettings();
      recompute();
    });
    const customChange = () => {
      const w = parseFloat($('#custom-w').value), h = parseFloat($('#custom-h').value);
      if (w > 0) S.settings.customW = Math.round(Math.min(200, w * 10));
      if (h > 0) S.settings.customH = Math.round(Math.min(287, h * 10));
      saveSettings();
      recompute();
    };
    $('#custom-w').addEventListener('change', customChange);
    $('#custom-h').addEventListener('change', customChange);

    const num = (id, key, lo, hi) => {
      const inp = $(id);
      inp.value = S.settings[key];
      inp.addEventListener('change', () => {
        let v = parseFloat(inp.value);
        if (!isFinite(v)) v = DEFAULTS[key];
        v = Math.max(lo, Math.min(hi, v));
        inp.value = v;
        S.settings[key] = v;
        saveSettings();
        clearHi();
        recompute();
      });
    };
    num('#set-margin', 'margin', 0, 30);
    num('#set-gap', 'gap', 0, 20);
    const dpi = $('#set-dpi');
    dpi.value = String(S.settings.dpi);
    dpi.addEventListener('change', () => { S.settings.dpi = +dpi.value; saveSettings(); clearHi(); renderFramePanel(); });
    const chk = (id, key, after) => {
      const c = $(id);
      c.checked = !!S.settings[key];
      c.addEventListener('change', () => { S.settings[key] = c.checked; saveSettings(); if (after) after(); });
    };
    chk('#set-mixed', 'mixed', recompute);
    chk('#set-cut', 'cutLines');
    chk('#set-autoselect', 'autoSelect');
  }

  /* =========================================================
   * Toolbar
   * ======================================================= */
  function setFilter(f) {
    S.filter = f;
    $$('#filter-seg button').forEach((b) => b.classList.toggle('active', b.dataset.filter === f));
    renderGallery();
    $('#gallery-wrap').scrollTop = 0;
  }

  function bindToolbar() {
    $('#filter-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) setFilter(b.dataset.filter);
    });
    $('#btn-select-all').addEventListener('click', selectAllVisible);
    $('#btn-clear-sel').addEventListener('click', () => {
      const n = S.photos.filter((p) => p.selected).length;
      if (!n) return;
      S.photos.forEach((p) => { if (p.selected) { p.selected = false; p.copies = 0; updateCard(p); } });
      updateFilterCounts();
      scheduleStats();
      if (S.filter !== 'all') renderGallery();
      toast('הבחירה נוקתה (' + n + ' תמונות)', 'info');
    });
    $('#btn-reset-copies').addEventListener('click', () => {
      S.photos.forEach((p) => { if (p.selected && p.copies !== 1) { p.copies = 1; updateCard(p); } });
      scheduleStats();
    });
    const sort = $('#sort-select');
    sort.value = S.settings.sort;
    sort.addEventListener('change', () => { S.settings.sort = sort.value; saveSettings(); renderGallery(); });
    const ts = $('#thumb-size');
    ts.value = S.settings.thumbSize;
    const applyThumb = () => document.documentElement.style.setProperty('--thumb', ts.value + 'px');
    applyThumb();
    ts.addEventListener('input', () => { applyThumb(); S.settings.thumbSize = +ts.value; saveSettings(); });
  }

  function selectAllVisible() {
    let n = 0;
    visiblePhotos().forEach((p) => {
      if (!p.selected && p.status !== 'error') { p.selected = true; p.copies = Math.max(1, p.copies); n++; updateCard(p); }
    });
    updateFilterCounts();
    scheduleStats();
    if (S.filter === 'unselected') renderGallery();
    if (n) toast('נבחרו ' + n + ' תמונות', 'info');
  }

  /* =========================================================
   * Frames UI, drag & drop, global keys
   * ======================================================= */
  function bindFrames() {
    const input = $('#input-frame');
    let target = 'portrait';
    $$('.frame-slot').forEach((slot) => {
      const open = () => { target = slot.dataset.slot; input.value = ''; input.click(); };
      slot.addEventListener('click', (e) => { if (!e.target.closest('.frame-remove')) open(); });
      slot.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      slot.querySelector('.frame-remove').addEventListener('click', (e) => { e.stopPropagation(); removeFrame(slot.dataset.slot); });
      slot.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); slot.classList.add('drag'); });
      slot.addEventListener('dragleave', () => slot.classList.remove('drag'));
      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        slot.classList.remove('drag');
        document.body.classList.remove('dragging');
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) loadFrame(f, slot.dataset.slot);
      });
    });
    input.addEventListener('change', () => { if (input.files[0]) loadFrame(input.files[0], target); });
  }

  function bindImport() {
    const ip = $('#input-photos'), ifo = $('#input-folder');
    const pick = () => { ip.value = ''; ip.click(); };
    const pickFolder = () => { ifo.value = ''; ifo.click(); };
    $('#btn-add-photos').addEventListener('click', pick);
    $('#empty-add').addEventListener('click', pick);
    $('#btn-add-folder').addEventListener('click', pickFolder);
    $('#empty-folder').addEventListener('click', pickFolder);
    ip.addEventListener('change', () => addFiles(ip.files));
    ifo.addEventListener('change', () => addFiles(ifo.files));

    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      if (MG.ui.topModal()) return;
      const files = await filesFromDataTransfer(e.dataTransfer);
      addFiles(files);
    });

    $('#btn-clear-all').addEventListener('click', async () => {
      if (!S.photos.length) { toast('אין תמונות לניקוי', 'info'); return; }
      const ok = await confirmDialog({
        title: 'להתחיל אירוע חדש?',
        message: 'כל ' + S.photos.length + ' התמונות יוסרו מהעבודה (הקבצים המקוריים לא נפגעים). המסגרות וההגדרות יישמרו.',
        buttons: [{ label: 'כן, נקה הכל', value: true, variant: 'danger' }, { label: 'ביטול', value: false }]
      });
      if (ok) {
        removePhotos(S.photos.slice());
        S.importTotal = 0; S.importDone = 0;
        updateImportProgress();
        clearHi();
      }
    });
  }

  function bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      if (MG.ui.topModal()) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'a' || e.key === 'A' || e.key === 'ש')) { e.preventDefault(); selectAllVisible(); }
      else if (mod && (e.key === 'p' || e.key === 'P' || e.key === 'פ')) { e.preventDefault(); MG.print.open(); }
      else if (e.key === '?' ) { e.preventDefault(); MG.ui.openModal($('#help-modal')); }
    });
    $('#btn-help').addEventListener('click', () => MG.ui.openModal($('#help-modal')));
    $('#help-close').addEventListener('click', () => MG.ui.closeModal($('#help-modal')));
    $('#btn-preview').addEventListener('click', () => MG.print.open());
    window.addEventListener('beforeunload', (e) => {
      if (S.photos.length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function decorateIcons(root) {
    $$('[data-icon]', root).forEach((n) => {
      if (n.querySelector(':scope > .ico')) return;
      n.prepend(icon(n.dataset.icon));
    });
    $$('.frame-remove', root).forEach((n) => { if (!n.firstChild) n.append(icon('close')); });
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
    }
  }

  /* =========================================================
   * Hooks used by editor & print modules
   * ======================================================= */
  function onPhotoEdited(p) {
    p.edited = true;
    p.editVer++;
    dropHiFor(p);
    refreshThumb(p, 0);
    updateCard(p);
    updateFilterCounts();
    refilterIfNeeded(p);
  }

  function markPrinted(items) {
    items.forEach(({ p, copies }) => { p.printed += copies; updateCard(p); });
    updateFilterCounts();
  }

  function clearSelectionOf(list) {
    list.forEach((p) => { p.selected = false; p.copies = 0; updateCard(p); });
    updateFilterCounts();
    scheduleStats();
    if (S.filter !== 'all') renderGallery();
  }

  /* =========================================================
   * Init
   * ======================================================= */
  async function init() {
    S.settings = Object.assign({}, DEFAULTS, MG.store.loadSettings());
    if (!L.PRESETS.some((p) => p.id === S.settings.presetId)) S.settings.presetId = DEFAULTS.presetId;
    decorateIcons(document);
    pool = await new MG.engine.Pool().init();
    MG.app.pool = pool;
    buildLayoutControls();
    bindFrames();
    bindImport();
    bindGallery();
    bindToolbar();
    bindGlobalKeys();
    setFilter('all');
    recompute();
    await restoreFrames();
    renderFramePanel();
    registerServiceWorker();
    document.body.classList.add('ready');
  }

  MG.app = {
    S, avail, frameDims, frameKeyFor, compositeSizeFor, compositeAR, noFrameRatio,
    sortedPhotos, visiblePhotos, jobPhotos, totals, setSelected, setCopies, onPhotoEdited,
    ensureHi, hiGet, hiKey, pruneHi, markPrinted, clearSelectionOf, decorateIcons, updateCard,
    get layout() { return S.layout; },
    get settings() { return S.settings; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.MG = window.MG || {});
