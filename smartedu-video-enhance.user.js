// ==UserScript==
// @name         智慧教育·教师研修 视频增强（倍速/后台播放/拖进度条）
// @namespace    https://github.com/doughnuts/smartedu-video-enhance
// @version      1.2.0
// @description  国家智慧教育公共服务平台视频播放增强：倍速播放、后台播放、拖动进度条。仅供学习浏览器脚本技术，请遵守平台规则；使用产生的一切后果（含学时认定、账号处理）由使用者自行承担。
// @author       LD(鸡蛋不放葱)
// @license      MIT
// @match        https://www.smartedu.cn/*
// @match        https://*.smartedu.cn/*
// @match        https://teacher.ykt.eduyun.cn/*
// @match        https://*.ykt.eduyun.cn/*
// @match        https://*.ykt.cbern.com.cn/*
// @include      *://www.smartedu.cn/*
// @include      *://*.smartedu.cn/*
// @include      *://teacher.ykt.eduyun.cn/*
// @include      *://*.ykt.eduyun.cn/*
// @include      *://*.ykt.cbern.com.cn/*
// @downloadURL  https://raw.githubusercontent.com/doughnuts/smartedu-video-enhance/main/smartedu-video-enhance.user.js
// @updateURL    https://raw.githubusercontent.com/doughnuts/smartedu-video-enhance/main/smartedu-video-enhance.user.js
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

/* =============================================================
 * 免责声明 / Disclaimer
 * -------------------------------------------------------------
 * 本脚本仅供学习与研究浏览器脚本技术、HTML5 视频播放控制原理。
 * 请勿将其用于违反平台用户协议、规避学习/学时要求等用途。
 * 使用者应对自身行为负责：因使用本脚本产生的一切后果
 * （包括但不限于学时不被认定、账号被封禁等）均由使用者自行承担，
 * 与脚本作者无关。下载、安装、使用本脚本即视为同意本声明。
 * ============================================================= */

