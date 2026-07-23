/* ==========================================================================
   单词小乐园 · app.js
   纯前端单词练习应用：数据存 localStorage，不上传服务器。
   ========================================================================== */
(function () {
  "use strict";

  /* ---------------- 存储层 ---------------- */
  const LS_KEY = "wordland.v1";
  const hasLS = (() => {
    try {
      const k = "__wl_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  })();

  const DAY = 86400000;

  const defaultState = () => ({
    words: [],
    mistakes: [],
    stats: { stars: 0, streak: 0, lastActive: "", achievements: [] },
    settings: { accent: "us", autoSpeakLearn: true },
  });

  let state = defaultState();

  // 当前视图（用于同步后精准刷新）
  let currentView = "book";

  // ============ 云端同步（Cloudflare KV）============
  // 思路：用「同步口令」派生 KV key，整块 state 存云端；updated_at 做后写覆盖/冲突保护。
  const SYNC_KEY = "wordland.sync"; // 同步口令
  const SYNC_ON = "wordland.syncOn"; // 是否开启自动同步
  const SYNC_AT = "wordland.syncAt"; // 最近一次成功同步的 updated_at
  let pushTimer = null;
  let syncing = false;
  let applyingRemote = false; // 应用云端数据时，避免 save() 再次触发推送
  let dirty = false; // 本地有改动尚未成功上传

  function getSyncPass() {
    try { return localStorage.getItem(SYNC_KEY) || ""; } catch { return ""; }
  }
  function getSyncOn() {
    try { return localStorage.getItem(SYNC_ON) === "1"; } catch { return false; }
  }
  function getSyncAt() {
    try { return Number(localStorage.getItem(SYNC_AT)) || 0; } catch { return 0; }
  }
  function setSyncAt(v) {
    try { localStorage.setItem(SYNC_AT, String(v)); } catch { /* ignore */ }
  }
  function hasLocalData() {
    return state.words.length > 0 || state.mistakes.length > 0;
  }

  function syncHeaders(pass) {
    return { "Content-Type": "application/json", Authorization: "Bearer " + pass };
  }

  // 拉取：返回 { status, data, updated_at, error }
  async function apiGet(pass) {
    const r = await fetch("/api/sync", { headers: { Authorization: "Bearer " + pass } });
    if (r.status === 404) return { status: 404 };
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { status: r.status, error: text || ("HTTP " + r.status) };
    }
    const j = await r.json();
    return { status: 200, data: j.data, updated_at: j.updated_at };
  }
  // 推送：返回 { status, updated_at, data, error }
  async function apiPut(pass, data, updated_at) {
    const r = await fetch("/api/sync", {
      method: "POST",
      headers: syncHeaders(pass),
      body: JSON.stringify({ data, updated_at }),
    });
    if (r.status === 409) {
      const j = await r.json().catch(() => ({}));
      return { status: 409, data: j.data, updated_at: j.updated_at };
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { status: r.status, error: text || ("HTTP " + r.status) };
    }
    const j = await r.json().catch(() => ({}));
    return { status: 200, updated_at: j.updated_at || updated_at };
  }

  function updateSyncUI(kind, msg) {
    const el = document.getElementById("sync-status");
    if (!el) return;
    if (kind === "ok") {
      el.textContent = "已同步 · " + new Date().toLocaleTimeString();
      el.className = "sync-status ok";
    } else if (kind === "err") {
      const base = "同步失败";
      el.textContent = msg ? base + "：" + msg : base + "（检查网络或部署）";
      el.className = "sync-status err";
    } else {
      const at = getSyncAt();
      el.textContent = at ? "上次同步：" + new Date(at).toLocaleString() : "未同步";
      el.className = "sync-status";
    }
  }

  // 把云端 data 写回本地（复用 load 的归一化逻辑）
  function applyRemote(data, updated_at) {
    if (!data || typeof data !== "object") return;
    applyingRemote = true;
    try {
      state = Object.assign(defaultState(), data);
      state.stats = Object.assign(defaultState().stats, data.stats || {});
      state.settings = Object.assign(defaultState().settings, data.settings || {});
      if (!Array.isArray(state.words)) state.words = [];
      if (!Array.isArray(state.mistakes)) state.mistakes = [];
      save();
      setSyncAt(updated_at || 0);
      renderAll();
      if (currentView === "mistakes") renderMistakes();
    } finally {
      applyingRemote = false;
    }
  }

  // 推送（带防抖，由 save() 触发）
  async function pushSync() {
    const pass = getSyncPass();
    if (!pass || !getSyncOn() || syncing) return;
    syncing = true;
    const at = Date.now();
    try {
      const res = await apiPut(pass, state, at);
      if (res.status === 200) {
        setSyncAt(res.updated_at || at);
        dirty = false;
        updateSyncUI("ok");
      } else if (res.status === 409) {
        if (res.data) applyRemote(res.data, res.updated_at); // 云端更新，以云端为准
        toast("已用云端最新数据更新本机 ☁️", "ok");
      } else {
        updateSyncUI("err", res.error || ("HTTP " + res.status));
      }
    } catch (e) {
      updateSyncUI("err", e.message || String(e));
    } finally {
      syncing = false;
    }
  }

  function schedulePush() {
    if (!getSyncOn() || !getSyncPass()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushSync(), 1500);
  }

  // 拉取并按 updated_at 调和（立即同步按钮也走这里）
  async function pullSync() {
    const pass = getSyncPass();
    if (!pass || !getSyncOn() || syncing) return;
    syncing = true;
    try {
      const res = await apiGet(pass);
      if (res.status === 404) {
        if (hasLocalData()) {
          const at = Date.now();
          const r = await apiPut(pass, state, at);
          if (r.status === 200) { setSyncAt(at); dirty = false; updateSyncUI("ok"); }
          else if (r.status === 409 && r.data) applyRemote(r.data, r.updated_at);
        }
        return;
      }
      if (res.status !== 200) { updateSyncUI("err", res.error || ("HTTP " + res.status)); return; }

      const remoteAt = res.updated_at || 0;
      const localAt = getSyncAt();

      if (localAt === 0 && hasLocalData()) {
        // 首次开启同步且本机已有数据：让用户决定以谁为准
        const useLocal = confirm(
          "检测到云端已有同步数据。\n点「确定」= 用【本机】数据覆盖云端（推荐先在本机操作）；\n点「取消」= 改用【云端】数据覆盖本机。"
        );
        if (useLocal) {
          const at = Date.now();
          const r = await apiPut(pass, state, at);
          if (r.status === 200) { setSyncAt(at); updateSyncUI("ok"); }
          else if (r.status === 409 && r.data) applyRemote(r.data, r.updated_at);
        } else {
          applyRemote(res.data, remoteAt);
          toast("已用云端数据覆盖本机 ☁️", "ok");
        }
      } else if (remoteAt > localAt) {
        applyRemote(res.data, remoteAt);
        toast("已从云端同步最新数据 ☁️", "ok");
      } else if (remoteAt < localAt || dirty) {
        // 本机更新或本机有未上传改动 → 上传本机
        const at = Date.now();
        const r = await apiPut(pass, state, at);
        if (r.status === 200) { setSyncAt(at); dirty = false; updateSyncUI("ok"); }
        else if (r.status === 409 && r.data) applyRemote(r.data, r.updated_at);
      } else {
        updateSyncUI("ok");
      }
    } catch (e) {
      updateSyncUI("err", e.message || String(e));
    } finally {
      syncing = false;
    }
  }

  function bindSync() {
    const passEl = document.getElementById("sync-pass");
    const onEl = document.getElementById("sync-on");
    const nowBtn = document.getElementById("btn-sync-now");
    if (!passEl || !onEl) return;

    passEl.value = getSyncPass();
    onEl.checked = getSyncOn();
    updateSyncUI();

    onEl.addEventListener("change", () => {
      const on = onEl.checked;
      try { localStorage.setItem(SYNC_ON, on ? "1" : "0"); } catch { /* ignore */ }
      if (on) {
        const p = passEl.value.trim();
        if (!p) {
          toast("请先填写同步口令", "err");
          onEl.checked = false;
          try { localStorage.setItem(SYNC_ON, "0"); } catch { /* ignore */ }
          return;
        }
        try { localStorage.setItem(SYNC_KEY, p); } catch { /* ignore */ }
        toast("已开启自动同步，正在拉取云端…", "ok");
        pullSync();
      } else {
        updateSyncUI();
      }
    });

    passEl.addEventListener("change", () => {
      const p = passEl.value.trim();
      try {
        if (p) localStorage.setItem(SYNC_KEY, p);
        else localStorage.removeItem(SYNC_KEY);
      } catch { /* ignore */ }
    });

    if (nowBtn) {
      nowBtn.addEventListener("click", () => {
        const p = passEl.value.trim();
        if (!p) {
          toast("请先填写同步口令", "err");
          return;
        }
        try {
          localStorage.setItem(SYNC_KEY, p);
          localStorage.setItem(SYNC_ON, "1");
        } catch { /* ignore */ }
        onEl.checked = true;
        toast("正在同步…", "ok");
        pullSync();
      });
    }
  }

  function load() {
    if (!hasLS) {
      toast("当前浏览器不支持本地存储，数据将无法保存", "err");
      return;
    }
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = Object.assign(defaultState(), parsed);
        state.stats = Object.assign(defaultState().stats, parsed.stats || {});
        state.settings = Object.assign(defaultState().settings, parsed.settings || {});
        if (!Array.isArray(state.words)) state.words = [];
        if (!Array.isArray(state.mistakes)) state.mistakes = [];
      }
    } catch (e) {
      toast("读取存档失败，已重置为空单词本", "err");
      state = defaultState();
    }
  }

  function save() {
    if (!hasLS) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch (e) {
      toast("保存失败：浏览器存储空间可能已满", "err");
    }
    // 改动后触发（防抖）推送；应用云端数据时跳过，避免回写循环
    if (!applyingRemote) { dirty = true; schedulePush(); }
  }

  /* ---------------- 小工具 ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show" + (kind ? " " + kind : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => (el.hidden = true), 300);
    }, 2200);
  }

  /* ---------------- 发音 (Web Speech API) ---------------- */
  const synth = window.speechSynthesis || null;
  let voices = [];
  function refreshVoices() {
    if (synth) voices = synth.getVoices() || [];
  }
  refreshVoices();
  if (synth && typeof synth.onvoiceschanged !== "undefined") {
    synth.onvoiceschanged = refreshVoices;
  }
  function pickVoice() {
    const want = state.settings.accent === "uk" ? "en-GB" : "en-US";
    if (!voices.length) refreshVoices();
    let v = voices.find((x) => x.lang === want);
    if (!v) v = voices.find((x) => x.lang && x.lang.startsWith("en"));
    return v || null;
  }
  function speak(text, rate) {
    if (!synth) {
      toast("当前浏览器不支持语音发音", "err");
      return;
    }
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.lang = state.settings.accent === "uk" ? "en-GB" : "en-US";
      u.rate = rate || 0.95;
      synth.speak(u);
    } catch (e) {
      toast("发音失败", "err");
    }
  }

  /* ---------------- 单词记忆模型辅助 ---------------- */
  function ensureFields(w) {
    if (typeof w.wrong !== "number") w.wrong = 0;
    if (typeof w.ease !== "number") w.ease = 2.5;
    if (typeof w.reps !== "number") w.reps = 0;
    if (typeof w.due !== "number") w.due = 0; // 0 = 从未复习，最生疏
    if (typeof w.last !== "number") w.last = 0;
    return w;
  }
  const isMastered = (w) => w.reps >= 3 && w.wrong === 0;
  const isWeak = (w) => !isMastered(w);
  function dueSort(a, b) {
    // due 越小越优先（0 表示从未练）
    return (a.due || 0) - (b.due || 0);
  }

  // 轻量 SM-2：知道 -> 拉长间隔；不知道 -> 立刻重来
  function scheduleReview(w, known) {
    w.reps = (w.reps || 0) + 1;
    const now = Date.now();
    if (known) {
      w.ease = clamp((w.ease || 2.5) + 0.1, 1.3, 3.0);
      const intervalDays = Math.min(Math.pow(2, w.reps - 1), 30); // 1,2,4,8...上限30天
      w.due = now + intervalDays * DAY;
    } else {
      w.reps = 1;
      w.ease = clamp((w.ease || 2.5) - 0.2, 1.3, 3.0);
      w.wrong = (w.wrong || 0) + 1;
      w.due = now + 5 * 60 * 1000; // 5 分钟后再来
    }
    w.last = now;
  }

  /* ---------------- 错题本：记录与同步 ---------------- */
  function recordMistake({ wordId, mode, prompt, answer, correct }) {
    const w = wordId ? state.words.find((x) => x.id === wordId) : null;
    const now = Date.now();
    // 去重：同一 wordId + mode 在最近 30 秒内只更新，不新增
    const dup = state.mistakes.find(
      (m) => m.wordId === wordId && m.mode === mode && !m.resolved && now - m.at < 30000
    );
    if (dup) {
      dup.answer = answer || "";
      dup.prompt = prompt || "";
      dup.correct = correct || "";
      dup.at = now;
    } else {
      state.mistakes.push({
        id: uid(),
        wordId: wordId || "",
        en: w ? w.en : "",
        zh: w ? w.zh : "",
        mode,
        prompt: prompt || "",
        answer: answer || "",
        correct: correct || "",
        at: now,
        resolved: false,
      });
    }
    save();
    renderStats();
    // 如果当前正在看错题本，实时刷新
    if (currentView === "mistakes") renderMistakes();
    else {
      const badge = $("#mistake-count");
      if (badge) badge.textContent = state.mistakes.filter((m) => !m.resolved).length;
    }
    // 用户反馈
    toast("已加入错题本 📕", "");
  }

  // 旧版本只有 word.wrong 计数，没有 state.mistakes；启动时自动迁移一次
  function migrateLegacyMistakes() {
    if (!Array.isArray(state.mistakes)) state.mistakes = [];
    let added = 0;
    state.words.forEach((w) => {
      if (!w.wrong) return;
      // 该词已经有任何错题记录，就不再迁移（避免重复）
      if (state.mistakes.some((m) => m.wordId === w.id)) return;
      state.mistakes.push({
        id: uid(),
        wordId: w.id,
        en: w.en,
        zh: w.zh,
        mode: "legacy",
        prompt: `中文：${w.zh}`,
        answer: "（历史错题）",
        correct: w.en,
        at: w.last || w.added || Date.now(),
        resolved: false,
      });
      added++;
    });
    if (added) {
      save();
      toast(`已迁移 ${added} 条历史错题 📕`, "ok");
    }
  }

  // 单词被练到「已掌握」时，自动将其错题标记为已攻克（保留历史）
  function syncResolved() {
    let changed = false;
    state.mistakes.forEach((m) => {
      if (m.resolved) return;
      const w = m.wordId && state.words.find((x) => x.id === m.wordId);
      if (w && isMastered(w)) {
        m.resolved = true;
        changed = true;
      }
    });
    if (changed) save();
  }

  /* ---------------- 打卡 / 星星 / 成就 ---------------- */
  function checkin() {
    const t = todayStr();
    const last = state.stats.lastActive;
    if (last === t) return;
    if (last) {
      const diff = Math.round((new Date(t) - new Date(last)) / DAY);
      state.stats.streak = diff === 1 ? state.stats.streak + 1 : 1;
    } else {
      state.stats.streak = 1;
    }
    state.stats.lastActive = t;
    save();
  }

  function addStars(n) {
    state.stats.stars += n;
    save();
    renderHUD();
  }

  const ACHIEVEMENTS = [
    { id: "first", icon: "🌱", name: "启程", test: (s) => s.words.length >= 1 },
    { id: "ten", icon: "📚", name: "小书虫", test: (s) => s.words.length >= 10 },
    { id: "fifty", icon: "🎓", name: "词汇达人", test: (s) => s.words.length >= 50 },
    { id: "star50", icon: "⭐", name: "五十星", test: (s) => s.stats.stars >= 50 },
    { id: "star200", icon: "🌟", name: "闪耀之星", test: (s) => s.stats.stars >= 200 },
    { id: "streak3", icon: "🔥", name: "三日打卡", test: (s) => s.stats.streak >= 3 },
    { id: "streak7", icon: "🏆", name: "一周坚持", test: (s) => s.stats.streak >= 7 },
    { id: "master10", icon: "💎", name: "掌握十词", test: (s) => s.words.filter(isMastered).length >= 10 },
    { id: "mistakeFirst", icon: "📕", name: "初见错题", test: (s) => s.mistakes.length >= 1 },
    { id: "mistakeClear10", icon: "🧹", name: "错题清道夫", test: (s) => s.mistakes.filter((m) => m.resolved).length >= 10 },
  ];

  function checkAchievements() {
    let unlocked = false;
    ACHIEVEMENTS.forEach((a) => {
      if (!state.stats.achievements.includes(a.id) && a.test(state)) {
        state.stats.achievements.push(a.id);
        unlocked = true;
        toast(`解锁成就：${a.icon} ${a.name}！`, "ok");
      }
    });
    if (unlocked) save();
  }

  /* ---------------- 渲染：HUD / 成就 ---------------- */
  function renderHUD() {
    $("#hud-stars").textContent = state.stats.stars;
    $("#hud-streak").textContent = state.stats.streak;
    const t = $("#accent-toggle");
    t.textContent = state.settings.accent === "uk" ? "🇬🇧 英音" : "🇺🇸 美音";
  }

  function renderStats() {
    syncResolved();
    const grid = $("#stats-grid");
    grid.innerHTML = "";
    const total = state.words.length;
    const mastered = state.words.filter(isMastered).length;
    const wrong = state.words.filter((w) => w.wrong > 0).length;
    const pending = state.mistakes.filter((m) => !m.resolved).length;
    const tiles = [
      { num: total, lbl: "总词数" },
      { num: mastered, lbl: "已掌握" },
      { num: wrong, lbl: "错词" },
      { num: pending, lbl: "待攻克" },
      { num: state.stats.stars, lbl: "星星" },
    ];
    tiles.forEach((t) => {
      const d = document.createElement("div");
      d.className = "stat-tile";
      const n = document.createElement("div");
      n.className = "num";
      n.textContent = t.num;
      const l = document.createElement("div");
      l.className = "lbl";
      l.textContent = t.lbl;
      d.appendChild(n);
      d.appendChild(l);
      grid.appendChild(d);
    });
    const badge = $("#mistake-count");
    if (badge) badge.textContent = pending;
    // 成就徽章
    const achWrap = document.createElement("div");
    achWrap.style.gridColumn = "1 / -1";
    ACHIEVEMENTS.forEach((a) => {
      const span = document.createElement("span");
      const got = state.stats.achievements.includes(a.id);
      span.className = "achv" + (got ? "" : " locked");
      span.textContent = `${a.icon} ${a.name}`;
      achWrap.appendChild(span);
    });
    grid.appendChild(achWrap);
  }

  /* ---------------- 渲染：分类下拉 ---------------- */
  function refreshCategories() {
    const cats = Array.from(new Set(state.words.map((w) => w.cat).filter(Boolean))).sort();
    // datalist
    const dl = $("#cat-list");
    dl.innerHTML = "";
    cats.forEach((c) => {
      const o = document.createElement("option");
      o.value = c;
      dl.appendChild(o);
    });
    // filter select
    const sel = $("#cat-filter");
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部分类</option>';
    cats.forEach((c) => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      sel.appendChild(o);
    });
    if (cats.includes(cur)) sel.value = cur;
  }

  /* ---------------- 渲染：单词列表 ---------------- */
  function renderList() {
    const ul = $("#word-list");
    const q = ($("#search-input").value || "").trim().toLowerCase();
    const cat = $("#cat-filter").value;
    ul.innerHTML = "";

    let items = state.words.slice().reverse();
    if (q) items = items.filter((w) => w.en.toLowerCase().includes(q) || (w.zh || "").toLowerCase().includes(q));
    if (cat) items = items.filter((w) => w.cat === cat);

    $("#word-count").textContent = state.words.length;
    $("#empty-hint").style.display = state.words.length === 0 ? "block" : "none";

    items.forEach((w) => {
      const li = document.createElement("li");
      li.className = "word-item";

      const spk = document.createElement("button");
      spk.className = "wi-btn";
      spk.title = "发音";
      spk.textContent = "🔊";
      spk.addEventListener("click", () => speak(w.en));

      const main = document.createElement("div");
      main.className = "wi-main";

      const enLine = document.createElement("div");
      const en = document.createElement("span");
      en.className = "wi-en";
      en.textContent = w.en;
      enLine.appendChild(en);
      if (w.phonetic) {
        const ph = document.createElement("span");
        ph.className = "wi-phon";
        ph.textContent = w.phonetic;
        enLine.appendChild(ph);
      }
      if (isMastered(w)) {
        const tg = document.createElement("span");
        tg.className = "wi-tag mastered";
        tg.textContent = "已掌握";
        enLine.appendChild(document.createTextNode(" "));
        enLine.appendChild(tg);
      } else if (w.wrong > 0) {
        const tg = document.createElement("span");
        tg.className = "wi-tag wrong";
        tg.textContent = "错 " + w.wrong;
        enLine.appendChild(document.createTextNode(" "));
        enLine.appendChild(tg);
      }

      const zh = document.createElement("div");
      zh.className = "wi-zh";
      zh.textContent = w.zh;

      main.appendChild(enLine);
      main.appendChild(zh);
      if (w.ex) {
        const ex = document.createElement("div");
        ex.className = "wi-ex";
        ex.textContent = w.ex;
        main.appendChild(ex);
      }

      if (w.cat) {
        const c = document.createElement("span");
        c.className = "wi-cat";
        c.textContent = w.cat;
        main.appendChild(c);
      }

      const del = document.createElement("button");
      del.className = "wi-btn";
      del.title = "删除";
      del.textContent = "🗑️";
      del.addEventListener("click", () => {
        state.words = state.words.filter((x) => x.id !== w.id);
        save();
        renderAll();
        toast("已删除：" + w.en);
      });

      li.appendChild(spk);
      li.appendChild(main);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function renderAll() {
    renderHUD();
    renderStats();
    refreshCategories();
    renderList();
    checkAchievements();
  }

  /* ---------------- 单词本：增删导入导出 ---------------- */
  function addWord(data, silent) {
    const en = (data.en || "").trim();
    const zh = (data.zh || "").trim();
    if (!en || !zh) {
      if (!silent) toast("英文和中文都要填哦", "err");
      return false;
    }
    const exists = state.words.find((w) => w.en.toLowerCase() === en.toLowerCase());
    if (exists) {
      if (!silent) toast(`"${en}" 已经在单词本里啦`, "err");
      return false;
    }
    const w = ensureFields({
      id: uid(),
      en,
      zh,
      cat: (data.cat || "").trim(),
      ex: (data.ex || "").trim(),
      phonetic: (data.phonetic || "").trim(),
    });
    state.words.push(w);
    save();
    if (!silent) {
      renderAll();
      toast("已保存：" + en, "ok");
    }
    return true;
  }

  function bindBook() {
    $("#word-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const ok = addWord({
        en: $("#en-input").value,
        zh: $("#zh-input").value,
        cat: $("#cat-input").value,
        ex: $("#ex-input").value,
        phonetic: $("#en-input").dataset.phonetic || "",
      });
      if (ok) {
        $("#en-input").value = "";
        $("#zh-input").value = "";
        $("#ex-input").value = "";
        delete $("#en-input").dataset.phonetic;
        $("#en-input").focus();
      }
    });

    $("#search-input").addEventListener("input", renderList);
    $("#cat-filter").addEventListener("change", renderList);

    // 自动查
    $("#btn-lookup").addEventListener("click", lookupWord);

    // 示例词库
    $("#btn-sample").addEventListener("click", () => {
      let added = 0;
      SAMPLE.forEach((s) => {
        if (addWord(s, true)) added++;
      });
      renderAll();
      toast(added ? `已加入 ${added} 个示例单词 🎁` : "示例单词都已在词库里", added ? "ok" : "");
    });

    // 导出（含错题本）
    $("#btn-export").addEventListener("click", () => {
      if (!state.words.length) return toast("单词本是空的，没什么可导出", "err");
      const blob = new Blob(
        [JSON.stringify({ words: state.words, mistakes: state.mistakes }, null, 2)],
        { type: "application/json" }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `单词小乐园_${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("已导出单词本与错题本 ⬇️", "ok");
    });

    // 导入（兼容旧版纯数组与新版 {words,mistakes}）
    $("#btn-import").addEventListener("click", () => $("#file-input").click());
    $("#file-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          let wordsToAdd = data;
          if (!Array.isArray(data)) {
            if (data && Array.isArray(data.words)) wordsToAdd = data.words;
            else throw new Error("格式不对");
            if (Array.isArray(data.mistakes)) {
              data.mistakes.forEach((m) => {
                if (m && (m.en || m.zh)) {
                  state.mistakes.push(
                    Object.assign({ id: uid(), resolved: false, at: Date.now() }, m)
                  );
                }
              });
            }
          }
          let added = 0;
          wordsToAdd.forEach((item) => {
            if (item && item.en && item.zh && addWord(item, true)) added++;
          });
          save();
          renderAll();
          toast(`导入完成，新增 ${added} 个单词 ⬆️`, "ok");
        } catch (err) {
          toast("导入失败：文件格式不正确", "err");
        }
        $("#file-input").value = "";
      };
      reader.onerror = () => toast("读取文件失败", "err");
      reader.readAsText(file);
    });

    // 清空
    $("#btn-clear").addEventListener("click", () => {
      if (!state.words.length) return toast("单词本已经是空的啦", "");
      if (confirm("确定要清空整个单词本吗？相关错题也会一起清空，此操作不可恢复！")) {
        state.words = [];
        state.mistakes = [];
        save();
        renderAll();
        if (currentView === "mistakes") renderMistakes();
        toast("已清空单词本和错题");
      }
    });
  }

  /* ---------------- 自动查（联网，失败降级） ---------------- */
  // 音标 + 例句（dictionaryapi.dev，CORS 友好，浏览器直连）
  async function fetchPhoneticEx(en) {
    try {
      const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(en));
      if (!r.ok) return { phonetic: "", ex: "" };
      const data = await r.json();
      const entry = Array.isArray(data) ? data[0] : null;
      if (!entry) return { phonetic: "", ex: "" };
      const phonetic =
        entry.phonetic || (entry.phonetics || []).map((p) => p.text).find(Boolean) || "";
      let ex = "";
      (entry.meanings || []).some((m) =>
        (m.definitions || []).some((d) => {
          if (d.example) {
            ex = d.example;
            return true;
          }
          return false;
        })
      );
      return { phonetic, ex };
    } catch {
      return { phonetic: "", ex: "" };
    }
  }

  // 中文翻译兜底：MyMemory（浏览器直连，用本机 IP 不会被 Cloudflare 共享 IP 限流）
  async function fetchZhMyMemory(en) {
    try {
      const r = await fetch(
        "https://api.mymemory.translated.net/get?q=" +
          encodeURIComponent(en) +
          "&langpair=en|zh-CN"
      );
      if (!r.ok) return "";
      const j = await r.json();
      const zh = j && j.responseData && j.responseData.translatedText;
      if (zh && !/MYMEMORY WARNING/i.test(zh)) return zh;
      return "";
    } catch {
      return "";
    }
  }

  async function lookupWord() {
    const en = ($("#en-input").value || "").trim();
    if (!en) return toast("请先输入英语单词", "err");
    const btn = $("#btn-lookup");
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "查询中…";
    const key = en.toLowerCase();

    // 中文：内置词库优先（离线、准确、永不失败）
    let zh = window.BUILTIN_ZH && window.BUILTIN_ZH[key] ? window.BUILTIN_ZH[key] : "";

    // 并行：音标例句（直连）+ 中文兜底（仅当词库未命中时）
    const [pe, zhM] = await Promise.all([
      fetchPhoneticEx(en),
      zh ? Promise.resolve("") : fetchZhMyMemory(en),
    ]);
    if (!zh && zhM) zh = zhM;

    btn.disabled = false;
    btn.textContent = old;

    if (pe.phonetic) $("#en-input").dataset.phonetic = pe.phonetic;
    if (pe.ex && !$("#ex-input").value) $("#ex-input").value = pe.ex;
    if (zh) $("#zh-input").value = zh;

    if (zh || pe.phonetic || pe.ex) toast("已自动填入，可再手动修改 ✨", "ok");
    else toast("联网查询失败，请手动填写中文意思", "err");
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(view) {
    currentView = view;
    $$(".view").forEach((v) => v.classList.add("hidden"));
    const target = $("#view-" + view);
    if (target) target.classList.remove("hidden");
    $$("#tabs .tab").forEach((t) => {
      t.setAttribute("aria-current", t.dataset.view === view ? "true" : "false");
    });
    // 进入模式时重置
    if (view === "learn") initLearn();
    if (view === "spell") resetSpell();
    if (view === "review") resetReview();
    if (view === "exam") resetExam();
    if (view === "game") resetGame();
    if (view === "mistakes") renderMistakes();
  }

  function bindTabs() {
    $("#tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (btn) switchView(btn.dataset.view);
    });
    $("#accent-toggle").addEventListener("click", () => {
      state.settings.accent = state.settings.accent === "us" ? "uk" : "us";
      save();
      renderHUD();
      toast(state.settings.accent === "uk" ? "已切换为英音 🇬🇧" : "已切换为美音 🇺🇸");
    });
  }

  function pool(range) {
    let arr = state.words.slice();
    if (range === "wrong") arr = arr.filter((w) => w.wrong > 0);
    else if (range === "weak") arr = arr.filter(isWeak);
    else if (range === "due") {
      const now = Date.now();
      arr = arr.filter((w) => (w.due || 0) <= now || w.reps === 0).sort(dueSort);
      if (!arr.length) arr = state.words.slice().sort(dueSort);
    }
    return arr;
  }

  /* ---------------- 学习模式 ---------------- */
  let learnList = [],
    learnIdx = 0;
  function initLearn() {
    learnList = state.words.slice();
    learnIdx = 0;
    const area = $("#learn-area");
    const controls = $("#learn-controls");
    if (!learnList.length) {
      area.innerHTML = '<div class="empty-hint">请先在「单词本」添加单词，再来学习吧！</div>';
      controls.hidden = true;
      $("#learn-progress").style.width = "0%";
      return;
    }
    controls.hidden = false;
    renderLearnCard();
  }
  function renderLearnCard() {
    const w = learnList[learnIdx];
    const area = $("#learn-area");
    area.innerHTML = "";
    const card = document.createElement("div");
    card.className = "flashcard";

    const front = document.createElement("div");
    front.className = "face front";
    const en = document.createElement("div");
    en.className = "fc-en";
    en.textContent = w.en;
    front.appendChild(en);
    if (w.phonetic) {
      const ph = document.createElement("div");
      ph.className = "fc-phon";
      ph.textContent = w.phonetic;
      front.appendChild(ph);
    }
    const hint1 = document.createElement("div");
    hint1.className = "fc-hint";
    hint1.textContent = "点我翻面看中文 👆";
    front.appendChild(hint1);

    const back = document.createElement("div");
    back.className = "face back";
    const zh = document.createElement("div");
    zh.className = "fc-zh";
    zh.textContent = w.zh;
    back.appendChild(zh);
    if (w.ex) {
      const ex = document.createElement("div");
      ex.className = "fc-ex";
      ex.textContent = w.ex;
      back.appendChild(ex);
    }

    card.appendChild(front);
    card.appendChild(back);
    card.addEventListener("click", () => card.classList.toggle("flipped"));
    area.appendChild(card);

    const pct = ((learnIdx + 1) / learnList.length) * 100;
    $("#learn-progress").style.width = pct + "%";

    // 默认直接发音：每显示一张卡片就自动念出英文（设置可关）
    if (state.settings.autoSpeakLearn) {
      // 稍延迟，等卡片渲染完成、避免与翻面动画/上次发音抢资源
      setTimeout(() => {
        if (learnList[learnIdx] === w) speak(w.en);
      }, 120);
    }
  }
  function bindLearn() {
    $("#learn-prev").addEventListener("click", () => {
      if (!learnList.length) return;
      learnIdx = (learnIdx - 1 + learnList.length) % learnList.length;
      renderLearnCard();
    });
    $("#learn-next").addEventListener("click", () => {
      if (!learnList.length) return;
      learnIdx = (learnIdx + 1) % learnList.length;
      renderLearnCard();
    });
    $("#learn-flip").addEventListener("click", () => {
      const c = $("#learn-area .flashcard");
      if (c) c.classList.toggle("flipped");
    });
    $("#learn-speak").addEventListener("click", () => {
      if (learnList[learnIdx]) speak(learnList[learnIdx].en);
    });
    $("#learn-slow").addEventListener("click", () => {
      if (learnList[learnIdx]) speak(learnList[learnIdx].en, 0.5);
    });
    const autoSpk = $("#learn-autospeak");
    if (autoSpk) {
      autoSpk.checked = !!state.settings.autoSpeakLearn;
      autoSpk.addEventListener("change", () => {
        state.settings.autoSpeakLearn = autoSpk.checked;
        save();
        if (autoSpk.checked && learnList[learnIdx]) speak(learnList[learnIdx].en);
      });
    }
  }

  /* ---------------- 拼写模式 ---------------- */
  let spellList = [],
    spellIdx = 0,
    spellHintCount = 0;
  function resetSpell() {
    $("#spell-setup").hidden = false;
    $("#spell-area").hidden = true;
  }
  function bindSpell() {
    $("#spell-start").addEventListener("click", () => {
      const range = $("#spell-range").value;
      spellList = shuffle(pool(range));
      if (!spellList.length) return toast("这个范围里还没有单词哦", "err");
      spellIdx = 0;
      $("#spell-setup").hidden = true;
      $("#spell-area").hidden = false;
      renderSpell();
    });
  }
  function renderSpell() {
    const type = $("#spell-type").value;
    const area = $("#spell-area");
    spellHintCount = 0;
    if (spellIdx >= spellList.length) {
      area.innerHTML =
        '<div class="spell-question"><div class="sq-prompt">🎉 拼写完成！</div>' +
        '<div class="sq-sub">共练习 ' + spellList.length + ' 个单词</div></div>';
      const again = document.createElement("button");
      again.className = "btn btn-primary";
      again.textContent = "🔄 再来一组";
      again.addEventListener("click", resetSpell);
      area.appendChild(again);
      addStars(2);
      toast("拼写完成 +2⭐", "ok");
      return;
    }
    const w = spellList[spellIdx];
    area.innerHTML = "";

    const q = document.createElement("div");
    q.className = "spell-question";
    const prompt = document.createElement("div");
    prompt.className = "sq-prompt";
    const sub = document.createElement("div");
    sub.className = "sq-sub";
    if (type === "listen") {
      prompt.textContent = "🔊 听发音拼写";
      sub.textContent = "点下面的喇叭再听一次";
      setTimeout(() => speak(w.en), 250);
    } else {
      prompt.textContent = w.zh;
      sub.textContent = "请拼出对应的英文单词";
    }
    q.appendChild(prompt);
    q.appendChild(sub);

    const row = document.createElement("div");
    row.className = "spell-input-row";
    const input = document.createElement("input");
    input.type = "text";
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "在这里输入…";
    row.appendChild(input);

    const hintTxt = document.createElement("div");
    hintTxt.className = "spell-hint-txt";
    const fb = document.createElement("div");
    fb.className = "spell-feedback";

    const actions = document.createElement("div");
    actions.className = "spell-actions";
    const submit = mkBtn("btn btn-primary", "✅ 检查", () => checkSpell());
    const listen = mkBtn("btn btn-round", "🔊 听发音", () => speak(w.en));
    const hintBtn = mkBtn("btn btn-round", "💡 提示", () => {
      spellHintCount = Math.min(spellHintCount + 1, w.en.length);
      const shown = w.en.slice(0, spellHintCount);
      hintTxt.textContent = shown + "_".repeat(Math.max(0, w.en.length - spellHintCount));
    });
    const skip = mkBtn("btn btn-round", "⏭️ 跳过", () => {
      spellIdx++;
      renderSpell();
    });
    actions.append(submit, listen, hintBtn, skip);

    function checkSpell() {
      const val = input.value.trim().toLowerCase();
      if (!val) return;
      if (val === w.en.toLowerCase()) {
        fb.textContent = "🎉 拼对啦！太棒了！";
        fb.className = "spell-feedback ok";
        w.reps = (w.reps || 0) + 1;
        w.last = Date.now();
        save();
        addStars(1);
        setTimeout(() => {
          spellIdx++;
          renderSpell();
        }, 900);
      } else {
        fb.textContent = "再想想～正确答案：" + w.en;
        fb.className = "spell-feedback no";
        w.wrong = (w.wrong || 0) + 1;
        recordMistake({ wordId: w.id, mode: "spell", prompt: w.zh, answer: input.value.trim(), correct: w.en });
        save();
        speak(w.en);
      }
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") checkSpell();
    });

    area.append(q, row, hintTxt, fb, actions);
    input.focus();
  }

  /* ---------------- 复习模式 ---------------- */
  let reviewList = [],
    reviewIdx = 0,
    reviewShown = false;
  function resetReview() {
    $("#review-setup").hidden = false;
    $("#review-area").hidden = true;
    $("#review-controls").hidden = true;
    $("#review-progress").style.width = "0%";
  }
  function bindReview() {
    $("#review-start").addEventListener("click", () => {
      const range = $("#review-range").value;
      reviewList = range === "due" ? pool("due") : shuffle(pool(range));
      if (!reviewList.length) return toast("这个范围里还没有单词哦", "err");
      reviewIdx = 0;
      $("#review-setup").hidden = true;
      $("#review-area").hidden = false;
      $("#review-controls").hidden = false;
      renderReview();
    });
    $("#review-show").addEventListener("click", showReviewAnswer);
    $("#review-speak").addEventListener("click", () => {
      if (reviewList[reviewIdx]) speak(reviewList[reviewIdx].en);
    });
    $("#review-known").addEventListener("click", () => gradeReview(true));
    $("#review-unknown").addEventListener("click", () => gradeReview(false));
  }
  function renderReview() {
    reviewShown = false;
    $("#review-known").disabled = true;
    $("#review-unknown").disabled = true;
    const area = $("#review-area");
    if (reviewIdx >= reviewList.length) {
      area.innerHTML =
        '<div class="review-card"><div class="rc-zh">🎉 复习完成！</div>' +
        '<div class="rc-ex">共复习 ' + reviewList.length + " 个单词，继续保持～</div></div>";
      $("#review-controls").hidden = true;
      $("#review-progress").style.width = "100%";
      addStars(3);
      toast("复习完成 +3⭐", "ok");
      return;
    }
    const w = reviewList[reviewIdx];
    area.innerHTML = "";
    const card = document.createElement("div");
    card.className = "review-card";
    const zh = document.createElement("div");
    zh.className = "rc-zh";
    zh.textContent = w.zh;
    card.appendChild(zh);
    const ansHint = document.createElement("div");
    ansHint.className = "fc-hint";
    ansHint.textContent = "先回想英文，再点「显示答案」";
    ansHint.style.marginTop = "10px";
    ansHint.style.color = "#b0a89c";
    card.appendChild(ansHint);
    area.appendChild(card);
    const pct = (reviewIdx / reviewList.length) * 100;
    $("#review-progress").style.width = pct + "%";
  }
  function showReviewAnswer() {
    if (reviewShown || reviewIdx >= reviewList.length) return;
    reviewShown = true;
    const w = reviewList[reviewIdx];
    const card = $("#review-area .review-card");
    if (!card) return;
    const ans = document.createElement("div");
    ans.className = "rc-answer";
    const en = document.createElement("div");
    en.className = "rc-en";
    en.textContent = w.en;
    ans.appendChild(en);
    if (w.phonetic) {
      const ph = document.createElement("div");
      ph.className = "rc-phon";
      ph.textContent = w.phonetic;
      ans.appendChild(ph);
    }
    if (w.ex) {
      const ex = document.createElement("div");
      ex.className = "rc-ex";
      ex.textContent = w.ex;
      ans.appendChild(ex);
    }
    card.appendChild(ans);
    speak(w.en);
    $("#review-known").disabled = false;
    $("#review-unknown").disabled = false;
  }
  function gradeReview(known) {
    if (!reviewShown) return toast("先点「显示答案」再自评哦", "");
    const w = reviewList[reviewIdx];
    scheduleReview(w, known);
    if (!known) recordMistake({ wordId: w.id, mode: "review", prompt: w.zh, answer: "", correct: w.en });
    save();
    if (known) addStars(1);
    reviewIdx++;
    renderReview();
    renderStats();
  }

  /* ---------------- 考试模式 ---------------- */
  let examQs = [],
    examIdx = 0,
    examScore = 0,
    examLog = [];
  function resetExam() {
    $("#exam-setup").hidden = false;
    $("#exam-area").hidden = true;
    $("#exam-result").hidden = true;
  }
  function bindExam() {
    $("#exam-start").addEventListener("click", () => {
      const num = parseInt($("#exam-num").value, 10);
      const type = $("#exam-type").value;
      const range = $("#exam-range").value;
      const src = pool(range);
      if (src.length < 4) return toast("至少要有 4 个单词才能考试哦", "err");
      const chosen = shuffle(src).slice(0, Math.min(num, src.length));
      examQs = chosen.map((w) => buildQuestion(w, type, src));
      examIdx = 0;
      examScore = 0;
      examLog = [];
      $("#exam-setup").hidden = true;
      $("#exam-result").hidden = true;
      $("#exam-area").hidden = false;
      renderExam();
    });
  }
  function buildQuestion(w, type, src) {
    const ask = type === "en2zh" ? w.en : w.zh;
    const correct = type === "en2zh" ? w.zh : w.en;
    const distractPool = src.filter((x) => x.id !== w.id);
    const distract = shuffle(distractPool)
      .slice(0, 3)
      .map((x) => (type === "en2zh" ? x.zh : x.en));
    // 若不足 3 个干扰项则去重补齐
    const opts = shuffle([correct, ...distract].filter((v, i, a) => a.indexOf(v) === i));
    return { w, ask, correct, opts, type };
  }
  function renderExam() {
    const area = $("#exam-area");
    if (examIdx >= examQs.length) return finishExam();
    const q = examQs[examIdx];
    area.innerHTML = "";
    const prog = document.createElement("div");
    prog.className = "exam-progress";
    prog.textContent = `第 ${examIdx + 1} / ${examQs.length} 题　得分 ${examScore}`;
    const card = document.createElement("div");
    card.className = "exam-q-card";
    const title = document.createElement("div");
    title.className = "exam-q-title";
    title.textContent = q.ask;
    card.appendChild(title);
    if (q.type === "en2zh") {
      const spk = mkBtn("btn btn-round", "🔊 听发音", () => speak(q.w.en));
      spk.style.display = "block";
      spk.style.margin = "0 auto 14px";
      card.appendChild(spk);
    }
    const optsWrap = document.createElement("div");
    optsWrap.className = "exam-options";
    q.opts.forEach((opt) => {
      const b = document.createElement("button");
      b.className = "exam-option";
      b.textContent = opt;
      b.addEventListener("click", () => answerExam(b, opt, q, optsWrap));
      optsWrap.appendChild(b);
    });
    card.appendChild(optsWrap);
    area.appendChild(prog);
    area.appendChild(card);
  }
  function answerExam(btn, opt, q, wrap) {
    Array.from(wrap.children).forEach((b) => (b.disabled = true));
    const ok = opt === q.correct;
    if (ok) {
      btn.classList.add("correct");
      examScore++;
      q.w.reps = (q.w.reps || 0) + 1;
    } else {
      btn.classList.add("wrong");
      q.w.wrong = (q.w.wrong || 0) + 1;
      recordMistake({ wordId: q.w.id, mode: "exam", prompt: q.ask, answer: opt, correct: q.correct });
      Array.from(wrap.children).forEach((b) => {
        if (b.textContent === q.correct) b.classList.add("correct");
      });
    }
    q.w.last = Date.now();
    save();
    examLog.push({ ask: q.ask, correct: q.correct, chosen: opt, ok });
    setTimeout(() => {
      examIdx++;
      renderExam();
    }, 950);
  }
  function finishExam() {
    $("#exam-area").hidden = true;
    const box = $("#exam-result");
    box.hidden = false;
    box.innerHTML = "";
    const total = examQs.length;
    const pct = Math.round((examScore / total) * 100);
    const score = document.createElement("div");
    score.className = "er-score";
    score.textContent = examScore + " / " + total;
    const msg = document.createElement("div");
    msg.className = "er-msg";
    let m = "继续加油！💪";
    if (pct === 100) m = "满分！你太厉害了！🏆";
    else if (pct >= 80) m = "很棒！继续保持～🌟";
    else if (pct >= 60) m = "不错哦，再练练就更好啦！👍";
    msg.textContent = m;
    box.appendChild(score);
    box.appendChild(msg);

    examLog.forEach((l) => {
      const d = document.createElement("div");
      d.className = "exam-review-item " + (l.ok ? "ok" : "no");
      d.textContent = l.ok
        ? `${l.ask} → ${l.correct}`
        : `${l.ask} → 正确：${l.correct}（你选了：${l.chosen}）`;
      box.appendChild(d);
    });

    const again = mkBtn("btn btn-primary", "🔄 再考一次", resetExam);
    again.style.marginTop = "16px";
    box.appendChild(again);

    // 考后有错题 → 提供跳转错题本入口
    const wrongCount = examLog.filter((l) => !l.ok).length;
    const toMb = $("#exam-tomistakes");
    toMb.hidden = wrongCount === 0;
    toMb.innerHTML = "";
    if (wrongCount > 0) {
      const b = mkBtn("btn btn-primary", `📕 查看错题本（${wrongCount} 道）`, () => switchView("mistakes"));
      b.style.marginTop = "10px";
      toMb.appendChild(b);
    }

    const stars = Math.max(1, Math.round(examScore / 2));
    addStars(stars);
    toast(`考试结束，得 ${examScore} 分 +${stars}⭐`, "ok");
    renderStats();
  }

  /* ---------------- 配对游戏 ---------------- */
  let gameSel = null,
    gameMatched = 0,
    gamePairs = 0;
  function resetGame() {
    $("#game-setup").hidden = false;
    $("#game-board").hidden = true;
    $("#game-result").hidden = true;
  }
  function bindGame() {
    $("#game-start").addEventListener("click", () => {
      const n = parseInt($("#game-num").value, 10);
      const pairs = n / 2;
      const src = shuffle(state.words.slice());
      if (src.length < pairs) return toast(`至少要有 ${pairs} 个单词才能玩哦`, "err");
      const chosen = src.slice(0, pairs);
      gamePairs = pairs;
      gameMatched = 0;
      gameSel = null;
      const cells = [];
      chosen.forEach((w) => {
        cells.push({ pid: w.id, text: w.en, type: "en", word: w });
        cells.push({ pid: w.id, text: w.zh, type: "zh", word: w });
      });
      const board = $("#game-board");
      board.innerHTML = "";
      board.hidden = false;
      $("#game-setup").hidden = true;
      $("#game-result").hidden = true;
      shuffle(cells).forEach((c) => {
        const el = document.createElement("button");
        el.className = "game-cell " + c.type;
        el.textContent = c.text;
        el.dataset.pid = c.pid;
        el.dataset.type = c.type;
        el.addEventListener("click", () => onGameCell(el, c));
        board.appendChild(el);
      });
    });
  }
  function onGameCell(el, c) {
    if (el.classList.contains("matched") || el.classList.contains("selected")) return;
    if (c.type === "en") speak(c.text);
    if (!gameSel) {
      gameSel = { el, c };
      el.classList.add("selected");
      return;
    }
    if (gameSel.el === el) return;
    // 需一英一中且同一 pid
    const a = gameSel.c,
      b = c;
    const match = a.pid === b.pid && a.type !== b.type;
    if (match) {
      gameSel.el.classList.remove("selected");
      gameSel.el.classList.add("matched");
      el.classList.add("matched");
      gameSel = null;
      gameMatched++;
      if (gameMatched === gamePairs) finishGame();
    } else {
      const first = gameSel.el;
      el.classList.add("selected", "shake");
      first.classList.add("shake");
      const f = gameSel;
      gameSel = null;
      // 记录配对连错：英文词 A 被错配成中文 B
      const enCell = a.type === "en" ? a : b;
      const zhCell = a.type === "en" ? b : a;
      recordMistake({ wordId: enCell.word.id, mode: "game", prompt: enCell.text, answer: zhCell.text, correct: enCell.word.zh });
      setTimeout(() => {
        first.classList.remove("selected", "shake");
        el.classList.remove("selected", "shake");
      }, 500);
    }
  }
  function finishGame() {
    const box = $("#game-result");
    box.hidden = false;
    box.innerHTML =
      '<div class="gr-emoji">🎉🐻</div><div class="er-score">全部配对成功！</div>' +
      '<div class="er-msg">你的记忆力真棒！</div>';
    const again = mkBtn("btn btn-primary", "🎲 再玩一局", resetGame);
    again.style.marginTop = "12px";
    box.appendChild(again);
    const stars = gamePairs;
    addStars(stars);
    toast(`配对全部完成 +${stars}⭐`, "ok");
  }

  /* ---------------- 错题本：渲染与交互 ---------------- */
  const MODE_LABEL = { spell: "拼写", exam: "考试", review: "复习", game: "配对", legacy: "历史" };
  let showResolved = false;

  function relTime(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return m + " 分钟前";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " 小时前";
    const d = Math.floor(h / 24);
    return d + " 天前";
  }

  function renderMistakes() {
    syncResolved();
    const ul = $("#mistake-list");
    const modeFilter = $("#mistake-mode-filter").value;
    const q = ($("#mistake-search").value || "").trim().toLowerCase();
    ul.innerHTML = "";

    let items = state.mistakes.slice().sort((a, b) => b.at - a.at); // 最新在前
    if (!showResolved) items = items.filter((m) => !m.resolved);
    if (modeFilter) items = items.filter((m) => m.mode === modeFilter);
    if (q)
      items = items.filter(
        (m) =>
          (m.en || "").toLowerCase().includes(q) ||
          (m.zh || "").toLowerCase().includes(q) ||
          (m.prompt || "").toLowerCase().includes(q)
      );

    const pending = state.mistakes.filter((m) => !m.resolved).length;
    $("#mistake-count").textContent = pending;
    $("#mistake-empty-hint").style.display = items.length === 0 ? "block" : "none";

    items.forEach((m) => {
      const li = document.createElement("li");
      li.className = "mistake-item" + (m.resolved ? " resolved" : "");

      const top = document.createElement("div");
      top.className = "mi-top";
      const prompt = document.createElement("span");
      prompt.className = "mi-prompt";
      prompt.textContent = m.prompt || m.en;
      const badge = document.createElement("span");
      badge.className = "mi-badge " + m.mode;
      badge.textContent = MODE_LABEL[m.mode] || m.mode;
      top.append(prompt, badge);

      const answers = document.createElement("div");
      answers.className = "mi-answers";
      const ans = document.createElement("div");
      ans.className = "mi-answer";
      const aLabel = document.createElement("span");
      aLabel.textContent = "你的答案：";
      const aVal = document.createElement("b");
      aVal.textContent = m.answer || (m.mode === "review" ? "（没记住）" : "—");
      ans.append(aLabel, aVal);
      const cor = document.createElement("div");
      cor.className = "mi-correct";
      const cLabel = document.createElement("span");
      cLabel.textContent = "正确答案：";
      const cVal = document.createElement("b");
      cVal.textContent = m.correct || m.en;
      cor.append(cLabel, cVal);
      answers.append(ans, cor);

      const meta = document.createElement("div");
      meta.className = "mi-meta";
      const time = document.createElement("span");
      time.textContent = "🕒 " + relTime(m.at);
      meta.appendChild(time);

      const actions = document.createElement("div");
      actions.className = "mi-actions";
      const w = m.wordId && state.words.find((x) => x.id === m.wordId);
      if (w) {
        actions.appendChild(mkBtn("btn btn-round", "🔁 去巩固", () => practiceWord(m.wordId)));
      } else {
        const note = document.createElement("span");
        note.className = "mi-removed-note";
        note.textContent = "（原词已删除）";
        actions.appendChild(note);
      }
      if (!m.resolved) {
        actions.appendChild(
          mkBtn("btn btn-round", "✅ 标记攻克", () => {
            m.resolved = true;
            const w = m.wordId && state.words.find((x) => x.id === m.wordId);
            if (w) {
              w.wrong = 0;
              w.reps = Math.max(w.reps || 0, 3); // 标记攻克视为连续掌握
            }
            save();
            renderMistakes();
            renderStats();
            toast("已标记为攻克 🧹", "ok");
          })
        );
      }
      actions.appendChild(
        mkBtn("btn btn-round", "🗑️ 移除", () => {
          state.mistakes = state.mistakes.filter((x) => x.id !== m.id);
          save();
          renderMistakes();
          renderStats();
          toast("已从错题本移除");
        })
      );

      li.append(top, answers, meta, actions);
      ul.appendChild(li);
    });
  }

  // 去巩固：复用复习模式「仅错词」筛选，错题中的词必定在列表中
  function practiceWord(id) {
    $("#review-range").value = "wrong";
    switchView("review");
    $("#review-start").click();
    toast("已为你打开复习（仅错词）🔄", "");
  }

  function bindMistakes() {
    $("#mistake-mode-filter").addEventListener("change", renderMistakes);
    $("#mistake-search").addEventListener("input", renderMistakes);
    $("#btn-mistake-practice").addEventListener("click", () => {
      if (!pool("wrong").length) return toast("暂时没有需要巩固的错题哦", "");
      practiceWord();
    });
    $("#mistake-show-resolved").addEventListener("click", () => {
      showResolved = !showResolved;
      $("#mistake-show-resolved").textContent = showResolved ? "👀 看未攻克" : "👀 看已攻克";
      renderMistakes();
    });
    $("#btn-mistake-clear").addEventListener("click", () => {
      if (!state.mistakes.length) return toast("错题本已经是空的啦", "");
      if (confirm("确定要清空整个错题本吗？此操作不可恢复！")) {
        state.mistakes = [];
        save();
        renderMistakes();
        renderStats();
        toast("已清空错题本");
      }
    });
  }

  /* ---------------- 通用按钮生成 ---------------- */
  function mkBtn(cls, text, fn) {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  }

  /* ---------------- 示例词库 ---------------- */
  const SAMPLE = [
    { en: "apple", zh: "苹果", cat: "食物", ex: "I eat an apple every day.", phonetic: "/ˈæp.əl/" },
    { en: "banana", zh: "香蕉", cat: "食物", ex: "The monkey likes bananas.", phonetic: "/bəˈnɑː.nə/" },
    { en: "cat", zh: "猫", cat: "动物", ex: "The cat is sleeping.", phonetic: "/kæt/" },
    { en: "dog", zh: "狗", cat: "动物", ex: "My dog is very friendly.", phonetic: "/dɒɡ/" },
    { en: "elephant", zh: "大象", cat: "动物", ex: "An elephant is very big.", phonetic: "/ˈel.ɪ.fənt/" },
    { en: "red", zh: "红色", cat: "颜色", ex: "The apple is red.", phonetic: "/red/" },
    { en: "blue", zh: "蓝色", cat: "颜色", ex: "The sky is blue.", phonetic: "/bluː/" },
    { en: "green", zh: "绿色", cat: "颜色", ex: "The grass is green.", phonetic: "/ɡriːn/" },
    { en: "school", zh: "学校", cat: "地点", ex: "I go to school by bus.", phonetic: "/skuːl/" },
    { en: "teacher", zh: "老师", cat: "人物", ex: "My teacher is kind.", phonetic: "/ˈtiː.tʃər/" },
    { en: "water", zh: "水", cat: "食物", ex: "Please drink some water.", phonetic: "/ˈwɔː.tər/" },
    { en: "book", zh: "书", cat: "物品", ex: "This is my English book.", phonetic: "/bʊk/" },
    { en: "happy", zh: "开心的", cat: "情绪", ex: "I am happy today.", phonetic: "/ˈhæp.i/" },
    { en: "run", zh: "跑", cat: "动作", ex: "I can run fast.", phonetic: "/rʌn/" },
    { en: "sun", zh: "太阳", cat: "自然", ex: "The sun is shining.", phonetic: "/sʌn/" },
    { en: "moon", zh: "月亮", cat: "自然", ex: "The moon is bright.", phonetic: "/muːn/" },
  ];

  /* ---------------- 启动 ---------------- */
  function init() {
    load();
    migrateLegacyMistakes();
    checkin();
    bindTabs();
    bindBook();
    bindLearn();
    bindSpell();
    bindReview();
    bindExam();
    bindGame();
    bindMistakes();
    bindSync();
    renderAll();
    // 首屏渲染后，若已开启同步则拉取云端
    if (getSyncOn() && getSyncPass()) pullSync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
