/* Print preview, high-resolution rendering and clean A4 printing. */
(function (MG) {
  'use strict';

  const { $, $$, el, toast, confirmDialog, fmtCm } = MG.ui;
  const PAGE_W = 210, PAGE_H = 297;

  let session = 0;
  let job = null;
  let ready = false;

  const modal = () => $('#preview-modal');

  function buildJob() {
    const app = MG.app;
    const layout = app.layout;
    const photos = app.jobPhotos().filter((p) => p.status === 'ready');
    const copies = new Map(photos.map((p) => [p, p.copies]));
    const items = [];
    photos.forEach((p) => { for (let i = 0; i < p.copies; i++) items.push(p); });
    const pages = [];
    for (let i = 0; i < items.length; i += layout.capacity) pages.push(items.slice(i, i + layout.capacity));
    return { photos, copies, items, pages, layout, cutLines: !!app.settings.cutLines };
  }

  /**
   * How a composite (aspect ratio `ar` = w/h) sits inside a slot: rotated by 90° if its orientation
   * differs from the slot's, then scaled to fit without distortion and centered.
   */
  function imageBox(slot, ar) {
    const slotLand = slot.w > slot.h * 1.001;
    const compLand = ar > 1.001;
    const compSquare = Math.abs(ar - 1) <= 0.001;
    const rotate = !compSquare && slotLand !== compLand;
    const dispAR = rotate ? 1 / ar : ar;
    let dw, dh;
    if (dispAR > slot.w / slot.h) { dw = slot.w; dh = slot.w / dispAR; } else { dh = slot.h; dw = slot.h * dispAR; }
    return { rotate, dw, dh, bw: rotate ? dh : dw, bh: rotate ? dw : dh };
  }

  function buildSheet(pageItems, layout, mode, srcFor, cutLines) {
    const isPrint = mode === 'print';
    const sheet = el('div', { class: isPrint ? 'sheet' : 'sheet-preview' });
    const count = isPrint ? pageItems.length : layout.slots.length;
    for (let i = 0; i < count; i++) {
      const s = layout.slots[i];
      const p = pageItems[i];
      const pos = isPrint
        ? { left: s.x + 'mm', top: s.y + 'mm', width: s.w + 'mm', height: s.h + 'mm' }
        : { left: (s.x / PAGE_W * 100) + '%', top: (s.y / PAGE_H * 100) + '%', width: (s.w / PAGE_W * 100) + '%', height: (s.h / PAGE_H * 100) + '%' };
      if (!p) {
        sheet.append(el('div', { class: 'slot slot-empty', style: pos, title: 'מקום פנוי' }));
        continue;
      }
      const b = imageBox(s, MG.app.compositeAR(p));
      const slot = el('div', { class: 'slot', style: pos });
      slot.append(el('img', {
        alt: '', 'data-id': p.id, src: srcFor(p) || '', draggable: 'false',
        style: {
          width: (b.bw / s.w * 100) + '%',
          height: (b.bh / s.h * 100) + '%',
          transform: 'translate(-50%, -50%)' + (b.rotate ? ' rotate(90deg)' : '')
        }
      }));
      if (cutLines) {
        slot.append(el('div', {
          class: 'cut',
          style: {
            left: ((s.w - b.dw) / 2 / s.w * 100) + '%', top: ((s.h - b.dh) / 2 / s.h * 100) + '%',
            width: (b.dw / s.w * 100) + '%', height: (b.dh / s.h * 100) + '%'
          }
        }));
      }
      sheet.append(slot);
    }
    return sheet;
  }

  function renderSummary() {
    const lay = job.layout;
    const last = job.pages.length ? job.pages[job.pages.length - 1].length : 0;
    const box = $('#preview-summary');
    box.textContent = '';
    const chip = (b, t) => el('span', { class: 'sum-chip' }, el('b', null, String(b)), ' ' + t);
    box.append(
      chip(job.pages.length, job.pages.length === 1 ? 'דף A4' : 'דפי A4'),
      chip(job.items.length, 'מגנטים'),
      chip(job.photos.length, 'תמונות'),
      chip(fmtCm(lay.slotShort) + '×' + fmtCm(lay.slotLong), 'ס״מ'));
    if (last < lay.capacity) {
      box.append(el('span', { class: 'sum-chip warn' }, 'דף אחרון: ', el('b', null, last + '/' + lay.capacity), ' – ' + (lay.capacity - last) + ' מקומות פנויים'));
    } else {
      box.append(el('span', { class: 'sum-chip ok' }, 'כל הדפים מלאים'));
    }
  }

  function renderPages() {
    const host = $('#preview-pages');
    host.textContent = '';
    job.pages.forEach((pg, i) => {
      const sheet = buildSheet(pg, job.layout, 'preview', (p) => MG.app.hiGet(p) || p.thumbUrl, job.cutLines);
      host.append(el('div', { class: 'page-wrap' },
        el('div', { class: 'page-label' }, 'דף ' + (i + 1) + ' מתוך ' + job.pages.length,
          el('span', null, pg.length + ' / ' + job.layout.capacity + ' מגנטים')),
        sheet));
    });
  }

  function setProgress(done, total, failed) {
    const label = $('#preview-progress-label');
    $('#preview-bar').style.width = (total ? (100 * done / total) : 100).toFixed(1) + '%';
    const box = $('#preview-progress');
    box.classList.toggle('done', done >= total && !failed);
    box.classList.toggle('failed', !!failed);
    if (failed) label.textContent = failed + ' תמונות נכשלו בהכנה להדפסה';
    else if (done >= total) label.textContent = 'מוכן להדפסה באיכות ' + MG.app.settings.dpi + ' DPI';
    else label.textContent = 'מכין קבצים באיכות הדפסה… ' + done + ' / ' + total;
  }

  async function open() {
    const app = MG.app;
    if (MG.ui.topModal()) return;
    const t = app.totals();
    if (!t.cap) { toast('גודל המגנט שנבחר לא נכנס בדף A4', 'error'); return; }
    if (!t.magnets) { toast('לא נבחרו תמונות להדפסה', 'warn'); return; }
    if (t.pending) { toast('ממתין לסיום עיבוד של ' + t.pending + ' תמונות – נסה שוב בעוד רגע', 'warn'); return; }

    job = buildJob();
    const my = ++session;
    ready = false;
    $('#preview-print').disabled = true;
    renderSummary();
    renderPages();
    MG.ui.openModal(modal(), { onRequestClose: close });
    $('#preview-pages').scrollTop = 0;

    const keep = new Set(job.photos.map((p) => app.hiKey(p).key));
    app.pruneHi(keep);

    let done = 0, failed = 0;
    const total = job.photos.length;
    setProgress(0, total, 0);
    await Promise.all(job.photos.map((p) => app.ensureHi(p, () => session !== my).then((url) => {
      if (session !== my || !url) return;
      done++;
      $$('#preview-pages img[data-id="' + p.id + '"]').forEach((img) => { img.src = url; });
      setProgress(done, total, failed);
    }).catch((err) => {
      console.error('print render failed', p.name, err);
      failed++;
      if (session === my) setProgress(done, total, failed);
    })));
    if (session !== my) return;
    if (failed) {
      toast('חלק מהתמונות לא הוכנו להדפסה. הסר אותן מהבחירה ונסה שוב.', 'error', 6000);
      return;
    }
    ready = true;
    $('#preview-print').disabled = false;
    $('#preview-print').focus();
  }

  function close() {
    session++;
    job = null;
    ready = false;
    MG.ui.closeModal(modal());
  }

  function waitForImages(root) {
    return Promise.all($$('img', root).map((img) => {
      if (img.decode) return img.decode().catch(() => {});
      if (img.complete) return Promise.resolve();
      return new Promise((r) => { img.onload = img.onerror = r; });
    }));
  }

  async function doPrint() {
    if (!job || !ready) return;
    const app = MG.app;
    const current = job;
    const missing = current.photos.filter((p) => !app.hiGet(p));
    if (missing.length) { toast('הקבצים להדפסה עדיין בהכנה', 'warn'); return; }

    const btn = $('#preview-print');
    btn.disabled = true;
    const root = $('#print-root');
    root.textContent = '';
    current.pages.forEach((pg) => root.append(buildSheet(pg, current.layout, 'print', (p) => app.hiGet(p), current.cutLines)));
    await waitForImages(root);

    const afterPrint = new Promise((resolve) => {
      const h = () => { window.removeEventListener('afterprint', h); resolve(); };
      window.addEventListener('afterprint', h);
    });
    window.print();
    await afterPrint;
    root.textContent = '';
    btn.disabled = false;

    const answer = await confirmDialog({
      title: 'ההדפסה הסתיימה?',
      message: 'נשלחו ' + current.pages.length + ' דפים עם ' + current.items.length + ' מגנטים. לסמן את התמונות כ"הודפסו"?',
      buttons: [
        { label: 'כן – סמן כהודפסו ונקה בחירה', value: 'clear', variant: 'primary' },
        { label: 'כן – סמן כהודפסו', value: 'mark' },
        { label: 'לא, ההדפסה בוטלה', value: 'no', variant: 'ghost' }
      ],
      dismissValue: 'no'
    });
    if (answer === 'clear' || answer === 'mark') {
      app.markPrinted(current.photos.map((p) => ({ p, copies: current.copies.get(p) || 0 })));
      if (answer === 'clear') app.clearSelectionOf(current.photos);
      close();
      toast('סומנו ' + current.items.length + ' מגנטים כמודפסים', 'success');
    }
  }

  function init() {
    $('#preview-close').addEventListener('click', close);
    $('#preview-back').addEventListener('click', close);
    $('#preview-print').addEventListener('click', doPrint);
    document.addEventListener('keydown', (e) => {
      if (MG.ui.topModal() !== modal()) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P' || e.key === 'פ')) {
        e.preventDefault();
        doPrint();
      }
    });
  }

  MG.print = { open, close, imageBox };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.MG = window.MG || {});
