/* Page layout engine: packs magnet slots onto an A4 sheet as efficiently as possible. */
(function (MG) {
  'use strict';

  const A4 = { w: 210, h: 297 };
  const EPS = 1e-6;

  const PRESETS = [
    { id: '5x7.5', label: '5 × 7.5', w: 50, h: 75 },
    { id: '6x9', label: '6 × 9', w: 60, h: 90 },
    { id: '6.5x9', label: '6.5 × 9', w: 65, h: 90 },
    { id: '7x10', label: '7 × 10', w: 70, h: 100 },
    { id: '9x13', label: '9 × 13', w: 90, h: 130 },
    { id: '10x15', label: '10 × 15', w: 100, h: 150 },
    { id: 'custom', label: 'מותאם אישית', w: 0, h: 0 }
  ];

  const COUNT_OPTIONS = [1, 2, 4, 6, 8, 9, 10, 12, 15, 16, 20, 24, 30];

  function fitGrid(W, H, w, h, g) {
    if (w <= 0 || h <= 0 || W + EPS < w || H + EPS < h) return { c: 0, r: 0 };
    return {
      c: Math.floor((W + g + EPS) / (w + g)),
      r: Math.floor((H + g + EPS) / (h + g))
    };
  }

  function span(n, size, g) {
    return n > 0 ? n * size + (n - 1) * g : 0;
  }

  /**
   * Find the arrangement with the largest number of slots.
   * Considers a uniform grid in both orientations, and (optionally) a "mixed" layout:
   * a main grid plus a strip of rotated slots in the leftover space.
   */
  function pack(opts) {
    const pageW = opts.pageW || A4.w;
    const pageH = opts.pageH || A4.h;
    const m = Math.max(0, +opts.margin || 0);
    const g = Math.max(0, +opts.gap || 0);
    const a = Math.min(opts.slotW, opts.slotH);
    const b = Math.max(opts.slotW, opts.slotH);
    const W = pageW - 2 * m;
    const H = pageH - 2 * m;
    const preferPortrait = opts.preferPortrait !== false;

    const empty = { slots: [], capacity: 0, mixed: false, rotatedCount: 0, utilization: 0, slotShort: a, slotLong: b };
    if (!(a > 0) || W <= 0 || H <= 0) return empty;

    const orients = Math.abs(a - b) < EPS ? [[a, b]] : (preferPortrait ? [[a, b], [b, a]] : [[b, a], [a, b]]);
    let best = null;
    const consider = (cand) => {
      if (cand.count <= 0) return;
      if (!best || cand.count > best.count || (cand.count === best.count && cand.score < best.score)) best = cand;
    };

    orients.forEach(([w, h], oi) => {
      const full = fitGrid(W, H, w, h, g);
      consider({ count: full.c * full.r, score: oi, split: 'h', blocks: [{ c: full.c, r: full.r, w, h }] });
      if (!opts.allowMixed || orients.length === 1) return;
      // Horizontal split: r rows of the main orientation, rotated strip below.
      for (let r = 1; r <= full.r; r++) {
        const used = span(r, h, g) + g;
        const strip = fitGrid(W, H - used, h, w, g);
        if (strip.c * strip.r === 0 || full.c === 0) continue;
        consider({
          count: r * full.c + strip.c * strip.r, score: 10 + oi, split: 'h',
          blocks: [{ c: full.c, r, w, h }, { c: strip.c, r: strip.r, w: h, h: w }]
        });
      }
      // Vertical split: c columns of the main orientation, rotated strip beside.
      for (let c = 1; c <= full.c; c++) {
        const used = span(c, w, g) + g;
        const strip = fitGrid(W - used, H, h, w, g);
        if (strip.c * strip.r === 0 || full.r === 0) continue;
        consider({
          count: c * full.r + strip.c * strip.r, score: 20 + oi, split: 'v',
          blocks: [{ c, r: full.r, w, h }, { c: strip.c, r: strip.r, w: h, h: w }]
        });
      }
    });

    if (!best) return empty;

    const blocks = best.blocks.filter((bl) => bl.c > 0 && bl.r > 0);
    const slots = [];
    const pushBlock = (bl, x0, y0) => {
      const bw = span(bl.c, bl.w, g);
      for (let r = 0; r < bl.r; r++) {
        for (let c = 0; c < bl.c; c++) {
          // Right-to-left fill order (Hebrew reading order).
          slots.push({ x: x0 + bw - (c + 1) * bl.w - c * g, y: y0 + r * (bl.h + g), w: bl.w, h: bl.h });
        }
      }
    };

    if (best.split === 'h') {
      const total = blocks.reduce((s, bl) => s + span(bl.r, bl.h, g), 0) + g * (blocks.length - 1);
      let y = m + (H - total) / 2;
      blocks.forEach((bl) => {
        pushBlock(bl, m + (W - span(bl.c, bl.w, g)) / 2, y);
        y += span(bl.r, bl.h, g) + g;
      });
    } else {
      const total = blocks.reduce((s, bl) => s + span(bl.c, bl.w, g), 0) + g * (blocks.length - 1);
      let xr = m + (W + total) / 2;
      blocks.forEach((bl) => {
        const bw = span(bl.c, bl.w, g);
        pushBlock(bl, xr - bw, m + (H - span(bl.r, bl.h, g)) / 2);
        xr -= bw + g;
      });
    }

    const mainLandscape = blocks[0].w > blocks[0].h;
    const rotatedCount = slots.filter((s) => (s.w > s.h) !== mainLandscape).length;
    return {
      slots,
      capacity: slots.length,
      mixed: blocks.length > 1,
      rotatedCount,
      utilization: (slots.length * a * b) / (pageW * pageH),
      slotShort: a,
      slotLong: b
    };
  }

  /** Largest slot (keeping `ratio` = long/short) such that at least `n` slots fit on the page. */
  function sizeForCount(n, ratio, margin, gap, allowMixed, preferPortrait) {
    ratio = Math.max(1, ratio || 1.5);
    let lo = 1, hi = 300;
    const fits = (s) => pack({ margin, gap, slotW: s, slotH: s * ratio, allowMixed, preferPortrait }).capacity >= n;
    if (!fits(lo)) return { w: lo, h: lo * ratio };
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    const s = Math.floor(lo * 10) / 10;
    return { w: s, h: Math.floor(s * ratio * 10) / 10 };
  }

  MG.layout = { A4, PRESETS, COUNT_OPTIONS, pack, sizeForCount, fitGrid };
  if (typeof module !== 'undefined' && module.exports) module.exports = MG.layout;
})(typeof window !== 'undefined' ? (window.MG = window.MG || {}) : {});
