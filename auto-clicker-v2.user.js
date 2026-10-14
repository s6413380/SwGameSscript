// ==UserScript==
// @name         愛吉吉
// @namespace    local.auto-clicker
// @version      3.46
// @description  原地掛機 N 次後全隊休息，可自動移動到目標關卡（含子區域與地形切換）；可鍛造；體力與血條低時自動用道具補給；統計戰鬥傷害、治療、控制、擊殺
// @match        https://myteam.swordgale.online/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/s6413380/SwGameSscript/main/auto-clicker-v2.user.js
// @downloadURL  https://raw.githubusercontent.com/s6413380/SwGameSscript/main/auto-clicker-v2.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__autoClickerLoaded) return;
  window.__autoClickerLoaded = true;

  // 載入器用 <script> 插入時，執行當下的 currentScript 就是整份程式碼，表頭的 @version 讀得到；
  // 直接用 Tampermonkey 安裝時改看 GM_info（@grant none 也有）
  const SCRIPT_VERSION = (() => {
    const match = document.currentScript && /@version\s+(\S+)/.exec(document.currentScript.textContent);
    if (match) return match[1];
    return typeof GM_info !== 'undefined' ? GM_info.script.version : '?';
  })();

  const STORAGE_KEY = 'autoClickerSettingsV2';
  const V1_STORAGE_KEY = 'autoClickerSettings';

  // 體力與血條共用同一套補給邏輯：每條數值對應一格道具欄與一個使用按鈕，綁在同一列設定。
  // 陣列順序就是檢查優先順序，血條排前面，先保命再補體力
  // healField：/api/items 裡這條數值對應的回復量欄位；heroField／fullField：/api/huntInfo 裡的目前值與最大值。
  // 有這些欄位的群組才能改用 API 判斷與吃藥
  const SUPPLY_GROUPS = [
    { id: 'health', name: '血條', healField: 'healHp', heroField: 'hp', fullField: 'fullHp' },
    { id: 'resource', name: '體力', healField: 'healSp', heroField: 'sp', fullField: 'fullSp' },
    // 鍛造模式專用的體力與道具，放在「鍛造」頁，只在鍛造模式檢查
    { id: 'forge', name: '鍛造體力', forgeOnly: true, healField: 'healSp', heroField: 'sp', fullField: 'fullSp' },
  ];
  // 面板分頁，避免所有設定擠在同一頁
  const TABS = [
    ['main', '主流程'],
    ['health', '補血'],
    ['resource', '補體力'],
    ['move', '移動'],
    ['equip', '換裝'],
    ['train', '練等'],
    ['pause', '暫停'],
    ['forge', '自動鍛造'],
    ['recipe', '配方'],
    ['mining', '挖礦'],
    ['material', '材料統計'],
    ['combat', '戰鬥'],
    ['huntStats', '樓層'],
    ['income', '收益'],
    ['growth', '成長'],
    ['draw', '抽卡'],
    ['pick', '勾選'],
    ['alert', '提醒'],
    ['cloud', '雲端'],
    ['log', '紀錄'],
    ['api', 'API'],
    ['backup', '備份'],
    ['transfer', '轉移'],
    ['cardBuy', '購卡'],
  ];
  // 分頁太多，先選大類再選分頁；大類裡記住上次看的分頁
  const TAB_GROUPS = [
    ['hunt', '打怪', ['main', 'health', 'resource', 'move', 'equip', 'train', 'pause']],
    ['forging', '鍛造', ['forge', 'recipe', 'material', 'mining']],
    ['stats', '統計', ['income', 'combat', 'huntStats', 'growth', 'draw']],
    ['other', '其他', ['pick', 'transfer', 'cardBuy', 'alert', 'cloud', 'log', 'api', 'backup']],
  ];
  const TAB_STORAGE_KEY = 'autoClickerV2Tab';
  const GROUP_TABS_STORAGE_KEY = 'autoClickerV2GroupTabs';

  function tabGroupOf(tabId) {
    return (TAB_GROUPS.find(([, , tabIds]) => tabIds.includes(tabId)) || TAB_GROUPS[0])[0];
  }
  const SLOT_COUNT = 4;
  const LOG_LIMIT = 50;
  // 每個角色的道具介面各有自己的 X，所以 X 也是每條各設
  const SLOT_PARTS = { Bar: '數值', Slot: '道具欄', Use: '使用', Close: 'X' };

  function slotKey(groupId, part, index) {
    return `${groupId}${part}${index + 1}`;
  }

  function groupKey(groupId, name) {
    return `${groupId}${name}`;
  }

  // 狩獵的角色直接用 /api/huntInfo 的隊伍，不用設定；鍛造的角色不在隊伍裡，要自己勾
  function forgeHeroKey(index) {
    return `forgeHero${index + 1}`;
  }

  // 換裝：每位角色各自一組設定，可以登記多件備用裝備依序嘗試
  const CHARACTER_COUNT = 4;
  const SPARE_COUNT = 4;

  function equipKey(characterIndex, name) {
    return `equip${characterIndex + 1}${name}`;
  }

  // 地圖區域表：沒有「從哪裡進」的是地形（用切換按鈕進入），有的是子區域（在母區域某一關按進入按鈕，用返回按鈕離開）。
  // 名稱要和關卡欄位上顯示的文字一樣，之後有新區域可以自己加在空白列
  const AREA_COUNT = 12;
  const DEFAULT_AREAS = [
    { name: '大草原' },
    { name: '黑暗山洞' },
    { name: '猛牛原', parent: '大草原', parentStage: 11 },
    { name: '草原秘徑', parent: '大草原', parentStage: 16 },
    { name: '老鼠洞', parent: '黑暗山洞', parentStage: 12 },
    { name: '迷霧森林', parent: '草原秘徑', parentStage: 27 },
  ];
  // 區域表預設內容改過就加一：已經存過設定的人也補上新的預設區域（只補一次，刪掉了不會再冒出來）
  const AREA_PRESET_VERSION = 4;
  const LOOT_RARE_PAUSE_OFF_KEY = 'autoClickerV2LootRarePauseOff';
  const PLAYER_IGNORE_DEFAULT = '大草原1-3、黑暗山洞1-3';
  const PLAYER_IGNORE_DEFAULT_KEY = 'autoClickerV2PlayerIgnoreDefault';
  const AREA_PRESET_KEY = 'autoClickerV2AreaPreset';

  function areaKey(areaIndex, name) {
    return `area${areaIndex + 1}${name}`;
  }

  // 鍛造坊數量各帳號不同，預留幾格，沒用到的留空即可
  const FORGE_SHOP_COUNT = 6;

  function forgeKey(shopIndex, name) {
    return `forge${shopIndex + 1}${name}`;
  }

  const defaultSettings = {
    selectorC: '',
    selectorA: '',
    selectorB: '',
    stageEnabled: false,
    stageSelector: '',
    stageTargetArea: '大草原',
    stageTargetNumber: 1,
    townName: '初始之鎮',
    stageTown: '',
    stageTownText: '',
    selectorD: '',
    selectorDText: '',
    stageBack: '',
    stageBackText: '',
    stageFinishMove: '',
    // 移動時間到了之後，隨機再等幾秒才按完成移動，不要每次都剛好準點
    finishMoveMinSeconds: 1,
    finishMoveMaxSeconds: 5,
    // API 打怪冷卻結束後隨機再等幾秒才打，像人看到冷卻結束才按
    huntReactMinSeconds: 1,
    huntReactMaxSeconds: 3,
    stageFinishMoveText: '',
    intervalMinSeconds: 8,
    intervalMaxSeconds: 20,
    repeatCount: 5,
    loop: false,
    loopDelaySeconds: 30,
    healthPausePercent: 20,
    // 避難：血量低於緊急暫停的 % 時先換到這個關卡掛機，到了還是低才暫停
    healthEscapeEnabled: false,
    healthEscapeArea: '',
    healthEscapeNumber: 1,
    // 避難：同地圖有紅名或黑名單玩家就離開；back＝往回退一關，escape＝先去避難關卡
    playerEscapeEnabled: false,
    playerEscapeMode: 'back',
    playerEscapeRed: true,
    playerBlacklist: '',
    playerEscapeArea: '',
    playerEscapeNumber: 1,
    // 躲開危險玩家後，幾分鐘沒再遇到就走回原本掛機的關卡
    playerReturnEnabled: false,
    playerReturnMinutes: 10,
    // 這些關卡的危險玩家不理（前幾層常有小號紅名），例如「1-2」「大草原1-2」「老鼠洞」
    playerIgnoreStages: PLAYER_IGNORE_DEFAULT,
    resourcePausePercent: 20,
    deathPauseEnabled: true,
    // 異常狀態（中毒、燒傷…）：0＝不處理、1＝輕度以上、2＝中度以上、3＝重度
    statusAlertLevel: 2,
    // 執行中不在狩獵頁／鍛造頁就自動切過去
    autoNavigateEnabled: true,
    // 打怪改直接打 API：不用停在狩獵頁，同一個分頁可以同時 API 鍛造
    huntByApiEnabled: false,
    // 低調模式：每步多等一點、偶爾分心、玩一陣子就休息，節奏像人
    lowProfileEnabled: false,
    lowProfilePlayMinMinutes: 40,
    lowProfilePlayMaxMinutes: 90,
    lowProfileBreakMinMinutes: 5,
    lowProfileBreakMaxMinutes: 20,
    lowProfileSleepHours: '2-9',
    // 完全休息的時段（上班、出門…）：跟睡覺一樣完全不動
    lowProfileOffHours: '',
    // 玩法：serious＝認真玩（一段一段長時間玩）；casual＝休閒（每小時玩一點，離開時偶爾回來點幾下）
    lowProfileStyle: 'serious',
    // 自動玩法：這些時段認真玩，其他時間休閒
    lowProfileSeriousHours: '20-24',
    lowProfileCasualMinutes: 20,
    lowProfileCheckinMinMinutes: 8,
    lowProfileCheckinMaxMinutes: 20,
    lowProfileCheckinMinHunts: 2,
    lowProfileCheckinMaxHunts: 5,
    lowProfileForgeCheckin: true,
    // 多開輪流：同一台電腦的幾個帳號透過中繼站排隊，一次只有一個分頁打遊戲 API
    turnTakingEnabled: false,
    // 主帳號照常打；其他帳號（小號）打怪頻率只有主帳號的幾 %
    mainAccountName: '',
    sideHuntPercent: 50,
    // 三個帳號同步＝當成同一個人：共用設定經中繼站同步，低調模式的玩／休息／睡覺時間表也一樣
    syncAccountsEnabled: true,
    // 全體暫時暫停幾分鐘後自動開始
    globalPauseMinutes: 10,
    statusPauseLevel: 3,
    expPauseEnabled: false,
    expSelectors: '',
    expPausePercent: 90,
    verifyEnabled: true,
    verifyKeyword: '活人驗證',
    verifyAutoResume: true,
    alertRedEnabled: true,
    alertSoundEnabled: true,
    alertVolume: 50,
    alertPopupEnabled: true,
    alertNotifyEnabled: true,
    // 開好幾個帳號時分得出是哪個；截圖分享時可以關掉
    showAccountName: true,
    itemStepSeconds: 1,
    combatEnabled: true,
    combatKeyword: '戰鬥過程',
    combatSelector: '',
    huntExcludedHeroIds: '',
    equipApiEnabled: false,
    equipApiMinDurability: 10,
    equipApiSameName: false,
    equipApiPauseWhenEmpty: true,
    // 要自動換裝的角色（heroId，逗號分隔）；沒勾就誰都不換
    equipApiHeroIds: '',
    // 可以換上的裝備名稱（逗號分隔）；留空＝閒置裝備都能用
    equipApiAllowedNames: '',
    // 練等：回城換上要練的英雄，到練等關卡練到指定等級，再回城換回原本的隊伍、回原本的關卡
    trainEnabled: false,
    trainHeroIds: '',
    // 原本隊伍裡練等時繼續留下的英雄（heroId，逗號分隔）
    trainKeepIds: '',
    // {heroId: [equipmentId…]}：要練的英雄穿哪些裝備
    trainEquip: '{}',
    trainTargetArea: '',
    trainTargetNumber: 1,
    trainLevel: 10,
    growthEnabled: true,
    growthSyncEnabled: true,
    // 物品頁一鍵勾選：要勾的品質、類型、名稱（逗號分隔，由掃描出來的清單勾選）、勾或取消、每勾一個的間隔
    qualityPickNames: '',
    qualityPickTypes: '',
    qualityPickItemNames: '',
    qualityPickMode: 'check',
    // 換過名字：舊版存的「關閉」不會蓋掉現在的預設開啟
    cloudSyncEnabled: true,
    huntStatsEnabled: true,
    incomeEnabled: true,
    // 「材料」頁直接鍛造：配方（名稱×數量、…）、裝備名稱（名稱每天影響數值，自己取）、第幾個鍛造坊
    forgeRecipe: '',
    // 統計時扣掉名稱影響（只算對得到社群測名表的裝備）
    materialNameAdjust: true,
    // 遊戲的裝備詳細資料加上鍛造材料、時間、基本值
    forgeDetailEnabled: true,
    // API 鍛造前把配方填進遊戲的鍛造表單（人在鍛造頁時才有作用）
    forgeFillGameForm: true,
    recipeNameAdjust: true,
    forgeRecipeType: '單手劍',
    // API 鍛造：勾選的角色輪流用配方開爐；開幾爐（0＝不限）。名稱不能叫 forgeApi…，那是鍛造體力補給的欄位
    forgeByApiEnabled: false,
    forgeByApiHeroIds: '',
    // 每個角色自己的 { type, recipe, name }（JSON）；鍛造師數值不同，最好的配方也不同
    forgeByApiPlans: '{}',
    forgeByApiCount: 0,
    // 挖礦：{ heroId: 地點 1～4 }（JSON）；每幾小時收一次（每次前後飄幾 %）；出發前喝勾選的體力藥水（都不勾＝任何體力道具）
    miningPlans: '{}',
    // 收礦順序（heroId 陣列，JSON）；有的角色要最後收
    miningOrder: '[]',
    miningConditionRest: true,
    miningIntervalHours: 6,
    miningIntervalJitterPercent: 15,
    miningPotionEnabled: true,
    miningPotionNames: '',
    // 出發前也把 HP 補滿（勾選的補血道具，都不勾＝任何補血道具）
    miningHpPotionEnabled: true,
    miningHpPotionNames: '',
    // 這個帳號有幾個鍛造欄位；0＝從遊戲讀（基本 2 格＋擴建次數）
    forgeShopSlots: 0,
    // 名稱效果每天 00:00 換：過了 00:00 先不開新爐，每隔幾分鐘抓測名表，有六圍平均 ≥ 這個 % 的名稱就換上繼續
    forgeAutoNameEnabled: false,
    forgeAutoNameMinutes: 10,
    forgeAutoNamePercent: 80,
    // 每種裝備看重的屬性順序：自動換名稱時各類型挑自己最好的名稱（沒列到的類型用六圍平均）
    forgeNamePriorities: [
      '單手劍、細劍、短刀、單手錘、雙手劍、太刀、雙手斧、長槍：攻>重>耐',
      '盾牌、頭盔、盔甲：防>重>攻',
      '帽子、大衣：防>智>重',
      '項鍊：幸>智>防',
    ].join('\n'),
    forgeRecipeName: '',
    forgeRecipeTarget: 1,
    // 配方頁直接連續鍛造幾爐（0＝鍛到材料不夠為止）
    forgeRecipeRepeat: 0,
    // 掉落名稱包含這些字就提醒（逗號分隔）
    lootRareNames: '英雄券',
    lootRarePause: false,
    // 留空＝用內建的共用試算表
    cloudUrl: '',
    cloudName: '',
    qualityPickMinMilliseconds: 300,
    qualityPickMaxMilliseconds: 800,
    dashboardEnabled: false,
    dashboardUrl: 'http://localhost:8787',
    // 轉金幣時請對方掛單用的材料（掛 1 個，價格＝要轉的金額）
    transferMine: '泥土',
    // 多開輪流時，轉移期間中繼站只讓轉移的請求通過：human＝兩個帳號之間切換仍隔一下，fast＝不隔
    transferTurnMode: 'human',
    // 對方不在中繼站上時，透過雲端試算表接收「請掛單」的要求（每 30 秒看一次）
    transferCloudEnabled: false,
    // 雲端轉角色要這個帳號付錢，預設每次都要按同意；這裡列的帳號 ID（自己的其他帳號）免問
    transferTrustedIds: '',
    // 查拍賣場英雄：照卡片種類（不是玩家取的名字）、價格、等級、潛能評價提醒或買玩家掛賣的英雄。
    // cardBuyEnabled 是總開關（查不查），會不會花錢另外由 cardAutoBuyEnabled 決定
    cardBuyEnabled: false,
    cardAutoBuyEnabled: false,
    cardNotifyOverPrice: true,
    cardReleasedEnabled: true,
    // toast＝右下角小提示＋系統通知，不打斷；popup＝照「提醒」頁設定（彈窗、聲音、紅框）
    cardAlertStyle: 'toast',
    cardBuyRules: '',
    // 0＝不買：花的是真錢，一定要自己設上限
    cardBuyBudget: 0,
    cardBuyMaxCount: 1,
    // passive＝只看遊戲自己抓的清單（不多發請求）；active＝自己去查（搶卡用）
    cardWatchMode: 'passive',
    cardBuyIntervalSeconds: 25,
    cardBuyIntervalMaxSeconds: 90,
    // 主動查的時段（「8-24」「20-2」）；留空＝整天
    cardActiveHours: '',
    // 主動查開幾分鐘後自動切回被動；0＝不切
    cardActiveMinutes: 60,
    cardBuyExcludeSellerIds: '',
    autoUpdateEnabled: true,
  };
  SUPPLY_GROUPS.forEach(({ id }) => {
    defaultSettings[groupKey(id, 'ThresholdPercent')] = 50;
    defaultSettings[groupKey(id, 'TargetPercent')] = 80;
    defaultSettings[groupKey(id, 'CloseSelector')] = '';
    defaultSettings[groupKey(id, 'MaxUses')] = 20;
    defaultSettings[groupKey(id, 'ItemNames')] = '';
    defaultSettings[groupKey(id, 'ApiEnabled')] = false;
    for (let index = 0; index < SLOT_COUNT; index++) {
      Object.keys(SLOT_PARTS).forEach((part) => (defaultSettings[slotKey(id, part, index)] = ''));
      if (id === 'forge') defaultSettings[forgeHeroKey(index)] = '';
      defaultSettings[`${slotKey(id, 'Use', index)}Text`] = '';
      defaultSettings[`${slotKey(id, 'Use', index)}Context`] = '';
      defaultSettings[`${slotKey(id, 'Close', index)}Text`] = '';
    }
  });

  for (let areaIndex = 0; areaIndex < AREA_COUNT; areaIndex++) {
    const preset = DEFAULT_AREAS[areaIndex] || {};
    defaultSettings[areaKey(areaIndex, 'Name')] = preset.name || '';
    defaultSettings[areaKey(areaIndex, 'Parent')] = preset.parent || '';
    defaultSettings[areaKey(areaIndex, 'ParentStage')] = preset.parentStage || 0;
    ['Enter', 'EnterText', 'Return', 'ReturnText'].forEach((name) => (defaultSettings[areaKey(areaIndex, name)] = ''));
  }

  Object.assign(defaultSettings, {
    forgeIntervalMinSeconds: 20,
    forgeIntervalMaxSeconds: 40,
    forgeStart: '',
    forgeStartText: '',
    forgeFinish: '',
    forgeFinishText: '',
  });
  for (let shopIndex = 0; shopIndex < FORGE_SHOP_COUNT; shopIndex++) {
    defaultSettings[forgeKey(shopIndex, 'Switch')] = '';
    defaultSettings[forgeKey(shopIndex, 'SwitchText')] = '';
    defaultSettings[forgeKey(shopIndex, 'Count')] = 0;
  }

  for (let characterIndex = 0; characterIndex < CHARACTER_COUNT; characterIndex++) {
    const key = (name) => equipKey(characterIndex, name);
    defaultSettings[key('Enabled')] = false;
    defaultSettings[key('Threshold')] = 10;
    defaultSettings[key('PauseWhenEmpty')] = true;
    ['Durability', 'Open', 'OpenText', 'Remove', 'RemoveText', 'Close'].forEach((name) => {
      defaultSettings[key(name)] = '';
    });
    for (let spare = 1; spare <= SPARE_COUNT; spare++) {
      ['', 'Text', 'Context'].forEach((suffix) => (defaultSettings[key(`Wear${spare}${suffix}`)] = ''));
    }
  }

  // 第一次用 V2 時沿用 V1 的設定，不用全部重抓
  function migrateFromV1(v1) {
    const migrated = {};
    ['selectorC', 'selectorA', 'selectorB', 'intervalSeconds', 'repeatCount', 'loop', 'loopDelaySeconds', 'itemStepSeconds',
      'expPauseEnabled', 'expSelectors', 'expPausePercent', 'stageEnabled', 'stageSelector', 'stageTarget', 'selectorD']
      .forEach((key) => {
        if (key in v1) migrated[key] = v1[key];
      });
    const renamed = {
      resourceThresholdPercent: 'resourceThresholdPercent',
      itemTargetPercent: 'resourceTargetPercent',
      selectorItemClose: 'resourceCloseSelector',
      itemMaxUses: 'resourceMaxUses',
      healthThresholdPercent: 'healthPausePercent',
    };
    Object.entries(renamed).forEach(([v1Key, v2Key]) => {
      if (v1Key in v1) migrated[v2Key] = v1[v1Key];
    });
    for (let index = 0; index < SLOT_COUNT; index++) {
      const v1Parts = { Bar: 'resourceSelector', Slot: 'slotSelector', Use: 'useSelector' };
      Object.entries(v1Parts).forEach(([part, v1Prefix]) => {
        const value = v1[`${v1Prefix}${index + 1}`];
        if (value) migrated[slotKey('resource', part, index)] = value;
      });
    }
    // V1 的血條是一串逗號清單，只用來暫停
    splitSelectors(v1.healthSelectors || '').slice(0, SLOT_COUNT).forEach((selector, index) => {
      migrated[slotKey('health', 'Bar', index)] = selector;
    });
    return migrated;
  }

  // 抓「709 / 744」這種格式，允許千分位逗號
  const RATIO_PATTERN = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/;
  const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*%/;

  const state = {
    running: false,
    // 避難用：同地圖玩家、上次讀的時間、正在因血量低走去避難關卡、已提醒過的危險玩家
    zoneUsers: [],
    zoneUsersAt: 0,
    healthEscaping: false,
    playerAlertKey: '',
    playerEscapeTarget: '',
    timerId: null,
    clickedC: false,
    clickCountA: 0,
    cycleCount: 0,
    // 使用後有回升但沒到目標的列（"群組:索引"），下一次原地掛機／移動前不再嘗試，避免一直重開道具欄
    itemUsedSlots: new Set(),
    // 換裝失敗（且沒勾暫停）的角色，本輪不再嘗試
    equipSkipped: new Set(),
    // API 換裝找不到替換品的裝備 id，本輪不再試
    equipApiSkipped: new Set(),
    // /api/equipments 的結果與讀取時間；耐久掉得慢，不用每一步都重抓
    equipments: [],
    equipmentsAt: 0,
    // 鍛造進度：每個鍛造坊這次按開始後開工了幾次、是否還有成品沒收，以及巡到哪一個
    forgeStarted: [],
    forgeApiStarted: 0,
    forgePending: [],
    forgeCursor: -1,
    // 鍛造模式看按的是哪顆開始決定，不存進設定：設定是各分頁共用的，開兩個分頁時才不會互相蓋掉
    forgeMode: false,
    // 因驗證框暫停時記下當時跑的是鍛造（true）還是掛機（false），驗證框消失後照原模式繼續；
    // null 表示不是被驗證框停下的，不自動繼續
    verifyResumeMode: null,
    // API 被要求驗證、正在等驗證完成
    captchaWaiting: false,
    captchaCheckedAt: 0,
    // 驗證框從什麼時候開始不見，要穩定消失一陣子才繼續，避免換題時短暫消失就開跑
    verifyGoneSince: 0,
    // 道具用完時設為 true，下一步直接點 B 休息，不再點 A
    needRest: false,
    // stop/start 時遞增，讓還在等待中的道具流程知道自己已過期
    runId: 0,
    // heroId → /api/huntInfo 的角色資料（hp、sp、fullHp、fullSp），API 補給的條用它判斷，不讀畫面
    heroStats: new Map(),
    heroStatsAt: 0,
    // /api/huntInfo 隊伍的順序，第幾條就是第幾位
    huntTeamIds: [],
    pickingTarget: null,
    pickingMode: null,
  };

  // 分頁在背景超過 5 分鐘後，Chrome / Edge 會把主執行緒的計時器壓成每分鐘最多一次，
  // 設定 11～18 秒也會變成固定 1 分鐘。Web Worker 裡的計時器不受這個限制，
  // 所以改由 Worker 計時、時間到再通知主執行緒。網站若禁止建立 Worker，就退回一般計時器
  const backgroundTimer = createBackgroundTimer();

  function createBackgroundTimer() {
    const fallback = {
      mode: '一般計時器（無法建立背景計時器）',
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (id) => window.clearTimeout(id),
    };
    let worker;
    try {
      const source = `
        const timers = {};
        onmessage = (event) => {
          const { id, delay, cancel } = event.data;
          clearTimeout(timers[id]);
          delete timers[id];
          if (!cancel) timers[id] = setTimeout(() => { delete timers[id]; postMessage(id); }, delay);
        };`;
      worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    } catch {
      return fallback;
    }
    // id → { callback, dueAt }；記下預定時間，回來時可以檢查有沒有提早
    const pending = new Map();
    let nextId = 1;
    let failed = false;
    // 不管什麼原因提早回來，都用一般計時器補足剩下的時間，確保每一步真的有等到
    const runWhenDue = ({ callback, dueAt }) => {
      const remaining = dueAt - Date.now();
      if (remaining > 20) window.setTimeout(callback, remaining);
      else callback();
    };
    worker.onmessage = (event) => {
      const entry = pending.get(event.data);
      pending.delete(event.data);
      if (entry) runWhenDue(entry);
    };
    // 被網站的安全政策擋下時錯誤是非同步回報的，這時把還在等的計時改用一般計時器補跑
    worker.onerror = () => {
      failed = true;
      pending.forEach(runWhenDue);
      pending.clear();
    };
    return {
      get mode() {
        return failed ? '一般計時器（背景計時器無法使用）' : '背景計時器';
      },
      setTimeout(callback, delay) {
        if (failed) return fallback.setTimeout(callback, delay);
        const id = `worker-${nextId++}`;
        pending.set(id, { callback, dueAt: Date.now() + (Number(delay) || 0) });
        worker.postMessage({ id, delay });
        return id;
      },
      clearTimeout(id) {
        if (typeof id === 'string' && pending.has(id)) {
          pending.delete(id);
          worker.postMessage({ id, cancel: true });
        } else {
          fallback.clearTimeout(id);
        }
      },
    };
  }

  function loadSettings() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) saved = migrateFromV1(JSON.parse(localStorage.getItem(V1_STORAGE_KEY) || '{}'));
    } catch {
      // 讀不到就用預設值
    }
    // 舊版目標關卡是一段文字（例如「大草原 20」），拆成區域與第幾關
    if (saved && saved.stageTarget && !saved.stageTargetArea) {
      const match = String(saved.stageTarget).trim().match(/^(.*?)\s*(\d+)$/);
      saved.stageTargetArea = match ? match[1].trim() : String(saved.stageTarget).trim();
      saved.stageTargetNumber = match ? Number(match[2]) : 0;
    }
    if (saved) delete saved.stageTarget;
    // 舊版要填 heroId，有填就代表在用 API 補給；現在自動用狩獵隊伍，只要把開關打開
    if (saved && !('resourceApiEnabled' in saved)) {
      ['resource', 'health'].forEach((groupId) => {
        const keys = Array.from({ length: SLOT_COUNT }, (_, index) => [`${groupId}Hero${index + 1}`, `huntHero${index + 1}`]).flat();
        if (keys.some((key) => saved[key])) saved[groupKey(groupId, 'ApiEnabled')] = true;
      });
    }
    // 舊版只有固定間隔，改成區間：原本的秒數當下限、兩倍當上限
    if (saved && saved.intervalSeconds && !saved.intervalMinSeconds) {
      saved.intervalMinSeconds = saved.intervalSeconds;
      saved.intervalMaxSeconds = saved.intervalSeconds * 2;
      delete saved.intervalSeconds;
    }
    const merged = { ...defaultSettings, ...saved };
    const presetVersion = Number(readJsonStorage(AREA_PRESET_KEY, 1)) || 1;
    if (saved && presetVersion < AREA_PRESET_VERSION) addMissingPresetAreas(merged);
    // 第 3 版以前預設老鼠洞從黑暗山洞 11 層進，實際是 12；還是舊預設值的才改，自己改過的不動
    if (saved && presetVersion < 4) {
      Array.from({ length: AREA_COUNT }, (_, index) => index)
        .filter((index) => merged[areaKey(index, 'Name')] === '老鼠洞' && merged[areaKey(index, 'Parent')] === '黑暗山洞' && Number(merged[areaKey(index, 'ParentStage')]) === 11)
        .forEach((index) => (merged[areaKey(index, 'ParentStage')] = 12));
    }
    writeJsonStorage(AREA_PRESET_KEY, AREA_PRESET_VERSION);
    // 舊版預設撿到稀有道具就暫停，改成預設只提醒；已經存過的設定也改一次，之後自己再勾就照自己的
    if (saved && !readJsonStorage(LOOT_RARE_PAUSE_OFF_KEY, false)) {
      merged.lootRarePause = false;
      saveSettings(merged);
    }
    writeJsonStorage(LOOT_RARE_PAUSE_OFF_KEY, true);
    // v2.82～2.84 預設不理會的關卡是空的；還是空的就補上新預設一次，之後自己清空就照自己的
    if (saved && !readJsonStorage(PLAYER_IGNORE_DEFAULT_KEY, false) && !merged.playerIgnoreStages) {
      merged.playerIgnoreStages = PLAYER_IGNORE_DEFAULT;
      saveSettings(merged);
    }
    writeJsonStorage(PLAYER_IGNORE_DEFAULT_KEY, true);
    return merged;
  }

  function addMissingPresetAreas(settings) {
    const names = Array.from({ length: AREA_COUNT }, (_, index) => String(settings[areaKey(index, 'Name')] || '').trim());
    DEFAULT_AREAS.filter((preset) => !names.includes(preset.name)).forEach((preset) => {
      const empty = names.indexOf('');
      if (empty === -1) return;
      names[empty] = preset.name;
      settings[areaKey(empty, 'Name')] = preset.name;
      settings[areaKey(empty, 'Parent')] = preset.parent || '';
      settings[areaKey(empty, 'ParentStage')] = preset.parentStage || 0;
    });
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // 部分網站會封鎖 localStorage，設定不保存但不影響執行
    }
  }

  // Radix / React 等套件每次打開彈窗都會重新產生 id（例如 radix-:rm:），拿來當 selector 下次就對不上
  function isStableId(id) {
    return Boolean(id) && !id.includes(':') && !id.startsWith('radix-');
  }

  // 優先用穩定的 id；沒有就往上組 nth-of-type 路徑，遇到彈窗本身就用 [role="dialog"] 當起點
  function buildSelector(element) {
    if (isStableId(element.id)) return '#' + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body) {
      if (isStableId(current.id)) {
        parts.unshift('#' + CSS.escape(current.id));
        break;
      }
      const role = current.getAttribute('role');
      if (role === 'dialog' || role === 'alertdialog') {
        parts.unshift(`[role="${role}"]`);
        break;
      }
      const tag = current.tagName.toLowerCase();
      const sameTagSiblings = Array.from(current.parentElement.children).filter(
        (sibling) => sibling.tagName === current.tagName
      );
      const index = sameTagSiblings.indexOf(current) + 1;
      parts.unshift(sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function slotRowsHtml(group) {
    return Array.from({ length: SLOT_COUNT }, (_, index) => {
      const buttons = Object.entries(SLOT_PARTS)
        .map(([part, label]) => {
          const key = slotKey(group.id, part, index);
          const pickMode = part === 'Bar' ? 'ratio' : 'replace';
          const buttonLabel = part === 'Bar' ? group.name : label;
          // 使用按鈕另外記下按鈕文字與所在那一列，selector 跑掉時用來找回同一個道具的按鈕；
          // X 記下文字，介面關掉後 selector 指到別的東西時才不會亂點
          const textField = {
            Use: `<input type="hidden" data-field="${key}Text"><input type="hidden" data-field="${key}Context">`,
            Close: `<input type="hidden" data-field="${key}Text">`,
          }[part] || '';
          return `${textField}<input type="hidden" data-field="${key}"><button data-pick="${key}" data-pick-mode="${pickMode}" data-slot-label="${buttonLabel}"></button>`;
        })
        .join('');
      return `<div class="row">第${index + 1}條${buttons}<button data-clear-slot="${group.id}:${index}" title="清除這一列">✕</button></div>`;
    }).join('');
  }

  // 用一顆按鈕代表一個要選取的目標，選好會顯示 ✓；text/context 為 true 時另外記下按鈕文字與所在那一列
  function pickButtonHtml(key, label, { mode = 'replace', text = false, context = false } = {}) {
    const hiddenFields = [key, text && `${key}Text`, context && `${key}Context`]
      .filter(Boolean)
      .map((field) => `<input type="hidden" data-field="${field}">`)
      .join('');
    return `${hiddenFields}<button data-pick="${key}" data-pick-mode="${mode}" data-slot-label="${label}"></button>`;
  }

  function clearButtonHtml(keys) {
    return `<button data-clear-fields="${keys.join(',')}" title="清除">✕</button>`;
  }

  function areaRowHtml(areaIndex) {
    const key = (name) => areaKey(areaIndex, name);
    return `
      <div style="border-top:1px dashed #3a3a40;padding-top:3px;margin-top:3px">
        <div class="row">${areaIndex + 1}. <input data-field="${key('Name')}" placeholder="區域名稱">
          ${pickButtonHtml(key('Enter'), '進入', { text: true })}</div>
        <div class="row">從<input data-field="${key('Parent')}" list="auto-clicker-areas" placeholder="（地形留空）" style="width:70px;flex:none">
          第 ${numberInput(key('ParentStage'), 'min="0"')} 關進入 ${pickButtonHtml(key('Return'), '返回', { text: true })}</div>
      </div>`;
  }

  function equipCharacterHtml(characterIndex) {
    const key = (name) => equipKey(characterIndex, name);
    const spareRows = Array.from({ length: SPARE_COUNT }, (_, spareIndex) => {
      const wearKey = key(`Wear${spareIndex + 1}`);
      return `<div class="row">備用${spareIndex + 1}
        ${pickButtonHtml(wearKey, '穿上', { text: true, context: true })}
        ${clearButtonHtml([wearKey, `${wearKey}Text`, `${wearKey}Context`])}</div>`;
    }).join('');
    return `
      <div data-character="${characterIndex}">
        <label class="row"><input data-field="${key('Enabled')}" type="checkbox" style="flex:none;width:auto"> 啟用第 ${characterIndex + 1} 位角色自動換裝</label>
        <div class="row">${pickButtonHtml(key('Durability'), '耐久數字', { mode: 'number' })}
          低於 ${numberInput(key('Threshold'), 'min="0"')} 就換</div>
        <div class="row">1. ${pickButtonHtml(key('Open'), '裝備欄', { text: true })}
          2. ${pickButtonHtml(key('Remove'), '脫下', { text: true })}</div>
        <div>3. 備用裝備的「穿上」（依序嘗試，穿上後耐久夠了就停）</div>
        ${spareRows}
        <div class="row">X 按鈕<input data-field="${key('Close')}" placeholder="留空＝Esc＋點空白處關閉"><button data-pick="${key('Close')}">選取</button></div>
        <label class="row"><input data-field="${key('PauseWhenEmpty')}" type="checkbox" style="flex:none;width:auto"> 沒有可用的備用裝備就暫停</label>
      </div>`;
  }

  function escapeTargetHtml(prefix) {
    return `<select data-field="${prefix}Area" data-area-select style="width:150px;flex:none;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select>
      第 ${numberInput(`${prefix}Number`, 'min="0"')} 關`;
  }

  function numberInput(key, attributes) {
    return `<input data-field="${key}" type="number" ${attributes} style="flex:none;width:44px">`;
  }

  function supplyGroupHtml(group) {
    const { id, name } = group;
    // 勾了 API 補給就只顯示 API 的設定，沒勾才顯示按鈕方式的設定，兩套不會擠在一起
    return `
    <fieldset class="group">
      <legend>${name}補給</legend>
      ${group.healField ? `<label class="row"><input data-field="${groupKey(id, 'ApiEnabled')}" type="checkbox" style="flex:none;width:auto">
        <b>用 API 補給</b>（直接讀數值、直接吃，不用選按鈕）</label>` : ''}
      <div class="row">低於 ${numberInput(groupKey(id, 'ThresholdPercent'), 'min="0" max="100"')}% 補到
        ${numberInput(groupKey(id, 'TargetPercent'), 'min="0" max="100"')}%，最多 ${numberInput(groupKey(id, 'MaxUses'), 'min="1"')} 次</div>
      <div data-supply-mode="button:${id}">
        <div class="hint">點該條的道具欄 → 連點使用直到目標 → 點 X；點了沒動或沒有使用按鈕＝沒道具 → 全隊休息</div>
        ${slotRowsHtml(group)}
        <div class="row">共用 X<input data-field="${groupKey(id, 'CloseSelector')}" placeholder="留空＝Esc＋點空白處關閉"><button data-pick="${groupKey(id, 'CloseSelector')}">選取</button></div>
      </div>
      ${group.healField ? `<div data-supply-mode="api:${id}">${apiSupplyHtml(group)}</div>` : ''}
    </fieldset>`;
  }

  function refreshSupplyModes() {
    const equipApiEnabled = panel.querySelector('[data-field="equipApiEnabled"]').checked;
    panel.querySelector('[data-equip-mode="api"]').style.display = equipApiEnabled ? '' : 'none';
    panel.querySelector('[data-equip-mode="button"]').style.display = equipApiEnabled ? 'none' : '';
    SUPPLY_GROUPS.forEach(({ id }) => {
      const apiToggle = panel.querySelector(`[data-field="${groupKey(id, 'ApiEnabled')}"]`);
      const apiEnabled = Boolean(apiToggle && apiToggle.checked);
      panel.querySelectorAll(`[data-supply-mode="button:${id}"]`).forEach((section) => (section.style.display = apiEnabled ? 'none' : ''));
      panel.querySelectorAll(`[data-supply-mode="api:${id}"]`).forEach((section) => (section.style.display = apiEnabled ? '' : 'none'));
    });
  }

  // 勾了「用 API 補給」的群組直接讀 API 判斷、直接吃，不用設定數值條／道具欄／使用／X。
  // 狩獵自動補隊伍裡每個人，只能排除；排除清單補血與補體力共用，放在補體力頁。鍛造的角色另外勾
  function apiSupplyHtml(group) {
    const forge = group.id === 'forge';
    const forgeHeroRows = Array.from({ length: SLOT_COUNT }, (_, index) => {
      const key = forgeHeroKey(index);
      return `<div class="row">第${index + 1}位 heroId<input data-field="${key}">
        <button data-capture-hero="${group.id}:${index}" title="按下後手動替這位角色吃一次道具，自動記下 heroId">抓取</button></div>`;
    }).join('');
    const heroSection = forge
      ? `<div class="row"><button data-load-heroes="${group.id}" title="讀取英雄列表，勾選負責鍛造的角色">從英雄列表勾選</button></div>
        <div data-hero-choices="${group.id}" class="choices"></div>
        ${forgeHeroRows}`
      : group.id === 'resource'
        ? `<div class="hint">自動補狩獵隊伍裡的每個人，換隊員也會跟著變；取消勾選＝不補那位</div>
          <input type="hidden" data-field="huntExcludedHeroIds">
          <div data-role="hunt-team" class="choices"><div class="hint">還沒讀到隊伍</div></div>
          <div class="row"><button data-action="load-hunt-team">重新讀取隊伍</button></div>`
        : `<div class="hint">自動補狩獵隊伍裡的每個人；要排除誰在「補體力」頁設定（兩邊共用）</div>`;
    return `
      <div class="hint">讀 ${forge ? '/api/heroes' : '/api/huntInfo'} 判斷；每次 1 或 10 個，間隔 1～3 秒；只從可用道具裡挑庫存最多的</div>
      <div class="subhead">可用道具</div>
      <div class="row"><input data-field="${groupKey(group.id, 'ItemNames')}" placeholder="留空＝全部都能用"><button data-load-items="${group.id}" title="讀取物品欄，勾選允許使用的道具">勾選</button></div>
      <div data-item-choices="${group.id}" class="choices"></div>
      <div class="subhead">角色</div>
      ${heroSection}`;
  }

  const panel = document.createElement('div');
  panel.innerHTML = `
    <div class="row" style="font-weight:bold;margin:0 0 6px;cursor:move" data-role="header">
      <span style="flex:1"><span data-role="app-name">愛吉吉</span> <span style="font-weight:normal;opacity:.7">v${SCRIPT_VERSION}</span> ⠿ <span data-role="mini-status" style="font-weight:normal;opacity:.85"></span></span>
      <button data-action="minimize" title="縮到最小／展開">–</button>
      <button data-action="close" title="關閉：這個分頁的腳本全部停止（重新整理頁面才會恢復）">×</button>
    </div>
    <div data-role="body">
    <div class="row">
      <button data-action="start">開始</button>
      <button data-action="stop">停止</button>
    </div>
    <div class="row global-row">全體
      <button data-action="global-run" data-global-mode="run">開始</button>
      <button data-action="global-temp" data-global-mode="temp">暫時暫停</button>
      <button data-action="global-stop" data-global-mode="stop">永久暫停</button>
    </div>
    <div class="row global-row">低調
      <button data-action="low-mode" data-low-mode="off">關</button>
      <button data-action="low-mode" data-low-mode="serious">認真</button>
      <button data-action="low-mode" data-low-mode="casual">休閒</button>
      <button data-action="low-mode" data-low-mode="auto">自動</button>
    </div>
    <div data-role="status" style="margin-top:6px">待命中</div>
    <div data-role="monitor" class="monitor"></div>
    <hr class="divider">
    <div class="tab-groups">${TAB_GROUPS.map(([id, name]) => `<button data-tab-group="${id}">${name}</button>`).join('')}</div>
    <div class="tabs">${TABS.map(([id, name]) => `<button data-tab-button="${id}" data-group="${tabGroupOf(id)}">${name}</button>`).join('')}</div>

    <div data-tab="main">
      <label class="row"><input data-field="huntByApiEnabled" type="checkbox" style="flex:none;width:auto"> <b>用 API 打怪</b>（不用停在狩獵頁，可以同一個分頁 API 鍛造）</label>
      <div class="hint">開了之後原地掛機、前進後退、全隊休息都直接打 API；補給、換裝請用 API 版。目標關卡只會在同一張地圖裡前進後退</div>
      <label>冷卻結束後再等 ${numberInput('huntReactMinSeconds', 'min="0" step="0.5"')} ～ ${numberInput('huntReactMaxSeconds', 'min="0" step="0.5"')} 秒（隨機）才打</label>
      <div class="hint">像人看到冷卻結束才按。這是打怪頻率最大的變數：1～3 秒一輪約 13 秒，0.5～1.5 秒約快 8%，但越短越不像人。三個帳號自動同步</div>
      <label class="row"><input data-field="lowProfileEnabled" type="checkbox" style="flex:none;width:auto"> <b>低調模式</b>（模擬人類操作的延遲）</label>
      <div class="row">玩法 <select data-field="lowProfileStyle" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="serious">認真玩：一段一段長時間玩</option><option value="casual">休閒：每小時玩一點，離開時偶爾回來點幾下</option><option value="auto">自動：認真時段認真玩，其他時間休閒</option></select></div>
      <div class="row">自動：每天 <input data-field="lowProfileSeriousHours" placeholder="20-24" style="width:110px;flex:none"> 點認真玩（可寫多段 12-13,20-24；每天前後飄 30 分鐘）</div>
      <div class="row">認真：玩 ${numberInput('lowProfilePlayMinMinutes', 'min="5"')}～${numberInput('lowProfilePlayMaxMinutes', 'min="5"')} 分鐘，休息 ${numberInput('lowProfileBreakMinMinutes', 'min="1"')}～${numberInput('lowProfileBreakMaxMinutes', 'min="1"')} 分鐘</div>
      <div class="row">休閒：每小時玩 ${numberInput('lowProfileCasualMinutes', 'min="0" max="60"')} 分鐘（每小時前後飄 30%，分 1～2 段）</div>
      <div class="row">休閒離開時每 ${numberInput('lowProfileCheckinMinMinutes', 'min="1"')}～${numberInput('lowProfileCheckinMaxMinutes', 'min="1"')} 分鐘回來點 ${numberInput('lowProfileCheckinMinHunts', 'min="1"')}～${numberInput('lowProfileCheckinMaxHunts', 'min="1"')} 下狩獵</div>
      <label class="row"><input data-field="lowProfileForgeCheckin" type="checkbox" style="flex:none;width:auto"> 休閒離開時鍛造好了就回來收（晚 1～8 分鐘），順便點幾下狩獵</label>
      <div class="row">每天 <input data-field="lowProfileSleepHours" placeholder="留空＝不睡" style="width:70px;flex:none"> 點睡覺（例：2-9；每天前後飄 1 小時，偶爾多睡）</div>
      <div class="row">每天 <input data-field="lowProfileOffHours" placeholder="留空＝沒有" style="width:110px;flex:none"> 點完全休息（例：9-12,14-17；前後飄 15 分鐘）</div>
      <div class="hint">完全休息跟睡覺一樣：不打怪、不開爐、不收鍛造，休閒的「回來看一下」也不會有。不管哪種玩法都照這個時段停</div>
      <div class="hint">開了之後掛機、API 鍛造每一步多等 1～8 秒（多數短、偶爾長），偶爾分心停 0.5～2 分鐘，要補給、換裝時晚幾秒才反應，動作之間的間隔也拉長；玩一陣子就整個停下休息，晚上睡覺。休息、睡覺時不會打怪、開爐，也不會躲紅名（血量、活人驗證照常監控）。反應變慢，補給門檻設高一點比較安全</div>
      <div class="hint" data-role="low-profile-personality"></div>
      <label class="row"><input data-field="turnTakingEnabled" type="checkbox" style="flex:none;width:auto"> <b>多開輪流</b>（同一台電腦的帳號一次只有一個送出請求）</label>
      <div class="row"><b>主帳號</b> <input data-field="mainAccountName" placeholder="留空＝沒有" style="width:110px;flex:none"> <button data-action="main-account-me" style="flex:none">設成這個帳號</button></div>
      <div class="row">小號打怪頻率是主帳號的 ${numberInput('sideHuntPercent', 'min="10" max="100" step="5"')} %</div>
      <div class="hint">填帳號名稱。主帳號照常打；其他帳號每次打怪後多等一段（每次長短不一），50% 約兩輪打一次，讓出來的時間給主帳號。只影響 API 打怪，鍛造照常。三個帳號自動同步</div>
      <label class="row"><input data-field="syncAccountsEnabled" type="checkbox" style="flex:none;width:auto"> <b>三個帳號同步</b>（當成同一個人）</label>
      <div class="hint">要開中繼站。低調模式、多開輪流、轉移模式的設定在任一個帳號改了，其他帳號約 10 秒內跟著改；低調模式的玩／休息／睡覺時間表三個帳號一樣，一起停下來休息（手速、分心還是各帳號自己的）</div>
      <div class="hint" data-role="sync-accounts-status"></div>
      <div class="row">全體「暫時暫停」${numberInput('globalPauseMinutes', 'min="1"')} 分鐘後自動開始</div>
      <div class="hint">最上面「全體」三顆按鈕要開中繼站：一按，同一台電腦上所有帳號（掛機、鍛造、補給…）的請求都先停住，送出去的會做完；按「開始」從停下的地方接著跑。你自己點遊戲畫面不受影響，適合手動操作時用。中繼站重開後永久暫停還在</div>
      <div class="hint">要開中繼站（啟動中繼站.cmd），每個帳號都要勾。腳本打的 API 一律經中繼站排隊，一次一個，換到別的帳號（或別的分頁）之前隔 0.5～1.5 秒；讀完畫面接著打怪算同一次，不用再排，像一個人在幾個視窗之間切換；總覽、附近玩家、收入這類定時讀取會等這個帳號下次動作時順便送（最多等 30 秒）。中繼站沒開就照舊直接送。遊戲網頁自己發的請求不受管</div>
      <label class="row"><input data-field="autoNavigateEnabled" type="checkbox" style="flex:none;width:auto"> 執行中不在狩獵頁／鍛造頁就自動切過去（API 打怪、API 鍛造不需要）</label>
      <label>A 原地掛機（重複點）</label>
      <div class="row"><input data-field="selectorA" placeholder="CSS selector"><button data-pick="selectorA">選取</button></div>
      <label>原地掛機點 ${numberInput('repeatCount', 'min="1"')} 次後全隊休息</label>
      <label>間隔 ${numberInput('intervalMinSeconds', 'min="0.5" step="0.1"')} ～ ${numberInput('intervalMaxSeconds', 'min="0.5" step="0.1"')} 秒隨機（偏向較短）</label>
      <label>B 全隊休息</label>
      <div class="row"><input data-field="selectorB" placeholder="CSS selector"><button data-pick="selectorB">選取</button></div>
      <label class="row"><input data-field="loop" type="checkbox" style="flex:none;width:auto"> 全隊休息後
        <input data-field="loopDelaySeconds" type="number" min="0" style="flex:none;width:56px"> 秒重新循環</label>
      <label>C 休息結束（第二輪起每輪開始前點，可留空）</label>
      <div class="row"><input data-field="selectorC" placeholder="CSS selector"><button data-pick="selectorC">選取</button></div>
    </div>

    <div data-tab="move">
      <label class="row"><input data-field="stageEnabled" type="checkbox" style="flex:none;width:auto"> 自動移動到目標關卡（到之前不原地掛機）</label>
      <div class="row">關卡欄位<input data-field="stageSelector" placeholder="顯示目前位置的文字"><button data-pick="stageSelector" data-pick-mode="element">選取</button></div>
      <div class="row">目標<select data-field="stageTargetArea" data-area-select style="width:150px;flex:none;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select>
        第 ${numberInput('stageTargetNumber', 'min="0"')} 關</div>
      <div class="hint">選項來自下面的區域表。目標是分支時關卡填 0＝進去就開始刷；大區填 0＝進到大區就好。
        API 打怪不用設定下面的按鈕：換大區會先回城再前往，分支裡可以再有分支（母區域填分支名稱）；不在目標那條路上就直接去目標大區第 1 層，再一路走進去。走到分支入口時遊戲會告訴腳本有哪些分支，區域表沒有的會自動補上</div>
      <datalist id="auto-clicker-areas"></datalist>
      <div class="row">城鎮<input data-field="townName" placeholder="初始之鎮" style="width:90px;flex:none">${pickButtonHtml('stageTown', '回城', { text: true })}</div>
      <div class="hint">在城鎮時直接按目標大區（到第 1 關再前行）；目標填城鎮名稱＝回城</div>
      <div class="row">${pickButtonHtml('selectorD', '前行', { text: true })} ${pickButtonHtml('stageBack', '後退', { text: true })} ${pickButtonHtml('stageFinishMove', '完成移動', { text: true })}</div>
      <label>移動時間到了再等 ${numberInput('finishMoveMinSeconds', 'min="0" step="0.5"')} ～ ${numberInput('finishMoveMaxSeconds', 'min="0" step="0.5"')} 秒（隨機）才完成移動</label>
      <div class="hint">畫面上出現可按的「完成移動」時一律先按，不管有沒有開自動移動</div>
      <fieldset class="group">
        <legend>區域表</legend>
        <div class="hint">名稱要和關卡欄位上的文字一樣。「從…第…關進入」留空＝大區（用進入按鈕切換大區）；有填＝分支地圖（在那一關按進入，用返回按鈕回大區）；母區域也可以是分支</div>
        ${Array.from({ length: AREA_COUNT }, (_, index) => areaRowHtml(index)).join('')}
      </fieldset>
    </div>

    ${SUPPLY_GROUPS.filter((group) => !group.forgeOnly)
      .map((group) => `<div data-tab="${group.id}">${supplyGroupHtml(group)}</div>`)
      .join('')}

    <div data-tab="forge">
      <div class="row"><button data-action="forge-start" style="font-weight:bold">開始鍛造</button><button data-action="forge-stop">停止鍛造</button></div>
      <div class="hint">勾「用 API 鍛造」：鍛造自己跑，可以跟上方「開始」的掛機同時進行，人也不用待在鍛造頁。沒勾（按鈕鍛造）：要待在鍛造頁，跟掛機只能二選一，按其中一個開始會停掉另一個。上方「開始」只管掛機</div>
      <fieldset class="group">
        <legend>API 鍛造（用「配方」頁的配方）</legend>
        <label class="row"><input data-field="forgeByApiEnabled" type="checkbox" style="flex:none;width:auto"> <b>用 API 鍛造</b>（不用設下面的按鈕鍛造）</label>
        <div class="row">鍛造欄位 ${numberInput('forgeShopSlots', 'min="0"')} 個（0＝自動讀遊戲）　開 ${numberInput('forgeByApiCount', 'min="0"')} 爐（0＝不限）</div>
        <div class="hint">只要填這個帳號有幾個鍛造欄位；哪個角色用哪一格會自動找空的</div>
        <fieldset class="group">
          <legend>鍛造佇列</legend>
          <div data-role="forge-plan-overview" style="font-size:12px"></div>
        </fieldset>
        <fieldset class="group" data-fold="closed">
          <legend>編輯佇列（列出所有角色）</legend>
          <div class="row"><button data-action="forge-api-heroes">讀取角色</button></div>
          <input data-field="forgeByApiHeroIds" type="hidden"><input data-field="forgeByApiPlans" type="hidden">
          <div data-role="forge-api-heroes" style="font-size:12px;max-height:200px;overflow:auto"></div>
          <div class="hint">勾選＝排進佇列。每個角色可以有自己的類型、名稱、配方；名稱沒填就用「配方」頁的。按「帶入」把「配方」頁目前的類型與配方帶進來。平常在「配方」頁的「④ 給誰用」按「加入」就好</div>
          <label class="row"><input data-field="forgeFillGameForm" type="checkbox" style="flex:none;width:auto"> 送出前把類型、名稱、材料也填到遊戲的鍛造頁（停在鍛造頁、而且「按鈕鍛造」區設過該鍛造坊的「切換」按鈕才會切過去填）</label>
        </fieldset>
        <fieldset class="group" data-fold="closed">
          <legend>每天自動換名稱</legend>
          <label class="row"><input data-field="forgeAutoNameEnabled" type="checkbox" style="flex:none;width:auto"> <b>每天自動換名稱</b>：過 00:00 先暫停開爐，等測名表有好名稱再換上繼續</label>
          <div class="row">每 ${numberInput('forgeAutoNameMinutes', 'min="1"')} 分鐘抓一次測名表，分數 ≥ ${numberInput('forgeAutoNamePercent', 'min="0" max="100" step="0.5"')} % 就用（0＝有資料就用最高的）</div>
          <label>各裝備看重的屬性（一行一組，越前面越重要；屬性用 攻 防 智 幸 重 耐）</label>
          <textarea data-field="forgeNamePriorities" rows="4" style="width:100%;box-sizing:border-box"></textarea>
          <div class="hint">每種裝備各自挑分數最高的名稱：排第 1 的屬性佔最多（3 個屬性就是 3:2:1 加權平均）。佇列裡不同類型的角色會拿到不同名稱；沒列到的類型用六圍平均。全部類型都到門檻才開新爐</div>
          <div class="hint">換名稱時勾選角色的名稱、配方頁的名稱都會換成今天六圍平均最高的（同名稱測過好幾次取平均）。暫停期間做好的爐照樣收。手動開始、重整頁面也一樣：今天的名稱還沒定就先等。當天自己改過名稱就用自己的，下一個 00:00 才換</div>
        </fieldset>
        <div class="hint">佇列裡的角色好了就收、閒著就用自己的類型與配方開下一爐；材料不夠會暫停提醒，鍛造體力照下面的設定補</div>
      </fieldset>
      <fieldset class="group" data-fold="closed">
        <legend>按鈕鍛造（沒勾「用 API 鍛造」才用）</legend>
        <label>巡視間隔 ${numberInput('forgeIntervalMinSeconds', 'min="1" step="0.1"')} ～ ${numberInput('forgeIntervalMaxSeconds', 'min="1" step="0.1"')} 秒隨機</label>
        <div class="row">共用按鈕 ${pickButtonHtml('forgeStart', '開始鍛造', { text: true })} ${pickButtonHtml('forgeFinish', '完成鍛造', { text: true })}</div>
        <div>鍛造坊（切換按鈕與次數，次數 0 或沒選切換按鈕就不做）</div>
        ${Array.from({ length: FORGE_SHOP_COUNT }, (_, index) => {
          const key = (name) => forgeKey(index, name);
          return `<div class="row">${index + 1}. ${pickButtonHtml(key('Switch'), '切換', { text: true })}
            次數 ${numberInput(key('Count'), 'min="0"')}
            ${clearButtonHtml([key('Switch'), `${key('Switch')}Text`])}</div>`;
        }).join('')}
      </fieldset>
      ${supplyGroupHtml(SUPPLY_GROUPS.find((group) => group.id === 'forge'))}
    </div>

    <div data-tab="equip">
      <fieldset class="group">
        <legend>API 換裝</legend>
        <label class="row"><input data-field="equipApiEnabled" type="checkbox" style="flex:none;width:auto">
          <b>用 API 自動換裝</b>（只換勾選的角色，不用選按鈕）</label>
        <div data-equip-mode="api">
          <div class="row">耐久低於 ${numberInput('equipApiMinDurability', 'min="0"')} 就換</div>
          <label class="row"><input data-field="equipApiSameName" type="checkbox" style="flex:none;width:auto"> 只換同名裝備（不勾＝同類型都可以）</label>
          <label class="row"><input data-field="equipApiPauseWhenEmpty" type="checkbox" style="flex:none;width:auto"> 沒有可替換的裝備就暫停</label>
          <div class="subhead">要換裝的角色</div>
          <input type="hidden" data-field="equipApiHeroIds">
          <div data-role="equip-heroes" class="choices"><div class="hint">還沒讀到隊伍</div></div>
          <div class="row"><button data-action="load-hunt-team">重新讀取隊伍</button></div>
          <div class="subhead">可以換上的裝備</div>
          <div class="row"><input data-field="equipApiAllowedNames" placeholder="留空＝閒置裝備都能用"><button data-action="load-equipment-choices">勾選</button></div>
          <div data-role="equipment-choices" class="choices"></div>
          <div class="hint">從閒置中的裝備挑同類型、耐久最高的；先脫下舊的再穿上新的，每步間隔 1～3 秒，記在「紀錄」頁</div>
        </div>
      </fieldset>
      <div data-equip-mode="button">
        <div class="tabs">${Array.from({ length: CHARACTER_COUNT }, (_, index) => `<button data-character-button="${index}">角色${index + 1}</button>`).join('')}</div>
        ${Array.from({ length: CHARACTER_COUNT }, (_, index) => equipCharacterHtml(index)).join('')}
        <div class="hint">每步間隔沿用「暫停」頁的道具每步間隔</div>
      </div>
    </div>

    <div data-tab="train">
      <label class="row"><input data-field="trainEnabled" type="checkbox" style="flex:none;width:auto"> <b>練特定英雄</b>（要開「用 API 打怪」，打怪執行中才會動）</label>
      <div class="hint">打勾後：記下原本的隊伍和關卡 → 回城 → 換上要練的英雄、穿上勾的裝備 → 去練等關卡打 → 要練的每一隻都到指定等級 → 回城 → 換回原本的隊伍和裝備 → 回原本的關卡繼續打。練到一半取消勾選＝提早回去換回來</div>
      <div class="row">練等關卡 ${escapeTargetHtml('trainTarget')}</div>
      <div class="row">練到 ${numberInput('trainLevel', 'min="1"')} 級（等級 ≥ 這個就算練好）</div>
      <input type="hidden" data-field="trainHeroIds">
      <input type="hidden" data-field="trainKeepIds">
      <input type="hidden" data-field="trainEquip">
      <div class="row"><button data-action="load-train-heroes">讀取英雄與裝備</button></div>
      <div data-role="train-heroes" class="choices"><div class="hint">按「讀取英雄與裝備」</div></div>
      <div data-role="train-status" class="hint"></div>
      <div class="row"><span class="hint" style="flex:1">卡住時（例如手動換過隊伍）可以清掉進度，不會換回隊伍</span><button data-action="train-reset">清除練等進度</button></div>
    </div>

    <div data-tab="pause">
      <label>緊急暫停：任一條血條低於 ${numberInput('healthPausePercent', 'min="0" max="100"')}%（要比補血門檻低）</label>
      <label>原地掛機前任一條體力低於 ${numberInput('resourcePausePercent', 'min="0" max="100"')}% 就暫停（0＝不檢查；休息中不檢查）</label>      <label class="row"><input data-field="deathPauseEnabled" type="checkbox" style="flex:none;width:auto"> 有人死亡（任一條血條血量 0）就暫停</label>
      <label class="row"><input data-field="expPauseEnabled" type="checkbox" style="flex:none;width:auto"> 經驗 ≥
        ${numberInput('expPausePercent', 'min="0" max="100" step="0.1"')}% 就暫停（等你手動練等）</label>
      <div class="row">經驗條<input data-field="expSelectors" placeholder="逐條按「加入」"><button data-pick="expSelectors" data-pick-mode="ratio-append">加入</button><button data-clear="expSelectors">清除</button></div>
      <label>異常狀態（中毒、燒傷…）</label>
      <div class="row">　🔔 只提醒、繼續打：<select data-field="statusAlertLevel" style="flex:none;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="0">不處理</option><option value="1">輕度以上</option><option value="2">中度以上</option><option value="3">重度</option></select></div>
      <div class="row">　⏸ 暫停：<select data-field="statusPauseLevel" style="flex:none;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="0">不處理</option><option value="1">輕度以上</option><option value="2">中度以上</option><option value="3">重度</option></select></div>
      <div class="hint">例：提醒選「輕度以上」、暫停選「重度」＝輕度、中度只響提醒，重度才停下來</div>
      <div class="row">撿到稀有道具提醒<input data-field="lootRareNames" placeholder="名稱包含這些字就提醒，逗號分隔"></div>
      <label class="row"><input data-field="lootRarePause" type="checkbox" style="flex:none;width:auto"> 撿到稀有道具時暫停掛機（沒勾就只在右下角小提示）</label>
      <fieldset class="group">
        <legend>避難：換關卡掛機</legend>
        <label class="row"><input data-field="healthEscapeEnabled" type="checkbox" style="flex:none;width:auto"> 血量低於上面「緊急暫停」的 % 時，不暫停、改去</label>
        <div class="row">${escapeTargetHtml('healthEscape')}</div>
        <label class="row"><input data-field="playerEscapeEnabled" type="checkbox" style="flex:none;width:auto"> 同地圖有危險玩家時離開</label>
        <div class="row">做法<select data-field="playerEscapeMode" style="flex:1;min-width:0;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="back">往回退一關（還有就再退）</option><option value="escape">先去避難關卡，那裡也有再往回退</option></select></div>
        <div class="row">避難關卡 ${escapeTargetHtml('playerEscape')}</div>
        <label class="row"><input data-field="playerEscapeRed" type="checkbox" style="flex:none;width:auto"> 紅名玩家算危險</label>
        <div class="row">黑名單<input data-field="playerBlacklist" placeholder="玩家暱稱或 ID，逗號分隔"></div>
        <div class="row">不理會的關卡<input data-field="playerIgnoreStages" placeholder="例：大草原1-3、黑暗山洞1-3"></div>
        <div class="row"><label style="flex:none"><input data-field="playerReturnEnabled" type="checkbox" style="width:auto"> 躲開後</label> ${numberInput('playerReturnMinutes', 'min="1"')} 分鐘沒再遇到危險玩家，就走回原本掛機的關卡</div>
        <div class="hint">不理會的關卡寫法：「大草原1-3」＝大草原第 1～3 關；「1-2」＝每個區域的第 1、2 關；「老鼠洞」＝整個老鼠洞；多個用逗號或頓號分開</div>
        <div class="hint">觸發時把「移動」頁的目標改成這裡並打開自動移動，走過去後照常掛機。血量：到了避難關卡血量還是低才暫停（死亡照樣馬上暫停）。玩家：每 15 秒看一次同地圖的玩家（城鎮不看）；移動途中路過的關卡不管，到了目標關卡才看；分支退到入口之前會回到母區域；退到第 1 關還有就只提醒</div>
      </fieldset>
      <label class="row"><input data-field="verifyEnabled" type="checkbox" style="flex:none;width:auto"> 畫面出現驗證框就暫停</label>
      <div class="row">關鍵字<input data-field="verifyKeyword" placeholder="驗證框上的文字"></div>
      <label class="row"><input data-field="verifyAutoResume" type="checkbox" style="flex:none;width:auto"> 驗證框消失後自動繼續（只在因驗證框暫停時）</label>
      <label>道具每步間隔 ${numberInput('itemStepSeconds', 'min="0.5" step="0.1"')} 秒（最少 0.5；補給、換裝、鍛造共用）</label>
    </div>

    <div data-tab="alert">
      <div>自動暫停時要用哪些方式提醒（手動按停止不會提醒）：</div>
      <label class="row"><input data-field="alertRedEnabled" type="checkbox" style="flex:none;width:auto"> 介面亮紅</label>
      <label class="row"><input data-field="alertSoundEnabled" type="checkbox" style="flex:none;width:auto"> 發出聲音</label>
      <div class="row">音量<input data-field="alertVolume" type="range" min="0" max="100"><button data-action="test-sound">試聽</button></div>
      <label class="row"><input data-field="alertPopupEnabled" type="checkbox" style="flex:none;width:auto"> 彈出提示視窗</label>
      <label class="row"><input data-field="alertNotifyEnabled" type="checkbox" style="flex:none;width:auto"> 系統通知＋分頁標題閃爍</label>
      <label class="row"><input data-field="showAccountName" type="checkbox" style="flex:none;width:auto"> 面板標題、分頁標題和提醒顯示帳號名稱（例如「愛吉吉的小明」）</label>
      <fieldset class="group">
        <legend>多帳號總覽</legend>
        <label class="row"><input data-field="dashboardEnabled" type="checkbox" style="flex:none;width:auto"> 回報到總覽頁（每 5 秒）</label>
        <div class="row">位址<input data-field="dashboardUrl"></div>
        <div class="hint">先執行 monitor-server.ps1，再用瀏覽器開這個位址看三個帳號；不按開始也會回報</div>
        <label class="row"><input data-field="autoUpdateEnabled" type="checkbox" style="flex:none;width:auto"> 中繼站上有新版就自動重新整理（要用載入器安裝）</label>
      </fieldset>
    </div>

    <div data-tab="combat">
      <label class="row"><input data-field="combatEnabled" type="checkbox" style="flex:none;width:auto"> 讀取戰鬥紀錄並統計（不用按開始）</label>
      <div class="row">紀錄區 ${pickButtonHtml('combatSelector', '選取', { mode: 'log' })} ${clearButtonHtml(['combatSelector'])}</div>
      <div class="hint">原地掛機後會直接讀 /api/hunt 回傳的戰報，不用選取；只有讀不到 API 時才用下面的紀錄區或標題文字找畫面</div>
      <div class="row">紀錄標題<input data-field="combatKeyword" placeholder="戰鬥紀錄最上面那行字"></div>
      <div data-role="combat-stats"></div>
      <div data-role="combat-anomalies"></div>
      <div class="row"><button data-action="copy-last-report">複製上一場戰報</button><button data-action="reset-combat">重置統計</button></div>
      <textarea data-role="combat-report" rows="4" style="display:none;width:100%;box-sizing:border-box;font:11px monospace"></textarea>
      <div class="hint">控制＝讓敵人陷入異常（燒傷、害怕降攻…）的次數；擊殺＝補最後一刀的人；爆擊＝命中要害的比例；回血／回體＝恢復生命值／體力的量，算在施放的人身上</div>
    </div>

    <div data-tab="growth">
      <div class="hint">同名的卡成長也不一樣，一張卡一筆（自己的加上匯入別人的）</div>
      <div class="row"><select data-role="growth-type" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select>
        <button data-action="growth-refresh">重新計算</button></div>
      <div data-role="growth-summary"></div>
      <div class="subhead">全部角色合併：依升級地點（各角色先跟自己的平均比，跟角色無關）</div>
      <div data-role="growth-places" style="font-size:12px"></div>
      <div class="row"><button data-action="growth-viewer" style="font-weight:bold">開啟地圖統計大表</button></div>
      <div class="hint">不在狩獵隊伍裡的角色升級算「修練」；只算一次升一級的紀錄</div>
      <fieldset class="group">
        <legend>分享與整合</legend>
        <label class="row"><input data-field="growthSyncEnabled" type="checkbox" style="flex:none;width:auto"> 透過中繼站自動同步（自己的帳號之間每 5 分鐘合併一次）</label>
        <div class="row"><span data-role="growth-sync-status" class="hint" style="flex:1"></span><button data-action="growth-sync-now">立即同步</button></div>
        <div class="hint">匯出全部角色的升級紀錄（只有角色名稱、類型、每次升級的成長值與地點，不含帳號）。匯入別人的檔案會合併，同一筆升級不會重複算，可以一直匯入不同人的</div>
        <div class="row"><button data-action="growth-export-file">匯出成檔案</button><button data-action="growth-export-copy">複製</button></div>
        <div class="row"><button data-action="growth-import-file">從檔案匯入（可多選）</button>
          <input data-role="growth-import-file" type="file" accept=".json,application/json" multiple style="display:none"></div>
        <textarea data-role="growth-share-text" rows="3" placeholder="或把別人複製的內容貼在這裡" style="width:100%;box-sizing:border-box;font:11px monospace"></textarea>
        <div class="row"><button data-action="growth-import-text">匯入貼上的內容</button>
          <button data-action="growth-load-types" title="舊紀錄可能沒有記到角色類型，讀一次角色清單補上">補齊角色類型</button></div>
      </fieldset>
    </div>

    <div data-tab="pick">
      <div class="hint">在遊戲「物品」頁按「掃描物品頁」，列出畫面上有的品質、類型、名稱；同一組勾多個＝任一個都算，不同組要同時符合，整組不勾＝不限</div>
      <div class="row"><button data-action="quality-pick-scan">掃描物品頁</button>
        <select data-field="qualityPickMode" style="flex:none;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px">
          <option value="check">勾選</option><option value="uncheck">取消勾選</option></select></div>
      <input data-field="qualityPickNames" type="hidden"><input data-field="qualityPickTypes" type="hidden"><input data-field="qualityPickItemNames" type="hidden">
      <div data-role="pick-choices" style="max-height:220px;overflow:auto;font-size:12px"></div>
      <div class="row">每勾一個間隔 ${numberInput('qualityPickMinMilliseconds', 'min="0"')} ～ ${numberInput('qualityPickMaxMilliseconds', 'min="0"')} 毫秒</div>
      <div class="row"><button data-action="quality-pick">開始</button><button data-action="quality-pick-stop">停止</button></div>
      <div class="hint">只處理畫面上這一頁；已經是目標狀態的不會再點</div>
    </div>

    <div data-tab="material">
      <div class="hint">鍛造材料在鍛造時自動記（也讀鍛造工具腳本的紀錄）；裝備數值在物品頁看過就會記下來，之後賣掉也還算得到</div>
      <div class="row"><select data-role="material-mode" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="tendency">材料屬性傾向（全部類型）</option><option value="regression">依材料貢獻（扣除其他材料）</option><option value="single">依單一材料</option><option value="combo">依材料組合</option><option value="enchant">附魔推測（填材料估附魔）</option></select>
        <select data-role="material-type" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select></div>
      <div class="row"><select data-role="material-forger" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select></div>
      <div class="row"><select data-role="material-sort" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="count">依件數</option><option value="atk">依攻擊</option><option value="def">依防禦</option><option value="int">依智力</option><option value="lck">依幸運</option><option value="fullDur">依耐久</option><option value="wgt">依重量（輕的先）</option><option value="recyclePrice">依回收價</option></select>
        <input data-role="material-filter" placeholder="搜尋材料" style="flex:1;min-width:0"></div>
      <label class="row"><input data-field="materialNameAdjust" type="checkbox" style="flex:none;width:auto"> 扣掉名稱影響（用每日測名表的比重）</label>
      <label class="row"><input data-field="forgeDetailEnabled" type="checkbox" style="flex:none;width:auto"> 在遊戲的裝備詳細資料顯示鍛造材料、時間與基本值</label>
      <div class="row"><button data-action="material-refresh">讀取裝備並統計</button><button data-action="material-viewer">放大檢視</button></div>
      <div data-role="material-summary" style="font-size:12px;max-height:380px;overflow:auto"></div>
    </div>

    <div data-tab="mining">
      <div class="row"><button data-action="mining-start" style="font-weight:bold">開始挖礦</button><button data-action="mining-stop">停止挖礦</button><button data-action="mining-refresh">重新讀取</button></div>
      <div class="hint">選了地點的角色在城裡閒著就去挖（狩獵隊伍、鍛造佇列裡的角色不會被拿去），時間到收礦再出發；遊戲規定至少挖 3 分鐘。可以跟掛機、鍛造同時跑</div>
      <div class="row">挖 ${numberInput('miningIntervalHours', 'min="0.1" step="0.5"')} 小時收一次再挖（每次前後飄 ${numberInput('miningIntervalJitterPercent', 'min="0" max="50"')} %）</div>
      <div class="row"><button data-action="mining-potions">重新讀取道具</button><span style="color:#a0a0aa">都不勾＝任何這類道具；補到差不到半瓶就滿為止</span></div>
      <label class="row"><input data-field="miningHpPotionEnabled" type="checkbox" style="flex:none;width:auto"> 出發前把 HP 補滿</label>
      <input data-field="miningHpPotionNames" type="hidden">
      <div data-role="mining-hp-potions" style="font-size:12px"></div>
      <label class="row"><input data-field="miningPotionEnabled" type="checkbox" style="flex:none;width:auto"> 出發前把體力補滿</label>
      <input data-field="miningPotionNames" type="hidden">
      <div data-role="mining-potions" style="font-size:12px"></div>
      <div class="hint">沒有道具時，體力不到三成或 HP 不到一半會先休息再挖</div>
      <label class="row"><input data-field="miningConditionRest" type="checkbox" style="flex:none;width:auto"> 有異常狀態（中毒…）就不出發、正在挖的提早收，並跳出提醒</label>
      <div class="hint">異常狀態下挖礦可能會死。有異常的角色留在城裡不動，好了才再出發</div>
      <input data-field="miningPlans" type="hidden"><input data-field="miningOrder" type="hidden">
      <div class="subhead">角色（選地點＝要挖；沒在跑「開始挖礦」時每 5 分鐘讀一次）</div>
      <div class="hint">要挖的角色一起出發、一起收：任一個時間到就照上面的順序（↑↓ 調整）全部收完，再一個一個出發</div>
      <div data-role="mining-heroes" style="font-size:12px"></div>
      <div class="subhead">最近收穫</div>
      <div data-role="mining-log" style="font-size:12px"></div>
    </div>

    <div data-tab="recipe">
      <div class="hint">這頁是配方編輯器：①看推薦 ②勾材料 ③取名稱 ④按「加入」把角色排進自動鍛造，或只鍛一次</div>
      <div class="subhead">① 推薦配方</div>
      <div class="row"><select data-field="forgeRecipeType" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option>單手劍</option><option>細劍</option><option>短刀</option><option>單手錘</option><option>盾牌</option><option>雙手劍</option><option>太刀</option><option>雙手斧</option><option>長槍</option><option>頭盔</option><option>帽子</option><option>盔甲</option><option>大衣</option><option>項鍊</option></select>
        <select data-role="recipe-goal" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="total">攻防智運合計</option><option value="atk">攻擊</option><option value="def">防禦</option><option value="int">智力</option><option value="lck">幸運</option><option value="fullDur">耐久</option><option value="wgt">重量輕</option></select></div>
      <div class="row"><select data-role="recipe-forger" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select></div>
      <label class="row"><input data-field="recipeNameAdjust" type="checkbox" style="flex:none;width:auto"> 扣掉名稱影響（只算對得到測名表的裝備）</label>
      <div data-role="recipe-list" style="font-size:12px;max-height:200px;overflow:auto"></div>
      <div class="subhead">② 配方（勾選材料）</div>
      <div class="row"><button data-action="mines-refresh">讀取材料庫存</button><input data-role="recipe-filter" placeholder="篩選材料名稱" style="flex:1;min-width:0"></div>
      <div data-role="recipe-total" style="font-size:12px;margin:2px 0"></div>
      <div data-role="recipe-picker" style="font-size:12px;max-height:220px;overflow:auto"></div>
      <div class="row">配方<input data-field="forgeRecipe" placeholder="勾上面的材料，或按推薦的「用」"></div>
      <div class="subhead">③ 名稱</div>
      <div class="row">名稱<input data-field="forgeRecipeName" list="autoClickerTodayNames" placeholder="名稱每天影響數值，自己取"><button data-action="name-sheet-refresh">更新測名表</button></div>
      <datalist id="autoClickerTodayNames"></datalist>
      <div data-role="name-suggest" style="font-size:12px;max-height:180px;overflow:auto"></div>
      <div class="subhead">④ 給誰用（按「加入」就排進自動鍛造佇列）</div>
      <div data-role="recipe-heroes" style="font-size:12px;max-height:240px;overflow:auto"></div>
      <div class="row"><button data-action="recipe-heroes">重新讀取角色</button></div>
      <div class="row">開 ${numberInput('forgeRecipeRepeat', 'min="0"')} 爐（0＝不限）<button data-action="recipe-auto-forge" style="font-weight:bold">開始自動鍛造</button></div>
      <div class="hint">「加入」：這個角色以後都用上面的類型與配方（名稱沒填的用上面的名稱），閒著就開爐，鍛造欄位自動找空的；佇列在「自動鍛造」頁。「鍛一次」：只用它鍛一爐，送出前再確認。狩獵隊伍的角色不會被拿去鍛造</div>
      <div class="row"><button data-action="material-refresh">更新裝備資料</button></div>
    </div>

    <div data-tab="income">
      <label class="row"><input data-field="incomeEnabled" type="checkbox" style="flex:none;width:auto"> 記錄經驗、道具與遊戲幣收益</label>
      <div class="row">道具明細看<select data-role="income-period" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="0">近 1 小時</option><option value="1">近 6 小時</option><option value="2">今天</option><option value="3">近 24 小時</option><option value="4">近 7 天</option></select></div>
      <div data-role="income" style="font-size:12px"></div>
    </div>

    <div data-tab="huntStats">
      <label class="row"><input data-field="huntStatsEnabled" type="checkbox" style="flex:none;width:auto"> 記錄每層的經驗、耗損、前進與掉落</label>
      <div class="row"><select data-role="hunt-stats-place" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select><button data-action="hunt-stats-clear">清除統計</button></div>
      <div data-role="hunt-stats" style="font-size:12px"></div>
      <div class="subhead">誰拿到什麼（戰報有寫是誰的）</div>
      <div class="row"><select data-role="actor-loot-period" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="1">今天</option><option value="7">近 7 天</option><option value="14">近 14 天</option></select></div>
      <div data-role="actor-loot" style="font-size:12px"></div>
    </div>

    <div data-tab="cloud">
      <div class="hint">把成長值與鍛造材料紀錄傳到 Google 試算表，跟朋友共用；設定方法看使用說明「雲端共用」。只傳自己的，同一筆不會重複</div>
      <label class="row"><input data-field="cloudSyncEnabled" type="checkbox" style="flex:none;width:auto"> 啟用雲端同步（每 10 分鐘）</label>
      <div class="row">網址<input data-field="cloudUrl" placeholder="留空＝用內建的共用試算表"></div>
      <div class="row">署名<input data-field="cloudName" placeholder="試算表上顯示是誰傳的"></div>
      <div class="row"><span data-role="cloud-status" class="hint" style="flex:1"></span><button data-action="cloud-sync-now">立即同步</button></div>
    </div>

    <div data-tab="transfer">
      <div class="hint">用拍賣在自己的帳號之間轉移：這邊按下去後，另一個帳號會自動掛單或買下。兩個帳號的遊戲分頁都要開著、「總覽」回報要打開、中繼站要開著。防搶：買方先待命（每 0.5 秒查拍賣），確定待命了才掛單，一出現就買；掛單留言放一組暗號，買方核對賣家、價格、暗號都對才買</div>
      <div class="row">對象帳號<select data-role="transfer-target" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select><button data-action="transfer-refresh">重新讀取</button></div>
      <div class="row">或輸入對方帳號 ID<input data-role="transfer-target-id" type="number" min="1" placeholder="對方面板上看得到" style="width:110px;flex:none"></div>
      <div class="hint" data-role="transfer-me"></div>
      <div class="row">多開輪流時轉移<select data-field="transferTurnMode" style="flex:none;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="human">優先＋模擬真人</option><option value="fast">優先＋最快</option></select></div>
      <div class="hint">（主流程勾了「多開輪流」才有用）兩個帳號都在中繼站上轉移時，所有帳號的掛機、鍛造請求先停著，只讓轉移的兩邊動作，做完自動接著跑。模擬真人：兩個視窗之間切換隔 0.6～1.5 秒，掛單到買下約 1～3 秒；最快：不隔，約 1 秒內</div>
      <fieldset class="group">
        <legend>轉金幣給對方</legend>
        <div class="row">金額 <input data-role="transfer-amount" type="number" min="1" style="width:100px;flex:none"> <button data-action="transfer-money" style="font-weight:bold">轉出</button></div>
        <div class="row">對方掛單用的材料<input data-field="transferMine" placeholder="泥土" style="width:80px;flex:none"> ×1</div>
        <div class="hint">做法：請對方把 1 個材料掛成這個價格，這個帳號再買下。拍賣沒有手續費，金額全部到對方；別人不會花大錢買 1 個泥土，不怕被搶</div>
        <label class="row"><input data-field="transferCloudEnabled" type="checkbox" style="flex:none;width:auto"> 接受雲端轉帳（每 30 秒看一次雲端有沒有要這個帳號掛單）</label>
        <div class="hint">對方在中繼站上就直接傳（幾秒）；不在（例如在別台電腦）就透過雲端試算表慢慢傳：收錢那邊要勾上面這格，約 30～60 秒掛單，這邊最多等 3 分鐘、掛上就買</div>
      </fieldset>
      <fieldset class="group">
        <legend>轉角色給對方</legend>
        <div class="row"><select data-role="transfer-hero" style="flex:1;min-width:0;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select></div>
        <div class="row">免問的帳號 ID<input data-field="transferTrustedIds" placeholder="自己的其他帳號，逗號分隔" style="flex:1;min-width:0"></div>
        <div class="row">價格 <input data-role="transfer-hero-price" type="number" min="1" style="width:100px;flex:none"> <button data-action="transfer-hero" style="font-weight:bold">掛單並讓對方買</button></div>
        <div class="hint">價格是對方要付的錢（會轉到這個帳號）。按下去會先跳確認；對方沒待命就不掛單，掛上去 20 秒內沒被買走會自動撤回。對方不在中繼站上就走雲端：對方要勾「接受雲端轉帳」，兩邊的掛機、鍛造先停下來等（最多約 2.5 分鐘），完成後自動恢復。收到雲端轉角色會跳視窗問要不要接受（要付錢），80 秒沒按就拒絕；「免問的帳號 ID」填自己的其他帳號就不用每次按</div>
      </fieldset>
      <div data-role="transfer-log" class="hint"></div>
    </div>

    <div data-tab="draw">
      <div class="hint">在遊戲物品頁用英雄券這類道具抽卡時自動記下抽到什麼（這個瀏覽器、這個帳號自己的紀錄）</div>
      <div class="row"><select data-role="draw-item" style="flex:1;min-width:0;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"></select><button data-action="draw-clear">清除紀錄</button></div>
      <div data-role="draw-stats"></div>
    </div>

    <div data-tab="cardBuy">
      <div class="row"><label style="flex:1"><input data-field="cardBuyEnabled" type="checkbox" style="width:auto"> <b>看拍賣場英雄</b></label><select data-field="cardWatchMode" style="flex:none;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="passive">被動（不多發請求）</option><option value="active">主動查（搶卡用）</option></select></div>
      <div class="hint">被動：你在遊戲開拍賣場的英雄頁、切回這個視窗，或停在人口販子頁時，遊戲抓到清單就順便比對，伺服器看到的跟一般玩家一樣。主動：自己去查，要搶卡時才開</div>
      <div class="hint">操作：<span data-role="card-buy-log"></span></div>
      <fieldset class="group">
        <legend>主動查（選「主動查」時才用）</legend>
        <div class="row">每 <input data-field="cardBuyIntervalSeconds" type="number" min="10" style="width:50px;flex:none"> ～ <input data-field="cardBuyIntervalMaxSeconds" type="number" min="10" style="width:50px;flex:none"> 秒查一次</div>
        <div class="hint">像人刷商店：間隔大多靠近短的、偶爾拉長；連查 3～8 次後休息 5～20 分鐘</div>
        <div class="row">只在 <input data-field="cardActiveHours" placeholder="留空＝整天" style="width:110px;flex:none"> 點查（例：8-24、20-2）</div>
        <div class="row">開 <input data-field="cardActiveMinutes" type="number" min="0" style="width:50px;flex:none"> 分鐘後自動切回被動（0＝不切）</div>
        <div class="row"><span data-role="card-buy-next" class="hint" style="flex:1"></span><button data-action="card-buy-check-now" title="不管模式和間隔，馬上查一次">立即查</button></div>
      </fieldset>
      <fieldset class="group">
        <legend>要找的卡（每行一條）</legend>
        <input type="hidden" data-field="cardBuyRules">
        <div data-role="card-rules"></div>
        <datalist id="autoClickerCardTypes"></datalist>
        <div class="row"><button data-action="card-rule-add">＋ 新增一張要找的卡</button></div>
        <div class="hint">卡片名稱是卡片種類（例如房東阿姨），不是玩家取的名字；打字時會列出看過的卡。空著的條件＝不限，等級兩格填一樣＝剛好那一級。沒填價格的只提醒；勾「只提醒不買」的開了自動購買也不買</div>
      </fieldset>
      <fieldset class="group">
        <legend>提醒</legend>
        <div class="hint">沒開自動購買時，符合的卡都只跳提醒。同一張掛單只提醒一次（降價會再提醒）</div>
        <label class="row"><input data-field="cardReleasedEnabled" type="checkbox" style="flex:none;width:auto"> 人口販子開放時也一起看（只提醒，不買）</label>
        <div class="row">提醒方式<select data-field="cardAlertStyle" style="flex:1;min-width:0;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"><option value="toast">右下角小提示＋系統通知（不打斷）</option><option value="popup">照「提醒」頁設定（彈窗、聲音、紅框）</option></select></div>
        <div class="row"><b style="flex:1">提醒紀錄</b><button data-action="card-notified-reset" title="提醒過的掛單下一輪會再叫一次">讓提醒過的再叫</button><button data-action="card-alert-history-clear">清空</button></div>
        <div data-role="card-alert-history" class="hint" style="max-height:140px;overflow-y:auto;border:1px solid #44444c;border-radius:5px;padding:4px"></div>
      </fieldset>
      <fieldset class="group">
        <legend>自動購買（會花錢）</legend>
        <label class="row"><input data-field="cardAutoBuyEnabled" type="checkbox" style="flex:none;width:auto"> <b>符合又有寫價格上限的卡直接買</b></label>
        <label class="row"><input data-field="cardNotifyOverPrice" type="checkbox" style="flex:none;width:auto"> 價格太高的也提醒（卡一出現就說一聲，低於價格才買）</label>
        <div class="row">總預算 <input data-field="cardBuyBudget" type="number" min="0" style="width:100px;flex:none"> 最多買 <input data-field="cardBuyMaxCount" type="number" min="1" style="width:50px;flex:none"> 張</div>
        <div class="row">不買這些賣家 ID<input data-field="cardBuyExcludeSellerIds" placeholder="逗號分隔" style="flex:1;min-width:0"></div>
        <div class="row"><span data-role="card-buy-status" class="hint" style="flex:1"></span><button data-action="card-buy-reset" title="已花的錢和已買張數歸零">重設已買紀錄</button></div>
        <div class="hint">從最便宜的開始買；預算或張數用完後，符合的改成提醒並寫出原因。買失敗（被搶走、角色欄滿了、錢不夠、逾時不確定有沒有買到）只關掉這格，提醒照常。自己的帳號、「轉移」頁免問的帳號、帶轉移暗號的掛單都不算</div>
      </fieldset>
      <div class="hint">遇到活人驗證會整個關掉並提醒。同一個帳號開好幾個分頁時只有一個分頁會查</div>
    </div>

    <div data-tab="backup">
      <div>把目前所有設定匯出，到其他瀏覽器或電腦再匯入。</div>
      <div class="row"><button data-action="export-file">匯出成檔案</button><button data-action="export-copy">複製到剪貼簿</button></div>
      <div class="row"><button data-action="import-file">從檔案匯入</button><input data-role="import-file" type="file" accept=".json,application/json" style="display:none"></div>
      <textarea data-role="import-text" rows="4" placeholder="或把複製的設定貼在這裡" style="width:100%;box-sizing:border-box;font:11px monospace"></textarea>
      <div class="row"><button data-action="import-text">匯入貼上的設定</button></div>
    </div>

    <div data-tab="log">
      <pre data-role="log" style="margin:0;max-height:260px;overflow:auto;font:11px monospace;white-space:pre-wrap"></pre>
      <div class="row" style="margin-top:8px"><b style="flex:1">吃藥／換裝紀錄（API，新的在上面）</b>
        <button data-action="item-log-copy">複製</button><button data-action="item-log-clear">清除</button></div>
      <textarea data-role="item-log" readonly rows="10" style="width:100%;box-sizing:border-box;font:11px monospace"></textarea>
      <fieldset class="group">
        <legend>角色成長值</legend>
        <label class="row"><input data-field="growthEnabled" type="checkbox" style="flex:none;width:auto"> 記錄升級成長值，顯示在角色屬性頁</label>
        <div class="hint">原本的「角色成長值紀錄」腳本請停用，不然會顯示兩次。舊紀錄：Tampermonkey 打開那支腳本 →「儲存空間」分頁（設定模式要選「進階」才看得到）→ 全選複製貼到下面</div>
        <textarea data-role="growth-import" rows="3" placeholder='{"hero_index":[...],"hero_123_history":[...]}' style="width:100%;box-sizing:border-box;font:11px monospace"></textarea>
        <div class="row"><button data-action="growth-import">匯入舊紀錄</button></div>
      </fieldset>
    </div>

    <div data-tab="api">
      <div class="hint">按「開始錄製」→ 手動替一位角色開道具欄、按使用、關掉 → 按「停止錄製」→「複製」貼出來分析。只在錄製中記錄；token、密碼這類欄位會自動遮掉</div>
      <div class="row"><button data-action="api-record">開始錄製</button><button data-action="api-copy">複製</button><button data-action="api-clear">清除</button></div>
      <textarea data-role="api-log" readonly rows="12" style="width:100%;box-sizing:border-box;font:11px monospace"></textarea>
    </div>
    </div>
  `;
  Object.assign(panel.style, {
    position: 'fixed', top: '20px', right: '20px', zIndex: 2147483647,
    background: '#1b1b1f', color: '#fff', border: '1px solid #3a3a40', borderRadius: '12px',
    padding: '12px', width: '300px', font: '13px/1.5 sans-serif',
    maxHeight: '90vh', overflowY: 'auto',
    boxShadow: '0 6px 20px rgba(0,0,0,.5)',
  });
  // 黑底白字；提示視窗也掛 data-auto-clicker，按鈕樣式共用
  const style = document.createElement('style');
  style.textContent = `
    [data-auto-clicker] .row { display:flex; gap:6px; align-items:center; margin:5px 0; }
    [data-auto-clicker] label:not(.row) { display:block; margin:5px 0; }
    [data-auto-clicker] input, [data-auto-clicker] textarea {
      flex:1; min-width:0; padding:3px 5px; font:12px monospace; color:#fff;
      background:#2a2a30; border:1px solid #44444c; border-radius:5px; }
    [data-auto-clicker] input::placeholder, [data-auto-clicker] textarea::placeholder { color:#7d7d86; }
    [data-auto-clicker] input[type="checkbox"] { accent-color:#fff; }
    [data-auto-clicker] input[type="range"] { accent-color:#fff; background:transparent; border:none; }
    [data-auto-clicker] button {
      padding:3px 9px; cursor:pointer; font-size:12px; color:#fff; background:#3a3a42;
      border:1px solid #4a4a52; border-radius:5px; }
    [data-auto-clicker] button:hover { background:#4a4a54; }
    [data-auto-clicker] .tab-groups { display:flex; gap:4px; margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid #3a3a40; }
    [data-auto-clicker] .tab-groups button { flex:1; padding:4px 0; color:#ccc; background:#1f1f24; border-color:#3a3a40; font-weight:bold; }
    [data-auto-clicker] .tab-groups button[data-active] { background:#3b82f6; color:#fff; border-color:#3b82f6; }
    [data-auto-clicker] .tabs { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px; }
    [data-auto-clicker] .tabs button { padding:2px 8px; color:#fff; background:#2a2a30; border-color:#3a3a40; }
    [data-auto-clicker] .tabs button:hover { background:#3a3a42; }
    [data-auto-clicker] .tabs button[data-active] { background:#fff; color:#111; border-color:#fff; font-weight:bold; }
    [data-auto-clicker] fieldset.group { border:1px solid #3a3a40; border-radius:8px; margin:8px 0; padding:4px 8px 8px; }
    [data-auto-clicker] fieldset.group legend { font-weight:bold; padding:0 4px; cursor:pointer; user-select:none; }
    [data-auto-clicker] fieldset.group > legend::before { content:'▾ '; color:#7a7a84; }
    [data-auto-clicker] fieldset.group.folded > legend::before { content:'▸ '; }
    [data-auto-clicker] fieldset.group.folded { padding-bottom:0; }
    [data-auto-clicker] fieldset.group fieldset.group { margin:6px 0; padding:2px 6px 6px; }
    [data-auto-clicker] fieldset.group.folded > :not(legend) { display:none !important; }
    [data-auto-clicker] .hint { font-size:12px; color:#a0a0aa; margin:3px 0; }
    [data-auto-clicker] .global-row { font-size:12px; color:#a0a0aa; }
    [data-auto-clicker] .global-row button[data-current="run"] { background:#2e7d32; border-color:#2e7d32; color:#fff; font-weight:bold; }
    [data-auto-clicker] .global-row button[data-current="temp"] { background:#e65100; border-color:#e65100; color:#fff; font-weight:bold; }
    [data-auto-clicker] .global-row button[data-low-current] { background:#2e7d32; border-color:#2e7d32; color:#fff; font-weight:bold; }
    [data-auto-clicker] .global-row button[data-current="stop"] { background:#c62828; border-color:#c62828; color:#fff; font-weight:bold; }
    [data-auto-clicker] .hint.fold { cursor:pointer; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:1; overflow:hidden; }
    [data-auto-clicker] .hint.fold::before { content:'▸ '; color:#7a7a84; }
    [data-auto-clicker] .hint.fold.open { display:block; }
    [data-auto-clicker] .hint.fold.open::before { content:'▾ '; }
    [data-auto-clicker] .subhead { font-weight:bold; font-size:12px; margin:8px 0 2px; border-bottom:1px solid #3a3a40; }
    [data-auto-clicker] .choices { font-size:12px; max-height:140px; overflow:auto; }
    [data-auto-clicker] .choices label { margin:2px 0; }
    [data-auto-clicker] .divider { border:none; border-top:1px solid #3a3a40; margin:10px 0 8px; }
    [data-auto-clicker] .monitor { margin-top:4px; padding:4px 6px; font:12px monospace; white-space:pre-line;
      background:#111114; border-radius:6px; }
    [data-auto-clicker] pre[data-role="log"] { background:#111114; border-radius:6px; padding:4px 6px; }
    [data-auto-clicker] table.combat { width:100%; border-collapse:collapse; font:11px monospace; margin:4px 0; }
    [data-auto-clicker] table.combat th, [data-auto-clicker] table.combat td { padding:1px 3px; text-align:right; border-bottom:1px solid #2e2e34; }
    [data-auto-clicker] table.combat th:first-child, [data-auto-clicker] table.combat td:first-child { text-align:left; }
    [data-auto-clicker][data-alerting] { background:#c62828 !important; border:3px solid #ffe066 !important; }
    .auto-clicker-hover { outline: 3px solid #e33 !important; }
  `;
  panel.setAttribute('data-auto-clicker', '');
  document.head.appendChild(style);
  document.body.appendChild(panel);

  // 長說明一多，「開始」被擠到很下面：預設只露第一行，點一下展開、再點收起。
  // 只收建立面板時寫死的說明；有 data-role 的是會變的狀態文字，要一直看得到
  const HINT_FOLD_MIN_LENGTH = 30;
  panel.querySelectorAll('.hint:not([data-role])').forEach((hint) => {
    if (hint.closest('.choices') || hint.textContent.trim().length < HINT_FOLD_MIN_LENGTH) return;
    hint.classList.add('fold');
    hint.title = '點一下展開／收起';
  });
  // 區塊點標題收起／展開；每個區塊的開關記在這台瀏覽器，重整後照舊
  const FOLDED_GROUPS_KEY = 'autoClickerV2FoldedGroups';
  const foldedGroups = readJsonStorage(FOLDED_GROUPS_KEY, {});
  panel.querySelectorAll('fieldset.group').forEach((group) => {
    const legend = group.querySelector(':scope > legend');
    if (!legend) return;
    const key = legend.textContent.trim();
    const folded = key in foldedGroups ? foldedGroups[key] : group.dataset.fold === 'closed';
    group.classList.toggle('folded', folded);
    legend.title = '點一下收起／展開';
    legend.addEventListener('click', () => {
      foldedGroups[key] = group.classList.toggle('folded');
      try {
        localStorage.setItem(FOLDED_GROUPS_KEY, JSON.stringify(foldedGroups));
      } catch {
        // 記不住就只影響這次
      }
    });
  });
  panel.addEventListener('click', (event) => {
    const hint = event.target.closest('.hint.fold');
    if (!hint || event.target.closest('button, input, select, a, label')) return;
    hint.classList.toggle('open');
  });

  const alertDialog = document.createElement('div');
  alertDialog.setAttribute('data-auto-clicker', '');
  alertDialog.innerHTML = `
    <div data-role="alert-title" style="font-weight:bold;font-size:18px;color:#c00">⚠ 愛吉吉已暫停</div>
    <div data-role="alert-message" style="margin:12px 0;font-size:14px"></div>
    <button data-action="dismiss-alert">知道了</button>
  `;
  Object.assign(alertDialog.style, {
    display: 'none', position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    zIndex: 2147483647, background: '#fff', color: '#222', border: '3px solid #e00', borderRadius: '10px',
    padding: '18px 22px', minWidth: '280px', font: '13px sans-serif', textAlign: 'center',
    boxShadow: '0 8px 30px rgba(0,0,0,.4)',
  });
  document.body.appendChild(alertDialog);
  alertDialog.addEventListener('click', (event) => {
    if (event.target.dataset.action === 'dismiss-alert') clearAlert();
  });

  // 不打斷人的提醒：右下角疊幾個小框，過一陣子自己消失
  const toastBox = document.createElement('div');
  toastBox.setAttribute('data-auto-clicker', '');
  Object.assign(toastBox.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647, display: 'flex',
    flexDirection: 'column', gap: '6px', maxWidth: '340px', font: '13px sans-serif',
  });
  document.body.appendChild(toastBox);

  // 瀏覽器內建的 confirm 開著時整個分頁的程式都會停住（掛機、鍛造跟著卡），執行中要問的事改用這個
  const confirmDialog = document.createElement('div');
  confirmDialog.setAttribute('data-auto-clicker', '');
  confirmDialog.innerHTML = `
    <div data-role="confirm-message" style="white-space:pre-line;margin:0 0 14px;font-size:14px;text-align:left"></div>
    <button data-confirm="yes" style="font-weight:bold;margin-right:8px">確定</button><button data-confirm="no">取消</button>
  `;
  Object.assign(confirmDialog.style, {
    display: 'none', position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    zIndex: 2147483647, background: '#fff', color: '#222', border: '3px solid #3b82f6', borderRadius: '10px',
    padding: '18px 22px', minWidth: '300px', maxWidth: '420px', font: '13px sans-serif', textAlign: 'center',
    boxShadow: '0 8px 30px rgba(0,0,0,.4)',
  });
  document.body.appendChild(confirmDialog);
  let resolveConfirm = null;
  confirmDialog.addEventListener('click', (event) => {
    if (!event.target.dataset.confirm || !resolveConfirm) return;
    confirmDialog.style.display = 'none';
    resolveConfirm(event.target.dataset.confirm === 'yes');
    resolveConfirm = null;
  });

  function askConfirm(message, timeoutMilliseconds = 0) {
    // 上一個還沒回答就當作取消
    if (resolveConfirm) resolveConfirm(false);
    confirmDialog.querySelector('[data-role="confirm-message"]').textContent = message;
    confirmDialog.style.display = 'block';
    return new Promise((resolve) => {
      resolveConfirm = resolve;
      if (!timeoutMilliseconds) return;
      backgroundTimer.setTimeout(() => {
        if (resolveConfirm !== resolve) return;
        confirmDialog.style.display = 'none';
        resolveConfirm = null;
        resolve(false);
      }, timeoutMilliseconds);
    });
  }

  const MINIMIZED_STORAGE_KEY = 'autoClickerV2Minimized';
  const panelBody = panel.querySelector('[data-role="body"]');
  const miniStatusElement = panel.querySelector('[data-role="mini-status"]');

  // 縮到最小只留標題列，標題列上顯示執行狀態，不用展開也知道有沒有在跑
  function setMinimized(minimized) {
    panelBody.style.display = minimized ? 'none' : '';
    panel.style.width = minimized ? 'auto' : '290px';
    panel.querySelector('[data-action="minimize"]').textContent = minimized ? '▢' : '–';
    updateMiniStatus();
    try {
      localStorage.setItem(MINIMIZED_STORAGE_KEY, minimized ? '1' : '');
    } catch {
      // 記不住縮小狀態不影響使用
    }
  }

  function updateMiniStatus() {
    const minimized = panelBody.style.display === 'none';
    miniStatusElement.textContent = minimized ? (state.running ? '· 執行中' : '· 已停止') : '';
  }

  function showCharacter(characterIndex) {
    panel.querySelectorAll('[data-character]').forEach((section) => {
      section.style.display = Number(section.dataset.character) === characterIndex ? '' : 'none';
    });
    panel.querySelectorAll('[data-character-button]').forEach((button) => {
      button.toggleAttribute('data-active', Number(button.dataset.characterButton) === characterIndex);
    });
  }

  // 每個瀏覽器分頁各自記目前看的是哪一頁，停著時監控區用來決定顯示鍛造體力還是血條
  let activeTab = 'main';

  function showTab(tabId) {
    activeTab = tabId;
    const group = tabGroupOf(tabId);
    if (tabId === 'growth') renderGrowthSummary();
    if (tabId === 'material' || tabId === 'recipe') {
      // 測名表過一陣子才重抓；抓到新的再重畫
      refreshNameWeights()
        .then(() => {
          if (activeTab === 'material') renderMaterialSummary();
          if (activeTab === 'recipe') renderRecipes();
        })
        .catch((error) => setStatus(`讀取測名表失敗（${error.message}）`));
    }
    if (tabId === 'material') renderMaterialSummary();
    if (tabId === 'recipe') {
      renderRecipes();
      renderRecipePicker();
      // 第一次開配方頁就順便讀材料庫存
      if (Date.now() - mineStockAt > MINE_STOCK_FRESH_MILLISECONDS) {
        refreshMineStock()
          .then(() => {
            renderRecipePicker();
            renderRecipes();
          })
          .catch(() => {});
      }
      renderRecipeHeroes();
      refreshForgeHeroes().catch((error) => setStatus(`讀取角色失敗（${error.message}）`));
    }
    if (tabId === 'huntStats') {
      renderHuntStats();
      renderActorLoot();
    }
    if (tabId === 'income') renderIncome();
    if (tabId === 'draw') renderDrawStats();
    if (tabId === 'forge') {
      renderForgePlanOverview();
      if (Date.now() - mineStockAt > MINE_STOCK_FRESH_MILLISECONDS) refreshMineStock().then(renderForgePlanOverview).catch(() => {});
      refreshForgeHeroes().catch((error) => setStatus(`讀取角色失敗（${error.message}）`));
    }
    if (tabId === 'mining') {
      renderMiningHeroes();
      if (!miningPotionItems) loadMiningPotions();
      if (Date.now() - loadMining().heroesAt > 60000) readMiningHeroes(readSettingsFromPanel()).catch((error) => miningLog(`讀取角色失敗（${error.message}）`));
    }
    if (tabId === 'transfer') refreshTransferChoices(readSettingsFromPanel()).catch((error) => transferLog(`讀取帳號或角色失敗（${error.message}）`));
    panel.querySelectorAll('[data-tab]').forEach((section) => {
      section.style.display = section.dataset.tab === tabId ? '' : 'none';
    });
    panel.querySelectorAll('[data-tab-button]').forEach((button) => {
      button.toggleAttribute('data-active', button.dataset.tabButton === tabId);
      button.style.display = button.dataset.group === group ? '' : 'none';
    });
    panel.querySelectorAll('[data-tab-group]').forEach((button) => {
      button.toggleAttribute('data-active', button.dataset.tabGroup === group);
    });
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tabId);
      const groupTabs = JSON.parse(localStorage.getItem(GROUP_TABS_STORAGE_KEY) || '{}');
      groupTabs[group] = tabId;
      localStorage.setItem(GROUP_TABS_STORAGE_KEY, JSON.stringify(groupTabs));
    } catch {
      // 記不住分頁不影響使用
    }
  }

  function showTabGroup(group) {
    let tabId = null;
    try {
      tabId = JSON.parse(localStorage.getItem(GROUP_TABS_STORAGE_KEY) || '{}')[group];
    } catch {
      // 記不住就開第一個
    }
    const [, , tabIds] = TAB_GROUPS.find(([id]) => id === group);
    showTab(tabIds.includes(tabId) ? tabId : tabIds[0]);
  }

  const statusElement = panel.querySelector('[data-role="status"]');
  const monitorElement = panel.querySelector('[data-role="monitor"]');
  const logElement = panel.querySelector('[data-role="log"]');
  const fieldElements = panel.querySelectorAll('[data-field]');

  function readSettingsFromPanel() {
    const settings = {};
    fieldElements.forEach((input) => {
      const key = input.dataset.field;
      if (input.type === 'checkbox') settings[key] = input.checked;
      else if (input.type === 'number' || input.type === 'range') settings[key] = Math.max(Number(input.min), Number(input.value) || 0);
      else settings[key] = input.value.trim();
    });
    return settings;
  }

  function writeSettingsToPanel(settings) {
    fieldElements.forEach((input) => {
      const key = input.dataset.field;
      if (input.type === 'checkbox') input.checked = settings[key];
      else setFieldValue(input, settings[key]);
    });
    renderCardRules();
  }

  // 下拉選單的選項是之後才填的（例如區域表），先放一個同名選項，值才不會被丟掉
  function setFieldValue(input, value) {
    if (input.tagName === 'SELECT' && value !== '' && value !== undefined && ![...input.options].some((option) => option.value === String(value))) {
      input.add(new Option(String(value), String(value)));
    }
    input.value = value;
  }

  // 偶發問題（例如誤判沒道具）只看當下狀態列抓不到，留一段歷史方便事後對照
  const logLines = [];

  function setStatus(text) {
    statusElement.textContent = text;
    const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    logLines.unshift(`${time} ${text}`);
    logLines.length = Math.min(logLines.length, LOG_LIMIT);
    logElement.textContent = logLines.join('\n');
  }

  function clickBySelector(selector) {
    const element = document.querySelector(selector);
    if (!element) return false;
    element.click();
    return true;
  }

  // element.click() 只送出 click 事件；有些彈窗的 X 或「點外面關閉」是聽 pointerdown/mousedown，
  // 所以關閉道具介面時改送完整的按下→放開→click 序列
  function simulateFullClick(element, clientX, clientY) {
    const init = { bubbles: true, cancelable: true, view: window, button: 0, clientX, clientY };
    const pointerInit = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    element.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    element.dispatchEvent(new MouseEvent('mousedown', init));
    element.dispatchEvent(new PointerEvent('pointerup', pointerInit));
    element.dispatchEvent(new MouseEvent('mouseup', init));
    element.dispatchEvent(new MouseEvent('click', init));
  }

  // 有設定 X 且找得到就點 X；否則送 Esc 再點畫面左上角空白處，多數彈窗都會因此關閉。
  // 回傳是否用了備援方式，方便在狀態列提示
  function closeItemMenu(closeSelector) {
    let closeButton = null;
    try {
      closeButton = closeSelector ? document.querySelector(closeSelector) : null;
    } catch {
      // selector 格式錯誤就當作找不到
    }
    if (closeButton) {
      const rect = closeButton.getBoundingClientRect();
      simulateFullClick(closeButton, rect.left + rect.width / 2, rect.top + rect.height / 2);
      return false;
    }
    const escapeInit = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true };
    const focused = document.activeElement || document.body;
    focused.dispatchEvent(new KeyboardEvent('keydown', escapeInit));
    focused.dispatchEvent(new KeyboardEvent('keyup', escapeInit));
    simulateFullClick(document.body, 1, 1);
    return true;
  }

  // 逐個 selector 分開查，才能保留「加入」的順序（querySelectorAll 會改成文件順序）；
  // 跳脫過的 \, 屬於 id 本身，不能當分隔符
  function splitSelectors(selectors) {
    return selectors
      .split(/(?<!\\),/)
      .map((selector) => selector.trim())
      .filter(Boolean);
  }

  function readPercent(selector) {
    let element;
    try {
      element = document.querySelector(selector);
    } catch {
      return null;
    }
    return element ? parsePercent(element.textContent) : null;
  }

  // 優先讀「709 / 744」；沒有斜線格式時改讀「45.3%」（經驗條常見）
  function parsePercent(text) {
    const ratio = text.match(RATIO_PATTERN);
    if (ratio) {
      const current = Number(ratio[1].replace(/,/g, ''));
      const maximum = Number(ratio[2].replace(/,/g, ''));
      return maximum > 0 ? (current / maximum) * 100 : null;
    }
    const percent = text.match(PERCENT_PATTERN);
    return percent ? Number(percent[1]) : null;
  }

  // 沒設定數值條的列回傳 undefined，讀不到數字的回傳 null
  // 填了 heroId 而且有 /api/huntInfo 資料時用 API 的數值，畫面沒刷新也不會誤判；沒有才讀數值條
  function readSlotPercent(settings, groupId, index) {
    const group = SUPPLY_GROUPS.find((candidate) => candidate.id === groupId);
    const hero = usesItemApi(settings, group, index) && state.heroStats.get(heroIdForSlot(settings, groupId, index));
    if (hero && hero[group.fullField] > 0) return (hero[group.heroField] / hero[group.fullField]) * 100;
    const selector = settings[slotKey(groupId, 'Bar', index)];
    return selector ? readPercent(selector) : undefined;
  }

  function readGroupPercents(settings, groupId) {
    return Array.from({ length: SLOT_COUNT }, (_, index) => readSlotPercent(settings, groupId, index));
  }

  // 依 SUPPLY_GROUPS 順序找第一個需要補給的列，血條優先；鍛造模式只看鍛造體力
  function findSlotNeedingItem(settings, { forge = false } = {}) {
    for (const group of SUPPLY_GROUPS.filter((candidate) => Boolean(candidate.forgeOnly) === forge)) {
      const threshold = settings[groupKey(group.id, 'ThresholdPercent')];
      for (let index = 0; index < SLOT_COUNT; index++) {
        const percent = readSlotPercent(settings, group.id, index);
        const usable =
          (settings[slotKey(group.id, 'Slot', index)] && settings[slotKey(group.id, 'Use', index)]) ||
          usesItemApi(settings, group, index);
        if (typeof percent === 'number' && percent < threshold && usable && !state.itemUsedSlots.has(`${group.id}:${index}`)) {
          return { group, index };
        }
      }
    }
    return null;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => backgroundTimer.setTimeout(resolve, milliseconds));
  }

  // 排序總覽要知道這個分頁下一步大約什麼時候動：掛機每一步、API 鍛造每一輪排下一次時記下來
  const nextTickAt = { hunt: 0, forge: 0 };

  function planTick(run, delay = 0) {
    nextTickAt.hunt = Date.now() + Math.max(0, Number(delay) || 0);
    return backgroundTimer.setTimeout(run, delay);
  }

  function nextActionAt() {
    const times = [];
    if (state.running) times.push(nextTickAt.hunt);
    if (forgeRunner.running) times.push(nextTickAt.forge);
    return times.length ? Math.min(...times) : 0;
  }

  function isVisible(element) {
    return element.getClientRects().length > 0;
  }

  const CLICKABLE_SELECTOR = 'button, a, input[type="button"], [role="button"]';

  // 畫面上可能有很多個「使用」，只比按鈕文字會點到別的道具。
  // 往上找到第一個「除了按鈕還有別的文字」的祖先，通常就是含道具名稱的那一列；
  // 只多了其他按鈕（例如同一格裡的「使用」「使用×10」）的那層不算，否則每列辨識內容都一樣。
  // 去掉數字與空白，數量從 x12 變成 x11 也還認得出來
  function contextAncestor(element) {
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && ancestor !== document.body && depth < 10; depth++) {
      const text = normalizeContext(ancestor.textContent || '');
      const buttonsText = normalizeContext(
        Array.from(ancestor.querySelectorAll(CLICKABLE_SELECTOR))
          .map((button) => button.textContent || '')
          .join('')
      );
      if (text !== buttonsText) return ancestor;
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function buttonContext(element) {
    const ancestor = contextAncestor(element);
    return ancestor ? normalizeContext(ancestor.textContent || '').slice(0, 80) : '';
  }

  // 同名裝備好幾件時辨識內容會一樣（數字被去掉了），挑那一列數字最大的，通常就是耐久最高的那件；
  // 有「目前 / 最大」格式時比目前值，否則比整列最大的數字
  function rowScore(element) {
    const current = rowRatioCurrent(element);
    if (current !== null) return current;
    const text = (contextAncestor(element) || element).textContent || '';
    const numbers = (text.match(/\d+/g) || []).map(Number);
    return numbers.length ? Math.max(...numbers) : 0;
  }

  // 那一列有「目前 / 最大」時回傳目前值（裝備清單上的耐久），沒有就回傳 null
  function rowRatioCurrent(element) {
    const text = (contextAncestor(element) || element).textContent || '';
    const ratio = text.match(RATIO_PATTERN);
    return ratio ? Number(ratio[1].replace(/,/g, '')) : null;
  }

  function normalizeContext(text) {
    return text.replace(/[\d\s,]/g, '');
  }

  // 找不到按鈕時的原因，寫進紀錄方便判斷是介面沒開還是辨識內容有問題
  let lastButtonProblem = '';
  // 找到了但值得記一筆的情況（例如有重複的按鈕），寫進紀錄方便追查
  let lastButtonNote = '';

  // 先用 selector 找，但要確認是同一個道具的按鈕；selector 跑掉（找不到，或指到別的道具）時，
  // 改找文字相同、所在那一列也相同的按鈕。都對不上就回傳 null，寧可不點也不要吃錯道具
  function visibleButtonsWithText(text) {
    return Array.from(document.querySelectorAll(CLICKABLE_SELECTOR)).filter(
      (candidate) => !panel.contains(candidate) && isVisible(candidate) && buttonText(candidate) === text
    );
  }

  // exclude：打開介面前就已經在畫面上的按鈕（關不掉的舊介面）。舊介面的數量不會跟著減少，
  // 按數量挑會一直選到它、點了沒反應；所以有新按鈕時優先排除，全被排除才退回用舊的
  function findButton(selector, text, context, { allowDuplicates = false, exclude = null } = {}) {
    lastButtonProblem = '';
    lastButtonNote = '';
    let element = null;
    try {
      element = selector ? document.querySelector(selector) : null;
    } catch {
      // selector 格式錯誤就當作找不到
    }
    if (!text) return element;
    let sameText = visibleButtonsWithText(text);
    if (exclude && exclude.size) {
      const fresh = sameText.filter((candidate) => !exclude.has(candidate));
      if (fresh.length) sameText = fresh;
    }
    if (!context) {
      // 沒有記錄所在列時：selector 找到的看得到就用；否則畫面上剛好一個同名按鈕才敢用
      if (element && isVisible(element)) return element;
      return (sameText.length === 1 ? sameText[0] : null) || element;
    }
    const sameRow = sameText.filter((candidate) => buttonContext(candidate) === context);
    if (sameRow.length > 1) {
      // 各自在不同列 → 同一種東西出現好幾次（例如藥水分兩疊、舊介面沒關乾淨又開了一個），點哪個都行；
      // 擠在同一個區塊 → 辨識範圍大到整個清單，分不出是哪個道具，寧可不點
      const inDistinctRows = new Set(sameRow.map(contextAncestor)).size === sameRow.length;
      if (allowDuplicates && inDistinctRows) {
        lastButtonNote = `畫面上有 ${sameRow.length} 個相同的按鈕`;
        // 優先數量／耐久最多的；一樣多時選後面的，通常是最新打開的介面
        return sameRow.reduce((best, candidate) => (rowScore(candidate) >= rowScore(best) ? candidate : best));
      }
      lastButtonProblem = inDistinctRows
        ? `有 ${sameRow.length} 個按鈕符合，請重新選取使用按鈕`
        : `辨識範圍太大，分不出是哪個道具，請重新選取使用按鈕`;
      return null;
    }
    if (sameRow.length === 0) {
      lastButtonProblem = sameText.length ? `畫面上有 ${sameText.length} 個「${text}」但沒有符合的道具` : '道具介面沒出現';
      return null;
    }
    return sameRow[0];
  }

  function buttonText(element) {
    return (element.textContent || element.value || '').trim().slice(0, 30);
  }

  // 遊戲回應慢時介面會晚一點才出現，固定等一下就找會誤判成「沒有使用按鈕」，所以輪詢到逾時為止
  async function waitForButton(selector, text, context, timeoutMilliseconds, runId, options) {
    const deadline = Date.now() + timeoutMilliseconds;
    for (;;) {
      const element = findButton(selector, text, context, options);
      if (element && isVisible(element)) return element;
      if (Date.now() >= deadline || runId !== state.runId) return element;
      await wait(100);
    }
  }

  const BUTTON_WAIT_MILLISECONDS = 3000;

  // 耐久可能顯示成「35」或「35 / 100」，後者取目前值
  function readNumber(selector) {
    if (!selector) return null;
    let element;
    try {
      element = document.querySelector(selector);
    } catch {
      return null;
    }
    const text = element ? element.textContent : '';
    const ratio = text.match(RATIO_PATTERN);
    if (ratio) return Number(ratio[1].replace(/,/g, ''));
    const number = text.match(/\d[\d,]*/);
    return number ? Number(number[0].replace(/,/g, '')) : null;
  }

  function findCharacterNeedingEquipment(settings) {
    for (let characterIndex = 0; characterIndex < CHARACTER_COUNT; characterIndex++) {
      const key = (name) => settings[equipKey(characterIndex, name)];
      const hasSpare = Array.from({ length: SPARE_COUNT }, (_, spare) => key(`Wear${spare + 1}`)).some(Boolean);
      if (!key('Enabled') || !key('Open') || !hasSpare || state.equipSkipped.has(characterIndex)) continue;
      const durability = readNumber(key('Durability'));
      if (typeof durability === 'number' && durability < key('Threshold')) return characterIndex;
    }
    return -1;
  }

  // 穿上後畫面要一點時間才更新耐久，輪詢到夠了或逾時，避免把剛穿上的好裝備誤判成失敗又脫掉
  async function waitForDurability(selector, threshold, runId) {
    const deadline = Date.now() + BUTTON_WAIT_MILLISECONDS;
    for (;;) {
      const durability = readNumber(selector);
      if (typeof durability === 'number' && durability >= threshold) return durability;
      if (Date.now() >= deadline || runId !== state.runId) return durability;
      await wait(200);
    }
  }

  async function swapEquipment(settings, characterIndex) {
    const runId = state.runId;
    const key = (name) => settings[equipKey(characterIndex, name)];
    const label = `第 ${characterIndex + 1} 位角色換裝`;
    const threshold = key('Threshold');
    const stepMilliseconds = settings.itemStepSeconds * 1000;
    const startDurability = readNumber(key('Durability'));

    const openButton = await waitForButton(key('Open'), key('OpenText'), '', BUTTON_WAIT_MILLISECONDS, runId);
    if (runId !== state.runId) return;
    if (!openButton) {
      state.equipSkipped.add(characterIndex);
      setStatus(`${label}：找不到裝備欄，本輪略過`);
      scheduleNext(settings);
      return;
    }
    openButton.click();
    setStatus(`${label}：耐久 ${startDurability} 低於 ${threshold}，打開裝備欄`);
    await wait(stepMilliseconds);
    if (runId !== state.runId) return;

    let newDurability = null;
    const failures = [];
    let isFirstAttempt = true;
    for (let spare = 1; spare <= SPARE_COUNT; spare++) {
      const wearSelector = key(`Wear${spare}`);
      if (!wearSelector) continue;
      const findWearButton = () =>
        waitForButton(wearSelector, key(`Wear${spare}Text`), key(`Wear${spare}Context`), BUTTON_WAIT_MILLISECONDS, runId, {
          allowDuplicates: true,
        });
      // 先確認備用裝備在、而且那一列顯示的耐久夠，才脫下身上的；
      // 否則全部備用都不能用時，角色會被脫到沒裝備
      let wearButton = await findWearButton();
      if (runId !== state.runId) return;
      if (!wearButton || !isVisible(wearButton)) {
        failures.push(`備用${spare}找不到`);
        continue;
      }
      const listedDurability = rowRatioCurrent(wearButton);
      if (listedDurability !== null && listedDurability < threshold) {
        failures.push(`備用${spare}耐久只剩 ${listedDurability}`);
        continue;
      }
      // 身上有裝備就先脫下；前一件備用試穿失敗時身上就是那件，也要先脫掉
      const removeButton = isFirstAttempt
        ? await waitForButton(key('Remove'), key('RemoveText'), '', BUTTON_WAIT_MILLISECONDS, runId)
        : findButton(key('Remove'), key('RemoveText'), '');
      if (runId !== state.runId) return;
      isFirstAttempt = false;
      if (removeButton && isVisible(removeButton)) {
        removeButton.click();
        setStatus(`${label}：已脫下裝備`);
        await wait(stepMilliseconds);
        if (runId !== state.runId) return;
        // 脫下後介面通常會重畫，要重新找一次穿上按鈕
        wearButton = await findWearButton();
        if (runId !== state.runId) return;
        if (!wearButton || !isVisible(wearButton)) {
          failures.push(`備用${spare}脫下後找不到`);
          continue;
        }
      }
      wearButton.click();
      setStatus(`${label}：穿上備用${spare}`);
      const durability = await waitForDurability(key('Durability'), threshold, runId);
      if (runId !== state.runId) return;
      if (typeof durability === 'number' && durability >= threshold) {
        newDurability = durability;
        break;
      }
      failures.push(`備用${spare}耐久 ${durability ?? '?'}`);
    }

    const usedFallback = closeItemMenu(key('Close'));
    const closeNote = usedFallback && key('Close') ? '（找不到 X，改用 Esc＋點空白處關閉）' : '';
    await wait(stepMilliseconds);
    if (runId !== state.runId) return;

    if (newDurability !== null) {
      setStatus(`${label}完成：耐久 ${startDurability} → ${newDurability}${closeNote}`);
    } else if (key('PauseWhenEmpty')) {
      pauseWithAlert(`${label}失敗，沒有可用的備用裝備（${failures.join('，') || '沒有設定備用裝備'}）`);
      return;
    } else {
      state.equipSkipped.add(characterIndex);
      setStatus(`${label}失敗，本輪略過（${failures.join('，')}）${closeNote}`);
    }
    scheduleNext(settings);
  }

  // 所有補給列登記的使用按鈕裡現在看得到的；有就代表某個角色的道具介面還開著。
  // 沒記到所在列的不算，否則頁面上任何一個「使用」都會被當成介面沒關
  function openItemUseButtons(settings) {
    const found = new Set();
    SUPPLY_GROUPS.forEach((group) => {
      for (let index = 0; index < SLOT_COUNT; index++) {
        const useKey = slotKey(group.id, 'Use', index);
        const text = settings[`${useKey}Text`];
        const context = settings[`${useKey}Context`];
        if (!text || !context) continue;
        visibleButtonsWithText(text)
          .filter((candidate) => buttonContext(candidate) === context)
          .forEach((candidate) => found.add(candidate));
      }
    });
    return found;
  }

  function findCloseButton(settings, closeKey) {
    let element = null;
    try {
      element = settings[closeKey] ? document.querySelector(settings[closeKey]) : null;
    } catch {
      return null;
    }
    if (!element || !isVisible(element)) return null;
    // selector 是位置路徑，介面關掉後可能指到別的東西；有記文字就要對得上才點
    const text = settings[`${closeKey}Text`];
    return !text || buttonText(element) === text ? element : null;
  }

  // 一次只點一個 X 再確認，避免介面重畫後點到過期的按鈕；
  // 先試這條自己的 X 與共用 X，再試其他條的 X（舊介面可能是別的角色的），最後才用 Esc＋點空白處
  async function closeAllItemMenus(settings, group, index, runId, stepMilliseconds) {
    const closeKeys = [slotKey(group.id, 'Close', index), groupKey(group.id, 'CloseSelector')];
    SUPPLY_GROUPS.forEach((otherGroup) => {
      for (let otherIndex = 0; otherIndex < SLOT_COUNT; otherIndex++) {
        closeKeys.push(slotKey(otherGroup.id, 'Close', otherIndex));
      }
      closeKeys.push(groupKey(otherGroup.id, 'CloseSelector'));
    });
    const tried = new Set();
    let escapeUsed = false;
    for (;;) {
      if (!openItemUseButtons(settings).size) return true;
      const closeKey = closeKeys.find((key) => !tried.has(key) && findCloseButton(settings, key));
      if (closeKey) {
        tried.add(closeKey);
        const closeButton = findCloseButton(settings, closeKey);
        const rect = closeButton.getBoundingClientRect();
        simulateFullClick(closeButton, rect.left + rect.width / 2, rect.top + rect.height / 2);
      } else if (!escapeUsed) {
        escapeUsed = true;
        closeItemMenu('');
      } else {
        return false;
      }
      await wait(stepMilliseconds);
      if (runId !== state.runId) return false;
    }
  }

  function usesItemApi(settings, group, index) {
    return Boolean(group.healField && settings[groupKey(group.id, 'ApiEnabled')] && heroIdForSlot(settings, group.id, index));
  }

  function excludedHuntHeroIds(settings) {
    return String(settings.huntExcludedHeroIds || '')
      .split(',')
      .map(Number)
      .filter(Boolean);
  }

  // 第幾條對應哪個角色：狩獵＝/api/huntInfo 隊伍的第幾位（排除的回傳 0）；鍛造＝自己勾的
  function heroIdForSlot(settings, groupId, index) {
    if (groupId === 'forge') return Number(settings[forgeHeroKey(index)]) || 0;
    const heroId = state.huntTeamIds[index] || 0;
    return excludedHuntHeroIds(settings).includes(heroId) ? 0 : heroId;
  }

  function itemNames(settings, group) {
    return String(settings[groupKey(group.id, 'ItemNames')] || '')
      .split(/[,，、]/)
      .map((name) => name.trim())
      .filter(Boolean);
  }

  // 可用道具清單有填就只從清單裡挑，避免吃到稀有道具；挑庫存最多的，平均消耗
  function pickHealingItem(items, group, names) {
    const candidates = items.filter(
      (item) => item[group.healField] > 0 && item.available > 0 && (!names.length || names.includes(item.name))
    );
    return candidates.reduce((best, item) => (!best || item.available > best.available ? item : best), null);
  }

  // 列出能回這種數值的道具讓使用者勾選，勾選結果寫回可用道具欄位
  async function showItemChoices(groupId) {
    const group = SUPPLY_GROUPS.find((candidate) => candidate.id === groupId);
    let items;
    try {
      items = (await requestGameApi(ITEMS_API)).items || [];
    } catch (error) {
      setStatus(`讀取物品欄失敗（${error.message}）`);
      return;
    }
    const allowed = itemNames(readSettingsFromPanel(), group);
    panel.querySelector(`[data-item-choices="${groupId}"]`).innerHTML = items
      .filter((item) => item[group.healField] > 0)
      .map(
        (item) => `<label style="display:block"><input type="checkbox" data-item-choice="${groupId}" value="${escapeHtml(item.name)}"
          ${allowed.includes(item.name) ? 'checked' : ''} style="width:auto;flex:none">
          ${escapeHtml(item.name)}（回 ${item[group.healField]}，剩 ${item.available}）</label>`
      )
      .join('');
  }

  function updateItemNamesFromChoices(groupId) {
    const checked = Array.from(panel.querySelectorAll(`[data-item-choice="${groupId}"]:checked`)).map((input) => input.value);
    panel.querySelector(`[data-field="${groupKey(groupId, 'ItemNames')}"]`).value = checked.join(', ');
  }

  const ITEMS_API = '/api/items';
  const HUNT_INFO_API = '/api/huntInfo';
  const HEROES_API = '/api/heroes';
  const PROFILE_API = '/api/profile';

  // 不同設定檔的分頁彼此不通，改由本機的 monitor-server.ps1 收集各分頁回報，總覽頁再一起顯示
  const DASHBOARD_REPORT_MILLISECONDS = 5000;
  // 掛機時 /api/hunt 的回應就會更新隊伍，只有停著或在鍛造時才需要自己去讀
  const DASHBOARD_TEAM_FRESH_MILLISECONDS = 30000;
  const DASHBOARD_PROFILE_FRESH_MILLISECONDS = 60000;
  // 同一個帳號常開兩個分頁（一個鍛造、一個推圖），只用帳號 id 回報會互相蓋掉、指令也會被另一頁拿走。
  // 每個分頁另外取一個代號放 sessionStorage：重新整理還是同一個，換分頁就不同
  const TAB_KEY_STORAGE_KEY = 'autoClickerV2TabKey';
  // 這個分頁上次按的是掛機還是鍛造，停著的時候總覽頁也認得出是哪個分頁
  const TAB_ROLE_STORAGE_KEY = 'autoClickerV2TabRole';
  const tabKey = (() => {
    try {
      const saved = sessionStorage.getItem(TAB_KEY_STORAGE_KEY);
      if (saved) return saved;
      const created = Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem(TAB_KEY_STORAGE_KEY, created);
      return created;
    } catch {
      return Math.random().toString(36).slice(2, 8);
    }
  })();

  function tabRole() {
    if (state.running) return state.forgeMode ? 'forge' : 'hunt';
    let saved = null;
    try {
      saved = sessionStorage.getItem(TAB_ROLE_STORAGE_KEY);
    } catch {
      // 讀不到就看目前停在哪一頁
    }
    // 還沒按過開始的分頁，停在鍛造頁就當作鍛造分頁
    return saved || (activeTab === 'forge' ? 'forge' : 'hunt');
  }

  function rememberTabRole(forgeMode) {
    try {
      sessionStorage.setItem(TAB_ROLE_STORAGE_KEY, forgeMode ? 'forge' : 'hunt');
    } catch {
      // 記不住就照執行狀態判斷
    }
  }

  const dashboard = {
    profile: null,
    profileTriedAt: 0,
    team: [],
    teamAt: 0,
    teamTriedAt: 0,
    // 鍛造分頁要看的是鍛造角色（/api/heroes），不是狩獵隊伍
    forgeHeroes: [],
    forgeHeroesTriedAt: 0,
    // 目前用哪個代號回報；關掉回報或關掉分頁時用來通知中繼站把卡片拿掉
    reportingId: '',
    alert: '',
    reportedAt: 0,
    sending: false,
    dataError: '',
    sendError: '',
    lastCommand: '',
  };

  // 總覽頁只能改這些欄位，其他設定（按鈕位置這類）遠端改了也看不到效果，不開放
  const REMOTE_CHECKBOX_FIELDS = ['healthApiEnabled', 'resourceApiEnabled', 'equipApiEnabled', 'stageEnabled', 'loop'];
  const REMOTE_NUMBER_FIELDS = [
    'healthThresholdPercent',
    'healthTargetPercent',
    'resourceThresholdPercent',
    'resourceTargetPercent',
    'repeatCount',
    'loopDelaySeconds',
    'intervalMinSeconds',
    'intervalMaxSeconds',
  ];
  // 重新整理後要自動開始的模式；只放這個分頁的 sessionStorage，關掉分頁就沒了
  const RESUME_AFTER_RELOAD_KEY = 'autoClickerV2ResumeAfterReload';

  // 載入器每次開頁面都從中繼站抓最新版，所以分頁只要重新整理就是新版；這裡定期比對版本號，有新版就找空檔重新整理
  const UPDATE_CHECK_MILLISECONDS = 60000;
  const autoUpdate = {
    // 這個分頁載入時中繼站上的版本；之後中繼站的版本跟它不同就是有新版
    loadedVersion: '',
    githubCheckedAt: 0,
    githubVersion: '',
    checkedAt: 0,
    pendingVersion: '',
  };

  // GitHub 有 5 分鐘快取，比中繼站查得慢一點；加時間參數避開快取
  const GITHUB_VERSION_URL = 'https://raw.githubusercontent.com/s6413380/SwGameSscript/main/version.txt';
  const GITHUB_UPDATE_CHECK_MILLISECONDS = 10 * 60000;

  // 為了哪一版重新整理過；重新整理後還是舊版，代表這個分頁的主程式不是從載入器來的，重新整理也沒用
  const UPDATE_TRIED_KEY = 'autoClickerV2UpdateTried';

  async function fetchVersionText(url) {
    const response = await window.fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.text()).trim();
  }

  // 「2.10」比「2.9」新：逐段比數字
  function compareVersions(first, second) {
    const a = String(first).split('.').map(Number);
    const b = String(second).split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (a[index] || 0) - (b[index] || 0);
      if (difference) return difference;
    }
    return 0;
  }

  // 中繼站和 GitHub 取比較新的：朋友電腦的中繼站可能還放著舊版，不能只看中繼站
  async function latestPublishedVersion(settings) {
    let relayVersion = '';
    try {
      relayVersion = await fetchVersionText(`${dashboardBaseUrl(settings)}/version`);
    } catch {
      // 中繼站沒開
    }
    if (Date.now() - autoUpdate.githubCheckedAt >= GITHUB_UPDATE_CHECK_MILLISECONDS) {
      autoUpdate.githubCheckedAt = Date.now();
      try {
        autoUpdate.githubVersion = await fetchVersionText(`${GITHUB_VERSION_URL}?t=${Date.now()}`);
      } catch {
        // 網路不通就沿用上次查到的
      }
    }
    return [relayVersion, autoUpdate.githubVersion]
      .filter((version) => /^[\d.]+$/.test(version))
      .reduce((latest, version) => (!latest || compareVersions(version, latest) > 0 ? version : latest), '');
  }

  async function checkForUpdate(settings) {
    if (!settings.autoUpdateEnabled || autoUpdate.pendingVersion) return;
    if (Date.now() - autoUpdate.checkedAt < UPDATE_CHECK_MILLISECONDS) return;
    autoUpdate.checkedAt = Date.now();
    // 知道自己是哪一版時直接拿來比，不然第一次查到的版本當作目前的
    if (!autoUpdate.loadedVersion && SCRIPT_VERSION !== '?') autoUpdate.loadedVersion = SCRIPT_VERSION;
    try {
      const version = await latestPublishedVersion(settings);
      if (!version || !/^[\w.]+$/.test(version)) return;
      if (!autoUpdate.loadedVersion) {
        autoUpdate.loadedVersion = version;
      } else if (compareVersions(version, autoUpdate.loadedVersion) > 0) {
        let triedVersion = '';
        try {
          triedVersion = sessionStorage.getItem(UPDATE_TRIED_KEY) || '';
        } catch {
          // 讀不到就照常重新整理
        }
        if (triedVersion === version) {
          setStatus(`有新版 ${version}，但重新整理後還是 ${SCRIPT_VERSION}：這個分頁不是用載入器載入，請在 Tampermonkey 移除「愛吉吉」（或舊名「器靈」「自動點擊按鈕 V2」）完整版、改裝載入器`);
          return;
        }
        autoUpdate.pendingVersion = version;
        setStatus(`發現新版 ${version}，等這一步做完就重新整理`);
        reloadForUpdateIfIdle();
      }
    } catch {
      // 中繼站沒開就下次再查
    }
  }

  // 只在沒有進行中的動作時重新整理：停著（沒在等驗證、沒有暫停警報）或執行中剛排好下一步的空檔。
  // 吃藥、換裝這些非同步流程做到一半時不會走到這裡，重新整理不會把它們切斷
  // 重新整理後要接著跑哪些：打怪、鍛造（API 鍛造跟打怪可以同時）
  function resumeModes() {
    return [state.running && !state.forgeMode ? 'hunt' : '', (state.running && state.forgeMode) || forgeRunner.running ? 'forge' : '', miningRunner.running ? 'mine' : '']
      .filter(Boolean)
      .join(',');
  }

  function reloadForUpdateIfIdle() {
    if (!autoUpdate.pendingVersion || forgeRunner.captchaWaiting) return false;
    if (!state.running && (state.verifyResumeMode !== null || dashboard.alert)) return false;
    try {
      if (resumeModes()) sessionStorage.setItem(RESUME_AFTER_RELOAD_KEY, resumeModes());
    } catch {
      // 記不住就只重新整理，不自動開始
    }
    try {
      sessionStorage.setItem(UPDATE_TRIED_KEY, autoUpdate.pendingVersion);
    } catch {
      // 記不住頂多多重新整理一次
    }
    backgroundTimer.clearTimeout(state.timerId);
    setStatus(`更新到 ${autoUpdate.pendingVersion}，重新整理中`);
    backgroundTimer.setTimeout(() => location.reload(), 500);
    return true;
  }

  // place：這份隊伍資料是在哪裡打完的（只有 /api/hunt 的回應才有意義，其他來源不傳）
  function rememberHuntTeam(heroes, place = '') {
    dashboard.team = heroes;
    dashboard.teamAt = Date.now();
    if (readSettingsFromPanel().growthEnabled) growthTracker.noticeTeamLevels(heroes, fetchHeroDetail, place);
  }

  function huntPlace(huntInfo) {
    if (!huntInfo || !huntInfo.zoneName) return '';
    return huntInfo.huntStage ? `${huntInfo.zoneName} ${huntInfo.huntStage}` : huntInfo.zoneName;
  }

  // 像手動點開角色頁一樣讀一次，隔一下再讀，不要緊跟在戰鬥請求後面
  async function fetchHeroDetail(heroId) {
    await wait(randomGap(1000, 3000));
    return requestGameApi(`${HEROES_API}/${heroId}`);
  }

  // 開好幾個帳號時，面板標題和提醒都要看得出是哪個帳號
  function rememberProfile(profile) {
    dashboard.profile = { id: profile.id, nickname: profile.nickname, money: profile.money };
    renderAppName();
    renderLowProfilePersonality();
    renderLowModeButtons();
    applyTitlePrefix();
  }

  // 「愛吉吉的小明」；截圖分享時可以選擇不顯示帳號名稱
  function appName() {
    const nickname = dashboard.profile && dashboard.profile.nickname;
    return nickname && readSettingsFromPanel().showAccountName ? `愛吉吉的${nickname}` : '愛吉吉';
  }

  function renderAppName() {
    panel.querySelector('[data-role="app-name"]').textContent = appName();
  }

  // 讀取時間在請求前就記下，失敗時才不會每 5 秒重打一次
  async function refreshDashboardData() {
    if (Date.now() - dashboard.profileTriedAt > DASHBOARD_PROFILE_FRESH_MILLISECONDS) {
      dashboard.profileTriedAt = Date.now();
      const profile = await requestGameApi(PROFILE_API, { background: true });
      rememberProfile(profile);
      if (readSettingsFromPanel().incomeEnabled) recordMoney(profile.money);
    }
    if (tabRole() === 'forge') {
      if (Date.now() - dashboard.forgeHeroesTriedAt > DASHBOARD_TEAM_FRESH_MILLISECONDS) {
        dashboard.forgeHeroesTriedAt = Date.now();
        dashboard.forgeHeroes = (await requestGameApi(HEROES_API, { background: true })).heroes || [];
      }
      return;
    }
    if (Date.now() - Math.max(dashboard.teamAt, dashboard.teamTriedAt) > DASHBOARD_TEAM_FRESH_MILLISECONDS) {
      dashboard.teamTriedAt = Date.now();
      rememberHuntTeam((await requestGameApi(HUNT_INFO_API, { background: true })).heroes || []);
    }
  }

  // 有在「鍛造」頁勾負責鍛造的角色就只看那幾位，沒勾就列出正在鍛造的
  function forgeReport(settings) {
    const chosen = Array.from({ length: SLOT_COUNT }, (_, index) => heroIdForSlot(settings, 'forge', index)).filter(Boolean);
    const heroes = chosen.length
      ? dashboard.forgeHeroes.filter((hero) => chosen.includes(hero.id))
      : dashboard.forgeHeroes.filter((hero) => hero.actionState === 5);
    return {
      progress: state.forgeStarted.length ? forgeProgressText(settings) : '',
      heroes: heroes.map(({ id, name, lv, sp, fullSp, actionState, actionTarget, actionCompleteTime, canComplete }) => ({
        id, name, lv, sp, fullSp, forging: actionState === 5, shop: actionTarget, completeAt: actionCompleteTime, canComplete,
      })),
    };
  }

  function forgeQueueReport(settings) {
    if (!settings.forgeByApiEnabled) return null;
    return {
      queued: forgeByApiHeroIds(settings).length,
      shops: Number(settings.forgeShopSlots) || forgeShops.count || 0,
      forging: forgeHeroes.filter((hero) => hero.actionState === 5).length,
      started: forgeRunner.started,
      limit: settings.forgeByApiCount,
    };
  }

  function dashboardBaseUrl(settings) {
    return String(settings.dashboardUrl || '').replace(/\/+$/, '');
  }

  // 關掉回報或關掉分頁時通知中繼站拿掉這張卡片，總覽頁才不會留一張「離線」
  function leaveDashboard(settings) {
    if (!dashboard.reportingId) return;
    const url = `${dashboardBaseUrl(settings)}/bye?id=${encodeURIComponent(dashboard.reportingId)}`;
    dashboard.reportingId = '';
    try {
      // 分頁正在關閉時一般的 fetch 會被取消，sendBeacon 才送得出去
      if (!navigator.sendBeacon(url, '')) window.fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
    } catch {
      // 送不出去就等中繼站 10 分鐘後自己清掉
    }
  }

  window.addEventListener('pagehide', () => {
    const settings = readSettingsFromPanel();
    leaveDashboard(settings);
    // 關分頁時剛好輪到自己，不放手的話別的帳號要等租約過期
    if (settings.turnTakingEnabled) {
      try {
        navigator.sendBeacon(`${dashboardBaseUrl(settings)}/turn/release?id=${encodeURIComponent(TURN_ID)}`, '');
        if (transferWatch.arm) navigator.sendBeacon(`${dashboardBaseUrl(settings)}/turn/transfer/end?id=${encodeURIComponent(TRANSFER_TURN_ID)}`, '');
      } catch {
        // 送不出去就等中繼站租約到期
      }
    }
    if (state.running) releaseRunLock(state.forgeMode);
    if (forgeRunner.running) releaseRunLock(true);
    if (miningRunner.running) releaseMiningLock();
  });

  // 畫面上讀不到位置（API 打怪不用停在狩獵頁、或沒設定關卡欄位）就用 API 拿到的位置
  function apiLocationText(settings) {
    const info = state.huntInfo;
    if (!info || info.huntZone === undefined) return '';
    if (Number(info.huntZone) === 0) return settings.townName || '城鎮';
    const name = loadPlaces().zones[info.huntZone] || info.zoneName || `地圖 ${info.huntZone}`;
    return `${name} ${info.huntStage}`;
  }

  // API 打怪時位置以 API 為準；畫面上的關卡欄位在別頁或遊戲改版後可能讀到別的字（例如「Lv. 44」），對不上區域就不用
  function dashboardLocationText(settings) {
    const apiText = apiLocationText(settings);
    if (isApiHunt(settings) && apiText) return apiText;
    const location = settings.stageSelector ? readLocation(settings) : null;
    return location && location.area ? location.text : apiText || (location ? location.text : '');
  }

  function dashboardReport(settings) {
    return {
      accountId: dashboard.profile.id,
      version: SCRIPT_VERSION,
      role: tabRole(),
      nickname: dashboard.profile.nickname,
      money: dashboard.profile.money,
      running: state.running || forgeRunner.running,
      forgeMode: state.forgeMode,
      huntRunning: state.running && !state.forgeMode,
      forgeRunning: (state.running && state.forgeMode) || forgeRunner.running,
      forgeQueue: forgeQueueReport(settings),
      forgeBoard: forgeBoardReport(settings),
      miningRunning: miningRunner.running,
      mining: miningReport(settings),
      actorLoot: actorLootReport(),
      alert: dashboard.alert,
      status: statusElement.textContent,
      location: dashboardLocationText(settings),
      heroes: dashboard.team.map((hero) => {
        const { id, name, lv, exp, fullExp, hp, fullHp, sp, fullSp, perished } = hero;
        return { id, name, lv, exp, fullExp, hp, fullHp, sp, fullSp, perished, conditions: heroConditions(hero) };
      }),
      teamAt: dashboard.teamAt,
      income: settings.incomeEnabled ? incomeReport() : null,
      controls: Object.fromEntries(
        [...REMOTE_CHECKBOX_FIELDS, ...REMOTE_NUMBER_FIELDS, 'stageTargetArea', 'stageTargetNumber'].map((field) => [field, settings[field]])
      ),
      townName: settings.townName,
      areas: configuredAreas(settings).map((area) => area.name),
      lastCommand: dashboard.lastCommand,
      lastAction: { at: lastGameRequest.actionAt, label: lastGameRequest.actionLabel, readAt: lastGameRequest.readAt, text: lastActionText() },
      globalMode: globalPauseActive() ? globalPause.mode : 'run',
      nextActionAt: nextActionAt(),
      // 轉移時賣方看這個確認買方已經待命，才掛單
      transferArmed: transferWatch.arm ? transferWatch.arm.token : '',
      transferRefused: transferWatch.refused,
      forge: forgeReport(settings),
    };
  }

  // 改面板上的欄位再觸發 change，跟手動改一樣會存檔、切換顯示；tick 每一步都重讀面板，執行中也馬上生效
  function setPanelField(field, value) {
    const input = panel.querySelector(`[data-field="${field}"]`);
    if (!input) throw new Error(`找不到欄位 ${field}`);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else setFieldValue(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 遠端補一次：照自動補給的道具清單挑，只吃 1 個，避免按錯時一次吃掉一堆
  async function healOnceByApi(heroId, groupId) {
    const group = SUPPLY_GROUPS.find((candidate) => candidate.id === groupId && !candidate.forgeOnly);
    if (!group) throw new Error(`不認得的補給種類 ${groupId}`);
    const hero = dashboard.team.find((candidate) => candidate.id === heroId);
    const who = `[遠端] ${hero ? hero.name : heroId}`;
    const items = (await requestGameApi(ITEMS_API)).items || [];
    const item = pickHealingItem(items, group, itemNames(readSettingsFromPanel(), group));
    if (!item) return `${who} 沒有可用的${group.name}道具`;
    await wait(itemRequestGap());
    const result = await requestGameApi(`${ITEMS_API}/${item.id}/use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 1, heroId }),
    });
    if (result.hero) {
      dashboard.team = dashboard.team.map((candidate) => (candidate.id === heroId ? { ...candidate, ...result.hero } : candidate));
      if (state.heroStats.has(heroId)) state.heroStats.set(heroId, { ...state.heroStats.get(heroId), ...result.hero });
    }
    const after = result.hero ? `，${group.heroField} ${result.hero[group.heroField]}/${result.hero[group.fullField]}` : '';
    const message = `${who} ${item.name}×1${after}`;
    logItemUse(message);
    return message;
  }

  // 帳號之間轉移：用拍賣掛單、另一個帳號買下（拍賣沒有手續費，價格全數到賣方）。
  // 帳號之間的指令走總覽中繼站：每個分頁每 5 秒回報一次時順便拿指令，所以兩邊的分頁都要開著、總覽回報要打開。
  // 防搶：買方先「待命」（每 0.5 秒查一次拍賣），確定買方待命了賣方才掛單，買方看到就馬上買，空窗不到 1 秒。
  // 掛單留言放一組暗號，買方核對賣家、價格、暗號都對才買，不會買到別人的單
  const TRANSFER_TARGET_FRESH_MILLISECONDS = 30000;
  const TRANSFER_ARM_MILLISECONDS = 60000;
  const TRANSFER_POLL_MILLISECONDS = 500;
  // 等買方回報「待命中」最多這麼久；買方每 5 秒回報一次，留一點餘裕
  // 指令跟著對方下一次回報（每 5 秒）才送到，對方再查錢、回報待命，15 秒常常不夠
  const TRANSFER_ARM_WAIT_MILLISECONDS = 30000;
  // 掛上去這麼久還沒被買走就撤回，不要一直公開掛著
  const TRANSFER_SOLD_WAIT_MILLISECONDS = 20000;
  // refused：買方拒絕待命的原因（例如錢不夠），回報給賣方看，賣方就不掛單
  const transferWatch = { arm: null, timerId: null, refused: null };

  function transferLog(message) {
    setStatus(`［轉移］${message}`);
    panel.querySelector('[data-role="transfer-log"]').textContent = message;
  }

  function transferToken() {
    return `#${Math.random().toString(36).slice(2, 8)}`;
  }

  // 同一個帳號可能開好幾個分頁，取最近回報的那個
  async function relayAccounts(settings) {
    const response = await window.fetch(`${dashboardBaseUrl(settings)}/status`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`中繼站回應 HTTP ${response.status}`);
    const { accounts = [] } = await response.json();
    const byAccount = new Map();
    accounts
      .filter((account) => account.data && account.data.accountId)
      .sort((first, second) => first.at - second.at)
      .forEach((account) =>
        byAccount.set(Number(account.data.accountId), {
          accountId: Number(account.data.accountId),
          nickname: account.data.nickname,
          relayId: account.id,
          at: account.at,
          transferArmed: account.data.transferArmed || '',
          transferRefused: account.data.transferRefused || null,
        })
      );
    return [...byAccount.values()];
  }

  async function findRelayAccount(settings, accountId) {
    const target = (await relayAccounts(settings)).find((account) => account.accountId === Number(accountId));
    if (!target || Date.now() - target.at > TRANSFER_TARGET_FRESH_MILLISECONDS) {
      throw new Error('對方帳號的分頁沒有在回報（要開著遊戲、面板「總覽」回報要打開、中繼站要開著）');
    }
    return target;
  }

  async function sendRelayCommand(settings, accountId, command) {
    const target = await findRelayAccount(settings, accountId);
    const response = await window.fetch(`${dashboardBaseUrl(settings)}/command?id=${encodeURIComponent(target.relayId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(command),
    });
    if (!response.ok) throw new Error(`送指令給對方失敗（HTTP ${response.status}）`);
    return target;
  }

  async function waitUntilArmed(settings, accountId, token) {
    const deadline = Date.now() + TRANSFER_ARM_WAIT_MILLISECONDS;
    while (Date.now() < deadline) {
      const target = (await relayAccounts(settings)).find((account) => account.accountId === Number(accountId));
      if (target && target.transferArmed === token) return;
      if (target && target.transferRefused && target.transferRefused.token === token) throw new Error(`對方沒辦法買：${target.transferRefused.reason}`);
      await wait(500);
    }
    throw new Error('對方沒有回報「待命中」，沒有掛單（對方分頁的總覽回報有打開嗎？）');
  }

  async function findOwnTrade(kind, token) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const trades = (await requestGameApi(`/api/trades?type=${kind}&own=true`))[kind] || [];
      const trade = trades.find((candidate) => candidate.message === token);
      if (trade) return trade;
      await wait(1000);
    }
    return null;
  }

  // 買方待命：知道暗號、賣家、價格，每 0.5 秒查一次拍賣，一出現就買
  async function armTransfer(command) {
    const settings = readSettingsFromPanel();
    const waitMilliseconds = command.waitMilliseconds || TRANSFER_ARM_MILLISECONDS;
    // 只有兩邊都在這台電腦的中繼站上才搶優先；雲端那條要等好幾分鐘，不能讓其他帳號一直停著。
    // 先搶優先再查錢：查錢跟著掛機排隊（還可能碰上全體暫停）會拖到賣方等不及
    if (command.relay) await beginTransferTurn(settings, waitMilliseconds);
    let profile;
    try {
      profile = command.relay ? await inTransferTurn(settings, () => sendGameRequestNow(PROFILE_API)) : await requestGameApi(PROFILE_API);
    } catch (error) {
      if (command.relay) endTransferTurn(settings);
      throw error;
    }
    // 先確認買得起，買不起就回報原因，賣方不會掛單
    if (profile.money < Number(command.price)) {
      if (command.relay) endTransferTurn(settings);
      const reason = `錢不夠（只有 $${profile.money.toLocaleString()}，要 $${Number(command.price).toLocaleString()}）`;
      transferWatch.refused = { token: command.token, reason };
      dashboard.reportedAt = 0;
      throw new Error(`轉移：${reason}，不待命`);
    }
    transferWatch.refused = null;
    backgroundTimer.clearTimeout(transferWatch.timerId);
    transferWatch.arm = { ...command, until: Date.now() + waitMilliseconds };
    dashboard.reportedAt = 0;
    pollArmedTransfer();
    const message = `轉移：待命中，對方一掛單就買（最多等 ${(command.waitMilliseconds || TRANSFER_ARM_MILLISECONDS) / 1000} 秒）`;
    transferLog(message);
    return message;
  }

  function disarmTransfer(message) {
    const arm = transferWatch.arm;
    backgroundTimer.clearTimeout(transferWatch.timerId);
    transferWatch.arm = null;
    dashboard.reportedAt = 0;
    if (arm && arm.relay) endTransferTurn(readSettingsFromPanel());
    transferLog(message);
    // 雲端轉角色待命時停掉的掛機、鍛造，結束就恢復
    if (arm && arm.onEnd) arm.onEnd();
  }

  async function pollArmedTransfer() {
    const arm = transferWatch.arm;
    if (!arm) return;
    if (Date.now() > arm.until) {
      disarmTransfer('轉移：等不到對方掛單，已停止待命');
      return;
    }
    try {
      // 搶時間：不排進動作隊伍（打怪的動作間隔會拖慢），查到就在同一次操作權裡買下
      const found = await inTransferTurn(readSettingsFromPanel(), async () => {
        const trades = (await sendGameRequestNow(`/api/trades?type=${arm.kind}`))[arm.kind] || [];
        if (transferWatch.arm !== arm) return null;
        const trade = trades.find((candidate) => candidate.message === arm.token && Number(candidate.sellerId) === Number(arm.sellerId));
        if (!trade || Number(trade.price) !== Number(arm.price)) return trade ? { trade } : null;
        return { trade, result: await sendGameRequestNow(`/api/trades/${trade.id}/buy`, { method: 'POST' }) };
      });
      if (transferWatch.arm !== arm) return;
      if (found) {
        const { trade, result } = found;
        if (!result) {
          disarmTransfer(`轉移：掛單價格 $${Number(trade.price).toLocaleString()} 跟約定的 $${Number(arm.price).toLocaleString()} 不一樣，不買`);
          return;
        }
        refreshGameView([['profile'], ['market'], ['heroes'], ['items']]);
        disarmTransfer(`轉移：買下 ${trade.name}（$${Number(trade.price).toLocaleString()}），剩 $${Number(result.money).toLocaleString()}`);
        return;
      }
    } catch (error) {
      // 偶爾查詢失敗就下一輪再試；買失敗（例如被別人先買走）就停
      if (/\/buy|HTTP 4/.test(error.message)) {
        disarmTransfer(`轉移：買不到（${error.message}）`);
        return;
      }
    }
    transferWatch.timerId = backgroundTimer.setTimeout(pollArmedTransfer, arm.pollMilliseconds || TRANSFER_POLL_MILLISECONDS);
  }

  // 收錢的一方：照對方的要求把 1 個材料掛成約定的價格（付錢的一方已經在待命）
  async function listForMoneyTransfer(command) {
    const settings = readSettingsFromPanel();
    const price = Number(command.price);
    // 從中繼站來的：買方已經待命、轉移優先已經開始，這邊的請求也要標成轉移才拿得到操作權
    const list = async () => {
      const mines = (await sendGameRequestNow(ITEMS_API)).mines || [];
      const mine = mines.find((candidate) => (candidate.name || itemName(candidate.id)) === command.mine && (Number(candidate.available ?? candidate.quantity) || 0) >= 1);
      if (!mine) throw new Error(`轉移：沒有可以掛單的「${command.mine}」`);
      await sendGameRequestNow(`${ITEMS_API}/${mine.id}/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price, quantity: 1, message: command.token }),
      });
    };
    if (command.relay) await inTransferTurn(settings, list);
    else await list();
    const message = `轉移：已把 ${command.mine}×1 掛成 $${price.toLocaleString()}，等對方買下`;
    transferLog(message);
    return message;
  }

  const TRANSFER_TARGETS_KEY = 'autoClickerV2TransferTargets';

  function selectedTransferTarget() {
    const typedId = Number(panel.querySelector('[data-role="transfer-target-id"]').value) || 0;
    if (typedId) {
      const known = readJsonStorage(TRANSFER_TARGETS_KEY, {});
      return { accountId: typedId, nickname: known[typedId] || `帳號 ${typedId}` };
    }
    const select = panel.querySelector('[data-role="transfer-target"]');
    const option = select.selectedOptions[0];
    if (!option || !option.value) throw new Error('先選對象帳號，或輸入對方的帳號 ID');
    return { accountId: Number(option.value), nickname: option.dataset.nickname };
  }

  function rememberTransferTarget(target) {
    const known = readJsonStorage(TRANSFER_TARGETS_KEY, {});
    if (target.nickname && !target.nickname.startsWith('帳號 ')) known[target.accountId] = target.nickname;
    else if (!known[target.accountId]) known[target.accountId] = '';
    writeJsonStorage(TRANSFER_TARGETS_KEY, known);
  }

  // 雲端轉帳：對方不在中繼站上（例如在別台電腦）時，改用雲端試算表的 transfers 分頁慢慢傳話。
  // 付錢的一方寫一筆「請掛單」，收錢的一方每 30 秒看一次，看到給自己的就掛單，付錢的一方一直在等，掛上就買。
  // 轉錢不怕被搶（沒人會花大錢買 1 個泥土），慢一點沒關係；只寫新事件不改舊列，試算表那端不用處理更新
  const TRANSFER_CLOUD_POLL_MILLISECONDS = 30000;
  const TRANSFER_CLOUD_EXPIRE_MILLISECONDS = 180000;
  const TRANSFER_CLOUD_BUY_POLL_MILLISECONDS = 2000;
  // 雲端轉角色：賣方最多等買方回「已待命」這麼久；買方只接這段時間內的要求，避免賣方已經放棄了還在等
  const TRANSFER_CLOUD_HERO_WAIT_MILLISECONDS = 150000;
  const TRANSFER_CLOUD_HERO_ACCEPT_MILLISECONDS = 120000;
  const TRANSFER_CLOUD_ANSWER_POLL_MILLISECONDS = 5000;
  const TRANSFER_REQUEST_EVENTS = ['request', 'heroRequest'];
  // 同一個帳號開好幾個分頁時，處理過的要求記在共用的地方，不會重複掛單
  const TRANSFER_HANDLED_KEY = 'autoClickerV2TransferHandled';

  // 查拍賣的英雄：花的錢和張數存起來，自動更新重新整理後才不會從 0 算、超過預算
  const CARD_BUY_STATE_KEY = 'autoClickerV2CardBuy';
  // 提醒過的掛單記起來，同一張卡不會每一輪都叫
  const CARD_NOTIFIED_KEY = 'autoClickerV2CardNotified';
  const CARD_NOTIFIED_LIMIT = 300;
  // 同一個帳號（同一個瀏覽器）開好幾個分頁時，誰最近查過誰負責，免得兩邊各買一張
  const CARD_BUY_LOCK_KEY = 'autoClickerV2CardBuyLock';
  // 提醒另外留一份清單，不會被之後的「查過了」「沒有符合」蓋掉
  const CARD_ALERT_HISTORY_KEY = 'autoClickerV2CardAlertHistory';
  const CARD_ALERT_HISTORY_LIMIT = 50;
  const CARD_BUY_MIN_SECONDS = 10;
  const POTENTIAL_ORDER = ['F', 'E', 'D', 'C', 'B', 'A', 'S'];
  // 轉移功能掛單時留言的暗號（transferToken）
  const TRANSFER_TOKEN_PATTERN = /^#[0-9a-z]{6}$/;
  const RELEASED_MARKET_API = '/api/releasedHeroMarket';
  const cardBuy = { checkedAt: 0, busy: false, burstLeft: 5 };

  // 找卡清單：一列一張卡，欄位改了就轉回原本的規則文字（cardBuyRules）存，舊設定照樣能用
  const CARD_TYPES_KEY = 'autoClickerV2CardTypes';
  const CARD_TYPES_LIMIT = 300;
  const CARD_RULE_SELECT_STYLE = 'flex:none;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px';

  // 看過的卡片種類記起來，輸入卡片名稱時可以直接挑
  function rememberCardTypes(cards) {
    const known = readJsonStorage(CARD_TYPES_KEY, []);
    const fresh = [...new Set(cards.map((card) => card && card.type).filter((type) => type && !known.includes(type)))];
    if (fresh.length) writeJsonStorage(CARD_TYPES_KEY, [...known, ...fresh].slice(-CARD_TYPES_LIMIT));
  }

  function cardRuleRowHtml(rule = {}) {
    const number = (key, value, width) =>
      `<input data-card-rule="${key}" type="number" min="0" value="${value || ''}" placeholder="不限" style="width:${width};flex:none">`;
    const potentials = ['', ...[...POTENTIAL_ORDER].reverse()]
      .map((grade) => `<option value="${grade}" ${grade === (rule.minPotential || '') ? 'selected' : ''}>${grade || '不限'}</option>`)
      .join('');
    return `<div class="card-rule" style="border:1px solid #3a3a40;border-radius:6px;padding:4px 6px;margin:4px 0">
      <div class="row"><input data-card-rule="type" list="autoClickerCardTypes" value="${escapeHtml(rule.type || '')}" placeholder="卡片名稱（例如房東阿姨）" style="flex:1;min-width:0">
        <button data-action="card-rule-remove" title="刪掉這張">✕</button></div>
      <div class="row">價格 ≤ ${number('maxPrice', rule.maxPrice, '90px')}　潛能 ≥ <select data-card-rule="minPotential" style="${CARD_RULE_SELECT_STYLE}">${potentials}</select></div>
      <div class="row">等級 ${number('minLevel', rule.minLevel, '50px')} ～ ${number('maxLevel', rule.maxLevel === Infinity ? '' : rule.maxLevel, '50px')}
        <label style="margin-left:8px"><input data-card-rule="notifyOnly" type="checkbox" ${rule.notifyOnly ? 'checked' : ''} style="width:auto;flex:none"> 只提醒不買</label></div>
    </div>`;
  }

  function renderCardRules() {
    const rules = parseCardBuyRules(panel.querySelector('[data-field="cardBuyRules"]').value);
    panel.querySelector('[data-role="card-rules"]').innerHTML = rules.map((rule) => cardRuleRowHtml(rule)).join('');
    const types = [...new Set([...readJsonStorage(CARD_TYPES_KEY, []), ...readJsonStorage(DRAW_LOG_KEY, []).map((draw) => draw.type)])].filter(Boolean);
    panel.querySelector('#autoClickerCardTypes').innerHTML = types.map((type) => `<option value="${escapeHtml(type)}"></option>`).join('');
  }

  function cardRuleText(rule) {
    const parts = [rule.type.replace(/\s+/g, '')];
    if (rule.maxPrice > 0) parts.push(`價格≤${rule.maxPrice}`);
    const { minLevel, maxLevel } = rule;
    if (minLevel && maxLevel && minLevel === maxLevel) parts.push(`等級${minLevel}`);
    else if (minLevel && maxLevel) parts.push(`等級${Math.min(minLevel, maxLevel)}-${Math.max(minLevel, maxLevel)}`);
    else if (minLevel) parts.push(`等級≥${minLevel}`);
    else if (maxLevel) parts.push(`等級≤${maxLevel}`);
    if (rule.minPotential) parts.push(`潛能≥${rule.minPotential}`);
    if (rule.notifyOnly) parts.push('提醒');
    return parts.join(' ');
  }

  // 還沒填卡片名稱的列先不存（列還留在畫面上讓人繼續填）
  function updateCardRulesFromRows() {
    const lines = [...panel.querySelectorAll('[data-role="card-rules"] .card-rule')]
      .map((row) => {
        const field = (key) => row.querySelector(`[data-card-rule="${key}"]`);
        return {
          type: field('type').value.trim(),
          maxPrice: Number(field('maxPrice').value) || 0,
          minLevel: Number(field('minLevel').value) || 0,
          maxLevel: Number(field('maxLevel').value) || 0,
          minPotential: field('minPotential').value,
          notifyOnly: field('notifyOnly').checked,
        };
      })
      .filter((rule) => rule.type)
      .map(cardRuleText);
    panel.querySelector('[data-field="cardBuyRules"]').value = lines.join('\n');
  }

  // 等級：「等級1-5」區間、「等級≥20」「等級≤5」、只寫數字「等級1」＝剛好那一級；> < 不含那一級
  function parseLevelRange(text) {
    const range = text.match(/等級\s*(\d+)\s*[-~]\s*(\d+)/);
    if (range) return [Number(range[1]), Number(range[2])];
    const atLeast = text.match(/等級\s*([≥>])\s*(\d+)/);
    if (atLeast) return [Number(atLeast[2]) + (atLeast[1] === '>' ? 1 : 0), Infinity];
    const atMost = text.match(/等級\s*([≤<])\s*(\d+)/);
    if (atMost) return [0, Number(atMost[2]) - (atMost[1] === '<' ? 1 : 0)];
    const exact = text.match(/等級\s*=?\s*(\d+)/);
    return exact ? [Number(exact[1]), Number(exact[1])] : [0, Infinity];
  }

  // 大家習慣的寫法不一樣：>=、≧、全形符號、「20以上」都換成 ≥ ≤ 再比對，不然條件會被當成沒寫
  function normalizeRuleText(text) {
    return text
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
      .replace(/＞＝|>=|≧/g, '≥')
      .replace(/＜＝|<=|≦/g, '≤')
      .replace(/＞/g, '>')
      .replace(/＜/g, '<')
      .replace(/＝/g, '=')
      .replace(/[～〜]/g, '~')
      .replace(/－/g, '-')
      .replace(/(等級|價格|潛能)\s*\$?([\w,]+)\s*以上/g, '$1≥$2')
      .replace(/(等級|價格|潛能)\s*\$?([\w,]+)\s*以下/g, '$1≤$2');
  }

  function parseCardBuyRules(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const type = line.split(/\s+/)[0];
        const rest = normalizeRuleText(line.slice(type.length));
        const price = rest.match(/價格\s*[≤<=]*\s*\$?\s*(\d[\d,]*)/);
        const potential = rest.match(/潛能\s*[≥>=]*\s*([A-Za-z]+)/);
        const [minLevel, maxLevel] = parseLevelRange(rest);
        return {
          line,
          type,
          notifyOnly: /提醒/.test(rest),
          maxPrice: price ? Number(price[1].replace(/,/g, '')) : 0,
          minLevel,
          maxLevel,
          minPotential: potential ? potential[1].toUpperCase() : '',
        };
      });
  }

  function potentialAtLeast(potential, minimum) {
    if (!minimum) return true;
    const rank = POTENTIAL_ORDER.indexOf(String(potential || '').toUpperCase());
    const needed = POTENTIAL_ORDER.indexOf(minimum);
    return rank >= 0 && needed >= 0 && rank >= needed;
  }

  // 要買的規則一定要有價格上限；只提醒的沒寫價格就不管價格
  function cardRuleMatches(rule, card) {
    const level = Number(card.lv || 0);
    return (
      card.type === rule.type &&
      (rule.notifyOnly || rule.maxPrice > 0) &&
      (!rule.maxPrice || Number(card.price) <= rule.maxPrice) &&
      level >= rule.minLevel &&
      level <= rule.maxLevel &&
      potentialAtLeast(card.potential, rule.minPotential)
    );
  }

  function cardText(card) {
    return `${card.type}「${card.name}」Lv.${card.lv} 潛能 ${card.potential}（$${Number(card.price).toLocaleString()}）`;
  }

  function renderCardAlertHistory() {
    const box = panel.querySelector('[data-role="card-alert-history"]');
    const history = readJsonStorage(CARD_ALERT_HISTORY_KEY, []);
    box.textContent = history.length ? '' : '還沒有提醒';
    history.forEach((entry) => {
      const line = document.createElement('div');
      const time = new Date(entry.at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      line.textContent = `${time} ${entry.message}`;
      box.appendChild(line);
    });
  }

  function recordCardAlert(message) {
    const history = readJsonStorage(CARD_ALERT_HISTORY_KEY, []);
    writeJsonStorage(CARD_ALERT_HISTORY_KEY, [{ at: Date.now(), message }, ...history].slice(0, CARD_ALERT_HISTORY_LIMIT));
    renderCardAlertHistory();
  }

  // 找到卡、買到卡照「提醒方式」；出問題（stopCardBuy）一律用正式的提醒
  function cardAlert(message) {
    recordCardAlert(message);
    if (readSettingsFromPanel().cardAlertStyle === 'popup') alertUser(`拍賣英雄：${message}`);
    else showToast(`拍賣英雄：${message}`);
  }

  function cardBuyLog(message) {
    setStatus(`［拍賣英雄］${message}`);
    panel.querySelector('[data-role="card-buy-log"]').textContent = `${new Date().toLocaleTimeString()} ${message}`;
  }

  function renderCardBuyStatus(settings = readSettingsFromPanel()) {
    const saved = readJsonStorage(CARD_BUY_STATE_KEY, { spent: 0, bought: 0 });
    const left = Math.max(0, Number(settings.cardBuyBudget) - Number(saved.spent));
    // 總預算欄位是上限、不會被改掉，剩多少另外算
    panel.querySelector('[data-role="card-buy-status"]').textContent =
      `已買 ${saved.bought}/${settings.cardBuyMaxCount} 張，已花 $${Number(saved.spent).toLocaleString()}，還能花 $${left.toLocaleString()}`;
  }

  // 買出問題只關自動購買、提醒照常；活人驗證才整個關
  function stopCardBuy(message, field = 'cardAutoBuyEnabled') {
    setPanelField(field, false);
    cardBuyLog(message);
    recordCardAlert(message);
    alertUser(`拍賣英雄：${message}`);
  }

  function cardBuyExcludedSellers(settings, ownId) {
    const ids = `${settings.transferTrustedIds || ''},${settings.cardBuyExcludeSellerIds || ''}`
      .split(/[,，\s]+/)
      .map(Number)
      .filter(Boolean);
    return new Set([Number(ownId), ...ids]);
  }

  // 只提醒新出現的；key 加上價格，同一張降價了會再提醒一次
  function notifyCards(cards, where) {
    const notified = readJsonStorage(CARD_NOTIFIED_KEY, []);
    const fresh = cards.filter((card) => !notified.includes(`${where}:${card.id}:${card.price}`));
    if (!fresh.length) return;
    writeJsonStorage(CARD_NOTIFIED_KEY, [...notified, ...fresh.map((card) => `${where}:${card.id}:${card.price}`)].slice(-CARD_NOTIFIED_LIMIT));
    cardAlert(`${where}有符合的卡：${fresh.map(cardText).join('、')}`);
  }

  // 人口販子平常沒開；回應格式還沒看過實際的，有 heroes 陣列或本身是陣列才當成清單，而且只提醒不買
  function releasedCardsFrom(data) {
    if (!data || data.enabled === false) return [];
    return Array.isArray(data.heroes) ? data.heroes : Array.isArray(data) ? data : [];
  }

  // 沒開自動購買時每條規則都當成提醒，沒寫價格的也算
  function cardRulesFor(settings) {
    return parseCardBuyRules(settings.cardBuyRules).map((rule) => (settings.cardAutoBuyEnabled ? rule : { ...rule, notifyOnly: true }));
  }

  // 主動查的節奏像人刷商店：連刷幾次（間隔多數靠近短的、偶爾拉長），再去做別的事一陣子
  const CARD_BURST_MIN = 3;
  const CARD_BURST_MAX = 8;
  const CARD_BREAK_MIN_MILLISECONDS = 5 * 60000;
  const CARD_BREAK_MAX_MILLISECONDS = 20 * 60000;
  // 切到主動查的時間：開太久會忘記關，到時間自動切回被動
  const CARD_ACTIVE_SINCE_KEY = 'autoClickerV2CardActiveSince';
  const MARKET_HEROES_PATTERN = /\/api\/trades\?type=heroes(?![^#]*own=true)/;
  const RELEASED_MARKET_PATTERN = /\/api\/releasedHeroMarket(?:[?#]|$)/;

  function nextActiveCheckDelay(settings) {
    if (cardBuy.burstLeft <= 0) {
      cardBuy.burstLeft = Math.round(randomGap(CARD_BURST_MIN, CARD_BURST_MAX));
      return { delay: randomGap(CARD_BREAK_MIN_MILLISECONDS, CARD_BREAK_MAX_MILLISECONDS), resting: true };
    }
    cardBuy.burstLeft--;
    const low = Math.max(CARD_BUY_MIN_SECONDS, Number(settings.cardBuyIntervalSeconds) || 0);
    const high = Math.max(low, Number(settings.cardBuyIntervalMaxSeconds) || 0);
    return { delay: randomSkewedSeconds(low, high) * 1000, resting: false };
  }

  // 「8-24」「8-12,20-24」「22-2」（跨午夜）；留空＝整天
  function inCardActiveHours(text, date = new Date()) {
    const ranges = String(text || '')
      .split(/[,，、\s]+/)
      .map((entry) => entry.match(/^(\d{1,2})[-~～](\d{1,2})$/))
      .filter(Boolean)
      .map((match) => [Number(match[1]), Number(match[2])]);
    if (!ranges.length) return true;
    const hour = date.getHours() + date.getMinutes() / 60;
    return ranges.some(([from, to]) => (from <= to ? hour >= from && hour < to : hour >= from || hour < to));
  }

  function waitText(milliseconds) {
    return milliseconds >= 60000 ? `${Math.round(milliseconds / 60000)} 分鐘` : `${Math.round(milliseconds / 1000)} 秒`;
  }

  // 被動、主動都走這裡：比對規則、提醒、買。讀不到帳號這類查詢錯誤丟回給呼叫的一方
  async function handleCardTrades(settings, trades, released) {
    const rules = cardRulesFor(settings);
    if (!rules.length) {
      cardBuyLog('還沒寫要找的卡');
      return;
    }
    let buying = null;
    rememberCardTypes([...trades, ...(released || [])]);
    try {
      const ownId = dashboard.profile ? dashboard.profile.id : (await requestGameApi(PROFILE_API)).id;
      const excluded = cardBuyExcludedSellers(settings, ownId);
      const matched = trades
        .filter((trade) => !excluded.has(Number(trade.sellerId)) && !TRANSFER_TOKEN_PATTERN.test(String(trade.message || '')))
        .map((trade) => ({
          trade,
          buy: rules.some((rule) => !rule.notifyOnly && cardRuleMatches(rule, trade)),
          // 要買的規則：卡出現就說一聲，價格內的才買
          notify: rules.some((rule) =>
            rule.notifyOnly
              ? cardRuleMatches(rule, trade)
              : settings.cardNotifyOverPrice && cardRuleMatches({ ...rule, maxPrice: 0, notifyOnly: true }, trade)
          ),
        }))
        .filter((entry) => entry.buy || entry.notify)
        .sort((first, second) => Number(first.trade.price) - Number(second.trade.price));
      const toBuy = matched.filter((entry) => entry.buy).map((entry) => entry.trade);
      const toNotify = matched.filter((entry) => !entry.buy).map((entry) => entry.trade);
      const releasedMatched = (released || []).filter((card) => rules.some((rule) => cardRuleMatches({ ...rule, notifyOnly: true }, card)));
      notifyCards(toNotify, '拍賣場');
      notifyCards(releasedMatched, '人口販子');
      const budget = Number(settings.cardBuyBudget) || 0;
      const leftover = [];
      for (const trade of toBuy) {
        const saved = readJsonStorage(CARD_BUY_STATE_KEY, { spent: 0, bought: 0 });
        const price = Number(trade.price);
        if (saved.bought >= settings.cardBuyMaxCount || saved.spent + price > budget) {
          leftover.push(trade);
          continue;
        }
        // 搶時間：不排進動作隊伍，跟轉移買單一樣直接送
        buying = trade;
        const result = await sendGameRequest(`/api/trades/${trade.id}/buy`, { method: 'POST' });
        buying = null;
        saved.spent += price;
        saved.bought += 1;
        writeJsonStorage(CARD_BUY_STATE_KEY, saved);
        refreshGameView([['profile'], ['market'], ['heroes']]);
        const text = `買下 ${cardText(trade)}${result && result.money !== undefined ? `，剩 $${Number(result.money).toLocaleString()}` : ''}`;
        cardBuyLog(text);
        cardAlert(text);
        await wait(randomGap(800, 1500));
      }
      // 預算用完、張數買滿就只剩提醒：符合要買的條件但買不下的也提醒一次，讓人自己決定
      const saved = readJsonStorage(CARD_BUY_STATE_KEY, { spent: 0, bought: 0 });
      const reason = !budget
        ? '總預算是 0'
        : saved.bought >= settings.cardBuyMaxCount
          ? `已買滿 ${saved.bought}/${settings.cardBuyMaxCount} 張`
          : `預算剩 $${Math.max(0, budget - saved.spent).toLocaleString()} 不夠`;
      notifyCards(leftover, `拍賣場（${reason}，沒買）`);
      if (!matched.length && !releasedMatched.length) {
        cardBuyLog(`沒有符合的卡（看了${released ? '人口販子' : ` ${trades.length} 張掛單`}）`);
      }
    } catch (error) {
      if (error.captchaRequired) stopCardBuy('伺服器要求活人驗證，查拍賣已關閉，驗證完要用再重新勾選', 'cardBuyEnabled');
      // 逾時或斷線時可能其實買到了，只是沒算進預算，所以也停下來讓人確認
      else if (buying && error.transient) stopCardBuy(`買 ${cardText(buying)} 時${error.message}，不確定有沒有買到，自動購買已關閉，請到遊戲確認`);
      else if (buying) stopCardBuy(`買不到 ${cardText(buying)}（${error.message}），自動購買已關閉`);
      else throw error;
    }
  }

  // 被動模式：遊戲自己抓拍賣或人口販子清單時順便看，一個請求都不多發
  function noticeGameMarket(url, data) {
    const settings = readSettingsFromPanel();
    if (tabShutDown || !settings.cardBuyEnabled || settings.cardWatchMode === 'active' || cardBuy.busy || !data) return;
    const isReleased = RELEASED_MARKET_PATTERN.test(url);
    if (isReleased && !settings.cardReleasedEnabled) return;
    cardBuy.busy = true;
    handleCardTrades(settings, isReleased ? [] : data.heroes || [], isReleased ? releasedCardsFrom(data) : null)
      .catch((error) => cardBuyLog(`比對失敗（${error.message}）`))
      .finally(() => {
        cardBuy.busy = false;
        renderCardBuyStatus();
      });
  }

  // 主動模式（搶卡用）：自己去抓清單。force＝按「立即查」，不管模式、時段、間隔
  async function checkCardMarket(settings, { force = false } = {}) {
    if (tabShutDown || !settings.cardBuyEnabled || cardBuy.busy) return;
    if (!force) {
      if (settings.cardWatchMode !== 'active' || Date.now() < cardBuy.checkedAt) return;
      const minutes = Number(settings.cardActiveMinutes) || 0;
      const since = readJsonStorage(CARD_ACTIVE_SINCE_KEY, 0);
      if (!since) writeJsonStorage(CARD_ACTIVE_SINCE_KEY, Date.now());
      if (minutes && since && Date.now() - since > minutes * 60000) {
        setPanelField('cardWatchMode', 'passive');
        cardBuyLog(`主動查滿 ${minutes} 分鐘，切回被動`);
        return;
      }
      // 別的分頁（同一個帳號）在查，等它那邊的下一次時間過了還沒動才接手
      const lock = readJsonStorage(CARD_BUY_LOCK_KEY, null);
      if (lock && lock.tab !== tabKey && Date.now() < (lock.until || lock.at) + 60000) return;
      if (!inCardActiveHours(settings.cardActiveHours)) {
        cardBuy.checkedAt = Date.now() + 60000;
        cardBuyLog('不在設定的時段，主動查先停著（被動照常）');
        return;
      }
    }
    const { delay, resting } = nextActiveCheckDelay(settings);
    cardBuy.checkedAt = Date.now() + delay;
    writeJsonStorage(CARD_BUY_LOCK_KEY, { tab: tabKey, at: Date.now(), until: cardBuy.checkedAt });
    if (state.captchaWaiting || forgeRunner.captchaWaiting) return;
    cardBuy.busy = true;
    try {
      const trades = (await requestGameApi('/api/trades?type=heroes')).heroes || [];
      const released = settings.cardReleasedEnabled ? releasedCardsFrom(await requestGameApi(RELEASED_MARKET_API).catch(() => null)) : null;
      await handleCardTrades(settings, trades, released);
      if (settings.cardWatchMode === 'active') {
        panel.querySelector('[data-role="card-buy-next"]').textContent = `下次主動查：${waitText(delay)}後${resting ? '（刷了一陣，休息一下）' : ''}`;
      }
    } catch (error) {
      if (error.captchaRequired) stopCardBuy('伺服器要求活人驗證，查拍賣已關閉，驗證完要用再重新勾選', 'cardBuyEnabled');
      else if (/HTTP 4/.test(error.message)) stopCardBuy(`查詢失敗（${error.message}），查拍賣已關閉`, 'cardBuyEnabled');
      else cardBuyLog(`查詢失敗（${error.message}），下一輪再試`);
    } finally {
      cardBuy.busy = false;
      renderCardBuyStatus();
    }
  }

  // 第一次只抓最後幾筆，不用從頭讀整張表
  const transferCloud = { checkedAt: 0, row: -50, busy: false, accountId: 0 };

  function cloudUrlOf(settings) {
    const url = settings.cloudUrl || DEFAULT_CLOUD_URL;
    if (!/^https:\/\/script\.google\.com\//.test(url)) throw new Error('還沒設定雲端試算表網址（其他 → 雲端）');
    return url;
  }

  async function postTransferEvent(settings, transfer, eventName) {
    const result = await cloudRequest(cloudUrlOf(settings), {
      method: 'POST',
      body: JSON.stringify({
        contributor: settings.cloudName || '未署名',
        transfers: [[`${transfer.id}:${eventName}`, transfer.id, transfer.from, transfer.to, transfer.amount, transfer.mine, transfer.token, eventName, Date.now()]],
      }),
    });
    if (!result.added || result.added.transfers === undefined) throw new Error('雲端試算表是舊版，沒有轉帳分頁（要更新 Apps Script 並重新部署）');
  }

  async function checkCloudTransfers(settings) {
    if (tabShutDown || !settings.transferCloudEnabled || transferCloud.busy) return;
    if (Date.now() - transferCloud.checkedAt < TRANSFER_CLOUD_POLL_MILLISECONDS) return;
    transferCloud.checkedAt = Date.now();
    transferCloud.busy = true;
    try {
      const url = cloudUrlOf(settings);
      if (!transferCloud.accountId) transferCloud.accountId = Number((await requestGameApi(PROFILE_API, { background: true })).id);
      const page = await cloudRequest(`${url}?only=transfers&after_transfers=${transferCloud.row}`);
      if (!page.transfers) return;
      transferCloud.row = page.transfers.next;
      const events = page.transfers.rows.map(([, id, from, to, amount, mine, token, eventName, at, contributor]) => ({
        id: String(id), from: Number(from), to: Number(to), amount: Number(amount), mine: String(mine), token: String(token), event: String(eventName), at: Number(at),
        contributor: String(contributor || ''),
      }));
      const closed = new Set(events.filter((item) => !TRANSFER_REQUEST_EVENTS.includes(item.event)).map((item) => item.id));
      const handled = new Set(readJsonStorage(TRANSFER_HANDLED_KEY, []));
      const requests = events.filter(
        (item) =>
          TRANSFER_REQUEST_EVENTS.includes(item.event) &&
          item.to === transferCloud.accountId &&
          !closed.has(item.id) &&
          !handled.has(item.id) &&
          Date.now() - item.at < (item.event === 'heroRequest' ? TRANSFER_CLOUD_HERO_ACCEPT_MILLISECONDS : TRANSFER_CLOUD_EXPIRE_MILLISECONDS)
      );
      for (const request of requests) {
        handled.add(request.id);
        writeJsonStorage(TRANSFER_HANDLED_KEY, [...handled].slice(-200));
        if (request.event === 'heroRequest') {
          await armForCloudHero(settings, request);
          continue;
        }
        try {
          await listForMoneyTransfer({ mine: request.mine, price: request.amount, token: request.token });
          await postTransferEvent(settings, request, 'listed').catch(() => {});
          // 對方等太久放棄的話，單會一直掛著；時間到還在就撤回
          backgroundTimer.setTimeout(() => cancelLeftoverTransfer(request.token), TRANSFER_CLOUD_EXPIRE_MILLISECONDS);
        } catch (error) {
          transferLog(`雲端轉帳掛單失敗：${error.message}`);
          await postTransferEvent(settings, request, 'failed').catch(() => {});
        }
      }
    } catch {
      // 雲端偶爾連不上，下次再看
    } finally {
      transferCloud.busy = false;
    }
  }

  async function cancelLeftoverTransfer(token) {
    try {
      const trade = await findOwnTrade('mines', token);
      if (!trade) return;
      await requestGameApi(`/api/trades/${trade.id}/cancel?own=true`, { method: 'POST' });
      transferLog('雲端轉帳：對方沒來買，已撤回掛單');
    } catch (error) {
      transferLog(`雲端轉帳：撤回掛單失敗（${error.message}），請到市場自己撤回`);
    }
  }

  async function startMoneyTransfer(settings) {
    const target = selectedTransferTarget();
    const amount = Math.floor(Number(panel.querySelector('[data-role="transfer-amount"]').value) || 0);
    if (amount < 1) throw new Error('金額要大於 0');
    const mine = settings.transferMine || '泥土';
    const profile = await requestGameApi(PROFILE_API);
    if (profile.money < amount) throw new Error(`錢不夠：只有 $${profile.money.toLocaleString()}`);
    if (target.accountId === Number(profile.id)) throw new Error('不能轉給自己');
    // 對方在中繼站上就直接傳；不在就走雲端
    const viaRelay = await findRelayAccount(settings, target.accountId).then(() => true, () => false);
    if (!viaRelay) cloudUrlOf(settings);
    if (
      !(await askConfirm(
        `確定要轉 $${amount.toLocaleString()} 給「${target.nickname}」？\n\n做法：請「${target.nickname}」把 1 個${mine}掛成 $${amount.toLocaleString()}，這個帳號買下。\n拍賣沒有手續費，金額會全部到對方。\n${viaRelay ? '對方在中繼站上，幾秒內完成。' : '對方不在中繼站上，透過雲端傳話：對方要勾「接受雲端轉帳」，約 30～60 秒，最多等 3 分鐘。'}`
      ))
    ) {
      transferLog('已取消');
      return;
    }
    rememberTransferTarget(target);
    const token = transferToken();
    if (viaRelay) {
      // 自己先待命再叫對方掛，對方一掛上就買
      await armTransfer({ kind: 'mines', token, price: amount, sellerId: target.accountId, relay: true });
      await sendRelayCommand(settings, target.accountId, { type: 'transferList', mine, price: amount, token, relay: true });
      transferLog(`已請「${target.nickname}」掛單，這個帳號待命中，一掛上就買（約 5～10 秒）`);
      return;
    }
    const transfer = { id: `${profile.id}-${Date.now()}`, from: Number(profile.id), to: target.accountId, amount, mine, token };
    await armTransfer({ kind: 'mines', token, price: amount, sellerId: target.accountId, waitMilliseconds: TRANSFER_CLOUD_EXPIRE_MILLISECONDS, pollMilliseconds: TRANSFER_CLOUD_BUY_POLL_MILLISECONDS });
    try {
      await postTransferEvent(settings, transfer, 'request');
    } catch (error) {
      disarmTransfer(`雲端轉帳失敗：${error.message}`);
      return;
    }
    transferLog(`已透過雲端請「${target.nickname}」掛單；對方約 30～60 秒內掛上，這個帳號會自動買下（最多等 3 分鐘）`);
  }

  // 雲端轉角色要等比較久：兩邊先把掛機、鍛造停下來專心等，結束後照原本的狀態再開
  function pauseScriptsForTransfer() {
    const huntWasRunning = state.running && !state.forgeMode;
    const forgeWasRunning = (state.running && state.forgeMode) || forgeRunner.running;
    if (state.running) stop('轉移角色中，掛機先停下');
    if (forgeRunner.running) stopForgeRunner('轉移角色中，鍛造先停下');
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (huntWasRunning) start(false);
      if (forgeWasRunning) start(true);
    };
  }

  // 輪詢雲端，等這筆轉移出現指定的事件（例如對方回「已待命」）
  async function waitCloudEvent(settings, transferId, eventNames, timeoutMilliseconds) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      await wait(TRANSFER_CLOUD_ANSWER_POLL_MILLISECONDS);
      try {
        const page = await cloudRequest(`${cloudUrlOf(settings)}?only=transfers&after_transfers=-100`);
        const row = ((page.transfers && page.transfers.rows) || []).find(([, id, , , , , , eventName]) => String(id) === transferId && eventNames.includes(String(eventName)));
        if (row) return { event: String(row[7]), note: String(row[5]) };
      } catch {
        // 雲端偶爾連不上，繼續等
      }
    }
    return null;
  }

  async function listHeroAndWaitSold(hero, price, token, nickname, { relay = false } = {}) {
    const settings = readSettingsFromPanel();
    // 中繼站那條：買方待命時已經開了轉移優先，這邊的請求標成轉移才不會跟著被擋
    const inTurn = (run) => (relay ? inTransferTurn(settings, run) : run());
    await inTurn(() =>
      sendGameRequestNow(`${HEROES_API}/${hero.id}/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price, message: token }),
      })
    );
    transferLog(`「${hero.name}」已掛單 $${price.toLocaleString()}，「${nickname}」待命中`);
    refreshGameView([['heroes'], ['market']]);
    const deadline = Date.now() + TRANSFER_SOLD_WAIT_MILLISECONDS;
    while (Date.now() < deadline) {
      await wait(1500);
      const isListed = () => inTurn(async () => ((await sendGameRequestNow(`/api/trades?type=heroes&own=true`)).heroes || []).some((trade) => trade.message === token));
      // 偶爾讀到的清單還沒更新，連兩次都不在才算賣掉
      if (!(await isListed()) && (await wait(1000), !(await isListed()))) {
        transferLog(`「${hero.name}」已被「${nickname}」買走（$${price.toLocaleString()}）`);
        return true;
      }
    }
    await inTurn(() => sendGameRequestNow(`${HEROES_API}/${hero.id}/cancelTrade`, { method: 'POST' })).catch(() => {});
    refreshGameView([['heroes'], ['market']]);
    return false;
  }

  async function startHeroTransfer(settings) {
    const target = selectedTransferTarget();
    const heroId = Number(panel.querySelector('[data-role="transfer-hero"]').value);
    const price = Math.floor(Number(panel.querySelector('[data-role="transfer-hero-price"]').value) || 0);
    if (!heroId) throw new Error('先選要轉移的角色');
    if (price < 1) throw new Error('先設定價格（對方要付的錢，會轉到這個帳號）');
    const heroes = (await requestGameApi(HEROES_API)).heroes || [];
    const hero = heroes.find((candidate) => candidate.id === heroId);
    if (!hero) throw new Error('找不到這個角色，按「重新讀取」再選一次');
    if (hero.actionState) throw new Error(`「${hero.name}」正在行動中（鍛造、移動…），先停下來再轉`);
    const huntTeam = (await requestGameApi(HUNT_INFO_API)).heroes || [];
    if (huntTeam.some((member) => member.id === hero.id)) throw new Error(`「${hero.name}」在狩獵隊伍裡，先換下來再轉`);
    const profile = await requestGameApi(PROFILE_API);
    if (target.accountId === Number(profile.id)) throw new Error('不能轉給自己');
    // 對方在中繼站上就直接傳（幾秒）；不在就走雲端（兩邊腳本先停，慢慢等）
    const viaRelay = await findRelayAccount(settings, target.accountId).then(() => true, () => false);
    if (!viaRelay) cloudUrlOf(settings);
    if (
      !(await askConfirm(
        `確定把「${hero.name}」（Lv ${hero.lv} ${hero.type}）以 $${price.toLocaleString()} 掛上拍賣，由「${target.nickname}」買走？\n\n會先讓對方待命，確定對方準備好才掛單，對方一看到就買（空窗約 1 秒）；${TRANSFER_SOLD_WAIT_MILLISECONDS / 1000} 秒內沒被買走會自動撤回。\n${
          viaRelay
            ? '對方在中繼站上，幾秒內完成。'
            : `對方不在中繼站上，透過雲端傳話：對方要勾「接受雲端轉帳」。兩邊的掛機、鍛造會先停下來等（最多約 ${TRANSFER_CLOUD_HERO_WAIT_MILLISECONDS / 60000} 分鐘），完成後自動恢復。`
        }`
      ))
    ) {
      transferLog('已取消');
      return;
    }
    rememberTransferTarget(target);
    const token = transferToken();
    if (viaRelay) {
      await sendRelayCommand(settings, target.accountId, { type: 'transferArm', kind: 'heroes', token, price, sellerId: profile.id, relay: true });
      transferLog(`等「${target.nickname}」待命…`);
      // 對方沒待命就不掛，避免掛上去沒人買、被別人撿走
      await waitUntilArmed(settings, target.accountId, token);
      if (!(await listHeroAndWaitSold(hero, price, token, target.nickname, { relay: true }))) throw new Error(`${TRANSFER_SOLD_WAIT_MILLISECONDS / 1000} 秒內對方沒買走，已撤回掛單`);
      return;
    }
    const transfer = { id: `${profile.id}-${Date.now()}`, from: Number(profile.id), to: target.accountId, amount: price, mine: hero.name, token };
    const resume = pauseScriptsForTransfer();
    try {
      await postTransferEvent(settings, transfer, 'heroRequest');
      transferLog(`已透過雲端請「${target.nickname}」待命，兩邊腳本先停下來等（對方約 30～60 秒回應）`);
      const answer = await waitCloudEvent(settings, transfer.id, ['armed', 'refused'], TRANSFER_CLOUD_HERO_WAIT_MILLISECONDS);
      if (!answer) throw new Error('對方一直沒回應（分頁有開著、有勾「接受雲端轉帳」嗎？），沒有掛單');
      if (answer.event === 'refused') throw new Error(`對方沒辦法買：${answer.note}，沒有掛單`);
      const sold = await listHeroAndWaitSold(hero, price, token, target.nickname);
      await postTransferEvent(settings, transfer, sold ? 'done' : 'cancelled').catch(() => {});
      if (!sold) throw new Error(`${TRANSFER_SOLD_WAIT_MILLISECONDS / 1000} 秒內對方沒買走，已撤回掛單`);
    } finally {
      resume();
    }
  }

  // 收到雲端「請待命買角色」：先把自己的掛機、鍛造停下，待命買；買到、等不到或失敗都會恢復
  // 雲端試算表是共用的，網址拿到的人都能寫要求；要這個帳號付錢的事一定要本人同意（或是信任的自己帳號）
  const TRANSFER_HERO_CONFIRM_MILLISECONDS = 80000;

  async function armForCloudHero(settings, request) {
    const trusted = String(settings.transferTrustedIds || '')
      .split(/[,，\s]+/)
      .map(Number)
      .filter(Boolean);
    if (!trusted.includes(request.from)) {
      panel.style.display = '';
      if (settings.alertSoundEnabled) playBeeps(settings.alertVolume);
      const sender = `帳號 ${request.from}${request.contributor ? `（雲端署名：${request.contributor}）` : ''}`;
      const accepted = await askConfirm(
        `${sender} 想透過雲端把角色「${request.mine}」轉給這個帳號。\n這個帳號要付 $${request.amount.toLocaleString()}（付給對方）。\n\n要接受嗎？${TRANSFER_HERO_CONFIRM_MILLISECONDS / 1000} 秒內沒回答就當作拒絕。\n不認識這個帳號就按取消。`,
        TRANSFER_HERO_CONFIRM_MILLISECONDS
      );
      if (!accepted) {
        transferLog(`雲端轉角色：已拒絕 ${sender} 的「${request.mine}」（$${request.amount.toLocaleString()}）`);
        await postTransferEvent(settings, { ...request, mine: '對方拒絕或沒有回應' }, 'refused').catch(() => {});
        return;
      }
    }
    const resume = pauseScriptsForTransfer();
    try {
      await armTransfer({ kind: 'heroes', token: request.token, price: request.amount, sellerId: request.from, waitMilliseconds: TRANSFER_CLOUD_HERO_WAIT_MILLISECONDS, onEnd: resume });
      await postTransferEvent(settings, request, 'armed');
      transferLog(`雲端轉角色：待命買「${request.mine}」（$${request.amount.toLocaleString()}），掛機、鍛造先停下`);
    } catch (error) {
      if (transferWatch.arm && transferWatch.arm.token === request.token) disarmTransfer(`雲端轉角色失敗：${error.message}`);
      resume();
      await postTransferEvent(settings, { ...request, mine: error.message.replace(/^轉移：/, '') }, 'refused').catch(() => {});
    }
  }

  async function refreshTransferChoices(settings) {
    const targetSelect = panel.querySelector('[data-role="transfer-target"]');
    const heroSelect = panel.querySelector('[data-role="transfer-hero"]');
    const [accounts, profile, heroes, huntInfo] = await Promise.all([
      relayAccounts(settings).catch(() => []),
      requestGameApi(PROFILE_API),
      requestGameApi(HEROES_API).then((data) => data.heroes || []),
      requestGameApi(HUNT_INFO_API).catch(() => ({})),
    ]);
    const huntTeamIds = new Set((huntInfo.heroes || []).map((hero) => hero.id));
    const others = accounts.filter((account) => account.accountId !== Number(profile.id));
    const known = readJsonStorage(TRANSFER_TARGETS_KEY, {});
    const remembered = Object.entries(known)
      .filter(([id]) => Number(id) !== Number(profile.id) && !others.some((account) => account.accountId === Number(id)))
      .map(([id, nickname]) => ({ accountId: Number(id), nickname: nickname || `帳號 ${id}`, cloud: true }));
    const choices = [...others, ...remembered];
    const chosen = targetSelect.value;
    targetSelect.innerHTML =
      `<option value="">${choices.length ? '選對象帳號' : '沒有其他帳號在回報（可以直接輸入對方 ID）'}</option>` +
      choices
        .map((account) => `<option value="${account.accountId}" data-nickname="${escapeHtml(account.nickname)}">${escapeHtml(account.nickname)}（${account.accountId}）${account.cloud ? '・雲端' : ''}</option>`)
        .join('');
    panel.querySelector('[data-role="transfer-me"]').textContent = `這個帳號：${profile.nickname}，ID ${profile.id}（給對方輸入用）`;
    targetSelect.value = choices.some((account) => String(account.accountId) === chosen) ? chosen : '';
    heroSelect.innerHTML =
      '<option value="">選要轉移的角色</option>' +
      heroes
        .map((hero) => {
          const busy = hero.actionState ? '（行動中，不能轉）' : huntTeamIds.has(hero.id) ? '（狩獵隊伍中，不能轉）' : '';
          return `<option value="${hero.id}" ${busy ? 'disabled' : ''}>${escapeHtml(hero.name)}　Lv ${hero.lv} ${escapeHtml(hero.type || '')}${busy}</option>`;
        })
        .join('');
  }

  async function runDashboardCommand(command) {
    const settings = readSettingsFromPanel();
    switch (command.type) {
      case 'start':
        start(false);
        return '開始掛機';
      case 'forge':
        start(true);
        return '開始鍛造';
      case 'stop':
        stop('總覽頁按了停止');
        stopForgeRunner('總覽頁按了停止');
        stopMiningRunner('總覽頁按了停止');
        return '停止';
      case 'stop-hunt':
        if (state.running && !state.forgeMode) stop('總覽頁停止掛機');
        return '停止掛機';
      case 'mine':
        startMiningRunner();
        return '開始挖礦';
      case 'stop-mine':
        if (miningRunner.running) stopMiningRunner('總覽頁停止挖礦');
        return '停止挖礦';
      case 'forge-queue':
        return queueHeroFromDashboard(Number(command.heroId), Number(command.fromId) || 0);
      case 'forge-plan':
        return setForgePlanFromDashboard(command);
      case 'forge-unqueue':
        unqueueHeroForForge(Number(command.heroId));
        return `${command.heroId} 移出鍛造佇列`;
      case 'forge-name': {
        const name = String(command.name || '').trim();
        if (!name) throw new Error('名稱是空的');
        applyForgeName(name);
        // 當成今天手動定好名稱，自動換名稱不會再蓋掉
        writeJsonStorage(FORGE_NAME_DAY_KEY, localDayKey(Date.now()));
        return `鍛造名稱改成「${name}」`;
      }
      case 'forge-setting': {
        const labels = { forgeShopSlots: '鍛造欄位', forgeByApiCount: '開幾爐', forgeAutoNamePercent: '自動換名稱門檻 %' };
        if (!labels[command.field]) throw new Error(`不開放遠端修改 ${command.field}`);
        setPanelField(command.field, Math.max(0, Number(command.value) || 0));
        saveSettings(readSettingsFromPanel());
        renderForgePlanOverview();
        // 門檻改了不用等下一次抓測名表，馬上再看一次
        wakeForgeRunner();
        return `${labels[command.field]}改成 ${readSettingsFromPanel()[command.field]}`;
      }
      case 'stop-forge':
        if (forgeRunner.running) stopForgeRunner('總覽頁停止鍛造');
        if (state.running && state.forgeMode) stop('總覽頁停止鍛造');
        return '停止鍛造';
      case 'resume':
        clearAlert();
        start(state.forgeMode);
        return `解除警報並重新${state.forgeMode ? '鍛造' : '掛機'}`;
      case 'target':
        setPanelField('stageEnabled', true);
        setPanelField('stageTargetArea', String(command.area || '').trim());
        if (command.number !== undefined) setPanelField('stageTargetNumber', Number(command.number) || 0);
        return `目標改成 ${targetLabel(readSettingsFromPanel())}`;
      case 'town':
        setPanelField('stageEnabled', true);
        setPanelField('stageTargetArea', settings.townName);
        return `回城（${settings.townName}）`;
      case 'field': {
        const isCheckbox = REMOTE_CHECKBOX_FIELDS.includes(command.field);
        if (!isCheckbox && !REMOTE_NUMBER_FIELDS.includes(command.field)) throw new Error(`不開放遠端修改 ${command.field}`);
        setPanelField(command.field, isCheckbox ? Boolean(command.value) : Number(command.value) || 0);
        return `${command.field} 改成 ${readSettingsFromPanel()[command.field]}`;
      }
      case 'heal':
        return healOnceByApi(Number(command.heroId), command.group);
      case 'transferList':
        return listForMoneyTransfer(command);
      case 'transferArm':
        return armTransfer(command);
      case 'reload':
        try {
          if (command.autoStart && resumeModes()) sessionStorage.setItem(RESUME_AFTER_RELOAD_KEY, resumeModes());
        } catch {
          // 記不住就只重新整理，不自動開始
        }
        backgroundTimer.setTimeout(() => location.reload(), 500);
        return command.autoStart ? '重新整理後自動開始' : '重新整理';
      default:
        throw new Error(`不認得的指令 ${command.type}`);
    }
  }

  // 指令跟著回報的回應一起拿回來，不用另外輪詢；做完馬上再回報一次，總覽頁才看得到結果
  async function runDashboardCommands(commands) {
    for (const command of commands) {
      const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
      try {
        const result = await runDashboardCommand(command);
        dashboard.lastCommand = `${time} ${result}`;
        setStatus(`[總覽] ${result}`);
      } catch (error) {
        dashboard.lastCommand = `${time} ✗ ${error.message}`;
        setStatus(`[總覽] 指令失敗（${error.message}）`);
      }
    }
    dashboard.reportedAt = 0;
  }

  async function reportToDashboard(settings) {
    if (!settings.dashboardEnabled) leaveDashboard(settings);
    if (!settings.dashboardEnabled || dashboard.sending) return;
    if (Date.now() - dashboard.reportedAt < DASHBOARD_REPORT_MILLISECONDS) return;
    dashboard.sending = true;
    dashboard.reportedAt = Date.now();
    try {
      // 多開輪流時讀取會延到下次動作才送；回報不能跟著卡住，遠端指令（例如轉移）是跟著回報拿回來的
      const refreshing = refreshDashboardData().then(
        () => {
          dashboard.dataError = '';
        },
        (error) => {
          dashboard.dataError = `讀取遊戲資料失敗（${error.message}）`;
        }
      );
      if (!dashboard.profile || !settings.turnTakingEnabled) await refreshing;
      if (!dashboard.profile) return;
      const reportingId = `${dashboard.profile.id}-${tabKey}`;
      const response = await window.fetch(`${dashboardBaseUrl(settings)}/status?id=${encodeURIComponent(reportingId)}`, {
        method: 'POST',
        // text/plain 是簡單請求，不用多一次 CORS 預檢
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(dashboardReport(settings)),
      });
      if (response.ok) dashboard.reportingId = reportingId;
      const reply = response.ok ? await response.json().catch(() => null) : null;
      // 舊版中繼站只回 ok 文字、不會轉交指令，遠端操作會像沒反應一樣，直接講出來
      dashboard.sendError = !response.ok
        ? `回報失敗（HTTP ${response.status}）`
        : reply
          ? ''
          : 'monitor-server.ps1 是舊版，收不到遠端指令，請關掉重開';
      if (reply && Array.isArray(reply.commands) && reply.commands.length) await runDashboardCommands(reply.commands);
    } catch (error) {
      dashboard.sendError = `連不上 ${settings.dashboardUrl}（${error.message}），monitor-server.ps1 有在跑嗎？`;
    } finally {
      dashboard.sending = false;
    }
  }

  // 三個帳號一定要一樣才有意義的設定：任一個帳號改了就送到中繼站，其他帳號定時拿回來套用
  const SHARED_SETTING_KEYS = [
    'lowProfileEnabled',
    'lowProfilePlayMinMinutes',
    'lowProfilePlayMaxMinutes',
    'lowProfileBreakMinMinutes',
    'lowProfileBreakMaxMinutes',
    'lowProfileSleepHours',
    'lowProfileOffHours',
    'lowProfileStyle',
    'lowProfileSeriousHours',
    'lowProfileCasualMinutes',
    'lowProfileCheckinMinMinutes',
    'lowProfileCheckinMaxMinutes',
    'lowProfileCheckinMinHunts',
    'lowProfileCheckinMaxHunts',
    'lowProfileForgeCheckin',
    'turnTakingEnabled',
    'mainAccountName',
    'sideHuntPercent',
    'transferTurnMode',
    'huntReactMinSeconds',
    'huntReactMaxSeconds',
  ];
  const SHARED_SETTINGS_AT_KEY = 'autoClickerV2SharedSettingsAt';
  const SHARED_SETTINGS_POLL_MILLISECONDS = 10000;
  const sharedSettings = { at: Number(readJsonStorage(SHARED_SETTINGS_AT_KEY, 0)) || 0, checkedAt: 0, text: '' };

  function rememberSharedSettingsAt(at) {
    sharedSettings.at = at;
    try {
      localStorage.setItem(SHARED_SETTINGS_AT_KEY, JSON.stringify(at));
    } catch {
      // 記不住就下次重新整理時再跟中繼站對一次
    }
  }

  async function pushSharedSettings(settings) {
    const at = Date.now();
    const values = Object.fromEntries(SHARED_SETTING_KEYS.map((key) => [key, settings[key]]));
    try {
      const response = await window.fetch(`${dashboardBaseUrl(settings)}/shared`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ at, values }),
      });
      if (!response.ok) throw new Error(response.status === 404 ? 'monitor-server.ps1 是舊版，請關掉重開' : `HTTP ${response.status}`);
      rememberSharedSettingsAt(at);
      sharedSettings.text = `同步：已把這個帳號的設定送給其他帳號（${new Date(at).toLocaleTimeString('zh-TW', { hour12: false })}）`;
    } catch (error) {
      sharedSettings.text = `同步：送不出去（${error.message}）`;
    }
    renderSyncAccountsStatus();
  }

  async function syncSharedSettings(settings) {
    if (!settings.syncAccountsEnabled || Date.now() - sharedSettings.checkedAt < SHARED_SETTINGS_POLL_MILLISECONDS) return;
    sharedSettings.checkedAt = Date.now();
    try {
      const response = await window.fetch(`${dashboardBaseUrl(settings)}/shared`, { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? 'monitor-server.ps1 是舊版，請關掉重開' : `HTTP ${response.status}`);
      const remote = await response.json();
      // 中繼站剛開、還沒有人送過：拿這個帳號的當起點
      if (!remote.at) return pushSharedSettings(settings);
      if (remote.at <= sharedSettings.at) return;
      const changed = SHARED_SETTING_KEYS.filter((key) => key in remote.values && remote.values[key] !== settings[key]);
      changed.forEach((key) => setPanelField(key, remote.values[key]));
      rememberSharedSettingsAt(remote.at);
      if (changed.length) sharedSettings.text = `同步：其他帳號改了 ${changed.length} 項設定，已跟著改（${new Date().toLocaleTimeString('zh-TW', { hour12: false })}）`;
    } catch (error) {
      sharedSettings.text = `同步：連不上中繼站（${error.message}）`;
    }
    renderSyncAccountsStatus();
  }

  function renderSyncAccountsStatus() {
    const element = panel.querySelector('[data-role="sync-accounts-status"]');
    if (element) element.textContent = readSettingsFromPanel().syncAccountsEnabled ? sharedSettings.text : '';
  }

  function dashboardMonitorText(settings) {
    if (!settings.dashboardEnabled) return '';
    const problem = dashboard.sendError || dashboard.dataError;
    return `總覽：${problem || (dashboard.profile ? `回報中（${dashboard.profile.nickname}）` : '準備中')}`;
  }
  // 遊戲每個 API 請求都帶 token 標頭；從遊戲自己送出的請求記下來沿用，沒記到才去 localStorage 找
  let gameToken = '';

  function currentGameToken() {
    if (gameToken) return gameToken;
    try {
      return localStorage.getItem('token') || '';
    } catch {
      return '';
    }
  }

  // 腳本送出的動作（打怪、鍛造、吃藥、換裝）排隊一個一個送，兩個動作之間至少隔一下；
  // API 打怪和 API 鍛造在同一個分頁一起跑也不會同時送出
  let actionQueue = Promise.resolve();
  let lastActionAt = 0;
  function queueAction(run) {
    const next = actionQueue.then(async () => {
      const gap = (readSettingsFromPanel().lowProfileEnabled ? randomGap(1500, 4000) : randomGap(800, 1600)) - (Date.now() - lastActionAt);
      if (gap > 0) await wait(gap);
      try {
        return await run();
      } finally {
        lastActionAt = Date.now();
      }
    });
    actionQueue = next.catch(() => {});
    return next;
  }

  function requestGameApi(path, options = {}) {
    if (String(options.method || 'GET').toUpperCase() !== 'GET') return queueAction(() => sendGameRequest(path, options));
    return sendGameRequest(path, options);
  }

  // 一個請求卡住不回，排在後面的動作（掛機、鍛造共用一條隊伍）會全部卡死，所以要有逾時
  const GAME_REQUEST_TIMEOUT_MILLISECONDS = 30000;

  // 三個帳號開在同一台電腦，後台看得到同一個 IP；幾個帳號在同一瞬間一起動作不像人，
  // 所以透過中繼站輪流：一次只有一個分頁在打遊戲 API，換人之間的空檔由中繼站決定
  const TURN_ID = `${tabKey}-${Math.random().toString(36).slice(2, 6)}`;
  const TURN_RELAY_TIMEOUT_MILLISECONDS = 2000;
  const TURN_GIVE_UP_MILLISECONDS = 180000;
  const turnTaking = { chain: Promise.resolve(), downUntil: 0, error: '', waitingSince: 0, background: [], transferWaiting: false, held: false, lingerTimer: null, linger: true };
  // 轉移的請求用另一個 id、另一條隊伍：自己分頁的掛機請求正卡在等轉移結束時，轉移不能排在它後面
  const TRANSFER_TURN_ID = `${TURN_ID}-t`;
  let transferTurnChain = Promise.resolve();
  // 不急的讀取（總覽、附近玩家、收入）等這個分頁下次動作時順便送，不另外排隊搶操作權；
  // 分頁停著沒在動作時，最多等這麼久就自己送
  const TURN_BACKGROUND_WAIT_MILLISECONDS = 30000;
  // 一次順便送太多會占住操作權太久，剩下的留給下一次
  const TURN_BACKGROUND_PER_TURN = 4;

  async function askTurnRelay(settings, action, method, { id = TURN_ID, query = '' } = {}) {
    const controller = new AbortController();
    const timer = backgroundTimer.setTimeout(() => controller.abort(), TURN_RELAY_TIMEOUT_MILLISECONDS);
    try {
      const response = await window.fetch(`${dashboardBaseUrl(settings)}/${action}?id=${encodeURIComponent(id)}${query}`, {
        method,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      backgroundTimer.clearTimeout(timer);
    }
  }

  async function takeTurn(settings, { id = TURN_ID, transfer = false } = {}) {
    if (Date.now() < turnTaking.downUntil) return false;
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < TURN_GIVE_UP_MILLISECONDS) {
        const reply = await askTurnRelay(settings, 'turn', 'GET', { id, query: transfer ? '&transfer=1' : '' });
        if (reply.granted) {
          // 別的帳號預約的打怪時間快到了，讀完就交出去，不要佔著
          if (id === TURN_ID) turnTaking.linger = reply.linger !== false;
          turnTaking.error = '';
          turnTaking.waitingSince = 0;
          turnTaking.transferWaiting = false;
          return true;
        }
        turnTaking.waitingSince = turnTaking.waitingSince || startedAt;
        turnTaking.transferWaiting = Boolean(reply.transfer) && !transfer;
        // 轉移時中繼站回很短的等待，掛單到買下的空窗才小
        await wait(Math.min(Math.max(Number(reply.retry) || 500, 50), 1500));
      }
      turnTaking.error = `等了 ${TURN_GIVE_UP_MILLISECONDS / 60000} 分鐘還輪不到，這次直接送`;
    } catch (error) {
      // 中繼站沒開不能讓掛機卡住：先直接送，30 秒後再試
      turnTaking.downUntil = Date.now() + 30000;
      turnTaking.error = error.message === 'HTTP 404'
        ? 'monitor-server.ps1 是舊版，請關掉重開，現在直接送'
        : `連不上中繼站（${error.message}），現在直接送`;
    }
    turnTaking.waitingSince = 0;
    return false;
  }

  // 全體暫停：狀態放在中繼站，每個分頁每 2 秒看一次；暫停時腳本的請求在這裡等，遊戲網頁自己的請求不管
  const GLOBAL_POLL_MILLISECONDS = 2000;
  const globalPause = { mode: 'run', until: 0, checkedAt: 0, error: '' };

  function globalPauseActive() {
    if (globalPause.mode === 'temp' && Date.now() >= globalPause.until) globalPause.mode = 'run';
    return globalPause.mode !== 'run';
  }

  async function waitGlobalResume() {
    while (globalPauseActive()) await wait(1000);
  }

  // 暫停是為了不跟你的操作撞在一起；你自己按面板上的按鈕（讀取角色、讀取材料…）就是要它現在送，
  // 所以按下後這一小段時間的請求不等暫停。開始類（會一直跑下去）和暫停按鈕本身不算
  const MANUAL_REQUEST_MILLISECONDS = 15000;
  const NOT_MANUAL_ACTIONS = ['main-account-me', 'mining-start', 'start', 'forge-start', 'recipe-auto-forge', 'quality-pick', 'global-run', 'global-temp', 'global-stop'];
  let manualRequestUntil = 0;

  function noteManualAction(event, action) {
    if (event.isTrusted && action && !NOT_MANUAL_ACTIONS.includes(action)) manualRequestUntil = Date.now() + MANUAL_REQUEST_MILLISECONDS;
  }

  function applyGlobalPause(reply) {
    globalPause.mode = ['temp', 'stop'].includes(reply.mode) ? reply.mode : 'run';
    // 中繼站和分頁在同一台電腦，時間一樣；還是換算成剩餘時間，免得時鐘差一點
    globalPause.until = reply.mode === 'temp' ? Date.now() + Math.max(0, Number(reply.until) - Number(reply.now)) : 0;
    globalPause.error = '';
    renderGlobalButtons();
  }

  async function pollGlobalPause(settings) {
    if (Date.now() - globalPause.checkedAt < GLOBAL_POLL_MILLISECONDS) return;
    globalPause.checkedAt = Date.now();
    try {
      const response = await window.fetch(`${dashboardBaseUrl(settings)}/global`, { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? 'monitor-server.ps1 是舊版，請關掉重開' : `HTTP ${response.status}`);
      applyGlobalPause(await response.json());
    } catch (error) {
      // 連不上就維持最後知道的狀態：永久暫停時中繼站掛了，也不能自己跑起來跟你的操作撞在一起
      globalPause.error = error.message;
      renderGlobalButtons();
    }
  }

  async function setGlobalPause(settings, mode) {
    const minutes = Math.max(1, Number(settings.globalPauseMinutes) || 10);
    try {
      const response = await window.fetch(`${dashboardBaseUrl(settings)}/global?mode=${mode}&minutes=${minutes}`, { method: 'POST' });
      if (!response.ok) throw new Error(response.status === 404 ? 'monitor-server.ps1 是舊版，請關掉重開' : `HTTP ${response.status}`);
      applyGlobalPause(await response.json());
    } catch (error) {
      // 中繼站連不上時「開始」至少要讓這個分頁自己動起來
      if (mode === 'run') applyGlobalPause({ mode: 'run' });
      setStatus(`全體${{ run: '開始', temp: '暫時暫停', stop: '永久暫停' }[mode]}：連不上中繼站（${error.message}）`);
    }
  }

  function renderGlobalButtons() {
    const mode = globalPauseActive() ? globalPause.mode : 'run';
    panel.querySelectorAll('[data-global-mode]').forEach((button) => {
      if (button.dataset.globalMode === mode) button.dataset.current = mode;
      else delete button.dataset.current;
    });
  }

  function globalMonitorText() {
    const problem = globalPause.error ? `（中繼站：${globalPause.error}）` : '';
    if (!globalPauseActive()) return problem ? `全體：${problem}` : '';
    if (globalPause.mode === 'stop') return `全體：永久暫停中，按「全體 開始」才會繼續${problem}`;
    return `全體：暫時暫停中，${Math.ceil((globalPause.until - Date.now()) / 60000)} 分鐘後自動開始${problem}`;
  }

  // 監控欄「上次動作」：看得出來是不是卡住了。讀取（GET）也記，才分得出是沒動作還是整個沒在跑
  const GAME_ACTION_LABELS = [
    [/\/api\/hunt\?type=forward/, '前進一層'],
    [/\/api\/hunt\?type=back/, '後退一層'],
    [/\/api\/hunt$/, '打怪'],
    [/\/restAll\/complete/, '休息完成'],
    [/\/restAll/, '全隊休息'],
    [/\/api\/move\/complete/, '移動完成'],
    [/\/api\/move/, '移動'],
    [/\/api\/moveForkPath/, '進分支'],
    [/\/api\/forge/, '開爐'],
    [/\/completeForge/, '收爐'],
    [/\/completeAction/, '完成行動'],
    [/\/api\/items\/\d+\/use/, '使用道具'],
    [/\/(un)?equip$/, '換裝'],
    [/\/buy$/, '購買'],
    [/\/sell$/, '掛單'],
    [/\/cancel/, '撤單'],
    [/\/attack/, '攻擊'],
    [/\/(select|deselect)$/, '換隊員'],
  ];
  const lastGameRequest = { actionAt: 0, actionLabel: '', readAt: 0, runningSince: 0 };

  function rememberGameRequest(path, method) {
    if (String(method || 'GET').toUpperCase() === 'GET') {
      lastGameRequest.readAt = Date.now();
      return;
    }
    const plain = String(path).replace(/\?(?!type=).*$/, '');
    const match = GAME_ACTION_LABELS.find(([pattern]) => pattern.test(plain));
    lastGameRequest.actionAt = Date.now();
    lastGameRequest.actionLabel = match ? match[1] : plain.replace(/^\/api\//, '');
  }

  function agoText(at) {
    const seconds = Math.round((Date.now() - at) / 1000);
    if (seconds < 60) return `${seconds} 秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒前`;
    return `${Math.floor(seconds / 3600)} 小時前`;
  }

  // 正在跑、不是在休息或暫停，卻這麼久沒有任何動作，就標出來
  const STUCK_WARNING_MILLISECONDS = 5 * 60000;

  function lastActionText() {
    if (!lastGameRequest.actionAt && !lastGameRequest.readAt) return '上次動作：還沒有';
    const parts = [];
    if (lastGameRequest.actionAt) parts.push(`上次動作：${lastGameRequest.actionLabel}（${agoText(lastGameRequest.actionAt)}）`);
    if (lastGameRequest.readAt) parts.push(`讀取 ${agoText(lastGameRequest.readAt)}`);
    const running = state.running || forgeRunner.running;
    if (!running) lastGameRequest.runningSince = 0;
    else if (!lastGameRequest.runningSince) lastGameRequest.runningSince = Date.now();
    const resting = state.apiResting || Date.now() < lowProfile.breakUntil || Date.now() < lowProfile.sleepUntil;
    const idleFor = Date.now() - Math.max(lastGameRequest.actionAt, lastGameRequest.runningSince);
    if (running && !resting && !globalPauseActive() && idleFor > STUCK_WARNING_MILLISECONDS) parts.push('⚠ 很久沒動作，可能卡住');
    return parts.join('・');
  }

  // 排序總覽：從中繼站拿每個分頁回報的「下一步時間」，照先後排出接下來輪到誰
  const QUEUE_POLL_MILLISECONDS = 5000;
  const queueOverview = { checkedAt: 0, entries: [], error: '' };

  async function pollQueueOverview(settings) {
    if (!settings.dashboardEnabled || Date.now() - queueOverview.checkedAt < QUEUE_POLL_MILLISECONDS) return;
    queueOverview.checkedAt = Date.now();
    try {
      const response = await window.fetch(`${dashboardBaseUrl(settings)}/status`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { now, accounts = [] } = await response.json();
      // 時間換成相對中繼站的現在，分頁之間時鐘差一點也排得對
      queueOverview.entries = accounts
        .filter((account) => account.data && account.data.running && account.data.nextActionAt && now - account.at < 30000)
        .map((account) => ({
          name: `${account.data.nickname || account.id}${account.data.role === 'forge' ? '（鍛造）' : ''}`,
          self: account.id === dashboard.reportingId,
          inMilliseconds: account.data.nextActionAt - now,
          readAt: Date.now(),
        }))
        .sort((first, second) => first.inMilliseconds - second.inMilliseconds);
      queueOverview.error = '';
    } catch (error) {
      queueOverview.error = error.message;
    }
  }

  function inText(milliseconds) {
    const seconds = Math.round(milliseconds / 1000);
    if (seconds <= 0) return '現在';
    if (seconds < 60) return `${seconds} 秒後`;
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒後`;
  }

  function queueMonitorText(settings) {
    if (!settings.dashboardEnabled) return '';
    if (queueOverview.error) return `排序：讀不到（${queueOverview.error}）`;
    if (!queueOverview.entries.length) return '排序：沒有帳號在跑';
    if (globalPauseActive()) return '排序：全體暫停中';
    const marks = ['①', '②', '③', '④', '⑤', '⑥'];
    return `排序：${queueOverview.entries
      .map((entry, index) => {
        const left = entry.inMilliseconds - (Date.now() - entry.readAt);
        return `${marks[index] || index + 1 + '.'}${entry.self ? '★' : ''}${entry.name} ${inText(left)}`;
      })
      .join(' → ')}`;
  }

  function sendGameRequest(path, options = {}) {
    if (globalPauseActive() && Date.now() >= manualRequestUntil) return waitGlobalResume().then(() => sendGameRequest(path, options));
    return sendGameRequestUnpaused(path, options);
  }

  function sendGameRequestUnpaused(path, { background = false, noLinger = false, ...options } = {}) {
    const settings = readSettingsFromPanel();
    if (!settings.turnTakingEnabled) return sendGameRequestNow(path, options);
    if (background) return deferBackgroundRequest(settings, path, options);
    return sendInTurn(settings, path, options, { noLinger });
  }

  // 讀完（GET）先別交出去：同一輪接著要打怪、吃藥，像人看完畫面就按，不用再排一次隊、多等一次換帳號。
  // 送出動作（POST）或這麼久沒下一個請求才交給別的帳號
  const TURN_LINGER_MILLISECONDS = 3000;

  function releaseTurn(settings) {
    turnTaking.held = false;
    return askTurnRelay(settings, 'turn/release', 'POST').catch(() => {});
  }

  function sendInTurn(settings, path, options, { noLinger = false } = {}) {
    // 同一個分頁也一次一個：掛機和鍛造的 GET 不排隊，不串起來就會疊在一起送
    const next = turnTaking.chain.then(async () => {
      backgroundTimer.clearTimeout(turnTaking.lingerTimer);
      if (!turnTaking.held) turnTaking.held = await takeTurn(settings);
      const isRead = String(options.method || 'GET').toUpperCase() === 'GET';
      try {
        return await sendGameRequestNow(path, options);
      } finally {
        await runBackgroundRequests();
        if (turnTaking.held && (!isRead || noLinger || !turnTaking.linger)) await releaseTurn(settings);
        else if (turnTaking.held) {
          // 交出去也排進同一條隊伍，才不會在下一個請求送到一半時放掉
          turnTaking.lingerTimer = backgroundTimer.setTimeout(() => {
            turnTaking.chain = turnTaking.chain.then(() => (turnTaking.held ? releaseTurn(settings) : null));
          }, TURN_LINGER_MILLISECONDS);
        }
      }
    });
    turnTaking.chain = next.catch(() => {});
    return next;
  }

  function deferBackgroundRequest(settings, path, options) {
    return new Promise((resolve, reject) => {
      const item = { path, options, resolve, reject };
      item.timer = backgroundTimer.setTimeout(() => {
        const index = turnTaking.background.indexOf(item);
        if (index < 0) return;
        turnTaking.background.splice(index, 1);
        sendInTurn(settings, path, options).then(resolve, reject);
      }, TURN_BACKGROUND_WAIT_MILLISECONDS);
      turnTaking.background.push(item);
    });
  }

  // 還拿著操作權時接著送，像人按完一下順手看一眼別的畫面
  async function runBackgroundRequests() {
    for (let count = 0; count < TURN_BACKGROUND_PER_TURN && turnTaking.background.length; count++) {
      const item = turnTaking.background.shift();
      backgroundTimer.clearTimeout(item.timer);
      await wait(randomGap(200, 700));
      await sendGameRequestNow(item.path, item.options).then(item.resolve, item.reject);
    }
  }

  // 轉移開始時通知中繼站：之後只有標成轉移的請求拿得到操作權，其他帳號（和自己的掛機、鍛造）先等
  function beginTransferTurn(settings, milliseconds) {
    if (!settings.turnTakingEnabled) return Promise.resolve();
    const mode = settings.transferTurnMode === 'fast' ? 'fast' : 'human';
    return askTurnRelay(settings, 'turn/transfer', 'POST', { id: TRANSFER_TURN_ID, query: `&mode=${mode}&ms=${Math.round(milliseconds)}` }).catch(() => {});
  }

  function endTransferTurn(settings) {
    if (!settings.turnTakingEnabled) return Promise.resolve();
    return askTurnRelay(settings, 'turn/transfer/end', 'POST', { id: TRANSFER_TURN_ID }).catch(() => {});
  }

  // 轉移的一組請求（例如查到掛單接著買）在同一次操作權裡送完，中間不讓別的請求插進來
  function inTransferTurn(settings, run) {
    if (!settings.turnTakingEnabled) return run();
    const next = transferTurnChain.then(async () => {
      const held = await takeTurn(settings, { id: TRANSFER_TURN_ID, transfer: true });
      try {
        return await run();
      } finally {
        if (held) await askTurnRelay(settings, 'turn/release', 'POST', { id: TRANSFER_TURN_ID }).catch(() => {});
      }
    });
    transferTurnChain = next.catch(() => {});
    return next;
  }

  function turnMonitorText(settings) {
    if (!settings.turnTakingEnabled) return '';
    if (turnTaking.error) return `多開輪流：${turnTaking.error}`;
    if (turnTaking.waitingSince && turnTaking.transferWaiting) return `多開輪流：帳號之間轉移中，先暫停（${Math.round((Date.now() - turnTaking.waitingSince) / 1000)} 秒）`;
    if (turnTaking.waitingSince) return `多開輪流：等其他帳號（${Math.round((Date.now() - turnTaking.waitingSince) / 1000)} 秒）`;
    return '多開輪流：開啟';
  }

  async function sendGameRequestNow(path, options = {}) {
    const token = currentGameToken();
    if (!token) throw new Error('還沒取得 token，請在遊戲裡點一下任一分頁再試');
    const controller = new AbortController();
    const timer = backgroundTimer.setTimeout(() => controller.abort(), GAME_REQUEST_TIMEOUT_MILLISECONDS);
    let response;
    let text;
    try {
      response = await window.fetch(path, {
        credentials: 'same-origin',
        ...options,
        signal: controller.signal,
        headers: { ...(options.headers || {}), token },
      });
      text = await response.text();
    } catch (cause) {
      // 網路斷掉、逾時：過一下通常就好，呼叫的一方可以重試
      const error = new Error(cause.name === 'AbortError' ? `${GAME_REQUEST_TIMEOUT_MILLISECONDS / 1000} 秒沒回應` : `連線失敗（${cause.message}）`);
      error.transient = true;
      throw error;
    } finally {
      backgroundTimer.clearTimeout(timer);
    }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}：${text.slice(0, 100)}`);
      error.status = response.status;
      error.transient = response.status >= 500 || response.status === 429;
      // 腳本自己打的 API 遊戲不知道要驗證；遊戲收到這個事件會重抓驗證狀態、把驗證框叫出來
      if (response.status === 403 && /CAPTCHA_REQUIRED/.test(text)) {
        error.captchaRequired = true;
        window.dispatchEvent(new Event('captcha-required'));
      }
      throw error;
    }
    rememberGameRequest(path, options.method);
    return JSON.parse(text);
  }

  function hasApiSupply(settings, { forge = false } = {}) {
    return SUPPLY_GROUPS.some(
      (group) =>
        Boolean(group.forgeOnly) === forge &&
        group.healField &&
        settings[groupKey(group.id, 'ApiEnabled')] &&
        // 狩獵的隊伍要先讀 /api/huntInfo 才知道，所以只看開關；鍛造要有勾角色
        (!forge || Array.from({ length: SLOT_COUNT }, (_, index) => heroIdForSlot(settings, group.id, index)).some(Boolean))
    );
  }

  // 要比掛機間隔下限短，每次行動前才都會重抓；只有剛吃完藥接著判斷時會沿用
  const HERO_STATS_FRESH_MILLISECONDS = 5000;

  // 狩獵看 /api/huntInfo（只有隊伍 4 人）；鍛造的角色不在隊伍裡，改看 /api/heroes（全部角色）
  async function refreshHeroStats({ forge = false, noLinger = false } = {}) {
    const data = await requestGameApi(forge ? HEROES_API : HUNT_INFO_API, { noLinger });
    const heroes = data.heroes || [];
    if (!forge) state.huntInfo = data;
    state.heroStats = new Map(heroes.map((hero) => [hero.id, hero]));
    if (!forge) {
      state.huntTeamIds = heroes.map((hero) => hero.id);
      rememberHuntTeam(heroes);
      renderHuntTeam(heroes);
    }
  }

  function renderHuntTeam(heroes) {
    renderEquipHeroes(heroes);
    const excluded = excludedHuntHeroIds(readSettingsFromPanel());
    panel.querySelector('[data-role="hunt-team"]').innerHTML = heroes.length
      ? heroes
          .map(
            (hero, index) => `<label style="display:block"><input type="checkbox" data-hunt-include value="${hero.id}"
              ${excluded.includes(hero.id) ? '' : 'checked'} style="width:auto;flex:none">
              ${index + 1}. ${escapeHtml(hero.name)}（血 ${hero.hp}/${hero.fullHp}，體力 ${hero.sp}/${hero.fullSp}）</label>`
          )
          .join('')
      : '<div class="hint">隊伍裡沒有角色</div>';
  }

  async function loadHuntTeam() {
    try {
      await refreshHeroStats();
      state.heroStatsAt = Date.now();
      setStatus(`已讀取狩獵隊伍（${state.huntTeamIds.length} 人）`);
    } catch (error) {
      setStatus(`讀取狩獵隊伍失敗（${error.message}）`);
    }
  }

  function equipHeroIds(settings) {
    return String(settings.equipApiHeroIds || '')
      .split(',')
      .map(Number)
      .filter(Boolean);
  }

  function equipAllowedNames(settings) {
    return String(settings.equipApiAllowedNames || '')
      .split(/[,，、]/)
      .map((name) => name.trim())
      .filter(Boolean);
  }

  function renderEquipHeroes(heroes) {
    const selected = equipHeroIds(readSettingsFromPanel());
    panel.querySelector('[data-role="equip-heroes"]').innerHTML = heroes.length
      ? heroes
          .map(
            (hero) => `<label style="display:block"><input type="checkbox" data-equip-hero value="${hero.id}"
              ${selected.includes(hero.id) ? 'checked' : ''} style="width:auto;flex:none"> ${escapeHtml(hero.name)}</label>`
          )
          .join('')
      : '<div class="hint">隊伍裡沒有角色</div>';
  }

  // 不在目前隊伍裡的已勾角色也保留，換隊員回來時不用重勾
  function updateEquipHeroesFromChoices() {
    const inputs = Array.from(panel.querySelectorAll('[data-equip-hero]'));
    const shown = new Set(inputs.map((input) => Number(input.value)));
    const kept = equipHeroIds(readSettingsFromPanel()).filter((heroId) => !shown.has(heroId));
    const checked = inputs.filter((input) => input.checked).map((input) => Number(input.value));
    panel.querySelector('[data-field="equipApiHeroIds"]').value = [...kept, ...checked].join(',');
  }

  // 遊戲裡同名裝備會依品質分開顯示（高級的愛彌斯、普通的愛彌斯），能力差很多，所以用「品質・名稱」分開勾
  function equipmentLabel(equipment) {
    return equipment.quality ? `${equipment.quality}・${equipment.name}` : equipment.name;
  }

  // 舊設定只存名稱，名稱相符也算
  function isAllowedEquipment(allowed, equipment) {
    return !allowed.length || allowed.includes(equipmentLabel(equipment)) || allowed.includes(equipment.name);
  }

  // 同一種裝備通常有好幾件，用「品質・名稱」勾選，之後新做的同種裝備也會自動算進去
  async function showEquipmentChoices() {
    try {
      await refreshEquipments();
    } catch (error) {
      setStatus(`讀取裝備清單失敗（${error.message}）`);
      return;
    }
    const allowed = equipAllowedNames(readSettingsFromPanel());
    const byLabel = new Map();
    state.equipments.forEach((equipment) => {
      const label = equipmentLabel(equipment);
      const entry = byLabel.get(label) || { type: equipment.type, total: 0, idle: 0, best: 0 };
      entry.total++;
      if (equipment.equipped === null && equipment.state === 0) {
        entry.idle++;
        entry.best = Math.max(entry.best, equipment.dur);
      }
      byLabel.set(label, entry);
    });
    panel.querySelector('[data-role="equipment-choices"]').innerHTML = [...byLabel.entries()]
      .sort(([, first], [, second]) => String(first.type).localeCompare(String(second.type)))
      .map(
        ([label, entry]) => `<label style="display:block"><input type="checkbox" data-equipment-choice value="${escapeHtml(label)}"
          ${allowed.includes(label) ? 'checked' : ''} style="width:auto;flex:none">
          ${escapeHtml(label)}（${escapeHtml(entry.type)}，共 ${entry.total} 件，閒置 ${entry.idle}${entry.idle ? `，最高耐久 ${entry.best}` : ''}）</label>`
      )
      .join('');
    setStatus(`裝備清單共 ${state.equipments.length} 件，分成 ${byLabel.size} 種`);
  }

  function updateAllowedEquipmentFromChoices() {
    const checked = Array.from(panel.querySelectorAll('[data-equipment-choice]:checked')).map((input) => input.value);
    panel.querySelector('[data-field="equipApiAllowedNames"]').value = checked.join(', ');
  }

  function updateExcludedHeroesFromChoices() {
    const excluded = Array.from(panel.querySelectorAll('[data-hunt-include]'))
      .filter((input) => !input.checked)
      .map((input) => input.value);
    panel.querySelector('[data-field="huntExcludedHeroIds"]').value = excluded.join(',');
  }

  // 用的時候才判斷資料夠不夠新：過期就重抓，失敗就清掉改讀數值條，不要拿過期的數字判斷
  // API 換裝也要知道狩獵隊伍有誰
  function needsHuntTeam(settings) {
    return hasApiSupply(settings) || Boolean(settings.equipApiEnabled) || Boolean(settings.huntByApiEnabled);
  }

  async function ensureFreshHeroStats(settings, { forge = false } = {}) {
    const needed = forge ? hasApiSupply(settings, { forge }) : needsHuntTeam(settings);
    if (!needed || Date.now() - state.heroStatsAt <= HERO_STATS_FRESH_MILLISECONDS) return;
    try {
      await refreshHeroStats({ forge });
    } catch (error) {
      state.heroStats = new Map();
      setStatus(`讀取角色數值失敗（${error.message}）`);
    }
    state.heroStatsAt = Date.now();
  }

  // 鍛造的角色由使用者從全部角色裡勾，勾選順序填進第 1～4 條
  async function showHeroChoices(groupId) {
    let heroes;
    try {
      heroes = (await requestGameApi(HEROES_API)).heroes || [];
    } catch (error) {
      setStatus(`讀取英雄列表失敗（${error.message}）`);
      return;
    }
    const settings = readSettingsFromPanel();
    const selected = Array.from({ length: SLOT_COUNT }, (_, index) => String(settings[forgeHeroKey(index)]));
    panel.querySelector(`[data-hero-choices="${groupId}"]`).innerHTML = heroes
      .map(
        (hero) => `<label style="display:block"><input type="checkbox" data-hero-choice="${groupId}" value="${hero.id}"
          ${selected.includes(String(hero.id)) ? 'checked' : ''} style="width:auto;flex:none">
          ${escapeHtml(hero.name)}（${escapeHtml(hero.type)}，體力 ${hero.sp}/${hero.fullSp}）</label>`
      )
      .join('');
  }

  function updateHeroIdsFromChoices(groupId) {
    const checked = Array.from(panel.querySelectorAll(`[data-hero-choice="${groupId}"]:checked`)).map((input) => input.value);
    if (checked.length > SLOT_COUNT) setStatus(`最多 ${SLOT_COUNT} 位，只會用前 ${SLOT_COUNT} 個勾選的角色`);
    for (let index = 0; index < SLOT_COUNT; index++) {
      panel.querySelector(`[data-field="${forgeHeroKey(index)}"]`).value = checked[index] || '';
    }
  }

  // 手動操作時開物品欄、每按一次使用之間都會隔一下，照樣隔 1～3 秒
  function itemRequestGap() {
    return 1000 + Math.random() * 2000;
  }

  // 吃藥明細另外記一份，不會被一般紀錄洗掉；存進 localStorage，重新整理後還查得到
  const ITEM_LOG_STORAGE_KEY = 'autoClickerV2ItemLog';
  const ITEM_LOG_LIMIT = 300;
  let itemLogLines = [];
  try {
    itemLogLines = JSON.parse(localStorage.getItem(ITEM_LOG_STORAGE_KEY) || '[]');
  } catch {
    // 讀不到就從空的開始
  }

  function logItemUse(text) {
    const time = new Date().toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    itemLogLines.unshift(`${time} ${text}`);
    itemLogLines.length = Math.min(itemLogLines.length, ITEM_LOG_LIMIT);
    try {
      localStorage.setItem(ITEM_LOG_STORAGE_KEY, JSON.stringify(itemLogLines));
    } catch {
      // 存不了只影響重新整理後能不能查
    }
    renderItemLog();
  }

  function renderItemLog() {
    panel.querySelector('[data-role="item-log"]').value = itemLogLines.join('\n');
  }

  async function copyItemLog() {
    if (!itemLogLines.length) {
      setStatus('還沒有吃藥紀錄');
      return;
    }
    try {
      await navigator.clipboard.writeText(itemLogLines.join('\n'));
      setStatus('已複製吃藥紀錄');
    } catch {
      // 有些環境不允許寫剪貼簿，改成選取文字框讓使用者自己複製
      panel.querySelector('[data-role="item-log"]').select();
      setStatus('無法直接複製，請在吃藥紀錄文字框按 Ctrl+C');
    }
  }

  // 遊戲吃道具就是 POST /api/items/{道具id}/use，body 帶數量與 heroId；畫面上只有「使用」和「使用×10」，所以數量只送 1 或 10。
  // 先 GET 物品欄（等同按「道具」），之後每次使用都依回應裡最新的角色數值重算，補到目標就停
  async function useItemByApi(settings, { group, index }, { onDone = null, isCancelled = null } = {}) {
    const runId = state.runId;
    const cancelled = isCancelled || (() => runId !== state.runId);
    const finish = onDone || (() => continueAfterItem(settings));
    const label = `第 ${index + 1} 條${group.name}`;
    const heroId = heroIdForSlot(settings, group.id, index);
    const names = itemNames(settings, group);
    const targetPercent = settings[groupKey(group.id, 'TargetPercent')];
    let hero = state.heroStats.get(heroId);
    const who = `${label}（${hero ? hero.name : heroId}）`;
    const skipUntilNextAction = (message) => {
      state.itemUsedSlots.add(`${group.id}:${index}`);
      setStatus(`${label}：${message}，這次掛機前先不補`);
      logItemUse(`${who} ✗ ${message}`);
      finish();
    };
    if (!hero) {
      skipUntilNextAction(`狩獵隊伍裡找不到 heroId ${heroId}`);
      return;
    }
    let items;
    try {
      items = (await requestGameApi(ITEMS_API)).items || [];
    } catch (error) {
      if (cancelled()) return;
      skipUntilNextAction(`開啟物品欄失敗（${error.message}）`);
      return;
    }
    if (cancelled()) return;
    const targetValue = (hero[group.fullField] * targetPercent) / 100;
    const startValue = hero[group.heroField];
    const used = [];
    for (let request = 0; request < settings[groupKey(group.id, 'MaxUses')] && hero[group.heroField] < targetValue; request++) {
      const item = pickHealingItem(items, group, names);
      if (!item) break;
      const needed = Math.ceil((targetValue - hero[group.heroField]) / item[group.healField]);
      const quantity = needed >= 10 && item.available >= 10 ? 10 : 1;
      await wait(itemRequestGap());
      if (cancelled()) return;
      let result;
      try {
        result = await requestGameApi(`${ITEMS_API}/${item.id}/use`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantity, heroId }),
        });
      } catch (error) {
        if (cancelled()) return;
        skipUntilNextAction(`使用 ${item.name} 失敗（${error.message}，已吃 ${used.join('、') || '無'}）`);
        return;
      }
      if (cancelled()) return;
      used.push(`${item.name}×${quantity}`);
      const beforeValue = hero[group.heroField];
      // 回應帶回最新的物品欄與角色數值，直接拿來算下一次；萬一沒帶就自己估
      items = (result.items && result.items.items) || items;
      hero = result.hero || {
        ...hero,
        [group.heroField]: Math.min(hero[group.fullField], hero[group.heroField] + quantity * item[group.healField]),
      };
      const remaining = (items.find((candidate) => candidate.id === item.id) || { available: '?' }).available;
      logItemUse(
        `${who} ${item.name}×${quantity}：${group.heroField} ${beforeValue}→${hero[group.heroField]}/${hero[group.fullField]}` +
          `${result.hero ? '' : '（回應沒帶角色數值，估計值）'}，${item.name} 剩 ${remaining}`
      );
      state.heroStats.set(heroId, hero);
      state.heroStatsAt = Date.now();
    }
    const summary = `${startValue}→${hero[group.heroField]}/${hero[group.fullField]}，吃了 ${used.join('、') || '無'}`;
    let outcome;
    if (hero[group.heroField] >= targetValue) {
      outcome = `已補到 ${targetPercent}% 以上`;
    } else if (!pickHealingItem(items, group, names)) {
      state.needRest = true;
      outcome = '沒有可用的道具，稍後全隊休息';
    } else {
      state.itemUsedSlots.add(`${group.id}:${index}`);
      outcome = `送出 ${settings[groupKey(group.id, 'MaxUses')]} 次仍未達 ${targetPercent}%，這次掛機前先不補`;
    }
    setStatus(`${label}：${outcome}（${summary}）`);
    logItemUse(`${who} ＝ ${outcome}（${summary}）`);
    finish();
  }

  const HUNT_API_PATTERN = /\/api\/hunt(?:\?|$)/;
  // 修練等狩獵以外的升級不會出現在戰鬥回應裡；角色列表（遊戲角色頁、鍛造分頁都會讀）帶全部角色的等級，靠它補抓
  const HERO_LIST_PATTERN = /\/api\/heroes(?:[?#]|$)/;
  const EQUIPMENT_LIST_PATTERN = /\/api\/equipments(?:[?#]|$)/;
  const FORGE_START_PATTERN = /\/api\/forge(?:[?#]|$)/;
  const FORGE_COMPLETE_PATTERN = /\/api\/heroes\/(\d+)\/complete(?:Forge|Action)(?:[?#]|$)/;
  const ITEM_LIST_PATTERN = /\/api\/(?:items|mines)(?:[?#]|$)/;
  const ITEM_USE_PATTERN = /\/api\/items\/(\d+)\/use(?:[?#]|$)/;

  // 原地掛機的回應已經帶回打完後的隊伍數值與裝備變化，直接拿來用，下一步就不用再 GET 一次
  // 遊戲隊伍資料每人有 statuses；kind 為 condition 的是異常（中毒、燒傷…），classification 是程度
  const CONDITION_LEVELS = { 輕度: 1, 中度: 2, 重度: 3 };
  function heroConditions(hero) {
    return (Array.isArray(hero.statuses) ? hero.statuses : [])
      .filter((status) => status && status.kind === 'condition' && status.name)
      .map((status) => {
        const level = String(status.classification || '');
        const severity = CONDITION_LEVELS[level] || (/重/.test(level) ? 3 : /中/.test(level) ? 2 : 1);
        return { name: status.name, level, severity };
      });
  }

  // 同一個人同一種同程度的異常只提醒一次；好了之後再中才會再提醒
  const notifiedConditions = new Set();
  function checkHeroConditions(heroes, settings) {
    const alertLevel = Number(settings.statusAlertLevel) || 0;
    const pauseLevel = Number(settings.statusPauseLevel) || 0;
    const active = new Set();
    const pauseTexts = [];
    const alertTexts = [];
    heroes.forEach((hero) =>
      heroConditions(hero).forEach((condition) => {
        const key = `${hero.id}:${condition.name}:${condition.severity}`;
        active.add(key);
        if (notifiedConditions.has(key)) return;
        const text = `${hero.name} ${condition.level}${condition.name}`;
        if (pauseLevel && condition.severity >= pauseLevel) pauseTexts.push(text);
        else if (alertLevel && condition.severity >= alertLevel) alertTexts.push(text);
        else return;
        notifiedConditions.add(key);
      })
    );
    [...notifiedConditions].forEach((key) => {
      if (!active.has(key)) notifiedConditions.delete(key);
    });
    if (pauseTexts.length && state.running && !state.forgeMode) pauseWithAlert(`異常狀態：${[...pauseTexts, ...alertTexts].join('、')}`);
    else if (pauseTexts.length || alertTexts.length) alertUser(`異常狀態：${[...pauseTexts, ...alertTexts].join('、')}`);
  }

  function handleHuntResponse(data, requestBody, url) {
    if (!data || typeof data !== 'object') return;
    if (data.huntInfo) state.huntInfo = data.huntInfo;
    const heroes = data.huntInfo && data.huntInfo.heroes;
    if (Array.isArray(heroes) && !state.forgeMode) {
      state.heroStats = new Map(heroes.map((hero) => [hero.id, hero]));
      state.huntTeamIds = heroes.map((hero) => hero.id);
      state.heroStatsAt = Date.now();
      renderHuntTeam(heroes);
    }
    if (Array.isArray(heroes)) rememberHuntTeam(heroes, huntPlace(data.huntInfo));
    const changes = data.equipmentChanges;
    if (changes && state.equipments.length) {
      const deleted = new Set(changes.deletedIds || []);
      const updated = new Map((Array.isArray(changes.updated) ? changes.updated : []).map((equipment) => [equipment.id, equipment]));
      state.equipments = state.equipments
        .filter((equipment) => !deleted.has(equipment.id))
        .map((equipment) => (updated.has(equipment.id) ? { ...equipment, ...updated.get(equipment.id) } : equipment));
    }
    const settings = readSettingsFromPanel();
    if (Array.isArray(heroes) && !state.forgeMode) checkHeroConditions(heroes, settings);
    if (settings.combatEnabled) recordBattleFromApi(data.report);
    if (settings.huntStatsEnabled) recordHuntStats(data, requestBody, settings, url);
    recordActorLoot(data);
    if (settings.incomeEnabled) {
      recordIncome(data);
      if (activeTab === 'income') renderIncome();
    }
  }

  // 手動換裝時打開裝備欄到按脫下約 2 秒、脫下後挑新裝備再按裝備約 10 秒，照這個節奏等
  function randomGap(minimumMilliseconds, maximumMilliseconds) {
    return minimumMilliseconds + Math.random() * (maximumMilliseconds - minimumMilliseconds);
  }

  const EQUIPMENTS_API = '/api/equipments';
  // 耐久一場只掉一點，30 秒讀一次就夠，也不會每一步都多打一個請求
  const EQUIPMENTS_FRESH_MILLISECONDS = 30000;

  // 失敗也記下時間，免得讀不到時每一步都重試
  async function refreshEquipments() {
    try {
      state.equipments = (await requestGameApi(EQUIPMENTS_API)).equipments || [];
    } finally {
      state.equipmentsAt = Date.now();
    }
  }

  // 監控欄顯示換裝看到了什麼，沒換的時候才看得出是沒勾角色、還沒讀到裝備，還是耐久其實還夠
  function equipMonitorText(settings) {
    const heroIds = equipHeroIds(settings);
    if (!heroIds.length) return '換裝：還沒勾要換裝的角色';
    if (!state.equipments.length) return '換裝：還沒讀到裝備清單（按開始後讀取）';
    const worn = state.equipments.filter((equipment) => heroIds.includes(equipment.equipped));
    if (!worn.length) return '換裝：勾選的角色身上沒有裝備';
    const lowest = worn.reduce((best, equipment) => (equipment.dur < best.dur ? equipment : best));
    const hero = state.heroStats.get(lowest.equipped);
    return `換裝：監控 ${worn.length} 件，最低耐久 ${lowest.dur}（${hero ? hero.name : lowest.equipped} 的${lowest.type}），低於 ${settings.equipApiMinDurability} 換`;
  }

  function findWornEquipmentNeedingSwap(settings) {
    return (
      state.equipments.find(
        (equipment) =>
          equipHeroIds(settings).includes(equipment.equipped) &&
          equipment.dur < settings.equipApiMinDurability &&
          !state.equipApiSkipped.has(equipment.id)
      ) || null
    );
  }

  // 同類型（或同名）、閒置中、耐久夠的裡面挑耐久最高的；同類型才會換到同一個部位
  function findReplacementEquipment(settings, worn) {
    const allowed = equipAllowedNames(settings);
    return state.equipments
      .filter(
        (equipment) =>
          equipment.equipped === null &&
          equipment.state === 0 &&
          equipment.type === worn.type &&
          (!settings.equipApiSameName || equipment.name === worn.name) &&
          isAllowedEquipment(allowed, equipment) &&
          equipment.dur >= settings.equipApiMinDurability
      )
      .reduce((best, equipment) => (!best || equipment.dur > best.dur ? equipment : best), null);
  }

  // 遊戲換裝是 POST /api/equipments/{id}/unequip 與 POST /api/equipments/{id}/equip（body 帶 heroId）；
  // 先脫再穿，不依賴遊戲會不會自動替換同部位；兩個回應都帶回最新的裝備清單
  function equipmentInResult(result, equipmentId) {
    const list = result && Array.isArray(result.equipments) ? result.equipments : null;
    return list ? list.find((equipment) => equipment.id === equipmentId) || null : null;
  }

  // 裝備清單很長，貼紀錄時只看清單以外的欄位（通常是錯誤訊息）與這件裝備的狀態
  function describeEquipResult(result) {
    if (!result || typeof result !== 'object') return String(result);
    const { equipments, ...rest } = result;
    const extra = Object.keys(rest).length ? JSON.stringify(rest).slice(0, 150) : '';
    return extra || (Array.isArray(equipments) ? `清單 ${equipments.length} 件但這件狀態沒變` : '沒有裝備清單');
  }

  async function swapEquipmentByApi(settings, worn) {
    const runId = state.runId;
    const heroId = worn.equipped;
    const hero = state.heroStats.get(heroId);
    const who = `[換裝] ${hero ? hero.name : heroId} 的${worn.type}「${worn.name}」(耐久 ${worn.dur}/${worn.fullDur})`;
    const replacement = findReplacementEquipment(settings, worn);
    if (!replacement) {
      state.equipApiSkipped.add(worn.id);
      logItemUse(`${who} ✗ 沒有可替換的閒置裝備`);
      if (settings.equipApiPauseWhenEmpty) {
        pauseWithAlert(`${hero ? hero.name : heroId} 的${worn.type}耐久 ${worn.dur}，沒有可替換的閒置裝備，已暫停`);
        return;
      }
      setStatus(`${who}：沒有可替換的閒置裝備，本輪不再換`);
      continueAfterItem(settings);
      return;
    }
    const fail = (message) => {
      state.equipApiSkipped.add(worn.id);
      state.equipmentsAt = 0;
      setStatus(`${who}：${message}，本輪不再換`);
      logItemUse(`${who} ✗ ${message}`);
      continueAfterItem(settings);
    };
    // 伺服器可能回 200 但其實沒換（例如回一段錯誤訊息），所以要用回應裡的裝備清單確認真的換了
    try {
      // 照手動流程：按角色的「裝備」時遊戲會先讀 /api/heroes，接著才脫下、再穿上
      await requestGameApi(HEROES_API);
      await wait(randomGap(2000, 4000));
      if (runId !== state.runId) return;
      const result = await requestGameApi(`${EQUIPMENTS_API}/${worn.id}/unequip`, { method: 'POST' });
      const after = equipmentInResult(result, worn.id);
      if (!after || after.equipped !== null) {
        if (runId !== state.runId) return;
        fail(`脫下沒有生效（伺服器回應：${describeEquipResult(result)}）`);
        return;
      }
      state.equipments = result.equipments;
    } catch (error) {
      if (runId !== state.runId) return;
      fail(`脫下失敗（${error.message}）`);
      return;
    }
    try {
      await wait(randomGap(6000, 12000));
      if (runId !== state.runId) return;
      const result = await requestGameApi(`${EQUIPMENTS_API}/${replacement.id}/equip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ heroId }),
      });
      const after = equipmentInResult(result, replacement.id);
      if (!after || after.equipped !== heroId) {
        if (runId !== state.runId) return;
        fail(`已脫下但穿上「${replacement.name}」沒有生效（伺服器回應：${describeEquipResult(result)}），請手動檢查`);
        return;
      }
      state.equipments = result.equipments;
      state.equipmentsAt = Date.now();
    } catch (error) {
      if (runId !== state.runId) return;
      fail(`已脫下但穿上「${replacement.name}」失敗（${error.message}），請手動檢查`);
      return;
    }
    if (runId !== state.runId) return;
    const message = `${who} → 換上「${replacement.name}」(耐久 ${replacement.dur}/${replacement.fullDur})`;
    setStatus(message);
    logItemUse(message);
    continueAfterItem(settings);
  }

  async function useItem(settings, { group, index }, options) {
    if (usesItemApi(settings, group, index)) {
      useItemByApi(settings, { group, index }, options);
      return;
    }
    const runId = state.runId;
    const label = `第 ${index + 1} 條${group.name}`;
    const targetPercent = settings[groupKey(group.id, 'TargetPercent')];
    const stepMilliseconds = settings.itemStepSeconds * 1000;
    const useSelector = settings[slotKey(group.id, 'Use', index)];
    const useText = settings[`${slotKey(group.id, 'Use', index)}Text`];
    const useContext = settings[`${slotKey(group.id, 'Use', index)}Context`];
    // 還沒打開道具欄就看得到使用按鈕，代表有角色的道具介面沒關乾淨；
    // 留著的話點到的「使用」可能是幫別的角色吃藥，或是舊介面裡沒反應的按鈕，所以全部關掉才開，關不掉就不用
    if (openItemUseButtons(settings).size) {
      setStatus(`${label}：道具介面上次沒關乾淨，先關掉再重開`);
      const closed = await closeAllItemMenus(settings, group, index, runId, stepMilliseconds);
      if (runId !== state.runId) return;
      if (!closed) {
        state.itemUsedSlots.add(`${group.id}:${index}`);
        setStatus(`${label}：道具介面關不掉，怕吃到別的角色的藥，這次掛機前先不使用（請替每條設定各自的 X）`);
        continueAfterItem(settings);
        return;
      }
    }
    const staleButtons = new Set(useText ? visibleButtonsWithText(useText) : []);

    if (!clickBySelector(settings[slotKey(group.id, 'Slot', index)])) {
      state.itemUsedSlots.add(`${group.id}:${index}`);
      setStatus(`${label}：找不到道具欄，這次掛機前先略過`);
      continueAfterItem(settings);
      return;
    }
    // 等道具介面打開
    await wait(stepMilliseconds);
    if (runId !== state.runId) return;
    const startPercent = readSlotPercent(settings, group.id, index);
    let highestPercent = startPercent;
    let clickCount = 0;
    let recovered = false;
    let useButtonMissing = false;
    let duplicateNote = '';
    for (let useNumber = 1; useNumber <= settings[groupKey(group.id, 'MaxUses')]; useNumber++) {
      const useButton = await waitForButton(useSelector, useText, useContext, BUTTON_WAIT_MILLISECONDS, runId, {
        allowDuplicates: true,
        exclude: staleButtons,
      });
      if (lastButtonNote) duplicateNote = `，${lastButtonNote}`;
      if (runId !== state.runId) return;
      if (!useButton) {
        useButtonMissing = true;
        break;
      }
      useButton.click();
      clickCount++;
      setStatus(`${label}：使用道具第 ${useNumber} 次`);
      // 等數值更新後再判斷，否則讀到的還是使用前的舊值
      await wait(stepMilliseconds);
      if (runId !== state.runId) return;
      const percent = readSlotPercent(settings, group.id, index);
      if (typeof percent === 'number' && (typeof highestPercent !== 'number' || percent > highestPercent)) {
        highestPercent = percent;
      }
      if (typeof percent === 'number' && percent >= targetPercent) {
        recovered = true;
        break;
      }
    }

    // 沒記到所在列的舊設定看不出介面關了沒，只能照舊點一次就算
    if (!useContext) closeItemMenu(settings[groupKey(group.id, 'CloseSelector')]);
    const closed = await closeAllItemMenus(settings, group, index, runId, stepMilliseconds);
    if (runId !== state.runId) return;
    const closeNote = closed ? '' : '（道具介面關不掉，下次使用前會再試）';
    // 關閉後再等一下才讀，有些遊戲數值要等介面關掉或伺服器回應才會更新
    await wait(stepMilliseconds);
    if (runId !== state.runId) return;
    const endPercent = readSlotPercent(settings, group.id, index);
    if (typeof endPercent === 'number' && (typeof highestPercent !== 'number' || endPercent > highestPercent)) {
      highestPercent = endPercent;
    }
    // 只要過程中數值有升過，就代表道具有效，不算沒道具
    const increased =
      typeof startPercent === 'number' && typeof highestPercent === 'number' && highestPercent > startPercent;
    const noItem = clickCount === 0 ? useButtonMissing : !increased && typeof startPercent === 'number';
    const detail = `（${formatPercents([startPercent])}→${formatPercents([endPercent])}，點了 ${clickCount} 次${
      useButtonMissing ? `，找不到對應的使用按鈕：${lastButtonProblem || '原因不明'}` : duplicateNote
    }）`;
    if (recovered || (typeof endPercent === 'number' && endPercent >= targetPercent)) {
      setStatus(`${label}已回到 ${targetPercent}% 以上，繼續${detail}${closeNote}`);
    } else if (noItem) {
      state.needRest = true;
      setStatus(`${label}判定沒有道具，稍後全隊休息${detail}${closeNote}`);
    } else {
      // 有回升但沒到目標，多半是道具快用完，這次掛機前先跳過這列，免得一直重開道具欄
      state.itemUsedSlots.add(`${group.id}:${index}`);
      setStatus(`${label}使用道具後仍未達 ${targetPercent}%，這次掛機前不再使用${closeNote}`);
    }
    continueAfterItem(settings);
  }

  // 補給是原地掛機／移動前的準備，補完立刻回到流程檢查下一條或接著行動，不用再等一個掛機間隔
  function continueAfterItem(settings) {
    state.timerId = planTick(() => tick(settings), 0);
  }

  // 跳過只限這一次行動前，行動後每條都要重新檢查；留到全隊休息才清，偶發失敗的那條會整輪都不補
  function clearItemSkips() {
    state.itemUsedSlots.clear();
  }

  function pauseIfHealthLow(settings) {
    const healthPercents = readGroupPercents(settings, 'health');
    if (!healthPercents.some((percent) => typeof percent === 'number' && percent < settings.healthPausePercent)) {
      state.healthEscaping = false;
      return false;
    }
    return handleLowHealth(settings, `血條低於 ${settings.healthPausePercent}%`);
  }

  // 避難：把移動目標換成設定的關卡，自動移動會接手走過去
  function isEscapeTarget(settings, prefix) {
    return settings.stageTargetArea === settings[`${prefix}Area`] && Number(settings.stageTargetNumber) === Number(settings[`${prefix}Number`]);
  }

  function escapeTo(settings, prefix, reason) {
    moveTargetTo(settings[`${prefix}Area`], Number(settings[`${prefix}Number`]) || 0, reason);
  }

  function moveTargetTo(area, stage, reason) {
    setPanelField('stageEnabled', true);
    setPanelField('stageTargetArea', area);
    setPanelField('stageTargetNumber', stage);
    const label = targetLabel(readSettingsFromPanel());
    const message = `${reason}，改去 ${label} 掛機`;
    setStatus(message);
    alertUser(message);
    return label;
  }

  // 目前所在的區域與關卡；城鎮或看不出來回傳 null
  function currentPlace(settings) {
    if (isApiHunt(settings)) {
      const info = state.huntInfo;
      if (!info || info.huntZone === undefined || Number(info.huntZone) === 0) return null;
      return { area: loadPlaces().zones[info.huntZone] || info.zoneName || '', stage: Number(info.huntStage) || 0 };
    }
    const location = settings.stageSelector ? readLocation(settings) : null;
    return location && location.area ? { area: location.area.name, stage: location.number || 0 } : null;
  }

  // 前一關：分支的關卡號碼接在母區域後面，退到入口之前就回到母區域（分支裡的分支一路往上找）
  function previousStage(settings, place) {
    if (!place || place.stage <= 1) return null;
    const stage = place.stage - 1;
    const areas = configuredAreas(settings);
    let area = areas.find((candidate) => candidate.name === place.area);
    while (area && area.parent && stage < Number(area.parentStage)) {
      const parentName = area.parent;
      area = areas.find((candidate) => candidate.name === parentName) || { name: parentName };
    }
    return { area: area ? area.name : place.area, stage };
  }

  function isIgnoredPlace(settings, place) {
    if (!place) return false;
    return String(settings.playerIgnoreStages || '')
      .split(/[,，、]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .some((entry) => {
        const [, area, from, to] = /^(.*?)\s*(?:(\d+)\s*(?:[-~～]\s*(\d+))?)?$/.exec(entry);
        if (area.trim() && area.trim() !== place.area) return false;
        if (!from) return Boolean(area.trim());
        return place.stage >= Number(from) && place.stage <= Number(to || from);
      });
  }

  // 判斷不了位置（找不到關卡欄位之類）就當作到了，免得血量低卻一直不暫停
  function arrivedAtTarget(settings) {
    const move = isApiHunt(settings) ? planApiMove(settings) : planMove(settings);
    return move === null || Boolean(move.problem);
  }

  // 血量過低：有設避難就先離開這個關卡，走到避難關卡血量還是低才暫停；回傳 true＝已暫停
  function handleLowHealth(settings, reason) {
    if (settings.healthEscapeEnabled && settings.healthEscapeArea) {
      if (!isEscapeTarget(settings, 'healthEscape')) {
        state.healthEscaping = true;
        escapeTo(settings, 'healthEscape', reason);
        return false;
      }
      // 移動中不會打怪，先讓它走完（途中照常補血）
      if (state.healthEscaping && !arrivedAtTarget(settings)) return false;
    }
    pauseWithAlert(`${reason}，緊急暫停（按開始繼續）`);
    return true;
  }

  // 紅名（遊戲的 nameColor：0 一般、1 橘名、2 紅名）或黑名單玩家跟自己在同一個地方，就換關卡
  const ZONE_USERS_API = '/api/zoneUsers';
  const RED_NAME_COLOR = 2;
  const ZONE_USERS_FRESH_MILLISECONDS = 15000;

  function dangerousPlayers(settings) {
    const blacklist = String(settings.playerBlacklist || '')
      .split(/[,，、]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const ownId = dashboard.profile && dashboard.profile.id;
    return (state.zoneUsers || []).filter(
      (user) =>
        user.id !== ownId &&
        ((settings.playerEscapeRed && user.nameColor === RED_NAME_COLOR) || blacklist.includes(String(user.id)) || blacklist.includes(String(user.nickname || '').trim()))
    );
  }

  // API 打怪看地圖編號 0；按鈕模式看關卡欄位有沒有城鎮名稱
  function inTownNow(settings) {
    if (isApiHunt(settings)) return Boolean(state.huntInfo) && Number(state.huntInfo.huntZone) === 0;
    const town = String(settings.townName || '').trim();
    const location = settings.stageSelector ? readLocation(settings) : null;
    return Boolean(town && location && location.text.includes(town));
  }

  // 躲危險玩家前的掛機關卡和最後一次看到危險玩家的時間；存起來，重新整理後也走得回去
  const PLAYER_RETURN_KEY = 'autoClickerV2PlayerReturn';

  function notePlayerDanger(settings) {
    const saved = readJsonStorage(PLAYER_RETURN_KEY, null);
    writeJsonStorage(
      PLAYER_RETURN_KEY,
      saved && saved.area
        ? { ...saved, dangerAt: Date.now() }
        : { area: settings.stageTargetArea, number: settings.stageTargetNumber, dangerAt: Date.now() }
    );
  }

  function noteEscapedTarget(label) {
    const saved = readJsonStorage(PLAYER_RETURN_KEY, null);
    if (saved) writeJsonStorage(PLAYER_RETURN_KEY, { ...saved, escapedTo: label });
  }

  // 一段時間沒再看到危險玩家就走回原本的關卡；中間自己改過目標就當作不用回去
  function returnAfterPlayerEscape(settings) {
    const saved = readJsonStorage(PLAYER_RETURN_KEY, null);
    if (!saved || !saved.area || !settings.playerEscapeEnabled || !settings.playerReturnEnabled) return false;
    const here = targetLabel(settings);
    const original = targetLabel({ stageTargetArea: saved.area, stageTargetNumber: saved.number });
    if ((saved.escapedTo && saved.escapedTo !== here) || original === here) {
      writeJsonStorage(PLAYER_RETURN_KEY, null);
      return false;
    }
    const minutes = Math.max(1, Number(settings.playerReturnMinutes) || 0);
    if (Date.now() - saved.dangerAt < minutes * 60000) return false;
    writeJsonStorage(PLAYER_RETURN_KEY, null);
    state.playerEscapeTarget = '';
    setPanelField('stageEnabled', true);
    setPanelField('stageTargetArea', saved.area);
    setPanelField('stageTargetNumber', saved.number);
    const message = `${minutes} 分鐘沒再遇到危險玩家，走回原本的 ${original}`;
    setStatus(message);
    showToast(message);
    return true;
  }

  // 回傳 true＝換了目標，這一步先不做別的
  function escapeFromPlayers(settings) {
    // 城鎮不管（沒有關卡可以退，紅名在城裡很常見）；還在往目標走（路過的關卡，或剛換目標正在走）也不管，到了目標才看
    if (!settings.playerEscapeEnabled || inTownNow(settings) || !arrivedAtTarget(settings)) return false;
    const place = currentPlace(settings);
    // 認不出在哪一關（移動途中、按鈕模式讀不到關卡欄位）：拿到的玩家名單多半是上一個地方的，也沒有關可以退，不判斷
    if (!place || !place.stage) return false;
    const found = isIgnoredPlace(settings, place) ? [] : dangerousPlayers(settings);
    if (!found.length) {
      state.playerAlertKey = '';
      return false;
    }
    notePlayerDanger(settings);
    const names = found.map((user) => `${user.nickname || user.id}${user.nameColor === RED_NAME_COLOR ? '（紅名）' : ''}`).join('、');
    const reason = `同地圖有危險玩家：${names}`;
    // 目標是自己剛換的（已經避難或退過）就不再回避難關卡，免得在兩個有人的地方來回跑
    const escaped = state.playerEscapeTarget === targetLabel(settings) || isEscapeTarget(settings, 'playerEscape');
    if (!escaped && settings.playerEscapeMode === 'escape' && settings.playerEscapeArea) {
      escapeTo(settings, 'playerEscape', reason);
      state.playerEscapeTarget = targetLabel(readSettingsFromPanel());
      noteEscapedTarget(state.playerEscapeTarget);
      return true;
    }
    const back = previousStage(settings, place);
    if (back) {
      state.playerEscapeTarget = moveTargetTo(back.area, back.stage, `${reason}，往回退一關`);
      noteEscapedTarget(state.playerEscapeTarget);
      return true;
    }
    if (state.playerAlertKey !== names) {
      state.playerAlertKey = names;
      alertUser(`${reason}（已經退到第 1 關，留在原地）`);
    }
    return false;
  }

  // 換了地方，上一個地方的玩家名單不能再用，到了馬上重讀
  function forgetZoneUsers() {
    state.zoneUsers = [];
    state.zoneUsersAt = 0;
  }

  async function refreshZoneUsers() {
    // 不能延後順便送：tick 會等這個讀完才繼續，延後的話要等下一個動作，而下一個動作又在等它
    const data = await requestGameApi(ZONE_USERS_API);
    state.zoneUsers = (data && data.users) || [];
  }

  // 只在原地掛機前檢查：休息中體力本來就低，在監控迴圈裡檢查會一休息就停。
  // 補給後還是這麼低，多半是道具用完或點錯介面，停下來讓人看
  function pauseIfResourceLow(settings) {
    if (!settings.resourcePausePercent) return false;
    const lowSlots = readGroupPercents(settings, 'resource')
      .map((percent, index) => ({ percent, index }))
      .filter(({ percent }) => typeof percent === 'number' && percent < settings.resourcePausePercent);
    if (!lowSlots.length) return false;
    const detail = lowSlots.map(({ percent, index }) => `第 ${index + 1} 條 ${Math.round(percent)}%`).join('、');
    pauseWithAlert(`原地掛機前體力過低（${detail}，低於 ${settings.resourcePausePercent}%），可能是道具用完或補給失敗，請檢查`);
    return true;
  }

  function readExpPercents(settings) {
    return splitSelectors(settings.expSelectors).map(readPercent);
  }

  function pauseIfExpHigh(settings) {
    if (!settings.expPauseEnabled) return false;
    const expPercents = readExpPercents(settings);
    if (!expPercents.some((percent) => typeof percent === 'number' && percent >= settings.expPausePercent)) {
      return false;
    }
    pauseWithAlert(`經驗達 ${settings.expPausePercent}%，已暫停，練完等再按開始`);
    return true;
  }

  function countOccurrences(text, keyword) {
    return text.split(keyword).length - 1;
  }

  // 用整頁「看得到的文字」找關鍵字，不限定彈窗的結構；
  // 面板與提示視窗自己也會顯示關鍵字，所以要扣掉這兩處的次數
  function isVerificationShown(settings) {
    if (!settings.verifyEnabled || !settings.verifyKeyword) return false;
    const keyword = settings.verifyKeyword;
    const ownCount = countOccurrences(panel.innerText, keyword) + countOccurrences(alertDialog.innerText, keyword);
    return countOccurrences(document.body.innerText, keyword) > ownCount;
  }

  // 自動繼續時還卡在淡出的驗證框元素；分頁回到前景前都會留著，暫停檢查要略過，否則一繼續馬上又停
  let dismissedVerifyElements = new Set();

  function pauseIfVerification(settings) {
    if (!isVerificationShown(settings)) return false;
    if (dismissedVerifyElements.size) {
      const elements = verificationTextElements(settings.verifyKeyword);
      if (elements.length && elements.every((element) => dismissedVerifyElements.has(element))) return false;
      dismissedVerifyElements = new Set();
    }
    holdForgeForCaptcha();
    const resumeMode = state.forgeMode;
    const afterVerify = settings.verifyAutoResume ? '，完成後會自動繼續' : '後按開始';
    pauseWithAlert(`偵測到「${settings.verifyKeyword}」，請手動完成驗證${afterVerify}`);
    // pauseWithAlert 裡的 stop 會清掉，所以要在之後才記
    state.verifyResumeMode = resumeMode;
    state.verifyGoneSince = 0;
    return true;
  }

  const VERIFY_RESUME_DELAY_MILLISECONDS = 3000;
  // Vue 的 xxx-leave-active、React 的 xxx-exit 這類關閉動畫用的 class
  const LEAVING_CLASS_PATTERN = /[-_](?:leave|exit)(?:[-_]|$)/i;

  // 分頁在背景時瀏覽器會暫停動畫，驗證框的淡出播不完就一直留在 DOM 裡；
  // 已經在淡出（透明、隱藏或掛著關閉動畫的 class）的就當作關掉了
  function isFadingOut(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || Number(style.opacity) < 0.05) return true;
      const classes = (node.getAttribute('class') || '').split(/\s+/);
      if (classes.some((name) => LEAVING_CLASS_PATTERN.test(name))) return true;
    }
    return false;
  }

  function verificationTextElements(keyword) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const elements = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || !node.nodeValue.includes(keyword)) continue;
      if (panel.contains(element) || alertDialog.contains(element) || !isVisible(element)) continue;
      elements.push(element);
    }
    return elements;
  }

  // 只用在「等驗證框消失」：出現時不能這樣判斷，背景中剛彈出的框可能卡在淡入（透明）的狀態。
  // 關鍵字被拆在好幾個元素裡找不到文字節點時，照原本整頁文字的判斷
  function isVerificationStillShown(settings) {
    if (!isVerificationShown(settings)) return false;
    const elements = verificationTextElements(settings.verifyKeyword);
    return elements.length === 0 || !elements.every(isFadingOut);
  }

  // 只接續被驗證框停下的那次執行；本來就沒在跑、或是手動停止的都不會動
  function resumeIfVerificationGone(settings) {
    if (state.captchaWaiting) {
      resumeIfCaptchaCleared(settings);
      return;
    }
    if (state.verifyResumeMode === null || !settings.verifyAutoResume || !settings.verifyEnabled) return;
    if (isVerificationStillShown(settings)) {
      state.verifyGoneSince = 0;
      return;
    }
    if (!state.verifyGoneSince) state.verifyGoneSince = Date.now();
    if (Date.now() - state.verifyGoneSince < VERIFY_RESUME_DELAY_MILLISECONDS) return;
    resumeAfterVerification(settings, `「${settings.verifyKeyword}」已消失`);
  }

  // API 被要求驗證時畫面不一定有驗證框，改問伺服器 /api/captcha：沒有待完成的驗證（pendingCaptchaId 空的）就算完成
  const CAPTCHA_POLL_MILLISECONDS = 8000;
  // 同一個分頁的掛機和 API 鍛造：任一邊遇到活人驗證就兩邊都先停，驗證完各自接著做（鍛造會自己問 /api/captcha）
  function holdForgeForCaptcha() {
    if (!forgeRunner.running || forgeRunner.captchaWaiting) return;
    forgeRunner.captchaWaiting = true;
    forgeRunner.captchaCheckedAt = 0;
    forgeLog('掛機遇到活人驗證，鍛造也先停，完成後會自動繼續');
  }

  function pauseForCaptcha(settings) {
    holdForgeForCaptcha();
    const resumeMode = state.forgeMode;
    const afterVerify = settings.verifyAutoResume ? '，完成後會自動繼續' : '後按開始';
    pauseWithAlert(`伺服器要求活人驗證，請完成驗證${afterVerify}`);
    // pauseWithAlert 裡的 stop 會清掉，所以要在之後才記
    state.verifyResumeMode = resumeMode;
    state.verifyGoneSince = 0;
    state.captchaWaiting = true;
    state.captchaCheckedAt = 0;
  }

  async function resumeIfCaptchaCleared(settings) {
    if (!state.captchaWaiting || state.verifyResumeMode === null) {
      state.captchaWaiting = false;
      return;
    }
    if (!settings.verifyAutoResume || Date.now() - state.captchaCheckedAt < CAPTCHA_POLL_MILLISECONDS) return;
    state.captchaCheckedAt = Date.now();
    try {
      const captcha = await requestGameApi('/api/captcha');
      if (captcha && captcha.pendingCaptchaId) return;
    } catch {
      return;
    }
    if (!state.captchaWaiting || state.verifyResumeMode === null) return;
    state.captchaWaiting = false;
    resumeAfterVerification(settings, '驗證已完成');
  }

  function resumeAfterVerification(settings, reason) {
    const forgeMode = state.verifyResumeMode;
    state.verifyResumeMode = null;
    // 還留在畫面上的驗證框（淡出中，或其他分頁已解掉但這頁沒關）之後都略過，否則一繼續馬上又停
    dismissedVerifyElements = new Set(verificationTextElements(settings.verifyKeyword));
    clearAlert();
    // 不走 start()：start 會把輪數、鍛造進度歸零，這裡要接著原本的進度跑
    state.running = true;
    state.forgeMode = forgeMode;
    rememberTabRole(forgeMode);
    setStatus(`${reason}，自動繼續${forgeMode ? '鍛造' : '掛機'}`);
    tick(settings);
  }

  // 同一個帳號開好幾個分頁時，驗證在任一分頁完成就全部解除；但沒在看的分頁驗證框不會自己關，
  // 所以驗證框消失的分頁要通知其他分頁，收到的分頁當作驗證已完成
  const tabChannel = (() => {
    try {
      return new BroadcastChannel('autoClickerV2');
    } catch {
      return null;
    }
  })();
  // 這個分頁看過「還沒處理的」驗證框；之後它消失了，代表驗證是在這裡完成的
  let verificationSeen = false;

  function announceVerificationSolved(settings) {
    if (!tabChannel || !settings.verifyEnabled || !settings.verifyKeyword) return;
    if (isVerificationStillShown(settings)) {
      const elements = verificationTextElements(settings.verifyKeyword);
      // 已略過的舊框不算，否則那個分頁之後回到前景、舊框關掉時會誤發通知
      if (elements.length === 0 || elements.some((element) => !dismissedVerifyElements.has(element))) verificationSeen = true;
      return;
    }
    if (!verificationSeen) return;
    verificationSeen = false;
    tabChannel.postMessage({ type: 'verification-solved' });
  }

  if (tabChannel) {
    tabChannel.onmessage = (event) => {
      if (!event.data || event.data.type !== 'verification-solved') return;
      const settings = readSettingsFromPanel();
      if (state.verifyResumeMode === null || !settings.verifyAutoResume || !settings.verifyEnabled) return;
      verificationSeen = false;
      resumeAfterVerification(settings, '其他分頁已完成驗證');
    };
  }

  // 自動暫停都需要人回來處理，人可能不在這個分頁，所以依「提醒」頁的勾選用多種方式提醒
  function pauseWithAlert(message) {
    dashboard.alert = message;
    stop(message);
    alertUser(message, { paused: true });
  }

  let audioContext = null;
  let titleFlashTimer = null;
  let originalTitle = document.title;

  // 瀏覽器規定聲音要在使用者操作時才能啟用，所以在按「開始」或「試聽」時先準備好
  function ensureAudio() {
    try {
      audioContext = audioContext || new AudioContext();
      audioContext.resume();
    } catch {
      // 不支援就只剩其他提醒方式
    }
  }

  function prepareAlerts(settings) {
    ensureAudio();
    if (settings.alertNotifyEnabled && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function playBeeps(volumePercent) {
    if (!audioContext) return;
    for (let beep = 0; beep < 3; beep++) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = (volumePercent / 100) * 0.6;
      oscillator.connect(gain).connect(audioContext.destination);
      const startAt = audioContext.currentTime + beep * 0.35;
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.2);
    }
  }

  // 關掉面板＝這個分頁不要用腳本：停掉執行、通知總覽拿掉卡片，之後監控迴圈、API 錄製、戰鬥處理都不再動作。
  // 成長值例外：使用者手動玩照樣會升級，關掉也要繼續記
  let tabShutDown = false;

  function shutDownTab() {
    const settings = readSettingsFromPanel();
    if (state.running || state.verifyResumeMode !== null) stop('面板已關閉，腳本停止');
    stopForgeRunner('面板已關閉，鍛造停止');
    apiRecorder.recording = false;
    apiRecorder.heroCapture = null;
    leaveDashboard(settings);
    tabShutDown = true;
    clearAlert();
    panel.style.display = 'none';
  }

  // 只提醒（異常狀態、稀有掉落沒設暫停）時腳本照跑，標題不能寫「已暫停」，不然會以為停了
  let alertTitle = '⚠ 愛吉吉已暫停';
  function alertUser(message, { paused = false } = {}) {
    const settings = readSettingsFromPanel();
    alertTitle = `⚠ ${appName()}${paused ? '已暫停' : '提醒（仍在執行）'}`;
    alertDialog.querySelector('[data-role="alert-title"]').textContent = alertTitle;
    // 面板被關掉時也要讓人看得到暫停原因，所以暫停就把面板叫回來
    panel.style.display = '';
    if (settings.alertRedEnabled) panel.setAttribute('data-alerting', '');
    if (settings.alertSoundEnabled) playBeeps(settings.alertVolume);
    if (settings.alertPopupEnabled) {
      alertDialog.querySelector('[data-role="alert-message"]').textContent = message;
      alertDialog.style.display = 'block';
    }
    if (settings.alertNotifyEnabled) {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(alertTitle.replace('⚠ ', ''), { body: message });
      }
      startTitleFlash();
    }
  }

  // 瀏覽器允許的話也跳系統通知（Windows 在右下角），切到別的視窗也看得到
  function showToast(message) {
    const toast = document.createElement('div');
    toast.textContent = `${appName()}：${message}`;
    toast.title = '點一下關掉';
    Object.assign(toast.style, {
      background: '#2a2a30', color: '#fff', border: '1px solid #e0a020', borderRadius: '8px',
      padding: '10px 12px', boxShadow: '0 4px 16px rgba(0,0,0,.4)', cursor: 'pointer',
    });
    toast.addEventListener('click', () => toast.remove());
    toastBox.appendChild(toast);
    setTimeout(() => toast.remove(), 15000);
    if ('Notification' in window && Notification.permission === 'granted') new Notification(`${appName()}提醒`, { body: message });
  }

  function clearAlert() {
    dashboard.alert = '';
    panel.removeAttribute('data-alerting');
    alertDialog.style.display = 'none';
    stopTitleFlash();
  }

  function startTitleFlash() {
    if (titleFlashTimer) return;
    originalTitle = document.title;
    let showWarning = false;
    titleFlashTimer = setInterval(() => {
      showWarning = !showWarning;
      document.title = showWarning ? alertTitle : originalTitle;
    }, 1000);
  }

  function stopTitleFlash() {
    if (!titleFlashTimer) return;
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
    document.title = originalTitle;
  }

  window.addEventListener('focus', stopTitleFlash);

  // 分頁標題前面加「帳號名稱｜」（有勾顯示帳號名稱時），分頁上一眼看出是哪個帳號；
  // 結尾再加一段看不見的帳號 id 標記，總覽頁點帳號名稱時中繼站靠它找到這個瀏覽器視窗（不管有沒有顯示名稱）
  const TITLE_MARK = '｜';
  const TITLE_ID_PATTERN = /\u2063[\u200b\u200c]*\u2063$/;
  let appliedTitlePrefix = '';

  function titleIdMarker() {
    const id = dashboard.profile && Number(dashboard.profile.id);
    if (!id) return '';
    return `\u2063${id.toString(2).replace(/0/g, '\u200b').replace(/1/g, '\u200c')}\u2063`;
  }

  function applyTitlePrefix() {
    // 標題閃爍提醒時不要搶著改，停下來時會還原成帶前綴的標題
    if (titleFlashTimer) return;
    const nickname = dashboard.profile && dashboard.profile.nickname;
    const prefix = nickname && readSettingsFromPanel().showAccountName ? `${nickname}${TITLE_MARK}` : '';
    const current = document.title;
    let base = current.replace(TITLE_ID_PATTERN, '');
    if (appliedTitlePrefix && base.startsWith(appliedTitlePrefix)) base = base.slice(appliedTitlePrefix.length);
    appliedTitlePrefix = prefix;
    const wanted = prefix + base + titleIdMarker();
    if (current !== wanted) document.title = wanted;
  }

  function titleNeedsMarks() {
    return (appliedTitlePrefix && !document.title.startsWith(appliedTitlePrefix)) || !document.title.endsWith(titleIdMarker());
  }

  // 遊戲自己換標題（切頁面）時再補上；監控每秒也檢查一次，萬一漏掉
  new MutationObserver(() => {
    if (dashboard.profile && titleNeedsMarks()) applyTitlePrefix();
  }).observe(document.head, { subtree: true, childList: true, characterData: true });

  // 看血條的「目前值」是不是 0，不看百分比門檻；門檻設 0 或補血流程先動時也擋得住
  function pauseIfDeath(settings) {
    if (!settings.deathPauseEnabled) return false;
    for (let index = 0; index < SLOT_COUNT; index++) {
      // API 補給的條可能沒選數值條，改看 /api/huntInfo 的資料
      const hero = state.heroStats.get(state.huntTeamIds[index]);
      if ((hero && (hero.perished || hero.hp === 0)) || readNumber(settings[slotKey('health', 'Bar', index)]) === 0) {
        pauseWithAlert(`第 ${index + 1} 條血條血量 0，有人死亡，已暫停`);
        return true;
      }
    }
    return false;
  }

  function shouldPause(settings) {
    return (
      pauseIfVerification(settings) || pauseIfDeath(settings) || pauseIfHealthLow(settings) || pauseIfExpHigh(settings)
    );
  }

  function configuredAreas(settings) {
    return Array.from({ length: AREA_COUNT }, (_, areaIndex) => {
      const key = (name) => settings[areaKey(areaIndex, name)];
      return {
        name: String(key('Name') || '').trim(),
        parent: String(key('Parent') || '').trim(),
        parentStage: key('ParentStage'),
        enter: key('Enter'),
        enterText: key('EnterText'),
        returnSelector: key('Return'),
        returnText: key('ReturnText'),
      };
    }).filter((area) => area.name);
  }

  // 從關卡欄位文字認出目前在哪個區域、第幾關。名稱長的先比，避免短名稱剛好是長名稱的一部分
  function readLocation(settings) {
    let text = null;
    try {
      const element = settings.stageSelector ? document.querySelector(settings.stageSelector) : null;
      text = element ? element.textContent.trim() : null;
    } catch {
      // selector 格式錯誤就當作找不到
    }
    if (text === null) return null;
    const area = configuredAreas(settings)
      .sort((first, second) => second.name.length - first.name.length)
      .find((candidate) => text.includes(candidate.name));
    if (!area) return { text, area: null, number: null };
    const afterName = text.slice(text.indexOf(area.name) + area.name.length);
    const number = afterName.match(/\d+/);
    return { text, area, number: number ? Number(number[0]) : null };
  }

  function targetLabel(settings) {
    return `${settings.stageTargetArea}${settings.stageTargetNumber ? ` ${settings.stageTargetNumber}` : ''}`;
  }

  // 規劃下一步怎麼走。回傳 null＝已到達或沒開自動移動；{ problem }＝沒辦法走；
  // 否則回傳要按的按鈕。每次只走一步，按完要等「完成移動」，下一輪再重新判斷
  function planMove(settings) {
    if (!settings.stageEnabled || !settings.stageSelector || !settings.stageTargetArea) return null;
    const location = readLocation(settings);
    if (!location) return { problem: '找不到關卡欄位' };
    const townName = String(settings.townName || '').trim();
    const inTown = Boolean(townName) && location.text.includes(townName);
    // 目標設成城鎮＝要回城；回城在任何地方都能按
    if (townName && settings.stageTargetArea.trim() === townName) {
      if (inTown) return null;
      const from = `目前「${location.text}」→ 目標「${townName}」`;
      return { from, label: '回城', selector: settings.stageTown, text: settings.stageTownText || '回城' };
    }
    const areas = configuredAreas(settings);
    const target = areas.find((area) => area.name === settings.stageTargetArea.trim());
    if (!target) return { problem: `區域表裡沒有「${settings.stageTargetArea}」` };
    const from = `目前「${location.text}」→ 目標「${targetLabel(settings)}」`;
    // 進入按鈕沒選取時，用區域名稱當按鈕文字找（例如城鎮裡的「大草原」按鈕）
    const enter = (area) => ({ from, label: `進入${area.name}`, selector: area.enter, text: area.enterText || area.name });

    // 在城鎮就直接前往目標所在的大區；目標是分支地圖時先去它的母大區
    if (inTown) {
      const bigArea = target.parent ? areas.find((area) => area.name === target.parent) : target;
      if (!bigArea) return { problem: `區域表裡沒有「${target.name}」的母區域「${target.parent}」` };
      return { ...enter(bigArea), label: `從${townName}前往${bigArea.name}` };
    }

    if (!location.area) return { problem: `看不出「${location.text}」是區域表裡的哪個區域` };
    const here = location.area;
    const stepToward = (stageNumber) => {
      if (location.number === null) return { problem: `${from}：看不出目前是第幾關` };
      return location.number < stageNumber
        ? { from, label: '前行', selector: settings.selectorD, text: settings.selectorDText || '前行' }
        : { from, label: '後退', selector: settings.stageBack, text: settings.stageBackText || '後退' };
    };

    if (here.name === target.name) {
      // 沒填目標關卡就進去算到達；分支有的只是一張地圖（看不到關卡數字）也算到達，
      // 但像草原秘境有分關的，要照數字走到目標關
      if (!settings.stageTargetNumber || location.number === settings.stageTargetNumber) return null;
      if (target.parent && location.number === null) return null;
      return stepToward(settings.stageTargetNumber);
    }
    // 在別的子區域裡，先回母區域
    if (here.parent) {
      return { from, label: `返回${here.parent}`, selector: here.returnSelector, text: here.returnText };
    }
    if (target.parent) {
      const parent = areas.find((area) => area.name === target.parent);
      if (!parent) return { problem: `區域表裡沒有「${target.name}」的母區域「${target.parent}」` };
      if (here.name !== parent.name) return enter(parent);
      if (location.number !== target.parentStage) return stepToward(target.parentStage);
      return enter(target);
    }
    return enter(target);
  }

  // 剛移動完遊戲會要求先按「完成移動」才能做別的事，所以每次動作前畫面上有就直接按，不等。
  // 沒選取這顆按鈕時，用預設文字「完成移動」找
  const FINISH_MOVE_DEFAULT_TEXT = '完成移動';

  // 低調模式：休息時間是這個分頁自己的，掛機和 API 鍛造一起休息
  const lowProfile = { sessionEnd: 0, breakUntil: 0, sleepUntil: 0, reaction: null, checkin: null, nextCheckinAt: 0 };

  // 同一個字串永遠得到同一串亂數：帳號個性、每天的睡覺時間重新整理後才不會變
  function seededRandom(text) {
    let seed = 2166136261;
    for (const character of String(text)) seed = Math.imul(seed ^ character.codePointAt(0), 16777619);
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 每個帳號固定一組節奏，三個帳號開同樣的設定也不會步調一致
  function accountPersonality() {
    const profile = dashboard.profile || {};
    const random = seededRandom(`personality:${profile.nickname || profile.id || ''}`);
    const personality = {
      speed: 0.75 + random() * 0.6,
      distractChance: 0.03 + random() * 0.05,
      play: 0.8 + random() * 0.45,
      rest: 0.8 + random() * 0.5,
      sleepShiftMinutes: Math.round(random() * 180 - 90),
    };
    // 三個帳號同步＝同一個人：玩多久、休息多久、幾點睡用同一組，手速和分心還是各視窗自己的
    if (readSettingsFromPanel().syncAccountsEnabled) {
      const shared = seededRandom('personality:shared');
      personality.play = 0.8 + shared() * 0.45;
      personality.rest = 0.8 + shared() * 0.5;
      personality.sleepShiftMinutes = Math.round(shared() * 180 - 90);
    }
    return personality;
  }

  function lowProfilePersonalityText() {
    const personality = accountPersonality();
    const shift = personality.sleepShiftMinutes;
    return `這個帳號的節奏：手速 ×${(1 / personality.speed).toFixed(2)}、分心 ${Math.round(personality.distractChance * 100)}%、玩 ×${personality.play.toFixed(2)}、休息 ×${personality.rest.toFixed(2)}、睡覺${shift >= 0 ? '晚' : '早'} ${Math.abs(shift)} 分鐘`;
  }

  function lowModeOf(settings) {
    if (!settings.lowProfileEnabled) return 'off';
    return ['casual', 'auto'].includes(settings.lowProfileStyle) ? settings.lowProfileStyle : 'serious';
  }

  // 「20-24」「12-13,20-24」＝這些時段認真玩；每天邊界前後飄 30 分鐘，三個帳號同步時一起飄
  function seriousRanges(settings, now) {
    return hourRanges(settings.lowProfileSeriousHours, 'serious', 30, settings, now);
  }

  // 「9-12,14-17」完全休息：時段內回傳結束時間，否則 0
  function offHoursEndAt(settings, now) {
    const range = hourRanges(settings.lowProfileOffHours, 'off', 15, settings, now).find(([start, end]) => now >= start && now < end);
    return range ? range[1] : 0;
  }

  function hourRanges(text, seedName, jitterMinutes, settings, now) {
    const profile = dashboard.profile || {};
    const who = settings.syncAccountsEnabled ? 'shared' : profile.nickname || profile.id || '';
    const ranges = [];
    String(text || '')
      .split(/[,，、\s]+/)
      .filter(Boolean)
      .forEach((part, index) => {
        const match = part.match(/^(\d{1,2}(?:\.\d+)?)[-~～](\d{1,2}(?:\.\d+)?)$/);
        if (!match) return;
        const from = Number(match[1]);
        const to = Number(match[2]);
        for (const dayOffset of [-1, 0, 1]) {
          const day = new Date(now);
          day.setDate(day.getDate() + dayOffset);
          day.setHours(0, 0, 0, 0);
          const random = seededRandom(`${seedName}:${who}:${index}:${day.toDateString()}`);
          const jitter = () => (random() * 2 - 1) * jitterMinutes;
          const start = day.getTime() + (from * 60 + jitter()) * 60000;
          const end = day.getTime() + ((to <= from ? to + 24 : to) * 60 + jitter()) * 60000;
          ranges.push([start, end]);
        }
      });
    return ranges;
  }

  function effectiveLowStyle(settings, now = Date.now()) {
    if (settings.lowProfileStyle !== 'auto') return settings.lowProfileStyle === 'casual' ? 'casual' : 'serious';
    return seriousRanges(settings, now).some(([start, end]) => now >= start && now < end) ? 'serious' : 'casual';
  }

  // 自動玩法：休閒離開中最晚在認真時段開始時醒來
  function nextSeriousStart(settings, now) {
    if (settings.lowProfileStyle !== 'auto') return Infinity;
    const starts = seriousRanges(settings, now)
      .map(([start]) => start)
      .filter((start) => start > now);
    return starts.length ? Math.min(...starts) : Infinity;
  }

  function renderLowModeButtons() {
    const mode = lowModeOf(readSettingsFromPanel());
    panel.querySelectorAll('[data-low-mode]').forEach((button) => button.toggleAttribute('data-low-current', button.dataset.lowMode === mode));
  }

  // 面板上方的快速切換：三個帳號同步時順便送給其他帳號
  function setLowMode(mode) {
    setPanelField('lowProfileEnabled', mode !== 'off');
    if (mode !== 'off') setPanelField('lowProfileStyle', mode);
    const settings = readSettingsFromPanel();
    saveSettings(settings);
    if (settings.syncAccountsEnabled) pushSharedSettings(settings);
    setStatus(`低調模式：${{ off: '關', serious: '認真玩', casual: '休閒', auto: '自動（認真時段認真玩，其他休閒）' }[mode]}${settings.syncAccountsEnabled ? '（三個帳號一起換）' : ''}`);
  }

  // 換了玩法就重排作息：正在睡到休息結束的掛機、鍛造叫醒，照新的玩法重新算
  function resetLowProfileRhythm() {
    Object.assign(lowProfile, { sessionEnd: 0, breakUntil: 0, sleepUntil: 0, checkin: null, nextCheckinAt: 0 });
    const settings = readSettingsFromPanel();
    if (state.running && !state.forgeMode && nextTickAt.hunt - Date.now() > 20000) {
      backgroundTimer.clearTimeout(state.timerId);
      state.timerId = planTick(() => tick(settings), randomGap(3000, 10000));
    }
    if (forgeRunner.running && nextTickAt.forge - Date.now() > 20000) scheduleForgeRunner(randomGap(3000, 10000));
    renderLowModeButtons();
  }

  function renderLowProfilePersonality() {
    const element = panel.querySelector('[data-role="low-profile-personality"]');
    if (element) element.textContent = lowProfilePersonalityText();
  }

  function minutesBetween(settings, minKey, maxKey, factor = 1) {
    const low = Number(settings[minKey]) || 1;
    return randomGap(low, Math.max(low, Number(settings[maxKey]) || low)) * 60000 * factor;
  }

  // 「2-9」＝每天 2 點睡到 9 點；起床、睡覺時間每天各自前後飄最多 1 小時，偶爾多睡 1～3 小時（那天少玩）
  function sleepEndAt(settings, now = Date.now()) {
    const match = String(settings.lowProfileSleepHours || '').trim().match(/^(\d{1,2}(?:\.\d+)?)[-~～](\d{1,2}(?:\.\d+)?)$/);
    if (!match) return 0;
    const from = Number(match[1]);
    const to = Number(match[2]);
    const personality = accountPersonality();
    const profile = dashboard.profile || {};
    for (const dayOffset of [-1, 0]) {
      const day = new Date(now);
      day.setDate(day.getDate() + dayOffset);
      day.setHours(0, 0, 0, 0);
      const sleeper = settings.syncAccountsEnabled ? 'shared' : profile.nickname || profile.id || '';
      const random = seededRandom(`sleep:${sleeper}:${day.toDateString()}`);
      const startMinutes = from * 60 + personality.sleepShiftMinutes + (random() * 120 - 60);
      let endMinutes = (to <= from ? to + 24 : to) * 60 + personality.sleepShiftMinutes + (random() * 120 - 60);
      if (random() < 0.15) endMinutes += 60 + random() * 120;
      const start = day.getTime() + startMinutes * 60000;
      const end = day.getTime() + endMinutes * 60000;
      if (now >= start && now < end) return end;
    }
    return 0;
  }

  // 三個帳號同步時：玩／休息的時間表由日期決定，每個分頁自己算出來都一樣，不用互相通知就會一起停下來
  function sharedBreakEndAt(settings, now) {
    const personality = accountPersonality();
    const random = seededRandom(`rhythm:${new Date(now).toDateString()}`);
    const between = (minKey, maxKey, factor) => {
      const low = Number(settings[minKey]) || 1;
      const high = Math.max(low, Number(settings[maxKey]) || low);
      return (low + random() * (high - low)) * 60000 * factor;
    };
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    let at = midnight.getTime();
    while (at <= now) {
      at += between('lowProfilePlayMinMinutes', 'lowProfilePlayMaxMinutes', personality.play);
      if (now < at) return 0;
      at += between('lowProfileBreakMinMinutes', 'lowProfileBreakMaxMinutes', personality.rest);
      if (now < at) return at;
    }
    return 0;
  }

  // 休閒：每個小時玩幾分鐘（前後飄 30%），分成 1～2 段放在這個小時裡的隨機位置；同一個小時每次算都一樣
  function casualSessions(settings, hourStart, seedKey) {
    const random = seededRandom(`casual:${seedKey}:${hourStart}`);
    const perHour = Math.min(60, Math.max(0, Number(settings.lowProfileCasualMinutes) || 0));
    const minutes = Math.min(60, perHour * (0.7 + random() * 0.6));
    const parts = minutes > 10 && random() < 0.5 ? 2 : 1;
    const segment = 60 / parts;
    const length = Math.min(segment, minutes / parts);
    return Array.from({ length: parts }, (_, index) => {
      const start = hourStart + (index * segment + random() * (segment - length)) * 60000;
      return [start, start + length * 60000];
    });
  }

  // 0＝現在是玩的時段；否則回傳下一段開始的時間
  function casualBreakEndAt(settings, now, seedKey) {
    if ((Number(settings.lowProfileCasualMinutes) || 0) >= 60) return 0;
    const hour = new Date(now);
    hour.setMinutes(0, 0, 0);
    for (let offset = 0; offset < 4; offset++) {
      const sessions = casualSessions(settings, hour.getTime() + offset * 3600000, seedKey);
      if (sessions.some(([start, end]) => now >= start && now < end)) return 0;
      const next = sessions.find(([start]) => start > now);
      if (next) return next[0];
    }
    return now + 3600000;
  }

  // 休閒離開中回來看一下：點幾下狩獵（鍛造也順便收）再離開；時間到也走，免得這個分頁沒在打怪就一直卡著
  function startCasualCheckin(settings, reason) {
    const low = Math.max(1, Number(settings.lowProfileCheckinMinHunts) || 1);
    const high = Math.max(low, Number(settings.lowProfileCheckinMaxHunts) || low);
    const hunts = Math.round(randomGap(low, high));
    lowProfile.checkin = { hunts, until: Date.now() + (hunts * 25 + 60) * 1000 };
    lowProfile.breakUntil = 0;
    setStatus(`低調模式（休閒）：${reason}，點 ${hunts} 下狩獵再離開`);
    // 掛機正睡到休息結束：叫醒它
    if (state.running && !state.forgeMode && nextTickAt.hunt - Date.now() > 20000) {
      backgroundTimer.clearTimeout(state.timerId);
      state.timerId = planTick(() => tick(settings), randomGap(3000, 10000));
    }
  }

  function noteCheckinHunt() {
    if (lowProfile.checkin && lowProfile.checkin.hunts > 0) lowProfile.checkin.hunts--;
  }

  function casualBreakLeft(settings, now) {
    const profile = dashboard.profile || {};
    const seedKey = settings.syncAccountsEnabled ? 'shared' : profile.nickname || profile.id || '';
    const breakEnd = casualBreakEndAt(settings, now, seedKey);
    if (!breakEnd) {
      lowProfile.checkin = null;
      return 0;
    }
    if (lowProfile.checkin && lowProfile.checkin.hunts > 0 && now < lowProfile.checkin.until) return 0;
    lowProfile.checkin = null;
    const gap = () => minutesBetween(settings, 'lowProfileCheckinMinMinutes', 'lowProfileCheckinMaxMinutes');
    if (!lowProfile.nextCheckinAt || lowProfile.nextCheckinAt < now - 60000) lowProfile.nextCheckinAt = now + gap();
    if (now >= lowProfile.nextCheckinAt && lowProfile.nextCheckinAt < breakEnd) {
      lowProfile.nextCheckinAt = now + gap();
      startCasualCheckin(settings, '離開中回來看一下');
      return 0;
    }
    const until = Math.min(breakEnd, lowProfile.nextCheckinAt, nextSeriousStart(settings, now));
    lowProfile.breakUntil = until;
    const minutes = (time) => Math.max(1, Math.round((time - now) / 60000));
    setStatus(
      `低調模式（休閒）：離開中，${minutes(breakEnd)} 分鐘後回來玩${lowProfile.nextCheckinAt < breakEnd ? `，${minutes(lowProfile.nextCheckinAt)} 分鐘後回來看一下` : ''}`
    );
    return until - now;
  }

  // 休閒離開中（不是睡覺）且會為了鍛造回來：鍛造照完成時間排，不等整段休息結束
  function casualForgeAway(settings) {
    if (!settings.lowProfileEnabled || effectiveLowStyle(settings) !== 'casual' || !settings.lowProfileForgeCheckin) return false;
    return lowProfileBreakLeft(settings) > 0 && Date.now() >= lowProfile.sleepUntil;
  }

  // 回傳還要休息多久（毫秒）；0＝正在玩
  function lowProfileBreakLeft(settings) {
    if (!settings.lowProfileEnabled) return 0;
    const now = Date.now();
    // 自動玩法換了時段：上一個玩法排的休息作廢，照新的玩法重算
    const style = effectiveLowStyle(settings, now);
    if (lowProfile.style && lowProfile.style !== style) Object.assign(lowProfile, { sessionEnd: 0, breakUntil: 0, checkin: null, nextCheckinAt: 0 });
    lowProfile.style = style;
    if (now < lowProfile.sleepUntil) return lowProfile.sleepUntil - now;
    if (now < lowProfile.breakUntil) return lowProfile.breakUntil - now;
    const personality = accountPersonality();
    const playTime = () => minutesBetween(settings, 'lowProfilePlayMinMinutes', 'lowProfilePlayMaxMinutes', personality.play);
    const wakeAt = sleepEndAt(settings, now);
    if (wakeAt) {
      lowProfile.sleepUntil = wakeAt;
      lowProfile.sessionEnd = wakeAt + playTime();
      const wake = new Date(wakeAt);
      setStatus(`低調模式：睡覺中，${wake.getHours()}:${String(wake.getMinutes()).padStart(2, '0')} 起床`);
      return wakeAt - now;
    }
    // 跟睡覺一樣記在 sleepUntil：休閒的回來看、鍛造好了回來收都不會發生
    const offEnd = offHoursEndAt(settings, now);
    if (offEnd) {
      lowProfile.sleepUntil = offEnd;
      const back = new Date(offEnd);
      setStatus(`低調模式：完全休息中，${back.getHours()}:${String(back.getMinutes()).padStart(2, '0')} 回來`);
      return offEnd - now;
    }
    if (style === 'casual') return casualBreakLeft(settings, now);
    if (settings.syncAccountsEnabled) {
      const breakEnd = sharedBreakEndAt(settings, now);
      if (!breakEnd) return 0;
      lowProfile.breakUntil = breakEnd;
      setStatus(`低調模式：玩了一陣子，三個帳號一起休息 ${Math.round((breakEnd - now) / 60000)} 分鐘`);
      return breakEnd - now;
    }
    if (!lowProfile.sessionEnd) lowProfile.sessionEnd = now + playTime();
    if (now < lowProfile.sessionEnd) return 0;
    lowProfile.breakUntil = now + minutesBetween(settings, 'lowProfileBreakMinMinutes', 'lowProfileBreakMaxMinutes', personality.rest);
    lowProfile.sessionEnd = lowProfile.breakUntil + playTime();
    setStatus(`低調模式：玩了一陣子，休息 ${Math.round((lowProfile.breakUntil - now) / 60000)} 分鐘`);
    return lowProfile.breakUntil - now;
  }

  function lowProfileDelay(settings, delay) {
    if (!settings.lowProfileEnabled) return delay;
    const breakLeft = lowProfileBreakLeft(settings);
    if (breakLeft) return Math.max(delay, breakLeft + randomGap(1000, 5000));
    const personality = accountPersonality();
    const extra =
      Math.random() < personality.distractChance ? randomGap(30000, 120000) : randomSkewedSeconds(1, 8) * 1000 * personality.speed;
    return delay + extra;
  }

  // 要補給、換裝時人不會下一步就發現，晚幾秒才反應；回傳還要等多久（毫秒），0＝可以動了。
  // 躲紅名不走這裡，太晚躲會被打
  function lowProfileReactionLeft(settings, key) {
    if (!settings.lowProfileEnabled) return 0;
    const now = Date.now();
    // 上次反應完很久了才又需要，是新的一次，要重新反應
    if (!lowProfile.reaction || lowProfile.reaction.key !== key || now - lowProfile.reaction.due > 30000) {
      lowProfile.reaction = { key, due: now + randomSkewedSeconds(2, 10) * 1000 * accountPersonality().speed };
    }
    const left = lowProfile.reaction.due - now;
    if (left > 0) return left;
    lowProfile.reaction = null;
    return 0;
  }

  function waitToReact(settings, key, label) {
    const left = lowProfileReactionLeft(settings, key);
    if (!left) return false;
    setStatus(`低調模式：${(left / 1000).toFixed(1)} 秒後才反應過來要${label}`);
    state.timerId = planTick(() => tick(settings), left);
    return true;
  }

  // selector 是位置路徑，換到別的畫面（例如鍛造）同一個位置可能是別顆按鈕；字不對就不按，
  // 否則每一步都會先誤按那顆按鈕、又只隔一個道具步驟就重來，後面的流程永遠輪不到
  function finishMoveGap(settings) {
    const minimum = Number(settings.finishMoveMinSeconds) || 0;
    const maximum = Math.max(minimum, Number(settings.finishMoveMaxSeconds) || 0);
    return randomGap(minimum * 1000, maximum * 1000);
  }

  // 回傳 false＝沒有完成移動可按；'waiting'＝出現了，還在等隨機的幾秒；true＝按了
  function clickFinishMoveIfReady(settings) {
    const text = settings.stageFinishMoveText || FINISH_MOVE_DEFAULT_TEXT;
    let button = findButton(settings.stageFinishMove, text, '');
    // selector 指到別顆時改成只用文字找，真正的「完成移動」出現時才按得到
    if (button && buttonText(button) !== text) button = findButton('', text, '');
    if (!isClickable(button)) {
      state.finishMoveAt = 0;
      return false;
    }
    if (!state.finishMoveAt) state.finishMoveAt = Date.now() + finishMoveGap(settings);
    if (Date.now() < state.finishMoveAt) return 'waiting';
    state.finishMoveAt = 0;
    button.click();
    return true;
  }

  function performMove(settings, move) {
    if (move.problem) {
      setStatus(`移動：${move.problem}`);
    } else if (!move.selector && !move.text) {
      setStatus(`${move.from}：「${move.label}」按鈕還沒設定（在「移動」頁設定）`);
    } else {
      const button = findButton(move.selector, move.text, '');
      if (isClickable(button)) {
        button.click();
        setStatus(`${move.from}：${move.label}`);
      } else {
        setStatus(`${move.from}：找不到可以按的「${move.label}」按鈕，稍後重試`);
      }
    }
    scheduleNext(settings);
  }

  // 戰鬥統計：解析畫面上的戰鬥紀錄文字，累計結果另外存起來，重新整理也不會歸零
  const COMBAT_STORAGE_KEY = 'autoClickerV2CombatStats';
  // 統計格式或判斷方式改過就換版本，舊資料對不上（例如治療沒分生命、體力），直接重新統計
  const COMBAT_STATS_VERSION = 4;
  const MEMBER_FIELDS = ['damage', 'hits', 'crits', 'healthHealing', 'staminaHealing', 'controls', 'kills'];
  const SKILL_FIELDS = ['casts', 'damage', 'hits', 'crits'];
  const BASIC_ATTACK = '普通攻擊';
  const ANOMALY_LIMIT = 10;
  const DAMAGE_PATTERN = /造成\s*(\d[\d,]*)\s*點?傷害/;
  const ANY_DAMAGE_PATTERN = /(?:造成|受到)\s*(\d[\d,]*)\s*點?傷害/;
  // 寫在敵人那一行、其實是我方打的：「…分心被盜寶哥布林趁機攻擊造成 237 點傷害」「…遭王剛反擊，命中要害，受到 2050 傷害」
  const BORROWED_ATTACKS = [
    // 「…分心被盜寶哥布林趁機攻擊」或「…無法動彈，王剛趁機攻擊」；名字裡不含「被」，從逗號起算時才不會把「分心被」也包進名字
    { pattern: /(?:被|，)([^，被]+?)趁\S?攻擊/, skill: '趁機攻擊' },
    // 「遭古老樹人反擊」「遭到古老樹人上前反擊」
    { pattern: /遭到?([^，]+?)(?:上前)?反擊/, skill: '反擊' },
  ];
  // 一行可能同時恢復兩種，例如「恢復了 278 生命值和 61 體力」
  const HEAL_AMOUNT_PATTERN = /(\d[\d,]*)\s*點?\s*(體力|生命值)?/g;
  const FOOD_PATTERN = /(?:吃|喝)了一些(.+?)，/;
  const KILL_PATTERN = /^(.+?)被擊殺死亡了/;
  // 多段攻擊每一擊前面會加「第 N 擊」
  const HIT_PATTERN = /^(?:第\s*\d+\s*擊)?擊中(.+?)，/;
  const EXP_PATTERN = /^(.+?)獲得了\s*\d[\d,]*\s*點經驗值/;
  const REMAINING_PATTERN = /^(.+?)還剩下\s*\d[\d,]*\s*點生命值/;
  // 戰鬥中喝藥也會出現「點生命值」，所以只認戰後結算那種寫法
  const BATTLE_END_PATTERN = /還剩下\s*\d[\d,]*\s*點生命值|點經驗值/;
  // 這些字眼一定是自己出手，就算剛被治療過也不能當成治療後的狀態描述
  const ACTION_VERB_PATTERN = /使出|攻擊|發動/;

  function countCombatLines(text) {
    return text.split('\n').filter((line) => /造成|擊中|恢復了|攻擊/.test(line)).length;
  }

  function toNumber(text) {
    return Number(text.replace(/,/g, ''));
  }

  function emptyStats(fields) {
    return Object.fromEntries(fields.map((field) => [field, 0]));
  }

  function emptyMemberStats() {
    return { ...emptyStats(MEMBER_FIELDS), skills: {} };
  }

  function addStats(total, addition, fields) {
    fields.forEach((field) => (total[field] += addition[field]));
  }

  // 技能名稱取出手那一行去掉名字後的第一段，例如「灑了一大桶熱油」；有「使出」就取後面的招式名
  // （「對綠水靈1使出角撞」→「角撞」）；「2 連擊」去掉次數；「攻擊XX」「朝XX發動攻擊」都算普通攻擊。
  // 只要看招式打了多少，所以目標連同前面的「對／朝」一起拿掉（「對狐蝠3潑了一匙熱油」→「潑了一匙熱油」），同一招打不同怪才會合在一起
  function skillName(line, name, others) {
    let text = line.slice(name.length).split('，')[0].trim();
    const used = text.match(/使出(.+)/);
    if (used) return used[1];
    if (/攻擊/.test(text)) return BASIC_ATTACK;
    text = text.replace(/^\d+\s*/, '');
    others.forEach((other) => (text = text.split(other).join('◯')));
    text = text.replace(/[對朝向往]?◯/g, '');
    return text || '（不明）';
  }

  function findBorrowedAttack(line) {
    for (const { pattern, skill } of BORROWED_ATTACKS) {
      const match = line.match(pattern);
      if (match) return { name: match[1], skill };
    }
    return null;
  }

  // 我方＝戰後拿到經驗值的人；全滅時沒有經驗值，改用戰後還活著的人。
  // 其他名字從被擊中、被擊殺、被攻擊的描述收集，用來認出每行開頭是誰
  // API 戰報直接給敵我名單（a 我方、b 敵方），就不用從結算的文字猜
  function collectCombatants(lines, sides = null) {
    // 名字不會很長也不會有標點；幾行黏在一起時抓到的「名字」會是一大串，不當成角色
    const isPlausibleName = (name) => name.length <= 16 && !/[，。]/.test(name);
    const namesFrom = (pattern) =>
      lines.map((line) => line.match(pattern)).filter(Boolean).map((match) => match[1]).filter(isPlausibleName);
    const expNames = namesFrom(EXP_PATTERN);
    const party = new Set(sides && sides.party.length ? sides.party : expNames.length ? expNames : namesFrom(REMAINING_PATTERN));
    const names = new Set([...party, ...(sides ? sides.enemies : [])]);
    const namePatterns = [HIT_PATTERN, KILL_PATTERN, /朝(.+?)發動攻擊/, /^([^朝，]+?)攻擊([^，]+?)，/];
    lines.forEach((line) => {
      namePatterns.forEach((pattern) => {
        const match = line.match(pattern);
        if (match) match.slice(1).forEach((name) => names.add(name));
      });
    });
    // 「古老樹人胡亂攻擊意外命中…」會被當成名字「古老樹人胡亂」，比我方名字長會先比到，整行就認不出是誰
    names.forEach((name) => {
      if (!party.has(name) && [...party].some((member) => name.startsWith(member))) names.delete(name);
    });
    // 長的先比，避免「綠水靈1」吃掉「綠水靈10」
    const sortedNames = [...names].sort((first, second) => second.length - first.length);
    const leadingName = (text) => sortedNames.find((name) => text.startsWith(name)) || null;
    const otherNames = (line, name) => sortedNames.filter((other) => line.slice(name.length).includes(other));
    return { party, leadingName, otherNames };
  }

  // 「吃了一些麻婆豆腐」只寫誰吃，沒寫誰做的；往回找提到同一道菜、又不是別人吃的那一行，就是做菜的人
  function findFoodSourceLine(lines, index, leadingName) {
    const food = lines[index].match(FOOD_PATTERN);
    if (!food) return null;
    for (let previous = index - 1; previous >= 0; previous--) {
      const line = lines[previous];
      if (line.includes(food[1]) && !line.includes('恢復了') && leadingName(line)) return line;
    }
    return null;
  }

  function isStatusLike(line, name, otherNames) {
    return otherNames(line, name).length === 0 && !DAMAGE_PATTERN.test(line) && !ACTION_VERB_PATTERN.test(line);
  }

  // 各種治療技能寫法都不同，只看結構：往回跳過同一串「恢復了」與被治療者緊接著的狀態描述，
  // 前一行若是我方的出手而且不是攻擊，就是施放的人；否則回傳 null，當成自己喝藥或自然回復
  function findHealSourceLine(lines, index, { party, leadingName, otherNames }) {
    let previous = index - 1;
    while (previous >= 0) {
      const line = lines[previous];
      const name = leadingName(line);
      const followsOwnHeal = name && previous > 0 && leadingName(lines[previous - 1]) === name;
      if (line.includes('恢復了') || (followsOwnHeal && isStatusLike(line, name, otherNames))) {
        previous--;
        continue;
      }
      break;
    }
    const source = lines[previous];
    const sourceName = source ? leadingName(source) : null;
    const isHealAction =
      sourceName &&
      party.has(sourceName) &&
      ![HIT_PATTERN, KILL_PATTERN, EXP_PATTERN, REMAINING_PATTERN, DAMAGE_PATTERN, /攻擊/].some((pattern) => pattern.test(source));
    return isHealAction ? source : null;
  }

  // 紀錄沒有標出「誰的技能打中誰」，所以記住最近一個出手的人，後面的「擊中…」「恢復了…」「被擊殺」都算他的；
  // 剛被打中或被治療的人緊接著出現的狀態描述（燒起來了、被燒傷了）不算新的出手。
  // 我方角色只有緊接在自己被打中／被治療那行後面才算狀態，否則像「王剛做了一道麻婆豆腐」會被當成王剛被打後的反應。
  // indented 有給時（逐行讀得到縮排），縮排的子行一律屬於上面那行出手的人，不用再猜。
  // sides 是 API 戰報才有的：敵我名單，和每行是哪一方受傷（damaged[index]：'a' 我方、'b' 敵方）
  function parseBattle(lines, indented = null, sides = null) {
    const combatants = collectCombatants(lines, sides);
    const damaged = sides ? sides.damaged : [];
    const { party, leadingName, otherNames } = combatants;
    const members = {};
    party.forEach((name) => (members[name] = emptyMemberStats()));
    let actor = null;
    let skill = '';
    let skillCounted = false;
    let targets = new Set();
    let lastTarget = null;
    // 提到我方角色、有傷害或恢復數字，卻沒有算進任何我方角色的行，記下來讓使用者把整份戰報拿來調整判斷
    const flagged = new Set();
    // 認不出是誰時清空，避免後面的「擊中」算到上一個人頭上。
    // 我方單體出手時，行內的敵人也當成目標，緊接著的「狐蝠3被燒傷了」「狐蝠3被擊殺死亡了」才會算在出手的人身上；
    // 敵人出手的目標（我方）不記，否則我方下一次出手會被當成被打後的狀態描述
    const startAction = (line, name, fixedSkill = '') => {
      actor = name;
      skill = fixedSkill || (name ? skillName(line, name, otherNames(line, name)) : '');
      skillCounted = false;
      targets = new Set();
      lastTarget = null;
      if (name && party.has(name)) {
        otherNames(line, name)
          .filter((other) => !party.has(other))
          .forEach((other) => {
            targets.add(other);
            lastTarget = other;
          });
      }
    };
    const credit = (field, amount = 1) => {
      if (members[actor]) members[actor][field] += amount;
    };
    const creditDamage = (line, pattern = DAMAGE_PATTERN) => {
      const damage = line.match(pattern);
      if (!damage || !members[actor]) return;
      const amount = toNumber(damage[1]);
      const critical = line.includes('命中要害') ? 1 : 0;
      credit('damage', amount);
      credit('hits');
      credit('crits', critical);
      const skills = members[actor].skills;
      const skillStats = skills[skill] || (skills[skill] = emptyStats(SKILL_FIELDS));
      // 一招打中好幾隻只算施放一次
      if (!skillCounted) skillStats.casts++;
      skillCounted = true;
      addStats(skillStats, { casts: 0, damage: amount, hits: 1, crits: critical }, SKILL_FIELDS);
    };
    const handleLine = (line, index) => {
      // 縮排在出手那行底下、又是敵方受傷：不管寫法（擊中、第 N 擊…）都是上面那個人打的
      if (indented && indented[index] && damaged[index] === 'b') {
        creditDamage(line, ANY_DAMAGE_PATTERN);
        return;
      }
      const hit = line.match(HIT_PATTERN);
      if (hit) {
        targets.add(hit[1]);
        lastTarget = hit[1];
        creditDamage(line);
        return;
      }
      if (KILL_PATTERN.test(line)) {
        credit('kills');
        return;
      }
      if (EXP_PATTERN.test(line) || REMAINING_PATTERN.test(line)) {
        actor = null;
        return;
      }
      const borrowed = findBorrowedAttack(line);
      if (borrowed) {
        startAction(line, borrowed.name, borrowed.skill);
        creditDamage(line, ANY_DAMAGE_PATTERN);
        return;
      }
      const name = leadingName(line);
      const isIndented = Boolean(indented && indented[index]);
      const healText = line.split('恢復了')[1];
      if (healText !== undefined) {
        let healer;
        if (indented) {
          // 子行算上面那行出手的人；沒縮排的整行自己就是一次出手（例如「王剛炒了一盤蛋炒飯，盜寶哥布林吃了…」）
          if (!isIndented) startAction(line, name);
          healer = actor;
        } else {
          const sourceLine =
            findFoodSourceLine(lines, index, leadingName) || findHealSourceLine(lines, index, combatants);
          // 找不到施放的人就算被治療的人自己，不改變目前出手的人，吸血這類邊打邊回的才不會打斷後面的「擊中」
          healer = sourceLine ? leadingName(sourceLine) : name || actor;
          if (sourceLine && healer !== actor) startAction(sourceLine, healer);
        }
        for (const amount of healText.matchAll(HEAL_AMOUNT_PATTERN)) {
          const field = amount[2] === '體力' ? 'staminaHealing' : 'healthHealing';
          if (members[healer]) members[healer][field] += toNumber(amount[1]);
        }
        if (name) {
          targets.add(name);
          lastTarget = name;
        }
        return;
      }
      const isStatusLine =
        isIndented ||
        (name &&
          targets.has(name) &&
          (name === lastTarget || !party.has(name)) &&
          isStatusLike(line, name, otherNames));
      if (isStatusLine) {
        if (name && !party.has(name)) credit('controls');
        return;
      }
      startAction(line, name);
      creditDamage(line);
      // 同一行後半段描述敵人狀態（例如「綠水靈1因害怕攻擊力降低了」）也算控制
      line.split('，').slice(1).forEach((clause) => {
        const subject = leadingName(clause);
        if (subject && !party.has(subject) && !/傷害|沒有/.test(clause)) credit('controls');
      });
    };
    const partyOutput = () =>
      Object.values(members).reduce((sum, memberStats) => sum + memberStats.damage + memberStats.healthHealing + memberStats.staminaHealing, 0);
    for (const [index, line] of lines.entries()) {
      const outputBefore = partyOutput();
      handleLine(line, index);
      // 我方受傷的行一定不是我方的輸出
      if (partyOutput() === outputBefore && damaged[index] !== 'a' && hasUncreditedPartyOutput(line, party)) flagged.add(index);
    }
    return { members, flagged };
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 有傷害或恢復的數字、又提到我方角色，而且我方不是挨打或被治療的那一方，卻沒有算到任何人身上 → 判斷規則漏了這種寫法。
  // 被打（「攻擊王剛」「盜寶哥布林上前保護受到」「盜寶哥布林因中毒受到」）、被治療（「王剛吃了…恢復了」）都是正常的
  function hasUncreditedPartyOutput(line, party) {
    if (!/(?:造成|受到|恢復了)[^，]*?\d/.test(line)) return false;
    return [...party].some((member) => {
      if (!line.includes(member)) return false;
      const name = escapeRegExp(member);
      const asReceiver = new RegExp(
        `(?:攻擊|朝|擊中|襲擊|對)${name}|${name}(?:上前保護)?受到|${name}因|${name}[^，]*?(?:吃|喝)了|${name}[^，]*?恢復了`
      );
      return !asReceiver.test(line);
    });
  }

  // 複製出來的戰報保留縮排，可疑的行前面加 ⚠，貼出來就看得出是哪幾行沒認出來
  function formatBattleReport(lines, indented, flagged) {
    return lines
      .map((line, index) => `${flagged.has(index) ? '⚠ ' : ''}${indented && indented[index] ? '　　' : ''}${line}`)
      .join('\n');
  }

  function recordAnomaly(reason, report) {
    combatStats.anomalies = [{ time: Date.now(), reason, report }, ...(combatStats.anomalies || [])].slice(0, ANOMALY_LIMIT);
  }

  function freshCombatStats(lastSignature = '') {
    return { version: COMBAT_STATS_VERSION, battles: 0, since: Date.now(), members: {}, last: null, lastSignature };
  }

  function loadCombatStats() {
    try {
      const saved = JSON.parse(localStorage.getItem(COMBAT_STORAGE_KEY) || 'null');
      if (saved && saved.version === COMBAT_STATS_VERSION) return saved;
    } catch {
      // 讀不到就從頭統計
    }
    return freshCombatStats();
  }

  function saveCombatStats() {
    try {
      localStorage.setItem(COMBAT_STORAGE_KEY, JSON.stringify(combatStats));
    } catch {
      // 存不了只是重新整理後歸零
    }
  }

  let combatStats = loadCombatStats();
  let pendingBattleText = '';

  // 有選取紀錄區就直接讀；沒選取才用標題文字往上找包住整場紀錄的區塊。還沒出現戰後結算就當作這場還沒打完
  function findBattleLogElement(settings) {
    if (settings.combatSelector) {
      let element = null;
      try {
        element = document.querySelector(settings.combatSelector);
      } catch {
        // selector 格式錯誤就當作找不到
      }
      return element && BATTLE_END_PATTERN.test(element.innerText) ? element : null;
    }
    const keyword = settings.combatKeyword;
    if (!keyword) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue.includes(keyword) && !panel.contains(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    const heading = walker.nextNode();
    let container = heading ? heading.parentElement : null;
    for (let depth = 0; container && container !== document.body && depth < 8; depth++) {
      if (BATTLE_END_PATTERN.test(container.innerText)) return container;
      container = container.parentElement;
    }
    return null;
  }

  // 戰報逐行讀，行號不會混進內容，也看得出哪些行縮排在上一行底下（群體技能、群體治療的子行）。
  // 依序試：每行一個 .msg → 用連號的行號元素找出每一行 → 整塊文字照換行切（indented 給 null 表示不知道縮排）
  function readBattleLines(container) {
    const messages = Array.from(container.querySelectorAll('.msg'));
    const rows = messages.length
      ? messages.map((message) => ({ text: message.innerText.trim(), element: message }))
      : readNumberedRows(container);
    if (!rows) {
      const lines = container.innerText.split('\n').map((text) => text.trim()).filter(Boolean);
      return { lines, indented: null };
    }
    const kept = rows.filter((row) => row.text);
    // 縮排用相對的判斷：比最靠左的行多縮進去才算子行，整份戰報本身有左邊距也不會全部被當成子行
    const offsets = kept.map((row) => leftOffset(row.element));
    const minimumOffset = Math.min(...offsets);
    const indented = offsets.map((offset) => offset > minimumOffset);
    // 整份都沒有縮排就等於不知道分組，交給一般規則判斷（例如往回找做菜的人）
    return { lines: kept.map((row) => row.text), indented: indented.some(Boolean) ? indented : null };
  }

  function leftOffset(element) {
    const style = getComputedStyle(element);
    return parseFloat(style.paddingLeft) + parseFloat(style.marginLeft) + parseFloat(style.textIndent) || 0;
  }

  // 每行前面有自己的行號元素（1、2、3…）時，用行號找出每一行，行號旁邊的內容就是那一行。
  // 要從 1 開始連號才算行號，內容裡出現的數字（傷害、經驗值）不會被誤認
  function readNumberedRows(container) {
    const numberElements = [];
    container.querySelectorAll('*').forEach((element) => {
      if (element.children.length === 0 && element.textContent.trim() === String(numberElements.length + 1)) {
        numberElements.push(element);
      }
    });
    if (numberElements.length < 3) return null;
    return numberElements.map((numberElement) => {
      // 行號可能包了好幾層，往上找到真正跟內容並排的那一層
      let numberHolder = numberElement;
      while (numberHolder.parentElement && numberHolder.parentElement.textContent.trim() === numberElement.textContent.trim()) {
        numberHolder = numberHolder.parentElement;
      }
      const row = numberHolder.parentElement;
      const contents = Array.from(row.childNodes).filter((node) => node !== numberHolder);
      return {
        text: contents.map((node) => node.textContent).join('').trim(),
        element: contents.find((node) => node.nodeType === 1) || row,
      };
    });
  }

  // 這個分頁收到過 /api/hunt 的戰報後就只用 API，不再讀畫面，同一場才不會算兩次
  let combatFromApi = false;

  // 遊戲按原地掛機送的 POST /api/hunt，回應的 report.messages 就是整份戰報，每個 m 是一行
  function recordBattleFromApi(report) {
    if (!report || !Array.isArray(report.messages)) return;
    combatFromApi = true;
    const signature = `api:${report.id}`;
    if (signature === combatStats.lastSignature) return;
    combatStats.lastSignature = signature;
    const messages = report.messages.filter((message) => String(message.m || '').trim());
    const lines = messages.map((message) => String(message.m).trim());
    // 群體技能的子行（第 1 擊、第 2 擊…）帶 indent，等同畫面上的縮排，交給解析器算在上面那行出手的人身上
    const indented = messages.map((message) => Boolean(message.indent));
    const names = (side) => (Array.isArray(side) ? side.map((fighter) => fighter && fighter.name).filter(Boolean) : []);
    const sides = { party: names(report.a), enemies: names(report.b), damaged: messages.map((message) => message.dmged) };
    recordBattle(lines, indented.some(Boolean) ? indented : null, () => JSON.stringify(report).slice(0, 20000), sides);
  }

  function watchBattleLog(settings) {
    if (!settings.combatEnabled || combatFromApi) return;
    const container = findBattleLogElement(settings);
    const battle = container ? readBattleLines(container) : null;
    const text = battle ? battle.lines.join('\n') : '';
    // 紀錄可能一行一行跑出來，連續兩次讀到一樣的內容才算這場打完；同一份紀錄只算一次
    if (!text || text !== pendingBattleText) {
      pendingBattleText = text;
      return;
    }
    if (text === combatStats.lastSignature) return;
    combatStats.lastSignature = text;
    recordBattle(battle.lines, battle.indented, () => container.outerHTML.slice(0, 20000));
  }

  // rawReport：認不出來時保存的原始內容，用函式包著，正常時不用產生
  function recordBattle(lines, indented, rawReport, sides = null) {
    const { members, flagged } = parseBattle(lines, indented, sides);
    combatStats.lastReport = formatBattleReport(lines, indented, flagged);
    // 分不出行時整份戰報會黏成一兩行，解析出來的「角色」會是一大串文字，寧可不算也不要把垃圾放進統計
    if (lines.length < 3 || Object.keys(members).length === 0) {
      const reason =
        lines.length < 3 ? '戰報分不出行（整份黏在一起）' : '認不出我方角色（找不到經驗值或剩餘生命值的結算）';
      recordAnomaly(reason, rawReport());
      saveCombatStats();
      renderCombatStats();
      return;
    }
    if (flagged.size) recordAnomaly(`${flagged.size} 行提到我方的傷害或恢復沒有算到任何人`, combatStats.lastReport);
    combatStats.battles++;
    combatStats.last = members;
    Object.entries(members).forEach(([name, battleStats]) => {
      const total = combatStats.members[name] || (combatStats.members[name] = emptyMemberStats());
      addStats(total, battleStats, MEMBER_FIELDS);
      Object.entries(battleStats.skills).forEach(([skill, skillStats]) => {
        addStats(total.skills[skill] || (total.skills[skill] = emptyStats(SKILL_FIELDS)), skillStats, SKILL_FIELDS);
      });
    });
    saveCombatStats();
    renderCombatStats();
  }

  function sumMembers(members) {
    const sum = emptyStats(MEMBER_FIELDS);
    Object.values(members).forEach((memberStats) => addStats(sum, memberStats, MEMBER_FIELDS));
    return sum;
  }

  function formatAmount(value) {
    return Math.round(value).toLocaleString();
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
  }

  function percentText(part, whole) {
    return whole ? `${Math.round((part / whole) * 100)}%` : '-';
  }

  function byDamage([, first], [, second]) {
    return second.damage - first.damage;
  }

  function combatTableHtml(members) {
    const rows = Object.entries(members)
      .sort(byDamage)
      .map(([name, memberStats]) => `<tr><td>${escapeHtml(name)}</td><td>${formatAmount(memberStats.damage)}</td>
        <td>${percentText(memberStats.crits, memberStats.hits)}</td><td>${formatAmount(memberStats.healthHealing)}</td>
        <td>${formatAmount(memberStats.staminaHealing)}</td><td>${memberStats.controls}</td><td>${memberStats.kills}</td></tr>`)
      .join('');
    return `<table class="combat"><tr><th>角色</th><th>傷害</th><th>爆擊</th><th title="恢復生命值">回血</th>
      <th title="恢復體力">回體</th><th>控制</th><th>擊殺</th></tr>${rows}</table>`;
  }

  // 每個角色各招的傷害；key 用來在重畫後保留展開狀態
  function skillDetailsHtml(members, key) {
    const totalDamage = sumMembers(members).damage;
    const sections = Object.entries(members)
      .filter(([, memberStats]) => memberStats.damage > 0)
      .sort(byDamage)
      .map(([name, memberStats]) => {
        const rows = Object.entries(memberStats.skills)
          .sort(byDamage)
          .map(([skill, skillStats]) => `<tr><td>${escapeHtml(skill)}</td><td>${formatAmount(skillStats.damage)}</td>
            <td>${percentText(skillStats.damage, memberStats.damage)}</td></tr>`)
          .join('');
        return `<div style="margin-top:4px"><b>${escapeHtml(name)}</b> ${formatAmount(memberStats.damage)}（佔全隊 ${percentText(memberStats.damage, totalDamage)}）</div>
          <table class="combat"><tr><th>技能</th><th>傷害</th><th>佔比</th></tr>${rows}</table>`;
      })
      .join('');
    return `<details data-skill-details="${key}"><summary>各技能傷害</summary>${sections || '沒有造成傷害'}</details>`;
  }

  function combatQuickText() {
    const anomalyCount = (combatStats.anomalies || []).length;
    const anomalyNote = anomalyCount ? ` ⚠異常 ${anomalyCount}` : '';
    if (!combatStats.last) return anomalyNote.trim();
    const last = sumMembers(combatStats.last);
    return `上場：傷 ${formatAmount(last.damage)} 回血 ${formatAmount(last.healthHealing)} 回體 ${formatAmount(last.staminaHealing)} 控 ${last.controls} 殺 ${last.kills}（共 ${combatStats.battles} 場）${anomalyNote}`;
  }

  function renderCombatAnomalies() {
    const anomalies = combatStats.anomalies || [];
    const container = panel.querySelector('[data-role="combat-anomalies"]');
    if (!anomalies.length) {
      container.innerHTML = '';
      return;
    }
    const items = anomalies
      .map((anomaly) => `<div>${new Date(anomaly.time).toLocaleTimeString('zh-TW', { hour12: false })} ${escapeHtml(anomaly.reason)}</div>`)
      .join('');
    container.innerHTML = `
      <div style="margin-top:6px;color:#ffe066"><b>⚠ ${anomalies.length} 場戰報有認不出的內容</b>（已保存整份原文）</div>
      <div class="hint">${items}</div>
      <div class="row"><button data-action="copy-anomalies">複製異常戰報</button><button data-action="clear-anomalies">清除</button></div>`;
  }

  function anomaliesText() {
    return (combatStats.anomalies || [])
      .map((anomaly) => `=== ${new Date(anomaly.time).toLocaleString('zh-TW', { hour12: false })}　${anomaly.reason} ===\n${anomaly.report}`)
      .join('\n\n');
  }

  async function copyCombatText(text, label) {
    const textArea = panel.querySelector('[data-role="combat-report"]');
    if (!text) {
      setStatus(`還沒有${label}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      textArea.style.display = 'none';
      setStatus(`已複製${label}`);
    } catch {
      // 有些環境不允許寫剪貼簿，改放到文字框讓使用者自己複製
      textArea.value = text;
      textArea.style.display = '';
      textArea.select();
      setStatus(`無法直接複製，${label}已放在下方文字框，請按 Ctrl+C`);
    }
  }

  function clearCombatAnomalies() {
    combatStats.anomalies = [];
    saveCombatStats();
    renderCombatAnomalies();
    setStatus('已清除異常戰報');
  }

  function renderCombatStats() {
    renderCombatAnomalies();
    const container = panel.querySelector('[data-role="combat-stats"]');
    if (!combatStats.battles) {
      container.innerHTML = '<div class="hint">還沒有統計到戰鬥</div>';
      return;
    }
    const openDetails = Array.from(container.querySelectorAll('details[open]')).map((details) => details.dataset.skillDetails);
    const total = sumMembers(combatStats.members);
    const battles = combatStats.battles;
    const minutes = Math.max(1, Math.round((Date.now() - combatStats.since) / 60000));
    container.innerHTML = `
      <div><b>上一場</b></div>${combatTableHtml(combatStats.last)}${skillDetailsHtml(combatStats.last, 'last')}
      <div style="margin-top:6px"><b>累計 ${battles} 場</b>（${new Date(combatStats.since).toLocaleString('zh-TW', { hour12: false })} 起，約 ${minutes} 分鐘）</div>
      ${combatTableHtml(combatStats.members)}${skillDetailsHtml(combatStats.members, 'total')}
      <div>平均每場：傷害 ${formatAmount(total.damage / battles)}、回血 ${formatAmount(total.healthHealing / battles)}、
        回體 ${formatAmount(total.staminaHealing / battles)}、控制 ${(total.controls / battles).toFixed(1)}、擊殺 ${(total.kills / battles).toFixed(1)}</div>
      <div>每分鐘傷害 ${formatAmount(total.damage / minutes)}</div>`;
    openDetails.forEach((key) => container.querySelector(`[data-skill-details="${key}"]`)?.setAttribute('open', ''));
  }

  function resetCombatStats() {
    if (!window.confirm('要把戰鬥統計歸零嗎？')) return;
    // 保留目前畫面上那場的紀錄，免得歸零後馬上又被算進去
    // 異常戰報是要拿去調整判斷的，不跟著統計一起清掉
    combatStats = {
      ...freshCombatStats(combatStats.lastSignature),
      lastReport: combatStats.lastReport,
      anomalies: combatStats.anomalies,
    };
    saveCombatStats();
    renderCombatStats();
    setStatus('已重置戰鬥統計');
  }

  function formatPercents(percents) {
    return percents
      .map((percent) => (percent === undefined ? '-' : percent === null ? '?' : Math.floor(percent) + '%'))
      .join(' ');
  }

  // 每秒檢查一次，讓血條掉下來時不用等到下一次點擊才暫停
  function updateMonitors() {
    const settings = readSettingsFromPanel();
    updateMiniStatus();
    // 執行中照實際模式顯示；停著的時候看目前停在哪一頁，按開始會用哪種模式就先顯示哪種
    const forgeMode = state.running ? state.forgeMode : activeTab === 'forge';
    const lines = SUPPLY_GROUPS.filter((group) => Boolean(group.forgeOnly) === forgeMode).map(
      (group) => `${group.name}：${formatPercents(readGroupPercents(settings, group.id))}`
    );
    if (forgeMode && state.forgeStarted.length) lines.push(`鍛造：${forgeProgressText(settings)}`);
    if (settings.expSelectors) lines.push(`經驗：${formatPercents(readExpPercents(settings))}`);
    if (settings.stageEnabled && (settings.stageSelector || isApiHunt(settings))) {
      const reached = (isApiHunt(settings) ? planApiMove(settings) : planMove(settings)) === null;
      lines.push(`位置：${dashboardLocationText(settings) || '?'} → ${targetLabel(settings)}${reached ? '（已到達）' : ''}`);
    }
    const durabilities = Array.from({ length: CHARACTER_COUNT }, (_, characterIndex) =>
      settings[equipKey(characterIndex, 'Enabled')] ? readNumber(settings[equipKey(characterIndex, 'Durability')]) ?? '?' : '-'
    );
    if (durabilities.some((value) => value !== '-')) lines.push(`耐久：${durabilities.join(' ')}`);
    if (settings.equipApiEnabled) lines.push(equipMonitorText(settings));
    if (forgeRunner.running) lines.push(`API 鍛造：執行中（已開 ${forgeRunner.started} 爐${forgeRunner.failures ? `，重試中 ${forgeRunner.failures}/${FORGE_RETRY_LIMIT}` : ''}${forgeRunner.captchaWaiting ? '，等驗證' : ''}${forgeRunner.nameWaiting ? `，暫停開爐等好名稱：${forgeRunner.nameWaiting}` : ''}）`);
    else if (forgeRunner.stoppedReason) lines.push(`API 鍛造已停：${forgeRunner.stoppedReason}`);
    if (miningRunner.running) lines.push(`挖礦：執行中（已收 ${miningRunner.collected} 次${miningRunner.failures ? `，重試中 ${miningRunner.failures}/${FORGE_RETRY_LIMIT}` : ''}）`);
    else if (miningRunner.stoppedReason) lines.push(`挖礦已停：${miningRunner.stoppedReason}`);
    watchBattleLog(settings);
    const combatLine = settings.combatEnabled ? combatQuickText() : '';
    if (combatLine) lines.push(combatLine);
    const dashboardLine = dashboardMonitorText(settings);
    if (dashboardLine) lines.push(dashboardLine);
    const turnLine = turnMonitorText(settings);
    if (turnLine) lines.push(turnLine);
    if (dashboard.profile && titleNeedsMarks()) applyTitlePrefix();
    const globalLine = globalMonitorText();
    if (globalLine) lines.push(globalLine);
    const queueLine = queueMonitorText(settings);
    if (queueLine) lines.unshift(queueLine);
    lines.unshift(lastActionText());
    monitorElement.textContent = lines.join('\n');
    reportToDashboard(settings);
    checkForUpdate(settings);
    syncGrowth(settings);
    syncSharedSettings(settings);
    pollGlobalPause(settings);
    pollQueueOverview(settings);
    syncCloud(settings);
    sampleMoney(settings);
    checkCloudTransfers(settings);
    checkCardMarket(settings);
    keepRunLock();
    keepMiningLock();
    watchMining(settings);
    checkForgeCaptcha();
    if (!state.running) reloadForUpdateIfIdle();
    announceVerificationSolved(settings);
    if (state.running) shouldPause(settings);
    else resumeIfVerificationGone(settings);
  }

  // API 打怪：原地掛機／前進／後退都是 POST /api/hunt（前進後退加 ?type=），全隊休息 POST /api/heroes/restAll，
  // 休息到角色的完成時間後 POST /api/heroes/restAll/complete。不靠畫面按鈕，所以不用停在狩獵頁
  function isApiHunt(settings) {
    return Boolean(settings.huntByApiEnabled) && !state.forgeMode;
  }

  function huntTeam() {
    return (state.huntTeamIds || []).map((id) => state.heroStats.get(id)).filter(Boolean);
  }

  // 畫面上的血條可能不在（人在別頁），改用 API 拿到的隊伍數值判斷要不要暫停
  function pauseIfApiTeamInDanger(settings) {
    const team = huntTeam();
    const percent = (value, full) => (full ? (value / full) * 100 : 100);
    const names = (heroes) => heroes.map((hero) => hero.name).join('、');
    const dead = team.filter((hero) => hero.perished || hero.hp === 0);
    if (settings.deathPauseEnabled && dead.length) {
      pauseWithAlert(`${names(dead)} 死亡，已暫停`);
      return true;
    }
    const lowHealth = team.filter((hero) => percent(hero.hp, hero.fullHp) < settings.healthPausePercent);
    if (settings.healthPausePercent > 0 && lowHealth.length) {
      return handleLowHealth(settings, `${names(lowHealth)} 血量低於 ${settings.healthPausePercent}%`);
    }
    state.healthEscaping = false;
    const lowResource = team.filter((hero) => percent(hero.sp, hero.fullSp) < settings.resourcePausePercent);
    if (settings.resourcePausePercent > 0 && lowResource.length) {
      pauseWithAlert(`${names(lowResource)} 體力低於 ${settings.resourcePausePercent}%，已暫停`);
      return true;
    }
    return false;
  }

  // 地圖知識：API 回應的 huntZone 是地圖編號（城鎮 0、大草原 1；分支是另一個編號，像草原秘徑 10002、老鼠洞 20002），
  // 分支入口那一層的 huntInfo 會帶 paths（這層可以進的分支）。記下編號對應的名稱、哪個分支從哪張地圖第幾層進，
  // 區域表沒有的分支自動補上；也同步到雲端，一台電腦走過，別台不用再走
  const PLACES_KEY = 'autoClickerV2Places';
  const KNOWN_ZONES = { 0: '初始之鎮', 1: '大草原', 10002: '草原秘徑', 20002: '老鼠洞' };
  const PLACE_API_PATTERN = /\/api\//;
  const HUNT_INFO_PATTERN = /\/api\/huntInfo(?:\?|$)/;

  function loadPlaces() {
    const saved = readJsonStorage(PLACES_KEY, null) || {};
    const zones = { ...KNOWN_ZONES };
    // 學到的名稱蓋過內建的；同一個名稱只留一個編號
    Object.entries(saved.zones || {}).forEach(([zone, name]) => setZoneName(zones, zone, name));
    return { zones, forks: saved.forks || {} };
  }

  function savePlaces(places) {
    writeJsonStorage(PLACES_KEY, places);
  }

  function setZoneName(zones, zone, name) {
    if (!name || zones[zone] === name) return false;
    Object.keys(zones).forEach((other) => {
      if (zones[other] === name) delete zones[other];
    });
    zones[zone] = String(name);
    return true;
  }

  function zoneIdByName(places, name) {
    const entry = Object.entries(places.zones).find(([, zoneName]) => zoneName === name);
    return entry ? Number(entry[0]) : null;
  }

  function learnPlace(data) {
    const info = data && (data.huntZone !== undefined ? data : data.huntInfo);
    if (!info || info.huntZone === undefined || info.huntZone === null) return;
    const zone = Number(info.huntZone);
    const stage = Number(info.huntStage) || 0;
    const places = loadPlaces();
    let changed = setZoneName(places.zones, zone, info.zoneName);
    (Array.isArray(info.paths) ? info.paths : []).forEach((forkPath) => {
      if (!forkPath || forkPath.zoneId === undefined) return;
      const branch = Number(forkPath.zoneId);
      changed = setZoneName(places.zones, branch, forkPath.zoneName) || changed;
      const known = places.forks[branch];
      if (!known || known.parent !== zone || known.stage !== stage) {
        places.forks[branch] = { parent: zone, stage };
        changed = true;
      }
    });
    if (!changed) return;
    savePlaces(places);
    addLearnedAreas(places);
  }

  // 學到的分支區域表裡沒有，就補進空白列（已經有的不動，以使用者填的為準）
  function addLearnedAreas(places) {
    const settings = readSettingsFromPanel();
    const names = Array.from({ length: AREA_COUNT }, (_, index) => String(settings[areaKey(index, 'Name')] || '').trim());
    let added = 0;
    Object.entries(places.forks).forEach(([branch, fork]) => {
      const name = places.zones[branch];
      const parent = places.zones[fork.parent];
      const empty = names.indexOf('');
      if (!name || !parent || names.includes(name) || empty === -1) return;
      names[empty] = name;
      settings[areaKey(empty, 'Name')] = name;
      settings[areaKey(empty, 'Parent')] = parent;
      settings[areaKey(empty, 'ParentStage')] = fork.stage;
      added++;
    });
    if (!added) return;
    writeSettingsToPanel(settings);
    saveSettings(readSettingsFromPanel());
    refreshAreaList();
  }

  // 下一步怎麼移動。區域表決定分支從哪張地圖第幾層進（分支裡還可以再有分支，例如大草原 → 草原秘徑 → 迷霧森林）；
  // 分支的層數接著母地圖算，所以在母地圖走到那一層就能進。出分支只能回城或直接回某個大區第 1 層，
  // 所以不在目標那條路上就直接去目標大區第 1 層。回傳 null＝已到達；{ problem }＝走不了；{ type }＝前進／後退；{ path }＝打這支 API
  function planApiMove(settings) {
    const info = state.huntInfo;
    if (!settings.stageEnabled || !settings.stageTargetArea || !info || info.huntZone === undefined) return null;
    const places = loadPlaces();
    const zone = Number(info.huntZone);
    const stage = Number(info.huntStage) || 0;
    const hereName = places.zones[zone] || info.zoneName || `地圖 ${zone}`;
    const from = `目前「${hereName}${zone ? ` ${stage}` : ''}」→ 目標「${targetLabel(settings)}」`;
    const goTown = { from, label: '回城', path: '/api/move/0' };
    const targetName = settings.stageTargetArea;
    if (targetName === String(settings.townName || '').trim() || zoneIdByName(places, targetName) === 0) return zone === 0 ? null : goTown;

    const areas = new Map(configuredAreas(settings).map((area) => [area.name, area]));
    const target = areas.get(targetName);
    if (!target) return { problem: `區域表裡沒有「${targetName}」` };
    const chain = [target];
    while (chain[0].parent) {
      const parent = areas.get(chain[0].parent);
      if (!parent || chain.includes(parent)) return { problem: `區域表裡找不到「${chain[0].name}」的母區域「${chain[0].parent}」` };
      chain.unshift(parent);
    }
    const index = zone === 0 ? -1 : chain.findIndex((area) => area.name === hereName);
    if (index === -1) {
      // 直接移動被伺服器拒絕過（例如大區之間不能直接走）就先回城
      if (state.apiDirectMoveFailed && zone !== 0) return goTown;
      const bigAreaId = zoneIdByName(places, chain[0].name);
      if (bigAreaId === null) return { problem: `還不知道「${chain[0].name}」的地圖編號，請手動進去一次（之後會記住，也會同步到雲端）` };
      return { from, label: `前往${chain[0].name} 1`, path: `/api/move/${bigAreaId}` };
    }
    const step = (stageNumber) => ({ from, label: stage < stageNumber ? '前行' : '後退', type: stage < stageNumber ? 'forward' : 'back' });
    if (index === chain.length - 1) {
      if (!settings.stageTargetNumber || stage === settings.stageTargetNumber) return null;
      return step(settings.stageTargetNumber);
    }
    const next = chain[index + 1];
    const nextId = zoneIdByName(places, next.name);
    // 遊戲說這層就有這個分支的入口，區域表層數填錯也直接進
    const forkHere = (Array.isArray(info.paths) ? info.paths : []).some((forkPath) => forkPath && (forkPath.zoneName === next.name || Number(forkPath.zoneId) === nextId));
    if (!forkHere && stage !== next.parentStage) return step(next.parentStage);
    if (nextId === null) return { problem: `這層沒看到「${next.name}」的入口，確認區域表的進入層數` };
    return { from, label: `進入${next.name}`, path: `/api/moveForkPath/${nextId}` };
  }

  function performApiMove(settings, move) {
    clearItemSkips();
    if (move.type) huntByApi(settings, move.type, move.from);
    else moveByApi(settings, move);
  }

  function rememberApiPlace(info) {
    if (!info || info.huntZone === undefined) return;
    state.huntInfo = info;
    if (Array.isArray(info.heroes)) {
      state.heroStats = new Map(info.heroes.map((hero) => [hero.id, hero]));
      state.heroStatsAt = Date.now();
    }
  }

  // move/{編號} 要等角色的移動時間到了再 move/complete；分支這類是立刻到
  async function moveByApi(settings, move) {
    const runId = state.runId;
    try {
      const data = await requestGameApi(move.path, { method: 'POST' });
      if (runId !== state.runId) return;
      state.apiHuntFailures = 0;
      syncGameMove(data, /moveForkPath/.test(move.path) ? 'fork' : 'move');
      rememberApiPlace(data && data.huntZone !== undefined ? data : data && data.huntInfo);
      if (move.path === '/api/move/0') state.apiDirectMoveFailed = false;
      forgetZoneUsers();
      setStatus(`${move.from}：API ${move.label}`);
      const heroes = huntTeam();
      if (heroes.some((hero) => hero.actionState === 1)) {
        state.apiMoving = true;
        state.apiMoveUntil = restUntilOf(heroes);
        state.timerId = planTick(() => tick(settings), randomGap(1000, 3000));
        return;
      }
      scheduleApiHunt(settings, state.huntInfo);
    } catch (error) {
      if (runId !== state.runId) return;
      if (!error.captchaRequired && /^\/api\/move\/[1-9]/.test(move.path) && !state.apiDirectMoveFailed) {
        state.apiDirectMoveFailed = true;
        setStatus(`${move.from}：直接${move.label}失敗（${error.message}），改成先回城`);
        state.timerId = planTick(() => tick(settings), randomGap(3000, 6000));
        return;
      }
      handleApiHuntError(settings, error);
    }
  }

  async function finishMoveByApi(settings) {
    if (Date.now() < state.apiMoveUntil) {
      const delay = state.apiMoveUntil - Date.now() + finishMoveGap(settings);
      setStatus(`移動中，${Math.ceil(delay / 1000)} 秒後完成移動`);
      state.timerId = planTick(() => tick(settings), delay);
      return;
    }
    const runId = state.runId;
    try {
      const data = await requestGameApi('/api/move/complete', { method: 'POST' });
      if (runId !== state.runId) return;
      state.apiHuntFailures = 0;
      syncGameMove(data, 'complete');
      state.apiMoving = false;
      forgetZoneUsers();
      rememberApiPlace(data && data.huntZone !== undefined ? data : data && data.huntInfo);
      const places = loadPlaces();
      setStatus(`API 完成移動，到了${state.huntInfo ? places.zones[state.huntInfo.huntZone] || state.huntInfo.zoneName || '' : ''}`);
      scheduleApiHunt(settings, state.huntInfo);
    } catch (error) {
      if (runId !== state.runId) return;
      // 可能已經在別處（例如手動）完成了：重讀一次位置再判斷
      state.apiMoving = false;
      state.heroStatsAt = 0;
      handleApiHuntError(settings, error);
    }
  }

  // 等伺服器說可以打的時間（huntAvailableAt）再晚個 1～3 秒，像人看到冷卻結束才按
  function scheduleApiHunt(settings, huntInfo) {
    if (reloadForUpdateIfIdle()) return;
    const availableAt = huntInfo && huntInfo.huntAvailableAt ? Date.parse(huntInfo.huntAvailableAt) : 0;
    const cooldown = Math.max(0, (availableAt || 0) - Date.now());
    const sideWait = sideAccountWait(settings, cooldown);
    const delay = lowProfileDelay(settings, cooldown + huntReactGap(settings)) + sideWait;
    state.timerId = planTick(() => tick(settings), delay);
    statusElement.textContent += `（${(delay / 1000).toFixed(1)} 秒後下一步${sideWait ? '，小號慢一點' : ''}）`;
    bookHuntSlot(settings, Date.now() + delay);
  }

  function isMainAccount(settings) {
    const main = String(settings.mainAccountName || '').trim();
    const profile = dashboard.profile;
    return !main || (profile && (main === profile.nickname || main === String(profile.id)));
  }

  // 小號每輪多等一段，平均下來頻率是主帳號的 sideHuntPercent %；長短不一，不會變成固定節奏
  const SIDE_ROUND_MIN_MILLISECONDS = 10000;

  function sideAccountWait(settings, cooldown) {
    if (isMainAccount(settings)) return 0;
    const percent = Math.min(100, Math.max(10, Number(settings.sideHuntPercent) || 50));
    const round = Math.max(cooldown, SIDE_ROUND_MIN_MILLISECONDS) + ((Number(settings.huntReactMinSeconds) || 0) + (Number(settings.huntReactMaxSeconds) || 0)) * 500;
    return Math.round(round * (100 / percent - 1) * (0.6 + Math.random() * 0.8));
  }

  function setMainAccountToMe() {
    if (!dashboard.profile) {
      setStatus('還沒讀到這個帳號的名稱，稍等再按');
      return;
    }
    setPanelField('mainAccountName', dashboard.profile.nickname);
    const settings = readSettingsFromPanel();
    saveSettings(settings);
    if (settings.syncAccountsEnabled) pushSharedSettings(settings);
    setStatus(`主帳號：${dashboard.profile.nickname}${settings.syncAccountsEnabled ? '（其他帳號 10 秒內變小號）' : '（其他帳號也要填一樣的名稱）'}`);
  }

  function huntReactGap(settings) {
    const minimum = Math.max(0, Number(settings.huntReactMinSeconds) || 0);
    const maximum = Math.max(minimum, Number(settings.huntReactMaxSeconds) || 0);
    return randomGap(minimum * 1000, maximum * 1000);
  }

  // 多開輪流時，三個帳號的打怪時間先跟中繼站登記：撞在一起的往後挪一點，登記的時間到了操作權留給它，
  // 不用等別人讀完畫面、也不用跟別人搶
  function bookHuntSlot(settings, at) {
    if (!settings.turnTakingEnabled || Date.now() < turnTaking.downUntil) return;
    const runId = state.runId;
    const timerId = state.timerId;
    askTurnRelay(settings, 'turn/plan', 'POST', { query: `&at=${Math.round(at)}` })
      .then((reply) => Number(reply.at) || at)
      .catch(() => at)
      .then((slot) => {
        if (runId !== state.runId || state.timerId !== timerId || Date.now() > at - 200) return;
        if (slot > at + 50) {
          backgroundTimer.clearTimeout(state.timerId);
          state.timerId = planTick(() => tick(settings), slot - Date.now());
        }
        prefetchBeforeHunt(settings, slot, state.timerId);
      });
  }

  // 冷卻中先把畫面讀好（隊伍數值、同地圖玩家），時間到只剩「打」一下，不會輪到了才開始讀
  const PREFETCH_LEAD_MIN_MILLISECONDS = 1500;
  const PREFETCH_LEAD_MAX_MILLISECONDS = 2500;

  function prefetchBeforeHunt(settings, slot, timerId) {
    const fireAt = slot - randomGap(PREFETCH_LEAD_MIN_MILLISECONDS, PREFETCH_LEAD_MAX_MILLISECONDS);
    if (fireAt - Date.now() < 300) return;
    const runId = state.runId;
    backgroundTimer.setTimeout(async () => {
      if (!state.running || runId !== state.runId || state.timerId !== timerId) return;
      const current = readSettingsFromPanel();
      try {
        const moving = state.apiMoving || huntTeam().some((hero) => hero.actionState === 1);
        if (current.playerEscapeEnabled && !moving && !inTownNow(current) && slot - state.zoneUsersAt > ZONE_USERS_FRESH_MILLISECONDS) {
          state.zoneUsersAt = Date.now();
          await refreshZoneUsers();
        }
        if (needsHuntTeam(current) && slot - state.heroStatsAt > HERO_STATS_FRESH_MILLISECONDS) {
          await refreshHeroStats({ noLinger: true });
          state.heroStatsAt = Date.now();
        }
      } catch {
        // 讀不到就照舊，時間到了 tick 自己會再讀
      }
    }, fireAt - Date.now());
  }

  function handleApiHuntError(settings, error) {
    if (error.captchaRequired) {
      pauseForCaptcha(settings);
      return;
    }
    // 狀態錯誤多半是隊伍裡有人剛被拿去做別的事：重讀隊伍，下一輪由 waitForBusyHuntTeam 等它，不算失敗
    if (isHeroStateError(error) && (state.apiHeroStateErrors = (state.apiHeroStateErrors || 0) + 1) < 10) {
      state.heroStatsAt = 0;
      setStatus(`API 打怪：伺服器說英雄狀態不對（第 ${state.apiHeroStateErrors} 次），重讀隊伍後再試`);
      state.timerId = planTick(() => tick(settings), randomGap(10000, 20000));
      return;
    }
    state.apiHuntFailures = (state.apiHuntFailures || 0) + 1;
    if (state.apiHuntFailures >= 3) {
      pauseWithAlert(`API 打怪連續失敗：${error.message}`);
      return;
    }
    setStatus(`API 打怪失敗（${error.message}），稍後重試`);
    state.timerId = planTick(() => tick(settings), randomGap(5000, 10000));
  }

  const HERO_ACTION_NAMES = { 3: '復活', 4: '採礦', 5: '鍛造', 6: '販售', 7: '訓練' };

  // 隊伍裡有人在做別的事（鍛造、採礦、復活…）時打怪，伺服器一定回「英雄狀態錯誤」：等它做完再打
  function waitForBusyHuntTeam(settings) {
    const busy = huntTeam().filter((hero) => HERO_ACTION_NAMES[hero.actionState]);
    if (!busy.length) return false;
    const text = busy.map((hero) => `${hero.name}${HERO_ACTION_NAMES[hero.actionState]}中`).join('、');
    setStatus(`狩獵隊伍 ${text}，做完才能打怪（鍛造的話，到「自動鍛造」取消勾選這個角色，或把它移出隊伍）`);
    state.heroStatsAt = 0;
    state.timerId = planTick(() => tick(settings), randomGap(20000, 40000));
    return true;
  }

  function isHeroStateError(error) {
    return /英雄狀態錯誤/.test(String(error && error.message));
  }

  // 重複按開始時上一次打怪可能還在路上；不跟著 runId 重設，才擋得住緊接著再打一次
  let apiHuntInFlight = false;

  // 冷卻還沒過、或上一次還沒回來就打，伺服器一定回「仍在CD中」：先等。回傳 true＝已排好下一步
  function waitForHuntCooldown(settings, move) {
    if (move && !move.type) return false;
    if (apiHuntInFlight) {
      setStatus('上一次打怪還沒回來，等一下再打');
      state.timerId = planTick(() => tick(settings), randomGap(1000, 2000));
      return true;
    }
    if (!state.huntInfo) {
      const runId = state.runId;
      refreshHeroStats()
        .catch((error) => setStatus(`讀取狩獵資訊失敗（${error.message}）`))
        .then(() => {
          if (runId === state.runId) state.timerId = planTick(() => tick(settings), randomGap(1000, 2000));
        });
      return true;
    }
    const availableAt = Date.parse(state.huntInfo.huntAvailableAt) || 0;
    if (availableAt <= Date.now()) return false;
    setStatus('打怪冷卻中，冷卻結束再打');
    scheduleApiHunt(settings, state.huntInfo);
    return true;
  }

  async function huntByApi(settings, type, note = '') {
    const runId = state.runId;
    apiHuntInFlight = true;
    try {
      const data = await requestGameApi(`/api/hunt${type ? `?type=${type}` : ''}`, { method: 'POST' }).finally(() => {
        apiHuntInFlight = false;
      });
      if (data && data.huntInfo) state.huntInfo = data.huntInfo;
      if (runId !== state.runId) return;
      state.apiHuntFailures = 0;
      state.apiHeroStateErrors = 0;
      syncGameHuntView(data);
      clearItemSkips();
      if (!type) {
        state.clickCountA++;
        noteCheckinHunt();
      }
      setStatus(
        type
          ? `API ${type === 'forward' ? '前進' : '後退'}一層（${note || `目標第 ${settings.stageTargetNumber} 層`}）`
          : `第 ${state.cycleCount + 1} 輪：API 原地掛機 ${state.clickCountA}/${settings.repeatCount}`
      );
      scheduleApiHunt(settings, data && data.huntInfo);
    } catch (error) {
      if (runId !== state.runId) return;
      handleApiHuntError(settings, error);
    }
  }

  function restUntilOf(heroes) {
    const times = (heroes || []).map((hero) => Date.parse(hero.actionCompleteTime)).filter(Number.isFinite);
    return times.length ? Math.max(...times) : 0;
  }

  async function restByApi(settings) {
    const runId = state.runId;
    try {
      const data = await requestGameApi('/api/heroes/restAll', { method: 'POST' });
      if (runId !== state.runId) return;
      state.apiHuntFailures = 0;
      syncGameRestAll(data);
      state.apiResting = true;
      state.apiRestUntil = restUntilOf(data && data.heroes);
      if (data && data.huntZone !== undefined) state.huntInfo = data;
      finishCycle(settings);
    } catch (error) {
      if (runId !== state.runId) return;
      handleApiHuntError(settings, error);
    }
  }

  // 休息要到角色的完成時間才能結束；還沒到就等到那時候
  async function finishRestByApi(settings) {
    if (Date.now() < state.apiRestUntil) {
      const delay = lowProfileDelay(settings, state.apiRestUntil - Date.now() + randomGap(1000, 3000));
      setStatus(`全隊休息中，${Math.ceil(delay / 1000)} 秒後完成休息`);
      state.timerId = planTick(() => tick(settings), delay);
      return;
    }
    const runId = state.runId;
    try {
      const data = await requestGameApi('/api/heroes/restAll/complete', { method: 'POST' });
      if (runId !== state.runId) return;
      state.apiHuntFailures = 0;
      syncGameRestAll(data);
      state.apiResting = false;
      const info = data && data.huntInfo;
      if (info) {
        state.huntInfo = info;
        state.heroStats = new Map((info.heroes || []).map((hero) => [hero.id, hero]));
        state.heroStatsAt = Date.now();
      }
      setStatus(`第 ${state.cycleCount + 1} 輪：API 完成休息`);
      scheduleApiHunt(settings, info);
    } catch (error) {
      if (runId !== state.runId) return;
      handleApiHuntError(settings, error);
    }
  }

  function scheduleNext(settings) {
    if (reloadForUpdateIfIdle()) return;
    const delaySeconds = lowProfileDelay(settings, randomIntervalSeconds(settings) * 1000) / 1000;
    state.timerId = planTick(() => tick(settings), delaySeconds * 1000);
    statusElement.textContent += `（${delaySeconds.toFixed(1)} 秒後下一步）`;
  }

  // 均勻亂數平方後會集中在 0 附近，讓間隔大多落在下限附近、偶爾拉長，比較像真人。
  // 例如 8～20 秒：約一半落在 8～11 秒，只有約 13% 超過 17 秒
  function randomIntervalSeconds(settings) {
    return randomSkewedSeconds(settings.intervalMinSeconds, settings.intervalMaxSeconds);
  }

  function randomSkewedSeconds(first, second) {
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    return low + (high - low) * Math.random() ** 2;
  }

  // 按鈕在畫面上、而且沒有被停用（鍛造中「完成鍛造」通常是灰的）
  function isClickable(element) {
    return (
      Boolean(element) && isVisible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
    );
  }

  function scheduleForge(settings) {
    if (reloadForUpdateIfIdle()) return;
    const delaySeconds = randomSkewedSeconds(settings.forgeIntervalMinSeconds, settings.forgeIntervalMaxSeconds);
    state.timerId = planTick(() => tick(settings), delaySeconds * 1000);
    statusElement.textContent += `（${delaySeconds.toFixed(1)} 秒後巡下一個）`;
  }

  function forgeTarget(settings, shopIndex) {
    return settings[forgeKey(shopIndex, 'Switch')] ? settings[forgeKey(shopIndex, 'Count')] : 0;
  }

  // 開始次數做滿、而且最後一次也收完成品，這個鍛造坊才算做完
  function isForgeShopDone(settings, shopIndex) {
    return state.forgeStarted[shopIndex] >= forgeTarget(settings, shopIndex) && !state.forgePending[shopIndex];
  }

  function forgeProgressText(settings) {
    return Array.from({ length: FORGE_SHOP_COUNT }, (_, shopIndex) => shopIndex)
      .filter((shopIndex) => forgeTarget(settings, shopIndex) > 0)
      .map((shopIndex) => `${shopIndex + 1}:${state.forgeStarted[shopIndex]}/${forgeTarget(settings, shopIndex)}`)
      .join(' ');
  }

  // 輪流巡每個還沒做完的鍛造坊：切過去 → 好了就「完成鍛造」→ 次數沒滿就「開始鍛造」。
  // 不讀倒數時間，直接看按鈕能不能按，畫面上的時間格式怎麼變都不影響
  async function forgeTick(settings) {
    const runId = state.runId;
    if (state.needRest) {
      pauseWithAlert('鍛造體力不足，而且沒有道具可用');
      return;
    }
    const remaining = Array.from({ length: FORGE_SHOP_COUNT }, (_, shopIndex) => shopIndex).filter(
      (shopIndex) => forgeTarget(settings, shopIndex) > 0 && !isForgeShopDone(settings, shopIndex)
    );
    if (remaining.length === 0) {
      stop(`鍛造全部完成（${forgeProgressText(settings)}）`);
      return;
    }
    const shopIndex = remaining.find((index) => index > state.forgeCursor) ?? remaining[0];
    state.forgeCursor = shopIndex;
    const key = (name) => settings[forgeKey(shopIndex, name)];
    const label = `鍛造坊${shopIndex + 1}`;
    const stepMilliseconds = settings.itemStepSeconds * 1000;

    const switchButton = await waitForButton(key('Switch'), key('SwitchText'), '', BUTTON_WAIT_MILLISECONDS, runId);
    if (runId !== state.runId) return;
    if (!switchButton) {
      setStatus(`找不到${label}的切換按鈕`);
      scheduleForge(settings);
      return;
    }
    switchButton.click();
    await wait(stepMilliseconds);
    if (runId !== state.runId) return;

    const actions = [];
    const finishButton = findButton(settings.forgeFinish, settings.forgeFinishText, '');
    if (isClickable(finishButton)) {
      finishButton.click();
      state.forgePending[shopIndex] = false;
      actions.push('完成鍛造');
      await wait(stepMilliseconds);
      if (runId !== state.runId) return;
    }
    if (state.forgeStarted[shopIndex] < forgeTarget(settings, shopIndex)) {
      const startButton = findButton(settings.forgeStart, settings.forgeStartText, '');
      // 開工後就不能吃體力藥，所以要在按開始之前補；補完下一輪回到同一個鍛造坊再開工
      if (isClickable(startButton)) {
        await ensureFreshHeroStats(settings, { forge: true });
        if (runId !== state.runId) return;
      }
      const supplyTarget = isClickable(startButton) ? findSlotNeedingItem(settings, { forge: true }) : null;
      if (supplyTarget) {
        state.forgeCursor = shopIndex - 1;
        useItem(settings, supplyTarget);
        return;
      }
      if (isClickable(startButton)) {
        startButton.click();
        await wait(stepMilliseconds);
        if (runId !== state.runId) return;
        // 按了還能再按，代表沒開始成功（例如體力不夠），不算次數
        if (isClickable(findButton(settings.forgeStart, settings.forgeStartText, ''))) {
          actions.push('開始鍛造沒有反應');
        } else {
          state.forgeStarted[shopIndex]++;
          state.forgePending[shopIndex] = true;
          // 鍛造體力補到一半的格子，開工成功後就可以再試
          state.itemUsedSlots.clear();
          actions.push('開始鍛造');
        }
      }
    }
    const progress = `${state.forgeStarted[shopIndex]}/${forgeTarget(settings, shopIndex)}`;
    setStatus(`${label}：${actions.join('、') || '鍛造中，還沒完成'}（${progress}）`);
    scheduleForge(settings);
  }

  // 打怪要在狩獵頁、鍛造要在鍛造頁才找得到按鈕（API 鍛造也要在鍛造頁才能把配方填進表單）。
  // 用遊戲自己的連結切頁（不重新載入）；10 秒內切過還沒到就先等，不要一直點
  const MODE_PAGES = { hunt: '/hunt', forge: '/forge' };
  let lastNavigateAt = 0;
  function ensureModePage(settings) {
    if (!settings.autoNavigateEnabled || isApiHunt(settings)) return false;
    const target = state.forgeMode ? MODE_PAGES.forge : MODE_PAGES.hunt;
    if (location.pathname === target || location.pathname.startsWith(`${target}/`)) return false;
    if (Date.now() - lastNavigateAt >= 10000) {
      lastNavigateAt = Date.now();
      const link = [...document.querySelectorAll('a[href]')].find((anchor) => !panel.contains(anchor) && new URL(anchor.href, location.href).pathname === target);
      if (link) {
        link.click();
      } else {
        // 找不到選單連結就直接改網址，遊戲的路由會跟著換頁
        history.pushState(null, '', target);
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      }
      setStatus(`不在${state.forgeMode ? '鍛造' : '狩獵'}頁，自動切過去`);
    }
    state.timerId = planTick(() => tick(settings), 2500);
    return true;
  }

  function tick() {
    if (!state.running) return;
    // 每一步都重讀面板：要換裝的角色、可用道具這些清單常在按開始之後才勾，沿用開始時的設定會一直看不到
    const settings = readSettingsFromPanel();
    if (shouldPause(settings)) return;
    if (ensureModePage(settings)) return;

    const apiHunt = isApiHunt(settings);
    // 剛移動完要先按完成移動才能做其他事；按完只隔一個道具步驟就接著做，不用等整個間隔
    const finishMove = !apiHunt && clickFinishMoveIfReady(settings);
    if (finishMove === 'waiting') {
      const delay = state.finishMoveAt - Date.now();
      setStatus(`移動時間到了，${Math.ceil(delay / 1000)} 秒後按完成移動`);
      state.timerId = planTick(() => tick(settings), Math.max(delay, 200));
      return;
    }
    if (finishMove) {
      setStatus('已按完成移動');
      state.timerId = planTick(() => tick(settings), settings.itemStepSeconds * 1000);
      return;
    }

    if (state.forgeMode) {
      forgeTick(settings);
      return;
    }

    // 休息中也要看：紅名可能趁休息時打過來，先換好目標，休息完就走。
    // 城鎮和移動途中不看：從城鎮出發時伺服器回的還是城鎮的玩家，會把城裡的紅名當成目的地的
    const moving = isApiHunt(settings) && (state.apiMoving || huntTeam().some((hero) => hero.actionState === 1));
    const inTown = inTownNow(settings) || moving;
    if (settings.playerEscapeEnabled && !inTown && Date.now() - state.zoneUsersAt > ZONE_USERS_FRESH_MILLISECONDS) {
      const runId = state.runId;
      state.zoneUsersAt = Date.now();
      refreshZoneUsers()
        .catch((error) => setStatus(`讀取同地圖玩家失敗（${error.message}）`))
        .then(() => {
          if (runId === state.runId) tick(settings);
        });
      return;
    }
    if (!inTown && escapeFromPlayers(settings)) {
      state.timerId = planTick(() => tick(settings), 0);
      return;
    }
    if (!moving && returnAfterPlayerEscape(settings)) {
      state.timerId = planTick(() => tick(settings), 0);
      return;
    }

    // API 打怪：上一輪全隊休息後，到時間就完成休息；一開始就在休息中（例如手動按過）也一樣
    if (apiHunt && !state.apiResting && huntTeam().some((hero) => hero.actionState === 2)) {
      state.apiResting = true;
      state.apiRestUntil = restUntilOf(huntTeam());
    }
    if (apiHunt && state.apiResting) {
      finishRestByApi(settings);
      return;
    }
    // 換地圖要等移動時間到；一開始就在移動中（例如手動按過回城）也一樣
    if (apiHunt && !state.apiMoving && huntTeam().some((hero) => hero.actionState === 1)) {
      state.apiMoving = true;
      state.apiMoveUntil = restUntilOf(huntTeam());
    }
    if (apiHunt && state.apiMoving) {
      finishMoveByApi(settings);
      return;
    }

    if (!apiHunt && settings.selectorC && !state.clickedC) {
      if (clickBySelector(settings.selectorC)) {
        state.clickedC = true;
        setStatus(`第 ${state.cycleCount + 1} 輪：已點休息結束，稍後開始原地掛機`);
      } else {
        setStatus(`找不到「休息結束」按鈕，稍後重試`);
      }
      scheduleNext(settings);
      return;
    }

    // API 補給的條要先拿到最新的角色數值才能判斷；剛吃完藥時回應已帶回新數值，短時間內不重抓
    if (!state.needRest && needsHuntTeam(settings) && Date.now() - state.heroStatsAt > HERO_STATS_FRESH_MILLISECONDS) {
      const runId = state.runId;
      ensureFreshHeroStats(settings).then(() => {
        if (runId === state.runId) tick(settings);
      });
      return;
    }

    const supplyTarget = state.needRest ? null : findSlotNeedingItem(settings);
    if (supplyTarget) {
      if (waitToReact(settings, 'supply', '補給')) return;
      useItem(settings, supplyTarget);
      return;
    }

    if (!state.needRest && settings.equipApiEnabled) {
      if (Date.now() - state.equipmentsAt > EQUIPMENTS_FRESH_MILLISECONDS) {
        const runId = state.runId;
        refreshEquipments()
          .catch((error) => setStatus(`讀取裝備清單失敗（${error.message}）`))
          .then(() => {
            if (runId === state.runId) tick(settings);
          });
        return;
      }
      const worn = findWornEquipmentNeedingSwap(settings);
      if (worn) {
        if (waitToReact(settings, 'equip', '換裝')) return;
        swapEquipmentByApi(settings, worn);
        return;
      }
    }

    const equipCharacter = state.needRest || settings.equipApiEnabled ? -1 : findCharacterNeedingEquipment(settings);
    if (equipCharacter !== -1) {
      if (waitToReact(settings, 'equip', '換裝')) return;
      swapEquipment(settings, equipCharacter);
      return;
    }

    if (apiHunt && trainStep(settings)) return;

    if (state.clickCountA < settings.repeatCount && !state.needRest) {
      // 還沒到目標關卡就先移動，不算進原地掛機的次數，到了才開始照常掛機
      if (apiHunt) {
        if (pauseIfApiTeamInDanger(settings)) return;
        const move = planApiMove(settings);
        if (move && move.problem) {
          setStatus(`移動：${move.problem}`);
          state.timerId = planTick(() => tick(settings), randomGap(10000, 20000));
        } else if (waitForBusyHuntTeam(settings)) {
          return;
        } else if (!waitForHuntCooldown(settings, move)) {
          if (move) performApiMove(settings, move);
          else huntByApi(settings, '');
        }
        return;
      }
      const move = planMove(settings);
      if (move) {
        clearItemSkips();
        performMove(settings, move);
        return;
      }
      if (pauseIfResourceLow(settings)) return;
      if (clickBySelector(settings.selectorA)) {
        clearItemSkips();
        state.clickCountA++;
        noteCheckinHunt();
        setStatus(`第 ${state.cycleCount + 1} 輪：原地掛機 ${state.clickCountA}/${settings.repeatCount}`);
      } else {
        // 找不到時不計次，下一輪再試，避免頁面還在載入時就把次數用掉
        setStatus(`找不到「原地掛機」按鈕，稍後重試`);
      }
      scheduleNext(settings);
      return;
    }

    if (apiHunt) {
      restByApi(settings);
      return;
    }
    if (!clickBySelector(settings.selectorB)) {
      setStatus(`找不到「全隊休息」按鈕，稍後重試`);
      scheduleNext(settings);
      return;
    }
    finishCycle(settings);
  }

  // 全隊休息之後：算一輪，要循環就等一下再開始下一輪
  function finishCycle(settings) {
    state.cycleCount++;
    const reason = state.needRest ? '沒有道具' : `原地掛機 ${state.clickCountA} 次`;
    if (settings.loop) {
      state.clickCountA = 0;
      state.clickedC = false;
      state.needRest = false;
      state.itemUsedSlots.clear();
      state.equipSkipped.clear();
      state.equipApiSkipped.clear();
      setStatus(`${reason}，已全隊休息（完成 ${state.cycleCount} 輪），${settings.loopDelaySeconds} 秒後開始下一輪`);
      state.timerId = planTick(() => tick(settings), settings.loopDelaySeconds * 1000);
    } else {
      stop(`完成：${reason}，已全隊休息`);
    }
  }

  // 練等：換上要練的英雄、到練等關卡練到指定等級，再換回原本的隊伍和關卡。
  // 進度存起來（重新整理、暫停後按開始都接得下去）：phase 'toTown' 回城換人 → 'training' 練等 → 'back' 回城換回
  const TRAIN_STATE_KEY = 'autoClickerV2Train';
  // 遊戲規定：隊伍最多 4 人、不能有兩隻同種類，而且只能在城鎮裡換人
  const TEAM_LIMIT = 4;
  const train = { heroes: null, equipments: [], busy: false };

  function idList(text) {
    return String(text || '')
      .split(',')
      .map(Number)
      .filter(Boolean);
  }

  function trainEquipMap(settings) {
    try {
      return JSON.parse(settings.trainEquip || '{}') || {};
    } catch {
      return {};
    }
  }

  // 回傳空字串＝可以換；heroes 是 /api/heroes 的全部英雄
  function trainTeamProblem(settings, heroes) {
    const byId = new Map(heroes.map((hero) => [hero.id, hero]));
    const trainees = idList(settings.trainHeroIds).map((id) => byId.get(id)).filter(Boolean);
    if (!trainees.length) return '還沒勾要練的英雄';
    const keepIds = idList(settings.trainKeepIds);
    const kept = heroes.filter((hero) => hero.selected && keepIds.includes(hero.id) && !trainees.includes(hero));
    const team = [...kept, ...trainees];
    if (team.length > TEAM_LIMIT) return `隊伍最多 ${TEAM_LIMIT} 人，現在是 ${team.length} 人（留隊 ${kept.length}＋要練 ${trainees.length}）`;
    const types = team.map((hero) => hero.type);
    const duplicate = types.find((type, index) => types.indexOf(type) !== index);
    if (duplicate) return `隊伍裡不能有兩隻同種類的英雄（${duplicate}）`;
    const busy = trainees.find((hero) => !hero.selected && hero.actionState);
    if (busy) return `${busy.name} 正在做別的事（鍛造、挖礦…），要閒著才能加入隊伍`;
    return '';
  }

  function renderTrainChoices() {
    const box = panel.querySelector('[data-role="train-heroes"]');
    if (!train.heroes) return;
    const settings = readSettingsFromPanel();
    const keepIds = idList(settings.trainKeepIds);
    const traineeIds = idList(settings.trainHeroIds);
    const equipMap = trainEquipMap(settings);
    const heroName = new Map(train.heroes.map((hero) => [hero.id, hero.name]));
    const team = train.heroes.filter((hero) => hero.selected);
    const others = train.heroes.filter((hero) => !hero.selected);
    const heroText = (hero) => `${escapeHtml(hero.name)}　Lv ${hero.lv} ${escapeHtml(hero.type || '')}${hero.actionState ? '（行動中）' : ''}`;
    // 可以穿的：閒置的，或現在穿在隊員身上的（練完會還回去）
    const candidates = train.equipments
      .filter((equipment) => equipment.state === 0 && (equipment.equipped === null || team.some((hero) => hero.id === equipment.equipped)))
      .sort((first, second) => String(first.type).localeCompare(String(second.type)));
    const equipHtml = (hero) => {
      const chosen = (equipMap[hero.id] || []).map(Number);
      const worn = train.equipments.filter((equipment) => equipment.equipped === hero.id);
      const rows = candidates
        .map(
          (equipment) => `<label style="display:block"><input type="checkbox" data-train-choice="equip" data-hero="${hero.id}" value="${equipment.id}"
            ${chosen.includes(equipment.id) ? 'checked' : ''} style="width:auto;flex:none">
            ${escapeHtml(equipment.type)}・${escapeHtml(equipmentLabel(equipment))}（耐久 ${equipment.dur}/${equipment.fullDur}${
              equipment.equipped ? `，現在在 ${escapeHtml(heroName.get(equipment.equipped) || equipment.equipped)} 身上` : ''
            }）</label>`
        )
        .join('');
      return `<details style="margin-left:20px"><summary>穿什麼裝備（勾了 ${chosen.length} 件）</summary>
        <div class="hint">現在穿著：${worn.length ? worn.map((equipment) => escapeHtml(`${equipment.type}・${equipment.name}`)).join('、') : '沒有'}；同類型的會先脫下</div>
        ${rows || '<div class="hint">沒有閒置的裝備</div>'}</details>`;
    };
    const problem = trainTeamProblem(settings, train.heroes);
    box.innerHTML = `
      <div class="subhead">目前隊伍（勾＝練等時繼續待在隊伍）</div>
      ${team
        .map(
          (hero) => `<label style="display:block"><input type="checkbox" data-train-choice="keep" value="${hero.id}"
            ${keepIds.includes(hero.id) ? 'checked' : ''} style="width:auto;flex:none"> ${heroText(hero)}</label>`
        )
        .join('') || '<div class="hint">隊伍裡沒有英雄</div>'}
      <div class="subhead">要練的英雄</div>
      ${others
        .map(
          (hero) => `<label style="display:block"><input type="checkbox" data-train-choice="hero" value="${hero.id}"
            ${traineeIds.includes(hero.id) ? 'checked' : ''} style="width:auto;flex:none"> ${heroText(hero)}</label>
            ${traineeIds.includes(hero.id) ? equipHtml(hero) : ''}`
        )
        .join('') || '<div class="hint">隊伍外沒有英雄</div>'}
      <div class="hint" style="color:${problem ? '#f88' : '#8c8'}">${problem ? `⚠ ${escapeHtml(problem)}` : '✓ 可以換'}</div>`;
  }

  async function loadTrainChoices() {
    try {
      const [heroes] = await Promise.all([requestGameApi(HEROES_API), refreshEquipments()]);
      train.heroes = heroes.heroes || [];
      train.equipments = state.equipments;
      renderTrainChoices();
      setStatus(`練等：讀到 ${train.heroes.length} 隻英雄、${train.equipments.length} 件裝備`);
    } catch (error) {
      setStatus(`練等：讀取英雄或裝備失敗（${error.message}）`);
    }
  }

  function updateTrainFromChoices() {
    const checked = (kind) => Array.from(panel.querySelectorAll(`[data-train-choice="${kind}"]:checked`));
    const traineeIds = checked('hero').map((input) => Number(input.value));
    const equipMap = {};
    checked('equip').forEach((input) => {
      const heroId = Number(input.dataset.hero);
      if (traineeIds.includes(heroId)) (equipMap[heroId] = equipMap[heroId] || []).push(Number(input.value));
    });
    panel.querySelector('[data-field="trainKeepIds"]').value = checked('keep').map((input) => input.value).join(',');
    panel.querySelector('[data-field="trainHeroIds"]').value = traineeIds.join(',');
    panel.querySelector('[data-field="trainEquip"]').value = JSON.stringify(equipMap);
    renderTrainChoices();
  }

  function renderTrainStatus(settings = readSettingsFromPanel()) {
    const run = readJsonStorage(TRAIN_STATE_KEY, null);
    const element = panel.querySelector('[data-role="train-status"]');
    if (!run || !run.phase) {
      element.textContent = settings.trainEnabled ? '練等：等打怪開始後執行' : '';
      return;
    }
    const phaseText = { toTown: '回城換上要練的英雄', training: '練等中', back: '回城換回原本的隊伍' }[run.phase] || run.phase;
    const levels = huntTeam()
      .filter((hero) => idList(settings.trainHeroIds).includes(hero.id))
      .map((hero) => `${hero.name} Lv ${hero.lv}`)
      .join('、');
    element.textContent = `練等：${phaseText}${levels ? `（${levels}／目標 ${settings.trainLevel}）` : ''}；原本關卡 ${run.original.area} ${run.original.number}`;
  }

  function writeTrainState(run) {
    writeJsonStorage(TRAIN_STATE_KEY, run);
    renderTrainStatus();
  }

  // 只改移動目標，不跳提醒（moveTargetTo 是避難用的，會提醒）
  function setTrainTarget(area, stage, enabled = true) {
    setPanelField('stageEnabled', enabled);
    setPanelField('stageTargetArea', area);
    setPanelField('stageTargetNumber', stage);
  }

  // 隊伍資料還沒更新（剛換完人）時找不到要練的英雄，不能當成練好了
  function trainTraineesReady(settings) {
    const team = huntTeam();
    return idList(settings.trainHeroIds).every((heroId) => {
      const hero = team.find((member) => member.id === heroId);
      return hero && Number(hero.lv) >= Number(settings.trainLevel);
    });
  }

  function trainLog(message) {
    setStatus(`［練等］${message}`);
    logItemUse(`［練等］${message}`);
  }

  // tick 每一步都先問這裡；回傳 true＝這一步由練等接手（已排好下一次 tick）
  function trainStep(settings) {
    if (train.busy) return true;
    let run = readJsonStorage(TRAIN_STATE_KEY, null);
    if (!run || !run.phase) {
      if (!settings.trainEnabled) return false;
      if (!idList(settings.trainHeroIds).length || !settings.trainTargetArea) {
        setPanelField('trainEnabled', false);
        trainLog('沒勾要練的英雄或沒設練等關卡，已取消勾選');
        return false;
      }
      run = {
        phase: 'toTown',
        original: {
          area: settings.stageTargetArea,
          number: settings.stageTargetNumber,
          stageEnabled: settings.stageEnabled,
          teamIds: [...state.huntTeamIds],
        },
        restore: [],
      };
      writeTrainState(run);
      trainLog(`開始：記下原本的隊伍（${huntTeam().map((hero) => hero.name).join('、')}）和關卡 ${targetLabel(settings)}，先回城`);
    }
    if (!settings.trainEnabled && run.phase !== 'back') {
      run.phase = 'back';
      writeTrainState(run);
      trainLog('取消勾選，提早回城換回原本的隊伍');
    }
    if (run.phase === 'training') {
      if (!trainTraineesReady(settings)) {
        renderTrainStatus(settings);
        return false;
      }
      run.phase = 'back';
      writeTrainState(run);
      trainLog(`都練到 ${settings.trainLevel} 級了，回城換回原本的隊伍`);
    }
    const town = String(settings.townName || '').trim();
    const inTown = state.huntInfo && Number(state.huntInfo.huntZone) === 0;
    if (!inTown) {
      if (settings.stageTargetArea !== town || !settings.stageEnabled) {
        setTrainTarget(town, 0);
        state.timerId = planTick(() => tick(), 0);
        return true;
      }
      // 回城不用照原地掛機次數，直接走
      const move = planApiMove(readSettingsFromPanel());
      if (!move || move.problem) return false;
      performApiMove(readSettingsFromPanel(), move);
      return true;
    }
    train.busy = true;
    (run.phase === 'toTown' ? trainSwapIn(settings, run) : trainSwapBack(settings, run)).finally(() => {
      train.busy = false;
    });
    return true;
  }

  async function trainRequest(path) {
    await wait(randomGap(1500, 3000));
    return requestGameApi(path, { method: 'POST' });
  }

  async function trainEquipTo(equipmentId, heroId) {
    await wait(randomGap(1500, 3000));
    const result = await requestGameApi(`${EQUIPMENTS_API}/${equipmentId}/equip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ heroId }),
    });
    const after = equipmentInResult(result, equipmentId);
    if (!after || after.equipped !== heroId) throw new Error(`穿上裝備沒有生效（${describeEquipResult(result)}）`);
    state.equipments = result.equipments;
  }

  async function trainUnequip(equipmentId) {
    const result = await trainRequest(`${EQUIPMENTS_API}/${equipmentId}/unequip`);
    const after = equipmentInResult(result, equipmentId);
    if (!after || after.equipped !== null) throw new Error(`脫下裝備沒有生效（${describeEquipResult(result)}）`);
    state.equipments = result.equipments;
  }

  // 換隊伍：先移出、再加入（隊伍滿 4 人時加不進去）
  async function trainSetTeam(heroes, wanted) {
    for (const hero of heroes.filter((member) => member.selected && !wanted.includes(member.id))) {
      await trainRequest(`${HEROES_API}/${hero.id}/deselect`);
    }
    for (const heroId of wanted.filter((id) => !heroes.some((hero) => hero.id === id && hero.selected))) {
      await trainRequest(`${HEROES_API}/${heroId}/select`);
    }
  }

  function trainFailed(settings, error, what) {
    if (error.captchaRequired) {
      pauseForCaptcha(settings);
      return;
    }
    // 進度不清掉：處理完按開始會從這一步重來
    pauseWithAlert(`練等${what}失敗（${error.message}），已暫停；處理完按開始會接著做`);
  }

  async function trainSwapIn(settings, run) {
    const runId = state.runId;
    try {
      const heroes = (await requestGameApi(HEROES_API)).heroes || [];
      const problem = trainTeamProblem(settings, heroes);
      if (problem) {
        writeJsonStorage(TRAIN_STATE_KEY, null);
        setPanelField('trainEnabled', false);
        setTrainTarget(run.original.area, run.original.number, run.original.stageEnabled);
        pauseWithAlert(`練等沒辦法換隊伍：${problem}。已取消練等，隊伍沒動`);
        return;
      }
      const traineeIds = idList(settings.trainHeroIds);
      const keepIds = idList(settings.trainKeepIds).filter((heroId) => heroes.some((hero) => hero.id === heroId && hero.selected));
      await trainSetTeam(heroes, [...keepIds, ...traineeIds.filter((heroId) => !keepIds.includes(heroId))]);
      if (runId !== state.runId) return;
      await refreshEquipments();
      const equipMap = trainEquipMap(settings);
      for (const heroId of traineeIds) {
        for (const equipmentId of (equipMap[heroId] || []).map(Number)) {
          const equipment = state.equipments.find((candidate) => candidate.id === equipmentId);
          if (!equipment || equipment.equipped === heroId) continue;
          // 同類型的先脫下（例如原本拿的單手劍），練完再穿回去
          const replaced = state.equipments.find((worn) => worn.equipped === heroId && worn.type === equipment.type);
          if (replaced) {
            await trainUnequip(replaced.id);
            run.restore.push({ equipmentId: replaced.id, heroId });
            writeTrainState(run);
          }
          if (equipment.equipped) {
            const owner = equipment.equipped;
            await trainUnequip(equipment.id);
            run.restore.push({ equipmentId: equipment.id, heroId: owner });
            writeTrainState(run);
          }
          await trainEquipTo(equipment.id, heroId);
          if (runId !== state.runId) return;
        }
      }
      run.phase = 'training';
      writeTrainState(run);
      setTrainTarget(settings.trainTargetArea, settings.trainTargetNumber);
      state.heroStatsAt = 0;
      refreshGameView(HUNT_QUERY_KEYS);
      trainLog(`隊伍換好了，前往練等關卡 ${settings.trainTargetArea} ${settings.trainTargetNumber}`);
      if (runId === state.runId) state.timerId = planTick(() => tick(), randomGap(1000, 3000));
    } catch (error) {
      if (runId === state.runId) trainFailed(settings, error, '換隊伍');
    }
  }

  async function trainSwapBack(settings, run) {
    const runId = state.runId;
    try {
      const heroes = (await requestGameApi(HEROES_API)).heroes || [];
      const original = run.original.teamIds.filter((heroId) => heroes.some((hero) => hero.id === heroId));
      await trainSetTeam(heroes, original);
      if (runId !== state.runId) return;
      await refreshEquipments();
      const failed = [];
      // 後借的先還：同一件被借了兩次也會回到最早的主人身上
      for (const { equipmentId, heroId } of [...run.restore].reverse()) {
        const equipment = state.equipments.find((candidate) => candidate.id === equipmentId);
        if (!equipment || equipment.equipped === heroId) continue;
        try {
          if (equipment.equipped) await trainUnequip(equipment.id);
          await trainEquipTo(equipment.id, heroId);
        } catch (error) {
          if (error.captchaRequired) throw error;
          failed.push(`${equipment.name}（${error.message}）`);
        }
        if (runId !== state.runId) return;
      }
      writeJsonStorage(TRAIN_STATE_KEY, null);
      setPanelField('trainEnabled', false);
      setTrainTarget(run.original.area, run.original.number, run.original.stageEnabled);
      state.heroStatsAt = 0;
      refreshGameView(HUNT_QUERY_KEYS);
      renderTrainStatus();
      const message = `練等完成，換回原本的隊伍，回 ${run.original.area} ${run.original.number} 繼續打${failed.length ? `；這些裝備沒穿回去，請手動處理：${failed.join('、')}` : ''}`;
      trainLog(message);
      if (failed.length) alertUser(message);
      else showToast(message);
      if (runId === state.runId) state.timerId = planTick(() => tick(), randomGap(1000, 3000));
    } catch (error) {
      if (runId === state.runId) trainFailed(settings, error, '換回隊伍');
    }
  }

  // 同一個瀏覽器（同一個帳號）的分頁共用 localStorage，拿來當鎖：執行中的分頁每次巡視都更新時間，
  // 打怪、鍛造各一把鎖，所以一個打怪分頁＋一個鍛造分頁可以同時跑，兩個分頁做同一件事就不行
  const RUN_LOCK_PREFIX = 'autoClickerV2RunLock:';
  const RUN_LOCK_STALE_MILLISECONDS = 20000;

  function runLockKey(forgeMode) {
    return RUN_LOCK_PREFIX + (forgeMode ? 'forge' : 'hunt');
  }

  function otherTabRunning(forgeMode) {
    const lock = readJsonStorage(runLockKey(forgeMode), null);
    return lock && lock.tab !== tabKey && Date.now() - lock.at < RUN_LOCK_STALE_MILLISECONDS ? lock : null;
  }

  function releaseRunLock(forgeMode) {
    const lock = readJsonStorage(runLockKey(forgeMode), null);
    if (!lock || lock.tab !== tabKey) return;
    try {
      localStorage.removeItem(runLockKey(forgeMode));
    } catch {
      // 移不掉的話 20 秒後也會過期
    }
  }

  // 執行中定時呼叫：還沒人拿就拿；別的分頁正在用同一把鎖（兩邊幾乎同時開始）就讓這邊停下
  function keepRunLock() {
    if (forgeRunner.running) {
      if (otherTabRunning(true)) pauseForgeRunner('同一個帳號的另一個分頁也在鍛造，這個分頁的鍛造先停下');
      else writeJsonStorage(runLockKey(true), { tab: tabKey, at: Date.now() });
    }
    if (!state.running) return;
    if (otherTabRunning(state.forgeMode)) {
      pauseWithAlert(`同一個帳號的另一個分頁也在${state.forgeMode ? '鍛造' : '打怪'}，這個分頁先停下`);
      return;
    }
    writeJsonStorage(runLockKey(state.forgeMode), { tab: tabKey, at: Date.now() });
  }

  function start(forgeMode = false) {
    const settings = readSettingsFromPanel();
    if (forgeMode && settings.forgeByApiEnabled) {
      startForgeRunner();
      return;
    }
    if (otherTabRunning(forgeMode)) {
      setStatus(`同一個帳號的另一個分頁正在${forgeMode ? '鍛造' : '打怪'}，這個分頁不啟動（要換到這裡跑，先停掉那一邊）`);
      return;
    }
    dashboard.alert = '';
    if (forgeMode) {
      const hasShop = Array.from({ length: FORGE_SHOP_COUNT }, (_, index) => forgeTarget(settings, index) > 0).some(Boolean);
      if (!settings.forgeByApiEnabled && (!settings.forgeStart || !settings.forgeFinish || !hasShop)) {
        setStatus('請先在「鍛造」頁設定開始／完成鍛造按鈕，以及至少一個鍛造坊的切換按鈕與次數');
        return;
      }
    } else if (!settings.huntByApiEnabled && (!settings.selectorA || !settings.selectorB)) {
      setStatus('請先在「主流程」設定原地掛機與全隊休息按鈕');
      return;
    }
    saveSettings(settings);
    stop();
    clearAlert();
    prepareAlerts(settings);
    state.running = true;
    state.forgeMode = forgeMode;
    state.apiMoving = false;
    keepRunLock();
    rememberTabRole(forgeMode);
    // 第一輪不點 C，C 只在重新循環時才點
    state.clickedC = true;
    state.clickCountA = 0;
    state.cycleCount = 0;
    state.needRest = false;
    state.itemUsedSlots.clear();
    state.equipSkipped.clear();
    state.equipApiSkipped.clear();
    state.equipments = [];
    state.equipmentsAt = 0;
    state.forgeStarted =new Array(FORGE_SHOP_COUNT).fill(0);
    state.forgePending = new Array(FORGE_SHOP_COUNT).fill(false);
    state.forgeCursor = -1;
    state.forgeApiStarted = 0;
    state.heroStats = new Map();
    state.heroStatsAt = 0;
    // 寫進紀錄方便事後確認：用的是哪種計時器、道具每步實際等多久
    setStatus(`開始執行（${backgroundTimer.mode}，道具每步 ${settings.itemStepSeconds} 秒）`);
    tick(settings);
  }

  // 手動停止、重新開始或其他原因暫停都走這裡，順便取消等待中的自動繼續
  function stop(message) {
    if (state.running) releaseRunLock(state.forgeMode);
    state.running = false;
    state.verifyResumeMode = null;
    state.runId++;
    backgroundTimer.clearTimeout(state.timerId);
    if (message) setStatus(message);
  }

  // 選取模式：按住 Alt 點擊才抓 selector，一般點擊照常交給頁面。
  // 這樣可以先在頁面上打開道具介面（點外面就會關閉的那種），再 Alt+點擊裡面的按鈕
  let hoveredElement = null;
  const PRESS_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];

  // 頁面可能是在 pointerdown/mousedown 就觸發動作，Alt+點擊時連這些事件一起擋掉
  function onPickPress(event) {
    if (!event.altKey || panel.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onPickKey(event) {
    if (event.key !== 'Escape') return;
    endPicking();
    setStatus('已取消選取');
  }

  function onPickHover(event) {
    if (panel.contains(event.target)) return;
    if (hoveredElement) hoveredElement.classList.remove('auto-clicker-hover');
    hoveredElement = event.target;
    hoveredElement.classList.add('auto-clicker-hover');
  }

  function onPickClick(event) {
    if (!event.altKey || panel.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const field = panel.querySelector(`[data-field="${state.pickingTarget}"]`);
    let target;
    if (state.pickingMode.startsWith('ratio')) {
      // 點到的可能是只含「709」的子元素，往上找到含完整「709 / 744」的最小元素
      target = event.target;
      while (target && target !== document.body && parsePercent(target.textContent) === null) {
        target = target.parentElement;
      }
      if (!target || target === document.body) {
        setStatus('這裡找不到「數字 / 數字」或「xx%」格式，請點數值文字本身');
        return;
      }
    } else if (state.pickingMode === 'number') {
      // 耐久數字：點到外框或圖示時往上找到第一個含數字的元素
      target = event.target;
      while (target && target !== document.body && !/\d/.test(target.textContent)) {
        target = target.parentElement;
      }
      if (!target || target === document.body) {
        setStatus('這裡找不到數字，請點耐久數字本身');
        return;
      }
    } else if (state.pickingMode === 'log') {
      // 點到的通常只是其中一行，往上找到包含好幾行戰鬥描述的整個紀錄區
      target = event.target;
      while (target && target !== document.body && countCombatLines(target.innerText) < 2) {
        target = target.parentElement;
      }
      if (!target || target === document.body) {
        setStatus('這裡找不到戰鬥紀錄（造成…傷害、擊中…這類文字），請點紀錄裡的某一行');
        return;
      }
    } else {
      // 關卡這類純文字欄位要抓點到的元素本身，不能往上找按鈕
      target = state.pickingMode === 'element'
        ? event.target
        : event.target.closest('button, a, input, [role="button"]') || event.target;
    }
    const selector = buildSelector(target);
    const textField = panel.querySelector(`[data-field="${state.pickingTarget}Text"]`);
    if (textField) textField.value = buttonText(target);
    const contextField = panel.querySelector(`[data-field="${state.pickingTarget}Context"]`);
    if (contextField) contextField.value = buttonContext(target);
    if (state.pickingMode.endsWith('-append')) {
      field.value = field.value ? `${field.value}, ${selector}` : selector;
      setStatus(`已加入，目前 ${splitSelectors(field.value).length} 條`);
    } else {
      field.value = selector;
      setStatus(state.pickingMode === 'log' ? `已選取戰鬥紀錄區（目前有 ${countCombatLines(target.innerText)} 行戰鬥描述）` : '已選取');
    }
    endPicking();
    refreshSlotButtons();
    saveSettings(readSettingsFromPanel());
  }

  // 每列按鈕顯示是否已設定，滑鼠停在上面可看到 selector
  // 目標與「從哪裡進」的輸入框可以直接從區域表的名稱挑
  function refreshAreaList() {
    const settings = readSettingsFromPanel();
    const areas = configuredAreas(settings);
    const names = areas.map((area) => area.name);
    if (settings.townName) names.unshift(settings.townName);
    panel.querySelector('#auto-clicker-areas').innerHTML = names
      .map((name) => `<option value="${name.replace(/"/g, '&quot;')}"></option>`)
      .join('');
    const options = [
      ...(settings.townName ? [[settings.townName, `${settings.townName}（回城）`]] : []),
      ...areas.map((area) => [area.name, area.parent ? `${area.name}（${area.parent} ${area.parentStage} 層進）` : `${area.name}（大區）`]),
    ];
    panel.querySelectorAll('[data-area-select]').forEach((select) => {
      const current = settings[select.dataset.field];
      const choices = [...(select.dataset.field === 'stageTargetArea' ? [] : [['', '（未設定）']]), ...options];
      // 目前的目標不在區域表裡（例如改了名稱）也留著，看得出來要重選
      if (current && !choices.some(([name]) => name === current)) choices.push([current, `${current}（區域表裡沒有）`]);
      select.innerHTML = choices.map(([name, label]) => `<option value="${escapeHtml(name)}">${escapeHtml(label)}</option>`).join('');
      select.value = current;
    });
  }

  function refreshSlotButtons() {
    panel.querySelectorAll('[data-slot-label]').forEach((button) => {
      const value = panel.querySelector(`[data-field="${button.dataset.pick}"]`).value;
      const contextField = panel.querySelector(`[data-field="${button.dataset.pick}Context"]`);
      const context = contextField && contextField.value;
      button.textContent = button.dataset.slotLabel + (value ? ' ✓' : '');
      // 讓使用者確認記到的是哪個道具那一列
      button.title = (value || '未設定') + (context ? `\n辨識：${context}` : '');
    });
  }

  function endPicking() {
    if (hoveredElement) hoveredElement.classList.remove('auto-clicker-hover');
    hoveredElement = null;
    state.pickingTarget = null;
    state.pickingMode = null;
    document.removeEventListener('mouseover', onPickHover, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    PRESS_EVENTS.forEach((type) => document.removeEventListener(type, onPickPress, true));
  }

  panel.addEventListener('click', (event) => {
    const pickField = event.target.dataset.pick;
    const clearField = event.target.dataset.clear;
    const clearSlot = event.target.dataset.clearSlot;
    const action = event.target.dataset.action;
    noteManualAction(event, action);
    if (pickField) {
      endPicking();
      state.pickingTarget = pickField;
      state.pickingMode = event.target.dataset.pickMode || 'replace';
      const targetNames = { element: '關卡文字', replace: '目標按鈕', number: '耐久數字', log: '戰鬥紀錄裡任一行' };
      const targetName = state.pickingMode.startsWith('ratio') ? '數值文字（例如 709 / 744）' : targetNames[state.pickingMode];
      setStatus(`按住 Alt 點擊${targetName}；一般點擊可正常操作頁面，Esc 取消`);
      // 延後註冊，避免當下這次點擊被自己攔到
      setTimeout(() => {
        document.addEventListener('mouseover', onPickHover, true);
        document.addEventListener('click', onPickClick, true);
        document.addEventListener('keydown', onPickKey, true);
        PRESS_EVENTS.forEach((type) => document.addEventListener(type, onPickPress, true));
      });
    } else if (clearField) {
      panel.querySelector(`[data-field="${clearField}"]`).value = '';
      saveSettings(readSettingsFromPanel());
    } else if (event.target.dataset.clearFields) {
      event.target.dataset.clearFields.split(',').forEach((key) => {
        panel.querySelector(`[data-field="${key}"]`).value = '';
      });
      refreshSlotButtons();
      saveSettings(readSettingsFromPanel());
    } else if (event.target.dataset.captureHero) {
      startHeroCapture(event.target.dataset.captureHero);
    } else if (action === 'card-rule-add') {
      panel.querySelector('[data-role="card-rules"]').insertAdjacentHTML('beforeend', cardRuleRowHtml());
      panel.querySelector('[data-role="card-rules"] .card-rule:last-child [data-card-rule="type"]').focus();
    } else if (action === 'card-rule-remove') {
      event.target.closest('.card-rule').remove();
      updateCardRulesFromRows();
      saveSettings(readSettingsFromPanel());
    } else if (action === 'enchant-plan-clear') {
      enchantPlan.clear();
      renderMaterialSummary();
    } else if (action === 'draw-clear') {
      if (window.confirm('要清除這個帳號的抽卡紀錄嗎？清掉就找不回來')) {
        writeJsonStorage(DRAW_LOG_KEY, []);
        renderDrawStats();
      }
    } else if (action === 'load-train-heroes') {
      loadTrainChoices();
    } else if (action === 'train-reset') {
      writeJsonStorage(TRAIN_STATE_KEY, null);
      renderTrainStatus();
      setStatus('練等進度已清除（隊伍、關卡沒有動）');
    } else if (action === 'load-hunt-team') {
      loadHuntTeam();
    } else if (action === 'load-equipment-choices') {
      showEquipmentChoices();
    } else if (event.target.dataset.loadHeroes) {
      showHeroChoices(event.target.dataset.loadHeroes);
    } else if (event.target.dataset.loadItems) {
      showItemChoices(event.target.dataset.loadItems);
    } else if (event.target.dataset.characterButton !== undefined) {
      showCharacter(Number(event.target.dataset.characterButton));
    } else if (clearSlot !== undefined) {
      const [groupId, index] = clearSlot.split(':');
      Object.keys(SLOT_PARTS).forEach((part) => {
        panel.querySelector(`[data-field="${slotKey(groupId, part, Number(index))}"]`).value = '';
      });
      ['Use', 'Close'].forEach((part) => {
        ['Text', 'Context'].forEach((suffix) => {
          const field = panel.querySelector(`[data-field="${slotKey(groupId, part, Number(index))}${suffix}"]`);
          if (field) field.value = '';
        });
      });
      refreshSlotButtons();
      saveSettings(readSettingsFromPanel());
    } else if (action === 'start') {
      start();
    } else if (action === 'low-mode') {
      setLowMode(event.target.dataset.lowMode);
    } else if (action === 'main-account-me') {
      setMainAccountToMe();
    } else if (action === 'global-run' || action === 'global-temp' || action === 'global-stop') {
      setGlobalPause(readSettingsFromPanel(), action.slice('global-'.length));
    } else if (action === 'mining-start') {
      startMiningRunner();
    } else if (action === 'mining-stop') {
      if (miningRunner.running) stopMiningRunner('已停止挖礦');
      else miningLog('挖礦沒有在執行');
    } else if (action === 'mining-order-up' || action === 'mining-order-down') {
      moveMiningOrder(Number(event.target.dataset.hero), action === 'mining-order-up' ? -1 : 1);
    } else if (action === 'mining-potions') {
      loadMiningPotions();
    } else if (action === 'mining-refresh') {
      readMiningHeroes(readSettingsFromPanel()).catch((error) => miningLog(`讀取角色失敗（${error.message}）`));
    } else if (action === 'forge-start') {
      start(true);
    } else if (action === 'forge-stop') {
      // 只停鍛造；正在掛機時按到不會把掛機停掉
      if (forgeRunner.running) {
        stopForgeRunner('已停止鍛造');
        clearAlert();
      } else if (state.running && state.forgeMode) {
        stop('已停止鍛造');
        clearAlert();
      } else {
        setStatus('鍛造沒有在執行');
      }
    } else if (action === 'forge-plan-copy') {
      const row = panel.querySelector(`[data-forge-plan-hero="${event.target.dataset.hero}"]`);
      const settings = readSettingsFromPanel();
      row.querySelector('[data-forge-plan="type"]').value = settings.forgeRecipeType;
      row.querySelector('[data-forge-plan="recipe"]').value = settings.forgeRecipe;
      updateForgeApiPlansFromChoices();
      saveSettings(readSettingsFromPanel());
      renderForgePlanOverview();
    } else if (action === 'forge-api-heroes') {
      showForgeApiHeroChoices().catch((error) => setStatus(`讀取角色失敗（${error.message}）`));
    } else if (action === 'card-buy-reset') {
      writeJsonStorage(CARD_BUY_STATE_KEY, { spent: 0, bought: 0 });
      renderCardBuyStatus();
    } else if (action === 'card-notified-reset') {
      writeJsonStorage(CARD_NOTIFIED_KEY, []);
      cardBuyLog('下一輪符合的卡會再提醒一次');
    } else if (action === 'card-alert-history-clear') {
      writeJsonStorage(CARD_ALERT_HISTORY_KEY, []);
      renderCardAlertHistory();
    } else if (action === 'card-buy-check-now') {
      const settings = readSettingsFromPanel();
      if (!settings.cardBuyEnabled) cardBuyLog('先勾「查拍賣場英雄」');
      else {
        checkCardMarket(settings, { force: true });
      }
    } else if (action === 'transfer-refresh') {
      refreshTransferChoices(readSettingsFromPanel())
        .then(() => transferLog('已重新讀取'))
        .catch((error) => transferLog(`讀取失敗（${error.message}）`));
    } else if (action === 'transfer-money') {
      startMoneyTransfer(readSettingsFromPanel()).catch((error) => transferLog(`轉金幣失敗：${error.message}`));
    } else if (action === 'transfer-hero') {
      startHeroTransfer(readSettingsFromPanel()).catch((error) => transferLog(`轉角色失敗：${error.message}`));
    } else if (action === 'growth-viewer') {
      openGrowthViewer();
    } else if (action === 'material-viewer') {
      renderMaterialSummary();
      openMaterialViewer();
    } else if (action === 'mines-refresh') {
      refreshMineStock()
        .then(() => {
          renderRecipePicker();
          renderRecipes();
          setStatus(`材料庫存 ${mineStock.length} 種`);
        })
        .catch((error) => setStatus(`讀取材料失敗（${error.message}）`));
    } else if (action === 'recipe-queue') {
      queueHeroForForge(Number(event.target.dataset.hero));
    } else if (action === 'forge-unqueue') {
      unqueueHeroForForge(Number(event.target.dataset.hero));
    } else if (action === 'recipe-forge-once') {
      forgeWithRecipe(readSettingsFromPanel(), Number(event.target.dataset.hero));
    } else if (action === 'recipe-auto-forge') {
      if (!forgeByApiHeroIds(readSettingsFromPanel()).length) {
        setStatus('佇列是空的：先在上面的角色按「加入」');
      } else {
        setPanelField('forgeByApiEnabled', true);
        setPanelField('forgeByApiCount', readSettingsFromPanel().forgeRecipeRepeat);
        start(true);
      }
    } else if (action === 'name-use') {
      setPanelField('forgeRecipeName', event.target.dataset.name);
    } else if (action === 'name-sheet-refresh') {
      setStatus('讀取測名表中…');
      refreshNameWeights(true)
        .then((weights) => {
          setStatus(`測名表已更新（今天 ${Object.keys(weights.days[localDayKey(Date.now())] || {}).length} 個名稱）`);
          renderRecipes();
        })
        .catch((error) => setStatus(`讀取測名表失敗（${error.message}）`));
    } else if (action === 'recipe-use') {
      setPanelField('forgeRecipe', event.target.dataset.recipe);
    } else if (action === 'recipe-heroes') {
      refreshForgeHeroes(true).catch((error) => setStatus(`讀取角色失敗（${error.message}）`));
    } else if (action === 'hunt-stats-clear') {
      if (!window.confirm('要清除所有樓層統計與掉落紀錄嗎？')) return;
      writeJsonStorage(HUNT_STATS_KEY, { places: {}, recent: [] });
      renderHuntStats();
    } else if (action === 'cloud-sync-now') {
      cloudSync.at = 0;
      setCloudStatus('同步中…');
      syncCloud(readSettingsFromPanel());
    } else if (action === 'material-refresh') {
      refreshMaterialSummary();
    } else if (action === 'quality-pick-scan') {
      showPickChoices();
    } else if (action === 'quality-pick') {
      pickItemsByQuality(readSettingsFromPanel());
    } else if (action === 'quality-pick-stop') {
      if (qualityPick.running) qualityPick.runId++;
    } else if (action === 'growth-sync-now') {
      growthSync.at = 0;
      setGrowthSyncStatus('同步中…');
      syncGrowth(readSettingsFromPanel());
    } else if (action === 'growth-refresh') {
      renderGrowthSummary();
    } else if (action === 'growth-export-file') {
      exportGrowthToFile();
    } else if (action === 'growth-export-copy') {
      exportGrowthToClipboard();
    } else if (action === 'growth-import-file') {
      panel.querySelector('[data-role="growth-import-file"]').click();
    } else if (action === 'growth-import-text') {
      const textArea = panel.querySelector('[data-role="growth-share-text"]');
      importGrowthShare(textArea.value, '貼上的內容');
      textArea.value = '';
    } else if (action === 'growth-load-types') {
      loadGrowthHeroTypes();
    } else if (action === 'export-file') {
      exportToFile();
    } else if (action === 'export-copy') {
      exportToClipboard();
    } else if (action === 'import-file') {
      panel.querySelector('[data-role="import-file"]').click();
    } else if (action === 'import-text') {
      importSettings(panel.querySelector('[data-role="import-text"]').value);
    } else if (action === 'reset-combat') {
      resetCombatStats();
    } else if (action === 'copy-last-report') {
      copyCombatText(combatStats.lastReport, '上一場戰報');
    } else if (action === 'copy-anomalies') {
      copyCombatText(anomaliesText(), '異常戰報');
    } else if (action === 'clear-anomalies') {
      clearCombatAnomalies();
    } else if (action === 'item-log-copy') {
      copyItemLog();
    } else if (action === 'growth-import') {
      const textArea = panel.querySelector('[data-role="growth-import"]');
      try {
        const heroCount = growthTracker.importStorage(textArea.value);
        textArea.value = '';
        setStatus(`已匯入成長值紀錄（${heroCount} 個角色）`);
      } catch (error) {
        setStatus(`匯入成長值紀錄失敗（${error.message}），請確認貼的是整份 JSON`);
      }
    } else if (action === 'item-log-clear') {
      itemLogLines = [];
      logItemUse('（清除紀錄）');
    } else if (action === 'api-record') {
      toggleApiRecording();
    } else if (action === 'api-copy') {
      copyApiLog();
    } else if (action === 'api-clear') {
      apiRecorder.entries = [];
      renderApiLog();
    } else if (action === 'test-sound') {
      ensureAudio();
      playBeeps(readSettingsFromPanel().alertVolume);
    } else if (event.target.dataset.tabGroup) {
      showTabGroup(event.target.dataset.tabGroup);
    } else if (event.target.dataset.tabButton) {
      showTab(event.target.dataset.tabButton);
    } else if (action === 'minimize') {
      setMinimized(panelBody.style.display !== 'none');
    } else if (action === 'close') {
      const message = '關閉後這個分頁的腳本全部停止（掛機、鍛造、監控、總覽回報、自動更新），總覽頁也不會再顯示這個分頁；只保留角色成長值紀錄。重新整理頁面才會恢復。要關閉嗎？';
      if (window.confirm(message)) shutDownTab();
    } else if (action === 'stop') {
      stop('已停止');
      clearAlert();
    }
  });

  // 想改成直接呼叫遊戲 API 吃藥、不用再設定要點哪個按鈕，先錄下手動吃藥時網頁送出的請求，判斷可不可行
  const API_LOG_LIMIT = 100;
  const API_TEXT_LIMIT = 1500;
  // heroCapture：按了「抓取」的那一條（"群組:索引"），等使用者手動吃一次道具時記下 heroId
  const apiRecorder = { recording: false, entries: [], heroCapture: null };
  const ITEM_USE_URL_PATTERN = /\/api\/items\/\d+\/use/;

  function captureHeroId(url, requestBody) {
    if (!apiRecorder.heroCapture || !ITEM_USE_URL_PATTERN.test(url)) return;
    let heroId;
    try {
      heroId = JSON.parse(requestBody).heroId;
    } catch {
      return;
    }
    if (!heroId) return;
    const [groupId, index] = apiRecorder.heroCapture.split(':');
    apiRecorder.heroCapture = null;
    panel.querySelector(`[data-field="${forgeHeroKey(Number(index))}"]`).value = heroId;
    saveSettings(readSettingsFromPanel());
    setStatus(`已記下第 ${Number(index) + 1} 條的 heroId：${heroId}`);
  }

  function startHeroCapture(target) {
    apiRecorder.heroCapture = target;
    const [groupId, index] = target.split(':');
    const group = SUPPLY_GROUPS.find((candidate) => candidate.id === groupId);
    setStatus(`請手動替第 ${Number(index) + 1} 條${group.name}的角色吃一次道具，會自動記下 heroId`);
  }
  // 紀錄要貼出去給人看，名稱像憑證的欄位一律遮掉
  const SECRET_KEY_PATTERN = /token|auth|password|passwd|secret|session|cookie|sign/i;
  // 圖片、樣式這類請求和遊戲操作無關，只會把紀錄洗掉
  const STATIC_ASSET_PATTERN = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|mp3|ogg|wav)(\?|#|$)/i;

  function maskSecrets(text) {
    return text
      .replace(/("([^"]+)"\s*:\s*)"[^"]*"/g, (match, prefix, name) => (SECRET_KEY_PATTERN.test(name) ? `${prefix}"***"` : match))
      .replace(/((?:^|[?&])([^=&\s?]+)=)[^&\s]*/g, (match, prefix, name) => (SECRET_KEY_PATTERN.test(name) ? `${prefix}***` : match));
  }

  function shortenApiText(text) {
    return text.length > API_TEXT_LIMIT ? `${text.slice(0, API_TEXT_LIMIT)}…（共 ${text.length} 字）` : text;
  }

  function bodyToText(body) {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      return Array.from(body.entries())
        .map(([name, value]) => `${name}=${typeof value === 'string' ? value : '[檔案]'}`)
        .join('&');
    }
    if (body instanceof Blob) return `[Blob ${body.size} bytes]`;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[二進位 ${body.byteLength} bytes]`;
    return String(body);
  }

  // 回應很長時內容會被截斷，另外列出兩層欄位名稱，才看得到後面還有哪些資料（例如角色體力）
  function jsonOutline(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return '';
    }
    const describe = (value) => {
      if (Array.isArray(value)) return `[${value.length} 筆]`;
      if (value && typeof value === 'object') return `{${Object.keys(value).join(', ')}}`;
      return typeof value;
    };
    if (!data || typeof data !== 'object' || Array.isArray(data)) return describe(data);
    return Object.entries(data)
      .map(([name, value]) => `${name}${describe(value)}`)
      .join('; ');
  }

  function recordApi(lines) {
    if (!apiRecorder.recording) return;
    const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    const text = lines
      .filter(Boolean)
      .map((line) => maskSecrets(shortenApiText(line)))
      .join('\n  ');
    apiRecorder.entries.push(`[${time}] ${text}`);
    if (apiRecorder.entries.length > API_LOG_LIMIT) apiRecorder.entries.shift();
    renderApiLog();
  }

  function renderApiLog() {
    const textArea = panel.querySelector('[data-role="api-log"]');
    textArea.value = apiRecorder.entries.join('\n\n');
    textArea.scrollTop = textArea.scrollHeight;
  }

  function toggleApiRecording() {
    apiRecorder.recording = !apiRecorder.recording;
    panel.querySelector('[data-action="api-record"]').textContent = apiRecorder.recording ? '停止錄製' : '開始錄製';
    setStatus(apiRecorder.recording ? 'API 錄製中，請手動操作一次吃藥' : `API 錄製已停止（${apiRecorder.entries.length} 筆）`);
  }

  async function copyApiLog() {
    const text = `頁面：${location.href}\n\n${apiRecorder.entries.join('\n\n')}`;
    if (!apiRecorder.entries.length) {
      setStatus('還沒有 API 紀錄');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已複製 API 紀錄');
    } catch {
      // 有些環境不允許寫剪貼簿，改成選取文字框讓使用者自己複製
      const textArea = panel.querySelector('[data-role="api-log"]');
      textArea.select();
      setStatus('無法直接複製，請在 API 文字框按 Ctrl+C');
    }
  }

  // 遊戲可能用 fetch、XHR 或 WebSocket 其中一種，三種都包起來；不在錄製時原樣放行
  function installApiRecorder() {
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      // 關閉面板＝不掛機也不回報，但手動玩的升級還是要記，所以只留成長值紀錄
      const growthOnly = tabShutDown;
      if (growthOnly && !readSettingsFromPanel().growthEnabled) return originalFetch.apply(this, args);
      const [input, init = {}] = args;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      try {
        const token = new Headers(init.headers || (input instanceof Request ? input.headers : undefined)).get('token');
        if (token) gameToken = token;
      } catch {
        // 標頭格式特殊就不記
      }
      const isHunt = HUNT_API_PATTERN.test(url);
      const growthHeroId = growthTracker.heroIdFromUrl(url);
      const isHeroList = HERO_LIST_PATTERN.test(url);
      const isEquipmentList = !growthOnly && EQUIPMENT_LIST_PATTERN.test(url);
      const isForgeData = FORGE_START_PATTERN.test(url) || FORGE_COMPLETE_PATTERN.test(url) || ITEM_LIST_PATTERN.test(url);
      const itemUseMatch = !growthOnly && url.match(ITEM_USE_PATTERN);
      const isCardMarket = !growthOnly && (MARKET_HEROES_PATTERN.test(url) || RELEASED_MARKET_PATTERN.test(url));
      const isOtherSite = /^https?:/i.test(url) && !url.startsWith(location.origin);
      const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const isPlace = PLACE_API_PATTERN.test(url) && (method !== 'GET' || HUNT_INFO_PATTERN.test(url));
      const isMoney = !growthOnly && PLACE_API_PATTERN.test(url) && (method !== 'GET' || MONEY_API_PATTERN.test(url));
      const needsResponse = growthOnly
        ? isHunt || growthHeroId || isHeroList || isForgeData || isPlace
        : apiRecorder.recording || apiRecorder.heroCapture || isHunt || growthHeroId || isHeroList || isEquipmentList || isForgeData || itemUseMatch || isPlace || isMoney || isCardMarket;
      if (!needsResponse || STATIC_ASSET_PATTERN.test(url) || isOtherSite) {
        return originalFetch.apply(this, args);
      }
      // 只記標頭名稱不記值：看得出要不要另外帶 Authorization，又不會把憑證貼出去
      let headerNames = '';
      try {
        headerNames = Array.from(new Headers(init.headers || (input instanceof Request ? input.headers : undefined)).keys()).join(', ');
      } catch {
        // 標頭格式特殊就不記
      }
      // Request 的內容只能讀一次，要在送出前先複製一份
      const requestBodyPromise =
        input instanceof Request && init.body === undefined
          ? input.clone().text().catch(() => '')
          : Promise.resolve(bodyToText(init.body));
      // 回應內容也只能讀一次，必須在交給網頁之前先複製，否則網頁讀完就複製不了
      return originalFetch.apply(this, args).then(
        (response) => {
          const responseTextPromise = response.clone().text().catch(() => '[讀不到回應內容]');
          Promise.all([requestBodyPromise, responseTextPromise]).then(([requestBody, responseText]) => {
            if (response.ok && !growthOnly) captureHeroId(url, requestBody);
            if (response.ok && growthHeroId && readSettingsFromPanel().growthEnabled) {
              try {
                growthTracker.processHeroData(growthHeroId, JSON.parse(responseText));
              } catch (error) {
                console.error('成長值紀錄解析失敗', error);
              }
            }
            if (response.ok && isHeroList && readSettingsFromPanel().growthEnabled) {
              try {
                const heroes = JSON.parse(responseText).heroes || [];
                growthTracker.rememberHeroList(heroes);
                growthTracker.noticeTeamLevels(heroes, fetchHeroDetail, '', { knownOnly: true });
              } catch (error) {
                console.error('成長值紀錄解析失敗', error);
              }
            }
            if (response.ok && isHunt && growthOnly) {
              try {
                const { huntInfo } = JSON.parse(responseText);
                if (huntInfo && Array.isArray(huntInfo.heroes)) {
                  growthTracker.noticeTeamLevels(huntInfo.heroes, fetchHeroDetail, huntPlace(huntInfo));
                }
              } catch {
                // 回應格式不對就略過，等打開角色頁時再補
              }
            }
            if (response.ok && isForgeData) {
              const data = parseJsonText(responseText);
              const completeMatch = method === 'POST' && url.match(FORGE_COMPLETE_PATTERN);
              if (data) rememberItemNames(data);
              // 遊戲自己讀物品欄（例如打開物品頁、買完東西）就順便更新材料庫存，不用另外打請求
              if (data && method === 'GET' && Array.isArray(data.mines)) {
                setMineStock(data);
                if (activeTab === 'forge') renderForgePlanOverview();
                if (activeTab === 'recipe') renderRecipePicker();
              }
              if (method === 'POST' && FORGE_START_PATTERN.test(url)) rememberForgeStart(requestBody, data);
              if (completeMatch) rememberForgeComplete(completeMatch[1], data).catch((error) => console.error('鍛造材料紀錄失敗', error));
              // 收爐、開爐的回應帶全部角色
              if (method === 'POST' && data && Array.isArray(data.heroes)) {
                noticeHeroList(data);
                wakeForgeRunner();
              }
            }
            if (response.ok && isPlace) learnPlace(parseJsonText(responseText));
            if (growthOnly) return;
            if (response.ok && isMoney && readSettingsFromPanel().incomeEnabled) {
              const data = parseJsonText(responseText);
              if (data && typeof data.money === 'number') {
                recordMoneyChange(data.money, url, method, isHunt && method === 'POST' ? huntMessageMoney(data.report && data.report.messages) : {}, data.robbedMoney);
              } else if (method !== 'GET' && !isHunt) {
                rememberMoneyAction(url);
              }
            }
            if (response.ok && isCardMarket && method === 'GET') noticeGameMarket(url, parseJsonText(responseText));
            // 角色列表不管是遊戲自己讀（每 16 秒、抽到新卡、買賣角色後）還是腳本讀的，挖礦頁都跟著換，新卡馬上看得到
            if (response.ok && method === 'GET' && isHeroList) noticeHeroList(parseJsonText(responseText));
            if (response.ok && itemUseMatch) {
              const data = parseJsonText(responseText);
              if (data && data.drawResult) {
                recordDraw(itemUseMatch[1], data);
                markMiningHeroesStale();
              }
            }
            if (response.ok && itemUseMatch && readSettingsFromPanel().incomeEnabled) {
              const data = parseJsonText(responseText);
              // 回應帶最新的物品欄（items.items），先記名稱，吃完剛好用光的道具才查得到名字
              if (data && data.items) rememberItemNames(Array.isArray(data.items) ? data : data.items);
              const body = parseJsonText(requestBody) || {};
              recordConsumption(itemName(itemUseMatch[1]), Number(body.quantity) || 1);
            }
            if (response.ok && isEquipmentList) {
              try {
                const equipments = JSON.parse(responseText).equipments || [];
                matchPendingForges(equipments);
                rememberForgedEquipments(equipments);
                rememberLatestEquipments(equipments);
              } catch {
                // 格式不對就不記，不影響遊戲
              }
            }
            if (response.ok && isHunt) {
              try {
                handleHuntResponse(JSON.parse(responseText), requestBody, url);
              } catch {
                // 回應格式不對就照舊讀畫面
              }
            }
            recordApi([
              `fetch ${method} ${url}`,
              headerNames && `標頭：${headerNames}`,
              requestBody && `送出：${requestBody}`,
              jsonOutline(responseText) && `回應結構：${jsonOutline(responseText)}`,
              `回應 ${response.status}：${responseText}`,
            ]);
          });
          return response;
        },
        (error) => {
          requestBodyPromise.then((requestBody) =>
            recordApi([`fetch ${method} ${url}`, requestBody && `送出：${requestBody}`, `失敗：${error}`])
          );
          throw error;
        }
      );
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.autoClickerRequest = { method: String(method).toUpperCase(), url: String(url) };
      return originalOpen.call(this, method, url, ...rest);
    };
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (String(name).toLowerCase() === 'token' && value) gameToken = String(value);
      return originalSetRequestHeader.call(this, name, value);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const request = this.autoClickerRequest;
      if (apiRecorder.recording && request && !STATIC_ASSET_PATTERN.test(request.url)) {
        const requestBody = bodyToText(body);
        this.addEventListener('loadend', () => {
          let responseText;
          try {
            responseText = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
          } catch {
            responseText = `[${this.responseType} 格式]`;
          }
          recordApi([`XHR ${request.method} ${request.url}`, requestBody && `送出：${requestBody}`, `回應 ${this.status}：${responseText}`]);
        });
      }
      return originalSend.call(this, body);
    };

    // 送出的部分改 prototype，連腳本載入前就連上的連線也錄得到；收到的部分只能錄之後新開的連線
    const originalSocketSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      recordApi([`WebSocket 送出 ${this.url}`, bodyToText(data)]);
      return originalSocketSend.call(this, data);
    };
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        socket.addEventListener('message', (event) => {
          recordApi([`WebSocket 收到 ${socket.url}`, typeof event.data === 'string' ? event.data : bodyToText(event.data)]);
        });
        return socket;
      },
    });

    // 標出每個請求是點了哪個按鈕觸發的，才對得上是哪個角色、哪個道具
    document.addEventListener(
      'click',
      (event) => {
        if (!apiRecorder.recording || panel.contains(event.target)) return;
        const target = event.target.closest(CLICKABLE_SELECTOR) || event.target;
        const context = buttonContext(target);
        recordApi([`▶ 點擊「${buttonText(target)}」${context ? `（所在列：${context}）` : ''}`]);
      },
      true
    );
  }

  // 角色成長值紀錄：原本是獨立的「我的攻略組 角色成長值紀錄 7.2」，併進來共用同一個 fetch 攔截。
  // 這支是 @grant none，沒有 GM_setValue，改存 localStorage；舊資料從 Tampermonkey 的儲存空間貼到「紀錄」頁匯入
  function createGrowthTracker() {
    const STORAGE_PREFIX = 'autoClickerV2Growth:';
    const STAT_MAP = {
      '力量': 'str', '韌性': 'tou', '敏捷': 'agi', '技巧': 'tec',
      '智力': 'int', '幸運': 'lck', '狩獵': 'hunt', '鍛造': 'forge',
      '裁縫': 'tailor', '工藝': 'craft', '挖礦': 'mining',
      '伐木': 'logging', '效率': 'efficiency',
    };
    // HP、體力：[最大值欄位, plus 欄位]（hp / sp 是目前剩餘量，不拿來算）
    const EXTRA_MAP = {
      'HP': ['fullHp', 'hp'],
      '體力': ['fullSp', 'sp'],
    };
    const STAT_NAMES = [...Object.keys(EXTRA_MAP), ...Object.keys(STAT_MAP)];
    // 生活技能與效率是每張卡固定的成長，不隨地圖變、同類型不同卡也不一樣；只在角色頁算這張卡自己的，不進地點與類型統計。
    // HP 雖然每張卡有自己的基本成長，不同地圖仍會多或少，所以要留在地點統計
    const CARD_FIXED_STATS = new Set(['狩獵', '鍛造', '裁縫', '工藝', '挖礦', '伐木', '效率']);
    const SHARED_STAT_NAMES = STAT_NAMES.filter((zhName) => !CARD_FIXED_STATS.has(zhName));

    const FONT_SIZE = null; // null = 遊戲原本大小；要縮小可改成 '12px' 等
    const COLUMN_GAP = '36px'; // 屬性、武器專精左右兩半的間距（遊戲原本 16px）
    const VALUE_GAP = '8px'; // 數值、裝備加成、成長值彼此的間距
    const SHOW_RANGE_INLINE = true; // 屬性列是否顯示範圍（放不下就改 false，範圍仍可在滑鼠提示看到）
    const STACK_PANELS = true; // 屬性、武器專精上下排列（false = 維持遊戲原本的左右並排）
    const WEAPON_COLUMNS = 2; // 武器專精每排幾個（1 = 遊戲原本的一個一排）
    const MOBILE_ONE_COLUMN = true; // 手機上屬性、武器專精都改成一個一排
    const MOBILE_BREAKPOINT = 640; // 螢幕寬度小於這個值（px）視為手機
    const HISTORY_LIMIT = 200; // 每個角色最多保留幾筆升級紀錄
    const RECENT_N = 5; // 「近 N 級平均」的 N
    // /api/heroes/{id} 與更換陣容的 select／deselect 都回傳完整屬性；其他子路徑不是
    const HERO_DETAIL_PATTERN = /\/api\/heroes\/(\d+)(?:\/(?:select|deselect))?(?:[?#]|$)/;
    // 同一隻角色的基準一直對不上時（讀取失敗、紀錄關掉），隔一陣子才重讀，不要每場戰鬥都打
    const REFETCH_COOLDOWN_MILLISECONDS = 60000;
    const lastFetchAt = new Map();
    // 戰鬥回應看到升級時記下地點，等角色資料讀回來寫紀錄時一起存
    const pendingPlaces = new Map();
    // 地點分析只看單級紀錄；樣本少於這個數的差值只當參考，顏色淡一點
    const PLACE_MIN_SAMPLES = 3;

    let currentHeroId = null;
    let currentHistory = [];
    let currentStats = null;
    let currentExtras = {}; // HP、體力目前的顯示值 { HP: { total, plus } }
    let currentTotals = {}; // 目前資料對應的畫面數值（含裝備），用來確認畫面上是不是同一隻角色

    function getValue(key, fallback) {
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    function setValue(key, value) {
      try {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
      } catch {
        // 存不進去（空間滿了）就只影響紀錄，不影響掛機
      }
    }

    // 每隻角色最後一次看到的畫面數值，切角色時用來比對畫面上是哪一隻
    // （遊戲切角色時不一定會重新呼叫 API，可能直接用快取）
    let snapshotCache = null;
    function getSnapshots() {
      if (!snapshotCache) {
        snapshotCache = new Map();
        for (const id of getValue('hero_index', [])) {
          const snap = getValue(`hero_${id}_snapshot`, null);
          if (snap) snapshotCache.set(id, snap);
        }
      }
      return snapshotCache;
    }

    function saveSnapshot(heroId, snap) {
      const snaps = getSnapshots();
      if (!snaps.has(heroId)) {
        const index = getValue('hero_index', []);
        if (!index.includes(heroId)) {
          index.push(heroId);
          setValue('hero_index', index);
        }
      }
      snaps.set(heroId, snap);
      setValue(`hero_${heroId}_snapshot`, snap);
    }

    function heroIdFromUrl(url) {
      const match = String(url || '').match(HERO_DETAIL_PATTERN);
      return match ? match[1] : null;
    }

    function processHeroData(heroId, data) {
      const currentLevel = data && data.lv;
      if (typeof currentLevel !== 'number') return;
      rememberMeta(heroId, data);

      const currentTrueStats = { level: currentLevel };
      const totals = {};
      for (const [zhName, apiKey] of Object.entries(STAT_MAP)) {
        const totalVal = data[apiKey] || 0;
        const plusVal = data.plus && data.plus[apiKey] ? data.plus[apiKey] : 0;
        currentTrueStats[zhName] = totalVal - plusVal;
        totals[zhName] = totalVal;
      }

      const extras = {};
      for (const [zhName, [fullKey, plusKey]] of Object.entries(EXTRA_MAP)) {
        if (typeof data[fullKey] !== 'number') continue;
        const plusVal = data.plus && data.plus[plusKey] ? data.plus[plusKey] : 0;
        currentTrueStats[zhName] = data[fullKey] - plusVal;
        extras[zhName] = { total: data[fullKey], plus: plusVal };
      }

      const statsKey = `hero_${heroId}_lastStats`;
      const historyKey = `hero_${heroId}_history`;

      const savedStats = getValue(statsKey, null) || getValue(`hero_${heroId}_apiStats`, null);
      let history = getValue(historyKey, null);
      if (!history) {
        history = migrateLegacy(heroId);
        setValue(historyKey, history);
      }

      if (savedStats && currentLevel > savedStats.level) {
        const d = {};
        for (const zhName of STAT_NAMES) {
          if (currentTrueStats[zhName] !== undefined && savedStats[zhName] !== undefined) {
            d[zhName] = currentTrueStats[zhName] - savedStats[zhName];
          }
        }
        const place = pendingPlaces.get(heroId) || (isOutsideHuntTeam(heroId) ? TRAINING_PLACE : '');
        pendingPlaces.delete(heroId);
        history.push({ from: savedStats.level, to: currentLevel, t: Date.now(), d, ...(place ? { place } : {}) });
        if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
        setValue(historyKey, history);
      }

      // 不管是升級、降級、或同等級但基礎值被其他方式改變，都更新基準，
      // 下次升級才只算到「升級帶來的」差值
      setValue(statsKey, currentTrueStats);

      saveSnapshot(heroId, { totals, extras });
      loadHero(heroId, history, extras, totals);

      setTimeout(render, 300);
    }

    function loadHero(heroId, history, extras, totals) {
      currentHeroId = heroId;
      currentHistory = history;
      currentStats = computeStats(history);
      currentExtras = extras || {};
      currentTotals = totals || {};
    }

    // 讀出畫面上各屬性顯示的數值（不含成長值）
    function readDomTotals(columns) {
      const result = {};
      for (const zhName of Object.keys(STAT_MAP)) {
        const labelNode = document.evaluate(`.//div[normalize-space(text())='${zhName}']`, columns, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        const valueNode = labelNode && labelNode.nextElementSibling;
        if (!valueNode || !valueNode.firstChild) continue;
        const n = parseInt(valueNode.firstChild.textContent.replace(/[^\d-]/g, ''), 10);
        if (!isNaN(n)) result[zhName] = n;
      }
      return result;
    }

    function totalsMatch(domTotals, totals) {
      const keys = Object.keys(domTotals);
      return keys.length > 0 && keys.every((k) => totals[k] === domTotals[k]);
    }

    // 確保目前資料就是畫面上那隻角色；不是的話從已存的角色裡找，找不到回傳 false
    function syncHeroWithDom(columns) {
      const domTotals = readDomTotals(columns);
      if (totalsMatch(domTotals, currentTotals)) return true;
      for (const [id, snap] of getSnapshots()) {
        if (totalsMatch(domTotals, snap.totals)) {
          loadHero(id, getValue(`hero_${id}_history`, []), snap.extras, snap.totals);
          return true;
        }
      }
      return false;
    }

    function clearDisplays(attrPanel) {
      attrPanel.querySelectorAll('.growth-value-display, #gv-hpsp-row, #growth-history-box').forEach((el) => el.remove());
    }

    // 舊版只存了一組成長值，轉成一筆 legacy 紀錄（只算進平均，不算範圍）
    function migrateLegacy(heroId) {
      const old = getValue(`hero_${heroId}_growths`, null);
      if (!old) return [];
      const d = {};
      for (const zhName of STAT_NAMES) {
        if (typeof old[zhName] === 'number' && !isNaN(old[zhName])) d[zhName] = Math.round(old[zhName]);
      }
      return [{ legacy: true, t: 0, d }];
    }

    function computeStats(history) {
      const result = {};
      for (const zhName of STAT_NAMES) {
        let gain = 0;
        let levels = 0;
        let total = 0;
        const singles = [];
        let lastRec = null;

        for (const rec of history) {
          const v = rec.d[zhName];
          if (v === undefined) continue;
          const lvs = rec.legacy ? 1 : rec.to - rec.from;
          gain += v;
          levels += lvs;
          if (!rec.legacy) {
            total += v;
            lastRec = rec;
            if (lvs === 1) singles.push(v); // 跨級的紀錄不算進範圍
          }
        }
        if (!levels) continue;

        const recent = singles.slice(-RECENT_N);
        result[zhName] = {
          avg: gain / levels,
          min: singles.length ? Math.min(...singles) : null,
          max: singles.length ? Math.max(...singles) : null,
          recentAvg: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null,
          samples: singles.length,
          levels,
          total,
          last: lastRec ? { v: lastRec.d[zhName], from: lastRec.from, to: lastRec.to } : null,
        };
      }
      return result;
    }

    const fmt = (n) => (n >= 0 ? '+' : '') + Math.round(n);
    const fmtDiff = (n) => (n >= 0 ? '+' : '') + n.toFixed(1);

    // 地點是「地圖 關卡」，關卡要照數字排（2 在 10 前面）；修練放最後
    function comparePlaces(first, second) {
      if ((first === TRAINING_PLACE) !== (second === TRAINING_PLACE)) return first === TRAINING_PLACE ? 1 : -1;
      const [, firstZone, firstStage] = /^(.*?)\s*(\d+)?$/.exec(first);
      const [, secondZone, secondStage] = /^(.*?)\s*(\d+)?$/.exec(second);
      return firstZone.localeCompare(secondZone, 'zh-Hant') || (Number(firstStage) || 0) - (Number(secondStage) || 0);
    }

    // 角色不是靠狩獵升級就是靠修練；不在狩獵隊伍裡卻升級了，就當成修練。
    // 隊伍存在 localStorage，同一個瀏覽器的鍛造分頁也看得到狩獵分頁的隊伍；還沒看過隊伍就不猜
    const TRAINING_PLACE = '修練';
    function isOutsideHuntTeam(heroId) {
      const team = getValue('hunt_team', null);
      return Array.isArray(team) && !team.includes(heroId);
    }

    // 跟角色無關的地點效果：每隻角色先跟自己的平均比（扣掉角色本身成長高低），再把所有角色在同一地點的差值合起來
    function placeSummaries() {
      const byPlace = new Map();
      for (const heroId of allHeroIds()) {
        const history = heroHistory(heroId);
        if (!history.length) continue;
        for (const { place, samples, diffs } of computePlaceStats(history, computeStats(history))) {
          if (!byPlace.has(place)) byPlace.set(place, { place, samples: 0, heroes: 0, sums: {}, weights: {} });
          const entry = byPlace.get(place);
          entry.samples += samples;
          entry.heroes++;
          for (const [zhName, diff] of Object.entries(diffs)) {
            entry.sums[zhName] = (entry.sums[zhName] || 0) + diff * samples;
            entry.weights[zhName] = (entry.weights[zhName] || 0) + samples;
          }
        }
      }
      return [...byPlace.values()]
        .map(({ place, samples, heroes, sums, weights }) => ({
          place,
          samples,
          heroes,
          diffs: Object.fromEntries(Object.keys(sums).map((zhName) => [zhName, sums[zhName] / weights[zhName]])),
        }))
        .sort((first, second) => comparePlaces(first.place, second.place));
    }

    // 同一隻角色在不同關卡升級，各屬性平均比整體平均多或少多少；跨級與沒記到地點的紀錄不算
    function computePlaceStats(history, overall) {
      const byPlace = new Map();
      for (const rec of history) {
        if (rec.legacy || !rec.place || rec.to - rec.from !== 1) continue;
        if (!byPlace.has(rec.place)) byPlace.set(rec.place, []);
        byPlace.get(rec.place).push(rec);
      }
      return [...byPlace.entries()]
        .map(([place, records]) => {
          const diffs = {};
          for (const zhName of SHARED_STAT_NAMES) {
            const values = records.map((rec) => rec.d[zhName]).filter((v) => v !== undefined);
            if (!values.length || !overall[zhName]) continue;
            diffs[zhName] = values.reduce((a, b) => a + b, 0) / values.length - overall[zhName].avg;
          }
          return { place, samples: records.length, diffs };
        })
        .sort((first, second) => comparePlaces(first.place, second.place));
    }

    function buildTooltip(zhName, s) {
      const lines = [`${zhName}｜累計 ${s.levels} 級（單級樣本 ${s.samples} 次）`];
      lines.push(`平均 ${fmt(s.avg)}` + (s.recentAvg !== null ? `　近${RECENT_N}級 ${fmt(s.recentAvg)}` : ''));
      if (s.min !== null) lines.push(`範圍 ${s.min} ~ ${s.max}`);
      if (s.last) lines.push(`最近一次 ${fmt(s.last.v)}（Lv.${s.last.from}→${s.last.to}）`);
      lines.push(`紀錄期間總計 ${fmt(s.total)}`);
      return lines.join('\n');
    }

    // 手機版：螢幕寬度小於 MOBILE_BREAKPOINT 時，屬性與武器專精改成一個一排
    function ensureMobileStyle() {
      if (!MOBILE_ONE_COLUMN || document.getElementById('gv-mobile-style')) return;
      const style = document.createElement('style');
      style.id = 'gv-mobile-style';
      style.textContent = `
        @media (max-width: ${MOBILE_BREAKPOINT - 1}px) {
          .gv-attr-cols { flex-direction: column; row-gap: 0 !important; }
          .gv-attr-cols > * { flex: none; }
          .gv-weapon-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `;
      document.head.appendChild(style);
    }

    function render() {
      const attrTitle = document.evaluate(`//h2[contains(text(), '屬性')]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!attrTitle) return;
      const attrPanel = attrTitle.parentNode;

      // 屬性與武器專精改成上下排列（各自佔滿整列）
      const weaponTitle = document.evaluate(`//h2[contains(text(), '武器專精')]`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      const weaponPanel = weaponTitle && weaponTitle.parentNode;
      if (STACK_PANELS) {
        for (const p of [attrPanel, weaponPanel]) {
          if (p && p.style.gridColumn !== '1 / -1') p.style.gridColumn = '1 / -1';
        }
      }

      // 武器專精改成多欄排列：只用 CSS grid，不搬動遊戲的 DOM
      if (weaponPanel && WEAPON_COLUMNS > 1) {
        const cols = `repeat(${WEAPON_COLUMNS}, minmax(0, 1fr))`;
        if (weaponPanel.style.gridTemplateColumns !== cols) {
          weaponPanel.style.display = 'grid';
          weaponPanel.style.gridTemplateColumns = cols;
          weaponPanel.style.columnGap = COLUMN_GAP;
          weaponPanel.style.alignContent = 'start';
        }
        if (weaponTitle.style.gridColumn !== '1 / -1') weaponTitle.style.gridColumn = '1 / -1';
        if (!weaponPanel.classList.contains('gv-weapon-grid')) weaponPanel.classList.add('gv-weapon-grid');
      }

      // 統一字體：直接設在兩欄的外層容器，名稱／數值／裝備加成(+185)／成長值全部繼承同一大小
      let columns = attrTitle.nextElementSibling;
      if (columns && columns.id === 'gv-hpsp-row') columns = columns.nextElementSibling; // 跳過自己插入的 HP／體力列
      if (columns) {
        if (FONT_SIZE && columns.style.fontSize !== FONT_SIZE) {
          columns.style.fontSize = FONT_SIZE;
          columns.style.lineHeight = '1.4';
        }
        if (columns.style.columnGap !== COLUMN_GAP) columns.style.columnGap = COLUMN_GAP;
        if (!columns.classList.contains('gv-attr-cols')) columns.classList.add('gv-attr-cols');
      }
      ensureMobileStyle();

      // 切角色時畫面和資料可能對不上：對不上就先清掉，避免顯示成前一隻的成長值
      if (!columns || !syncHeroWithDom(columns)) {
        clearDisplays(attrPanel);
        return;
      }

      renderHpSpRow(columns);

      for (const zhName of Object.keys(STAT_MAP)) {
        const labelNode = document.evaluate(`.//div[normalize-space(text())='${zhName}']`, columns || attrPanel, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!labelNode || !labelNode.nextElementSibling) continue;
        const valueNode = labelNode.nextElementSibling;
        const row = labelNode.parentNode;

        if (labelNode.style.whiteSpace !== 'nowrap') labelNode.style.whiteSpace = 'nowrap';
        if (valueNode.style.whiteSpace !== 'nowrap') valueNode.style.whiteSpace = 'nowrap';
        if (row.style.columnGap !== '4px') row.style.columnGap = '4px';

        // 遊戲原本的裝備加成 (+185) 也拉開一點
        const plusSpan = valueNode.querySelector(':scope > span:not(.growth-value-display)');
        if (plusSpan && plusSpan.style.marginLeft !== VALUE_GAP) plusSpan.style.marginLeft = VALUE_GAP;

        applyGrowthSpan(valueNode, zhName);
      }

      renderHistoryTable(attrPanel);
    }

    // 在數值後面加上 (+7) 或 (+7 ↕5~9)
    function applyGrowthSpan(valueNode, zhName) {
      const s = currentStats && currentStats[zhName];
      let span = valueNode.querySelector('.growth-value-display');

      if (!s) {
        if (span) span.remove();
        return;
      }

      const avgText = fmt(s.avg);
      const rangeText = SHOW_RANGE_INLINE && s.samples >= 2 && s.min !== s.max ? `${s.min}~${s.max}` : '';
      const key = `${avgText}|${rangeText}`;

      if (!span) {
        span = document.createElement('span');
        span.className = 'growth-value-display';
        span.style.cssText = `margin-left:${VALUE_GAP};color:#eab308;font-weight:bold;font-size:inherit;cursor:help;`;
        valueNode.appendChild(span);
      }
      if (span.dataset.key !== key) {
        span.dataset.key = key;
        span.textContent = `(${avgText}`;
        if (rangeText) {
          const r = document.createElement('span');
          r.textContent = `↕${rangeText}`;
          r.style.cssText = 'margin-left:6px;font-weight:normal;color:#a16207;';
          span.appendChild(r);
        }
        span.appendChild(document.createTextNode(')'));
      }
      const tip = buildTooltip(zhName, s);
      if (span.title !== tip) span.title = tip;
    }

    // HP、體力：在屬性兩欄上方插入獨立的一排（左 HP、右體力），
    // 沿用 gv-attr-cols，手機版會跟著變成一個一排，並排在所有屬性最前面
    function renderHpSpRow(columns) {
      if (!columns || !columns.parentNode) return;
      let hpRow = columns.parentNode.querySelector('#gv-hpsp-row');

      if (!Object.keys(currentExtras).length) {
        if (hpRow) hpRow.remove();
        return;
      }

      if (!hpRow) {
        hpRow = document.createElement('div');
        hpRow.id = 'gv-hpsp-row';
        hpRow.className = 'xs:gap-4 flex gap-2 gv-attr-cols';
        for (const zhName of Object.keys(EXTRA_MAP)) {
          const col = document.createElement('div');
          col.className = 'flex-1';
          col.innerHTML =
            `<div class="flex items-center justify-between py-0.5" style="column-gap:4px;">` +
            `<div class="text-stone-400" style="white-space:nowrap;"></div>` +
            `<div class="text-stone-300" style="white-space:nowrap;"><span class="gv-val"></span></div></div>`;
          col.dataset.stat = zhName;
          col.querySelector('.text-stone-400').textContent = zhName;
          hpRow.appendChild(col);
        }
      }
      if (hpRow.nextElementSibling !== columns) columns.parentNode.insertBefore(hpRow, columns);
      if (FONT_SIZE && hpRow.style.fontSize !== FONT_SIZE) {
        hpRow.style.fontSize = FONT_SIZE;
        hpRow.style.lineHeight = '1.4';
      }
      if (hpRow.style.columnGap !== COLUMN_GAP) hpRow.style.columnGap = COLUMN_GAP;

      for (const col of hpRow.children) {
        const zhName = col.dataset.stat;
        const info = currentExtras[zhName];
        col.style.visibility = info ? '' : 'hidden';
        if (!info) continue;

        const valueNode = col.querySelector('.text-stone-300');
        const valSpan = valueNode.querySelector('.gv-val');
        const valText = String(info.total);
        if (valSpan.textContent !== valText) valSpan.textContent = valText;

        // 有裝備加成時，照遊戲的樣式顯示 (+N)
        let plusSpan = valueNode.querySelector('.gv-plus');
        if (info.plus) {
          if (!plusSpan) {
            plusSpan = document.createElement('span');
            plusSpan.className = 'gv-plus text-stone-500';
            plusSpan.style.marginLeft = VALUE_GAP;
            valSpan.after(plusSpan);
          }
          const plusText = `(${fmt(info.plus)})`;
          if (plusSpan.textContent !== plusText) plusSpan.textContent = plusText;
        } else if (plusSpan) {
          plusSpan.remove();
        }

        applyGrowthSpan(valueNode, zhName);
      }
    }

    // 每個地點一列：在那裡升級時各屬性比這隻角色的平均多（綠）或少（紅）多少
    function placeAnalysis(records, cols, cell) {
      const box = document.createElement('div');
      box.style.cssText = 'margin-top:6px;';
      const rows = computePlaceStats(records, currentStats || {});
      const title = document.createElement('div');
      title.style.cssText = 'color:#eab308;font-weight:bold;';
      title.textContent = '依升級地點：比平均多／少';
      box.appendChild(title);
      if (!rows.length) {
        const hint = document.createElement('div');
        hint.style.cssText = 'color:#78716c;padding:2px 0;';
        hint.textContent = '還沒有記到地點的升級。之後掛機中升級會記下在哪一關升的。';
        box.appendChild(hint);
        return box;
      }
      const wrap = document.createElement('div');
      wrap.style.cssText = 'overflow:auto;max-height:200px;';
      const table = document.createElement('table');
      table.style.cssText = 'border-collapse:collapse;white-space:nowrap;text-align:center;';
      const head = document.createElement('tr');
      ['地點', '次數', ...cols].forEach((n) => head.appendChild(cell('th', n)));
      table.appendChild(head);
      for (const row of rows) {
        const tr = document.createElement('tr');
        tr.appendChild(cell('td', row.place));
        tr.appendChild(cell('td', String(row.samples)));
        for (const n of cols) {
          const diff = row.diffs[n];
          if (diff === undefined) {
            tr.appendChild(cell('td', '-'));
            continue;
          }
          // 差不到 0.5 當作一樣；樣本太少的顏色調淡，避免一兩次運氣好就當成規律
          const strong = row.samples >= PLACE_MIN_SAMPLES;
          const color = Math.abs(diff) < 0.5 ? '' : diff > 0 ? (strong ? '#22c55e' : '#86efac') : strong ? '#ef4444' : '#fca5a5';
          tr.appendChild(cell('td', fmtDiff(diff), color));
        }
        table.appendChild(tr);
      }
      wrap.appendChild(table);
      box.appendChild(wrap);
      const note = document.createElement('div');
      note.style.cssText = 'color:#78716c;font-size:smaller;';
      note.textContent = `只算單級升級；次數少於 ${PLACE_MIN_SAMPLES} 次的顏色較淡，參考就好`;
      box.appendChild(note);
      return box;
    }

    function renderHistoryTable(attrPanel) {
      let box = attrPanel.querySelector('#growth-history-box');
      const records = currentHistory.filter((r) => !r.legacy);

      const hasLegacy = currentHistory.some((r) => r.legacy);
      const key = `${currentHeroId}:${records.length}:${records.length ? records[records.length - 1].t : 0}:${hasLegacy}`;
      if (box && box.dataset.key === key) return;

      const wasOpen = box ? box.querySelector('details').open : false;
      if (box) box.remove();

      const cols = STAT_NAMES.filter((n) => records.some((r) => r.d[n] !== undefined && r.d[n] !== 0));

      box = document.createElement('div');
      box.id = 'growth-history-box';
      box.dataset.key = key;
      box.style.cssText = `margin-top:8px;${FONT_SIZE ? `font-size:${FONT_SIZE};` : ''}`;
      // 有可分配點數時整個屬性框會變成按鈕，點一下就開加點視窗；
      // 在紀錄區塊攔下事件，不讓它傳到屬性框（details 的展開、按鈕等原生行為不受影響）
      for (const type of ['click', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'keydown', 'keyup']) {
        box.addEventListener(type, (e) => e.stopPropagation());
      }

      const details = document.createElement('details');
      details.open = wasOpen;

      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;color:#eab308;font-weight:bold;user-select:none;-webkit-user-select:none;';
      summary.textContent = `成長紀錄（${records.length} 筆）`;
      details.appendChild(summary);

      const wrap = document.createElement('div');
      wrap.style.cssText = 'overflow:auto;max-height:260px;margin-top:4px;';

      const table = document.createElement('table');
      table.style.cssText = 'border-collapse:collapse;white-space:nowrap;text-align:center;';
      const cell = (tag, txt, color) => {
        const el = document.createElement(tag);
        el.textContent = txt;
        el.style.cssText = `padding:2px 6px;border-bottom:1px solid rgba(128,128,128,.3);${color ? `color:${color};` : ''}`;
        return el;
      };

      const head = document.createElement('tr');
      head.appendChild(cell('th', '等級'));
      head.appendChild(cell('th', '地點'));
      cols.forEach((n) => head.appendChild(cell('th', n)));
      table.appendChild(head);

      const avgRow = document.createElement('tr');
      avgRow.appendChild(cell('td', '平均', '#eab308'));
      avgRow.appendChild(cell('td', ''));
      cols.forEach((n) => avgRow.appendChild(cell('td', currentStats[n] ? fmt(currentStats[n].avg) : '-', '#eab308')));
      table.appendChild(avgRow);

      // 最新的在上面；高於平均綠色、低於平均紅色
      for (const rec of [...records].reverse()) {
        const lvs = rec.to - rec.from;
        const tr = document.createElement('tr');
        tr.appendChild(cell('td', `${rec.from}→${rec.to}`));
        tr.appendChild(cell('td', rec.place || '-'));
        for (const n of cols) {
          const v = rec.d[n];
          if (v === undefined) {
            tr.appendChild(cell('td', '-'));
            continue;
          }
          const avg = currentStats[n] ? Math.round(currentStats[n].avg) : null;
          const perLv = v / lvs;
          let color = '';
          if (avg !== null && lvs === 1) color = perLv > avg ? '#22c55e' : perLv < avg ? '#ef4444' : '';
          tr.appendChild(cell('td', fmt(v), color));
        }
        table.appendChild(tr);
      }

      if (records.length) {
        wrap.appendChild(table);
      } else {
        const hint = document.createElement('div');
        hint.style.cssText = 'color:#78716c;padding:2px 0;';
        hint.textContent = hasLegacy
          ? '目前只有舊版留下的一組成長值（已算進平均）。之後每次升級都會新增一筆紀錄。'
          : '尚無紀錄，角色升級後會開始累積。';
        wrap.appendChild(hint);
      }
      details.appendChild(wrap);
      details.appendChild(placeAnalysis(records, cols, cell));

      const clearBtn = document.createElement('button');
      clearBtn.textContent = '清除此角色紀錄';
      clearBtn.style.cssText = 'margin-top:4px;padding:1px 8px;font-size:inherit;border:1px solid #ef4444;color:#ef4444;border-radius:4px;background:transparent;cursor:pointer;';
      clearBtn.onclick = () => {
        if (!confirm('確定要清除這個角色的所有成長紀錄？')) return;
        setValue(`hero_${currentHeroId}_history`, []);
        setValue(`hero_${currentHeroId}_growths`, null);
        currentHistory = [];
        currentStats = computeStats([]);
        render();
      };
      details.appendChild(clearBtn);

      box.appendChild(details);
      attrPanel.appendChild(box);
    }

    // Tampermonkey 儲存空間的 JSON（{"hero_index":[...],"hero_123_history":[...],...}）整份貼進來，只收 hero_ 開頭的欄位
    function importStorage(text) {
      const data = JSON.parse(text);
      const keys = Object.keys(data || {}).filter((key) => key.startsWith('hero_'));
      keys.forEach((key) => setValue(key, data[key]));
      snapshotCache = null;
      render();
      return getValue('hero_index', []).length;
    }

    // 跨角色統計要按類型（王剛、關羽…）分組，名字也要存，不然只看得到 heroId；
    // 角色頁、/api/hunt、/api/huntInfo、/api/heroes 都帶 typeId，看到就記
    function rememberMeta(heroId, hero) {
      if (!hero || !hero.typeId) return;
      const key = `hero_${heroId}_meta`;
      const old = getValue(key, null) || {};
      const meta = { ...old, name: hero.name, typeId: hero.typeId, type: hero.type || old.type };
      if (hero.tier) meta.tier = hero.tier;
      if (hero.potential) meta.potential = hero.potential;
      if (JSON.stringify(meta) !== JSON.stringify(old)) setValue(key, meta);
    }

    function rememberHeroList(heroes) {
      heroes.forEach((hero) => rememberMeta(String(hero.id), hero));
    }

    function allHeroIds() {
      return [...new Set(getValue('hero_index', []).map(String))];
    }

    function heroHistory(heroId) {
      return getValue(`hero_${heroId}_history`, null) || [];
    }

    // 同類型的所有角色（自己的加上匯入別人的）合在一起算平均；跨級紀錄照原本規則只算進平均、不算範圍
    function cardSummaries() {
      return allHeroIds()
        .map((heroId) => {
          const history = heroHistory(heroId);
          if (!history.length) return null;
          const meta = getValue(`hero_${heroId}_meta`, null) || {};
          const stats = computeStats(history);
          const levelUps = history.filter((rec) => !rec.legacy).reduce((sum, rec) => sum + (rec.to - rec.from), 0);
          return {
            heroId,
            name: meta.name || heroId,
            type: meta.type || '未知類型',
            tier: meta.tier || '',
            potential: meta.potential || '',
            stats,
            levelUps,
            places: computePlaceStats(history, stats),
          };
        })
        .filter(Boolean)
        .sort((first, second) => first.type.localeCompare(second.type, 'zh-Hant') || second.levelUps - first.levelUps);
    }

    const SHARE_FORMAT = 'swordgale-growth';

    // 分享檔只放升級紀錄與角色類型，不放帳號、token、目前數值。
    // ownOnly：只要這個帳號自己的角色（有 snapshot＝自己看過的；匯入來的別人角色沒有），同步時才不會把別人的資料再傳回去
    function exportShare({ ownOnly = false } = {}) {
      const heroes = {};
      for (const heroId of allHeroIds()) {
        if (ownOnly && !getValue(`hero_${heroId}_snapshot`, null)) continue;
        const history = heroHistory(heroId);
        if (history.length) heroes[heroId] = { meta: getValue(`hero_${heroId}_meta`, null), history };
      }
      return { format: SHARE_FORMAT, version: 1, exportedAt: new Date().toISOString(), heroes };
    }

    function recordKey(rec) {
      return rec.legacy ? 'legacy' : `${rec.from}-${rec.to}`;
    }

    // 別人的檔案內容不可信，只收格式對的欄位
    function cleanRecord(rec) {
      if (!rec || typeof rec !== 'object' || !rec.d || typeof rec.d !== 'object') return null;
      const d = {};
      for (const zhName of STAT_NAMES) {
        if (Number.isFinite(rec.d[zhName])) d[zhName] = rec.d[zhName];
      }
      if (rec.legacy) return { legacy: true, t: 0, d };
      if (!Number.isInteger(rec.from) || !Number.isInteger(rec.to) || rec.to <= rec.from) return null;
      const cleaned = { from: rec.from, to: rec.to, t: Number(rec.t) || 0, d };
      if (typeof rec.place === 'string' && rec.place) cleaned.place = rec.place.slice(0, 40);
      return cleaned;
    }

    function cleanMeta(meta) {
      if (!meta || typeof meta !== 'object' || typeof meta.typeId !== 'string') return null;
      const text = (value) => (typeof value === 'string' ? value.slice(0, 40) : undefined);
      return { name: text(meta.name), typeId: text(meta.typeId), type: text(meta.type), tier: text(meta.tier), potential: text(meta.potential) };
    }

    // heroId 是遊戲裡全服唯一的，同一隻角色的同一次升級（from→to）只算一次；重複匯入同一個檔案不會灌水
    function importShare(data) {
      if (!data || data.format !== SHARE_FORMAT || !data.heroes || typeof data.heroes !== 'object') {
        throw new Error('不是成長值分享檔');
      }
      const index = allHeroIds();
      let heroCount = 0;
      let added = 0;
      for (const [heroId, entry] of Object.entries(data.heroes)) {
        if (!/^\d+$/.test(heroId) || !entry || !Array.isArray(entry.history)) continue;
        const history = heroHistory(heroId);
        const known = new Set(history.map(recordKey));
        const fresh = entry.history.map(cleanRecord).filter((rec) => rec && !known.has(recordKey(rec)));
        if (fresh.length) {
          const merged = [...history, ...fresh]
            .sort((first, second) => (first.legacy ? -1 : second.legacy ? 1 : first.from - second.from))
            .slice(-HISTORY_LIMIT);
          setValue(`hero_${heroId}_history`, merged);
          heroCount++;
          added += fresh.length;
        }
        const meta = cleanMeta(entry.meta);
        if (meta && !getValue(`hero_${heroId}_meta`, null)) setValue(`hero_${heroId}_meta`, meta);
        if (!index.includes(heroId)) index.push(heroId);
      }
      setValue('hero_index', index);
      snapshotCache = null;
      return { heroCount, added };
    }

    // DOM 變動時重新套用（debounce，避免每個小變動都重跑）
    let pending = null;
    function observe(isEnabled) {
      new MutationObserver(() => {
        if (pending || !isEnabled()) return;
        pending = setTimeout(() => {
          pending = null;
          // 不再檢查網址：遊戲重繪屬性數值時會把成長值一起洗掉，必須隨時補回
          render();
        }, 100);
      }).observe(document, { subtree: true, childList: true });
    }

    // 掛機升級時不會打開角色頁，只等 /api/heroes/{id} 的話要到下次打開才算，兩級會併成一筆跨級紀錄、不算進範圍。
    // 隊伍資料（/api/hunt、/api/huntInfo）每場都帶等級，看到和基準不同就主動讀一次角色資料，回應會經過 fetch 攔截記下來
    // knownOnly：角色列表有全部角色，沒基準的不讀，不然第一次會一口氣讀一整排；沒基準本來也算不出這次升級
    function noticeTeamLevels(heroes, fetchHero, place, { knownOnly = false } = {}) {
      if (!knownOnly) setValue('hunt_team', heroes.map((hero) => String(hero.id)));
      heroes.forEach((hero) => {
        if (typeof hero.lv !== 'number') return;
        const heroId = String(hero.id);
        rememberMeta(heroId, hero);
        const baseline = getValue(`hero_${heroId}_lastStats`, null);
        if (knownOnly && !baseline) return;
        if (baseline && baseline.level === hero.lv) return;
        if (baseline && hero.lv > baseline.level && place) pendingPlaces.set(heroId, place);
        const lastFetch = lastFetchAt.get(heroId);
        if (lastFetch && lastFetch.level === hero.lv && Date.now() - lastFetch.at < REFETCH_COOLDOWN_MILLISECONDS) return;
        lastFetchAt.set(heroId, { level: hero.lv, at: Date.now() });
        fetchHero(heroId).catch((error) => console.error('讀取角色資料失敗', error));
      });
    }

    return {
      heroIdFromUrl,
      processHeroData,
      importStorage,
      observe,
      noticeTeamLevels,
      rememberHeroList,
      cardSummaries,
      comparePlaces,
      placeSummaries,
      exportShare,
      importShare,
      sharedStatNames: SHARED_STAT_NAMES,
    };
  }

  const growthTracker = createGrowthTracker();

  installApiRecorder();
  growthTracker.observe(() => readSettingsFromPanel().growthEnabled);
  installForgeDetailEnhancer();
  renderItemLog();

  // 匯出時包一層版本資訊，之後格式改了也認得出是哪一版的設定
  function exportText() {
    return JSON.stringify(
      { app: 'auto-clicker-v2', exportedAt: new Date().toISOString(), settings: readSettingsFromPanel() },
      null,
      2
    );
  }

  const formatGrowth = (value) => (value >= 0 ? '+' : '') + value.toFixed(1);

  // 不同瀏覽器設定檔的 localStorage 不通，改由中繼站轉：每個帳號上傳自己的角色，再把所有帳號的下載回來合併。
  // 合併沿用分享檔的匯入，同一筆升級不會重複算
  const GROWTH_SYNC_MILLISECONDS = 5 * 60000;
  const growthSync = {
    // 開頁面 20 秒後第一次同步，不要跟遊戲載入搶
    at: Date.now() - GROWTH_SYNC_MILLISECONDS + 20000,
    running: false,
    uploadedHeroes: '',
    status: '',
  };

  function setGrowthSyncStatus(text) {
    growthSync.status = text;
    panel.querySelector('[data-role="growth-sync-status"]').textContent = text;
  }

  async function syncGrowth(settings) {
    if (!settings.growthEnabled || !settings.growthSyncEnabled || growthSync.running) return;
    if (Date.now() - growthSync.at < GROWTH_SYNC_MILLISECONDS) return;
    growthSync.running = true;
    growthSync.at = Date.now();
    try {
      if (!dashboard.profile) {
        const profile = await requestGameApi(PROFILE_API, { background: true });
        rememberProfile(profile);
      }
      const baseUrl = dashboardBaseUrl(settings);
      const share = growthTracker.exportShare({ ownOnly: true });
      // exportedAt 每次都不同，只比內容；沒變就不用再傳
      const heroesText = JSON.stringify(share.heroes);
      if (heroesText !== growthSync.uploadedHeroes) {
        const upload = await window.fetch(`${baseUrl}/growth?id=${encodeURIComponent(dashboard.profile.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(share),
        });
        if (upload.status === 404) throw new Error('中繼站是舊版，請關掉重開');
        if (!upload.ok) throw new Error(`上傳 HTTP ${upload.status}`);
        growthSync.uploadedHeroes = heroesText;
      }
      const download = await window.fetch(`${baseUrl}/growth`, { cache: 'no-store' });
      if (!download.ok) throw new Error(`下載 HTTP ${download.status}`);
      const { sources } = await download.json();
      let added = 0;
      sources.forEach((data) => {
        try {
          added += growthTracker.importShare(data).added;
        } catch {
          // 某個帳號的檔案壞了就跳過，不影響其他帳號
        }
      });
      const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
      setGrowthSyncStatus(`上次同步 ${time}，共 ${sources.length} 個帳號${added ? `，新增 ${added} 筆` : ''}`);
      if (added && activeTab === 'growth') renderGrowthSummary();
    } catch (error) {
      setGrowthSyncStatus(`同步失敗（${error.message}）`);
    } finally {
      growthSync.running = false;
    }
  }

  // 物品頁每列一個勾選框，品質、類型、名稱各是同一列裡單獨的一段文字；
  // 哪段是哪種，拿 /api/equipments 裡出現過的值來認
  const qualityPick = { running: false, runId: 0 };
  const PICK_GROUPS = [
    ['quality', '品質', 'qualityPickNames'],
    ['type', '類型', 'qualityPickTypes'],
    ['name', '名稱', 'qualityPickItemNames'],
  ];

  function itemCheckboxes() {
    return Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]:not([aria-hidden="true"])')).filter(
      (checkbox) => !panel.contains(checkbox) && !alertDialog.contains(checkbox)
    );
  }

  // 遊戲的勾選框是 <button role="checkbox">，狀態在 aria-checked；原生 input 才看 checked
  function isBoxChecked(checkbox) {
    return checkbox instanceof HTMLInputElement ? checkbox.checked : checkbox.getAttribute('aria-checked') === 'true';
  }

  // 從勾選框往上找到「只含這一個勾選框」的最大範圍，就是這一列
  function checkboxRow(checkbox, checkboxes) {
    let row = checkbox;
    while (row.parentElement && row.parentElement !== document.body) {
      const parent = row.parentElement;
      if (checkboxes.some((other) => other !== checkbox && parent.contains(other))) break;
      row = parent;
    }
    return row;
  }

  // 要整段文字完全相同：「一般」不能比對到「屎一般」，名稱裡剛好有品質字也不會誤認
  function rowTexts(row) {
    const texts = new Set();
    for (const element of row.querySelectorAll('*')) {
      texts.add(element.textContent.trim());
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) texts.add(node.textContent.trim());
      }
    }
    texts.delete('');
    return [...texts];
  }

  async function scanItemRows() {
    const equipments = (await requestGameApi(EQUIPMENTS_API)).equipments || [];
    const known = {
      quality: new Set(equipments.map((equipment) => equipment.quality).filter(Boolean)),
      type: new Set(equipments.map((equipment) => equipment.type).filter(Boolean)),
      name: new Set(equipments.map((equipment) => equipment.name).filter(Boolean)),
    };
    const checkboxes = itemCheckboxes();
    const rows = checkboxes.map((checkbox) => {
      const element = checkboxRow(checkbox, checkboxes);
      const texts = rowTexts(element);
      const find = (group) => texts.find((text) => known[group].has(text)) || '';
      return { checkbox, element, quality: find('quality'), type: find('type'), name: find('name') };
    });
    // 全選框那列沒有品質、別的分頁的列看不到，都不算
    const items = rows.filter((row) => row.quality && isVisible(row.element));
    // 找不到時把看到的東西寫進狀態，貼給人看才知道是哪一步對不上
    items.diagnosis = items.length
      ? ''
      : `勾選框 ${checkboxes.length} 個、裝備 ${equipments.length} 件、品質 ${[...known.quality].join('、') || '無'}；` +
        `第一列：${rows.length ? (rows[rows.length > 1 ? 1 : 0].element.textContent || '').replace(/s+/g, ' ').trim().slice(0, 80) : '無'}`;
    return items;
  }

  function pickSelections(settings) {
    return Object.fromEntries(
      PICK_GROUPS.map(([group, , field]) => [group, settings[field].split(/[,，、]/).map((value) => value.trim()).filter(Boolean)])
    );
  }

  // 每組裡勾的是「或」，不同組之間是「且」；整組沒勾就不限制
  function matchesPick(row, selections) {
    return PICK_GROUPS.every(([group]) => !selections[group].length || selections[group].includes(row[group]));
  }

  async function showPickChoices() {
    let rows;
    try {
      rows = await scanItemRows();
    } catch (error) {
      setStatus(`讀取裝備清單失敗（${error.message}）`);
      return;
    }
    const selections = pickSelections(readSettingsFromPanel());
    const box = panel.querySelector('[data-role="pick-choices"]');
    if (!rows.length) {
      box.innerHTML = `<div class="hint">畫面上找不到物品，請先切到遊戲「物品」頁。<br>${escapeHtml(rows.diagnosis)}</div>`;
      setStatus(`找不到物品（${rows.diagnosis}）`);
      return;
    }
    box.innerHTML = PICK_GROUPS.map(([group, title]) => {
      const counts = new Map();
      rows.forEach((row) => row[group] && counts.set(row[group], (counts.get(row[group]) || 0) + 1));
      // 之前勾過但這頁沒有的也列出來，免得重新掃描就把設定洗掉
      selections[group].forEach((value) => counts.has(value) || counts.set(value, 0));
      const choices = [...counts.entries()]
        .map(
          ([value, count]) => `<label style="display:inline-block;margin-right:8px"><input type="checkbox" data-pick-choice="${group}"
            value="${escapeHtml(value)}" ${selections[group].includes(value) ? 'checked' : ''} style="width:auto;flex:none">
            ${escapeHtml(value)}（${count}）</label>`
        )
        .join('');
      return `<div class="subhead">${title}</div><div>${choices || '<span class="hint">畫面上沒有顯示</span>'}</div>`;
    }).join('');
    setStatus(`物品頁共 ${rows.length} 件`);
  }

  function updatePickFromChoices(group) {
    const [, , field] = PICK_GROUPS.find(([candidate]) => candidate === group);
    panel.querySelector(`[data-field="${field}"]`).value = Array.from(panel.querySelectorAll(`[data-pick-choice="${group}"]`))
      .filter((input) => input.checked)
      .map((input) => input.value)
      .join(',');
  }

  async function pickItemsByQuality(settings) {
    const selections = pickSelections(settings);
    if (!PICK_GROUPS.some(([group]) => selections[group].length)) {
      setStatus('請先按「掃描物品頁」，勾要選的品質、類型或名稱');
      return;
    }
    if (qualityPick.running) return;
    const runId = ++qualityPick.runId;
    qualityPick.running = true;
    const checking = settings.qualityPickMode !== 'uncheck';
    const verb = checking ? '勾選' : '取消勾選';
    try {
      const targets = (await scanItemRows()).filter((row) => isBoxChecked(row.checkbox) !== checking && matchesPick(row, selections));
      if (!targets.length) {
        setStatus(`畫面上沒有要${verb}的物品`);
        return;
      }
      const minimum = Math.min(settings.qualityPickMinMilliseconds, settings.qualityPickMaxMilliseconds);
      const maximum = Math.max(settings.qualityPickMinMilliseconds, settings.qualityPickMaxMilliseconds);
      let done = 0;
      for (const { checkbox } of targets) {
        if (runId !== qualityPick.runId) {
          setStatus(`已停止${verb}，完成 ${done}／${targets.length} 個`);
          return;
        }
        // 換頁或清單重繪後舊的勾選框就不在畫面上了，不要點
        if (!checkbox.isConnected || isBoxChecked(checkbox) === checking) continue;
        if (done) await wait(randomGap(minimum, maximum));
        if (runId !== qualityPick.runId || isBoxChecked(checkbox) === checking) continue;
        checkbox.click();
        done++;
        setStatus(`${verb}中 ${done}／${targets.length}`);
      }
      setStatus(`已${verb} ${done} 個`);
    } catch (error) {
      setStatus(`${verb}失敗（${error.message}）`);
    } finally {
      qualityPick.running = false;
    }
  }

  // 地點只列出比平均多或少 0.5 以上的屬性，窄面板放不下整張表
  function placeDiffHtml(diffs) {
    return Object.entries(diffs)
      .filter(([, diff]) => Math.abs(diff) >= 0.5)
      .sort(([, first], [, second]) => second - first)
      .map(([zhName, diff]) => `<span style="color:${diff > 0 ? '#22c55e' : '#ef4444'}">${zhName} ${formatGrowth(diff)}</span>`)
      .join('、');
  }

  // 大視窗跟面板同一層，晚放進頁面的會蓋在面板上面
  // 地圖升級統計大表：面板太窄只放得下幾個屬性，這裡開一個大視窗把每個地點 × 每個屬性攤開，點表頭可排序
  const growthViewer = { element: null, sortKey: '' };

  function openGrowthViewer() {
    if (!growthViewer.element) {
      const element = document.createElement('div');
      element.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif';
      element.innerHTML = `
        <div style="width:min(960px,96vw);max-height:88vh;display:flex;flex-direction:column;background:#18181b;color:#eee;border:1px solid #3a3a40;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.6)">
          <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #3a3a40;flex-wrap:wrap">
            <b style="flex:1;min-width:140px">地圖升級屬性統計</b>
            <select data-viewer="scope" style="padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px;max-width:260px"></select>
            <label>至少 <input data-viewer="min" type="number" min="1" value="1" style="width:44px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px"> 次</label>
            <button data-viewer="close" style="padding:3px 10px;color:#fff;background:#3a3a42;border:1px solid #55555c;border-radius:5px;cursor:pointer">關閉</button>
          </div>
          <div data-viewer="hint" style="padding:6px 14px;color:#a0a0aa;font-size:12px"></div>
          <div data-viewer="body" style="overflow:auto;padding:0 14px 14px"></div>
        </div>`;
      element.addEventListener('click', (event) => {
        if (event.target === element || event.target.dataset.viewer === 'close') closeGrowthViewer();
        const header = event.target.closest('[data-viewer-sort]');
        if (header) {
          growthViewer.sortKey = growthViewer.sortKey === header.dataset.viewerSort ? '' : header.dataset.viewerSort;
          renderGrowthViewer();
        }
      });
      element.addEventListener('change', renderGrowthViewer);
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && growthViewer.element && growthViewer.element.isConnected) closeGrowthViewer();
      });
      growthViewer.element = element;
    }
    const scope = growthViewer.element.querySelector('[data-viewer="scope"]');
    const previous = scope.value;
    scope.innerHTML =
      '<option value="">全部角色合併（跟角色無關）</option>' +
      growthTracker
        .cardSummaries()
        .map((card) => `<option value="${escapeHtml(card.heroId)}">${escapeHtml(cardLabel(card))}</option>`)
        .join('');
    if ([...scope.options].some((option) => option.value === previous)) scope.value = previous;
    document.body.appendChild(growthViewer.element);
    renderGrowthViewer();
  }

  function closeGrowthViewer() {
    if (growthViewer.element) growthViewer.element.remove();
  }

  // 綠＝這個地點升級比平均多、紅＝少；越飽和差越多，樣本少的淡一點
  function viewerCell(diff, faded) {
    if (diff === undefined) return '<td style="color:#555;text-align:center">-</td>';
    const strength = Math.min(1, Math.abs(diff) / 3);
    const color = diff > 0 ? `rgba(34,197,94,${0.15 + strength * 0.55})` : `rgba(239,68,68,${0.15 + strength * 0.55})`;
    return `<td style="text-align:right;background:${Math.abs(diff) < 0.05 ? 'transparent' : color};opacity:${faded ? 0.5 : 1}">${formatGrowth(diff)}</td>`;
  }

  function renderGrowthViewer() {
    const element = growthViewer.element;
    if (!element) return;
    const heroId = element.querySelector('[data-viewer="scope"]').value;
    const minimum = Math.max(1, Number(element.querySelector('[data-viewer="min"]').value) || 1);
    const card = heroId ? growthTracker.cardSummaries().find((candidate) => candidate.heroId === heroId) : null;
    let places = (card ? card.places : growthTracker.placeSummaries()).filter((place) => place.samples >= minimum);
    const stats = growthTracker.sharedStatNames;
    if (growthViewer.sortKey === 'samples') places = places.slice().sort((first, second) => second.samples - first.samples);
    else if (growthViewer.sortKey) {
      const value = (place) => place.diffs[growthViewer.sortKey] ?? -Infinity;
      places = places.slice().sort((first, second) => value(second) - value(first));
    }
    element.querySelector('[data-viewer="hint"]').textContent = card
      ? '這張卡在各地點升級時，每級比它自己的平均多／少多少；點表頭可依該欄排序，再點一次恢復地點順序'
      : '每張卡先跟自己的平均比，再把所有卡在同一地點的差值合起來，跟角色無關；點表頭可依該欄排序，再點一次恢復地點順序';
    const header = (key, label) =>
      `<th data-viewer-sort="${key}" style="position:sticky;top:0;background:#18181b;padding:6px;cursor:pointer;white-space:nowrap;border-bottom:1px solid #3a3a40;${growthViewer.sortKey === key ? 'color:#60a5fa' : ''}">${label}${growthViewer.sortKey === key ? ' ▼' : ''}</th>`;
    element.querySelector('[data-viewer="body"]').innerHTML = places.length
      ? `<table style="width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums">
          <tr><th style="position:sticky;top:0;background:#18181b;padding:6px;text-align:left;border-bottom:1px solid #3a3a40">地點</th>
            ${header('samples', '次數')}${card ? '' : '<th style="position:sticky;top:0;background:#18181b;padding:6px;border-bottom:1px solid #3a3a40">角色</th>'}
            ${stats.map((zhName) => header(zhName, zhName)).join('')}</tr>
          ${places
            .map((place) => {
              const faded = place.samples < 3;
              return `<tr style="border-bottom:1px solid #26262b"><td style="padding:4px 6px;white-space:nowrap">${escapeHtml(place.place)}</td>
                <td style="text-align:right;padding:4px 6px">${place.samples}</td>${card ? '' : `<td style="text-align:right;padding:4px 6px">${place.heroes}</td>`}
                ${stats.map((zhName) => viewerCell(place.diffs[zhName], faded)).join('')}</tr>`;
            })
            .join('')}
        </table>
        <div style="color:#a0a0aa;font-size:12px;margin-top:8px">只算一次升一級、有記到地點的紀錄；次數少於 3 次的顏色較淡，參考就好</div>`
      : '<div style="color:#a0a0aa;padding:20px 0">還沒有符合條件的升級紀錄</div>';
  }

  function renderGrowthPlaces() {
    panel.querySelector('[data-role="growth-places"]').innerHTML =
      growthTracker
        .placeSummaries()
        .map(
          (place) =>
            `<div>${escapeHtml(place.place)}（${place.samples} 次・${place.heroes} 隻）：${placeDiffHtml(place.diffs) || '跟平均差不多'}</div>`
        )
        .join('') || '<div class="hint">還沒有記到地點的升級</div>';
  }

  // 品質倍率 [素質倍率, 重量倍率]，跟「裝備基本素質+測名看%數」腳本同一張表；那支腳本裡自己改過的倍率（sgoBase.quality）也照用。
  // 攻防智運與耐久上限 ÷ 素質倍率、重量 ÷ 重量倍率，就是換成「普通」品質的基本值，不同品質才比得起來
  const QUALITY_MULTIPLIERS = {
    傳說: [2.3, 0.82],
    神話: [2.1, 0.84],
    史詩: [2.0, 0.85],
    完美: [1.85, 0.87],
    頂級: [1.65, 0.88],
    精良: [1.5, 0.9],
    高級: [1.33, 0.93],
    上等: [1.15, 0.96],
    普通: [1.0, 1.0],
    次等: [0.9, 1.01],
    劣質: [0.8, 1.02],
    破爛: [0.7, 1.03],
    垃圾般: [0.55, 1.06],
    屎一般: [0.4, 1.1],
  };
  // 由差到好
  const QUALITY_ORDER = Object.keys(QUALITY_MULTIPLIERS).reverse();

  function qualityMultipliers() {
    const custom = readJsonStorage('sgoBase.quality', {}) || {};
    return Object.fromEntries(
      Object.entries(QUALITY_MULTIPLIERS).map(([quality, [statMultiplier, weightMultiplier]]) => {
        const saved = Array.isArray(custom[quality]) ? custom[quality] : [];
        return [quality, [Number(saved[0]) > 0 ? Number(saved[0]) : statMultiplier, Number(saved[1]) > 0 ? Number(saved[1]) : weightMultiplier]];
      })
    );
  }

  // 不認得的品質就不換算，照原值
  function baseStats(item, multipliers) {
    const [statMultiplier, weightMultiplier] = multipliers[item.quality] || [1, 1];
    const value = (field) => Number(item[field]) || 0;
    return {
      atk: value('atk') / statMultiplier,
      def: value('def') / statMultiplier,
      int: value('int') / statMultiplier,
      lck: value('lck') / statMultiplier,
      wgt: value('wgt') / weightMultiplier,
      fullDur: value('fullDur') / statMultiplier,
      fullSlots: value('fullSlots'),
      recyclePrice: value('recyclePrice'),
    };
  }

  // 自己記鍛造材料，不用另外裝鍛造工具腳本：送出 /api/forge 時記下材料，完成鍛造時對上新做出來的裝備。
  // 材料送出的只有道具 id，名稱要從之前讀過的道具清單查；材料用完就從清單消失了，所以平常看到就先存起來
  const OWN_FORGE_MATERIALS_KEY = 'autoClickerV2ForgeMaterials';
  const FORGE_PENDING_KEY = 'autoClickerV2ForgePending';
  const ITEM_NAMES_KEY = 'autoClickerV2ItemNames';
  const FORGE_TYPE_NAMES = {
    sword: '單手劍', rapier: '細劍', dagger: '短刀', hammer: '單手錘', shield: '盾牌',
    thsword: '雙手劍', katana: '太刀', axe: '雙手斧', spear: '長槍',
    helmet: '頭盔', hat: '帽子', armor: '盔甲', coat: '大衣', necklace: '項鍊',
  };

  function writeJsonStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 存不進去只影響材料統計
    }
  }

  function rememberItemNames(data) {
    const names = readJsonStorage(ITEM_NAMES_KEY, {});
    let changed = false;
    ['items', 'mines'].forEach((field) => {
      (Array.isArray(data && data[field]) ? data[field] : []).forEach((item) => {
        if (!item || !item.id || typeof item.name !== 'string' || names[item.id] === item.name) return;
        names[item.id] = item.name;
        changed = true;
      });
    });
    if (changed) writeJsonStorage(ITEM_NAMES_KEY, names);
  }

  // 抽卡統計：用英雄券這類道具（POST /api/items/{id}/use）時，回應的 drawResult 就是抽到的英雄
  const DRAW_LOG_KEY = 'autoClickerV2Draws';
  const DRAW_LOG_LIMIT = 3000;
  const DRAW_RECENT_COUNT = 20;

  function recordDraw(itemId, data) {
    rememberItemNames(Array.isArray(data.items) ? data : data.items || {});
    const hero = data.drawResult;
    const draws = readJsonStorage(DRAW_LOG_KEY, []);
    draws.push({
      at: Date.now(),
      item: itemName(itemId),
      heroId: hero.id,
      // 剛抽到的英雄還沒改名，名字就是卡片種類
      type: hero.type || hero.name || '',
      tier: hero.tier || '',
      potential: hero.potential || '',
    });
    writeJsonStorage(DRAW_LOG_KEY, draws.slice(-DRAW_LOG_LIMIT));
    if (activeTab === 'draw') renderDrawStats();
  }

  function countBy(draws, key) {
    const counts = new Map();
    draws.forEach((draw) => counts.set(draw[key], (counts.get(draw[key]) || 0) + 1));
    return counts;
  }

  function renderDrawStats() {
    const all = readJsonStorage(DRAW_LOG_KEY, []);
    const select = panel.querySelector('[data-role="draw-item"]');
    const items = [...new Set(all.map((draw) => draw.item))];
    const chosen = items.includes(select.value) ? select.value : '';
    select.innerHTML = `<option value="">全部道具</option>${items
      .map((item) => `<option value="${escapeHtml(item)}" ${item === chosen ? 'selected' : ''}>${escapeHtml(item)}</option>`)
      .join('')}`;
    const draws = chosen ? all.filter((draw) => draw.item === chosen) : all;
    const box = panel.querySelector('[data-role="draw-stats"]');
    if (!draws.length) {
      box.innerHTML = '<div class="hint">還沒有抽卡紀錄：在遊戲的物品頁用英雄券抽卡，這裡就會記下來</div>';
      return;
    }
    const percent = (count) => `${((count / draws.length) * 100).toFixed(1)}%`;
    const table = (title, counts, order = null) => {
      const rows = [...counts.entries()]
        .sort(([firstKey, firstCount], [secondKey, secondCount]) =>
          order ? order.indexOf(secondKey) - order.indexOf(firstKey) : secondCount - firstCount
        )
        .map(([key, count]) => `<tr><td style="text-align:left">${escapeHtml(key || '（不明）')}</td><td>${count}</td><td>${percent(count)}</td></tr>`)
        .join('');
      return `<table class="combat"><tr><th style="text-align:left">${title}</th><th>張</th><th>機率</th></tr>${rows}</table>`;
    };
    const recent = draws
      .slice(-DRAW_RECENT_COUNT)
      .reverse()
      .map((draw) => {
        const time = new Date(draw.at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return `<div>${time} ${escapeHtml(draw.type)}（稀有度 ${escapeHtml(draw.tier || '?')}，潛能 ${escapeHtml(draw.potential || '?')}）${chosen ? '' : `　${escapeHtml(draw.item)}`}</div>`;
      })
      .join('');
    const since = new Date(draws[0].at).toLocaleDateString();
    box.innerHTML = `
      <div>共抽 <b>${draws.length}</b> 張（${since} 起）</div>
      ${table('潛能評價', countBy(draws, 'potential'), POTENTIAL_ORDER)}
      ${table('稀有度', countBy(draws, 'tier'))}
      <details><summary>各卡片（${countBy(draws, 'type').size} 種）</summary>${table('卡片', countBy(draws, 'type'))}</details>
      <div class="subhead">最近 ${Math.min(DRAW_RECENT_COUNT, draws.length)} 抽</div>
      <div class="hint">${recent}</div>`;
  }

  // 自己沒記到的名稱，再看鍛造工具腳本有沒有記
  function itemName(itemId) {
    const own = readJsonStorage(ITEM_NAMES_KEY, {})[itemId];
    if (own) return own;
    const other = readJsonStorage('sgoEquipToolsMineNames', {});
    return (other && other[itemId]) || `#${itemId}`;
  }

  // 鍛造師的鍛造、裁縫、工藝會影響成品（裁縫管布料皮革、工藝管石材寶石），只有開工當下的數值才準
  function rememberForgeStart(requestBody, data) {
    const body = parseJsonText(requestBody);
    if (!body || !body.heroId || !Array.isArray(body.selectedMines)) return;
    const pending = readJsonStorage(FORGE_PENDING_KEY, {});
    const hero = ((data && data.heroes) || []).find((candidate) => candidate.id === body.heroId);
    pending[body.heroId] = {
      name: body.name,
      type: FORGE_TYPE_NAMES[body.type] || body.type,
      materials: body.selectedMines.map((mine) => [itemName(mine.itemId), Number(mine.quantity) || 0]),
      time: Date.now(),
      ...(hero ? { heroName: hero.name, skills: { forge: hero.forge, tailor: hero.tailor, craft: hero.craft } } : {}),
    };
    writeJsonStorage(FORGE_PENDING_KEY, pending);
  }

  function parseJsonText(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // 完成鍛造的回應有新裝備就用它，沒有就重讀裝備清單，挑鍛造開始後做出來、同名同類型、還沒對過的最新一件
  async function rememberForgeComplete(heroId, data) {
    const forge = readJsonStorage(FORGE_PENDING_KEY, {})[heroId];
    if (!forge) return;
    const found = [];
    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 5) return;
      if (Array.isArray(value)) {
        value.forEach((child) => walk(child, depth + 1));
        return;
      }
      if (typeof value.id === 'number' && typeof value.quality === 'string' && value.name === forge.name) found.push(value);
      Object.values(value).forEach((child) => walk(child, depth + 1));
    };
    walk(data, 0);
    // 回應裡同名的可能是角色身上穿的舊裝備，對不上就照樣重讀清單
    if (matchPendingForges(found)) return;
    matchPendingForges((await requestGameApi(EQUIPMENTS_API)).equipments || []);
  }

  // 完成當下沒對上的（角色身上同名舊裝備、請求失敗、在沒裝腳本的地方按完成），之後讀到裝備清單再補對
  function matchPendingForges(equipments) {
    const pending = readJsonStorage(FORGE_PENDING_KEY, {});
    const saved = readJsonStorage(OWN_FORGE_MATERIALS_KEY, {});
    const matched = [];
    Object.entries(pending).forEach(([heroId, forge]) => {
      const equipment = equipments
        .filter((item) => item && item.name === forge.name && !saved[item.id] && (!forge.type || item.type === forge.type))
        .filter((item) => !forge.heroName || !item.crafterHeroName || item.crafterHeroName === forge.heroName)
        // 修練也走 completeAction，同名的舊裝備不能算成這次做的
        .filter((item) => !item.craftedTime || Date.parse(item.craftedTime) >= forge.time - 60000)
        .sort((first, second) => second.id - first.id)[0];
      if (!equipment) return;
      saved[equipment.id] = {
        materials: forge.materials,
        time: equipment.craftedTime || new Date().toISOString(),
        ...(forge.skills ? { skills: forge.skills } : {}),
      };
      delete pending[heroId];
      matched.push(equipment);
    });
    if (!matched.length) return false;
    writeJsonStorage(OWN_FORGE_MATERIALS_KEY, saved);
    writeJsonStorage(FORGE_PENDING_KEY, pending);
    rememberForgedEquipments(matched);
    return true;
  }

  // 鍛造材料：API 不給，自己攔截鍛造請求記，也讀鍛造工具腳本存在 localStorage 的（裝備 id → 材料），別人的只讀不改。
  // 裝備數值則是每次讀到 /api/equipments 就自己存一份，賣掉、回收的裝備也還算得到
  const FORGED_EQUIPMENTS_KEY = 'autoClickerV2ForgedEquipments';
  const FORGED_EQUIPMENTS_LIMIT = 5000;
  const CLOUD_EQUIPMENTS_KEY = 'autoClickerV2CloudEquipments';
  const MATERIAL_STAT_FIELDS = [
    ['atk', '攻'],
    ['def', '防'],
    ['int', '智'],
    ['lck', '運'],
    ['wgt', '重'],
    ['fullDur', '耐'],
    ['fullSlots', '孔'],
    ['recyclePrice', '回收'],
  ];

  function readJsonStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  // 強化加的數值（plus）是之後另外加的，跟材料無關，扣掉才是剛做好時的數值
  function rememberForgedEquipments(equipments) {
    const saved = readJsonStorage(FORGED_EQUIPMENTS_KEY, {});
    let changed = false;
    equipments.forEach((equipment) => {
      if (!equipment.crafterHeroName) return;
      // 舊版存的沒有名稱；名稱每天影響數值（社群測名表就是查「某天某名稱」），補上才對得起來
      if (saved[equipment.id]) {
        if (!saved[equipment.id].name && equipment.name) {
          saved[equipment.id].name = equipment.name;
          changed = true;
        }
        return;
      }
      const plus = equipment.plus || {};
      saved[equipment.id] = {
        quality: equipment.quality,
        type: equipment.type,
        atk: equipment.atk - (plus.atk || 0),
        def: equipment.def - (plus.def || 0),
        int: equipment.int - (plus.int || 0),
        lck: equipment.lck - (plus.lck || 0),
        wgt: equipment.wgt - (plus.wgt || 0),
        fullDur: equipment.fullDur - (plus.dur || 0),
        fullSlots: equipment.fullSlots,
        enchantments: equipment.enchantments || null,
        recyclePrice: equipment.recyclePrice,
        forger: equipment.crafterHeroName,
        craftedTime: equipment.craftedTime,
        // 同配方同名稱的成長每天不同，名稱和鍛造時間留著，之後才能分開比
        name: equipment.name,
      };
      changed = true;
    });
    if (!changed) return;
    const ids = Object.keys(saved);
    // 超過上限就丟最舊的（id 越小越舊）
    ids.slice(0, Math.max(0, ids.length - FORGED_EQUIPMENTS_LIMIT)).forEach((id) => delete saved[id]);
    try {
      localStorage.setItem(FORGED_EQUIPMENTS_KEY, JSON.stringify(saved));
    } catch {
      // 存不進去只影響材料統計
    }
  }

  // 三個來源：自己記的、鍛造工具腳本的 sgoBase.forgeMaterials（同格式：id → { materials: [[名稱, 數量]] }）、
  // sgoEquipToolsForgeLog（陣列，materials: [{ name, qty }]）；同一件以前面的為準
  function readForgeMaterials() {
    const byEquipment = new Map();
    [OWN_FORGE_MATERIALS_KEY, 'sgoBase.forgeMaterials'].forEach((key) => {
      const saved = readJsonStorage(key, {});
      if (!saved || typeof saved !== 'object') return;
      Object.entries(saved).forEach(([id, entry]) => {
        if (byEquipment.has(String(id)) || !entry || !Array.isArray(entry.materials)) return;
        byEquipment.set(String(id), entry.materials.map(([name, quantity]) => [String(name), Number(quantity) || 0]));
      });
    });
    const log = readJsonStorage('sgoEquipToolsForgeLog', []);
    if (Array.isArray(log)) {
      log.forEach((entry) => {
        if (!entry || !entry.equipmentId || !Array.isArray(entry.materials) || byEquipment.has(String(entry.equipmentId))) return;
        byEquipment.set(String(entry.equipmentId), entry.materials.map((item) => [String(item.name), Number(item.qty ?? item.quantity) || 0]));
      });
    }
    return byEquipment;
  }

  function materialGroupKeys(materials, mode) {
    if (mode === 'combo') {
      return [
        [...materials]
          .sort(([first], [second]) => first.localeCompare(second, 'zh-Hant'))
          .map(([name, quantity]) => `${name}×${quantity}`)
          .join('、'),
      ];
    }
    return [...new Set(materials.map(([name]) => name))];
  }

  // 同一件裝備自己有紀錄就用自己的
  function forgedRecords() {
    const records = new Map(Object.entries(readJsonStorage(CLOUD_EQUIPMENTS_KEY, {})));
    const own = readJsonStorage(FORGED_EQUIPMENTS_KEY, {});
    const ownForges = readJsonStorage(OWN_FORGE_MATERIALS_KEY, {});
    readForgeMaterials().forEach((materials, id) => {
      if (own[id]) records.set(id, { ...own[id], materials, skills: ownForges[id] && ownForges[id].skills });
    });
    return records;
  }

  // 同一個鍛造師做的才比得起來；名稱一樣的鍛造師當同一個
  function forgerNames() {
    return [...new Set([...forgedRecords().values()].map((item) => item.forger).filter(Boolean))].sort();
  }

  function fillForgerSelect(select) {
    const previous = select.value;
    const names = forgerNames();
    select.innerHTML = `<option value="">全部鍛造師</option>${names.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}`;
    if (names.includes(previous)) select.value = previous;
  }

  function skillsText(items) {
    const withSkills = items.filter((item) => item.skills);
    if (!withSkills.length) return '';
    const average = (field) => Math.round(withSkills.reduce((sum, item) => sum + (Number(item.skills[field]) || 0), 0) / withSkills.length);
    return `鍛 ${average('forge')}／裁 ${average('tailor')}／工 ${average('craft')}`;
  }

  function materialSummaries(mode, type, forger = '', weights = null) {
    const multipliers = qualityMultipliers();
    const groups = new Map();
    let matched = 0;
    let fromCloud = 0;
    let unmatchedNames = 0;
    forgedRecords().forEach((equipment) => {
      if ((type && equipment.type !== type) || (forger && equipment.forger !== forger)) return;
      const base = adjustedBaseStats(equipment, multipliers, weights);
      if (!base) {
        unmatchedNames++;
        return;
      }
      matched++;
      if (equipment.contributor) fromCloud++;
      materialGroupKeys(equipment.materials, mode).forEach((key) => {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ...equipment, base });
      });
    });
    const summaries = [...groups.entries()]
      .map(([key, items]) => {
        const qualities = new Map();
        const enchantments = new Map();
        items.forEach((item) => {
          qualities.set(item.quality, (qualities.get(item.quality) || 0) + 1);
          Object.entries(item.enchantments || {}).forEach(([name, value]) => {
            const entry = enchantments.get(name) || { count: 0, total: 0 };
            entry.count++;
            entry.total += Number(value) || 0;
            enchantments.set(name, entry);
          });
        });
        const bases = items.map((item) => item.base);
        const averages = Object.fromEntries(
          MATERIAL_STAT_FIELDS.map(([field]) => [field, bases.reduce((sum, base) => sum + base[field], 0) / items.length])
        );
        return { key, count: items.length, qualities, enchantments, averages, skills: skillsText(items) };
      })
      .sort((first, second) => second.count - first.count);
    return { summaries, matched, fromCloud, unmatchedNames };
  }

  function qualityRank(quality) {
    const index = QUALITY_ORDER.indexOf(quality);
    return index < 0 ? QUALITY_ORDER.length : index;
  }

  // 材料統計畫成卡片：品質分布用遊戲裡的品質顏色堆疊成一條，屬性用長條（跟目前列出來的最高值比），附魔做成標籤
  const QUALITY_COLORS = {
    傳說: '#fb923c', 神話: '#f87171', 史詩: '#c084fc', 完美: '#facc15', 頂級: '#22d3ee', 精良: '#60a5fa', 高級: '#4ade80',
    上等: '#d6d3d1', 普通: '#a8a29e', 次等: '#78716c', 劣質: '#57534e', 破爛: '#b45309', 垃圾般: '#854d0e', 屎一般: '#78350f',
  };
  const MATERIAL_BAR_FIELDS = [
    ['atk', '攻', '#f87171'],
    ['def', '防', '#60a5fa'],
    ['int', '智', '#c084fc'],
    ['lck', '運', '#facc15'],
    ['fullDur', '耐', '#4ade80'],
    ['wgt', '重', '#a8a29e'],
  ];
  const MATERIAL_SORTS = {
    count: (summary) => summary.count,
    atk: (summary) => summary.averages.atk,
    def: (summary) => summary.averages.def,
    int: (summary) => summary.averages.int,
    lck: (summary) => summary.averages.lck,
    fullDur: (summary) => summary.averages.fullDur,
    wgt: (summary) => -summary.averages.wgt,
    recyclePrice: (summary) => summary.averages.recyclePrice,
  };
  let lastMaterialCards = { html: '', title: '' };

  // 重量越輕越好，所以長條是「最輕的 ÷ 這組」
  function materialBarWidth(field, value, extremes) {
    if (!(value > 0)) return 0;
    return field === 'wgt' ? (extremes.minWeight / value) * 100 : (value / extremes.max[field]) * 100;
  }

  function materialCardHtml(summary, extremes) {
    const qualityEntries = [...summary.qualities.entries()].sort(([first], [second]) => qualityRank(second) - qualityRank(first));
    const qualityBar = qualityEntries
      .map(
        ([quality, count]) =>
          `<div title="${escapeHtml(quality)} ${count} 件" style="flex:${count};background:${QUALITY_COLORS[quality] || '#555'}"></div>`
      )
      .join('');
    const qualityText = qualityEntries
      .map(([quality, count]) => `<span style="color:${QUALITY_COLORS[quality] || '#aaa'}">${escapeHtml(quality)}${count}</span>`)
      .join(' ');
    const bars = MATERIAL_BAR_FIELDS.map(([field, label, color]) => {
      const value = summary.averages[field];
      return `<div style="display:flex;align-items:center;gap:4px;height:14px">
        <span style="width:14px;color:#a0a0aa">${label}</span>
        <div style="flex:1;height:8px;background:#26262b;border-radius:4px;overflow:hidden"><div style="width:${Math.min(100, materialBarWidth(field, value, extremes)).toFixed(0)}%;height:100%;background:${color}"></div></div>
        <span style="width:42px;text-align:right;font-variant-numeric:tabular-nums">${Math.round(value)}</span></div>`;
    }).join('');
    const enchantments = [...summary.enchantments.entries()]
      .sort(([, first], [, second]) => second.count - first.count)
      .map(
        ([name, entry]) =>
          `<span style="display:inline-block;margin:1px 2px 0 0;padding:0 6px;border-radius:9px;background:#3b2f5c;color:#ddd6fe">${escapeHtml(name)} ${Math.round(
            (entry.count / summary.count) * 100
          )}%・+${Math.round(entry.total / entry.count)}</span>`
      )
      .join('');
    return `<div style="border:1px solid #2e2e34;border-radius:8px;padding:6px;margin:4px 0;background:#1c1c21">
      <div style="display:flex;gap:6px;align-items:baseline"><b style="flex:1;min-width:0;word-break:break-all">${escapeHtml(summary.key)}</b>
        <span style="color:#a0a0aa;white-space:nowrap">${summary.count} 件</span></div>
      <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;margin:4px 0 2px">${qualityBar}</div>
      <div style="font-size:11px;margin-bottom:3px">${qualityText}</div>
      ${bars}
      <div style="font-size:11px;color:#a0a0aa;margin-top:2px">孔 ${Math.round(summary.averages.fullSlots)}・回收 ${Math.round(summary.averages.recyclePrice)}${
        summary.skills ? `・鍛造師 ${summary.skills}` : ''
      }</div>
      <div style="font-size:11px;margin-top:2px">${enchantments || '<span style="color:#666">沒有附魔</span>'}</div>
    </div>`;
  }

  function materialCardsHtml(summaries) {
    const extremes = {
      max: Object.fromEntries(MATERIAL_BAR_FIELDS.map(([field]) => [field, Math.max(1, ...summaries.map((summary) => summary.averages[field]))])),
      minWeight: Math.min(...summaries.map((summary) => summary.averages.wgt).filter((value) => value > 0)),
    };
    return summaries.map((summary) => materialCardHtml(summary, extremes)).join('');
  }

  function openMaterialViewer() {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:12px system-ui,sans-serif;color:#eee';
    overlay.innerHTML = `<div style="width:min(1100px,96vw);max-height:88vh;display:flex;flex-direction:column;background:#18181b;border:1px solid #3a3a40;border-radius:10px">
      <div style="display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid #3a3a40"><b style="flex:1">${escapeHtml(lastMaterialCards.title)}</b>
        <button data-close style="padding:3px 10px;color:#fff;background:#3a3a42;border:1px solid #55555c;border-radius:5px;cursor:pointer">關閉</button></div>
      <div style="overflow:auto;padding:8px 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:4px 10px;align-items:start">${lastMaterialCards.html}</div>
    </div>`;
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.hasAttribute('data-close')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  }

  // 材料貢獻：一件裝備放了很多種材料，「用過某材料的裝備平均」會把別的材料的功勞也算進來。
  // 改用多元迴歸：數值 ≈ Σ 每種材料的數量 × 該材料每個的貢獻，同類型的裝備一起解（ridge 迴歸，樣本少時才不會爆掉），
  // 得到「其他材料不變時，多放 1 個這種材料平均增減多少」。數值先換成普通品質、扣掉名稱影響
  const REGRESSION_FIELDS = [
    ['atk', '攻'],
    ['def', '防'],
    ['int', '智'],
    ['lck', '運'],
    ['fullDur', '耐'],
    ['wgt', '重'],
  ];
  const REGRESSION_RIDGE = 0.5;
  // 不管放什麼材料都有的部分（類型本身的基本值），當成每件都放 1 個的假材料一起解
  const REGRESSION_BASE = '（類型基本值）';
  const REGRESSION_MIN_USES = 3;

  // Gauss-Jordan 求反矩陣；矩陣已加過 ridge，一定可逆
  function invertMatrix(matrix) {
    const size = matrix.length;
    const work = matrix.map((row, index) => [...row, ...Array.from({ length: size }, (_, column) => (column === index ? 1 : 0))]);
    for (let column = 0; column < size; column++) {
      let pivot = column;
      for (let row = column + 1; row < size; row++) if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
      [work[column], work[pivot]] = [work[pivot], work[column]];
      const divisor = work[column][column];
      for (let index = 0; index < size * 2; index++) work[column][index] /= divisor;
      for (let row = 0; row < size; row++) {
        if (row === column || !work[row][column]) continue;
        const factor = work[row][column];
        for (let index = 0; index < size * 2; index++) work[row][index] -= factor * work[column][index];
      }
    }
    return work.map((row) => row.slice(size));
  }

  function materialRegression(type, weights, forger = '') {
    if (!type) return null;
    const multipliers = qualityMultipliers();
    const samples = [];
    forgedRecords().forEach((equipment) => {
      if (equipment.type !== type || (forger && equipment.forger !== forger)) return;
      const base = adjustedBaseStats(equipment, multipliers, weights);
      if (base) samples.push({ materials: equipment.materials, base, enchantments: equipment.enchantments || {} });
    });
    const materialNames = [...new Set(samples.flatMap((sample) => sample.materials.map(([name]) => name)))].sort();
    if (!samples.length || !materialNames.length) return null;
    const names = [REGRESSION_BASE, ...materialNames];
    const column = new Map(names.map((name, index) => [name, index]));
    const rows = samples.map((sample) => {
      const row = new Array(names.length).fill(0);
      row[0] = 1;
      sample.materials.forEach(([name, quantity]) => (row[column.get(name)] += quantity));
      return row;
    });
    const gram = names.map((_, first) =>
      names.map((__, second) => rows.reduce((sum, row) => sum + row[first] * row[second], 0) + (first === second ? REGRESSION_RIDGE : 0))
    );
    const inverse = invertMatrix(gram);
    const result = { type, names: materialNames, sampleCount: samples.length, coefficients: {}, errors: {}, fit: {}, uses: {}, enchantLift: {}, means: {} };
    REGRESSION_FIELDS.forEach(([field]) => {
      const targets = samples.map((sample) => sample.base[field]);
      const moment = names.map((_, index) => rows.reduce((sum, row, rowIndex) => sum + row[index] * targets[rowIndex], 0));
      const beta = inverse.map((row) => row.reduce((sum, value, index) => sum + value * moment[index], 0));
      const predictions = rows.map((row) => row.reduce((sum, value, index) => sum + value * beta[index], 0));
      const residual = targets.reduce((sum, target, index) => sum + (target - predictions[index]) ** 2, 0);
      const mean = targets.reduce((sum, target) => sum + target, 0) / targets.length;
      const total = targets.reduce((sum, target) => sum + (target - mean) ** 2, 0);
      const variance = residual / Math.max(1, samples.length - names.length);
      result.coefficients[field] = Object.fromEntries(names.map((name, index) => [name, beta[index]]));
      result.errors[field] = Object.fromEntries(names.map((name, index) => [name, Math.sqrt(Math.max(0, inverse[index][index] * variance))]));
      result.fit[field] = total > 0 ? 1 - residual / total : null;
      result.means[field] = mean;
    });
    // 附魔是有或沒有，用「有放這個材料時出現率」減「沒放時出現率」看關聯
    const enchantNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.enchantments)))];
    result.enchantCounts = {};
    result.enchantCoefficients = {};
    enchantNames.forEach((enchant) => {
      const targets = samples.map((sample) => Number(sample.enchantments[enchant]) || 0);
      const moment = names.map((_, index) => rows.reduce((sum, row, rowIndex) => sum + row[index] * targets[rowIndex], 0));
      const beta = inverse.map((row) => row.reduce((sum, value, index) => sum + value * moment[index], 0));
      result.enchantCounts[enchant] = targets.filter(Boolean).length;
      result.enchantCoefficients[enchant] = Object.fromEntries(materialNames.map((name) => [name, beta[names.indexOf(name)]]));
    });
    materialNames.forEach((name) => {
      const withMaterial = samples.filter((sample) => sample.materials.some(([material]) => material === name));
      const without = samples.filter((sample) => !sample.materials.some(([material]) => material === name));
      result.uses[name] = withMaterial.length;
      const rate = (group, enchant) => (group.length ? group.filter((sample) => enchant in sample.enchantments).length / group.length : null);
      result.enchantLift[name] = enchantNames
        .map((enchant) => {
          const withRate = rate(withMaterial, enchant);
          const withoutRate = rate(without, enchant);
          return withoutRate === null || withRate === null ? null : { enchant, lift: withRate - withoutRate, rate: withRate };
        })
        .filter((entry) => entry && Math.abs(entry.lift) >= 0.1)
        .sort((first, second) => second.lift - first.lift);
    });
    return result;
  }

  function enchantRequirements(samples = [...forgedRecords().values()].filter((equipment) => Array.isArray(equipment.materials))) {
    const hasMaterial = (sample, name) => sample.materials.some(([material]) => material === name);
    const enchantNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.enchantments || {})))];
    return enchantNames
      .map((enchant) => {
        const withEnchant = samples.filter((sample) => sample.enchantments && enchant in sample.enchantments);
        const values = withEnchant.map((sample) => Number(sample.enchantments[enchant]) || 0);
        const required = [...new Set(withEnchant.flatMap((sample) => sample.materials.map(([name]) => name)))]
          .filter((name) => withEnchant.every((sample) => hasMaterial(sample, name)))
          .map((name) => {
            const used = samples.filter((sample) => hasMaterial(sample, name));
            return { name, used: used.length, rate: withEnchant.length / used.length };
          })
          // 幾乎每件都會放的材料（例如泥土）一定會被算成「必要」，看不出關係，不列
          .filter(({ used }) => used < samples.length * 0.9)
          .sort((first, second) => second.rate - first.rate);
        // 常放的材料（泥土、黑土）也常剛好「每件都有」，但放了之後出現率很低；只留出現率接近最高的才算來源
        const topRate = required.length ? required[0].rate : 0;
        required.splice(0, required.length, ...required.filter(({ rate }) => rate >= topRate * 0.6));
        return {
          enchant,
          count: withEnchant.length,
          min: Math.min(...values),
          max: Math.max(...values),
          required,
        };
      })
      .sort((first, second) => second.count - first.count);
  }

  // 反過來找「不帶附魔」的材料：只看沒放任何已知附魔來源材料的裝備，這種裝備放了某材料卻從沒出過附魔，
  // 這個材料大概就不給附魔。附魔有機率，所以件數越多越可信；沒放來源卻出了附魔，代表還有沒找到的來源
  function enchantFreeMaterials(requirements) {
    const samples = [...forgedRecords().values()].filter((equipment) => Array.isArray(equipment.materials));
    const sources = new Set(requirements.flatMap(({ required }) => required.map(({ name }) => name)));
    const hasMaterial = (sample, name) => sample.materials.some(([material]) => material === name);
    const clean = samples.filter((sample) => ![...sources].some((name) => hasMaterial(sample, name)));
    const names = [...new Set(samples.flatMap((sample) => sample.materials.map(([name]) => name)))].filter((name) => !sources.has(name));
    return names
      .map((name) => {
        const used = clean.filter((sample) => hasMaterial(sample, name));
        const enchanted = used.filter((sample) => sample.enchantments && Object.keys(sample.enchantments).length);
        return { name, used: used.length, enchanted: enchanted.length };
      })
      .filter(({ used }) => used > 0)
      .sort((first, second) => second.used - first.used);
  }

  function enchantRequirementsHtml() {
    const requirements = enchantRequirements();
    const free = enchantFreeMaterials(requirements);
    const none = free.filter(({ enchanted }) => !enchanted);
    const unknown = free.filter(({ enchanted }) => enchanted);
    const freeHtml =
      (none.length
        ? `<div style="margin:4px 0 2px"><b style="color:#a0a0aa">看起來不帶附魔</b>：${none
            .map(({ name, used }) => `${escapeHtml(name)}（${used} 件${used < 3 ? '，還少' : ''}）`)
            .join('、')}</div>`
        : '') +
      (unknown.length
        ? `<div style="margin:2px 0"><b style="color:#f59e0b">沒放已知來源也出過附魔</b>：${unknown
            .map(({ name, used, enchanted }) => `${escapeHtml(name)}（${enchanted}/${used} 件）`)
            .join('、')}</div>`
        : '');
    if (!requirements.length) return `<span class="hint">還沒有出過附魔的裝備</span>${freeHtml}`;
    return requirements
      .map(({ enchant, count, min, max, required }) => {
        const list = required
          .slice(0, 3)
          .map(({ name, used, rate }) => `${escapeHtml(name)}（放過 ${used} 件，出現 ${Math.round(rate * 100)}%）`)
          .join('、');
        return `<div style="margin:2px 0"><b style="color:#c4b5fd">${escapeHtml(enchant)}</b> ${min === max ? min : `${min}～${max}`}（${count} 件）：${
          list ? `必要材料 ${list}` : '<span style="color:#f59e0b">沒有每件都有放的材料，可能不只一種來源</span>'
        }${count < 3 ? '<span class="hint">（件數少，參考就好）</span>' : ''}</div>`;
      })
      .join('') + freeHtml;
  }

  // 附魔推測：自己填一份材料，照過去鍛造紀錄估會出哪些附魔、機率多少、數值大概多少。
  // 每種附魔先找「來源材料」（出過這個附魔的裝備全都有放），再看同樣放了來源、數量差不多的裝備有幾成出現
  const enchantPlan = new Map();

  function enchantSamples(type, forger) {
    return [...forgedRecords().values()].filter(
      (record) => Array.isArray(record.materials) && (!type || record.type === type) && (!forger || record.forger === forger)
    );
  }

  function materialQuantity(materials, names) {
    return materials.filter(([name]) => names.includes(name)).reduce((sum, [, quantity]) => sum + (Number(quantity) || 0), 0);
  }

  // 只用一個變數（來源材料數量）的直線；點太少或數量都一樣就不估
  function fitLine(points) {
    if (points.length < 3) return null;
    const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
    const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
    const spread = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
    if (!spread) return null;
    const slope = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0) / spread;
    return (x) => meanY + slope * (x - meanX);
  }

  function predictEnchants(samples, plan) {
    const planned = [...plan.entries()].filter(([, quantity]) => quantity > 0);
    const plannedNames = planned.map(([name]) => name);
    const plannedTotal = (names) => planned.filter(([name]) => names.includes(name)).reduce((sum, [, quantity]) => sum + quantity, 0);
    return enchantRequirements(samples).map(({ enchant, count, min, max, required }) => {
      const sources = required.map(({ name }) => name);
      if (!sources.length) return { enchant, count, min, max, sources, status: 'unknown' };
      const missing = sources.filter((name) => !plannedNames.includes(name));
      if (missing.length) return { enchant, count, min, max, sources, status: 'missing', missing };
      const quantity = plannedTotal(sources);
      const withSources = samples.filter((sample) => sources.every((name) => sample.materials.some(([material]) => material === name)));
      // 數量差不多的（一半到兩倍）才拿來算機率；太少就用全部放過來源的
      const similar = withSources.filter((sample) => {
        const used = materialQuantity(sample.materials, sources);
        return used >= quantity / 2 && used <= quantity * 2;
      });
      const basis = similar.length >= 3 ? similar : withSources;
      const appeared = basis.filter((sample) => sample.enchantments && enchant in sample.enchantments);
      const line = fitLine(
        samples
          .filter((sample) => sample.enchantments && enchant in sample.enchantments)
          .map((sample) => [materialQuantity(sample.materials, sources), Number(sample.enchantments[enchant]) || 0])
      );
      const estimate = line ? Math.max(0, Math.round(line(quantity))) : null;
      return { enchant, count, min, max, sources, status: 'possible', quantity, rate: appeared.length / basis.length, basis: basis.length, similar: basis === similar, estimate };
    });
  }

  function enchantPlannerHtml(type, forger) {
    const samples = enchantSamples(type, forger);
    if (!samples.length) return '<div class="hint">還沒有鍛造材料紀錄：之後在這個瀏覽器鍛造就會自動記</div>';
    const usage = new Map();
    samples.forEach((sample) => sample.materials.forEach(([name]) => usage.set(name, (usage.get(name) || 0) + 1)));
    const inputs = [...usage.entries()]
      .sort(([, first], [, second]) => second - first)
      .map(
        ([name, used]) => `<label style="display:inline-flex;align-items:center;gap:2px;margin:1px 6px 1px 0" title="放過 ${used} 件">${escapeHtml(name)}
          <input data-enchant-material="${escapeHtml(name)}" type="number" min="0" value="${enchantPlan.get(name) || ''}" placeholder="0" style="width:42px;flex:none"></label>`
      )
      .join('');
    return `<div class="hint">填這次要放的材料數量（${type || '全部類型'}，${samples.length} 件紀錄），下面會即時估附魔</div>
      <div style="margin:4px 0">${inputs}</div>
      <div class="row"><button data-action="enchant-plan-clear">清空材料</button></div>
      <div data-role="enchant-prediction">${enchantPredictionHtml(samples)}</div>`;
  }

  function enchantPredictionHtml(samples) {
    if (![...enchantPlan.values()].some((quantity) => quantity > 0)) return '<div class="hint">還沒填材料</div>';
    const results = predictEnchants(samples, enchantPlan);
    if (!results.length) return '<div class="hint">這些紀錄裡還沒有出過附魔的裝備</div>';
    const possible = results.filter((result) => result.status === 'possible').sort((first, second) => second.rate - first.rate);
    const rows = possible
      .map(({ enchant, rate, basis, similar, estimate, min, max, count }) => {
        const value = estimate === null ? (min === max ? `${min}` : `${min}～${max}`) : `約 ${estimate}`;
        const unsure = basis < 3 || count < 3;
        return `<tr style="opacity:${unsure ? 0.6 : 1}"><td style="text-align:left;color:#c4b5fd">${escapeHtml(enchant)}</td><td>${Math.round(rate * 100)}%</td><td>${value}</td>
          <td style="text-align:left" class="hint">${basis} 件${similar ? '數量相近' : '放過來源'}的裝備${unsure ? '，件數少' : ''}</td></tr>`;
      })
      .join('');
    const missing = results
      .filter((result) => result.status === 'missing')
      .map(({ enchant, missing: names }) => `${escapeHtml(enchant)}（要放 ${names.map(escapeHtml).join('、')}）`)
      .join('、');
    const unknown = results.filter((result) => result.status === 'unknown').map(({ enchant }) => escapeHtml(enchant)).join('、');
    return `${rows ? `<table class="combat"><tr><th style="text-align:left">附魔</th><th>機率</th><th>數值</th><th style="text-align:left">依據</th></tr>${rows}</table>` : '<div class="hint">這份材料估不出會出哪種附魔</div>'}
      ${missing ? `<div class="hint" style="margin-top:4px">不會出（沒放來源材料）：${missing}</div>` : ''}
      ${unknown ? `<div class="hint" style="color:#f59e0b">來源還看不出來（可能不只一種材料會給）：${unknown}</div>` : ''}
      <div class="hint">機率＝以前放了同樣來源材料、數量差不多的裝備有幾成出現；數值用來源材料數量畫直線估。附魔本來就看運氣，件數少的淡色顯示，參考就好</div>`;
  }

  function renderEnchantPrediction() {
    const box = panel.querySelector('[data-role="enchant-prediction"]');
    if (!box) return;
    const type = panel.querySelector('[data-role="material-type"]').value;
    const forger = panel.querySelector('[data-role="material-forger"]').value;
    box.innerHTML = enchantPredictionHtml(enchantSamples(type, forger));
  }

  // 給配方頁用：照迴歸結果估這個配方換成普通品質的數值；有沒分析過的材料就不估
  function predictRecipe(model, recipe) {
    if (!model || !recipe.length || recipe.some(([name]) => !(name in model.coefficients.atk))) return null;
    return Object.fromEntries(
      REGRESSION_FIELDS.map(([field]) => [
        field,
        recipe.reduce((sum, [name, quantity]) => sum + model.coefficients[field][name] * quantity, model.coefficients[field][REGRESSION_BASE]),
      ])
    );
  }

  function regressionHtml(model, sortKey, filter) {
    const sortField = REGRESSION_FIELDS.some(([field]) => field === sortKey) ? sortKey : null;
    const names = model.names
      .filter((name) => !filter || name.includes(filter))
      .sort((first, second) =>
        sortField
          ? (sortField === 'wgt' ? -1 : 1) * (model.coefficients[sortField][second] - model.coefficients[sortField][first])
          : model.uses[second] - model.uses[first]
      );
    const cell = (field, name) => {
      const value = model.coefficients[field][name];
      const error = model.errors[field][name];
      // 重量越輕越好，顏色反過來；誤差比數值大的（看不出正負）淡掉
      const good = field === 'wgt' ? value < 0 : value > 0;
      const unsure = model.uses[name] < REGRESSION_MIN_USES || Math.abs(value) < error;
      return `<td style="text-align:right;color:${good ? '#4ade80' : '#f87171'};opacity:${unsure ? 0.45 : 1}" title="±${error.toFixed(1)}">${value >= 0 ? '+' : ''}${value.toFixed(1)}</td>`;
    };
    const baseRow = `<tr style="border-bottom:1px solid #3a3a40"><td style="white-space:nowrap;color:#a0a0aa">類型基本值</td><td></td>${REGRESSION_FIELDS.map(
      ([field]) => `<td style="text-align:right;color:#a0a0aa">${Math.round(model.coefficients[field][REGRESSION_BASE])}</td>`
    ).join('')}</tr>`;
    const rows = names
      .map((name) => {
        const lifts = model.enchantLift[name]
          .slice(0, 3)
          .map(({ enchant, lift }) => `${escapeHtml(enchant)} ${lift > 0 ? '+' : ''}${Math.round(lift * 100)}%`)
          .join('、');
        return `<tr><td style="white-space:nowrap">${escapeHtml(name)}</td><td style="text-align:right">${model.uses[name]}</td>${REGRESSION_FIELDS.map(([field]) => cell(field, name)).join('')}</tr>
          ${lifts ? `<tr><td></td><td colspan="${REGRESSION_FIELDS.length + 1}" style="color:#c4b5fd;font-size:11px;text-align:left">附魔 ${lifts}</td></tr>` : ''}`;
      })
      .join('');
    // 每種附魔列出最相關的材料：每多放 1 個多多少附魔值，以及有放／沒放的出現率差
    const enchantSection = Object.entries(model.enchantCounts)
      .sort(([, first], [, second]) => second - first)
      .map(([enchant, count]) => {
        const sources = model.names
          .map((name) => ({
            name,
            value: model.enchantCoefficients[enchant][name],
            lift: (model.enchantLift[name].find((entry) => entry.enchant === enchant) || {}).lift,
          }))
          .filter((entry) => entry.value > 0.05)
          .sort((first, second) => second.value - first.value)
          .slice(0, 4)
          .map(
            (entry) =>
              `${escapeHtml(entry.name)} +${entry.value.toFixed(1)}/個${entry.lift === undefined ? '' : `（出現率 ${entry.lift > 0 ? '+' : ''}${Math.round(entry.lift * 100)}%）`}`
          )
          .join('、');
        return `<div style="margin:2px 0"><b style="color:#c4b5fd">${escapeHtml(enchant)}</b>（${count} 件有）：${sources || '看不出跟哪個材料有關'}</div>`;
      })
      .join('');
    const fit = REGRESSION_FIELDS.map(([field, label]) => `${label} ${model.fit[field] === null ? '-' : Math.round(model.fit[field] * 100) + '%'}`).join('・');
    return `<div class="hint">${escapeHtml(model.type)}：${model.sampleCount} 件、${model.names.length} 種材料。數字＝其他材料不變時，<b>多放 1 個</b>平均增減多少（普通品質）；淡色＝用過不到 ${REGRESSION_MIN_USES} 件或誤差比數值大，還看不準</div>
      ${model.sampleCount < (model.names.length + 1) * 2 ? `<div class="hint" style="color:#f59e0b">樣本還少（建議至少材料種類的 2 倍，也就是 ${(model.names.length + 1) * 2} 件），配方越多樣越準</div>` : ''}
      <table class="combat"><tr><th>材料</th><th>件</th>${REGRESSION_FIELDS.map(([, label]) => `<th>${label}</th>`).join('')}</tr>${baseRow}${rows}</table>
      <div class="hint">解釋力（這些材料能說明多少差異）：${fit}。屬性受名稱、鍛造師、運氣影響很大，只當大概的方向</div>
      <div class="subhead">附魔的必要材料（全部類型合計）</div>
      <div style="font-size:12px">${enchantRequirementsHtml()}</div>
      <div class="hint">必要材料＝出過這個附魔的裝備全都有放；出現％＝放了這個材料的裝備有幾成出現這個附魔。<br>不帶附魔＝沒搭配任何附魔來源材料時放過這麼多件，一次都沒出附魔（附魔有機率，件數越多越可信）</div>
      <div class="subhead">附魔可能來自哪些材料（這個類型，扣除其他材料）</div>
      <div style="font-size:12px">${enchantSection || '<span class="hint">這個類型還沒出現過附魔</span>'}</div>
      <div class="hint">「+數字/個」＝其他材料不變時，多放 1 個平均多多少附魔值；出現率＝有放這個材料時比沒放時多／少多少</div>`;
  }

  // 材料屬性傾向：每種裝備類型各解一次材料貢獻，換成「佔該類型平均值的百分比」（盔甲和武器的數值差很多，這樣才能放在一起比），
  // 再依用過的件數跨類型平均，看得出某個材料偏攻擊、偏防禦還是偏輕量；不用先選類型
  const TENDENCY_LABELS = { atk: '偏攻擊', def: '偏防禦', int: '偏智力', lck: '偏幸運', fullDur: '偏耐久', wgt: '偏輕' };
  // 雜訊會讓每個材料每項都有一點點正值；至少要這麼多、而且是誤差的兩倍以上才算真的有傾向
  const TENDENCY_MIN_PERCENT = 1;

  function isClearTendency(value, error) {
    return value >= TENDENCY_MIN_PERCENT && value > error * 2;
  }

  function materialTendencies(weights, forger) {
    const types = [...new Set([...forgedRecords().values()].map((item) => item.type).filter(Boolean))];
    const byMaterial = new Map();
    types.forEach((type) => {
      const model = materialRegression(type, weights, forger);
      if (!model) return;
      model.names.forEach((name) => {
        const uses = model.uses[name];
        if (uses < REGRESSION_MIN_USES) return;
        const entry = byMaterial.get(name) || { name, uses: 0, types: [], weighted: {}, errors: {}, weights: {} };
        entry.uses += uses;
        entry.types.push(type);
        REGRESSION_FIELDS.forEach(([field]) => {
          const mean = Math.abs(model.means[field]);
          if (!mean) return;
          entry.weighted[field] = (entry.weighted[field] || 0) + ((model.coefficients[field][name] / mean) * 100) * uses;
          entry.errors[field] = (entry.errors[field] || 0) + (((model.errors[field][name] / mean) * 100) * uses) ** 2;
          entry.weights[field] = (entry.weights[field] || 0) + uses;
        });
        byMaterial.set(name, entry);
      });
    });
    // 附魔：全部類型一起看，有放這個材料時比沒放時出現率高多少
    const samples = [...forgedRecords().values()].filter((equipment) => Array.isArray(equipment.materials) && (!forger || equipment.forger === forger));
    const enchantNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.enchantments || {})))];
    return [...byMaterial.values()].map((entry) => {
      const percent = {};
      const error = {};
      REGRESSION_FIELDS.forEach(([field]) => {
        const weight = entry.weights[field];
        percent[field] = weight ? entry.weighted[field] / weight : 0;
        error[field] = weight ? Math.sqrt(entry.errors[field]) / weight : 0;
      });
      const has = (sample) => sample.materials.some(([material]) => material === entry.name);
      const withMaterial = samples.filter(has);
      const without = samples.filter((sample) => !has(sample));
      const rate = (group, enchant) => (group.length ? group.filter((sample) => sample.enchantments && enchant in sample.enchantments).length / group.length : 0);
      const enchants = enchantNames
        .map((enchant) => ({ enchant, rate: rate(withMaterial, enchant), lift: rate(withMaterial, enchant) - rate(without, enchant) }))
        .filter(({ lift }) => lift >= 0.1)
        .sort((first, second) => second.lift - first.lift);
      // 傾向：比誤差大的正向屬性裡最大的；重量是越輕越好，用負值算
      const leaning = REGRESSION_FIELDS.map(([field]) => [field, field === 'wgt' ? -percent[field] : percent[field], error[field]])
        .filter(([, value, fieldError]) => isClearTendency(value, fieldError))
        .sort(([, first], [, second]) => second - first)
        .slice(0, 2)
        .map(([field]) => TENDENCY_LABELS[field]);
      return { name: entry.name, uses: entry.uses, types: entry.types, percent, error, enchants, leaning };
    });
  }

  function tendencyCardHtml(item, maxAbs) {
    const bars = MATERIAL_BAR_FIELDS.map(([field, label]) => {
      const value = item.percent[field];
      const good = field === 'wgt' ? value < 0 : value > 0;
      const width = Math.min(50, (Math.abs(value) / maxAbs[field]) * 50);
      const unsure = Math.abs(value) < item.error[field];
      return `<div style="display:flex;align-items:center;gap:4px;height:14px;opacity:${unsure ? 0.45 : 1}" title="±${item.error[field].toFixed(1)}%">
        <span style="width:14px;color:#a0a0aa">${label}</span>
        <div style="flex:1;height:8px;background:#26262b;border-radius:4px;position:relative;overflow:hidden">
          <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#55555c"></div>
          <div style="position:absolute;top:0;bottom:0;${value >= 0 ? 'left:50%' : `left:${50 - width}%`};width:${width}%;background:${good ? '#4ade80' : '#f87171'}"></div></div>
        <span style="width:48px;text-align:right;font-variant-numeric:tabular-nums;color:${good ? '#4ade80' : '#f87171'}">${value >= 0 ? '+' : ''}${value.toFixed(1)}%</span></div>`;
    }).join('');
    const enchants = item.enchants
      .slice(0, 4)
      .map(
        ({ enchant, rate, lift }) =>
          `<span style="display:inline-block;margin:1px 2px 0 0;padding:0 6px;border-radius:9px;background:#3b2f5c;color:#ddd6fe" title="有放時出現 ${Math.round(rate * 100)}%">${escapeHtml(enchant)} +${Math.round(lift * 100)}%</span>`
      )
      .join('');
    return `<div style="border:1px solid #2e2e34;border-radius:8px;padding:6px;margin:4px 0;background:#1c1c21">
      <div style="display:flex;gap:6px;align-items:baseline"><b style="flex:1;min-width:0;word-break:break-all">${escapeHtml(item.name)}</b>
        ${item.leaning.map((label) => `<span style="padding:0 6px;border-radius:9px;background:#14532d;color:#bbf7d0;font-size:11px">${label}</span>`).join('')}
        <span style="color:#a0a0aa;white-space:nowrap">${item.uses} 件</span></div>
      <div style="font-size:11px;color:#a0a0aa;margin:2px 0 3px">${escapeHtml(item.types.join('、'))}</div>
      ${bars}
      <div style="font-size:11px;margin-top:2px">${enchants || '<span style="color:#666">看不出跟哪個附魔有關</span>'}</div>
    </div>`;
  }

  function tendencyHtml(items, sortKey, filter) {
    if (!items.length) return `<div class="hint">還沒有足夠的資料：每個材料至少要在同一類型用過 ${REGRESSION_MIN_USES} 件才算得出來</div>`;
    const sortField = REGRESSION_FIELDS.some(([field]) => field === sortKey) ? sortKey : null;
    const score = (item, field) => (field === 'wgt' ? -item.percent[field] : item.percent[field]);
    const maxAbs = Object.fromEntries(MATERIAL_BAR_FIELDS.map(([field]) => [field, Math.max(1, ...items.map((item) => Math.abs(item.percent[field])))]));
    // 各屬性推薦：只挑比誤差大的（看得出正向的）
    const picks = MATERIAL_BAR_FIELDS.map(([field, label, color]) => {
      const best = items
        .filter((item) => isClearTendency(score(item, field), item.error[field]))
        .sort((first, second) => score(second, field) - score(first, field))
        .slice(0, 3)
        .map((item) => `${escapeHtml(item.name)} ${field === 'wgt' ? '-' : '+'}${Math.abs(item.percent[field]).toFixed(1)}%`)
        .join('、');
      return `<div style="margin:1px 0"><b style="color:${color}">${field === 'wgt' ? '輕量' : label}</b>：${best || '<span style="color:#666">還看不出來</span>'}</div>`;
    }).join('');
    const shown = items
      .filter((item) => !filter || item.name.includes(filter))
      .sort((first, second) => (sortField ? score(second, sortField) - score(first, sortField) : second.uses - first.uses));
    return {
      header: `<div class="hint">數字＝其他材料不變時，<b>多放 1 個</b>大約增減該類型平均值的幾 %（換成普通品質、跨類型依件數平均）；淡色＝誤差比數值大，還看不準</div>
        <div class="subhead">各屬性推薦材料</div><div style="font-size:12px">${picks}</div>
        <div class="hint">屬性受名稱、鍛造師、運氣影響很大，只當大概的方向；材料用得越多樣、件數越多越準</div>`,
      cards: shown.map((item) => tendencyCardHtml(item, maxAbs)).join(''),
    };
  }

  function renderMaterialSummary() {
    const mode = panel.querySelector('[data-role="material-mode"]').value;
    const typeSelect = panel.querySelector('[data-role="material-type"]');
    const types = [...new Set([...forgedRecords().values()].map((item) => item.type).filter(Boolean))];
    const previousType = typeSelect.value;
    typeSelect.innerHTML = `<option value="">全部類型</option>${types.map((type) => `<option>${escapeHtml(type)}</option>`).join('')}`;
    if (types.includes(previousType)) typeSelect.value = previousType;
    const forgerSelect = panel.querySelector('[data-role="material-forger"]');
    fillForgerSelect(forgerSelect);
    const nameAdjust = readSettingsFromPanel().materialNameAdjust;
    // 傾向看全部類型，類型選單用不到
    typeSelect.style.display = mode === 'tendency' ? 'none' : '';
    if (mode === 'tendency') {
      const box = panel.querySelector('[data-role="material-summary"]');
      const result = tendencyHtml(
        materialTendencies(nameAdjust ? loadNameWeights() || { days: {} } : null, forgerSelect.value),
        panel.querySelector('[data-role="material-sort"]').value,
        panel.querySelector('[data-role="material-filter"]').value.trim()
      );
      if (typeof result === 'string') {
        box.innerHTML = result;
        lastMaterialCards = { html: `<div style="grid-column:1/-1">${result}</div>`, title: '材料屬性傾向' };
        return;
      }
      box.innerHTML = result.header + result.cards;
      lastMaterialCards = { html: `<div style="grid-column:1/-1">${result.header}</div>${result.cards}`, title: `材料屬性傾向${forgerSelect.value ? `・${forgerSelect.value}` : ''}` };
      return;
    }
    if (mode === 'enchant') {
      const html = enchantPlannerHtml(typeSelect.value, forgerSelect.value);
      panel.querySelector('[data-role="material-summary"]').innerHTML = html;
      lastMaterialCards = { html: `<div style="grid-column:1/-1">${html}</div>`, title: `附魔推測：${typeSelect.value || '全部類型'}` };
      return;
    }
    if (mode === 'regression') {
      const box = panel.querySelector('[data-role="material-summary"]');
      const model = materialRegression(typeSelect.value, nameAdjust ? loadNameWeights() || { days: {} } : null, forgerSelect.value);
      const html = !typeSelect.value
        ? `<div class="subhead">附魔的必要材料（全部類型合計）</div>
          <div style="font-size:12px">${enchantRequirementsHtml()}</div>
          <div class="hint">必要材料＝出過這個附魔的裝備全都有放；出現％＝放了這個材料的裝備有幾成出現這個附魔</div>
          <div class="hint" style="margin-top:6px">想看各材料對攻、防等屬性的影響，請在上面選裝備類型（盔甲和武器的數值差太多，要分開算）</div>`
        : model
          ? regressionHtml(model, panel.querySelector('[data-role="material-sort"]').value, panel.querySelector('[data-role="material-filter"]').value.trim())
          : `<div class="hint">這個類型還沒有${nameAdjust ? '對得到測名表的' : ''}材料紀錄</div>`;
      box.innerHTML = html;
      lastMaterialCards = { html: `<div style="grid-column:1/-1">${html}</div>`, title: `材料貢獻：${typeSelect.value || '未選類型'}` };
      return;
    }
    const { summaries, matched, fromCloud, unmatchedNames } = materialSummaries(
      mode,
      typeSelect.value,
      forgerSelect.value,
      nameAdjust ? loadNameWeights() || { days: {} } : null
    );
    const nameNote = nameAdjust ? `<div class="hint">已扣掉名稱影響；另有 ${unmatchedNames} 件對不到測名表（名稱當天沒人測過）沒算進來</div>` : '';
    const box = panel.querySelector('[data-role="material-summary"]');
    if (!summaries.length) {
      lastMaterialCards = { html: '', title: '材料統計' };
      box.innerHTML =
        nameAdjust && unmatchedNames
          ? `<div class="hint">${unmatchedNames} 件裝備都對不到測名表（名稱當天沒人測過，或測名表還沒讀到）；取消勾選「扣掉名稱影響」可以看全部</div>`
          : readForgeMaterials().size
            ? '<div class="hint">有材料紀錄，但還沒有對應的裝備數值：到遊戲「物品」頁或按「讀取裝備並統計」</div>'
            : '<div class="hint">還沒有鍛造材料紀錄：之後在這個瀏覽器鍛造就會自動記</div>';
      return;
    }
    const filter = panel.querySelector('[data-role="material-filter"]').value.trim();
    const sortKey = panel.querySelector('[data-role="material-sort"]').value;
    const shown = summaries
      .filter((summary) => !filter || summary.key.includes(filter))
      .sort((first, second) => MATERIAL_SORTS[sortKey](second) - MATERIAL_SORTS[sortKey](first));
    const cards = materialCardsHtml(shown);
    lastMaterialCards = {
      html: cards,
      title: `材料統計：${typeSelect.value || '全部類型'}・${mode === 'combo' ? '材料組合' : '單一材料'}${forgerSelect.value ? `・${forgerSelect.value}` : ''}（${shown.length} 組）`,
    };
    box.innerHTML =
      `<div class="hint">共 ${matched} 件有材料紀錄的裝備${fromCloud ? `（其中 ${fromCloud} 件來自雲端）` : ''}；長條跟目前列出的最高值比（重量是最輕的最長）</div>` +
      '<div class="hint">數值換成「普通」品質的基本值平均（扣掉強化）；孔數、回收價是原值</div>' +
      nameNote +
      (cards ||
        (nameAdjust && !matched && unmatchedNames
          ? '<div class="hint">全部都對不到測名表（名稱當天沒人測過，或測名表還沒讀到）；取消勾選「扣掉名稱影響」可以看全部</div>'
          : '<div class="hint">沒有符合的材料</div>'));
  }

  async function refreshMaterialSummary() {
    try {
      const equipments = (await requestGameApi(EQUIPMENTS_API)).equipments || [];
      matchPendingForges(equipments);
      rememberForgedEquipments(equipments);
    } catch (error) {
      setStatus(`讀取裝備清單失敗（${error.message}）`);
    }
    renderMaterialSummary();
    renderRecipes();
  }

  // 雲端（Google 試算表 Apps Script）：跟朋友共用成長值與材料紀錄。
  // 上傳只送自己的、還沒送過的；下載照列號接著抓，只抓新的；重複的由試算表那端擋
  const CLOUD_SYNC_MILLISECONDS = 10 * 60000;
  // 大家共用的試算表；面板填了別的網址就改用那個
  // 推到 GitHub 公開版時這行會清空，網址改由私下傳給朋友的載入器提供（window.__autoClickerCloudUrl）
  const BUILT_IN_CLOUD_URL = '';
  const DEFAULT_CLOUD_URL = BUILT_IN_CLOUD_URL || window.__autoClickerCloudUrl || '';
  const CLOUD_STATE_KEY = 'autoClickerV2Cloud';
  const CLOUD_BATCH_ROWS = 1000;
  // 要跟 cloud-sheet.gs 的 PAGE_ROWS 一樣
  const CLOUD_PAGE_ROWS = 3000;
  const cloudSync = {
    // 開頁面 30 秒後第一次同步，不要跟遊戲載入搶
    at: Date.now() - CLOUD_SYNC_MILLISECONDS + 30000,
    running: false,
  };

  function setCloudStatus(text) {
    panel.querySelector('[data-role="cloud-status"]').textContent = text;
  }

  // 換了試算表網址就從頭傳、從頭抓
  function loadCloudState(url) {
    const saved = readJsonStorage(CLOUD_STATE_KEY, null);
    const fresh = { url, sentGrowth: [], sentEquipments: [], growthRow: 0, equipmentRow: 0 };
    // 舊的同步紀錄沒有地圖這兩欄，補上就好，不用整個重來
    return saved && saved.url === url ? { sentPlaces: [], placeRow: 0, ...saved } : { ...fresh, sentPlaces: [], placeRow: 0 };
  }

  function saveCloudState(saved) {
    try {
      localStorage.setItem(CLOUD_STATE_KEY, JSON.stringify(saved));
    } catch {
      // 存不進去頂多下次重傳，試算表那端會擋重複
    }
  }

  function cloudGrowthRows() {
    const rows = [];
    Object.entries(growthTracker.exportShare({ ownOnly: true }).heroes).forEach(([heroId, { meta, history }]) => {
      const info = meta || {};
      history.forEach((rec) => {
        if (rec.legacy) return;
        rows.push([
          `${heroId}:${rec.from}-${rec.to}`, heroId, info.name || '', info.type || '', info.typeId || '', info.tier || '', info.potential || '',
          rec.from, rec.to, rec.place || '', rec.t || 0, JSON.stringify(rec.d),
        ]);
      });
    });
    return rows;
  }

  // 只傳自己鍛造、有材料紀錄的；別人的是從雲端下載來的，不再傳回去
  function cloudEquipmentRows() {
    const own = readJsonStorage(FORGED_EQUIPMENTS_KEY, {});
    const rows = [];
    readForgeMaterials().forEach((materials, id) => {
      const item = own[id];
      if (!item) return;
      rows.push([
        Number(id), item.type, item.quality, item.atk, item.def, item.int, item.lck, item.wgt, item.fullDur, item.fullSlots, item.recyclePrice,
        JSON.stringify(item.enchantments || null), JSON.stringify(materials), item.forger || '', item.craftedTime || '', item.name || '',
      ]);
    });
    return rows;
  }

  function parseJsonCell(text, fallback) {
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  // 試算表的列：key, heroId, name, type, typeId, tier, potential, from, to, place, time, diff, contributor
  function importCloudGrowth(rows) {
    const heroes = {};
    rows.forEach(([, heroId, name, type, typeId, tier, potential, from, to, place, time, diff]) => {
      const id = String(heroId);
      if (!heroes[id]) heroes[id] = { meta: { name: String(name), type: String(type), typeId: String(typeId), tier: String(tier), potential: String(potential) }, history: [] };
      heroes[id].history.push({ from: Number(from), to: Number(to), t: Number(time) || 0, d: parseJsonCell(diff, {}), place: String(place) });
    });
    return Object.keys(heroes).length ? growthTracker.importShare({ format: 'swordgale-growth', version: 1, heroes }).added : 0;
  }

  // 試算表的列：equipmentId, type, quality, atk, def, int, lck, wgt, fullDur, fullSlots, recyclePrice, enchantments, materials, forger, craftedTime, name, contributor
  function importCloudEquipments(rows) {
    if (!rows.length) return 0;
    const saved = readJsonStorage(CLOUD_EQUIPMENTS_KEY, {});
    // 自己傳上去的會再被抓回來，本機已經有了就不用存
    const own = readForgeMaterials();
    let added = 0;
    rows.forEach(([id, type, quality, atk, def, int, lck, wgt, fullDur, fullSlots, recyclePrice, enchantments, materials, forger, craftedTime, name, contributor]) => {
      const parsedMaterials = parseJsonCell(materials, null);
      if (!Array.isArray(parsedMaterials) || saved[id] || own.has(String(id))) return;
      const numbers = { atk, def, int, lck, wgt, fullDur, fullSlots, recyclePrice };
      Object.keys(numbers).forEach((field) => (numbers[field] = Number(numbers[field]) || 0));
      saved[id] = {
        type: String(type), quality: String(quality), ...numbers,
        enchantments: parseJsonCell(enchantments, null),
        materials: parsedMaterials.map(([name, quantity]) => [String(name), Number(quantity) || 0]),
        forger: String(forger), craftedTime: String(craftedTime), name: String(name), contributor: String(contributor),
      };
      added++;
    });
    try {
      localStorage.setItem(CLOUD_EQUIPMENTS_KEY, JSON.stringify(saved));
    } catch {
      // 存不進去只影響材料統計
    }
    return added;
  }

  // 試算表的列：key, kind, zone, name, fromZone, fromStage, toZone, toStage, path
  function cloudPlaceRows() {
    const places = loadPlaces();
    return [
      ...Object.entries(places.zones).map(([zone, name]) => [`zone:${zone}`, 'zone', Number(zone), name, '', '', '', '', '']),
      ...Object.entries(places.forks).map(([branch, fork]) => [`fork:${branch}:${fork.parent}:${fork.stage}`, 'fork', Number(branch), '', fork.parent, fork.stage, '', '', '']),
    ];
  }

  // 自己學到的優先，雲端只補還不知道的
  function importCloudPlaces(rows) {
    if (!rows.length) return 0;
    const places = loadPlaces();
    let added = 0;
    rows.forEach(([, kind, zone, name, from, fromStage]) => {
      if (kind === 'zone' && name !== '' && places.zones[zone] === undefined && !Object.values(places.zones).includes(String(name))) {
        places.zones[Number(zone)] = String(name);
        added++;
      }
      if (kind === 'fork' && zone !== '' && !places.forks[zone]) {
        places.forks[Number(zone)] = { parent: Number(from), stage: Number(fromStage) || 0 };
        added++;
      }
    });
    if (added) {
      savePlaces(places);
      addLearnedAreas(places);
    }
    return added;
  }

  async function cloudRequest(url, options = {}) {
    // 字串 body 預設是 text/plain，瀏覽器不會先送 OPTIONS，Apps Script 也不支援 OPTIONS
    const response = await window.fetch(url, { ...options, cache: 'no-store', redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = parseJsonCell(await response.text(), null);
    if (!data) throw new Error('回應不是資料，確認部署時「誰可以存取」選的是「所有人」');
    if (data.ok === false) throw new Error(data.error);
    return data;
  }

  async function syncCloud(settings) {
    if (!settings.cloudSyncEnabled || cloudSync.running) return;
    if (Date.now() - cloudSync.at < CLOUD_SYNC_MILLISECONDS) return;
    cloudSync.running = true;
    cloudSync.at = Date.now();
    try {
      const url = settings.cloudUrl || DEFAULT_CLOUD_URL;
      if (!/^https:\/\/script\.google\.com\//.test(url)) throw new Error('網址要是 https://script.google.com/ 開頭的 Apps Script 網址');
      const saved = loadCloudState(url);
      const sentGrowth = new Set(saved.sentGrowth);
      const sentEquipments = new Set(saved.sentEquipments.map(String));
      const growth = cloudGrowthRows().filter((row) => !sentGrowth.has(row[0]));
      const equipment = cloudEquipmentRows().filter((row) => !sentEquipments.has(String(row[0])));
      const sentPlaces = new Set(saved.sentPlaces);
      const places = cloudPlaceRows().filter((row) => !sentPlaces.has(row[0]));
      let uploaded = 0;
      for (let start = 0; start < Math.max(growth.length, equipment.length, places.length); start += CLOUD_BATCH_ROWS) {
        const growthBatch = growth.slice(start, start + CLOUD_BATCH_ROWS);
        const equipmentBatch = equipment.slice(start, start + CLOUD_BATCH_ROWS);
        const placeBatch = places.slice(start, start + CLOUD_BATCH_ROWS);
        const result = await cloudRequest(url, {
          method: 'POST',
          body: JSON.stringify({ contributor: settings.cloudName || '未署名', growth: growthBatch, equipment: equipmentBatch, places: placeBatch }),
        });
        uploaded += (result.added.growth || 0) + (result.added.equipment || 0) + (result.added.places || 0);
        growthBatch.forEach((row) => sentGrowth.add(row[0]));
        equipmentBatch.forEach((row) => sentEquipments.add(String(row[0])));
        // 舊版試算表沒有地圖分頁（回應裡沒有 places），先不記成已傳，更新試算表後會補傳
        if (result.added.places !== undefined) placeBatch.forEach((row) => sentPlaces.add(row[0]));
        saved.sentGrowth = [...sentGrowth];
        saved.sentEquipments = [...sentEquipments];
        saved.sentPlaces = [...sentPlaces];
        saveCloudState(saved);
      }
      let downloaded = 0;
      for (;;) {
        const page = await cloudRequest(`${url}?after_growth=${saved.growthRow}&after_equipment=${saved.equipmentRow}&after_places=${saved.placeRow}`);
        const placePage = page.places || { rows: [], next: saved.placeRow };
        downloaded += importCloudGrowth(page.growth.rows) + importCloudEquipments(page.equipment.rows) + importCloudPlaces(placePage.rows);
        saved.growthRow = page.growth.next;
        saved.equipmentRow = page.equipment.next;
        saved.placeRow = placePage.next;
        saveCloudState(saved);
        if (page.growth.rows.length < CLOUD_PAGE_ROWS && page.equipment.rows.length < CLOUD_PAGE_ROWS && placePage.rows.length < CLOUD_PAGE_ROWS) break;
      }
      const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
      setCloudStatus(`上次同步 ${time}：上傳 ${uploaded} 筆、下載新增 ${downloaded} 筆；雲端共 ${saved.growthRow} 筆升級、${saved.equipmentRow} 件裝備、${saved.placeRow} 筆地圖`);
      if (downloaded && activeTab === 'growth') renderGrowthSummary();
      if (downloaded && activeTab === 'material') renderMaterialSummary();
    } catch (error) {
      setCloudStatus(`雲端同步失敗（${error.message}）`);
    } finally {
      cloudSync.running = false;
    }
  }

  // 配方用勾的：材料庫存一列一個，勾了就算進配方，跟「配方」文字欄雙向同步；順便看剩多少、夠鍛幾爐
  let mineStock = [];
  let mineStockAt = 0;
  // 庫存超過這麼久，切到鍛造、配方頁時重讀一次（中間可能去拍賣買了材料）
  const MINE_STOCK_FRESH_MILLISECONDS = 60000;

  function setMineStock(items) {
    mineStock = (items.mines || []).map((mine) => ({
      id: mine.id,
      name: mine.name || itemName(mine.id),
      have: Number(mine.available ?? mine.quantity) || 0,
    }));
    mineStockAt = Date.now();
  }

  async function refreshMineStock() {
    const items = await requestGameApi(ITEMS_API);
    rememberItemNames(items);
    setMineStock(items);
    return mineStock;
  }

  function parseRecipeLoosely(text) {
    try {
      return parseRecipe(text);
    } catch {
      return [];
    }
  }

  // 每種材料各夠用幾次，取最少的
  function forgesPossible(recipe, stock) {
    if (!recipe.length) return 0;
    const have = new Map(stock.map((mine) => [mine.name, mine.have]));
    return Math.min(...recipe.map(([name, quantity]) => Math.floor((have.get(name) || 0) / quantity)));
  }

  function renderRecipePicker() {
    const settings = readSettingsFromPanel();
    const recipe = parseRecipeLoosely(settings.forgeRecipe);
    const chosen = new Map(recipe);
    const filter = panel.querySelector('[data-role="recipe-filter"]').value.trim();
    // 配方裡有、庫存沒有的也列出來（剩 0），才看得出缺什麼；配方裡的材料不受篩選影響，取消勾選時才不會漏掉
    const stock = [...mineStock];
    recipe.forEach(([name]) => {
      if (!stock.some((mine) => mine.name === name)) stock.push({ name, have: 0 });
    });
    const rows = stock
      .filter((mine) => chosen.has(mine.name) || !filter || mine.name.includes(filter))
      .sort((first, second) => Number(chosen.has(second.name)) - Number(chosen.has(first.name)) || second.have - first.have)
      .map((mine) => {
        const quantity = chosen.get(mine.name);
        const short = quantity > mine.have;
        return `<div class="row" style="margin:1px 0"><label style="flex:1;min-width:0"><input type="checkbox" data-recipe-mine="${escapeHtml(mine.name)}" ${quantity ? 'checked' : ''} style="width:auto;flex:none">
          ${escapeHtml(mine.name)} <span style="color:${short ? '#ef4444' : '#a0a0aa'}">剩 ${mine.have}</span></label>
          <input type="number" min="1" data-recipe-qty="${escapeHtml(mine.name)}" value="${quantity || 1}" style="flex:none;width:44px"></div>`;
      })
      .join('');
    panel.querySelector('[data-role="recipe-picker"]').innerHTML =
      rows || `<div class="hint">${mineStock.length ? '沒有符合的材料' : '按「讀取材料庫存」列出你有的材料'}</div>`;
    const total = recipe.reduce((sum, [, quantity]) => sum + quantity, 0);
    const cap = MATERIAL_CAPS[settings.forgeRecipeType];
    const possible = mineStock.length && recipe.length ? forgesPossible(recipe, stock) : null;
    panel.querySelector('[data-role="recipe-total"]').innerHTML =
      `已選 <b style="color:${total > cap ? '#ef4444' : '#fff'}">${total}</b>／上限 ${cap}` +
      (possible === null ? '' : `，材料夠鍛 <b style="color:${possible ? '#22c55e' : '#ef4444'}">${possible}</b> 爐`) +
      recipePredictionText(settings, recipe);
  }

  function recipePredictionText(settings, recipe) {
    const model = materialRegression(settings.forgeRecipeType, settings.recipeNameAdjust ? loadNameWeights() || { days: {} } : null);
    const predicted = model && model.sampleCount >= 5 ? predictRecipe(model, recipe) : null;
    if (!predicted) return '';
    return `<div class="hint" style="margin:2px 0 0">預估（普通品質、依 ${model.sampleCount} 件資料）：${REGRESSION_FIELDS.map(([field, label]) => `${label} ${Math.round(predicted[field])}`).join('・')}</div>`;
  }

  // 勾選清單一律列出配方裡的材料，所以直接用勾選結果覆蓋配方
  function updateRecipeFromPicker() {
    const parts = [...panel.querySelectorAll('[data-recipe-mine]')]
      .filter((input) => input.checked)
      .map((input) => {
        const name = input.dataset.recipeMine;
        const quantityInput = [...panel.querySelectorAll('[data-recipe-qty]')].find((candidate) => candidate.dataset.recipeQty === name);
        return `${name}×${Math.max(1, Number(quantityInput.value) || 1)}`;
      });
    setPanelField('forgeRecipe', parts.join('、'));
  }

  // 配方頁編好的類型與配方存成這個角色的自動鍛造配方，並把他排進佇列
  function queueHeroForForge(heroId) {
    const settings = readSettingsFromPanel();
    if (!parseRecipeLoosely(settings.forgeRecipe).length) {
      setStatus('配方是空的，先在「② 配方」勾材料');
      return;
    }
    const plans = forgeByApiPlans(settings);
    plans[heroId] = { ...(plans[heroId] || {}), type: settings.forgeRecipeType, recipe: settings.forgeRecipe };
    setPanelField('forgeByApiPlans', JSON.stringify(plans));
    const heroIds = forgeByApiHeroIds(settings);
    if (!heroIds.includes(heroId)) setPanelField('forgeByApiHeroIds', [...heroIds, heroId].join(','));
    afterForgeQueueChange();
    const hero = forgeHeroes.find((candidate) => candidate.id === heroId);
    setStatus(`${hero ? hero.name : `角色 ${heroId}`} 已加入鍛造佇列：${settings.forgeRecipeType} ${settings.forgeRecipe}${forgeRunner.running ? '' : '（還沒開始自動鍛造）'}`);
  }

  function unqueueHeroForForge(heroId) {
    setPanelField('forgeByApiHeroIds', forgeByApiHeroIds(readSettingsFromPanel()).filter((id) => id !== heroId).join(','));
    afterForgeQueueChange();
  }

  function afterForgeQueueChange() {
    saveSettings(readSettingsFromPanel());
    if (panel.querySelector('[data-forge-plan-hero]')) renderForgeApiHeroChoices();
    renderForgePlanOverview();
    renderRecipeHeroes();
  }

  // 遊戲的裝備詳細資料加上鍛造材料、鍛造時間、鍛造師當時數值與換成「普通」品質的基本值。
  // 詳細資料畫面沒有裝備 id，用「品質的名稱」標題加上攻擊、防禦數字對回最近讀到的裝備清單
  const latestEquipments = new Map();
  const FORGE_DETAIL_MARK = 'data-auto-clicker-forge-info';

  function rememberLatestEquipments(equipments) {
    equipments.forEach((equipment) => latestEquipments.set(equipment.id, equipment));
  }

  function detailNumber(text, label) {
    const match = new RegExp(`${label}\\s*[:：]\\s*([\\d,]+)`).exec(text);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  }

  function findDetailEquipment(root, title) {
    const match = /^(.+?)的(.+?)(?:\s*\+\s*\d+)?$/.exec(title);
    if (!match) return null;
    const [, quality, name] = match;
    // 自己加的那段不算，不然數字會讀到基本值
    const text = [...root.childNodes]
      .filter((node) => !(node.nodeType === 1 && node.hasAttribute(FORGE_DETAIL_MARK)))
      .map((node) => node.textContent)
      .join(' ');
    const atk = detailNumber(text, '攻擊');
    const def = detailNumber(text, '防禦');
    const candidates = [...latestEquipments.values()].filter((equipment) => equipment.quality === quality.trim() && equipment.name === name.trim());
    const exact = candidates.filter((equipment) => (atk === null || equipment.atk === atk) && (def === null || equipment.def === def));
    const pool = exact.length ? exact : candidates.length === 1 ? candidates : [];
    return pool.sort((first, second) => second.id - first.id)[0] || null;
  }

  function formatLocalTime(time) {
    const date = new Date(time);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function forgeDetailLines(equipment) {
    const lines = [];
    const materials = readForgeMaterials().get(String(equipment.id));
    lines.push(`鍛造材料：${materials ? materials.map(([name, quantity]) => `${name}×${quantity}`).join('、') : '沒有紀錄（裝腳本以前做的，或在別的瀏覽器鍛造的）'}`);
    if (equipment.craftedTime) lines.push(`鍛造時間：${formatLocalTime(equipment.craftedTime)}`);
    const skills = (readJsonStorage(OWN_FORGE_MATERIALS_KEY, {})[equipment.id] || {}).skills;
    if (skills) lines.push(`鍛造師當時：鍛 ${skills.forge ?? '?'}／裁 ${skills.tailor ?? '?'}／工 ${skills.craft ?? '?'}`);
    const plus = equipment.plus || {};
    const base = baseStats(
      {
        ...equipment,
        atk: equipment.atk - (plus.atk || 0),
        def: equipment.def - (plus.def || 0),
        int: equipment.int - (plus.int || 0),
        lck: equipment.lck - (plus.lck || 0),
        wgt: equipment.wgt - (plus.wgt || 0),
        fullDur: equipment.fullDur - (plus.dur || 0),
      },
      qualityMultipliers()
    );
    if (equipment.quality !== '普通') {
      lines.push(
        `換成普通品質：攻 ${Math.round(base.atk)}・防 ${Math.round(base.def)}・智 ${Math.round(base.int)}・運 ${Math.round(base.lck)}・耐 ${Math.round(base.fullDur)}・重 ${Math.round(base.wgt)}`
      );
    }
    return lines;
  }

  // 標題是「品質的名稱」；不限標籤，整段文字就是這個格式的短元素都算（取最內層那個）
  function equipmentDetailHeadings() {
    const qualityPattern = new RegExp(`^(${Object.keys(QUALITY_MULTIPLIERS).join('|')})的\\S`);
    return [...document.body.querySelectorAll('h1, h2, h3, h4, div, span, p')].filter((element) => {
      if (element.children.length > 3 || panel.contains(element) || element.closest(`[${FORGE_DETAIL_MARK}]`)) return false;
      const text = element.textContent.replace(/\s+/g, ' ').trim();
      return (
        text.length < 60 &&
        qualityPattern.test(text) &&
        ![...element.children].some((child) => child.textContent.replace(/\s+/g, ' ').trim() === text)
      );
    });
  }

  // 腳本由載入器較晚插入，常常錯過遊戲一開始讀的裝備清單；對不到就自己讀一次（最多 15 秒一次）
  let detailEquipmentsFetchedAt = 0;
  function refetchEquipmentsForDetail() {
    if (Date.now() - detailEquipmentsFetchedAt < 15000) return;
    detailEquipmentsFetchedAt = Date.now();
    requestGameApi(EQUIPMENTS_API)
      .then((data) => {
        rememberLatestEquipments(data.equipments || []);
        enhanceEquipmentDetails();
      })
      .catch(() => {});
  }

  function enhanceEquipmentDetails() {
    if (tabShutDown || !readSettingsFromPanel().forgeDetailEnabled) return;
    equipmentDetailHeadings().forEach((heading) => {
      const title = heading.textContent.replace(/\s+/g, ' ').trim();
      let root = heading.parentElement;
      for (let depth = 0; root && depth < 10 && !/攻擊/.test(root.textContent) && !/防禦/.test(root.textContent); depth++) root = root.parentElement;
      if (!root || !/攻擊/.test(root.textContent)) return;
      // 另一支工具腳本已經顯示材料就不重複
      if (root.querySelector('[data-sgo-mats], .sgo-base.forge-info')) return;
      const equipment = findDetailEquipment(root, title);
      let box = root.querySelector(`[${FORGE_DETAIL_MARK}]`);
      if (!equipment) {
        if (box) box.remove();
        refetchEquipmentsForDetail();
        return;
      }
      const lines = forgeDetailLines(equipment);
      const signature = `${equipment.id}|${lines.join('|')}`;
      if (box && box.dataset.signature === signature) return;
      if (!box) {
        box = document.createElement('div');
        box.setAttribute(FORGE_DETAIL_MARK, '');
        box.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid rgba(168,162,158,.3);color:#2dd4bf;font-size:13px;line-height:1.5;word-break:break-all';
        root.appendChild(box);
      }
      box.dataset.signature = signature;
      box.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('');
    });
  }

  // 只看遊戲畫面的變動；自己加的那塊改內容不要再觸發一次
  function installForgeDetailEnhancer() {
    let pending = null;
    new MutationObserver((mutations) => {
      const ownOnly = mutations.every((mutation) => {
        const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        return target && (target.closest(`[${FORGE_DETAIL_MARK}]`) || panel.contains(target) || target.hasAttribute(FORGE_DETAIL_MARK));
      });
      if (ownOnly || pending) return;
      pending = setTimeout(() => {
        pending = null;
        enhanceEquipmentDetails();
      }, 150);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // 社群測名表：名稱對屬性的影響每天 00:00 換，大家用便宜的短刀測出每個名稱當天各屬性是理論上限的幾 %（基準比）。
  // 用「名稱＋鍛造日期」對到當天的比例，就能把名稱造成的加減成除掉，剩下的才是材料與鍛造師的效果
  const NAME_SHEET_URL =
    'https://docs.google.com/spreadsheets/d/1AQgO3da4OrSQk6Jwpm9wUkNfI1a0OYKwDyDuf_dwhaM/export?format=csv&gid=1009041432';
  const NAME_WEIGHTS_KEY = 'autoClickerV2NameWeights';
  const NAME_SHEET_REFRESH_MILLISECONDS = 30 * 60000;
  const NAME_WEIGHT_DAYS = 60;
  // 測名表在品質後面依序是 攻 防 智 幸 重 耐 的基準比；重量的換算方式不明，不拿來調整
  const NAME_WEIGHT_FIELDS = ['atk', 'def', 'int', 'lck', 'wgt', 'fullDur'];
  const NAME_ADJUSTED_FIELDS = ['atk', 'def', 'int', 'lck', 'fullDur'];
  let nameSheetLoading = null;

  // 欄位裡可能有引號包住的逗號與換行
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') {
          cell += '"';
          index++;
        } else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ',') {
        row.push(cell);
        cell = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[index + 1] === '\n') index++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += char;
    }
    if (cell || row.length) rows.push([...row, cell]);
    return rows;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  // 本機時間的日期，00:00 換日
  function localDayKey(time) {
    const date = new Date(time);
    return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  // 測名表的日期只有「10/12  00:05」沒有年份；比現在晚兩個月以上的當成去年（跨年）
  function sheetDayKey(text, now) {
    const match = /^(\d{1,2})\/(\d{1,2})/.exec(String(text).trim());
    if (!match) return '';
    const month = Number(match[1]);
    const year = month > now.getMonth() + 3 ? now.getFullYear() - 1 : now.getFullYear();
    return `${year}-${pad2(month)}-${pad2(Number(match[2]))}`;
  }

  function percentValue(text) {
    const value = parseFloat(String(text).replace('%', ''));
    return Number.isFinite(value) && value > 0 ? value / 100 : null;
  }

  function parseNameSheet(text) {
    const rows = parseCsv(text);
    const headerIndex = rows.findIndex((row) => row.includes('鍛造日期') && row.includes('名子') && row.includes('品質'));
    if (headerIndex < 0) throw new Error('測名表格式變了，找不到「鍛造日期／名子／品質」欄');
    const header = rows[headerIndex];
    const dateColumn = header.indexOf('鍛造日期');
    const nameColumn = header.indexOf('名子');
    const qualityColumn = header.indexOf('品質');
    const multipliers = qualityMultipliers();
    const now = new Date();
    const sums = {};
    rows.slice(headerIndex + 1).forEach((row) => {
      const day = sheetDayKey(row[dateColumn], now);
      const name = String(row[nameColumn] || '').trim();
      const ratios = NAME_WEIGHT_FIELDS.map((_, offset) => percentValue(row[qualityColumn + 1 + offset]));
      if (!day || !name || ratios.some((ratio) => ratio === null)) return;
      // 品質太差的基底數字很小，比例跳動大；有普通以上的樣本就只用那些
      const good = (multipliers[row[qualityColumn]] || [0])[0] >= 1;
      const dayEntry = sums[day] || (sums[day] = {});
      const entry = dayEntry[name] || (dayEntry[name] = { good: { total: [0, 0, 0, 0, 0, 0], count: 0 }, all: { total: [0, 0, 0, 0, 0, 0], count: 0 } });
      [entry.all, ...(good ? [entry.good] : [])].forEach((bucket) => {
        ratios.forEach((ratio, index) => (bucket.total[index] += ratio));
        bucket.count++;
      });
    });
    const days = {};
    Object.keys(sums)
      .sort()
      .slice(-NAME_WEIGHT_DAYS)
      .forEach((day) => {
        days[day] = Object.fromEntries(
          Object.entries(sums[day]).map(([name, { good, all }]) => {
            const bucket = good.count ? good : all;
            return [name, { w: bucket.total.map((total) => Math.round((total / bucket.count) * 1000) / 1000), n: bucket.count, good: Boolean(good.count) }];
          })
        );
      });
    return days;
  }

  function loadNameWeights() {
    const saved = readJsonStorage(NAME_WEIGHTS_KEY, null);
    return saved && saved.days ? saved : null;
  }

  // 測名表一直有人更新，隔一段時間才重抓；同時只抓一次
  function refreshNameWeights(force = false) {
    const saved = loadNameWeights();
    if (!force && saved && Date.now() - saved.fetchedAt < NAME_SHEET_REFRESH_MILLISECONDS) return Promise.resolve(saved);
    if (!nameSheetLoading) {
      nameSheetLoading = window
        .fetch(NAME_SHEET_URL, { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then((text) => {
          const fresh = { fetchedAt: Date.now(), days: parseNameSheet(text) };
          writeJsonStorage(NAME_WEIGHTS_KEY, fresh);
          return fresh;
        })
        .finally(() => {
          nameSheetLoading = null;
        });
    }
    return nameSheetLoading;
  }

  function nameWeightFor(weights, item) {
    const entry = weights && item.name && (weights.days[localDayKey(item.craftedTime)] || {})[item.name];
    return entry ? Object.fromEntries(NAME_WEIGHT_FIELDS.map((field, index) => [field, entry.w[index]])) : null;
  }

  // weights 有給就扣掉名稱影響（除以當天該名稱的基準比）；對不到測名表的回傳 null，由呼叫的地方排除
  function adjustedBaseStats(item, multipliers, weights) {
    const base = baseStats(item, multipliers);
    if (!weights) return base;
    const weight = nameWeightFor(weights, item);
    if (!weight) return null;
    NAME_ADJUSTED_FIELDS.forEach((field) => {
      base[field] /= weight[field];
    });
    return base;
  }

  // 今天測過的名稱，依目標排序（合計＝攻防智幸平均）
  const NAME_STAT_INDEX = { 攻: 0, 防: 1, 智: 2, 幸: 3, 重: 4, 耐: 5 };

  // 「盔甲」→ ['防', '重', '攻']；沒設定就 null
  function namePriorityFor(settings, type) {
    for (const line of String(settings.forgeNamePriorities || '').split('\n')) {
      const [left, right] = line.split(/[:：]/);
      if (!right || !left.split(/[,，、\s]+/).includes(type)) continue;
      const stats = right
        .split(/[>＞,，、\s]+/)
        .map((stat) => stat.trim())
        .filter((stat) => stat in NAME_STAT_INDEX);
      if (stats.length) return stats;
    }
    return null;
  }

  // 這種裝備今天的名稱排名：照屬性順序加權（3 個屬性就是 3:2:1）
  function todayNamesForType(settings, type) {
    const stats = namePriorityFor(settings, type);
    const names = todayNames('six');
    if (!stats) return names;
    const weights = stats.map((_, index) => stats.length - index);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    return names
      .map((entry) => ({ ...entry, score: stats.reduce((sum, stat, index) => sum + weights[index] * entry.w[NAME_STAT_INDEX[stat]], 0) / totalWeight }))
      .sort((first, second) => second.score - first.score);
  }

  function todayNames(goal) {
    const weights = loadNameWeights();
    const today = weights ? weights.days[localDayKey(Date.now())] || {} : {};
    const fieldIndex = (field) => NAME_WEIGHT_FIELDS.indexOf(field);
    const score = ({ w }) => (goal === 'six' ? w.reduce((sum, value) => sum + value, 0) / w.length : goal === 'total' ? (w[0] + w[1] + w[2] + w[3]) / 4 : w[fieldIndex(goal)]);
    return Object.entries(today)
      .map(([name, entry]) => ({ name, ...entry, score: score(entry) }))
      .sort((first, second) => second.score - first.score);
  }

  function renderNameSuggestions() {
    const goal = panel.querySelector('[data-role="recipe-goal"]').value;
    const names = todayNames(goal);
    const weights = loadNameWeights();
    const percent = (value) => `${Math.round(value * 100)}`;
    // 每個角色的名稱欄共用這份清單，打字時會跳出今天測過的名稱
    panel.querySelector('#autoClickerTodayNames').innerHTML = names.map(({ name }) => `<option value="${escapeHtml(name)}">`).join('');
    panel.querySelector('[data-role="name-suggest"]').innerHTML = names.length
      ? `<table class="combat"><tr><th>今天的名稱</th><th>攻</th><th>防</th><th>智</th><th>幸</th><th>耐</th><th>次</th><th></th></tr>${names
          .slice(0, 8)
          .map(
            ({ name, w, n, good }) => `<tr style="${good ? '' : 'opacity:.6'}"><td style="white-space:normal">${escapeHtml(name)}</td>
              <td>${percent(w[0])}</td><td>${percent(w[1])}</td><td>${percent(w[2])}</td><td>${percent(w[3])}</td><td>${percent(w[5])}</td><td>${n}</td>
              <td><button data-action="name-use" data-name="${escapeHtml(name)}">用</button></td></tr>`
          )
          .join('')}</table><div class="hint">社群測名表今天各屬性是上限的幾 %，依上面選的目標排序；淡色＝只有低品質樣本，比較不準${
          weights ? `；${new Date(weights.fetchedAt).toLocaleTimeString('zh-TW', { hour12: false })} 更新` : ''
        }</div>`
      : `<div class="hint">${weights ? '測名表今天還沒有資料' : '按「更新測名表」讀取'}</div>`;
    const settings = readSettingsFromPanel();
    const stats = namePriorityFor(settings, settings.forgeRecipeType);
    const best = names.length && stats ? todayNamesForType(settings, settings.forgeRecipeType)[0] : null;
    if (best) {
      panel.querySelector('[data-role="name-suggest"]').insertAdjacentHTML(
        'afterbegin',
        `<div style="margin-bottom:4px">${escapeHtml(settings.forgeRecipeType)}（${stats.join('>')}）今天最好：<b>${escapeHtml(best.name)}</b> ${(best.score * 100).toFixed(1)}% <button data-action="name-use" data-name="${escapeHtml(best.name)}">用</button></div>`
      );
    }
  }

  // 推薦配方：同類型裝備依「材料組合」分組，用換成普通品質的基本值排名；選好的配方可以直接用 API 鍛造
  // 每種裝備類型材料總數的上限（遊戲鍛造頁寫的）
  const MATERIAL_CAPS = {
    單手劍: 16, 細劍: 14, 短刀: 11, 單手錘: 16, 盾牌: 16, 雙手劍: 22, 太刀: 20,
    雙手斧: 22, 長槍: 18, 頭盔: 10, 帽子: 10, 盔甲: 16, 大衣: 12, 項鍊: 6,
  };
  const RECIPE_GOALS = {
    total: '攻防智運合計',
    atk: '攻擊',
    def: '防禦',
    int: '智力',
    lck: '幸運',
    fullDur: '耐久',
    wgt: '重量（越輕越好）',
  };
  const RECIPE_LIMIT = 10;

  function recipeScore(base, goal) {
    if (goal === 'total') return base.atk + base.def + base.int + base.lck;
    if (goal === 'wgt') return -base.wgt;
    return base[goal];
  }

  function recommendRecipes(type, goal, forger = '', weights = null) {
    const multipliers = qualityMultipliers();
    const groups = new Map();
    forgedRecords().forEach((equipment) => {
      if (equipment.type !== type || (forger && equipment.forger !== forger)) return;
      const base = adjustedBaseStats(equipment, multipliers, weights);
      if (!base) return;
      const [key] = materialGroupKeys(equipment.materials, 'combo');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...equipment, base });
    });
    return [...groups.entries()]
      .map(([key, items]) => ({
        key,
        count: items.length,
        score: items.reduce((sum, item) => sum + recipeScore(item.base, goal), 0) / items.length,
        skills: skillsText(items),
      }))
      .sort((first, second) => second.score - first.score)
      .slice(0, RECIPE_LIMIT);
  }

  function renderRecipes() {
    const type = readSettingsFromPanel().forgeRecipeType;
    const goal = panel.querySelector('[data-role="recipe-goal"]').value;
    const forgerSelect = panel.querySelector('[data-role="recipe-forger"]');
    fillForgerSelect(forgerSelect);
    const nameAdjust = readSettingsFromPanel().recipeNameAdjust;
    const recipes = recommendRecipes(type, goal, forgerSelect.value, nameAdjust ? loadNameWeights() || { days: {} } : null);
    renderNameSuggestions();
    const scoreText = (score) => String(Math.round(goal === 'wgt' ? -score : score));
    panel.querySelector('[data-role="recipe-list"]').innerHTML = recipes.length
      ? `<table class="combat"><tr><th>配方</th><th>件</th><th>${escapeHtml(RECIPE_GOALS[goal])}</th><th title="照目前的材料庫存，夠鍛幾爐">夠</th><th></th></tr>${recipes
          .map(
            (recipe) => `<tr><td style="white-space:normal">${escapeHtml(recipe.key)}${recipe.skills ? `<div class="hint" style="margin:0">${recipe.skills}</div>` : ''}</td><td>${recipe.count}</td><td>${scoreText(recipe.score)}</td>
              <td>${recipeStockCell(recipe.key)}</td><td><button data-action="recipe-use" data-recipe="${escapeHtml(recipe.key)}">用</button></td></tr>`
          )
          .join('')}</table><div class="hint">數值是換成普通品質的平均；鍛造師的鍛造、裁縫、工藝也會影響成品，選同一個鍛造師比較準；件數少的只能參考</div>`
      : `<div class="hint">這個類型還沒有${nameAdjust ? '對得到測名表的' : ''}材料紀錄</div>`;
  }

  // 推薦配方旁邊直接看材料夠不夠：夠幾爐，不夠的話缺哪些
  function recipeStockCell(recipeText) {
    const recipe = parseRecipeLoosely(recipeText);
    if (!recipe.length || !mineStock.length) return '<span style="color:#666">?</span>';
    const have = new Map(mineStock.map((mine) => [mine.name, mine.have]));
    const short = recipe.filter(([name, quantity]) => (have.get(name) || 0) < quantity).map(([name, quantity]) => `${name} 剩 ${have.get(name) || 0}／要 ${quantity}`);
    const possible = forgesPossible(recipe, mineStock);
    return `<span style="color:${possible ? '#22c55e' : '#ef4444'}" title="${escapeHtml(short.join('\n') || '材料都夠')}">${possible ? possible : '缺'}</span>`;
  }

  // 「泥土×4、楊木×2」→ [['泥土', 4], ['楊木', 2]]
  function parseRecipe(text) {
    return String(text || '')
      .split(/[、,，\n]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const match = /^(.+?)\s*[×xX*＊]\s*(\d+)$/.exec(part);
        if (!match) throw new Error(`看不懂「${part}」，要寫成 名稱×數量`);
        return [match[1].trim(), Number(match[2])];
      });
  }

  async function forgeWithRecipe(settings, heroId) {
    try {
      await refreshForgeHeroes(true);
      const hero = forgeHeroes.find((candidate) => candidate.id === heroId);
      if (!hero) throw new Error('找不到這個角色，按「重新讀取角色」');
      if (hero.actionState) throw new Error(`${hero.name} 正在忙`);
      if (inHuntTeam(hero)) throw new Error(`${hero.name} 在狩獵隊伍裡，拿去鍛造打怪會出錯`);
      const target = await freeForgeShop(forgeHeroes);
      if (!target) throw new Error('鍛造欄位都在用（欄位數不對的話到「自動鍛造」頁改）');
      const plan = { type: settings.forgeRecipeType, recipe: settings.forgeRecipe, name: settings.forgeRecipeName };
      const { body, summary, forgesLeft } = await buildForgeRequest(plan, heroId, target);
      if (!window.confirm(`用 ${hero.name} 在第 ${target} 個鍛造欄位鍛造\n${summary}\n確定送出？`)) return;
      await sendForge(body);
      setStatus(`已開始鍛造 ${summary}${forgesLeft === null ? '' : `，材料還夠 ${forgesLeft} 爐`}`);
      refreshForgeHeroes(true).catch(() => {});
    } catch (error) {
      setStatus(`鍛造沒送出（${error.message}）`);
    }
  }

  async function freeForgeShop(heroes) {
    const count = await forgeShopCount();
    const busy = new Set(heroes.filter((hero) => hero.actionState === 5).map((hero) => Number(hero.actionTarget)));
    return Array.from({ length: count }, (_, index) => index + 1).find((shop) => !busy.has(shop)) || 0;
  }

  // 檢查配方、名稱、材料庫存，組出 POST /api/forge 要送的內容；手動鍛造和 API 自動鍛造共用
  async function buildForgeRequest(plan, heroId, target, preloadedItems = null) {
    const { type } = plan;
    const typeId = Object.keys(FORGE_TYPE_NAMES).find((id) => FORGE_TYPE_NAMES[id] === type);
    const name = String(plan.name || '').trim();
    if (!heroId) throw new Error('先選鍛造的角色');
    if (!typeId) throw new Error('請選裝備類型');
    if (!name) throw new Error('請輸入裝備名稱');
    const recipe = parseRecipe(plan.recipe);
    if (!recipe.length) throw new Error('請先填配方');
    const total = recipe.reduce((sum, [, quantity]) => sum + quantity, 0);
    if (total > MATERIAL_CAPS[type]) throw new Error(`${type}材料上限 ${MATERIAL_CAPS[type]}，配方共 ${total}`);
    // 材料要用道具 id 送，從目前的材料庫存查，順便確認數量夠
    const items = preloadedItems || (await requestGameApi(ITEMS_API));
    rememberItemNames(items);
    const mines = new Map((items.mines || []).map((mine) => [mine.name || itemName(mine.id), mine]));
    const selectedMines = recipe.map(([materialName, quantity]) => {
      const mine = mines.get(materialName);
      if (!mine) throw new Error(`材料庫存裡沒有「${materialName}」`);
      const have = mine.available ?? mine.quantity;
      if (typeof have === 'number' && have < quantity) throw new Error(`「${materialName}」只剩 ${have}，配方要 ${quantity}`);
      return { itemId: mine.id, quantity };
    });
    const forgesLeft =
      Math.min(...recipe.map(([materialName, quantity]) => Math.floor(Number(mines.get(materialName).available ?? mines.get(materialName).quantity) / quantity))) - 1;
    return {
      forgesLeft: Number.isFinite(forgesLeft) ? forgesLeft : null,
      body: { heroId, target, name, type: typeId, selectedMines },
      summary: `${type}「${name}」，材料：${recipe.map(([materialName, quantity]) => `${materialName}×${quantity}`).join('、')}（共 ${total}）`,
    };
  }

  // API 鍛造不經過遊戲的鍛造表單，表單會停在原本的樣子；送出前先照配方把表單填好，畫面才看得出這次用了什麼。
  // 送出後角色變成鍛造中，表單會被鎖住（pointer-events-none），所以一定要在送出前填
  function setReactInputValue(input, value) {
    // React 受控元件要用原生的 setter 改值再發 input 事件，直接改 value 會被 React 蓋回去
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function gameForgeForm() {
    const nameInput = document.getElementById('name');
    if (!nameInput || panel.contains(nameInput)) return null;
    const form = nameInput.closest('.grid') || nameInput.parentElement.parentElement;
    if (!form || !form.querySelector('[role="radiogroup"]') || !form.querySelector('table')) return null;
    // 選中的角色正在忙時整個表單是鎖住的，點了也沒用
    if (form.classList.contains('pointer-events-none')) return null;
    return { form, nameInput };
  }

  async function fillGameForgeForm(body) {
    const found = gameForgeForm();
    if (!found) return false;
    const { form, nameInput } = found;
    const step = () => wait(randomGap(60, 140));
    const clearButton = [...form.querySelectorAll('button')].find((button) => button.textContent.trim() === '清除所有');
    if (clearButton && !clearButton.disabled) {
      clearButton.click();
      await step();
    }
    const radio = form.querySelector(`button[role="radio"][value="${body.type}"]`);
    if (radio && radio.getAttribute('aria-checked') !== 'true') {
      radio.click();
      await step();
    }
    setReactInputValue(nameInput, body.name);
    await step();
    const rows = [...form.querySelectorAll('tbody tr')];
    for (const { itemId, quantity } of body.selectedMines) {
      const materialName = itemName(itemId);
      const row = rows.find((candidate) => candidate.cells[0] && candidate.cells[0].textContent.trim() === materialName);
      if (!row) continue;
      for (let count = 0; count < quantity; count++) {
        row.click();
        await step();
      }
    }
    return true;
  }

  // 遊戲鍛造頁一次只顯示一個鍛造坊的表單，要先切到這次用的鍛造坊才填，不然會改到別的鍛造坊。
  // 切換按鈕沿用按鈕模式選過的「鍛造坊 N 切換」；沒選過就不填
  async function switchGameForgeShop(settings, target) {
    const selector = settings[forgeKey(target - 1, 'Switch')];
    if (!selector) return false;
    const button = findButton(selector, settings[forgeKey(target - 1, 'SwitchText')], '');
    if (!button) return false;
    button.click();
    await wait(randomGap(500, 900));
    return true;
  }

  async function sendForge(body) {
    const settings = readSettingsFromPanel();
    const onForgePage = Boolean(document.getElementById('name')) && !panel.contains(document.getElementById('name'));
    if (settings.forgeFillGameForm && onForgePage && (await switchGameForgeShop(settings, body.target).catch(() => false))) {
      await fillGameForgeForm(body).catch(() => false);
    }
    const result = await requestGameApi('/api/forge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    syncGameForge(result, body.heroId);
    return result;
  }

  // 遊戲前端用 TanStack Query 快取 API 資料（角色列表 16 秒自己重抓，道具、材料不會）；
  // 腳本直接打 API 時遊戲不知道資料變了，要叫它重抓，鍛造頁的材料數量、角色狀態才會跟著變
  const FORGE_QUERY_KEYS = [['heroes'], ['items'], ['equipments']];
  // API 打怪後遊戲畫面不知道：隊伍與位置（heroes）、戰報、金錢（profile）、同地圖玩家、掉落的裝備和道具都要重抓；只會重抓畫面上正在用的
  const HUNT_QUERY_KEYS = [['heroes'], ['reports', 'hunt'], ['profile'], ['zone', 'users'], ['equipments'], ['items']];
  let gameQueryClient = null;

  // React 把根節點的 fiber 掛在容器元素的 __reactContainer$… 屬性上，往下找 QueryClientProvider 的 client
  function findGameQueryClient() {
    if (gameQueryClient) return gameQueryClient;
    for (const element of document.querySelectorAll('body > *')) {
      const containerKey = Object.keys(element).find((key) => key.startsWith('__reactContainer$'));
      if (!containerKey) continue;
      const stack = [element[containerKey]];
      for (let visited = 0; stack.length && visited < 5000; visited++) {
        const fiber = stack.pop();
        if (!fiber) continue;
        const client = fiber.memoizedProps && fiber.memoizedProps.client;
        if (client && typeof client.invalidateQueries === 'function') {
          gameQueryClient = client;
          return client;
        }
        stack.push(fiber.sibling, fiber.child);
      }
    }
    return null;
  }

  function refreshGameView(queryKeys) {
    try {
      const client = findGameQueryClient();
      if (client) {
        queryKeys.forEach((queryKey) => client.invalidateQueries({ queryKey }));
        return;
      }
    } catch {
      // 遊戲改版找不到快取就退回下面的做法
    }
    // 退路：假裝切回這個分頁，遊戲會重抓已過期的資料
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  }

  // 狩獵頁的戰報是頁面自己的 state：開頁時從 localStorage 的 huntReports（最近 5 場）讀，之後只有在遊戲裡按才會加。
  // API 打的那場照遊戲的格式寫進 huntReports，再找到頁面上那個 state 換掉，畫面才會跟著變；不在狩獵頁時下次開頁也讀得到
  const GAME_HUNT_REPORTS_KEY = 'huntReports';
  const GAME_HUNT_REPORTS_LIMIT = 5;

  function findHuntReportsQueue(previousFirstId) {
    for (const element of document.querySelectorAll('body > *')) {
      const containerKey = Object.keys(element).find((key) => key.startsWith('__reactContainer$'));
      if (!containerKey) continue;
      const stack = [element[containerKey]];
      for (let visited = 0; stack.length && visited < 5000; visited++) {
        const fiber = stack.pop();
        if (!fiber) continue;
        // 用第一場戰報的 id 認：只有狩獵頁那個 state 會剛好跟 huntReports 一樣
        for (let hook = fiber.tag === 0 ? fiber.memoizedState : null; hook; hook = hook.next) {
          const value = hook.memoizedState;
          if (hook.queue && typeof hook.queue.dispatch === 'function' && Array.isArray(value) && value[0] && Array.isArray(value[0].messages) && value[0].id === previousFirstId) {
            return hook.queue;
          }
        }
        stack.push(fiber.sibling, fiber.child);
      }
    }
    return null;
  }

  function pushHuntReportToView(report) {
    let reports = [];
    try {
      reports = JSON.parse(localStorage.getItem(GAME_HUNT_REPORTS_KEY) || '[]');
    } catch {
      // 讀不到就當沒有
    }
    const previousFirstId = reports[0] && reports[0].id;
    const next = [report, ...reports].slice(0, GAME_HUNT_REPORTS_LIMIT);
    try {
      localStorage.setItem(GAME_HUNT_REPORTS_KEY, JSON.stringify(next));
    } catch {
      // 存不了就只更新畫面
    }
    const queue = previousFirstId === undefined ? null : findHuntReportsQueue(previousFirstId);
    if (queue) queue.dispatch(next);
  }

  // 照遊戲前端每個按鈕成功後的做法更新畫面快取（從遊戲程式抄來的）：回應裡有的資料直接換上，
  // 其餘只標成過期，畫面上正在顯示的才會重抓。全部標過期的話，畫面上的每個查詢都會重抓，多出玩家自己按不會有的讀取
  function mirrorGameUpdate(fallbackKeys, update) {
    try {
      const client = findGameQueryClient();
      if (client) {
        update(client);
        return;
      }
    } catch (error) {
      console.error('更新遊戲畫面失敗', error);
    }
    refreshGameView(fallbackKeys);
  }

  function setGameHero(client, hero) {
    if (!hero || hero.id === undefined) return;
    client.cancelQueries({ queryKey: ['heroes', hero.id], exact: true });
    client.cancelQueries({ queryKey: ['heroes', 'list'], exact: true });
    client.setQueryData(['heroes', hero.id], hero);
    client.setQueryData(['heroes', 'list'], (list) => list && list.map((item) => (item.id === hero.id ? hero : item)));
  }

  function setGameHuntInfo(client, huntInfo) {
    if (!huntInfo) return;
    client.cancelQueries({ queryKey: ['heroes', 'hunt'], exact: true });
    client.setQueryData(['heroes', 'hunt'], huntInfo);
  }

  function setGameHeroList(client, heroes) {
    if (!Array.isArray(heroes)) return;
    client.cancelQueries({ queryKey: ['heroes', 'list'], exact: true });
    client.setQueryData(['heroes', 'list'], heroes);
  }

  // 移動：move/{區域}、move/complete、moveForkPath 三個按鈕
  function syncGameMove(data, kind) {
    const huntInfo = data && data.heroes ? data : data && data.huntInfo;
    mirrorGameUpdate(HUNT_QUERY_KEYS, (client) => {
      setGameHuntInfo(client, huntInfo);
      client.invalidateQueries({ queryKey: ['heroes', 'list'] });
      if (kind !== 'move') client.invalidateQueries({ queryKey: ['zone', 'users'] });
      ((huntInfo && huntInfo.heroes) || []).forEach((hero) =>
        kind === 'complete' ? client.resetQueries({ queryKey: ['heroes', hero.id], exact: true }) : client.invalidateQueries({ queryKey: ['heroes', hero.id] })
      );
    });
  }

  // 全隊休息、全隊休息完成
  function syncGameRestAll(data) {
    const huntInfo = data && data.heroes ? data : data && data.huntInfo;
    mirrorGameUpdate(HUNT_QUERY_KEYS, (client) => {
      setGameHuntInfo(client, huntInfo);
      client.invalidateQueries({ queryKey: ['heroes', 'list'] });
      ((huntInfo && huntInfo.heroes) || []).forEach((hero) => client.invalidateQueries({ queryKey: ['heroes', hero.id] }));
    });
  }

  // 開爐：回應帶全部角色和材料
  function syncGameForge(data, heroId) {
    mirrorGameUpdate(FORGE_QUERY_KEYS, (client) => {
      client.invalidateQueries({ queryKey: ['heroes', heroId] });
      setGameHeroList(client, data && data.heroes);
      if (data && (data.items || data.mines)) client.setQueryData(['items'], { items: data.items, mines: data.mines });
    });
  }

  function syncGameCompleteForge(data, heroId) {
    mirrorGameUpdate(FORGE_QUERY_KEYS, (client) => {
      client.invalidateQueries({ queryKey: ['equipments'] });
      setGameHeroList(client, data && data.heroes);
      client.resetQueries({ queryKey: ['heroes', heroId], exact: true });
    });
  }

  // 完成行動（收礦、休息完）
  function syncGameCompleteAction(data, heroId) {
    mirrorGameUpdate(FORGE_QUERY_KEYS, (client) => {
      if (data && data.actionResult && data.actionResult.action === 4) {
        client.invalidateQueries({ queryKey: ['items'] });
        client.invalidateQueries({ queryKey: ['tower'] });
      }
      setGameHero(client, data && data.hero);
      client.invalidateQueries({ queryKey: ['heroes', 'collections'] });
      client.invalidateQueries({ queryKey: ['heroes', heroId, 'statuses'] });
      client.resetQueries({ queryKey: ['heroes', 'hunt'], exact: true });
    });
  }

  // 開始挖礦、單人休息：回應就是英雄
  function syncGameHeroAction(hero, kind) {
    mirrorGameUpdate([['heroes']], (client) => {
      setGameHero(client, hero);
      if (kind === 'rest') client.resetQueries({ queryKey: ['heroes', 'hunt'], exact: true });
    });
  }

  // 用道具：回應帶道具欄和英雄
  function syncGameItemUse(data) {
    mirrorGameUpdate([['items'], ['heroes']], (client) => {
      if (data && data.items !== undefined) client.setQueryData(['items'], data.items);
      const hero = data && data.hero;
      if (!hero) return;
      setGameHero(client, hero);
      client.cancelQueries({ queryKey: ['heroes', 'hunt'], exact: true });
      client.setQueryData(['heroes', 'hunt'], (info) =>
        info && { ...info, heroes: info.heroes.map((item) => (item.id === hero.id ? { ...item, ...hero, statuses: data.heroStatuses ?? item.statuses } : item)) }
      );
      if (data.heroStatuses !== undefined) client.setQueryData(['heroes', hero.id, 'statuses'], data.heroStatuses);
    });
  }

  // 照遊戲自己按「原地掛機」後的做法更新畫面：隊伍狀態直接換成回應裡的，不另外重抓，伺服器看到的請求跟手動一樣
  function syncGameHuntView(data) {
    try {
      const client = findGameQueryClient();
      if (!client || !data) {
        refreshGameView(HUNT_QUERY_KEYS);
        return;
      }
      if (data.report) pushHuntReportToView(data.report);
      client.invalidateQueries({ queryKey: ['tower'] });
      client.cancelQueries({ queryKey: ['profile'], exact: true });
      client.setQueryData(['profile'], (profile) => profile && { ...profile, money: data.money ?? profile.money, huntCount: data.huntCount ?? profile.huntCount });
      client.invalidateQueries({ queryKey: ['heroes', 'collections'] });
      if (Array.isArray(data.equipmentChanges) && data.equipmentChanges.length) client.invalidateQueries({ queryKey: ['equipments'] });
      if (data.huntInfo) {
        const before = client.getQueryData(['heroes', 'hunt']);
        if (!before || before.huntZone !== data.huntInfo.huntZone || before.huntStage !== data.huntInfo.huntStage) {
          client.invalidateQueries({ queryKey: ['zone', 'users'] });
        }
        client.invalidateQueries({ queryKey: ['heroes', 'list'] });
        setGameHuntInfo(client, data.huntInfo);
        (data.huntInfo.heroes || []).forEach((hero) => client.invalidateQueries({ queryKey: ['heroes', hero.id] }));
      } else {
        const before = client.getQueryData(['heroes', 'hunt']);
        client.invalidateQueries({ queryKey: ['zone', 'users'] });
        client.resetQueries({ queryKey: ['heroes', 'hunt'], exact: true });
        client.invalidateQueries({ queryKey: ['heroes', 'list'] });
        ((before && before.heroes) || []).forEach((hero) => client.invalidateQueries({ queryKey: ['heroes', hero.id] }));
      }
    } catch (error) {
      console.error('更新狩獵畫面失敗', error);
      refreshGameView(HUNT_QUERY_KEYS);
    }
  }

  function forgeByApiHeroIds(settings) {
    return settings.forgeByApiHeroIds.split(',').map(Number).filter(Boolean);
  }

  function forgeByApiPlans(settings) {
    const plans = parseJsonText(settings.forgeByApiPlans);
    return plans && typeof plans === 'object' ? plans : {};
  }

  // 名稱沒填就用「配方」頁的；類型沒選過就用「配方」頁的
  function forgeApiPlan(settings, heroId) {
    const plan = forgeByApiPlans(settings)[heroId] || {};
    return {
      type: plan.type || settings.forgeRecipeType,
      recipe: plan.recipe || '',
      name: plan.name || settings.forgeRecipeName,
    };
  }

  async function showForgeApiHeroChoices() {
    forgeHeroes = (await requestGameApi(HEROES_API)).heroes || [];
    forgeHeroesAt = Date.now();
    await refreshMineStock().catch(() => {});
    renderForgeApiHeroChoices();
    renderRecipeHeroes();
  }

  function renderForgeApiHeroChoices() {
    const heroes = forgeHeroes;
    const settings = readSettingsFromPanel();
    const chosen = forgeByApiHeroIds(settings);
    const plans = forgeByApiPlans(settings);
    const fieldStyle = 'flex:1;min-width:0;padding:2px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px';
    panel.querySelector('[data-role="forge-api-heroes"]').innerHTML = heroes
      .slice()
      .sort((first, second) => (second.forge || 0) - (first.forge || 0))
      .map((hero) => {
        const plan = { type: settings.forgeRecipeType, ...(plans[hero.id] || {}) };
        return `<div data-forge-plan-hero="${hero.id}" style="border-bottom:1px solid #2e2e34;padding:3px 0">
          <label class="row"><input type="checkbox" data-forge-api-hero value="${hero.id}" ${chosen.includes(hero.id) ? 'checked' : ''} style="width:auto;flex:none">
            ${escapeHtml(hero.name)}（鍛 ${hero.forge ?? '?'}／裁 ${hero.tailor ?? '?'}／工 ${hero.craft ?? '?'}）${forgeCountText(plan.recipe)}</label>
          <div class="row"><select data-forge-plan="type" style="${fieldStyle}">${Object.keys(MATERIAL_CAPS).map((type) => `<option ${type === plan.type ? 'selected' : ''}>${type}</option>`).join('')}</select>
            <input data-forge-plan="name" list="autoClickerTodayNames" value="${escapeHtml(plan.name || '')}" placeholder="名稱（空白＝配方頁的）" style="${fieldStyle}"></div>
          <div class="row"><input data-forge-plan="recipe" value="${escapeHtml(plan.recipe || '')}" placeholder="配方，例如 泥土×4、楊木×2" style="${fieldStyle}">
            <button data-action="forge-plan-copy" data-hero="${hero.id}" title="把「配方」頁目前的類型與配方帶進來">帶入</button></div>
        </div>`;
      })
      .join('');
    renderForgePlanOverview();
  }

  // 最近一次讀到的角色（遊戲回傳的順序就是自動鍛造挑閒置角色的順序）
  let forgeHeroes = [];
  let forgeHeroesAt = 0;
  const FORGE_HEROES_FRESH_MILLISECONDS = 60000;

  // 打開配方、自動鍛造頁就讀，不用先按「讀取角色」
  async function refreshForgeHeroes(force = false) {
    if (!force && Date.now() - forgeHeroesAt < FORGE_HEROES_FRESH_MILLISECONDS) return;
    forgeHeroes = (await requestGameApi(HEROES_API)).heroes || [];
    forgeHeroesAt = Date.now();
    renderRecipeHeroes();
    renderForgePlanOverview();
  }

  function renderRecipeHeroes() {
    const box = panel.querySelector('[data-role="recipe-heroes"]');
    if (!box) return;
    if (!forgeHeroes.length) {
      box.innerHTML = '<div class="hint">讀取角色中…（沒出現就按「重新讀取角色」）</div>';
      return;
    }
    const settings = readSettingsFromPanel();
    const queued = forgeByApiHeroIds(settings);
    const plans = forgeByApiPlans(settings);
    box.innerHTML = forgeHeroes
      .slice()
      .sort((first, second) => Number(queued.includes(second.id)) - Number(queued.includes(first.id)) || (second.forge || 0) - (first.forge || 0))
      .map((hero) => {
        const inQueue = queued.includes(hero.id);
        const plan = plans[hero.id] || {};
        const sameRecipe = inQueue && plan.recipe === settings.forgeRecipe && plan.type === settings.forgeRecipeType;
        const tags = [];
        if (inQueue) tags.push(`<span style="color:#4ade80">佇列中：${escapeHtml(plan.type || settings.forgeRecipeType)} ${escapeHtml(plan.recipe || '（沒有配方）')}</span>`);
        if (inHuntTeam(hero)) tags.push('<span style="color:#f87171">狩獵隊伍（不會被拿去鍛造）</span>');
        if (hero.actionState === 5) tags.push(`<span style="color:#60a5fa">第 ${hero.actionTarget} 欄鍛造中</span>`);
        else if (hero.actionState) tags.push('<span style="color:#a0a0aa">忙別的事</span>');
        const unavailable = hero.actionState || inHuntTeam(hero);
        return `<div class="row" style="margin:0;padding:3px 0;border-bottom:1px solid #2e2e34">
          <div style="flex:1;min-width:0"><b>${escapeHtml(hero.name)}</b> <span style="color:#a0a0aa">鍛 ${hero.forge ?? '?'}／裁 ${hero.tailor ?? '?'}／工 ${hero.craft ?? '?'}</span>${tags.length ? `<div>${tags.join('・')}</div>` : ''}</div>
          ${sameRecipe ? '<span style="color:#4ade80;white-space:nowrap">✓ 用這個配方</span>' : `<button data-action="recipe-queue" data-hero="${hero.id}" style="font-weight:bold">${inQueue ? '改用這個配方' : '加入'}</button>`}
          ${inQueue ? `<button data-action="forge-unqueue" data-hero="${hero.id}">移出</button>` : ''}
          <button data-action="recipe-forge-once" data-hero="${hero.id}" ${unavailable ? 'disabled' : ''}>鍛一次</button>
        </div>`;
      })
      .join('');
  }

  // 狩獵隊伍的角色在兩次打怪之間也是「閒置」，拿去開爐的話打怪會一直回「英雄狀態錯誤」
  function inHuntTeam(hero) {
    return Boolean(hero.selected) || (state.huntTeamIds || []).includes(hero.id);
  }

  function canStartForge(hero) {
    return !hero.actionState && !inHuntTeam(hero);
  }

  function forgeHeroStatus(hero, isNext) {
    if (!hero) return ['#a0a0aa', '狀態未知（按「讀取角色」）'];
    if (hero.actionState === 5) {
      const time = Date.parse(hero.actionCompleteTime);
      if (hero.canComplete || (Number.isFinite(time) && time <= Date.now())) return ['#facc15', `第 ${hero.actionTarget} 欄・已完成待收`];
      const clock = Number.isFinite(time) ? new Date(time).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '?';
      return ['#60a5fa', `第 ${hero.actionTarget} 欄・${clock} 完成`];
    }
    if (hero.actionState) return ['#a0a0aa', '忙別的事（打怪、移動…），閒下來才鍛造'];
    if (inHuntTeam(hero)) return ['#f87171', '在狩獵隊伍裡，不會拿去鍛造（要鍛造先移出隊伍）'];
    return ['#4ade80', isNext ? '閒置・下一爐就是它' : '閒置・等鍛造欄位空出來'];
  }

  // 鍛造佇列每個角色的狀態、配方、材料夠不夠；遊戲面板和總覽頁共用
  function forgeQueueRows(settings) {
    const heroIds = forgeByApiHeroIds(settings);
    const heroById = new Map(forgeHeroes.map((hero) => [hero.id, hero]));
    const order = [...forgeHeroes.filter((hero) => heroIds.includes(hero.id)).map((hero) => hero.id), ...heroIds.filter((id) => !heroById.has(id))];
    const nextId = order.find((id) => heroById.has(id) && canStartForge(heroById.get(id)));
    const stock = new Map(mineStock.map((mine) => [mine.name, mine.have]));
    const plans = forgeByApiPlans(settings);
    return order.map((heroId) => {
      const hero = heroById.get(heroId);
      const plan = forgeApiPlan(settings, heroId);
      const recipe = parseRecipeLoosely(plan.recipe);
      const total = recipe.reduce((sum, [, quantity]) => sum + quantity, 0);
      const cap = MATERIAL_CAPS[plan.type];
      const [statusColor, statusText] = forgeHeroStatus(hero, heroId === nextId);
      const problems = [];
      if (!recipe.length) problems.push('還沒設定配方，輪到它時會暫停');
      if (!String(plan.name || '').trim()) problems.push('沒有名稱');
      if (cap && total > cap) problems.push(`材料 ${total} 超過${plan.type}上限 ${cap}`);
      return {
        heroId,
        name: hero ? hero.name : `角色 ${heroId}`,
        next: heroId === nextId,
        statusColor,
        statusText,
        type: plan.type || '',
        itemName: plan.name || '',
        ownName: Boolean((plans[heroId] || {}).name),
        materials: recipe.map(([name, quantity]) => ({ name, quantity, have: mineStock.length ? stock.get(name) || 0 : null })),
        total,
        cap: cap || 0,
        possible: recipe.length && mineStock.length ? forgesPossible(recipe, mineStock) : null,
        problems,
      };
    });
  }

  function renderForgePlanOverview() {
    const box = panel.querySelector('[data-role="forge-plan-overview"]');
    if (!box) return;
    const settings = readSettingsFromPanel();
    const shopTotal = Number(settings.forgeShopSlots) || forgeShops.count;
    const forgingCount = forgeHeroes.filter((hero) => hero.actionState === 5).length;
    const shopLine = forgeHeroesAt
      ? `<div>鍛造欄位：使用中 <b>${forgingCount}</b>／${shopTotal || '?'}${Number(settings.forgeShopSlots) ? '' : '（自動讀遊戲）'}</div>`
      : '';
    const rows = forgeQueueRows(settings);
    if (!rows.length) {
      box.innerHTML = `${shopLine}<div class="hint">佇列是空的：到「配方」頁編好配方，在「④ 給誰用」按「加入」</div>`;
      return;
    }
    box.innerHTML = shopLine + rows
      .map((row) => {
        const chips = row.materials
          .map(({ name, quantity, have }) => {
            const short = have !== null && have < quantity;
            return `<span style="display:inline-block;margin:1px 3px 1px 0;padding:0 6px;border-radius:9px;background:${short ? '#5c1d1d' : '#2a2a30'};color:${short ? '#fca5a5' : '#e5e5e5'}" title="庫存 ${have ?? '?'}">${escapeHtml(name)}×${quantity}</span>`;
          })
          .join('');
        return `<div style="border:1px solid #2e2e34;border-radius:8px;padding:5px 6px;margin:4px 0;background:${row.next ? '#16261c' : '#1c1c21'}">
          <div style="display:flex;gap:6px;align-items:baseline"><b style="white-space:nowrap">${escapeHtml(row.name)}</b>
            <span style="flex:1;text-align:right;color:${row.statusColor}">${row.statusText}</span>
            <button data-action="forge-unqueue" data-hero="${row.heroId}" style="padding:0 6px" title="移出佇列（配方會留著）">移出</button></div>
          <div style="margin:2px 0"><span style="padding:0 6px;border-radius:9px;background:#3b2f5c;color:#ddd6fe">${escapeHtml(row.type || '?')}</span>
            「<b>${escapeHtml(row.itemName)}</b>」${row.ownName ? '' : '<span style="color:#a0a0aa">（配方頁的名稱）</span>'}</div>
          <div>${chips || '<span style="color:#666">沒有配方</span>'}
            ${row.materials.length ? `<span style="color:#a0a0aa">共 ${row.total}${row.cap ? `/${row.cap}` : ''}</span>` : ''}
            ${row.possible === null ? '' : `<span style="color:${row.possible ? '#4ade80' : '#f87171'}">・夠 ${row.possible} 爐</span>`}</div>
          ${row.problems.length ? `<div style="color:#f87171">⚠ ${row.problems.join('；')}</div>` : ''}
        </div>`;
      })
      .join('') + '<div class="hint">綠底＝下一個開爐的角色；紅色材料＝庫存不夠這一爐</div>';
  }

  // 總覽頁的鍛造管理：佇列、欄位、名稱，還有可以加進佇列的角色
  function forgeBoardReport(settings) {
    const heroIds = forgeByApiHeroIds(settings);
    if (!settings.forgeByApiEnabled && !heroIds.length) return null;
    return {
      at: forgeHeroesAt,
      running: forgeRunner.running,
      started: forgeRunner.started,
      limit: settings.forgeByApiCount,
      slots: Number(settings.forgeShopSlots) || 0,
      shops: Number(settings.forgeShopSlots) || forgeShops.count || 0,
      forging: forgeHeroes.filter((hero) => hero.actionState === 5).length,
      recipeType: settings.forgeRecipeType,
      recipe: settings.forgeRecipe,
      itemName: settings.forgeRecipeName,
      autoName: settings.forgeAutoNameEnabled,
      autoNamePercent: settings.forgeAutoNamePercent,
      note: forgeRunner.running ? forgeRunner.nameWaiting : forgeRunner.stoppedReason || '',
      rows: forgeQueueRows(settings),
      plans: Object.fromEntries(forgeByApiHeroIds(settings).map((heroId) => [heroId, forgeApiPlan(settings, heroId)])),
      recipeOptions: forgeRecipeOptions(settings),
      mines: mineStock.map((mine) => [mine.name, mine.have]),
      candidates: forgeHeroes
        .filter((hero) => !heroIds.includes(hero.id) && !inHuntTeam(hero))
        .sort((first, second) => (second.forge || 0) - (first.forge || 0))
        .map((hero) => ({ id: hero.id, name: hero.name, forge: hero.forge, tailor: hero.tailor, craft: hero.craft })),
    };
  }

  // 總覽頁編配方用：每種裝備前 5 個推薦配方（照這種裝備看重的第一個屬性排）；算一次要掃全部鍛造紀錄，1 分鐘重算一次
  const NAME_STAT_GOALS = { 攻: 'atk', 防: 'def', 智: 'int', 幸: 'lck', 重: 'wgt', 耐: 'fullDur' };
  const RECIPE_OPTIONS_FRESH_MILLISECONDS = 60000;
  const recipeOptionsCache = { at: 0, value: {} };

  function forgeRecipeOptions(settings) {
    if (Date.now() - recipeOptionsCache.at < RECIPE_OPTIONS_FRESH_MILLISECONDS) return recipeOptionsCache.value;
    const weights = settings.recipeNameAdjust ? loadNameWeights() || { days: {} } : null;
    recipeOptionsCache.value = Object.fromEntries(
      Object.values(FORGE_TYPE_NAMES).map((type) => {
        const stats = namePriorityFor(settings, type);
        const goal = stats ? NAME_STAT_GOALS[stats[0]] : 'total';
        const recipes = recommendRecipes(type, goal, '', weights)
          .slice(0, 5)
          .map((recipe) => ({ key: recipe.key, count: recipe.count, score: Math.round(goal === 'wgt' ? -recipe.score : recipe.score), goal: RECIPE_GOALS[goal] }));
        return [type, recipes];
      })
    );
    recipeOptionsCache.at = Date.now();
    return recipeOptionsCache.value;
  }

  // 總覽頁編某個角色的配方：類型、材料、名稱（名稱空白＝用配方頁的名稱）；不在佇列的順便加進去
  function setForgePlanFromDashboard(command) {
    const heroId = Number(command.heroId);
    const type = String(command.type || '').trim();
    const recipe = parseRecipe(command.recipe);
    if (!heroId) throw new Error('沒有指定角色');
    if (!Object.values(FORGE_TYPE_NAMES).includes(type)) throw new Error(`不認得的裝備類型 ${type}`);
    if (!recipe.length) throw new Error('配方是空的');
    const total = recipe.reduce((sum, [, quantity]) => sum + quantity, 0);
    if (total > MATERIAL_CAPS[type]) throw new Error(`${type}材料上限 ${MATERIAL_CAPS[type]}，配方共 ${total}`);
    const settings = readSettingsFromPanel();
    const plans = forgeByApiPlans(settings);
    plans[heroId] = { type, recipe: recipe.map(([name, quantity]) => `${name}×${quantity}`).join('、'), name: String(command.name || '').trim() };
    setPanelField('forgeByApiPlans', JSON.stringify(plans));
    const heroIds = forgeByApiHeroIds(settings);
    if (!heroIds.includes(heroId)) setPanelField('forgeByApiHeroIds', [...heroIds, heroId].join(','));
    afterForgeQueueChange();
    const hero = forgeHeroes.find((candidate) => candidate.id === heroId);
    return `${hero ? hero.name : heroId} 的配方改成 ${type} ${plans[heroId].recipe}`;
  }

  // 總覽頁「加入」：沿用佇列裡某個角色的配方，沒指定就用配方頁目前的配方
  function queueHeroFromDashboard(heroId, fromId) {
    const settings = readSettingsFromPanel();
    const plans = forgeByApiPlans(settings);
    if (!fromId) {
      queueHeroForForge(heroId);
      return `${heroId} 用配方頁的配方加入佇列`;
    }
    const source = plans[fromId];
    if (!source || !source.recipe) throw new Error('那個角色沒有配方');
    plans[heroId] = { ...source };
    setPanelField('forgeByApiPlans', JSON.stringify(plans));
    const heroIds = forgeByApiHeroIds(settings);
    if (!heroIds.includes(heroId)) setPanelField('forgeByApiHeroIds', [...heroIds, heroId].join(','));
    afterForgeQueueChange();
    return `${heroId} 用 ${fromId} 的配方加入佇列`;
  }

  function forgeCountText(recipeText) {
    const recipe = parseRecipeLoosely(recipeText);
    if (!recipe.length || !mineStock.length) return '';
    const possible = forgesPossible(recipe, mineStock);
    return ` <span style="color:${possible ? '#22c55e' : '#ef4444'}">夠 ${possible} 爐</span>`;
  }

  function updateForgeApiPlansFromChoices() {
    const plans = {};
    panel.querySelectorAll('[data-forge-plan-hero]').forEach((row) => {
      const value = (field) => row.querySelector(`[data-forge-plan="${field}"]`).value.trim();
      const plan = { type: value('type'), recipe: value('recipe'), name: value('name') };
      if (plan.recipe || plan.name) plans[row.dataset.forgePlanHero] = plan;
    });
    // 這次清單裡沒列出來的角色（例如已經送人）設定照留
    const shown = new Set([...panel.querySelectorAll('[data-forge-plan-hero]')].map((row) => row.dataset.forgePlanHero));
    const kept = Object.fromEntries(Object.entries(forgeByApiPlans(readSettingsFromPanel())).filter(([heroId]) => !shown.has(heroId)));
    panel.querySelector('[data-field="forgeByApiPlans"]').value = JSON.stringify({ ...kept, ...plans });
  }

  function updateForgeApiHeroesFromChoices() {
    panel.querySelector('[data-field="forgeByApiHeroIds"]').value = Array.from(panel.querySelectorAll('[data-forge-api-hero]'))
      .filter((input) => input.checked)
      .map((input) => input.value)
      .join(',');
  }

  // API 鍛造自己跑一條線，不佔用打怪的流程：同一個分頁可以一邊打怪一邊 API 鍛造。
  // 不用定時巡：有空的角色就開爐，否則睡到最早那爐的完成時間（遊戲有給 actionCompleteTime）再來收
  const forgeRunner = { running: false, runId: 0, timerId: null, started: 0, captchaWaiting: false, captchaCheckedAt: 0, failures: 0, nameWaiting: '' };
  // 名稱是哪一天定的（自動換上或手動改名稱）；存起來，重開腳本、重整頁面後才知道今天的名稱定了沒
  const FORGE_NAME_DAY_KEY = 'autoClickerV2ForgeNameDay';
  // 遊戲回錯誤或連線失敗時重試幾次才停（例如伺服器偶爾 502、掛機剛好同時動到同一個角色）
  const FORGE_RETRY_LIMIT = 5;
  // 鍛造坊數量＝基本 2 間＋擴建次數（/api/profile 的 forgeExpanded）；當成 6 間的話，真的都滿時會送到不存在的鍛造坊被拒
  const FORGE_BASE_SHOPS = 2;
  const FORGE_SHOPS_FRESH_MILLISECONDS = 10 * 60000;
  const forgeShops = { count: 0, at: 0 };

  async function forgeShopCount() {
    const manual = Number(readSettingsFromPanel().forgeShopSlots) || 0;
    if (manual > 0) return manual;
    if (forgeShops.count && Date.now() - forgeShops.at < FORGE_SHOPS_FRESH_MILLISECONDS) return forgeShops.count;
    try {
      const profile = await requestGameApi(PROFILE_API);
      forgeShops.count = FORGE_BASE_SHOPS + (Number(profile.forgeExpanded) || 0);
      forgeShops.at = Date.now();
    } catch {
      // 讀不到就沿用上次的；從沒讀到過就先當基本數量，寧可少開也不要送到不存在的鍛造坊
    }
    return forgeShops.count || FORGE_BASE_SHOPS;
  }

  function applyForgeNamesByType(namesByType) {
    const settings = readSettingsFromPanel();
    const plans = forgeByApiPlans(settings);
    forgeByApiHeroIds(settings).forEach((heroId) => {
      const name = namesByType[forgeApiPlan(settings, heroId).type];
      if (name && plans[heroId]) plans[heroId].name = name;
    });
    setPanelField('forgeByApiPlans', JSON.stringify(plans));
    if (namesByType[settings.forgeRecipeType]) setPanelField('forgeRecipeName', namesByType[settings.forgeRecipeType]);
    saveSettings(readSettingsFromPanel());
    if (panel.querySelector('[data-forge-plan-hero]')) showForgeApiHeroChoices().catch(() => {});
  }

  function applyForgeName(name) {
    const settings = readSettingsFromPanel();
    const plans = forgeByApiPlans(settings);
    forgeByApiHeroIds(settings).forEach((heroId) => {
      if (plans[heroId]) plans[heroId].name = name;
    });
    setPanelField('forgeByApiPlans', JSON.stringify(plans));
    setPanelField('forgeRecipeName', name);
    saveSettings(readSettingsFromPanel());
    if (panel.querySelector('[data-forge-plan-hero]')) showForgeApiHeroChoices().catch(() => {});
  }

  // 換好今天的名稱回傳 null；還不能換就回傳原因
  async function pickTodayForgeName(settings) {
    try {
      await refreshNameWeights(true);
    } catch (error) {
      return `讀取測名表失敗（${error.message}）`;
    }
    // 佇列裡每種裝備各挑各的；全部類型都到門檻才換
    const types = [...new Set([settings.forgeRecipeType, ...forgeByApiHeroIds(settings).map((heroId) => forgeApiPlan(settings, heroId).type)].filter(Boolean))];
    const picks = types.map((type) => {
      const stats = namePriorityFor(settings, type);
      return { type, label: stats ? stats.join('>') : '六圍', best: todayNamesForType(settings, type)[0] };
    });
    if (picks.some((pick) => !pick.best)) return '測名表今天還沒有資料';
    const pickText = (pick) => `${pick.type}「${pick.best.name}」${pick.label} ${(pick.best.score * 100).toFixed(1)}%`;
    const short = picks.filter((pick) => pick.best.score * 100 < settings.forgeAutoNamePercent);
    if (short.length) return `今天最高 ${short.map(pickText).join('、')}，還沒到 ${settings.forgeAutoNamePercent}%`;
    applyForgeNamesByType(Object.fromEntries(picks.map((pick) => [pick.type, pick.best.name])));
    writeJsonStorage(FORGE_NAME_DAY_KEY, localDayKey(Date.now()));
    forgeRunner.nameWaiting = '';
    forgeLog(`換成 ${picks.map(pickText).join('、')}，繼續鍛造`);
    return null;
  }

  // 同樣的原因只提醒一次，換了原因（例如另一個角色也沒材料了）才再提醒
  function noteForgeSkipped(skipped) {
    const text = skipped.join('；');
    if (forgeRunner.skippedText === text) return;
    forgeRunner.skippedText = text;
    showToast(`鍛造：先跳過 ${text}，其他角色照常鍛造`);
  }

  function forgeLog(message) {
    setStatus(`［鍛造］${message}`);
  }

  function scheduleForgeRunner(delay) {
    const settings = readSettingsFromPanel();
    delay = casualForgeAway(settings) ? delay + randomGap(60000, 480000) : lowProfileDelay(settings, delay);
    backgroundTimer.clearTimeout(forgeRunner.timerId);
    const runId = forgeRunner.runId;
    nextTickAt.forge = Date.now() + Math.max(0, Number(delay) || 0);
    forgeRunner.timerId = backgroundTimer.setTimeout(() => {
      if (runId === forgeRunner.runId) forgeApiTick(readSettingsFromPanel());
    }, delay);
  }

  function startForgeRunner() {
    const settings = readSettingsFromPanel();
    if (forgeRunner.running) {
      forgeLog('已經在鍛造了');
      return;
    }
    if (otherTabRunning(true)) {
      forgeLog('同一個帳號的另一個分頁正在鍛造，這個分頁不啟動（要換到這裡跑，先停掉那一邊）');
      return;
    }
    saveSettings(settings);
    prepareAlerts(settings);
    dashboard.alert = '';
    forgeRunner.running = true;
    forgeRunner.runId++;
    forgeRunner.started = 0;
    forgeRunner.failures = 0;
    forgeRunner.nameWaiting = '';
    forgeRunner.captchaWaiting = false;
    writeJsonStorage(runLockKey(true), { tab: tabKey, at: Date.now() });
    rememberTabRole(!state.running);
    forgeLog('開始 API 鍛造');
    forgeApiTick(settings);
  }

  function stopForgeRunner(message) {
    if (!forgeRunner.running) return;
    forgeRunner.running = false;
    // 狀態列會被掛機的訊息蓋掉，停下的原因另外留著顯示在監控區
    forgeRunner.stoppedReason = `${new Date().toLocaleTimeString('zh-TW', { hour12: false })} ${message || '已停止'}`;
    forgeRunner.runId++;
    forgeRunner.captchaWaiting = false;
    backgroundTimer.clearTimeout(forgeRunner.timerId);
    releaseRunLock(true);
    if (message) forgeLog(message);
  }

  function pauseForgeRunner(message) {
    stopForgeRunner(message);
    dashboard.alert = `鍛造：${message}`;
    alertUser(`鍛造：${message}`, { paused: true });
  }

  async function checkForgeCaptcha() {
    if (!forgeRunner.running || !forgeRunner.captchaWaiting) return;
    if (Date.now() - forgeRunner.captchaCheckedAt < CAPTCHA_POLL_MILLISECONDS) return;
    forgeRunner.captchaCheckedAt = Date.now();
    try {
      const captcha = await requestGameApi('/api/captcha');
      if (captcha && captcha.pendingCaptchaId) return;
    } catch {
      return;
    }
    if (!forgeRunner.running || !forgeRunner.captchaWaiting) return;
    forgeRunner.captchaWaiting = false;
    clearAlert();
    forgeLog('驗證已完成，繼續鍛造');
    forgeApiTick(readSettingsFromPanel());
  }

  // 還能再開爐就幾秒後再來；否則等最早完成的那爐（鍛造坊滿了就等任何一爐），到點再隨機晚幾秒，像人回來看
  function nextForgeDelay(heroes, heroIds, canStartMore) {
    if (canStartMore) return randomGap(3000, 8000);
    const waitingForShop = heroes.some((hero) => heroIds.includes(hero.id) && canStartForge(hero));
    const times = heroes
      .filter((hero) => hero.actionState === 5 && (waitingForShop || heroIds.includes(hero.id)))
      .map((hero) => Date.parse(hero.actionCompleteTime))
      .filter(Number.isFinite);
    const next = times.length ? Math.min(...times) : Date.now() + 60000;
    return Math.min(Math.max(next - Date.now(), 0) + randomGap(3000, 12000), 15 * 60000);
  }

  // 同一時間只跑一輪：手動收爐叫醒鍛造時，不會跟正在跑的那輪一起開爐
  async function forgeApiTick(initialSettings) {
    if (forgeRunner.ticking) return;
    forgeRunner.ticking = true;
    try {
      await forgeApiTickOnce(initialSettings);
    } finally {
      forgeRunner.ticking = false;
    }
  }

  // 遊戲畫面上手動收爐、開爐（或角色列表變了）：鍛造還在睡就 5～15 秒後起來看，像人看到畫面變了
  function wakeForgeRunner() {
    if (!forgeRunner.running || forgeRunner.ticking || forgeRunner.captchaWaiting) return;
    if (nextTickAt.forge - Date.now() > 20000) scheduleForgeRunner(randomGap(5000, 15000));
  }

  async function forgeApiTickOnce(initialSettings) {
    // 中途可能換了名稱，要重讀設定
    let settings = initialSettings;
    if (!forgeRunner.running || forgeRunner.captchaWaiting) return;
    if (casualForgeAway(settings)) startCasualCheckin(settings, '鍛造好了回來收');
    const runId = forgeRunner.runId;
    const cancelled = () => runId !== forgeRunner.runId;
    const heroIds = forgeByApiHeroIds(settings);
    if (!heroIds.length) {
      pauseForgeRunner('還沒勾要鍛造的角色');
      return;
    }
    try {
      let heroes = (await requestGameApi(HEROES_API)).heroes || [];
      if (cancelled()) return;
      forgeHeroes = heroes;
      forgeHeroesAt = Date.now();
      renderRecipeHeroes();
      const actions = [];
      for (const hero of heroes.filter((candidate) => heroIds.includes(candidate.id) && candidate.actionState === 5 && candidate.canComplete)) {
        let completed;
        try {
          completed = await requestGameApi(`${HEROES_API}/${hero.id}/completeForge`, { method: 'POST' });
        } catch (error) {
          // 讀完列表到送出之間被手動收走了：重讀一次角色，不算出錯
          if (error.status !== 400) throw error;
          heroes = (await requestGameApi(HEROES_API)).heroes || heroes;
          if (cancelled()) return;
          actions.push(`${hero.name} 已經被收走了`);
          continue;
        }
        heroes = completed.heroes || heroes;
        if (cancelled()) return;
        actions.push(`${hero.name} 完成鍛造`);
        syncGameCompleteForge(completed, hero.id);
      }
      const forging = heroes.filter((hero) => hero.actionState === 5);
      const limit = settings.forgeByApiCount;
      const progress = () => (limit > 0 ? `${forgeRunner.started}/${limit}` : `${forgeRunner.started}`);
      if (limit > 0 && forgeRunner.started >= limit) {
        if (!forging.some((hero) => heroIds.includes(hero.id))) {
          stopForgeRunner(`API 鍛造完成，共開 ${forgeRunner.started} 爐`);
          return;
        }
        const delay = nextForgeDelay(heroes, heroIds, false);
        forgeLog(`${actions.join('、') || '等最後幾爐完成'}（已開 ${progress()} 爐，${Math.round(delay / 1000)} 秒後再看）`);
        scheduleForgeRunner(delay);
        return;
      }
      if (settings.forgeAutoNameEnabled && readJsonStorage(FORGE_NAME_DAY_KEY, '') !== localDayKey(Date.now())) {
        const waiting = await pickTodayForgeName(settings);
        if (cancelled()) return;
        if (waiting) {
          forgeRunner.nameWaiting = waiting;
          const minutes = settings.forgeAutoNameMinutes;
          forgeLog(`${actions.length ? `${actions.join('、')}；` : ''}過了 00:00 先不開新爐：${waiting}，${minutes} 分鐘後再抓`);
          scheduleForgeRunner(randomGap(minutes * 60000, minutes * 60000 + 30000));
          return;
        }
        settings = readSettingsFromPanel();
      }
      forgeRunner.nameWaiting = '';
      const idleHeroes = heroes.filter((hero) => heroIds.includes(hero.id) && canStartForge(hero));
      let idle = null;
      let request = null;
      const skipped = [];
      const busyShops = new Set(forging.map((hero) => Number(hero.actionTarget)));
      const shopCount = await forgeShopCount();
      if (cancelled()) return;
      const freeShop = Array.from({ length: shopCount }, (_, index) => index + 1).find((shop) => !busyShops.has(shop));
      if (idleHeroes.length && freeShop) {
        // 開工後就不能吃體力藥，所以要在開工之前補；只用 API 補給，人不在鍛造頁也能補
        heroes.forEach((hero) => state.heroStats.set(hero.id, hero));
        state.heroStatsAt = Date.now();
        const supplyTarget = findSlotNeedingItem(settings, { forge: true });
        if (supplyTarget && usesItemApi(settings, supplyTarget.group, supplyTarget.index)) {
          useItem(settings, supplyTarget, { isCancelled: cancelled, onDone: () => scheduleForgeRunner(randomGap(1500, 3000)) });
          return;
        }
        // 一個角色材料不夠、配方沒設好，換下一個角色；全部都開不了而且沒有在鍛造的才停
        // 像人打開鍛造頁看一次材料，輪流看哪個角色的配方做得出來
        const items = idleHeroes.length > 1 ? await requestGameApi(ITEMS_API) : null;
        for (const hero of idleHeroes) {
          try {
            const plan = forgeApiPlan(settings, hero.id);
            if (!plan.recipe) throw new Error('還沒設定配方');
            request = await buildForgeRequest(plan, hero.id, freeShop, items);
            idle = hero;
            break;
          } catch (error) {
            if (error.captchaRequired || error.transient || error.status) {
              throw Object.assign(new Error(`${hero.name}：${error.message}`), {
                captchaRequired: error.captchaRequired,
                transient: error.transient,
                status: error.status,
              });
            }
            skipped.push(`${hero.name}：${error.message}`);
          }
          if (cancelled()) return;
        }
        if (cancelled()) return;
        if (!idle && !forging.some((hero) => heroIds.includes(hero.id))) throw new Error(skipped.join('；'));
        if (skipped.length) noteForgeSkipped(skipped);
      }
      if (idle) {
        const { body, summary, forgesLeft } = request;
        await sendForge(body);
        forgeRunner.started++;
        actions.push(`${idle.name} 在鍛造坊 ${freeShop} 開始鍛造 ${summary}${forgesLeft === null ? '' : `，材料還夠 ${forgesLeft} 爐`}`);
      }
      forgeRunner.failures = 0;
      forgeHeroes = heroes;
      if (activeTab === 'forge') {
        if (idle) await refreshMineStock().catch(() => {});
        renderForgePlanOverview();
      }
      const delay = nextForgeDelay(heroes, heroIds, Boolean(idle));
      if (skipped.length) actions.push(`跳過 ${skipped.join('；')}`);
      forgeLog(`${actions.join('、') || (idleHeroes.length ? `${shopCount} 間鍛造坊都有人在用` : '角色都在鍛造中')}（已開 ${progress()} 爐，${Math.round(delay / 1000)} 秒後再看）`);
      scheduleForgeRunner(delay);
    } catch (error) {
      if (cancelled()) return;
      if (error.captchaRequired) {
        forgeRunner.captchaWaiting = true;
        forgeRunner.captchaCheckedAt = 0;
        dashboard.alert = '鍛造：伺服器要求活人驗證';
        forgeLog('伺服器要求活人驗證，完成後會自動繼續');
        if (state.running && !state.forgeMode) pauseForCaptcha(readSettingsFromPanel());
        else alertUser('鍛造：伺服器要求活人驗證，完成後會自動繼續', { paused: true });
        return;
      }
      if ((error.transient || error.status) && forgeRunner.failures < FORGE_RETRY_LIMIT) {
        forgeRunner.failures++;
        const delay = randomGap(30000, 60000);
        forgeLog(`出錯（${error.message}），${Math.round(delay / 1000)} 秒後重試（第 ${forgeRunner.failures}/${FORGE_RETRY_LIMIT} 次）`);
        scheduleForgeRunner(delay);
        return;
      }
      // 材料不夠、配方有問題這類不會自己好，連續出錯也是，停下來讓人處理
      pauseForgeRunner(forgeRunner.failures ? `連續 ${forgeRunner.failures + 1} 次出錯，最後一次：${error.message}` : error.message);
    }
  }

  // 挖礦：選了地點的角色在城裡閒著就去挖，體力估計快用完（照上一次挖的耗體力速度）就收；
  // 收完體力或 HP 太低先休息再挖。遊戲規定至少挖 3 分鐘、休息 1 分鐘才能收，時間到也不會自己停
  const MINING_SITES = { 1: '砂石場', 2: '森林區', 3: '鐵礦山', 4: '阿嬤寶山' };
  const MINING_KEY = 'autoClickerV2Mining';
  const MINING_LOCK_KEY = `${RUN_LOCK_PREFIX}mine`;
  const MINING_WATCH_MILLISECONDS = 5 * 60000;
  const MINING_MIN_MINUTES = 3;
  const MINING_DEFAULT_REST_MINUTES = 30;
  const MINING_REST_SP_PERCENT = 30;
  const MINING_REST_HP_PERCENT = 50;
  const MINING_REST_MAX_MINUTES = 60;
  const MINING_DEFAULT_HOURS = 6;
  const MINING_LOG_LIMIT = 30;
  // 遊戲角色頁「行動紀錄」讀這個；API 收的也寫進去，遊戲裡看得到
  const GAME_ACTION_RESULTS_KEY = 'miningResults';
  const miningRunner = { running: false, runId: 0, timerId: null, failures: 0, collected: 0, stoppedReason: '' };
  const miningWatch = { busy: false };
  const miningNotified = new Set();

  function loadMining() {
    const saved = readJsonStorage(MINING_KEY, null);
    return { rates: {}, active: {}, log: [], heroes: [], heroesAt: 0, ...(saved || {}) };
  }

  function saveMining(data) {
    writeJsonStorage(MINING_KEY, data);
  }

  function miningPlans(settings) {
    try {
      const plans = JSON.parse(settings.miningPlans || '{}');
      return plans && typeof plans === 'object' ? plans : {};
    } catch {
      return {};
    }
  }

  function miningOrderedIds(settings, heroIds) {
    let order = [];
    try {
      order = JSON.parse(settings.miningOrder || '[]').map(Number);
    } catch {
      order = [];
    }
    const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length + heroIds.indexOf(id));
    return [...heroIds].sort((first, second) => rank(first) - rank(second));
  }

  function plannedMiningIds(settings) {
    const plans = miningPlans(settings);
    return Object.keys(plans)
      .filter((id) => MINING_SITES[plans[id]])
      .map(Number);
  }

  function moveMiningOrder(heroId, step) {
    const settings = readSettingsFromPanel();
    const ids = miningOrderedIds(settings, plannedMiningIds(settings));
    const index = ids.indexOf(heroId);
    const target = index + step;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setPanelField('miningOrder', JSON.stringify(ids));
    saveSettings(readSettingsFromPanel());
    renderMiningHeroes();
  }

  function canCompleteNow(hero, now) {
    return Boolean(hero.canComplete) || Date.parse(hero.actionCompleteTime) <= now;
  }

  function miningLog(message) {
    setStatus(`［挖礦］${message}`);
  }

  function inTownHero(hero) {
    return !Number(hero.huntZone) && !Number(hero.huntStage);
  }

  function actionMinutes(hero, now) {
    const start = Date.parse(hero.actionStart);
    return Number.isFinite(start) ? Math.max(0, (now - start) / 60000) : 0;
  }

  function durationText(minutes) {
    const whole = Math.floor(minutes);
    return whole >= 60 ? `${Math.floor(whole / 60)} 小時 ${whole % 60} 分` : `${whole} 分`;
  }

  // 列表的角色不一定帶狀態效果；在挖礦或要挖的才另外讀，看得到中毒這類異常
  // 自動挖礦時不另外讀狀態：要動作前「打開英雄頁」才讀，跟人一樣（openGameHeroPage）
  async function readMiningHeroes(settings, { statuses: withStatuses = true, ...options } = {}) {
    const heroes = (await requestGameApi(HEROES_API, options)).heroes || [];
    const plans = miningPlans(settings);
    const data = loadMining();
    const previous = new Map(data.heroes.map((hero) => [hero.id, hero.statuses]));
    for (const hero of heroes.filter((candidate) => !Array.isArray(candidate.statuses) && (candidate.actionState === 4 || plans[candidate.id]))) {
      hero.statuses = previous.get(hero.id);
      if (!withStatuses) continue;
      try {
        hero.statuses = (await requestGameApi(`${HEROES_API}/${hero.id}/statuses`, options)).statuses || [];
      } catch {
        // 讀不到狀態就沿用上次的，下次再讀
      }
    }
    data.heroes = heroes.map(compactMiningHero);
    data.heroesAt = Date.now();
    saveMining(data);
    if (activeTab === 'mining') renderMiningHeroes();
    return heroes;
  }


  function noticeHeroList(reply) {
    if (!reply || !Array.isArray(reply.heroes)) return;
    const data = loadMining();
    const previous = new Map(data.heroes.map((hero) => [hero.id, hero.statuses]));
    data.heroes = reply.heroes.map((hero) => compactMiningHero({ ...hero, statuses: Array.isArray(hero.statuses) ? hero.statuses : previous.get(hero.id) }));
    data.heroesAt = Date.now();
    saveMining(data);
    if (activeTab === 'mining') renderMiningHeroes();
    // 鍛造佇列、配方頁的角色狀態也一起換，手動收爐後不會一直顯示「已完成待收」
    forgeHeroes = reply.heroes;
    forgeHeroesAt = Date.now();
    if (activeTab === 'forge') renderForgePlanOverview();
    if (activeTab === 'recipe') renderRecipeHeroes();
  }

  // 抽到新卡：下次打開挖礦頁或定時讀取時重讀角色
  function markMiningHeroesStale() {
    const data = loadMining();
    data.heroesAt = 0;
    saveMining(data);
    if (activeTab === 'mining') readMiningHeroes(readSettingsFromPanel()).catch(() => {});
  }

  function compactMiningHero(hero) {
    const { id, name, actionState, actionTarget, actionStart, actionCompleteTime, canComplete, sp, fullSp, hp, fullHp, mining, perished, huntZone, huntStage, selected } = hero;
    return { id, name, actionState, actionTarget, actionStart, actionCompleteTime, canComplete, sp, fullSp, hp, fullHp, mining, perished, huntZone, huntStage, selected, statuses: hero.statuses };
  }

  // 挖礦中角色的體力是開挖時的值；知道耗體力速度就估現在剩多少
  function estimatedMiningSp(hero, data, now) {
    const rates = data.rates[hero.id] || {};
    const rate = rates.mineSp;
    const record = data.active[hero.id];
    const startSp = record && record.kind === 'mine' ? record.sp : hero.sp;
    // 只量過「用光了」的話速度是猜的，不顯示估計
    if (!(rate > 0) || !rates.mineSpExact) return null;
    return Math.max(0, startSp - rate * actionMinutes(hero, now));
  }

  function miningCollectAt(settings, hero, data, now) {
    const start = Date.parse(hero.actionStart) || now;
    const earliest = Date.parse(hero.actionCompleteTime) || start + MINING_MIN_MINUTES * 60000;
    const record = data.active[hero.id];
    // 每輪開挖時抽好這輪挖多久，之後每次巡都用同一個
    let at = start + (record && record.kind === 'mine' && record.hours ? record.hours : miningHours(settings)) * 3600000;
    if (settings.miningConditionRest && heroConditions(hero).length) at = now;
    return Math.max(at, earliest);
  }

  function miningNeedsRest(settings, hero) {
    const percent = (value, full) => (Number(full) > 0 ? (value / full) * 100 : 100);
    return (
      hero.sp <= 0 ||
      percent(hero.sp, hero.fullSp) < MINING_REST_SP_PERCENT ||
      percent(hero.hp, hero.fullHp) < MINING_REST_HP_PERCENT
    );
  }

  // 休息多久：照上次休息回復的速度算到滿；還不知道速度就先休息 30 分鐘
  function miningRestMinutes(settings, hero, data) {
    const rates = data.rates[hero.id] || {};
    const needs = [];
    if (rates.restSp > 0) needs.push((hero.fullSp - hero.sp) / rates.restSp);
    if (rates.restHp > 0) needs.push((hero.fullHp - hero.hp) / rates.restHp);
    const minutes = needs.length ? Math.max(...needs) : MINING_DEFAULT_REST_MINUTES;
    return Math.min(Math.max(1, Math.ceil(minutes)), MINING_REST_MAX_MINUTES);
  }

  function miningHours(settings) {
    return Math.max(0.1, Number(settings.miningIntervalHours) || MINING_DEFAULT_HOURS);
  }

  // 勾選可以喝的體力藥水：列出物品欄裡能回體力的道具
  // 出發前補的兩種：HP、體力
  const MINING_SUPPLIES = {
    hp: { group: 'health', field: 'hp', full: 'fullHp', heal: 'healHp', names: 'miningHpPotionNames', enabled: 'miningHpPotionEnabled', role: 'mining-hp-potions', label: 'HP', item: '補血道具' },
    sp: { group: 'resource', field: 'sp', full: 'fullSp', heal: 'healSp', names: 'miningPotionNames', enabled: 'miningPotionEnabled', role: 'mining-potions', label: '體力', item: '體力藥水' },
  };
  let miningPotionItems = null;

  async function loadMiningPotions() {
    try {
      miningPotionItems = ((await requestGameApi(ITEMS_API)).items || []).filter((item) => item.healSp > 0 || item.healHp > 0);
    } catch (error) {
      miningLog(`讀取物品欄失敗（${error.message}）`);
      return;
    }
    renderMiningPotions();
  }

  function miningPotionNames(settings, kind) {
    return String(settings[MINING_SUPPLIES[kind].names] || '')
      .split(/[,，、]/)
      .map((name) => name.trim())
      .filter(Boolean);
  }

  function renderMiningPotions() {
    const settings = readSettingsFromPanel();
    Object.entries(MINING_SUPPLIES).forEach(([kind, supply]) => {
      const box = panel.querySelector(`[data-role="${supply.role}"]`);
      if (!box) return;
      const chosen = miningPotionNames(settings, kind);
      const items = (miningPotionItems || []).filter((item) => item[supply.heal] > 0);
      // 勾過但物品欄現在沒有的也列出來，才取消得掉
      const rows = [
        ...items.map((item) => [item.name, `回 ${item[supply.heal]}，剩 ${item.available}`]),
        ...chosen.filter((name) => !items.some((item) => item.name === name)).map((name) => [name, '物品欄沒有']),
      ];
      box.innerHTML = rows.length
        ? rows
            .map(
              ([name, note]) => `<label style="display:block;margin-left:18px"><input type="checkbox" data-mining-potion="${kind}" value="${escapeHtml(name)}" ${chosen.includes(name) ? 'checked' : ''} style="width:auto;flex:none"> ${escapeHtml(name)}（${note}）</label>`
            )
            .join('')
        : `<div class="hint" style="margin-left:18px">${miningPotionItems ? `物品欄沒有${supply.item}` : '讀取中…'}</div>`;
    });
  }

  // 體力用光（或休息到滿）時只知道真正的速度至少這麼快：往上多估一點，下次早點收，才量得到真正的速度
  function learnMiningRate(data, heroId, record, after) {
    if (!record || !after) return;
    const minutes = (Date.now() - record.at) / 60000;
    if (minutes < 1) return;
    const rates = data.rates[heroId] || (data.rates[heroId] = {});
    // 量到過真正速度（沒用光、沒補滿）之後，用光／補滿的那幾次不再算；固定每幾小時收的話體力幾乎都會用光
    const learn = (key, sample, capped) => {
      const exact = `${key}Exact`;
      if (!capped) {
        rates[key] = rates[exact] && rates[key] ? rates[key] * 0.5 + sample * 0.5 : sample;
        rates[exact] = true;
      } else if (!rates[exact]) {
        rates[key] = Math.max(rates[key] || 0, sample * 1.15);
      }
    };
    if (record.kind === 'mine') {
      const used = record.sp - after.sp;
      if (used > 0) learn('mineSp', used / minutes, after.sp <= 0);
    } else {
      const spGain = after.sp - record.sp;
      const hpGain = after.hp - record.hp;
      if (spGain > 0) learn('restSp', spGain / minutes, after.sp >= after.fullSp);
      if (hpGain > 0) learn('restHp', hpGain / minutes, after.hp >= after.fullHp);
    }
  }

  function rememberGameActionResult(heroId, result) {
    if (!result || !Array.isArray(result.messages)) return;
    try {
      const saved = JSON.parse(localStorage.getItem(GAME_ACTION_RESULTS_KEY) || '{}');
      saved[heroId] = [{ time: Date.now(), messages: result.messages }, ...(saved[heroId] || [])].slice(0, 5);
      localStorage.setItem(GAME_ACTION_RESULTS_KEY, JSON.stringify(saved));
      window.dispatchEvent(new Event('action-results-changed'));
    } catch {
      // 遊戲的行動紀錄寫不進去不影響收礦
    }
  }

  // 玩家要先點進英雄頁（GET /api/heroes/{id}）才按得到完成行動、挖礦；同一輪只開一次
  // 英雄頁一打開會讀英雄和狀態效果兩個
  async function openGameHeroPage(hero, opened) {
    if (opened.has(hero.id)) return hero;
    opened.add(hero.id);
    const detail = await requestGameApi(`${HEROES_API}/${hero.id}`);
    let statuses = hero.statuses || [];
    try {
      statuses = (await requestGameApi(`${HEROES_API}/${hero.id}/statuses`)).statuses || [];
    } catch {
      // 讀不到狀態就沿用列表上的
    }
    mirrorGameUpdate([], (client) => {
      client.setQueryData(['heroes', hero.id], detail);
      client.setQueryData(['heroes', hero.id, 'statuses'], statuses);
    });
    await wait(randomGap(1500, 4000));
    return { ...hero, ...detail, statuses };
  }

  async function completeMiningAction(settings, hero, data, kind) {
    const record = data.active[hero.id];
    const reply = await requestGameApi(`${HEROES_API}/${hero.id}/completeAction`, { method: 'POST' });
    syncGameCompleteAction(reply, hero.id);
    const after = { ...hero, ...(reply.hero || {}), actionState: reply.hero ? reply.hero.actionState : 0 };
    learnMiningRate(data, hero.id, record && record.kind === kind ? record : null, after);
    delete data.active[hero.id];
    const messages = (reply.actionResult && reply.actionResult.messages) || [];
    rememberGameActionResult(hero.id, reply.actionResult);
    data.log.unshift({
      t: Date.now(),
      name: hero.name,
      kind,
      site: kind === 'mine' ? MINING_SITES[(record && record.site) || hero.actionTarget] || '' : '',
      minutes: Math.round(actionMinutes(hero, Date.now())),
      text: messages.map((message) => message.m).filter(Boolean).join('，'),
      accident: messages.some((message) => ['dmg', 'status', 'death'].includes(message.s)),
    });
    data.log.length = Math.min(data.log.length, MINING_LOG_LIMIT);
    saveMining(data);
    // 挖礦可能出事故：收完重讀狀態效果（遊戲收完也會重讀），下一步才知道要不要先休息
    try {
      after.statuses = (await requestGameApi(`${HEROES_API}/${hero.id}/statuses`)).statuses || [];
    } catch {
      after.statuses = hero.statuses;
    }
    if (kind === 'mine') miningRunner.collected++;
    return after;
  }

  // 同一個角色同一種異常只通知一次；好了之後再中才會再通知
  function notifyMiningConditions(settings, hero) {
    if (!settings.miningConditionRest) return;
    const conditions = heroConditions(hero);
    const current = new Set(conditions.map((condition) => `${hero.id}:${condition.name}:${condition.level}`));
    [...miningNotified].filter((key) => key.startsWith(`${hero.id}:`) && !key.includes(':potion') && !current.has(key)).forEach((key) => miningNotified.delete(key));
    conditions.forEach((condition) => {
      const key = `${hero.id}:${condition.name}:${condition.level}`;
      if (miningNotified.has(key)) return;
      miningNotified.add(key);
      alertUser(`挖礦：${hero.name} ${condition.name}${condition.level}，${hero.actionState === 4 ? '提早收礦，' : ''}好了之前不出發挖礦`);
    });
  }

  const MINING_POTION_MAX_USES = 10;

  // 一次喝一瓶，喝到目標；差不到半瓶就不喝，免得補過頭浪費
  // 同時回 HP 和體力的道具：另一邊也缺才划算，另一邊滿了就是浪費。挑「兩邊加起來真的補到最多」的，
  // 一樣多挑浪費少的，再一樣挑剩比較多的
  function pickMiningPotion(items, supply, names, hero) {
    const need = (field, full) => Math.max(0, hero[full] - hero[field]);
    const useful = (item) =>
      Math.min(item.healHp || 0, need('hp', 'fullHp')) + Math.min(item.healSp || 0, need('sp', 'fullSp'));
    const waste = (item) => (item.healHp || 0) + (item.healSp || 0) - useful(item);
    return items
      .filter((item) => item[supply.heal] > 0 && item.available > 0 && (!names.length || names.includes(item.name)))
      .sort((first, second) => useful(second) - useful(first) || waste(first) - waste(second) || second.available - first.available)[0] || null;
  }

  async function drinkMiningPotions(settings, hero, kind, items) {
    const supply = MINING_SUPPLIES[kind];
    const names = miningPotionNames(settings, kind);
    const target = hero[supply.full];
    if (!(target - hero[supply.field] > 0)) return { hero, used: [], empty: false };
    let current = hero;
    const used = [];
    let empty = false;
    for (let count = 0; count < MINING_POTION_MAX_USES && current[supply.field] < target; count++) {
      const item = pickMiningPotion(items, supply, names, current);
      if (!item) {
        empty = true;
        break;
      }
      if (target - current[supply.field] < item[supply.heal] / 2) break;
      await wait(itemRequestGap());
      const result = await requestGameApi(`${ITEMS_API}/${item.id}/use`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: 1, heroId: hero.id }),
      });
      syncGameItemUse(result);
      item.available--;
      current = { ...current, ...(result.hero || { [supply.field]: Math.min(target, current[supply.field] + item[supply.heal]) }), statuses: current.statuses };
      used.push(item.name);
    }
    if (used.length || empty) logItemUse(`［挖礦］${hero.name} ${used.length ? `用了 ${used.join('、')}` : ''}${empty ? `${used.length ? '，' : ''}沒有${supply.item}了` : ''}，${supply.label} ${current[supply.field]}/${target}`);
    return { hero: current, used, empty };
  }

  async function miningHeroStep(settings, hero, plans, data, now, waits, opened, roundHours) {
    const record = data.active[hero.id];
    const done = [];
    if (hero.actionState === 4) return done;
    if (hero.actionState === 2 && record && record.kind === 'rest') {
      const at = Math.max(record.at + record.minutes * 60000, Date.parse(hero.actionCompleteTime) || 0);
      if (at > now) {
        waits.push(at);
        return done;
      }
      hero = await openGameHeroPage(hero, opened);
      hero = await completeMiningAction(settings, hero, data, 'rest');
      done.push(`${hero.name} 休息完`);
    }
    if (hero.actionState || hero.perished || hero.hp <= 0 || !inTownHero(hero) || inHuntTeam(hero) || forgeByApiHeroIds(settings).includes(hero.id)) return done;
    hero = await openGameHeroPage(hero, opened);
    notifyMiningConditions(settings, hero);
    if (settings.miningConditionRest && heroConditions(hero).length) {
      waits.push(Date.now() + randomGap(10, 20) * 60000);
      return done;
    }
    // 物品欄只看一次，HP、體力照順序補
    const kinds = Object.keys(MINING_SUPPLIES).filter((kind) => settings[MINING_SUPPLIES[kind].enabled] && hero[MINING_SUPPLIES[kind].field] < hero[MINING_SUPPLIES[kind].full]);
    const items = kinds.length ? (await requestGameApi(ITEMS_API)).items || [] : [];
    for (const kind of kinds) {
      const supply = MINING_SUPPLIES[kind];
      const drink = await drinkMiningPotions(settings, hero, kind, items);
      if (drink.used.length) done.push(`${hero.name} 用了 ${drink.used.length} 個${supply.item}`);
      const key = `${hero.id}:potion:${kind}`;
      if (!drink.empty) miningNotified.delete(key);
      if (drink.empty && !miningNotified.has(key)) {
        miningNotified.add(key);
        showToast(`挖礦：${hero.name} 沒有${supply.item}了，${supply.label}太低會先休息`);
      }
      hero = drink.hero;
    }
    if (miningNeedsRest(settings, hero)) {
      const minutes = miningRestMinutes(settings, hero, data);
      syncGameHeroAction(await requestGameApi(`${HEROES_API}/${hero.id}/rest`, { method: 'POST' }), 'rest');
      data.active[hero.id] = { kind: 'rest', at: Date.now(), sp: hero.sp, hp: hero.hp, minutes };
      waits.push(Date.now() + minutes * 60000);
      done.push(`${hero.name} 先休息 ${minutes} 分鐘`);
    } else {
      const site = Number(plans[hero.id]);
      syncGameHeroAction(await requestGameApi(`${HEROES_API}/${hero.id}/mining/${site}`, { method: 'POST' }), 'mine');
      const hours = roundHours;
      data.active[hero.id] = { kind: 'mine', at: Date.now(), sp: hero.sp, hp: hero.hp, site, hours };
      done.push(`${hero.name} 去${MINING_SITES[site]}挖礦${hours ? `（約 ${hours.toFixed(1)} 小時後收）` : ''}`);
    }
    saveMining(data);
    return done;
  }

  async function miningTick() {
    if (!miningRunner.running) return;
    const settings = readSettingsFromPanel();
    const runId = miningRunner.runId;
    const cancelled = () => runId !== miningRunner.runId;
    const plans = miningPlans(settings);
    const heroIds = Object.keys(plans)
      .filter((id) => MINING_SITES[plans[id]])
      .map(Number);
    if (!heroIds.length) {
      stopMiningRunner('還沒選要挖礦的角色（挖礦頁每個角色選地點）');
      return;
    }
    try {
      const heroes = await readMiningHeroes(settings, { statuses: false });
      if (cancelled()) return;
      const data = loadMining();
      const now = Date.now();
      const actions = [];
      const waits = [];
      const opened = new Set();
      const byId = new Map(heroes.map((hero) => [hero.id, hero]));
      const ordered = miningOrderedIds(settings, heroIds)
        .map((id) => byId.get(id))
        .filter(Boolean);
      // 一起收：任一個到時間就照順序全部收（未滿 3 分鐘的下次再收），收完才出發，最後一個收的角色才真的是最後
      const mining = ordered.filter((hero) => hero.actionState === 4);
      const due = mining.some((hero) => miningCollectAt(settings, hero, data, now) <= now);
      for (const hero of mining) {
        if (!due) {
          waits.push(miningCollectAt(settings, hero, data, now));
          continue;
        }
        if (!canCompleteNow(hero, now)) {
          waits.push(Date.parse(hero.actionCompleteTime) || now + 60000);
          continue;
        }
        try {
          const pageHero = await openGameHeroPage(hero, opened);
          notifyMiningConditions(settings, pageHero);
          byId.set(hero.id, await completeMiningAction(settings, pageHero, data, 'mine'));
          actions.push(`${hero.name} 收礦`);
        } catch (error) {
          if (error.captchaRequired) throw error;
          actions.push(`${hero.name}：${error.message}`);
        }
        if (cancelled()) return;
      }
      // 同一輪出發的挖一樣久，下次才會一起到時間
      const jitter = Math.min(50, Math.max(0, Number(settings.miningIntervalJitterPercent) || 0)) / 100;
      const roundHours = miningHours(settings) * (1 + (Math.random() * 2 - 1) * jitter);
      for (const hero of ordered.map((item) => byId.get(item.id))) {
        try {
          actions.push(...(await miningHeroStep(settings, hero, plans, data, now, waits, opened, roundHours)));
        } catch (error) {
          if (error.captchaRequired) throw error;
          actions.push(`${hero.name}：${error.message}`);
        }
        if (cancelled()) return;
      }
      miningRunner.failures = 0;
      // 有動作就很快再讀一次，看清楚新的狀態再排下一次；沒事就睡到最早該收的時間
      const next = waits.length ? Math.min(...waits) : now + MINING_WATCH_MILLISECONDS;
      const delay = actions.length ? randomGap(5000, 15000) : Math.min(Math.max(next - Date.now(), 0) + randomGap(3000, 20000), 15 * 60000);
      miningLog(`${actions.join('、') || '都在挖或休息'}（${Math.round(delay / 1000)} 秒後再看）`);
      scheduleMiningRunner(delay);
    } catch (error) {
      if (cancelled()) return;
      if ((error.captchaRequired || error.transient || error.status) && miningRunner.failures < FORGE_RETRY_LIMIT) {
        miningRunner.failures++;
        const delay = error.captchaRequired ? randomGap(120000, 180000) : randomGap(30000, 60000);
        miningLog(`${error.captchaRequired ? '要活人驗證' : `出錯（${error.message}）`}，${Math.round(delay / 1000)} 秒後重試（第 ${miningRunner.failures}/${FORGE_RETRY_LIMIT} 次）`);
        scheduleMiningRunner(delay);
        return;
      }
      stopMiningRunner(`出錯停下：${error.message}`);
      dashboard.alert = `挖礦：${error.message}`;
      alertUser(`挖礦：${error.message}`, { paused: true });
    }
  }

  function scheduleMiningRunner(delay) {
    const settings = readSettingsFromPanel();
    delay = lowProfileDelay(settings, delay);
    backgroundTimer.clearTimeout(miningRunner.timerId);
    const runId = miningRunner.runId;
    miningRunner.timerId = backgroundTimer.setTimeout(() => {
      if (runId === miningRunner.runId) miningTick();
    }, delay);
  }

  function otherTabMining() {
    const lock = readJsonStorage(MINING_LOCK_KEY, null);
    return lock && lock.tab !== tabKey && Date.now() - lock.at < RUN_LOCK_STALE_MILLISECONDS;
  }

  function startMiningRunner() {
    if (miningRunner.running) {
      miningLog('已經在挖礦了');
      return;
    }
    if (otherTabMining()) {
      miningLog('同一個帳號的另一個分頁正在挖礦，這個分頁不啟動');
      return;
    }
    saveSettings(readSettingsFromPanel());
    Object.assign(miningRunner, { running: true, failures: 0, collected: 0, stoppedReason: '' });
    miningRunner.runId++;
    writeJsonStorage(MINING_LOCK_KEY, { tab: tabKey, at: Date.now() });
    miningLog('開始挖礦');
    miningTick();
  }

  function stopMiningRunner(message) {
    if (!miningRunner.running) return;
    miningRunner.running = false;
    miningRunner.runId++;
    miningRunner.stoppedReason = `${new Date().toLocaleTimeString('zh-TW', { hour12: false })} ${message || '已停止'}`;
    backgroundTimer.clearTimeout(miningRunner.timerId);
    releaseMiningLock();
    if (message) miningLog(message);
  }

  function releaseMiningLock() {
    const lock = readJsonStorage(MINING_LOCK_KEY, null);
    if (!lock || lock.tab !== tabKey) return;
    try {
      localStorage.removeItem(MINING_LOCK_KEY);
    } catch {
      // 移不掉的話 20 秒後也會過期
    }
  }

  function keepMiningLock() {
    if (!miningRunner.running) return;
    if (otherTabMining()) stopMiningRunner('同一個帳號的另一個分頁也在挖礦，這個分頁先停下');
    else writeJsonStorage(MINING_LOCK_KEY, { tab: tabKey, at: Date.now() });
  }

  // 沒在跑挖礦也定時讀角色，總覽頁、挖礦頁看得到誰在挖、挖多久、有沒有中毒；同一個帳號的分頁共用一份，不會一起讀
  function watchMining(settings) {
    if (miningRunner.running || miningWatch.busy || !dashboard.profile) return;
    if (!settings.dashboardEnabled && activeTab !== 'mining') return;
    if (lowProfile.sleepUntil > Date.now()) return;
    const data = loadMining();
    if (Date.now() - data.heroesAt < MINING_WATCH_MILLISECONDS) return;
    data.heroesAt = Date.now();
    saveMining(data);
    miningWatch.busy = true;
    readMiningHeroes(settings, { background: true })
      .catch(() => {})
      .finally(() => {
        miningWatch.busy = false;
      });
  }

  function miningHeroText(hero, data, now, settings) {
    if (hero.perished) return '死透了';
    if (hero.hp <= 0) return '死亡';
    const spText = (sp) => `體 ${Math.round(sp)}/${hero.fullSp}`;
    if (hero.actionState === 4) {
      const estimate = estimatedMiningSp(hero, data, now);
      const ready = Boolean(hero.canComplete) || Date.parse(hero.actionCompleteTime) <= now;
      const plan = settings && miningPlans(settings)[hero.id] ? new Date(miningCollectAt(settings, hero, data, now)) : null;
      const collect = plan ? `・${plan.getHours()}:${String(plan.getMinutes()).padStart(2, '0')} 收` : '';
      return `${MINING_SITES[hero.actionTarget] || '挖礦'}挖了 ${durationText(actionMinutes(hero, now))}${ready ? '' : '（未滿 3 分）'}・${estimate === null ? `開挖時${spText(hero.sp)}` : `約${spText(estimate)}`}${collect}`;
    }
    const hpText = `HP ${hero.hp}/${hero.fullHp}`;
    if (hero.actionState === 2) return `休息了 ${durationText(actionMinutes(hero, now))}・${hpText}`;
    if (hero.actionState) return `${HERO_ACTION_NAMES[hero.actionState] || '移動'}中`;
    if (!inTownHero(hero)) return '在城外';
    return `閒置・${spText(hero.sp)}・${hpText}`;
  }

  function miningReport(settings) {
    const data = loadMining();
    if (!data.heroesAt) return null;
    const plans = miningPlans(settings);
    const now = Date.now();
    return {
      at: data.heroesAt,
      heroes: data.heroes
        .filter((hero) => hero.actionState === 4 || plans[hero.id])
        .map((hero) => ({
          name: hero.name,
          planned: Boolean(plans[hero.id]),
          text: miningHeroText(hero, data, now, settings),
          conditions: heroConditions(hero).map((condition) => `${condition.name}${condition.level}`),
        })),
      last: data.log[0] || null,
    };
  }

  function renderMiningHeroes() {
    const box = panel.querySelector('[data-role="mining-heroes"]');
    if (!box) return;
    const settings = readSettingsFromPanel();
    const data = loadMining();
    const plans = miningPlans(settings);
    const queued = forgeByApiHeroIds(settings);
    const now = Date.now();
    const order = miningOrderedIds(settings, plannedMiningIds(settings));
    const rank = (hero) => (order.includes(hero.id) ? order.indexOf(hero.id) : Infinity);
    box.innerHTML = data.heroes.length
      ? data.heroes
          .slice()
          .sort((first, second) => rank(first) - rank(second) || Number(second.actionState === 4) - Number(first.actionState === 4) || (second.mining || 0) - (first.mining || 0))
          .map((hero) => {
            const position = order.indexOf(hero.id);
            const orderButtons =
              position < 0
                ? ''
                : `<span style="flex:none;white-space:nowrap">第 ${position + 1} 收 <button data-action="mining-order-up" data-hero="${hero.id}" ${position === 0 ? 'disabled' : ''}>↑</button><button data-action="mining-order-down" data-hero="${hero.id}" ${position === order.length - 1 ? 'disabled' : ''}>↓</button></span>`;
            const blocked = inHuntTeam(hero) ? '狩獵隊伍' : queued.includes(hero.id) ? '鍛造佇列' : '';
            const conditions = heroConditions(hero).map((condition) => `${condition.name}${condition.level}`);
            const options = [['', '不挖'], ...Object.entries(MINING_SITES)]
              .map(([value, name]) => `<option value="${value}" ${String(plans[hero.id] || '') === value ? 'selected' : ''}>${name}</option>`)
              .join('');
            return `<div class="row" style="margin:0;padding:3px 0;border-bottom:1px solid #2e2e34">
              <div style="flex:1;min-width:0"><b>${escapeHtml(hero.name)}</b> <span style="color:#a0a0aa">挖礦 ${hero.mining ?? '?'}</span>
                <div style="color:${hero.actionState === 4 ? '#60a5fa' : '#a0a0aa'}">${escapeHtml(miningHeroText(hero, data, now, settings))}${conditions.length ? ` <span style="color:#fb923c">${escapeHtml(conditions.join('、'))}</span>` : ''}${blocked ? ` <span style="color:#f87171">${blocked}（不會被拿去挖）</span>` : ''}</div></div>
              ${orderButtons}
              <select data-mining-hero="${hero.id}" style="flex:none;padding:3px;color:#fff;background:#2a2a30;border:1px solid #44444c;border-radius:5px">${options}</select>
            </div>`;
          })
          .join('')
      : '<div class="hint">讀取角色中…（沒出現就按「重新讀取」）</div>';
    const logBox = panel.querySelector('[data-role="mining-log"]');
    if (!logBox) return;
    logBox.innerHTML =
      data.log
        .slice(0, 10)
        .map((entry) => {
          const time = new Date(entry.t).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
          const what = entry.kind === 'mine' ? `${entry.site}挖 ${entry.minutes} 分` : `休息 ${entry.minutes} 分`;
          return `<div${entry.accident ? ' style="color:#fb923c"' : ''}>${time} ${escapeHtml(entry.name)} ${what}：${escapeHtml(entry.text || '-')}</div>`;
        })
        .join('') || '<div class="hint">還沒有</div>';
  }

  panel.addEventListener('change', (event) => {
    if (!event.target.matches || !event.target.matches('[data-mining-potion]')) return;
    const kind = event.target.dataset.miningPotion;
    const names = [...panel.querySelectorAll(`[data-mining-potion="${kind}"]:checked`)].map((input) => input.value);
    setPanelField(MINING_SUPPLIES[kind].names, names.join('、'));
    saveSettings(readSettingsFromPanel());
  });

  panel.addEventListener('change', (event) => {
    const heroId = event.target.dataset && event.target.dataset.miningHero;
    if (!heroId) return;
    const plans = miningPlans(readSettingsFromPanel());
    if (event.target.value) plans[heroId] = Number(event.target.value);
    else delete plans[heroId];
    setPanelField('miningPlans', JSON.stringify(plans));
    saveSettings(readSettingsFromPanel());
    renderMiningHeroes();
  });

  // 收益：每 10 分鐘一格記狩獵場數、隊伍拿到的經驗、撿到的道具；遊戲幣用帳號餘額的變化（含花掉的，是淨變化）。
  // 存在這個瀏覽器，同一個帳號的分頁共用；保留 8 天
  const INCOME_KEY = 'autoClickerV2Income';
  const INCOME_BUCKET_MILLISECONDS = 10 * 60000;
  const INCOME_KEEP_MILLISECONDS = 8 * 24 * 3600000;
  const MONEY_SAMPLE_MILLISECONDS = 5 * 60000;
  const INCOME_PERIODS = [
    ['近 1 小時', () => Date.now() - 3600000],
    ['近 6 小時', () => Date.now() - 6 * 3600000],
    ['今天', () => new Date().setHours(0, 0, 0, 0)],
    ['近 24 小時', () => Date.now() - 24 * 3600000],
    ['近 7 天', () => Date.now() - 7 * 24 * 3600000],
  ];
  const incomeState = { moneySampledAt: 0 };

  function loadIncome() {
    const saved = readJsonStorage(INCOME_KEY, null);
    return saved && saved.buckets ? saved : { buckets: {}, money: [] };
  }

  function saveIncome(income) {
    const keepFrom = Date.now() - INCOME_KEEP_MILLISECONDS;
    Object.keys(income.buckets).forEach((start) => {
      if (Number(start) < keepFrom) delete income.buckets[start];
    });
    income.money = income.money.filter(([time]) => time >= keepFrom);
    writeJsonStorage(INCOME_KEY, income);
  }

  function recordConsumption(name, quantity) {
    const income = loadIncome();
    const start = Math.floor(Date.now() / INCOME_BUCKET_MILLISECONDS) * INCOME_BUCKET_MILLISECONDS;
    const bucket = income.buckets[start] || (income.buckets[start] = { battles: 0, exp: 0, items: {} });
    bucket.used = bucket.used || {};
    bucket.used[name] = (bucket.used[name] || 0) + quantity;
    saveIncome(income);
    if (activeTab === 'income') renderIncome();
  }

  function recordIncome(data) {
    const { report } = data;
    if (!report || !Array.isArray(report.messages)) return;
    let exp = 0;
    // 「每位英雄獲得了 2 點經驗值」是每人各拿，要乘上隊伍人數
    const teamSize = (data.huntInfo && Array.isArray(data.huntInfo.heroes) && data.huntInfo.heroes.length) || (state.huntTeamIds || []).length || 1;
    report.messages.forEach((message) => {
      const match = HUNT_EXP_PATTERN.exec(String(message.m || '').trim());
      if (match) exp += messageNumber(match[2]) * (/每位/.test(match[1]) ? teamSize : 1);
    });
    const income = loadIncome();
    const start = Math.floor(Date.now() / INCOME_BUCKET_MILLISECONDS) * INCOME_BUCKET_MILLISECONDS;
    const bucket = income.buckets[start] || (income.buckets[start] = { battles: 0, exp: 0, items: {} });
    bucket.battles++;
    bucket.exp += exp;
    parseLoot(report.messages).forEach(([name, quantity]) => {
      bucket.items[name] = (bucket.items[name] || 0) + quantity;
    });
    saveIncome(income);
  }

  // 同樣的餘額 1 分鐘內不重複記
  function recordMoney(money) {
    if (typeof money !== 'number') return;
    const income = loadIncome();
    const last = income.money[income.money.length - 1];
    if (last && last[1] === money && Date.now() - last[0] < 60000) return;
    income.money.push([Date.now(), money]);
    saveIncome(income);
  }

  async function sampleMoney(settings) {
    if (tabShutDown || !settings.incomeEnabled || Date.now() - incomeState.moneySampledAt < MONEY_SAMPLE_MILLISECONDS) return;
    incomeState.moneySampledAt = Date.now();
    try {
      const profile = await requestGameApi(PROFILE_API, { background: true });
      rememberProfile(profile);
      recordMoney(profile.money);
    } catch {
      // 讀不到就下次再記
    }
  }

  // 收支：每次看到遊戲幣餘額（狩獵回應、/api/profile、其他動作的回應）就跟上一次看到的比，差額照來源分類。
  // 狩獵只認戰報裡寫明的錢（收租金、盜取）；拍賣（交易所）的錢另外記、不算進收支。別人買走你上架的東西是被動入帳，
  // 發生在兩次看到餘額之間、沒有對應的動作，所以這種不明入帳都當成拍賣售出。
  // 上一次的餘額存在 localStorage，同帳號開好幾個分頁也只算一次
  const LAST_MONEY_KEY = 'autoClickerV2LastMoney';
  // 太久沒看到餘額（例如關機一晚）中間發生什麼分不出來，那段差額就不歸類
  const MONEY_GAP_LIMIT_MILLISECONDS = 30 * 60000;
  const HUNT_MONEY_PATTERN = /(收到了|盜取了|獲得了|撿到了?)\s*([\d,]+)\s*(元|租金|金幣)\s*$/;
  const MARKET_API_PATTERN = /\/api\/(?:trades|market|releasedHeroMarket)/;
  const MONEY_API_PATTERN = /\/api\/profile(?:[?#]|$)/;

  function huntMessageMoney(messages) {
    const parts = {};
    (messages || []).forEach((message) => {
      const match = HUNT_MONEY_PATTERN.exec(String(message.m || '').trim());
      if (!match) return;
      const label = match[3] === '租金' ? '租金' : match[1] === '盜取了' ? '盜取' : '撿到錢';
      parts[label] = (parts[label] || 0) + messageNumber(match[2]);
    });
    return parts;
  }

  // 花了錢、回應卻沒帶餘額的動作（信仰捐獻、賭場、擴充欄位…）：先記著，下次看到餘額時這段差額算它的
  const MONEY_ACTION_KEY = 'autoClickerV2MoneyAction';
  const MONEY_ACTION_MILLISECONDS = 5 * 60000;
  // 只記會花錢的；移動、吃藥這類也是 POST，記了會把之後的被搶、拍賣算到它頭上
  const MONEY_ACTION_PATTERN = /\/api\/(?:beliefs|expand|monument|casino)|\/(?:revive|reincarnate)/;

  function rememberMoneyAction(url) {
    if (!MONEY_ACTION_PATTERN.test(url)) return;
    writeJsonStorage(MONEY_ACTION_KEY, { path: new URL(url, location.href).pathname, at: Date.now() });
  }

  // 被搶只有 /api/profile 的 robbedMoney（累計被搶走的錢）看得到；那時錢的差額多半已經在狩獵回應裡算成不明支出了，
  // 所以回頭把最近的不明支出改記成被搶
  function reclassifyRobbery(amount) {
    const income = loadIncome();
    let left = amount;
    Object.keys(income.buckets)
      .map(Number)
      .filter((start) => start >= Date.now() - MONEY_GAP_LIMIT_MILLISECONDS - INCOME_BUCKET_MILLISECONDS)
      .sort((first, second) => second - first)
      .forEach((start) => {
        const out = income.buckets[start].moneyOut;
        const unknown = out && out[UNKNOWN_SPENT_LABEL];
        if (!left || !unknown) return;
        const moved = Math.min(left, unknown);
        out[UNKNOWN_SPENT_LABEL] -= moved;
        if (!out[UNKNOWN_SPENT_LABEL]) delete out[UNKNOWN_SPENT_LABEL];
        out['被搶'] = (out['被搶'] || 0) + moved;
        left -= moved;
      });
    if (left < amount) saveIncome(income);
    return amount - left;
  }

  function moneySourceLabel(path) {
    if (/\/attack/.test(path)) return '打劫';
    if (/\/api\/beliefs/.test(path)) return '信仰捐獻';
    if (/\/api\/expand/.test(path)) return '擴充欄位';
    if (/\/revive/.test(path)) return '復活';
    if (/\/reincarnate/.test(path)) return '轉生';
    if (/\/api\/monument/.test(path)) return '紀念碑';
    if (/recycle/i.test(path)) return '回收';
    if (/\/api\/forge|complete(?:Forge|Action)/.test(path)) return '鍛造';
    if (/\/api\/(?:items|mines)/.test(path)) return '道具';
    if (/\/api\/equipments/.test(path)) return '裝備';
    if (/\/api\/casino/i.test(path)) return '賭場';
    return path.replace(/^\/api\//, '').split('/')[0] || '其他';
  }

  const UNKNOWN_SPENT_LABEL = '不明支出（被搶等）';

  function recordMoneyChange(money, url, method, known = {}, robbedMoney) {
    const last = readJsonStorage(LAST_MONEY_KEY, null);
    const robbedBefore = last && typeof last.robbed === 'number' ? last.robbed : null;
    writeJsonStorage(LAST_MONEY_KEY, { money, at: Date.now(), robbed: typeof robbedMoney === 'number' ? robbedMoney : robbedBefore });
    let robbed = typeof robbedMoney === 'number' && robbedBefore !== null ? Math.max(0, robbedMoney - robbedBefore) : 0;
    if (robbed) robbed -= reclassifyRobbery(robbed);
    if (!last || typeof last.money !== 'number' || Date.now() - last.at > MONEY_GAP_LIMIT_MILLISECONDS) return;
    const delta = money - last.money;
    const path = new URL(url, location.href).pathname;
    const changes = [];
    let rest = delta;
    if (method !== 'GET' && MARKET_API_PATTERN.test(path)) {
      changes.push(['market', '拍賣', delta]);
      rest = 0;
    } else {
      Object.entries(known).forEach(([label, amount]) => {
        changes.push(['in', label, amount]);
        rest -= amount;
      });
      // 狩獵以外的動作（回收、鍛造、買東西…）差額就是這個動作造成的
      if (method !== 'GET' && !HUNT_API_PATTERN.test(path) && rest) {
        changes.push([rest > 0 ? 'in' : 'out', moneySourceLabel(path), rest]);
        rest = 0;
      }
    }
    if (rest < 0 && robbed) {
      const amount = Math.min(robbed, -rest);
      changes.push(['out', '被搶', -amount]);
      rest += amount;
    }
    const action = readJsonStorage(MONEY_ACTION_KEY, null);
    if (rest && action && action.at >= last.at && Date.now() - action.at < MONEY_ACTION_MILLISECONDS) {
      changes.push([rest > 0 ? 'in' : 'out', moneySourceLabel(action.path), rest]);
      rest = 0;
      writeJsonStorage(MONEY_ACTION_KEY, null);
    }
    if (rest > 0) changes.push(['market', '不明入帳（多半是拍賣售出）', rest]);
    else if (rest < 0) changes.push(['out', UNKNOWN_SPENT_LABEL, rest]);
    if (!changes.some(([, , amount]) => amount)) return;
    const income = loadIncome();
    const start = Math.floor(Date.now() / INCOME_BUCKET_MILLISECONDS) * INCOME_BUCKET_MILLISECONDS;
    const bucket = income.buckets[start] || (income.buckets[start] = { battles: 0, exp: 0, items: {} });
    changes.forEach(([kind, label, amount]) => {
      if (!amount) return;
      const field = kind === 'market' ? 'moneyMarket' : kind === 'in' ? 'moneyIn' : 'moneyOut';
      bucket[field] = bucket[field] || {};
      bucket[field][label] = (bucket[field][label] || 0) + (kind === 'out' ? -amount : amount);
    });
    saveIncome(income);
  }

  function incomeSummary(from, to = Date.now()) {
    const income = loadIncome();
    const summary = { battles: 0, exp: 0, itemCount: 0, items: {}, usedCount: 0, used: {}, money: null, moneyIn: {}, moneyOut: {}, moneyMarket: {}, earned: 0, spent: 0, market: 0 };
    Object.entries(income.buckets).forEach(([start, bucket]) => {
      // 格子跟期間有重疊就算進來（10 分鐘一格，誤差最多 10 分鐘）
      if (Number(start) + INCOME_BUCKET_MILLISECONDS <= from || Number(start) > to) return;
      summary.battles += bucket.battles;
      summary.exp += bucket.exp;
      Object.entries(bucket.items).forEach(([name, quantity]) => {
        summary.items[name] = (summary.items[name] || 0) + quantity;
        summary.itemCount += quantity;
      });
      Object.entries(bucket.used || {}).forEach(([name, quantity]) => {
        summary.used[name] = (summary.used[name] || 0) + quantity;
        summary.usedCount += quantity;
      });
      [['moneyIn', 'earned'], ['moneyOut', 'spent'], ['moneyMarket', 'market']].forEach(([field, totalField]) => {
        Object.entries(bucket[field] || {}).forEach(([label, amount]) => {
          summary[field][label] = (summary[field][label] || 0) + amount;
          summary[totalField] += amount;
        });
      });
    });
    summary.net = summary.earned - summary.spent;
    // 遊戲幣：期間開始前最後一筆（沒有就用期間內第一筆）到最新一筆的差
    const samples = income.money.filter(([time]) => time <= to);
    const before = [...samples].reverse().find(([time]) => time <= from) || samples.find(([time]) => time >= from);
    const latest = samples[samples.length - 1];
    if (before && latest && latest[0] > before[0]) summary.money = latest[1] - before[1];
    return summary;
  }

  function formatSigned(value) {
    if (value === null) return '-';
    return `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString()}`;
  }

  function rareLootNames(settings = readSettingsFromPanel()) {
    return String(settings.lootRareNames || '')
      .split(/[,，、]/)
      .map((name) => name.trim())
      .filter(Boolean);
  }

  // 總覽頁只放得下幾樣：照數量排的話，撿到 1 張英雄券會被一大堆普通掉落擠掉，所以稀有道具一定放前面
  const TOP_LOOT_COUNT = 8;
  function topLootItems(items) {
    const rareNames = rareLootNames();
    const isRare = ([name]) => rareNames.some((rareName) => name.includes(rareName));
    const byQuantity = Object.entries(items).sort(([, first], [, second]) => second - first);
    const rare = byQuantity.filter(isRare);
    return [...rare, ...byQuantity.filter((entry) => !isRare(entry)).slice(0, Math.max(0, TOP_LOOT_COUNT - rare.length))];
  }

  // 給總覽頁：近 1 小時與今天
  // 總覽頁可以切換期間，所以各期間都給；每次回報都要重算 5 次，30 秒內沿用上次的
  const INCOME_REPORT_FRESH_MILLISECONDS = 30000;
  let cachedIncomeReport = { at: 0, report: null };
  function incomeReport() {
    if (cachedIncomeReport.report && Date.now() - cachedIncomeReport.at < INCOME_REPORT_FRESH_MILLISECONDS) return cachedIncomeReport.report;
    const brief = (summary, from) => ({
      battles: summary.battles,
      exp: summary.exp,
      items: summary.itemCount,
      money: summary.money,
      earned: summary.earned,
      spent: summary.spent,
      net: summary.net,
      market: summary.market,
      topIn: Object.entries(summary.moneyIn).sort(([, first], [, second]) => second - first).slice(0, 5),
      topOut: Object.entries(summary.moneyOut).sort(([, first], [, second]) => second - first).slice(0, 5),
      hours: (Date.now() - from) / 3600000,
      topItems: topLootItems(summary.items),
      used: summary.usedCount,
      topUsed: Object.entries(summary.used)
        .sort(([, first], [, second]) => second - first)
        .slice(0, 6),
    });
    const periods = {
      hour: Date.now() - 3600000,
      six: Date.now() - 6 * 3600000,
      today: new Date().setHours(0, 0, 0, 0),
      day: Date.now() - 24 * 3600000,
      week: Date.now() - 7 * 24 * 3600000,
    };
    const report = Object.fromEntries(Object.entries(periods).map(([key, from]) => [key, brief(incomeSummary(from), from)]));
    cachedIncomeReport = { at: Date.now(), report };
    return report;
  }

  function renderIncome() {
    const periodSelect = panel.querySelector('[data-role="income-period"]');
    const periodIndex = Number(periodSelect.value) || 0;
    const rows = INCOME_PERIODS.map(([label, from], index) => {
      const summary = incomeSummary(from());
      const hours = Math.max(1 / 6, (Date.now() - from()) / 3600000);
      return `<tr style="${index === periodIndex ? 'background:#26262b' : ''}"><td>${label}</td><td>${summary.battles.toLocaleString()}</td><td>${summary.exp.toLocaleString()}</td>
        <td>${Math.round(summary.exp / hours).toLocaleString()}</td><td>${summary.itemCount.toLocaleString()}</td><td>${summary.usedCount.toLocaleString()}</td>
        <td style="color:#4ade80">${formatSigned(summary.earned)}</td><td style="color:#f87171">${summary.spent ? `-${Math.round(summary.spent).toLocaleString()}` : '0'}</td>
        <td style="color:${summary.net >= 0 ? '#4ade80' : '#f87171'};font-weight:bold">${formatSigned(summary.net)}</td></tr>`;
    }).join('');
    // 近 24 小時每小時的經驗長條
    const hourly = Array.from({ length: 24 }, (_, index) => {
      const end = Date.now() - (23 - index) * 3600000;
      return { end, exp: incomeSummary(end - 3600000, end - 1).exp };
    });
    const maxExp = Math.max(1, ...hourly.map(({ exp }) => exp));
    const bars = hourly
      .map(
        ({ end, exp }) =>
          `<div title="${new Date(end).getHours()} 點前一小時：${exp.toLocaleString()} 經驗" style="flex:1;align-self:flex-end;height:${Math.max(2, (exp / maxExp) * 100)}%;background:${exp ? '#60a5fa' : '#33333a'}"></div>`
      )
      .join('');
    const selected = incomeSummary(INCOME_PERIODS[periodIndex][1]());
    const items = Object.entries(selected.items)
      .sort(([, first], [, second]) => second - first)
      .map(([name, quantity]) => `<tr><td>${escapeHtml(name)}</td><td>${quantity.toLocaleString()}</td></tr>`)
      .join('');
    const used = Object.entries(selected.used)
      .sort(([, first], [, second]) => second - first)
      .map(([name, quantity]) => `<tr><td>${escapeHtml(name)}</td><td>${quantity.toLocaleString()}</td></tr>`)
      .join('');
    const moneyRow = (label, amount, color, note = '') =>
      `<tr><td>${escapeHtml(label)}${note}</td><td style="color:${color}">${formatSigned(amount)}</td></tr>`;
    const moneyRows = [
      ...Object.entries(selected.moneyIn).sort(([, first], [, second]) => second - first).map(([label, amount]) => moneyRow(label, amount, '#4ade80')),
      ...Object.entries(selected.moneyOut).sort(([, first], [, second]) => second - first).map(([label, amount]) => moneyRow(label, -amount, '#f87171')),
      ...Object.entries(selected.moneyMarket).map(([label, amount]) => moneyRow(label, amount, '#a0a0aa', '（不計）')),
    ].join('');
    panel.querySelector('[data-role="income"]').innerHTML = `
      <table class="combat"><tr><th>期間</th><th>場</th><th>經驗</th><th>經驗/時</th><th>撿到</th><th>吃掉</th><th>收入</th><th>支出</th><th>純收益</th></tr>${rows}</table>
      <div class="hint">經驗＝整隊加總。收入／支出照來源分：狩獵只算戰報寫明的錢（租金、盜取），回收、鍛造、買東西照動作算；拍賣的錢不算（含不明入帳，多半是拍賣售出）。純收益＝收入－支出</div>
      <div class="subhead">錢的來源（${INCOME_PERIODS[periodIndex][0]}）</div>
      ${moneyRows ? `<table class="combat"><tr><th>來源</th><th>金額</th></tr>${moneyRows}</table>` : '<div class="hint">這段期間沒有錢的進出（改版後才開始記）</div>'}
      <div class="subhead">近 24 小時經驗（每小時）</div>
      <div style="display:flex;gap:1px;height:50px;align-items:flex-end">${bars}</div>
      <div class="subhead">撿到的道具（${INCOME_PERIODS[periodIndex][0]}）</div>
      ${items ? `<table class="combat"><tr><th>道具</th><th>數量</th></tr>${items}</table>` : '<div class="hint">這段期間沒有撿到道具</div>'}
      <div class="subhead">吃掉的補品（${INCOME_PERIODS[periodIndex][0]}）</div>
      ${used ? `<table class="combat"><tr><th>道具</th><th>數量</th></tr>${used}</table>` : '<div class="hint">這段期間沒有吃補品</div>'}`;
  }

  // 狩獵統計：每個地點（地圖＋關卡）的場數、每人每場經驗、每場秒數、HP／體力耗損、前進成功率、掉落。
  // 全部從 /api/hunt 的回應算，不讀畫面；存在這個瀏覽器
  const HUNT_STATS_KEY = 'autoClickerV2HuntStats';
  const RECENT_LOOT_LIMIT = 50;
  // 兩場之間隔太久（停下來、換地圖、補給很久）就不算進每場秒數
  const HUNT_GAP_LIMIT_MILLISECONDS = 180000;
  // 「獲得了兔皮 × 4」「獲得了兔皮」（沒寫數量＝1 個）「盜寶哥布林盜取了體力藥水 小」都算；偷到錢、收租金不算道具
  const LOOT_LINE_PATTERN = /(?:獲得了|拾獲了?|撿到了?|挖到了?|掉落了?|盜取了)\s*(.+?)(?:\s*[×xX*＊]\s*([\d,]+))?\s*$/;
  // 「獲得了 N 點…」這類數值句也不是道具
  const LOOT_NOT_ITEM_PATTERN = /經驗|\d\s*(?:元|租金)\s*$|\d\s*點/;
  const HUNT_EXP_PATTERN = /^(.+?)獲得了\s*([\d,]+)\s*點經驗值/;
  const lastHunt = { place: '', at: 0, stage: null };

  function emptyPlaceStats() {
    return {
      battles: 0, expSum: 0, expSamples: 0, seconds: 0, timedBattles: 0,
      hpLoss: 0, spLoss: 0, lossSamples: 0, forwardTries: 0, forwardSuccess: 0, loot: {},
    };
  }

  function loadHuntStats() {
    const saved = readJsonStorage(HUNT_STATS_KEY, null);
    return saved && saved.places ? saved : { places: {}, recent: [] };
  }

  function messageNumber(text) {
    return Number(String(text).replace(/,/g, '')) || 0;
  }

  function parseLoot(messages) {
    return messages
      .map((message) => String(message.m || '').trim())
      .filter((text) => text && !LOOT_NOT_ITEM_PATTERN.test(text))
      .map((text) => LOOT_LINE_PATTERN.exec(text))
      .filter(Boolean)
      .map((match) => [match[1].trim(), messageNumber(match[2]) || 1]);
  }

  function recordHuntStats(data, requestBody, settings, url = '') {
    const { report, huntInfo } = data;
    if (!report || !Array.isArray(report.messages) || !huntInfo) return;
    const battleStage = Number(report.stage) || Number(huntInfo.huntStage) || 0;
    const zoneName = huntInfo.zoneName || '';
    const place = battleStage ? `${zoneName} ${battleStage}` : zoneName;
    const saved = loadHuntStats();
    const stats = saved.places[place] || (saved.places[place] = emptyPlaceStats());
    stats.battles++;
    report.messages.forEach((message) => {
      const match = HUNT_EXP_PATTERN.exec(String(message.m || '').trim());
      if (!match) return;
      stats.expSum += messageNumber(match[2]);
      stats.expSamples++;
    });
    const now = Date.now();
    if (lastHunt.place === place && now - lastHunt.at < HUNT_GAP_LIMIT_MILLISECONDS) {
      stats.seconds += (now - lastHunt.at) / 1000;
      stats.timedBattles++;
    }
    // report.a 是開打時我方的狀態，跟戰後的隊伍資料比就是這場的耗損
    const after = new Map((huntInfo.heroes || []).map((hero) => [hero.name, hero]));
    (Array.isArray(report.a) ? report.a : []).forEach((start) => {
      const end = start && after.get(start.name);
      if (!end || !(end.fullHp > 0) || !(end.fullSp > 0) || typeof start.hp !== 'number' || typeof start.sp !== 'number') return;
      stats.hpLoss += (Math.max(0, start.hp - end.hp) / end.fullHp) * 100;
      stats.spLoss += (Math.max(0, start.sp - end.sp) / end.fullSp) * 100;
      stats.lossSamples++;
    });
    // 前進算在出發的那一層；剛開頁面還不知道前一層就不算
    let huntType = (parseJsonText(requestBody) || {}).type;
    try {
      huntType = new URL(url, location.href).searchParams.get('type') || huntType;
    } catch {
      // 網址怪怪的就照送出的內容
    }
    if (huntType === 'forward' && lastHunt.stage) {
      const fromPlace = `${zoneName} ${lastHunt.stage}`;
      const from = saved.places[fromPlace] || (saved.places[fromPlace] = emptyPlaceStats());
      from.forwardTries++;
      if (Number(huntInfo.huntStage) > lastHunt.stage) from.forwardSuccess++;
    }
    Object.assign(lastHunt, { place, at: now, stage: Number(huntInfo.huntStage) || null });
    const loot = parseLoot(report.messages);
    loot.forEach(([name, quantity]) => {
      const entry = stats.loot[name] || (stats.loot[name] = { drops: 0, quantity: 0 });
      entry.drops++;
      entry.quantity += quantity;
      saved.recent.unshift({ t: now, place, name, quantity });
    });
    saved.recent.length = Math.min(saved.recent.length, RECENT_LOOT_LIMIT);
    writeJsonStorage(HUNT_STATS_KEY, saved);
    alertRareLoot(loot, place, settings);
    if (activeTab === 'huntStats') renderHuntStats();
  }

  // 戰報裡寫了是誰拿到的（「盜寶哥布林盜取了 173 元」「盜寶哥布林盜取了體力藥水 小」）：照角色另外記，
  // 看得出誰在幫你賺。沒寫是誰的（「獲得了兔皮 × 4」）只算在上面的掉落
  const ACTOR_LOOT_KEY = 'autoClickerV2ActorLoot';
  const ACTOR_LOOT_DAYS = 14;
  const ACTOR_LOOT_RECENT = 100;
  const ACTOR_LINE_PATTERN = /^(.+?)(盜取了|獲得了|拾獲了?|撿到了?|挖到了?|收到了)\s*(.+?)(?:\s*[×xX*＊]\s*([\d,]+))?\s*$/;
  const ACTOR_MONEY_PATTERN = /^([\d,]+)\s*(元|租金|金幣)$/;
  // 句子開頭不是名字的（「每位英雄獲得了…」「戰鬥結束，獲得了…」）不算
  const NOT_ACTOR_PATTERN = /^(?:每位|全隊|你)|[，,。！!：:]/;

  function parseActorLoot(messages) {
    return (messages || [])
      .map((message) => String(message.m || '').trim())
      .filter((text) => text && !/經驗|\d\s*點/.test(text))
      .map((text) => ACTOR_LINE_PATTERN.exec(text))
      .filter((match) => match && match[1].trim() && !NOT_ACTOR_PATTERN.test(match[1].trim()))
      .map((match) => {
        const actor = match[1].trim();
        const verb = match[2].replace(/了$/, '');
        const what = match[3].trim();
        const money = ACTOR_MONEY_PATTERN.exec(what);
        return money
          ? { actor, verb, money: messageNumber(money[1]), unit: money[2] }
          : { actor, verb, item: what, quantity: messageNumber(match[4]) || 1 };
      });
  }

  function loadActorLoot() {
    const saved = readJsonStorage(ACTOR_LOOT_KEY, null);
    return saved && saved.days ? saved : { days: {}, recent: [] };
  }

  function recordActorLoot(data) {
    const report = data && data.report;
    if (!report || !Array.isArray(report.messages)) return;
    const found = parseActorLoot(report.messages);
    if (!found.length) return;
    // report.a 是我方；不在裡面的（例如敵人偷你的東西）另外標
    const ours = new Set((Array.isArray(report.a) ? report.a : []).map((hero) => hero && hero.name));
    const saved = loadActorLoot();
    const now = Date.now();
    const day = saved.days[localDayKey(now)] || (saved.days[localDayKey(now)] = {});
    found.forEach((entry) => {
      const actor = day[entry.actor] || (day[entry.actor] = { ours: false, money: {}, items: {} });
      actor.ours = actor.ours || ours.has(entry.actor);
      if ('money' in entry) actor.money[entry.verb] = (actor.money[entry.verb] || 0) + entry.money;
      else actor.items[`${entry.verb} ${entry.item}`] = (actor.items[`${entry.verb} ${entry.item}`] || 0) + entry.quantity;
      saved.recent.unshift({ t: now, ...entry });
    });
    saved.recent.length = Math.min(saved.recent.length, ACTOR_LOOT_RECENT);
    Object.keys(saved.days)
      .sort()
      .slice(0, -ACTOR_LOOT_DAYS)
      .forEach((key) => delete saved.days[key]);
    writeJsonStorage(ACTOR_LOOT_KEY, saved);
    if (activeTab === 'huntStats') renderActorLoot();
  }

  // 總覽頁用：今天每個角色拿到的錢（照動作分）和道具件數
  function actorLootReport() {
    const today = loadActorLoot().days[localDayKey(Date.now())] || {};
    return Object.entries(today).map(([name, actor]) => ({
      name,
      ours: actor.ours,
      money: actor.money,
      items: Object.values(actor.items).reduce((sum, quantity) => sum + quantity, 0),
      topItems: Object.entries(actor.items)
        .sort(([, first], [, second]) => second - first)
        .slice(0, 3),
    }));
  }

  function renderActorLoot() {
    const box = panel.querySelector('[data-role="actor-loot"]');
    if (!box) return;
    const days = Number(panel.querySelector('[data-role="actor-loot-period"]').value) || 1;
    const saved = loadActorLoot();
    const totals = {};
    Array.from({ length: days }, (_, index) => localDayKey(Date.now() - index * 86400000)).forEach((key) => {
      Object.entries(saved.days[key] || {}).forEach(([name, actor]) => {
        const total = totals[name] || (totals[name] = { ours: false, money: {}, items: {} });
        total.ours = total.ours || actor.ours;
        Object.entries(actor.money).forEach(([verb, amount]) => (total.money[verb] = (total.money[verb] || 0) + amount));
        Object.entries(actor.items).forEach(([item, quantity]) => (total.items[item] = (total.items[item] || 0) + quantity));
      });
    });
    const moneySum = (actor) => Object.values(actor.money).reduce((sum, amount) => sum + amount, 0);
    const names = Object.keys(totals).sort((first, second) => moneySum(totals[second]) - moneySum(totals[first]));
    if (!names.length) {
      box.innerHTML = '<div class="hint">還沒有：戰報寫「某某盜取了…」「某某撿到了…」這種有名字的才會記在這裡</div>';
      return;
    }
    const rows = names
      .map((name) => {
        const actor = totals[name];
        const money = Object.entries(actor.money).map(([verb, amount]) => `${escapeHtml(verb)} $${amount.toLocaleString()}`).join('<br>');
        const items = Object.entries(actor.items)
          .sort(([, first], [, second]) => second - first)
          .map(([item, quantity]) => `${escapeHtml(item)}×${quantity}`)
          .join('、');
        return `<tr><td>${escapeHtml(name)}${actor.ours ? '' : '<div style="color:#f87171">不是我方</div>'}</td><td>${money || '-'}</td><td style="white-space:normal">${items || '-'}</td></tr>`;
      })
      .join('');
    const recent = saved.recent
      .slice(0, 10)
      .map((entry) => {
        const time = new Date(entry.t).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const what = 'money' in entry ? `${entry.money.toLocaleString()} ${entry.unit || '元'}` : `${entry.item}${entry.quantity > 1 ? ` ×${entry.quantity}` : ''}`;
        return `<div>${time} ${escapeHtml(entry.actor)} ${escapeHtml(entry.verb)} ${escapeHtml(what)}</div>`;
      })
      .join('');
    box.innerHTML = `<table class="combat"><tr><th>誰</th><th>錢</th><th>道具</th></tr>${rows}</table>
      <div class="hint" style="margin-top:4px">最近 10 筆</div>${recent}`;
  }

  // 名稱有包含就算（「英雄券」也會對到「高級英雄券」）；只提醒時用右下角小提示，不打斷
  function alertRareLoot(loot, place, settings) {
    const rareNames = rareLootNames(settings);
    const rare = loot.filter(([name]) => rareNames.some((rareName) => name.includes(rareName)));
    if (!rare.length) return;
    const message = `撿到稀有道具：${rare.map(([name, quantity]) => `${name} ×${quantity}`).join('、')}（${place}）`;
    if (settings.lootRarePause && state.running) pauseWithAlert(message);
    else {
      setStatus(message);
      showToast(message);
    }
  }

  // 公式來自社群工具箱（SGO 多功能工具箱），升級經驗已用實際資料驗證（Lv15 → 4517），轉生點數沒驗證過
  function levelUpExp(level) {
    return 1.25 * level ** 3 + 16 * level + 58;
  }

  function reincarnationPoints(level) {
    if (level <= 16) return 0;
    if (level <= 30) return level - 16;
    const over = level - 30;
    const groups = Math.floor(over / 5);
    return 14 + 2 * over + (5 * groups * (groups - 1)) / 2 + (over % 5) * groups;
  }

  // 從 1 等練到幾等轉生，每小時拿到的轉生點數最多（假設一路都在這一層、每場經驗不變）
  function bestReincarnationLevel(expPerBattle, secondsPerBattle) {
    if (!(expPerBattle > 0) || !(secondsPerBattle >= 1)) return null;
    let best = null;
    let totalExp = 0;
    for (let level = 2; level <= 150; level++) {
      totalExp += levelUpExp(level - 1);
      const points = reincarnationPoints(level);
      if (!points) continue;
      const hours = ((totalExp / expPerBattle) * secondsPerBattle) / 3600;
      const rate = points / hours;
      if (!best || rate > best.rate) best = { level, points, hours, rate };
    }
    return best;
  }

  function placeSummary(stats) {
    return {
      expPerHero: stats.expSamples ? stats.expSum / stats.expSamples : null,
      secondsPerBattle: stats.timedBattles ? stats.seconds / stats.timedBattles : null,
      hpLoss: stats.lossSamples ? stats.hpLoss / stats.lossSamples : null,
      spLoss: stats.lossSamples ? stats.spLoss / stats.lossSamples : null,
      forwardRate: stats.forwardTries ? stats.forwardSuccess / stats.forwardTries : null,
    };
  }

  function formatMaybe(value, digits = 0, suffix = '') {
    return value === null ? '-' : `${value.toFixed(digits)}${suffix}`;
  }

  function renderHuntStats() {
    const saved = loadHuntStats();
    const places = Object.keys(saved.places)
      .filter((place) => saved.places[place].battles)
      .sort(growthTracker.comparePlaces);
    const select = panel.querySelector('[data-role="hunt-stats-place"]');
    const previous = select.value;
    select.innerHTML = places.map((place) => `<option>${escapeHtml(place)}</option>`).join('') || '<option value="">還沒有資料</option>';
    if (places.includes(previous)) select.value = previous;
    else if (lastHunt.place && places.includes(lastHunt.place)) select.value = lastHunt.place;
    const box = panel.querySelector('[data-role="hunt-stats"]');
    if (!places.length) {
      box.innerHTML = '<div class="hint">掛機打幾場之後就會開始統計</div>';
      return;
    }
    const rows = places
      .map((place) => {
        const stats = saved.places[place];
        const summary = placeSummary(stats);
        return `<tr><td>${escapeHtml(place)}</td><td>${stats.battles}</td><td>${formatMaybe(summary.expPerHero)}</td>
          <td>${formatMaybe(summary.secondsPerBattle)}</td><td>${formatMaybe(summary.hpLoss, 1)}</td><td>${formatMaybe(summary.spLoss, 1)}</td>
          <td>${summary.forwardRate === null ? '-' : `${Math.round(summary.forwardRate * 100)}%`}</td></tr>`;
      })
      .join('');
    // 轉生：每個地點都算一次最佳等級，挑每小時點數最多的
    const plans = places
      .map((place) => {
        const summary = placeSummary(saved.places[place]);
        return { place, plan: bestReincarnationLevel(summary.expPerHero, summary.secondsPerBattle) };
      })
      .filter(({ plan }) => plan)
      .sort((first, second) => second.plan.rate - first.plan.rate);
    const planText = ({ place, plan }) =>
      `${escapeHtml(place)}：練到 Lv${plan.level} 轉生，得 ${plan.points} 點、約 ${plan.hours.toFixed(1)} 小時，每小時 ${plan.rate.toFixed(2)} 點`;
    const selected = saved.places[select.value];
    const loot = selected
      ? Object.entries(selected.loot)
          .sort(([, first], [, second]) => second.drops - first.drops)
          .map(
            ([name, entry]) =>
              `<tr><td>${escapeHtml(name)}</td><td>${((entry.drops / selected.battles) * 100).toFixed(1)}%</td><td>${(entry.quantity / entry.drops).toFixed(1)}</td><td>${entry.quantity}</td></tr>`
          )
          .join('')
      : '';
    const selectedPlan = plans.find(({ place }) => place === select.value);
    box.innerHTML = `
      <table class="combat"><tr><th>地點</th><th>場</th><th>經驗/人</th><th>秒/場</th><th>HP%</th><th>體%</th><th>前進</th></tr>${rows}</table>
      <div class="hint">經驗/人＝每人每場；HP%、體%＝每場平均掉最大值的幾 %；前進＝按前進成功往下一層的比例</div>
      <div class="subhead">轉生練等（每隻角色）</div>
      <div style="font-size:12px">${plans.length ? `最划算：${planText(plans[0])}` : '<span class="hint">要有經驗與每場秒數才算得出來</span>'}
        ${selectedPlan && selectedPlan !== plans[0] ? `<div>這層：${planText(selectedPlan)}</div>` : ''}</div>
      <div class="hint">假設從 1 等起一路在同一層、每場經驗不變；轉生點數公式取自社群工具箱，未驗證</div>
      <div class="subhead">掉落：${escapeHtml(select.value)}（${selected ? selected.battles : 0} 場）</div>
      ${loot ? `<table class="combat"><tr><th>道具</th><th>掉率</th><th>平均</th><th>總數</th></tr>${loot}</table>` : '<div class="hint">這層還沒有掉落</div>'}
      <div class="subhead">最近掉落</div>
      <div style="font-size:11px;max-height:120px;overflow:auto">${
        saved.recent
          .map((entry) => `<div>${new Date(entry.t).toLocaleTimeString('zh-TW', { hour12: false })} ${escapeHtml(entry.place)} ${escapeHtml(entry.name)} ×${entry.quantity}</div>`)
          .join('') || '<span class="hint">還沒有</span>'
      }</div>`;
  }

  // 同名的卡可能好幾張，加上編號、Tier、潛力才分得出來
  function cardLabel(card) {
    const traits = [card.tier && `Tier ${card.tier}`, card.potential && `潛力 ${card.potential}`, `${card.levelUps} 級`].filter(Boolean);
    return `${card.name} #${card.heroId}（${traits.join('・')}）`;
  }

  function renderGrowthSummary() {
    renderGrowthPlaces();
    const summaries = growthTracker.cardSummaries();
    const select = panel.querySelector('[data-role="growth-type"]');
    const previous = select.value;
    const byType = new Map();
    summaries.forEach((summary) => byType.set(summary.type, [...(byType.get(summary.type) || []), summary]));
    select.innerHTML =
      [...byType.entries()]
        .map(
          ([type, cards]) =>
            `<optgroup label="${escapeHtml(type)}">${cards
              .map((card) => `<option value="${escapeHtml(card.heroId)}">${escapeHtml(cardLabel(card))}</option>`)
              .join('')}</optgroup>`
        )
        .join('') || '<option value="">還沒有成長紀錄</option>';
    if (summaries.some((summary) => summary.heroId === previous)) select.value = previous;
    const summary = summaries.find((candidate) => candidate.heroId === select.value);
    const box = panel.querySelector('[data-role="growth-summary"]');
    if (!summary) {
      box.innerHTML = '<div class="hint">角色升級後會開始累積，也可以匯入別人的紀錄</div>';
      return;
    }
    const rows = growthTracker.sharedStatNames
      .filter((zhName) => summary.stats[zhName])
      .map((zhName) => {
        const stat = summary.stats[zhName];
        const range = stat.min === null ? '-' : stat.min === stat.max ? String(stat.min) : `${stat.min}~${stat.max}`;
        return `<tr><td>${zhName}</td><td>${formatGrowth(stat.avg)}</td><td>${range}</td><td>${stat.samples}</td></tr>`;
      })
      .join('');
    const places = summary.places
      .map((place) => `<div>${escapeHtml(place.place)}（${place.samples} 次）：${placeDiffHtml(place.diffs) || '跟平均差不多'}</div>`)
      .join('');
    box.innerHTML = `
      ${summary.type === '未知類型' ? '<div class="hint">這張卡沒有記到類型，按下面「補齊角色類型」再重新計算</div>' : ''}
      <table class="combat"><tr><th>屬性</th><th>平均/級</th><th>範圍</th><th>樣本</th></tr>${rows}</table>
      <div class="hint">範圍與樣本只算一次升一級的紀錄</div>
      <div class="subhead">依升級地點（比這張卡自己的平均多／少）</div>
      <div style="font-size:12px">${places || '<div class="hint">還沒有記到地點的升級</div>'}</div>`;
  }

  function growthShareText() {
    return JSON.stringify(growthTracker.exportShare());
  }

  function exportGrowthToFile() {
    const blob = new Blob([growthShareText()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `swordgale-growth-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setStatus('已匯出成長值紀錄');
  }

  async function exportGrowthToClipboard() {
    const text = growthShareText();
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已複製成長值紀錄，可以貼給朋友');
    } catch {
      const textArea = panel.querySelector('[data-role="growth-share-text"]');
      textArea.value = text;
      textArea.select();
      setStatus('無法直接複製，內容已放在下方文字框，請按 Ctrl+C');
    }
  }

  function importGrowthShare(text, sourceName) {
    try {
      const result = growthTracker.importShare(JSON.parse(text));
      setStatus(`已匯入${sourceName}：${result.heroCount} 隻角色、新增 ${result.added} 筆升級紀錄`);
    } catch (error) {
      setStatus(`匯入${sourceName}失敗（${error.message}）`);
    }
    renderGrowthSummary();
  }

  async function loadGrowthHeroTypes() {
    try {
      growthTracker.rememberHeroList((await requestGameApi(HEROES_API)).heroes || []);
      setStatus('已補齊角色類型');
    } catch (error) {
      setStatus(`讀取角色清單失敗（${error.message}）`);
    }
    renderGrowthSummary();
  }

  panel.querySelector('[data-role="growth-type"]').addEventListener('change', renderGrowthSummary);
  panel.querySelector('[data-role="material-mode"]').addEventListener('change', renderMaterialSummary);
  panel.querySelector('[data-role="hunt-stats-place"]').addEventListener('change', renderHuntStats);
  panel.querySelector('[data-role="income-period"]').addEventListener('change', renderIncome);
  panel.querySelector('[data-role="actor-loot-period"]').addEventListener('change', renderActorLoot);
  panel.querySelector('[data-field="forgeRecipeType"]').addEventListener('change', renderRecipes);
  panel.querySelector('[data-role="recipe-forger"]').addEventListener('change', renderRecipes);
  panel.querySelector('[data-field="forgeRecipe"]').addEventListener('change', renderRecipePicker);
  panel.querySelector('[data-field="forgeRecipeType"]').addEventListener('change', renderRecipePicker);
  panel.querySelector('[data-role="recipe-filter"]').addEventListener('input', renderRecipePicker);
  panel.querySelector('[data-field="recipeNameAdjust"]').addEventListener('change', renderRecipes);
  panel.querySelector('[data-field="materialNameAdjust"]').addEventListener('change', renderMaterialSummary);
  panel.querySelector('[data-role="recipe-goal"]').addEventListener('change', renderRecipes);
  panel.querySelector('[data-role="material-type"]').addEventListener('change', renderMaterialSummary);
  panel.querySelector('[data-role="material-forger"]').addEventListener('change', renderMaterialSummary);
  panel.querySelector('[data-role="material-sort"]').addEventListener('change', renderMaterialSummary);
  panel.querySelector('[data-role="material-filter"]').addEventListener('input', renderMaterialSummary);
  panel.querySelector('[data-role="growth-import-file"]').addEventListener('change', (event) => {
    const files = Array.from(event.target.files);
    event.target.value = '';
    files.forEach((file) => file.text().then((text) => importGrowthShare(text, `「${file.name}」`)));
  });

  function exportToFile() {
    const blob = new Blob([exportText()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    link.download = `auto-clicker-v2-settings-${date}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setStatus('已匯出設定檔');
  }

  async function exportToClipboard() {
    const text = exportText();
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已複製設定到剪貼簿');
    } catch {
      // 有些環境不允許寫剪貼簿，改放到文字框讓使用者自己複製
      const textArea = panel.querySelector('[data-role="import-text"]');
      textArea.value = text;
      textArea.select();
      setStatus('無法直接複製，設定已放在下方文字框，請按 Ctrl+C');
    }
  }

  function importSettings(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      setStatus('匯入失敗：內容不是正確的設定格式');
      return;
    }
    const imported = parsed && typeof parsed.settings === 'object' ? parsed.settings : parsed;
    if (!imported || typeof imported !== 'object') {
      setStatus('匯入失敗：內容不是正確的設定格式');
      return;
    }
    // 只收認得的欄位，避免舊版或亂貼的內容塞進奇怪的值
    const known = Object.keys(imported).filter((key) => key in defaultSettings);
    if (known.length === 0) {
      setStatus('匯入失敗：裡面沒有可用的設定');
      return;
    }
    if (!window.confirm(`要用匯入的 ${known.length} 項設定覆蓋目前的設定嗎？`)) return;
    const merged = { ...readSettingsFromPanel() };
    known.forEach((key) => (merged[key] = imported[key]));
    if (state.running) stop();
    writeSettingsToPanel(merged);
    refreshAreaList();
    refreshSlotButtons();
    refreshSupplyModes();
    saveSettings(readSettingsFromPanel());
    setStatus(`已匯入 ${known.length} 項設定，按開始即可使用`);
  }

  panel.querySelector('[data-role="import-file"]').addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    file.text().then(importSettings);
  });

  // 勾選框、音量這類設定改完就存，不用等按開始
  panel.addEventListener('change', (event) => {
    // 匯入用的檔案選擇與文字框不是設定欄位
    if (event.target.dataset.role) return;
    if (event.target.dataset.itemChoice) updateItemNamesFromChoices(event.target.dataset.itemChoice);
    if (event.target.dataset.heroChoice) updateHeroIdsFromChoices(event.target.dataset.heroChoice);
    if (event.target.dataset.huntInclude !== undefined) updateExcludedHeroesFromChoices();
    if (event.target.dataset.equipHero !== undefined) updateEquipHeroesFromChoices();
    if (event.target.dataset.equipmentChoice !== undefined) updateAllowedEquipmentFromChoices();
    if (event.target.dataset.pickChoice) updatePickFromChoices(event.target.dataset.pickChoice);
    if (event.target.dataset.forgeApiHero !== undefined) updateForgeApiHeroesFromChoices();
    if (event.target.dataset.forgePlan) updateForgeApiPlansFromChoices();
    if (event.target.dataset.forgeApiHero !== undefined || event.target.dataset.forgePlan || ['forgeRecipe', 'forgeRecipeType'].includes(event.target.dataset.field)) {
      renderRecipeHeroes();
    }
    if (event.target.dataset.field === 'forgeShopSlots') renderForgePlanOverview();
    // 自動換名稱的門檻改了：鍛造正在等好名稱的話馬上再看一次，不用等下一輪
    if (['forgeAutoNamePercent', 'forgeAutoNameEnabled'].includes(event.target.dataset.field)) wakeForgeRunner();
    if (['lowProfileEnabled', 'lowProfileStyle', 'lowProfileCasualMinutes', 'lowProfileSeriousHours', 'lowProfileOffHours', 'lowProfileSleepHours'].includes(event.target.dataset.field)) resetLowProfileRhythm();
    if (event.target.dataset.trainChoice) updateTrainFromChoices();
    if (event.target.dataset.cardRule) updateCardRulesFromRows();
    if (event.target.dataset.field === 'trainEnabled') renderTrainStatus();
    if (event.target.dataset.field === 'showAccountName') {
      renderAppName();
      applyTitlePrefix();
    }
    // 剛切到主動：從現在起算自動切回的時間，第一次馬上查
    if (event.target.dataset.field === 'cardWatchMode' && event.target.value === 'active') {
      writeJsonStorage(CARD_ACTIVE_SINCE_KEY, Date.now());
      cardBuy.checkedAt = 0;
    }
    if (event.target.dataset.field === 'cardWatchMode' && event.target.value !== 'active') {
      panel.querySelector('[data-role="card-buy-next"]').textContent = '';
    }
    // 自己改了名稱＝今天就用這個名稱，自動換名稱等到下一個 00:00
    if (event.isTrusted && SHARED_SETTING_KEYS.includes(event.target.dataset.field) && readSettingsFromPanel().syncAccountsEnabled) {
      pushSharedSettings(readSettingsFromPanel());
    }
    if (event.isTrusted && event.target.dataset.field === 'syncAccountsEnabled' && event.target.checked) {
      // 剛打開同步：先跟中繼站上的設定對齊，不要拿自己的蓋掉別人的
      sharedSettings.at = 0;
      sharedSettings.checkedAt = 0;
    }
    if (event.isTrusted && (event.target.dataset.field === 'forgeRecipeName' || event.target.dataset.forgePlan === 'name')) {
      writeJsonStorage(FORGE_NAME_DAY_KEY, localDayKey(Date.now()));
    }
    // 改數量就當作要用這個材料
    if (event.target.dataset.recipeQty !== undefined) {
      const checkbox = [...panel.querySelectorAll('[data-recipe-mine]')].find((input) => input.dataset.recipeMine === event.target.dataset.recipeQty);
      if (checkbox) checkbox.checked = true;
    }
    if (event.target.dataset.recipeMine !== undefined || event.target.dataset.recipeQty !== undefined) updateRecipeFromPicker();
    refreshSupplyModes();
    saveSettings(readSettingsFromPanel());
    if (activeTab === 'forge') renderForgePlanOverview();
    if (/^card/.test(event.target.dataset.field || '')) {
      renderCardBuyStatus();
      // 系統通知要使用者點過東西才能要權限，趁改設定的時候要
      if (event.isTrusted && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    }
    refreshAreaList();
  });

  // 拖曳面板，避免擋住要點的按鈕
  panel.querySelector('[data-role="header"]').addEventListener('mousedown', (downEvent) => {
    const rect = panel.getBoundingClientRect();
    const offsetX = downEvent.clientX - rect.left;
    const offsetY = downEvent.clientY - rect.top;
    function onMove(moveEvent) {
      panel.style.left = moveEvent.clientX - offsetX + 'px';
      panel.style.top = moveEvent.clientY - offsetY + 'px';
      panel.style.right = 'auto';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  writeSettingsToPanel(loadSettings());
  refreshSlotButtons();
  refreshSupplyModes();
  refreshAreaList();
  renderCombatStats();
  renderCardBuyStatus();
  renderCardAlertHistory();
  renderTrainStatus();
  // data-role 的欄位不會進設定的 change 處理，篩選道具要自己接
  panel.querySelector('[data-role="draw-item"]').addEventListener('change', renderDrawStats);
  panel.querySelector('[data-role="material-summary"]').addEventListener('input', (event) => {
    const name = event.target.dataset.enchantMaterial;
    if (name === undefined) return;
    const quantity = Number(event.target.value) || 0;
    if (quantity > 0) enchantPlan.set(name, quantity);
    else enchantPlan.delete(name);
    renderEnchantPrediction();
  });
  // 一開頁面就讀帳號，面板標題才看得出是哪個帳號（之後回報、記收益時會再更新）
  requestGameApi(PROFILE_API)
    .then(rememberProfile)
    .catch(() => {});
  let savedTab = 'main';
  try {
    savedTab = localStorage.getItem(TAB_STORAGE_KEY) || 'main';
  } catch {
    // 讀不到就停在主流程
  }
  showTab(TABS.some(([id]) => id === savedTab) ? savedTab : 'main');
  showCharacter(0);
  let startMinimized = false;
  try {
    startMinimized = localStorage.getItem(MINIMIZED_STORAGE_KEY) === '1';
  } catch {
    // 讀不到就展開
  }
  setMinimized(startMinimized);
  setStatus(`已載入 v${SCRIPT_VERSION}`);
  let resumeAfterReload = null;
  try {
    resumeAfterReload = sessionStorage.getItem(RESUME_AFTER_RELOAD_KEY);
    sessionStorage.removeItem(RESUME_AFTER_RELOAD_KEY);
  } catch {
    // 讀不到就不自動開始
  }
  if (resumeAfterReload) {
    setStatus('總覽頁要求重新整理後自動開始，5 秒後開始');
    backgroundTimer.setTimeout(() => {
      const modes = resumeAfterReload.split(',');
      if (modes.includes('hunt')) start(false);
      if (modes.includes('forge')) start(true);
      if (modes.includes('mine')) startMiningRunner();
    }, 5000);
  }
  // 每秒檢查血條、驗證框；同樣用背景計時器，分頁在背景時才不會變成一分鐘才檢查一次
  (function monitorLoop() {
    if (tabShutDown) return;
    updateMonitors();
    backgroundTimer.setTimeout(monitorLoop, 1000);
  })();
})();