(function () {
  'use strict';

  var KEY = 'smSe_settings_v1';
  var TAG = '[研修视频增强]';

  // ==================== 设置持久化 ====================
  function loadSettings() {
    var def = { bg: true, shield: false, rate: 1, mini: false };
    try {
      if (typeof GM_getValue === 'function') {
        var s = GM_getValue(KEY, null);
        if (s) return Object.assign({}, def, s);
      }
      var raw = localStorage.getItem(KEY);
      if (raw) return Object.assign({}, def, JSON.parse(raw));
    } catch (e) { }
    return def;
  }
  function saveSettings() {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(KEY, state);
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) { }
  }
  var state = loadSettings();

  // ==================== 页面可见性伪装（document-start 生效，先于页面脚本） ====================
  var realHiddenGetter = null, realVisGetter = null, realHasFocus = null;
  try {
    realHiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;
    realVisGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get;
    realHasFocus = Document.prototype.hasFocus;
  } catch (e) { }

  function isReallyHidden() {
    try { return realHiddenGetter ? !!realHiddenGetter.call(document) : false; } catch (e) { return false; }
  }

  try {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: function () {
        return state.bg ? false : (realHiddenGetter ? !!realHiddenGetter.call(document) : false);
      }
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: function () {
        return state.bg ? 'visible' : (realVisGetter ? realVisGetter.call(document) : 'visible');
      }
    });
    if (realHasFocus) {
      document.hasFocus = function () {
        return state.bg ? true : realHasFocus.call(document);
      };
    }
  } catch (e) { console.warn(TAG, 'visibility hook fail', e); }

  // 拦截 visibilitychange / blur，阻止页面"切走就暂停"
  window.addEventListener('visibilitychange', function (ev) {
    if (state.bg) { ev.stopImmediatePropagation(); ev.stopPropagation(); }
  }, true);
  window.addEventListener('blur', function (ev) {
    if (state.bg) ev.stopImmediatePropagation();
  }, true);

  // ==================== 视频元素 Hook（核心反检测） ====================
  var TC_DESC = null, PR_DESC = null;
  try {
    TC_DESC = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    PR_DESC = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  } catch (e) { }

  function getRealTime(v) { try { return TC_DESC ? TC_DESC.get.call(v) : v.currentTime; } catch (e) { return 0; } }
  function getRealRate(v) { try { return PR_DESC ? PR_DESC.get.call(v) : v.playbackRate; } catch (e) { return 1; } }
  function setRealRate(v, r) { try { if (PR_DESC) PR_DESC.set.call(v, r); else v.playbackRate = r; } catch (e) { } }
  function setRealTime(v, t) { try { if (TC_DESC) TC_DESC.set.call(v, t); else v.currentTime = t; } catch (e) { } }

  /**
   * 核心思路：
   *  - 平台每秒测速：读取 player.playbackRate() 和 currentTime 增量。
   *  - 平台防拖拽：timeupdate 里发现 currentTime 相对上次跳变 >= 2 秒且超过"已看位置"就拉回。
   *  - 对策（shield 模式）：
   *      1) playbackRate 读取被伪装成 <= 2；
   *      2) currentTime 读取按 factor=max(1,rate/2) 放慢，平台看到的"视频时间"最多以 2 倍速推进；
   *      3) 拖进度条时把"伪装时间"做成连续的（不跳变），平台永远看不到跳变，也就不会拉回。
   *  关闭 shield 时一切还原为平台原生行为（原生 2x 倍速、允许范围内拖拽不受影响）。
   */
  function hookVideo(video) {
    if (video.__smSeHooked) return;
    video.__smSeHooked = true;
    var st = { shield: false, base: 0, baseReal: 0, factor: 1 };
    video.__smSeSt = st;
    try {
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get: function () {
          var real = getRealTime(video);
          if (!st.shield) return real;
          return st.base + (real - st.baseReal) / st.factor;
        },
        set: function (v) {
          // 按方向区分处理：
          //  1) 向前跳（用户拖拽）：伪装时间保持连续，平台看不到跳变，防拖拽逻辑不触发；
          //  2) 向后跳（平台回拉 / 用户回拖 / 播完重置）：伪装时间跟随真实值——
          //     平台回拉后若伪装值仍停在前面，页面层 seeking 处理器会反复回拉造成死循环。
          var real = getRealTime(video);
          if (st.shield && v >= real - 0.05) {
            st.base = st.base + (real - st.baseReal) / st.factor; // 当前伪装值
            st.baseReal = v;
          } else {
            st.base = v;
            st.baseReal = v;
          }
          setRealTime(video, v);
        }
      });
      Object.defineProperty(video, 'playbackRate', {
        configurable: true,
        get: function () {
          var real = getRealRate(video);
          return st.shield ? Math.min(real, 2) : real;
        },
        set: function (v) { setRealRate(video, v); }
      });
    } catch (e) { console.warn(TAG, 'video hook fail', e); }
  }

  // 包一层 video.js 播放器方法，页面拿到的 playbackRate() 同样被伪装
  function hookPlayer(video) {
    var p = video.player;
    if (!p || p.__smSeHooked) return;
    p.__smSeHooked = true;
    try {
      var orig = p.playbackRate.bind(p);
      p.playbackRate = function (v) {
        var st = video.__smSeSt;
        if (v === undefined) {
          var real = orig();
          return st.shield ? Math.min(real, 2) : real;
        }
        return orig(v);
      };
    } catch (e) { }
  }

  function enableShield(video, on) {
    var st = video.__smSeSt;
    if (!st) return;
    var real = getRealTime(video);
    st.shield = on;
    if (on) {
      st.base = real;
      st.baseReal = real;
      st.factor = Math.max(1, state.rate / 2);
    } else {
      st.base = 0; st.baseReal = 0; st.factor = 1;
    }
  }

  // 倍速变化时重算 factor，保持伪装时间连续
  function updateFactor(video) {
    var st = video.__smSeSt;
    if (!st || !st.shield) return;
    var real = getRealTime(video);
    st.base = st.base + (real - st.baseReal) / st.factor; // 当前伪装值
    st.baseReal = real;
    st.factor = Math.max(1, state.rate / 2);
  }

  function syncShield(video) {
    var st = video.__smSeSt;
    if (!st) return;
    // 注意：只在开关切换时重校准。切勿周期调用 updateFactor——
    // 那样会把伪装时间"瞬间对齐"回真实时间，恰好制造平台检测所需的跳变（会被回拉/报倍速）。
    if (st.shield !== state.shield) enableShield(video, state.shield);
  }

  // ==================== 视频发现 ====================
  function collectRoots() {
    var roots = [document];
    try {
      var micros = document.querySelectorAll('micro-app');
      for (var i = 0; i < micros.length; i++) {
        if (micros[i].shadowRoot) roots.push(micros[i].shadowRoot);
      }
    } catch (e) { }
    try {
      var frames = document.querySelectorAll('iframe');
      for (var j = 0; j < frames.length; j++) {
        try { if (frames[j].contentDocument) roots.push(frames[j].contentDocument); } catch (e) { }
      }
    } catch (e) { }
    return roots;
  }

  function collectVideos() {
    var out = [];
    var roots = collectRoots();
    for (var i = 0; i < roots.length; i++) {
      try {
        var vids = roots[i].querySelectorAll('video');
        for (var j = 0; j < vids.length; j++) out.push(vids[j]);
      } catch (e) { }
    }
    return out;
  }

  function getActiveVideo() {
    var vids = collectVideos();
    if (!vids.length) return null;
    // 优先课程播放器容器（course-video / fish-ndrVideo），其次正在播放的，其次有地址的
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      try {
        if (v.closest && (v.closest('.course-video') || v.closest('.fish-ndrVideo'))) return v;
      } catch (e) { }
    }
    for (var j = 0; j < vids.length; j++) { if (!vids[j].paused) return vids[j]; }
    for (var k = 0; k < vids.length; k++) { if (vids[k].currentSrc || vids[k].src) return vids[k]; }
    return vids[0];
  }

  function modalVisible() {
    var roots = collectRoots();
    for (var i = 0; i < roots.length; i++) {
      try {
        var els = roots[i].querySelectorAll('.ant-modal-wrap, .ant-modal-mask, [class*="modal-wrap"], [class*="dialog"]');
        for (var j = 0; j < els.length; j++) {
          var rc = els[j].getBoundingClientRect();
          if (rc.width > 100 && rc.height > 50) return true;
        }
      } catch (e) { }
    }
    return false;
  }

  // 平台倍速警告弹窗兜底自动关闭
  function closeSpeedWarn() {
    var roots = collectRoots();
    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      try {
        var nodes = r.querySelectorAll('div, section');
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          var txt = n.textContent || '';
          if (txt.length > 500) continue;
          if (txt.indexOf('检测到倍速播放') < 0) continue;
          var dial = null;
          try { dial = n.closest('[class*="modal"], [class*="dialog"]'); } catch (e) { }
          dial = dial || n;
          var btns = dial.querySelectorAll('button');
          for (var k = 0; k < btns.length; k++) {
            var t = (btns[k].textContent || '').trim();
            if (/^(确定|知道了|关闭|好的|继续|OK|ok)$/i.test(t)) {
              btns[k].click();
              autoResumeUntil = Date.now() + 3000;
              return true;
            }
          }
        }
      } catch (e) { }
    }
    return false;
  }

  // ==================== 核心操作 ====================
  function applyRate(v) {
    v = Math.max(0.1, v);
    state.rate = v;
    if (v > 2 && !state.shield) {
      state.shield = true;
      toast('超过 2 倍速会被平台检测暂停，已自动开启【超速模式】');
    }
    saveSettings();
    var vids = collectVideos();
    for (var i = 0; i < vids.length; i++) {
      var video = vids[i];
      hookVideo(video); hookPlayer(video);
      if (video.__smSeSt) syncShield(video); // 立即生效，避免检测窗口期
      try {
        if (video.player && video.player.playbackRate) video.player.playbackRate(v);
        else setRealRate(video, v);
      } catch (e) { setRealRate(video, v); }
      if (video.__smSeSt && state.shield) updateFactor(video);
    }
    refreshPanel();
  }

  var seekReq = null;
  function seekTo(video, t) {
    var dur = video.duration;
    if (!isFinite(dur) || dur <= 0) { toast('无法获取时长（可能是直播）'); return; }
    t = Math.max(0, Math.min(t, dur - 0.5));
    seekReq = { video: video, target: t, at: Date.now(), retries: 0 };
    try { video.currentTime = t; } catch (e) { setRealTime(video, t); }
  }

  var autoResumeUntil = 0;

  function watchdog() {
    // 强制一致性：超过 2 倍速必须开启 shield
    if (state.rate > 2 && !state.shield) { state.shield = true; saveSettings(); }

    var video = getActiveVideo();
    if (video) {
      hookVideo(video); hookPlayer(video);
      var st = video.__smSeSt;
      syncShield(video);

      // 保持目标倍速（平台可能偷偷改回 1x）
      if (state.rate !== 1 && !video.ended) {
        var real = getRealRate(video);
        if (Math.abs(real - state.rate) > 0.05) {
          try {
            if (video.player && video.player.playbackRate) video.player.playbackRate(state.rate);
            else setRealRate(video, state.rate);
          } catch (e) { setRealRate(video, state.rate); }
        }
      }

      // 拖拽被平台拉回 → 自动开启解锁模式重试
      if (seekReq && seekReq.video === video) {
        var rt = getRealTime(video);
        // 已落到目标位置（或播放已越过目标）即视为成功；被拉回时 real 会一直停在旧位置
        if (rt >= seekReq.target - 0.5) {
          seekReq = null;
        } else if (Date.now() - seekReq.at > 1500 && !dragging) {
          if (seekReq.retries < 4) {
            seekReq.retries++; seekReq.at = Date.now();
            if (!state.shield) {
              state.shield = true; saveSettings();
              toast('平台把进度拉回去了，已自动开启【解锁模式】并重试');
            }
            try { video.currentTime = seekReq.target; } catch (e) { setRealTime(video, seekReq.target); }
          } else {
            toast('该位置被平台限制，无法跳转');
            seekReq = null;
          }
        }
      }

      // 后台播放兜底：被暂停且真的切走了标签页时自动续播
      if (state.bg && video.paused && !video.ended) {
        var needResume = isReallyHidden() || Date.now() < autoResumeUntil;
        if (needResume && !modalVisible()) {
          try { video.play().catch(function () { }); } catch (e) { }
        }
      }

      // 倍速警告弹窗兜底关闭（正常情况 shield 已避免触发）
      if (video.paused && !video.ended && state.shield) closeSpeedWarn();

      updatePanelTime(video);
    }
    scanVideos();
  }

  var scannedVideos = new WeakSet();
  function scanVideos() {
    var vids = collectVideos();
    for (var i = 0; i < vids.length; i++) {
      hookVideo(vids[i]);
      hookPlayer(vids[i]);
      if (!scannedVideos.has(vids[i])) {
        scannedVideos.add(vids[i]);
        // 新视频套用当前倍速
        var v = vids[i];
        if (state.rate !== 1) {
          try {
            if (v.player && v.player.playbackRate) v.player.playbackRate(state.rate);
            else setRealRate(v, state.rate);
          } catch (e) { }
        }
        v.addEventListener('loadedmetadata', function () {
          if (state.rate !== 1) {
            try {
              if (v.player && v.player.playbackRate) v.player.playbackRate(state.rate);
              else setRealRate(v, state.rate);
            } catch (e) { }
          }
          syncShield(v);
        });
        v.addEventListener('ratechange', function () {
          var r = getRealRate(v);
          if (Math.abs(r - state.rate) > 0.05 && !manualRateLock) {
            state.rate = r; saveSettings(); refreshPanel();
            if (v.__smSeSt && state.shield) updateFactor(v); // 倍速变了要重算映射比例
          }
        });
        v.addEventListener('timeupdate', function () {
          if (v === getActiveVideo()) updatePanelTime(v);
        });
      }
      // shield 状态同步到所有视频（仅激活视频真正生效，其余只跟随 state 变化）
      if (vids[i] === getActiveVideo()) syncShield(vids[i]);
    }
  }

  var manualRateLock = false;

  // ==================== 面板 UI ====================
  function toast(msg) {
    var box = document.getElementById('smSe-toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'smSe-toast-box';
      document.documentElement.appendChild(box);
    }
    var t = document.createElement('div');
    t.className = 'smSe-toast';
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300);
    }, 3200);
  }

  var panel = null, barEl = null, playedEl = null, bufferedEl = null, curEl = null, durEl = null;
  var dragging = false;

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'smSe-panel';
    panel.innerHTML =
      '<div class="smSe-head"><span class="smSe-title">⚡ 研修视频增强</span>' +
      '<span class="smSe-mini" id="smSe-mini">—</span></div>' +
      '<div class="smSe-body" id="smSe-body">' +
      '<div class="smSe-row"><span class="smSe-label">倍速</span>' +
      '<button data-rate="0.75">0.75x</button><button data-rate="1">1x</button>' +
      '<button data-rate="1.25">1.25x</button><button data-rate="1.5">1.5x</button>' +
      '<button data-rate="2">2x</button>' +
      '</div>' +
      '<div class="smSe-row"><span class="smSe-label">超速</span>' +
      '<button data-rate="2.5">2.5x</button><button data-rate="3">3x</button>' +
      '<button data-rate="4">4x</button><button data-rate="8">8x</button>' +
      '<button data-rate="16">16x</button>' +
      '</div>' +
      '<div class="smSe-row smSe-toggles">' +
      '<label class="smSe-switch"><input type="checkbox" id="smSe-bg"> 后台播放</label>' +
      '<label class="smSe-switch"><input type="checkbox" id="smSe-shield"> 超速/解锁模式</label>' +
      '</div>' +
      '<div class="smSe-progress">' +
      '<div class="smSe-bar" id="smSe-bar"><div class="smSe-buffered" id="smSe-buffered"></div><div class="smSe-played" id="smSe-played"></div></div>' +
      '<div class="smSe-time"><span id="smSe-cur">0:00</span> / <span id="smSe-dur">0:00</span></div>' +
      '</div>' +
      '<div class="smSe-hint">提示：超速/解锁模式下，平台记录的学习进度会按最高 2 倍速推进。</div>' +
      '</div>';
    document.documentElement.appendChild(panel);

    barEl = document.getElementById('smSe-bar');
    playedEl = document.getElementById('smSe-played');
    bufferedEl = document.getElementById('smSe-buffered');
    curEl = document.getElementById('smSe-cur');
    durEl = document.getElementById('smSe-dur');

    panel.querySelectorAll('button[data-rate]').forEach(function (b) {
      b.addEventListener('click', function () {
        manualRateLock = true;
        applyRate(parseFloat(b.getAttribute('data-rate')));
        setTimeout(function () { manualRateLock = false; }, 600);
      });
    });

    document.getElementById('smSe-mini').addEventListener('click', function () {
      state.mini = !state.mini; saveSettings(); refreshPanel();
    });

    document.getElementById('smSe-bg').addEventListener('change', function (e) {
      state.bg = e.target.checked; saveSettings(); toast(state.bg ? '后台播放已开启：切走标签页不暂停' : '后台播放已关闭（恢复平台原生行为）');
    });
    document.getElementById('smSe-shield').addEventListener('change', function (e) {
      if (!e.target.checked && state.rate > 2) {
        // 超过 2 倍速时看门狗会强制重开，直接提示并回弹开关
        toast('当前倍速超过 2x，超速/解锁模式无法关闭（否则会被平台检测暂停）');
        e.target.checked = true;
        return;
      }
      state.shield = e.target.checked; saveSettings();
      var v = getActiveVideo();
      if (v) syncShield(v);
      toast(state.shield ? '超速/解锁模式已开启' : '已关闭（若平台限制拖拽，进度可能被拉回）');
      refreshPanel();
    });

    // 拖动进度条
    function seekFromPointer(e) {
      var video = getActiveVideo();
      if (!video || !isFinite(video.duration) || video.duration <= 0) return;
      var r = barEl.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      seekTo(video, ratio * video.duration);
    }
    barEl.addEventListener('pointerdown', function (e) {
      var video = getActiveVideo();
      if (!video) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true;
      try { barEl.setPointerCapture(e.pointerId); } catch (err) { }
      seekFromPointer(e);
    });
    barEl.addEventListener('pointermove', function (e) { if (dragging) seekFromPointer(e); });
    barEl.addEventListener('pointerup', function () { dragging = false; });
    barEl.addEventListener('pointercancel', function () { dragging = false; });

    refreshPanel();
  }

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return h > 0 ? h + ':' + p(m) + ':' + p(sec) : m + ':' + p(sec);
  }

  function updatePanelTime(video) {
    if (!curEl) return;
    try {
      var cur = getRealTime(video), dur = video.duration;
      curEl.textContent = fmt(cur);
      durEl.textContent = isFinite(dur) ? fmt(dur) : '--:--';
      if (isFinite(dur) && dur > 0) {
        playedEl.style.width = (Math.min(1, cur / dur) * 100) + '%';
        try {
          var bufEnd = 0;
          for (var i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= cur + 0.5 && video.buffered.end(i) >= cur) { bufEnd = video.buffered.end(i); break; }
          }
          bufferedEl.style.width = (Math.min(1, bufEnd / dur) * 100) + '%';
        } catch (e) { }
      }
    } catch (e) { }
  }

  function refreshPanel() {
    if (!panel) return;
    panel.querySelectorAll('button[data-rate]').forEach(function (b) {
      var r = parseFloat(b.getAttribute('data-rate'));
      b.classList.toggle('active', Math.abs(r - state.rate) < 0.01);
    });
    var bgEl = document.getElementById('smSe-bg');
    var shEl = document.getElementById('smSe-shield');
    if (bgEl) bgEl.checked = !!state.bg;
    if (shEl) shEl.checked = !!state.shield;
    var body = document.getElementById('smSe-body');
    if (body) body.style.display = state.mini ? 'none' : 'block';
    var mini = document.getElementById('smSe-mini');
    if (mini) mini.textContent = state.mini ? '＋' : '—';
  }

  function shouldBuildPanel() {
    if (window.top === window) {
      if (/jiaoshi|teacherTraining|courseDetail|courseIndex/i.test(location.pathname)) return true;
      return getActiveVideo() !== null;
    }
    // iframe 窗口：只有自己里面有视频才建面板
    return getActiveVideo() !== null;
  }

  // ==================== 样式 ====================
  function injectCss() {
    var css =
      '#smSe-panel{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:316px;' +
      'background:rgba(18,20,26,.92);color:#e8eaf0;border-radius:12px;font:12px/1.5 "PingFang SC","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.4);backdrop-filter:blur(8px);user-select:none;}' +
      '#smSe-panel .smSe-head{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.08);}' +
      '#smSe-panel .smSe-title{font-weight:600;font-size:13px;}' +
      '#smSe-panel .smSe-mini{cursor:pointer;font-size:14px;padding:0 6px;color:#9aa4b2;}' +
      '#smSe-panel .smSe-body{padding:10px 12px;}' +
      '#smSe-panel .smSe-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;}' +
      '#smSe-panel .smSe-label{color:#9aa4b2;width:32px;flex:none;}' +
      '#smSe-panel button{background:#2a2f3a;color:#dfe3ea;border:1px solid rgba(255,255,255,.12);border-radius:6px;' +
      'padding:3px 8px;cursor:pointer;font-size:12px;}' +
      '#smSe-panel button:hover{background:#3a4150;}' +
      '#smSe-panel button.active{background:#1e6fe0;border-color:#1e6fe0;color:#fff;font-weight:600;}' +
      '#smSe-panel .smSe-switch{display:inline-flex;align-items:center;gap:4px;color:#c3c9d4;cursor:pointer;}' +
      '#smSe-panel .smSe-switch input{accent-color:#1e6fe0;}' +
      '#smSe-panel .smSe-bar{position:relative;height:10px;background:#2a2f3a;border-radius:6px;cursor:pointer;flex:1;}' +
      '#smSe-panel .smSe-buffered{position:absolute;left:0;top:0;bottom:0;width:0;background:#4a5468;border-radius:6px;}' +
      '#smSe-panel .smSe-played{position:absolute;left:0;top:0;bottom:0;width:0;background:#1e6fe0;border-radius:6px;}' +
      '#smSe-panel .smSe-progress{display:flex;align-items:center;gap:8px;margin-top:2px;}' +
      '#smSe-panel .smSe-time{color:#9aa4b2;white-space:nowrap;font-variant-numeric:tabular-nums;}' +
      '#smSe-panel .smSe-hint{color:#7c8593;margin-top:8px;border-top:1px dashed rgba(255,255,255,.1);padding-top:6px;}' +
      '#smSe-toast-box{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483001;display:flex;flex-direction:column;gap:8px;align-items:center;}' +
      '#smSe-toast-box .smSe-toast{background:rgba(18,20,26,.94);color:#e8eaf0;padding:8px 16px;border-radius:8px;' +
      'font:13px/1.4 "PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);' +
      'opacity:0;transform:translateY(-6px);transition:all .25s ease;max-width:520px;}' +
      '#smSe-toast-box .smSe-toast.show{opacity:1;transform:translateY(0);}';
    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else {
      var st = document.createElement('style');
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    }
  }

  // ==================== 启动 ====================
  function boot() {
    injectCss();

    // 面板创建：顶层窗口直接建；iframe 里发现视频才建
    var tryBuild = function () {
      if (!panel && shouldBuildPanel()) buildPanel();
    };
    tryBuild();

    setInterval(function () {
      watchdog();
      tryBuild();
      refreshPanel();
    }, 1000);

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('研修视频增强：开关后台播放', function () {
          state.bg = !state.bg; saveSettings(); toast(state.bg ? '后台播放已开启' : '后台播放已关闭');
          refreshPanel();
        });
        GM_registerMenuCommand('研修视频增强：开关超速/解锁模式', function () {
          state.shield = !state.shield; saveSettings();
          var v = getActiveVideo(); if (v) syncShield(v);
          toast(state.shield ? '超速/解锁模式已开启' : '超速/解锁模式已关闭');
          refreshPanel();
        });
      }
    } catch (e) { }

    console.log(TAG, '已加载。默认后台播放开启；倍速 2x 以内无需额外设置，更高倍速会自动开启超速模式。');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
