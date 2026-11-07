/* Persistence: settings in localStorage, event frames (binary) in IndexedDB. */
(function (MG) {
  'use strict';
  const LS_KEY = 'magnet-studio.settings.v1';

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
  }

  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
        const req = indexedDB.open('magnet-studio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  function tx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const store = d.transaction('kv', mode).objectStore('kv');
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }
  const idbGet = (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined);
  const idbSet = (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => undefined);
  const idbDel = (k) => tx('readwrite', (s) => s.delete(k)).catch(() => undefined);

  MG.store = { loadSettings, saveSettings, idbGet, idbSet, idbDel };
})(window.MG = window.MG || {});
