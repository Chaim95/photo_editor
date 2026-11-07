/* Image engine: decoding, compositing photo + frame, and a Web Worker pool so heavy work never blocks the UI. */
(function (MG) {
  'use strict';

  /*
   * IMPORTANT: engineFactory is serialized with toString() and executed inside Web Workers,
   * so it must not reference anything outside its own body (except platform globals).
   */
  function engineFactory(env) {
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const normRot = (r) => ((((r || 0) % 360) + 360) % 360);

    async function decode(blob) {
      try {
        return await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch (e) {
        return await createImageBitmap(blob);
      }
    }

    function release(img) {
      if (img && typeof img.close === 'function') {
        try { img.close(); } catch (e) { /* already closed */ }
      }
    }

    function rotatedDims(w, h, rot) {
      return normRot(rot) % 180 === 90 ? [h, w] : [w, h];
    }

    /** Which frame (portrait/landscape/none) a photo should use. */
    function chooseFrame(pref, w, h, rot, avail) {
      if (pref === 'none') return null;
      const hasP = !!(avail && avail.portrait);
      const hasL = !!(avail && avail.landscape);
      if (!hasP && !hasL) return null;
      if (pref === 'portrait' && hasP) return 'portrait';
      if (pref === 'landscape' && hasL) return 'landscape';
      if (hasP && hasL) {
        const d = rotatedDims(w, h, rot);
        return d[0] > d[1] ? 'landscape' : 'portrait';
      }
      return hasP ? 'portrait' : 'landscape';
    }

    /** Output pixel size of a composite. The frame defines the aspect ratio; without a frame the magnet ratio does. */
    function compositeSize(frameKey, frameDims, w, h, rot, noFrameRatio, longPx) {
      let ar;
      const fd = frameKey && frameDims && frameDims[frameKey];
      if (fd) {
        ar = fd.w / fd.h;
      } else {
        const d = rotatedDims(w, h, rot);
        const r = noFrameRatio || 1.5;
        ar = d[0] >= d[1] ? r : 1 / r;
      }
      return ar >= 1
        ? { W: Math.round(longPx), H: Math.max(1, Math.round(longPx / ar)) }
        : { W: Math.max(1, Math.round(longPx * ar)), H: Math.round(longPx) };
    }

    /** Default vertical position: when a tall photo is cropped top/bottom keep the upper part (faces). */
    function autoPanY(rw, rh, W, H, fit) {
      if (fit === 'contain') return 0;
      return rw / rh < (W / H) * 0.9 ? 0.35 : 0;
    }

    /**
     * Where the photo is drawn inside a W x H composite.
     * edit: { rot (deg), zoom (>=1), px, py (-1..1 normalized pan; py null = auto), fit: 'cover' | 'contain' }
     */
    function placement(sw, sh, edit, W, H) {
      edit = edit || {};
      const rot = normRot(edit.rot);
      const d = rotatedDims(sw, sh, rot);
      const rw = d[0], rh = d[1];
      const fit = edit.fit === 'contain' ? 'contain' : 'cover';
      const base = fit === 'contain' ? Math.min(W / rw, H / rh) : Math.max(W / rw, H / rh);
      const zoom = clamp(edit.zoom || 1, 1, 8);
      const s = base * zoom;
      const dw = rw * s, dh = rh * s;
      const slackX = Math.max(0, (dw - W) / 2);
      const slackY = Math.max(0, (dh - H) / 2);
      const px = clamp(edit.px || 0, -1, 1);
      const py = edit.py == null ? autoPanY(rw, rh, W, H, fit) : clamp(edit.py, -1, 1);
      return { rot, s, rw, rh, dw, dh, slackX, slackY, px, py, cx: W / 2 + px * slackX, cy: H / 2 + py * slackY };
    }

    function smoothing(ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }

    function drawPlaced(ctx, img, sw, sh, p) {
      ctx.save();
      ctx.translate(p.cx, p.cy);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.drawImage(img, (-sw * p.s) / 2, (-sh * p.s) / 2, sw * p.s, sh * p.s);
      ctx.restore();
    }

    /** High quality downscale (successive halving) of any drawable to tw x th. */
    function scaledSource(img, sw, sh, tw, th) {
      tw = Math.max(1, Math.round(tw));
      th = Math.max(1, Math.round(th));
      let cur = img, cw = sw, ch = sh;
      while (cw / 2 >= tw && ch / 2 >= th) {
        const nw = Math.max(1, Math.round(cw / 2)), nh = Math.max(1, Math.round(ch / 2));
        const c = env.createCanvas(nw, nh);
        const x = c.getContext('2d');
        smoothing(x);
        x.drawImage(cur, 0, 0, nw, nh);
        cur = c; cw = nw; ch = nh;
      }
      if (cw !== tw || ch !== th || cur === img) {
        const c = env.createCanvas(tw, th);
        const x = c.getContext('2d');
        smoothing(x);
        x.drawImage(cur, 0, 0, tw, th);
        cur = c;
      }
      return cur;
    }

    /** Soft blurred backdrop, used when the photo does not fill the frame ("fit whole photo" mode). */
    function drawBackdrop(ctx, img, sw, sh, edit, W, H) {
      const tw = Math.max(4, Math.round(W / 40)), th = Math.max(4, Math.round(H / 40));
      const t = env.createCanvas(tw, th);
      const tc = t.getContext('2d');
      smoothing(tc);
      drawPlaced(tc, img, sw, sh, placement(sw, sh, { rot: edit.rot, fit: 'cover', zoom: 1, px: 0, py: 0 }, tw, th));
      const mw = Math.max(8, Math.round(W / 8)), mh = Math.max(8, Math.round(H / 8));
      const m = env.createCanvas(mw, mh);
      const mc = m.getContext('2d');
      smoothing(mc);
      mc.drawImage(t, 0, 0, mw, mh);
      ctx.save();
      smoothing(ctx);
      ctx.drawImage(m, 0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    /** Draw the full composite (photo + frame) into a context. */
    function renderTo(ctx, img, sw, sh, edit, frameImg, W, H) {
      smoothing(ctx);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      const p = placement(sw, sh, edit, W, H);
      if (p.dw < W - 0.5 || p.dh < H - 0.5) drawBackdrop(ctx, img, sw, sh, edit || {}, W, H);
      drawPlaced(ctx, img, sw, sh, p);
      if (frameImg) ctx.drawImage(frameImg, 0, 0, W, H);
      return p;
    }

    const frameCache = new Map();
    function frameAt(frames, key, W, H) {
      const f = frames && frames[key];
      if (!f) return null;
      const ck = (frames.ver || 0) + ':' + key + ':' + W + 'x' + H;
      let c = frameCache.get(ck);
      if (!c) {
        c = scaledSource(f.bitmap, f.w, f.h, W, H);
        frameCache.set(ck, c);
        while (frameCache.size > 6) frameCache.delete(frameCache.keys().next().value);
      }
      return c;
    }

    async function composeFromSource(img, sw, sh, task, frames) {
      const W = task.W, H = task.H;
      const p = placement(sw, sh, task.edit, W, H);
      let src = img;
      const tw = sw * p.s, th = sh * p.s;
      if (tw < sw * 0.7) src = scaledSource(img, sw, sh, tw, th);
      const c = env.createCanvas(W, H);
      const ctx = c.getContext('2d');
      renderTo(ctx, src, sw, sh, task.edit, task.frameKey ? frameAt(frames, task.frameKey, W, H) : null, W, H);
      return env.toBlob(c, task.type || 'image/jpeg', task.quality || 0.92);
    }

    function availOf(frames) {
      return { portrait: !!(frames && frames.portrait), landscape: !!(frames && frames.landscape) };
    }
    function dimsOf(frames) {
      const o = {};
      ['portrait', 'landscape'].forEach((k) => { o[k] = frames && frames[k] ? { w: frames[k].w, h: frames[k].h } : null; });
      return o;
    }

    async function ingest(task, frames) {
      const bmp = await decode(task.file);
      const w = bmp.width, h = bmp.height;
      let prev;
      try {
        const ps = Math.min(1, task.previewLong / Math.max(w, h));
        prev = scaledSource(bmp, w, h, w * ps, h * ps);
      } finally {
        release(bmp);
      }
      const pw = prev.width, ph = prev.height;
      const preview = await env.toBlob(prev, 'image/jpeg', 0.9);
      const frameKey = chooseFrame(task.edit.frame, w, h, task.edit.rot, availOf(frames));
      const size = compositeSize(frameKey, dimsOf(frames), w, h, task.edit.rot, task.noFrameRatio, task.thumbLong);
      const thumb = await composeFromSource(prev, pw, ph, { edit: task.edit, frameKey, W: size.W, H: size.H, quality: 0.85 }, frames);
      return { w, h, preview, thumb, stamp: task.stamp };
    }

    async function run(task, frames) {
      if (task.kind === 'ingest') return ingest(task, frames);
      if (task.kind === 'composite') {
        const bmp = await decode(task.src);
        try {
          const blob = await composeFromSource(bmp, bmp.width, bmp.height, task, frames);
          return { blob, stamp: task.stamp };
        } finally {
          release(bmp);
        }
      }
      throw new Error('Unknown task: ' + task.kind);
    }

    return {
      decode, release, rotatedDims, chooseFrame, compositeSize, placement, renderTo, scaledSource, run,
      resetFrameCache: () => frameCache.clear()
    };
  }

  const mainEnv = {
    createCanvas(w, h) {
      if (typeof OffscreenCanvas !== 'undefined') {
        try {
          const c = new OffscreenCanvas(w, h);
          if (c.getContext('2d')) return c;
        } catch (e) { /* fall through */ }
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    },
    toBlob(c, type, quality) {
      if (c.convertToBlob) return c.convertToBlob({ type, quality });
      return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, quality));
    }
  };

  function workerSource() {
    return [
      "'use strict';",
      'const engineFactory = ' + engineFactory.toString() + ';',
      'const env = { createCanvas: (w, h) => new OffscreenCanvas(w, h), toBlob: (c, type, quality) => c.convertToBlob({ type, quality }) };',
      'const engine = engineFactory(env);',
      'let frames = { ver: 0, portrait: null, landscape: null };',
      'let framesReady = Promise.resolve();',
      'async function loadFrames(m) {',
      '  const out = { ver: m.ver, portrait: null, landscape: null };',
      "  for (const k of ['portrait', 'landscape']) { if (m[k]) { const b = await engine.decode(m[k]); out[k] = { bitmap: b, w: b.width, h: b.height }; } }",
      '  frames = out; engine.resetFrameCache();',
      '}',
      'self.onmessage = async (e) => {',
      '  const m = e.data;',
      "  if (m.type === 'ping') { let ok = false; try { ok = !!new OffscreenCanvas(2, 2).getContext('2d'); } catch (err) {} self.postMessage({ type: 'pong', ok }); return; }",
      "  if (m.type === 'frames') { framesReady = loadFrames(m).catch(() => {}); return; }",
      "  if (m.type === 'task') {",
      '    try { await framesReady; const result = await engine.run(m.task, frames); self.postMessage({ type: \'result\', id: m.id, ok: true, result }); }',
      "    catch (err) { self.postMessage({ type: 'result', id: m.id, ok: false, error: (err && err.message) || String(err) }); }",
      '  }',
      '};'
    ].join('\n');
  }

  function canUseWorkers() {
    return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' &&
      typeof OffscreenCanvas.prototype.convertToBlob === 'function' && typeof createImageBitmap === 'function';
  }

  function ping(worker, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('worker timeout')), ms);
      worker.onmessage = (e) => {
        if (e.data && e.data.type === 'pong') {
          clearTimeout(t);
          e.data.ok ? resolve() : reject(new Error('no OffscreenCanvas 2d'));
        }
      };
      worker.onerror = (e) => { clearTimeout(t); reject(e); };
      worker.postMessage({ type: 'ping' });
    });
  }

  /** Priority task pool. Lower priority number runs first. */
  class Pool {
    constructor() {
      this.slots = [];
      this.queue = [];
      this.seq = 0;
      this.mode = 'none';
      this.frames = { type: 'frames', ver: 0, portrait: null, landscape: null };
    }

    async init() {
      if (canUseWorkers()) {
        const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
        const workers = [];
        try {
          const url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
          for (let i = 0; i < n; i++) workers.push(new Worker(url));
          await Promise.all(workers.map((w) => ping(w, 5000)));
          this.slots = workers.map((w) => this._workerSlot(w));
          this.mode = 'worker';
          return this;
        } catch (e) {
          workers.forEach((w) => w.terminate());
        }
      }
      this.mode = 'main';
      const engine = engineFactory(mainEnv);
      let frames = { ver: 0, portrait: null, landscape: null };
      let ready = Promise.resolve();
      this._mainSetFrames = (m) => {
        ready = (async () => {
          const out = { ver: m.ver, portrait: null, landscape: null };
          for (const k of ['portrait', 'landscape']) {
            if (m[k]) { const b = await engine.decode(m[k]); out[k] = { bitmap: b, w: b.width, h: b.height }; }
          }
          frames = out;
          engine.resetFrameCache();
        })().catch(() => {});
      };
      const slot = { busy: false };
      slot.start = (item) => {
        ready.then(() => engine.run(item.task, frames))
          .then((r) => this._finish(slot, item, true, r), (err) => this._finish(slot, item, false, err));
      };
      this.slots = [slot];
      return this;
    }

    _workerSlot(w) {
      const slot = { busy: false, current: null, worker: w };
      w.onmessage = (e) => {
        const m = e.data;
        if (!m || m.type !== 'result') return;
        const item = slot.current;
        slot.current = null;
        this._finish(slot, item, m.ok, m.ok ? m.result : new Error(m.error));
      };
      w.onerror = (e) => {
        if (e.preventDefault) e.preventDefault();
        const item = slot.current;
        slot.current = null;
        this._finish(slot, item, false, new Error(e.message || 'worker error'));
      };
      slot.start = (item) => {
        slot.current = item;
        w.postMessage({ type: 'task', id: item.seq, task: item.task });
      };
      w.postMessage(this.frames);
      return slot;
    }

    _finish(slot, item, ok, value) {
      slot.busy = false;
      if (item) (ok ? item.resolve(value) : item.reject(value instanceof Error ? value : new Error(String(value))));
      this._pump();
    }

    setFrames(portraitBlob, landscapeBlob, ver) {
      this.frames = { type: 'frames', ver, portrait: portraitBlob || null, landscape: landscapeBlob || null };
      if (this.mode === 'worker') this.slots.forEach((s) => s.worker.postMessage(this.frames));
      else if (this._mainSetFrames) this._mainSetFrames(this.frames);
    }

    /** Queue a task. isStale(): if it returns true when the task is about to start, it is skipped (resolves null). */
    run(task, priority, isStale) {
      return new Promise((resolve, reject) => {
        this.queue.push({ task, priority: priority == null ? 5 : priority, seq: this.seq++, resolve, reject, isStale });
        this._pump();
      });
    }

    pendingCount() {
      return this.queue.length + this.slots.filter((s) => s.busy).length;
    }

    _take() {
      while (this.queue.length) {
        let bi = 0;
        for (let i = 1; i < this.queue.length; i++) {
          const a = this.queue[i], b = this.queue[bi];
          if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) bi = i;
        }
        const item = this.queue.splice(bi, 1)[0];
        if (item.isStale && item.isStale()) { item.resolve(null); continue; }
        return item;
      }
      return null;
    }

    _pump() {
      for (const slot of this.slots) {
        if (slot.busy) continue;
        const item = this._take();
        if (!item) return;
        slot.busy = true;
        slot.start(item);
      }
    }
  }

  MG.engine = { engineFactory, Pool, mainEnv, main: engineFactory(mainEnv) };
})(window.MG = window.MG || {});
