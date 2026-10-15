// 貼到 Google 試算表的 Apps Script（擴充功能 → Apps Script），部署成網頁應用程式後，把網址填進遊戲面板「雲端」頁。
// 每個人的腳本會把自己的成長值、鍛造材料紀錄傳上來，再把所有人的下載回去合併。

// 最後兩欄（提供者、上傳時間）由這裡補，腳本送來的列不含這兩欄
const SHEETS = {
  growth: ['key', 'heroId', 'name', 'type', 'typeId', 'tier', 'potential', 'from', 'to', 'place', 'time', 'diff', 'contributor', 'uploadedAt'],
  equipment: ['equipmentId', 'type', 'quality', 'atk', 'def', 'int', 'lck', 'wgt', 'fullDur', 'fullSlots', 'recyclePrice', 'enchantments', 'materials', 'forger', 'craftedTime', 'name', 'contributor', 'uploadedAt'],
  // 地圖編號與換地圖的路線（kind = zone / route），API 打怪換地圖用
  places: ['key', 'kind', 'zone', 'name', 'fromZone', 'fromStage', 'toZone', 'toStage', 'path', 'contributor', 'uploadedAt'],
  // 帳號之間轉帳的傳話（event = request / listed / failed），只新增不修改
  transfers: ['key', 'transferId', 'from', 'to', 'amount', 'mine', 'token', 'event', 'at', 'contributor', 'uploadedAt'],
  // 角色遇過的異常狀態名稱（中毒…），挖礦「不理會」的勾選清單大家共用
  conditions: ['name', 'seenAt', 'contributor', 'uploadedAt'],
  // 抽卡結果（英雄 id 唯一）、刮刮樂每次的花費與獎項（prizes 是 JSON），大家的合起來看機率
  draws: ['heroId', 'at', 'item', 'type', 'tier', 'potential', 'contributor', 'uploadedAt'],
  scratches: ['key', 'at', 'card', 'count', 'cost', 'won', 'prizes', 'contributor', 'uploadedAt'],
};
// 跟遊戲腳本的 CLOUD_PAGE_ROWS 要一樣，腳本靠「拿到的列數少於這個」判斷已經抓完
const PAGE_ROWS = 3000;
// 網址拿到的人都能寫，限制單次大小避免被灌爆
const MAX_ROWS_PER_POST = 2000;
const MAX_TEXT_LENGTH = 2000;

function sheetFor(name) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonOutput(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// ?after_growth=N&after_equipment=M&after_places=K：從第 N 筆之後開始給，腳本記住看到哪裡，下次只抓新的
// ?only=transfers：只讀轉帳分頁（每 30 秒看一次，不用連其他分頁一起讀）；after 給負數＝只要最後幾筆
function doGet(event) {
  const result = {};
  const only = event.parameter.only;
  Object.keys(SHEETS).filter((name) => !only || name === only).forEach((name) => {
    const sheet = sheetFor(name);
    const total = sheet.getLastRow() - 1;
    const asked = Number(event.parameter['after_' + name]) || 0;
    const after = asked < 0 ? Math.max(0, total + asked) : asked;
    const count = Math.max(0, Math.min(PAGE_ROWS, total - after));
    // 上傳時間不用給腳本
    const rows = count ? sheet.getRange(2 + after, 1, count, SHEETS[name].length - 1).getValues() : [];
    result[name] = { rows, next: after + count };
  });
  return jsonOutput(result);
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(event.postData.contents);
    const contributor = String(body.contributor || '未署名').slice(0, 30);
    const now = new Date().toISOString();
    const added = {};
    Object.keys(SHEETS).forEach((name) => {
      const width = SHEETS[name].length;
      const incoming = Array.isArray(body[name]) ? body[name].slice(0, MAX_ROWS_PER_POST) : [];
      const sheet = sheetFor(name);
      const last = sheet.getLastRow();
      // 第一欄是唯一鍵，同一筆不管誰傳、傳幾次都只留一份
      const known = new Set(last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues().map((row) => String(row[0])) : []);
      const fresh = [];
      incoming.forEach((row) => {
        if (!Array.isArray(row) || row.length !== width - 2) return;
        const key = String(row[0]);
        if (!key || known.has(key)) return;
        known.add(key);
        const cells = row.map((value) => (typeof value === 'number' && isFinite(value) ? value : String(value).slice(0, MAX_TEXT_LENGTH)));
        fresh.push(cells.concat([contributor, now]));
      });
      if (fresh.length) {
        const needed = last + fresh.length - sheet.getMaxRows();
        if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed);
        const range = sheet.getRange(last + 1, 1, fresh.length, width);
        // 文字欄設成純文字，不然「2026-10-11T…」、「3/4」這類內容會被試算表自動轉成日期
        range.setNumberFormats(fresh.map((row) => row.map((value) => (typeof value === 'number' ? 'General' : '@'))));
        range.setValues(fresh);
      }
      added[name] = fresh.length;
    });
    return jsonOutput({ ok: true, added });
  } catch (error) {
    return jsonOutput({ ok: false, error: String(error) });
  } finally {
    lock.releaseLock();
  }
}
