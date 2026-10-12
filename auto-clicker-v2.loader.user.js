// ==UserScript==
// @name         自動點擊按鈕 V2（載入器）
// @namespace    local.auto-clicker
// @version      1.0
// @description  每次開頁面都從本機 monitor-server.ps1 載入最新的自動點擊 V2，改完腳本重新整理分頁就生效，不用每個瀏覽器各自更新
// @match        https://myteam.swordgale.online/*
// @grant        none
// @downloadURL  http://localhost:8787/auto-clicker-v2.loader.user.js
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_URL = 'http://localhost:8787/auto-clicker-v2.user.js';
  // 中繼站沒開時改用上次載入成功的版本，掛機不會因為忘了開中繼站就停擺
  const CACHE_STORAGE_KEY = 'autoClickerV2LoaderCache';

  function run(code, source) {
    const script = document.createElement('script');
    // sourceURL 讓瀏覽器的錯誤訊息指到 auto-clicker-v2.user.js，而不是一段匿名程式
    script.textContent = `${code}\n//# sourceURL=auto-clicker-v2.user.js`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    console.info(`[自動點擊 V2 載入器] 已載入（${source}）`);
  }

  fetch(SCRIPT_URL, { cache: 'no-store' })
    .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((code) => {
      try {
        localStorage.setItem(CACHE_STORAGE_KEY, code);
      } catch {
        // 存不了快取只影響中繼站沒開時的備援
      }
      run(code, '中繼站最新版');
    })
    .catch((error) => {
      let cached = null;
      try {
        cached = localStorage.getItem(CACHE_STORAGE_KEY);
      } catch {
        // 讀不到快取就只能提示
      }
      if (cached) {
        run(cached, `中繼站連不上（${error.message}），用上次的版本`);
      } else {
        console.error('[自動點擊 V2 載入器] 中繼站連不上，也沒有上次的版本，請先執行 monitor-server.ps1', error);
      }
    });
})();
