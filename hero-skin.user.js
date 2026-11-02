// ==UserScript==
// @name         角色換圖
// @namespace    hero-skin
// @version      1.1
// @description  只換圖：角色頭像（整種卡共用或單獨角色）、遊戲網頁／角色卡（統一或每隻角色）／頭像底圖背景，可用動圖。只有自己看得到
// @match        https://myteam.swordgale.online/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.__heroSkinActive) return;
  // 同時裝了別的換圖程式時讓它們知道，免得兩邊搶著改同一張圖
  window.__heroSkinActive = true;

  // 遊戲的角色圖是 /hero-avatars/{typeId}.png（同種卡同一張，typeId 是英文名稱），alt 是種類名稱，畫面上沒有角色 id。
  // 頭像兩種設定：整種卡共用（看 alt）、單獨某隻角色（看圖旁邊的名字認），單獨的優先
  const HERO_AVATAR_PATTERN = /\/hero-avatars\/([^/?#]+)\.png/;
  const HERO_AVATAR_IMAGES = 'img[src*="/hero-avatars/"], img[data-original-avatar]';
  // 往上找包住「這張圖＋名字」的區塊最多幾層；再上去就是整個列表
  const HERO_AVATAR_CLIMB = 6;
  const HERO_AVATAR_SIZE = 168;
  // 動圖（GIF、WebP）經過 canvas 會只剩第一格，所以原檔照存；太大會拖慢每次重畫
  const ANIMATED_IMAGE_TYPES = ['image/gif', 'image/webp', 'image/apng'];
  const ANIMATED_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
  const BACKGROUND_PARTS = [
    ['page', '遊戲網頁', 40],
    ['card', '角色卡', 55],
    ['avatar', '頭像底圖', 0],
  ];
  const BACKGROUND_MAX_SIDE = { page: 1920, card: 800, avatar: HERO_AVATAR_SIZE };
  const PAGE_BACKGROUND_STYLE_ID = 'hero-skin-page-background';
  const HEROES_FRESH_MILLISECONDS = 5 * 60000;

  // 圖片可能好幾 MB，放 IndexedDB；記憶體留一份給同步讀取。heroes { heroId: { name, type, typeId, image（頭像）, cardImage（卡片背景）} }、
  // types { 種類名稱: { typeId, image } }、backgrounds { page|card|avatar: { image, dim } }
  const store = { db: null, values: { heroes: {}, types: {}, backgrounds: {} } };
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('heroSkin') : null;
  let heroList = [];
  let heroListAt = 0;
  const view = { open: false, pickingScope: '', pickingKey: '' };

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('heroSkin', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function readDbKeys(db, storeName, keys) {
    return new Promise((resolve) => {
      const result = {};
      let transaction;
      try {
        transaction = db.transaction(storeName);
      } catch {
        resolve(result);
        return;
      }
      const objects = transaction.objectStore(storeName);
      keys.forEach((key) => {
        const get = objects.get(key);
        get.onsuccess = () => (result[key] = get.result);
      });
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => resolve(result);
    });
  }

  async function loadStore() {
    try {
      store.db = await openDb();
    } catch {
      return;
    }
    const saved = await readDbKeys(store.db, 'kv', Object.keys(store.values));
    Object.keys(store.values).forEach((key) => {
      if (saved[key] && typeof saved[key] === 'object') store.values[key] = saved[key];
    });
  }

  function save(key) {
    if (!store.db) return;
    try {
      const transaction = store.db.transaction('kv', 'readwrite');
      transaction.objectStore('kv').put(store.values[key], key);
      transaction.oncomplete = () => channel && channel.postMessage({ key });
    } catch {
      // 存不了只是重新整理後不見
    }
  }

  if (channel) {
    channel.onmessage = async (event) => {
      const key = event.data && event.data.key;
      if (!store.db || !(key in store.values)) return;
      const saved = await readDbKeys(store.db, 'kv', [key]);
      if (saved[key] && typeof saved[key] === 'object') store.values[key] = saved[key];
      applyAll();
      if (view.open) render();
    };
  }

  function toast(text) {
    const note = document.createElement('div');
    note.textContent = text;
    note.style.cssText = 'position:fixed;left:16px;bottom:64px;z-index:2147483647;background:#292524;color:#f5f5f4;border:1px solid #57534e;border-radius:8px;padding:8px 12px;font-size:13px;max-width:320px';
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 4000);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  async function refreshHeroList(force = false) {
    if (!force && Date.now() - heroListAt < HEROES_FRESH_MILLISECONDS) return;
    heroListAt = Date.now();
    const response = await fetch('/api/heroes', { headers: { token: localStorage.getItem('token') || '' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    heroList = (await response.json()).heroes || [];
  }

  // ---- 認圖、換圖 ----

  // 認名字用的候選：自己全部角色（沒換圖的也要，免得「瘟疫醫生2」的卡被認成「瘟疫醫生」）
  function candidates() {
    const result = new Map();
    heroList.forEach((hero) => result.set(String(hero.id), { name: hero.name, type: hero.type, lv: hero.lv, image: '', cardImage: '' }));
    Object.entries(store.values.heroes).forEach(([heroId, record]) => {
      const known = result.get(heroId);
      const images = { image: record.image || '', cardImage: record.cardImage || '' };
      result.set(heroId, known ? { ...known, ...images } : { name: record.name, type: record.type, ...images });
    });
    return [...result.values()].filter((candidate) => candidate.name).sort((first, second) => second.name.length - first.name.length);
  }

  function textPieces(element) {
    const pieces = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const piece = walker.currentNode.nodeValue.trim();
      if (piece) pieces.push(piece);
    }
    return pieces;
  }

  // 卡上同時印名字和種類：沒改名的角色（名字＝種類）只比對文字的話，整種卡都會被認成它。
  // 遊戲的角色卡把名字放在粗體（font-semibold）那格，有就只看那格；同名的再用「Lv N」分
  function heroOfImage(img, list) {
    const type = img.getAttribute('alt') || '';
    const fits = (candidate) => !type || !candidate.type || candidate.type === type;
    let box = img.parentElement;
    for (let level = 0; box && level < HERO_AVATAR_CLIMB; level++, box = box.parentElement) {
      if (box.querySelectorAll(HERO_AVATAR_IMAGES).length > 1) return null;
      const pieces = textPieces(box);
      if (!pieces.length) continue;
      const levelText = /Lv\.?\s*(\d+)/.exec(pieces.join(' '));
      const pickByLevel = (matches) => (levelText && matches.find((candidate) => Number(candidate.lv) === Number(levelText[1]))) || matches[0] || null;
      const nameCell = box.querySelector('.font-semibold');
      if (nameCell) {
        const name = nameCell.textContent.trim();
        return pickByLevel(list.filter((candidate) => fits(candidate) && candidate.name === name));
      }
      // 沒有名字格的頁面（例如角色詳細頁）：名字等於種類的，要出現兩次（名字＋種類）才算
      const count = (name) => pieces.filter((piece) => piece === name).length;
      const exact = list.filter((candidate) => fits(candidate) && count(candidate.name) >= (candidate.name === type ? 2 : 1));
      if (exact.length) return pickByLevel(exact.filter((candidate) => candidate.name === exact[0].name));
      const text = pieces.join(' ');
      const loose = list.filter((candidate) => fits(candidate) && candidate.name !== type && text.includes(candidate.name));
      if (loose.length) return pickByLevel(loose.filter((candidate) => candidate.name === loose[0].name));
    }
    return null;
  }

  // 共用圖先看 alt 的種類名稱，沒有 alt 才用網址裡的編號
  function typeImageOf(img, original) {
    const type = img.getAttribute('alt') || '';
    if (type && store.values.types[type]) return store.values.types[type].image;
    const match = HERO_AVATAR_PATTERN.exec(original);
    const record = match && Object.values(store.values.types).find((candidate) => String(candidate.typeId) === match[1]);
    return record ? record.image : '';
  }

  function imageCss(image, dimPercent) {
    if (!image) return '';
    const dim = Math.min(90, Math.max(0, Number(dimPercent) || 0)) / 100;
    const url = `url("${String(image).replace(/["\\\n]/g, encodeURIComponent)}")`;
    return dim ? `linear-gradient(rgba(0,0,0,${dim}),rgba(0,0,0,${dim})), ${url}` : url;
  }

  function backgroundCss(part) {
    const record = store.values.backgrounds[part];
    return record ? imageCss(record.image, record.dim) : '';
  }

  // 單獨設的角色卡背景用統一那行的遮暗（沒設統一的就用預設）
  function heroCardCss(hero) {
    if (!hero || !hero.cardImage) return backgroundCss('card');
    const record = store.values.backgrounds.card;
    return imageCss(hero.cardImage, record ? record.dim : (BACKGROUND_PARTS.find(([id]) => id === 'card') || [])[2]);
  }

  function setInlineBackground(element, marker, css) {
    if (css) {
      if (element.dataset[marker] === css) return;
      element.dataset[marker] = css;
      element.style.backgroundImage = css;
      element.style.backgroundSize = 'cover';
      element.style.backgroundPosition = 'center';
    } else if (element.dataset[marker]) {
      delete element.dataset[marker];
      ['backgroundImage', 'backgroundSize', 'backgroundPosition'].forEach((property) => (element.style[property] = ''));
    }
  }

  // 遊戲重畫時會把 src 改回原圖網址（換角色、重排），所以每次都以目前 src 為準
  function swapImage(img, list) {
    if (img.closest('[data-hero-skin-ui]')) return;
    const src = img.getAttribute('src') || '';
    const original = HERO_AVATAR_PATTERN.test(src) ? src : img.dataset.originalAvatar;
    if (!original || !HERO_AVATAR_PATTERN.test(original)) return;
    const hero = Object.keys(store.values.heroes).length ? heroOfImage(img, list) : null;
    const custom = (hero && hero.image) || typeImageOf(img, original);
    if (custom) {
      img.dataset.originalAvatar = original;
      if (src !== custom) img.setAttribute('src', custom);
    } else if (img.dataset.originalAvatar) {
      delete img.dataset.originalAvatar;
      if (src !== original) img.setAttribute('src', original);
    }
    // 角色卡＝頭像的上一層（圖＋名字＋血條那塊）；頭像底圖墊在 img 自己的 background，只有透明處看得到
    if (img.parentElement) setInlineBackground(img.parentElement, 'heroSkinCard', heroCardCss(hero));
    setInlineBackground(img, 'heroSkinAvatar', backgroundCss('avatar'));
  }

  // 遊戲的底色在 body（漸層）；換成圖片，捲動時固定不動
  function applyPageBackground() {
    const css = backgroundCss('page');
    let style = document.getElementById(PAGE_BACKGROUND_STYLE_ID);
    if (!css) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = PAGE_BACKGROUND_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `body{background-image:${css} !important;background-size:cover !important;background-position:center !important;background-attachment:fixed !important;}`;
  }

  function anythingSet() {
    const { heroes, types, backgrounds } = store.values;
    return Object.keys(heroes).length > 0 || Object.keys(types).length > 0 || Boolean((backgrounds.card && backgrounds.card.image) || (backgrounds.avatar && backgrounds.avatar.image));
  }

  function applyImages() {
    if (!anythingSet() && !document.querySelector('img[data-original-avatar], [data-hero-skin-card], img[data-hero-skin-avatar]')) return;
    const list = candidates();
    document.querySelectorAll(HERO_AVATAR_IMAGES).forEach((img) => swapImage(img, list));
  }

  function applyAll() {
    applyPageBackground();
    applyImages();
  }

  // ---- 設定 ----

  // 頭像（image）和卡片背景（cardImage）存在同一筆，兩個都沒有才刪
  function setHeroImage(heroId, changes) {
    const hero = heroList.find((candidate) => String(candidate.id) === String(heroId));
    const old = store.values.heroes[heroId] || {};
    const record = { ...old, name: hero ? hero.name : old.name, type: hero ? hero.type : old.type, typeId: hero ? hero.typeId : old.typeId, ...changes };
    if (record.image || record.cardImage) store.values.heroes[heroId] = record;
    else delete store.values.heroes[heroId];
    save('heroes');
  }

  function setTypeImage(type, image) {
    const hero = heroList.find((candidate) => candidate.type === type);
    if (image) store.values.types[type] = { typeId: hero ? hero.typeId : (store.values.types[type] || {}).typeId, image };
    else delete store.values.types[type];
    save('types');
  }

  function setBackground(part, changes) {
    const defaultDim = (BACKGROUND_PARTS.find(([id]) => id === part) || [])[2] || 0;
    const record = { dim: defaultDim, ...(store.values.backgrounds[part] || {}), ...changes };
    if (record.image) store.values.backgrounds[part] = record;
    else delete store.values.backgrounds[part];
    save('backgrounds');
  }

  function setByScope(scope, key, image) {
    if (scope === 'type') setTypeImage(key, image);
    else if (scope === 'background') setBackground(key, { image });
    else if (scope === 'heroCard') setHeroImage(key, { cardImage: image });
    else setHeroImage(key, { image });
    applyAll();
    render();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('讀檔失敗'));
      reader.readAsDataURL(file);
    });
  }

  // 頭像：置中裁成正方形再縮小；背景：不裁，等比例縮小
  async function prepareImage(file, { square, maxSide }) {
    if (ANIMATED_IMAGE_TYPES.includes(file.type)) {
      if (file.size > ANIMATED_IMAGE_MAX_BYTES) throw new Error(`動圖 ${(file.size / 1048576).toFixed(1)} MB 太大，請小於 4 MB`);
      return readFileAsDataUrl(file);
    }
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    if (square) {
      const side = Math.min(bitmap.width, bitmap.height);
      canvas.width = canvas.height = Math.min(maxSide, side);
      canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    } else {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    }
    bitmap.close();
    return canvas.toDataURL('image/webp', 0.85);
  }

  // ---- 介面 ----

  const ui = document.createElement('div');
  ui.setAttribute('data-hero-skin-ui', '');
  ui.innerHTML = `
    <style>
      [data-hero-skin-ui] { position:fixed; left:12px; bottom:12px; z-index:2147483646; font:13px/1.5 "Noto Sans TC",sans-serif; color:#e7e5e4; }
      [data-hero-skin-ui] .toggle { width:40px; height:40px; border-radius:50%; border:1px solid #57534e; background:#292524; font-size:20px; cursor:pointer; }
      [data-hero-skin-ui] .panel { display:none; position:absolute; left:0; bottom:48px; width:min(380px, calc(100vw - 24px)); max-height:70vh; overflow:auto; background:#1c1917; border:1px solid #57534e; border-radius:10px; padding:10px; box-shadow:0 8px 24px rgba(0,0,0,.5); }
      [data-hero-skin-ui].open .panel { display:block; }
      [data-hero-skin-ui] h3 { margin:8px 0 4px; font-size:14px; }
      [data-hero-skin-ui] .hint { color:#a8a29e; font-size:12px; }
      [data-hero-skin-ui] .row { display:flex; align-items:center; gap:4px; margin-top:4px; }
      [data-hero-skin-ui] .row.sub { padding-left:22px; }
      [data-hero-skin-ui] .grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      [data-hero-skin-ui] button { flex:none; background:#44403c; color:#e7e5e4; border:1px solid #57534e; border-radius:4px; padding:1px 6px; cursor:pointer; font:inherit; }
      [data-hero-skin-ui] input[type=number] { width:48px; background:#292524; color:#e7e5e4; border:1px solid #57534e; border-radius:4px; }
      [data-hero-skin-ui] .thumb { flex:none; object-fit:cover; border-radius:4px; }
      [data-hero-skin-ui] .none { flex:none; color:#78716c; font-size:11px; text-align:center; }
    </style>
    <button class="toggle" title="角色換圖">🎨</button>
    <div class="panel">
      <b>角色換圖</b>
      <div class="hint">只有這台電腦的瀏覽器看得到。動圖（GIF／WebP）上傳要小於 4 MB，用網址不限</div>
      <h3>背景</h3>
      <div class="hint">遮暗是在圖上蓋一層黑，數字越大字越清楚。角色卡背景會套到畫面上所有角色卡</div>
      <div data-list="backgrounds"></div>
      <h3>角色頭像</h3>
      <div class="hint">粗體那行是整種卡共用（別人的同種卡也會換），底下每隻可以另外設頭像和卡片背景，單獨的優先（卡片背景沒單獨設就用上面統一的角色卡背景）。名字、等級都一樣的分不出來</div>
      <div data-list="heroes"></div>
      <input type="file" accept="image/*" style="display:none">
    </div>`;
  const picker = ui.querySelector('input[type=file]');

  function thumb(src, size) {
    return `<img class="thumb" src="${escapeHtml(src)}" width="${size}" height="${size}" style="width:${size}px;height:${size}px">`;
  }

  function buttons(scope, key, hasImage) {
    const data = `data-scope="${scope}" data-key="${escapeHtml(key)}"`;
    return `<button data-do="pick" ${data}>選圖</button><button data-do="url" ${data}>網址</button>${hasImage ? `<button data-do="reset" ${data}>還原</button>` : ''}`;
  }

  function renderBackgrounds() {
    ui.querySelector('[data-list="backgrounds"]').innerHTML = BACKGROUND_PARTS.map(([part, label, defaultDim]) => {
      const record = store.values.backgrounds[part];
      const image = record && record.image;
      return `<div class="row">
        ${image ? thumb(image, 40) : '<span class="none" style="width:40px">沒設</span>'}
        <span class="grow">${label}</span>
        ${part === 'avatar' ? '' : `<label style="flex:none">遮暗<input data-dim="${part}" type="number" min="0" max="90" step="5" value="${record ? Number(record.dim) || 0 : defaultDim}">%</label>`}
        ${buttons('background', part, image)}
      </div>`;
    }).join('');
  }

  // 依種類分組：種類那行設共用圖，底下每隻角色可以另外設
  function renderHeroes() {
    const list = ui.querySelector('[data-list="heroes"]');
    const groups = new Map();
    const groupOf = (type, typeId) => {
      if (!groups.has(type)) groups.set(type, { typeId, heroes: [] });
      const group = groups.get(type);
      if (group.typeId === undefined) group.typeId = typeId;
      return group;
    };
    heroList.forEach((hero) => groupOf(hero.type || '', hero.typeId).heroes.push({ heroId: String(hero.id), name: hero.name }));
    // 換過圖但現在沒有的（賣掉了）也列出來，才還原得了
    Object.entries(store.values.heroes).forEach(([heroId, record]) => {
      const group = groupOf(record.type || '', record.typeId);
      if (!group.heroes.some((hero) => hero.heroId === heroId)) group.heroes.push({ heroId, name: record.name || `#${heroId}` });
    });
    Object.entries(store.values.types).forEach(([type, record]) => groupOf(type, record.typeId));
    if (!groups.size) {
      list.innerHTML = '<div class="hint">讀取角色中…</div>';
      return;
    }
    list.innerHTML = [...groups.entries()]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([type, group]) => {
        const shared = store.values.types[type] && store.values.types[type].image;
        const cardBackgroundSet = Boolean(store.values.backgrounds.card && store.values.backgrounds.card.image);
        const heroRows = group.heroes
          .sort((first, second) => first.name.localeCompare(second.name))
          .map((hero) => {
            const record = store.values.heroes[hero.heroId] || {};
            const placeholder = (text) => `<span class="none" style="width:28px">${text}</span>`;
            return `<div class="row sub">
              ${record.image ? thumb(record.image, 28) : placeholder(shared ? '共用' : '原圖')}
              <span class="grow">${escapeHtml(hero.name)}</span>
              ${buttons('hero', hero.heroId, record.image)}
            </div>
            <div class="row sub" style="padding-left:50px">
              ${record.cardImage ? thumb(record.cardImage, 28) : placeholder(cardBackgroundSet ? '統一' : '沒設')}
              <span class="grow" style="color:#a8a29e">卡片背景</span>
              ${buttons('heroCard', hero.heroId, record.cardImage)}
            </div>`;
          })
          .join('');
        return `<div class="row" style="margin-top:8px">
          ${group.typeId !== undefined ? thumb(`/hero-avatars/${group.typeId}.png`, 40) : ''}${shared ? `→${thumb(shared, 40)}` : ''}
          <b class="grow">${escapeHtml(type || '（不明種類）')}<span style="color:#a8a29e;font-weight:normal"> 共用</span></b>
          ${buttons('type', type, shared)}
        </div>${heroRows}`;
      })
      .join('');
  }

  function render() {
    if (!view.open) return;
    renderBackgrounds();
    renderHeroes();
  }

  ui.querySelector('.toggle').addEventListener('click', () => {
    view.open = !view.open;
    ui.classList.toggle('open', view.open);
    render();
    if (view.open)
      refreshHeroList()
        .then(render)
        .catch((error) => toast(`讀角色清單失敗（${error.message}）`));
  });

  ui.querySelector('.panel').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-do]');
    if (!button) return;
    const { scope, key } = button.dataset;
    if (button.dataset.do === 'pick') {
      view.pickingScope = scope;
      view.pickingKey = key;
      picker.value = '';
      picker.click();
    } else if (button.dataset.do === 'url') {
      const url = (prompt('圖片網址（https://…）', '') || '').trim();
      if (!url) return;
      if (!/^https?:\/\//.test(url)) {
        toast('網址要是 http:// 或 https:// 開頭');
        return;
      }
      setByScope(scope, key, url);
    } else if (button.dataset.do === 'reset') {
      setByScope(scope, key, '');
    }
  });

  ui.querySelector('.panel').addEventListener('change', (event) => {
    const part = event.target.dataset && event.target.dataset.dim;
    if (!part) return;
    setBackground(part, { dim: Number(event.target.value) || 0 });
    applyAll();
    render();
  });

  picker.addEventListener('change', async () => {
    const chosen = picker.files && picker.files[0];
    if (!view.pickingScope || !chosen) return;
    const options =
      view.pickingScope === 'background'
        ? { square: false, maxSide: BACKGROUND_MAX_SIDE[view.pickingKey] || 1920 }
        : view.pickingScope === 'heroCard'
          ? { square: false, maxSide: BACKGROUND_MAX_SIDE.card }
          : { square: true, maxSide: HERO_AVATAR_SIZE };
    try {
      setByScope(view.pickingScope, view.pickingKey, await prepareImage(chosen, options));
    } catch (error) {
      toast(`圖片讀不了（${error.message}）`);
    }
  });

  // ---- 啟動 ----

  async function start() {
    document.body.appendChild(ui);
    await loadStore();
    // 單獨設定靠名字認，要有全部角色的名字才不會認錯
    if (Object.keys(store.values.heroes).length) await refreshHeroList().catch(() => {});
    applyAll();
    // 新出現的卡馬上換
    new MutationObserver((mutations) => {
      if (!anythingSet()) return;
      const touched = mutations.some(
        (mutation) =>
          (mutation.type === 'attributes' && mutation.target.tagName === 'IMG' && !ui.contains(mutation.target)) ||
          [...mutation.addedNodes].some((node) => node.nodeType === 1 && !ui.contains(node) && (node.tagName === 'IMG' || node.querySelector('img')))
      );
      if (touched) applyImages();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    // 同一張圖被拿去顯示別隻角色時 src 不會變、監看抓不到，每秒重掃
    setInterval(applyImages, 1000);
    // 新抽到、改名的角色
    setInterval(() => {
      if (Object.keys(store.values.heroes).length || view.open) refreshHeroList().then(render).catch(() => {});
    }, HEROES_FRESH_MILLISECONDS);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
