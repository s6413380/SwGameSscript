// ==UserScript==
// @name         器靈（載入器）
// @namespace    local.auto-clicker
// @version      2.3
// @description  每次開頁面載入最新的器靈：本機中繼站和 GitHub 都抓，用版本比較新的；都失敗才用上次的版本
// @match        https://myteam.swordgale.online/*
// @grant        none
// @downloadURL  http://localhost:8787/auto-clicker-v2.loader.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 本機中繼站（開發時改完立刻生效）和 GitHub（朋友不用開中繼站也能自動更新）都抓，用版本比較新的；
  // 朋友電腦的中繼站可能還放著舊版，所以不能有中繼站就只用中繼站。都失敗才用上次成功的快取
  const SOURCES = [
    { label: '中繼站最新版', url: 'http://localhost:8787/auto-clicker-v2.user.js', timeout: 3000 },
    // 加時間參數避開 GitHub 的 5 分鐘快取
    { label: 'GitHub 最新版', url: () => `https://raw.githubusercontent.com/s6413380/SwGameSscript/main/auto-clicker-v2.user.js?t=${Date.now()}`, timeout: 15000 },
  ];
  const CACHE_STORAGE_KEY = 'autoClickerV2LoaderCache';
  // 快取是整份主程式（快 1MB），放 localStorage 會跟遊戲搶那 5MB；改放 IndexedDB，跟主程式的資料庫分開，免得版本號互相影響
  const CACHE_DB_NAME = 'autoClickerV2Loader';
  // 共用的雲端試算表網址放在載入器裡（私下傳給朋友），GitHub 上的公開主程式就不用帶著它
  // 公開版不附網址：要用共用試算表就把 Apps Script 網址填在這裡，或在面板「其他 → 雲端」填
  const CLOUD_URL = '';

  function run(code, source) {
    window.__autoClickerCloudUrl = CLOUD_URL;
    window.__autoClickerSource = source;
    const script = document.createElement('script');
    // sourceURL 讓瀏覽器的錯誤訊息指到 auto-clicker-v2.user.js，而不是一段匿名程式
    script.textContent = `${code}\n//# sourceURL=auto-clicker-v2.user.js`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    console.info(`[器靈 載入器] 已載入（${source}）`);
  }

  async function fetchScript({ url, timeout }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(typeof url === 'function' ? url() : url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const code = await response.text();
      // 抓到的不是腳本（例如錯誤頁）就當失敗
      if (!code.includes('==UserScript==')) throw new Error('內容不是腳本');
      return code;
    } finally {
      clearTimeout(timer);
    }
  }

  function versionOf(code) {
    const match = /@version\s+([\d.]+)/.exec(code);
    return match ? match[1].split('.').map(Number) : [];
  }

  function isNewer(first, second) {
    for (let index = 0; index < Math.max(first.length, second.length); index++) {
      const difference = (first[index] || 0) - (second[index] || 0);
      if (difference) return difference > 0;
    }
    return false;
  }

  function openCacheDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveCache(code) {
    try {
      const db = await openCacheDb();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('kv', 'readwrite');
        transaction.objectStore('kv').put(code, CACHE_STORAGE_KEY);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
      // 資料庫存好了才刪舊版留在 localStorage 的那份
      localStorage.removeItem(CACHE_STORAGE_KEY);
    } catch {
      // 存不了快取只影響之後全部連不上時的備援
    }
  }

  async function readCache() {
    try {
      const db = await openCacheDb();
      const code = await new Promise((resolve, reject) => {
        const get = db.transaction('kv').objectStore('kv').get(CACHE_STORAGE_KEY);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      db.close();
      if (typeof code === 'string') return code;
    } catch {
      // 資料庫打不開就看舊版的 localStorage
    }
    try {
      return localStorage.getItem(CACHE_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  (async () => {
    const failures = [];
    const results = await Promise.all(
      SOURCES.map((source) =>
        fetchScript(source).then(
          (code) => ({ source, code }),
          (error) => {
            failures.push(`${source.label}：${error.message}`);
            return null;
          }
        )
      )
    );
    // 版本一樣時用前面的（中繼站）
    const best = results.filter(Boolean).reduce((chosen, result) => (!chosen || isNewer(versionOf(result.code), versionOf(chosen.code)) ? result : chosen), null);
    if (best) {
      run(best.code, best.source.label);
      saveCache(best.code);
      return;
    }
    const cached = await readCache();
    if (cached) run(cached, `連不上（${failures.join('；')}），用上次的版本`);
    else console.error('[器靈 載入器] 中繼站和 GitHub 都連不上，也沒有上次的版本', failures);
  })();
})();
