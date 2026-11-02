/* Personal Tracker — vanilla JS, offline-first, localStorage only.
   Single state object + save()/load(). Schema versioned for migrations. */
'use strict';

/* ---------- constants ---------- */
var STORE_KEY = 'personal-tracker-v1';
var THEME_KEY = 'personal-tracker-theme'; // 'auto' | 'light' | 'dark'
var SCHEMA_VERSION = 1;

/* ---------- tiny utils ---------- */
function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

/* ---------- dates (local time, YYYY-MM-DD) ---------- */
function fmtDate(d) {
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}
function todayStr() { return fmtDate(new Date()); }
function parseD(s) {
  var p = String(s || '').split('-');
  if (p.length !== 3) return null;
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  return isNaN(d) ? null : d;
}
function addDaysStr(dateStr, n) {
  var d = parseD(dateStr) || new Date();
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
function monthKey(dateStr) { return String(dateStr || '').slice(0, 7); } // YYYY-MM
// Normalize to YYYY-MM-DD (pads 2026-9-5 -> 2026-09-05, strips time). Falls back to today.
function normDateStr(s, fallback) {
  var raw = String(s || '').trim().slice(0, 10);
  var m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return fallback || todayStr();
  var y = m[1], mo = String(+m[2]).padStart(2, '0'), d = String(+m[3]).padStart(2, '0');
  var dt = parseD(y + '-' + mo + '-' + d);
  if (!dt) return fallback || todayStr();
  // Reject rollover dates like 2026-02-30 (JS rolls into March).
  if (dt.getFullYear() !== +y || (dt.getMonth() + 1) !== +mo || dt.getDate() !== +d) return fallback || todayStr();
  return y + '-' + mo + '-' + d;
}
function monthLabel(ym) { // '2026-10' -> 'Oct 2026'
  var p = String(ym || '').split('-');
  if (p.length < 2) return ym;
  return (MONTHS[(+p[1]) - 1] || p[1]) + ' ' + p[0];
}
function shiftMonth(ym, delta) {
  var p = String(ym || monthKey(todayStr())).split('-');
  var d = new Date(+p[0], (+p[1]) - 1 + delta, 1);
  return fmtDate(d).slice(0, 7);
}
function startOfWeekStr(dateStr) { // Monday start
  var d = parseD(dateStr) || new Date();
  var dow = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - dow);
  return fmtDate(d);
}
function inRange(dateStr, range) {
  if (range === 'all') return true;
  var t = todayStr();
  if (range === 'today') return dateStr === t;
  if (range === 'month') return monthKey(dateStr) === monthKey(t);
  if (range === 'week') {
    return dateStr >= startOfWeekStr(t) && dateStr <= t;
  }
  if (range === 'open' || range === 'done') return true;
  return true;
}
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// '2026-10-17' -> 'Today' / 'Yesterday' / 'Oct 17' / 'Oct 17, 2025'
function niceDate(dateStr) {
  var d = parseD(dateStr);
  if (!d) return String(dateStr || '');
  var t = todayStr();
  if (dateStr === t) return 'Today';
  if (dateStr === addDaysStr(t, -1)) return 'Yesterday';
  if (dateStr === addDaysStr(t, 1)) return 'Tomorrow';
  var s = MONTHS[d.getMonth()] + ' ' + d.getDate();
  return d.getFullYear() === new Date().getFullYear() ? s : s + ', ' + d.getFullYear();
}
function iconBtns(kind, id, label) {
  return '<div class="actions">' +
    '<button type="button" class="btn btn-icon" data-edit-' + kind + '="' + esc(id) + '" aria-label="Edit ' + esc(label) + '"><svg class="ico" aria-hidden="true"><use href="#i-edit"/></svg></button>' +
    '<button type="button" class="btn btn-icon danger" data-del-' + kind + '="' + esc(id) + '" aria-label="Delete ' + esc(label) + '"><svg class="ico" aria-hidden="true"><use href="#i-trash"/></svg></button></div>';
}
// Click delegation: icons inside buttons are the event target, so look up the button.
function dataFrom(e, attr) {
  var el = e.target && e.target.closest ? e.target.closest('[' + attr + ']') : null;
  return el ? el.getAttribute(attr) : null;
}
function money(n) {
  // Philippine Peso formatting, e.g. ₱1,234.50
  var v = Number(n) || 0;
  var abs = Math.abs(v);
  var grouped;
  try { grouped = abs.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  catch (e) { grouped = abs.toFixed(2); }
  return (v < 0 ? '-' : '') + '₱' + grouped;
}

/* ---------- state ---------- */
function defaultState() {
  return {
    version: SCHEMA_VERSION,
    habits: [],   // {id,name,created,checks:{YYYY-MM-DD:true}}
    health: [],   // {id,date,water,sleep,workout,weight,note}
    finance: [],  // {id,type:'income'|'expense',amount,category,description,payMethod,date}
    goals: [],    // {id,title,deadline,created}
    tasks: [],    // {id,title,due,priority,done,goalId,created}
    budgets: [],  // {category, amount} monthly spending limit per expense category
    settings: { theme: 'auto' }
  };
}
var state = defaultState();
var dataMsgTimer = null;

function save() {
  undoSnap = null; // any later change makes the old snapshot unsafe to restore
  try {
    state.version = SCHEMA_VERSION;
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    updateStorageInfo();
    return true;
  } catch (e) {
    showMsg('Could not save (storage full or blocked). ' + (e && e.message ? e.message : ''), true);
    return false;
  }
}
function load() {
  var raw = null;
  try { raw = localStorage.getItem(STORE_KEY); }
  catch (e) { raw = null; }
  if (!raw) { state = defaultState(); return; }
  try {
    var parsed = JSON.parse(raw);
    state = migrate(parsed);
  } catch (e) {
    // Corrupted data: keep a backup key, start fresh, warn user.
    try { localStorage.setItem(STORE_KEY + '-corrupt-backup', raw); } catch (_) {}
    state = defaultState();
    setTimeout(function () {
      showMsg('Saved data was corrupted, so we started fresh. A backup was kept in this browser.', true);
    }, 0);
  }
}
// Migrate / sanitize unknown data into the current schema.
function migrate(s) {
  var d = defaultState();
  if (!s || typeof s !== 'object') return d;
  function arr(v) { return Array.isArray(v) ? v : []; }
  d.habits = arr(s.habits).filter(function (h) { return h && typeof h.name === 'string'; }).map(function (h) {
    return { id: String(h.id || uid()), name: String(h.name).slice(0, 80), created: h.created || todayStr(), checks: (h.checks && typeof h.checks === 'object') ? h.checks : {} };
  });
  d.health = arr(s.health).map(function (h) {
    return { id: String(h.id || uid()), date: normDateStr(h.date), water: numOrNull(h.water), sleep: numOrNull(h.sleep), workout: numOrNull(h.workout), weight: numOrNull(h.weight), note: String(h.note || '').slice(0, 140) };
  }).filter(function (h) { return !!parseD(h.date); });
  d.finance = arr(s.finance).map(function (f) {
    // note (old field name) folds into description so old backups keep their text
    var t = (f.type === 'income' || f.type === 'transfer') ? f.type : 'expense';
    return { id: String(f.id || uid()), type: t, amount: Math.abs(Number(f.amount) || 0), category: String(f.category || (t === 'transfer' ? 'Transfer' : 'Other')).slice(0, 40), description: String(f.description || f.note || '').slice(0, 140), payMethod: String(f.payMethod || '').slice(0, 30), fee: Math.abs(Number(f.fee) || 0), fromWallet: String(f.fromWallet || f.payMethod || '').slice(0, 30), toWallet: String(f.toWallet || '').slice(0, 30), date: normDateStr(f.date) };
  }).filter(function (f) { return f.amount > 0 && !!parseD(f.date); });
  d.goals = arr(s.goals).filter(function (g) { return g && typeof g.title === 'string'; }).map(function (g) {
    return { id: String(g.id || uid()), title: String(g.title).slice(0, 100), deadline: g.deadline || '', created: g.created || todayStr() };
  });
  d.tasks = arr(s.tasks).filter(function (t) { return t && typeof t.title === 'string'; }).map(function (t) {
    return { id: String(t.id || uid()), title: String(t.title).slice(0, 140), due: t.due || '', priority: ['low', 'medium', 'high'].indexOf(t.priority) >= 0 ? t.priority : 'medium', done: !!t.done, goalId: t.goalId || '', created: t.created || todayStr() };
  });
  var seenBud = {};
  d.budgets = arr(s.budgets).map(function (b) {
    return { category: String((b && b.category) || '').trim().slice(0, 40), amount: Math.round(Math.abs(Number(b && b.amount) || 0) * 100) / 100 };
  }).filter(function (b) {
    var k = b.category.toLowerCase();
    if (!b.category || !(b.amount > 0) || seenBud[k]) return false;
    seenBud[k] = true; return true;
  });
  if (s.settings && typeof s.settings.theme === 'string') d.settings.theme = s.settings.theme;
  d.version = SCHEMA_VERSION;
  return d;
}
function numOrNull(v) {
  if (v === '' || v == null) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/* ---------- UI helpers ---------- */
function showMsg(text, isErr, withUndo) {
  var el = $('#toast');
  if (!el) return;
  if (!withUndo) undoSnap = null; // the Undo button is gone, so drop its snapshot
  // A modal <dialog> sits in the top layer above everything; show the toast inside it
  // so messages like "Pick a category." aren't hidden behind the sheet.
  var host = document.querySelector('dialog[open]') || document.body;
  if (el.parentNode !== host) host.appendChild(el);
  el.innerHTML = '<span class="toast-text"></span>' + (withUndo ? '<button type="button" class="toast-undo" id="toastUndo">Undo</button>' : '');
  el.firstChild.textContent = text;
  el.classList.toggle('is-error', !!isErr);
  el.classList.toggle('has-action', !!withUndo);
  el.hidden = false;
  if (withUndo) $('#toastUndo').addEventListener('click', undoDelete);
  clearTimeout(dataMsgTimer);
  dataMsgTimer = setTimeout(function () {
    el.hidden = true;
    if (withUndo) undoSnap = null;
  }, withUndo ? 6000 : isErr ? 6000 : 3500);
}
/* ---------- delete with undo (instead of "Are you sure?" popups) ---------- */
var undoSnap = null;
function deleteWithUndo(msg, mutate) {
  var snap = JSON.stringify(state);
  mutate();
  if (!save()) { // keep screen and storage in sync; save() already showed the error
    state = migrate(JSON.parse(snap)); renderAll(); return;
  }
  renderAll();
  undoSnap = snap; // armed after save(), which clears it
  showMsg(msg, false, true);
}
function undoDelete() {
  if (!undoSnap) return;
  var snap = undoSnap;
  try { state = migrate(JSON.parse(snap)); } catch (e) { return; }
  save(); renderAll();
  showMsg('Restored.');
}
function updateStorageInfo() {
  try {
    var bytes = (localStorage.getItem(STORE_KEY) || '').length;
    var last = lsNum(BACKUP_KEY);
    $('#storageInfo').textContent = (bytes / 1024).toFixed(1) + ' KB stored locally · ' + (last ? 'backed up ' + daysAgoText(last) : 'not backed up yet');
  } catch (e) { /* private mode */ }
}

/* ---------- theme ---------- */
function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || (state.settings && state.settings.theme) || 'auto'; }
  catch (e) { return 'auto'; }
}
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  var sysDark = false;
  try { sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {}
  var dark = mode === 'dark' || (mode === 'auto' && sysDark);
  var name = mode === 'auto' ? 'Auto' : (mode === 'dark' ? 'Dark' : 'Light');
  var btn = $('#themeToggle');
  var icon = mode === 'auto' ? 'i-auto' : (dark ? 'i-moon' : 'i-sun');
  btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + icon + '"/></svg> <span class="btn-text">' + name + '</span>';
  btn.setAttribute('aria-label', 'Theme: ' + name + ' (tap to change)');
  // Status bar / browser chrome follows the chosen theme, not just the system one.
  $all('meta[name="theme-color"]').forEach(function (m) {
    m.setAttribute('content', dark ? '#12151b' : '#ffffff');
  });
}
function initTheme() {
  applyTheme(currentTheme());
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (currentTheme() === 'auto') applyTheme('auto');
    });
  } catch (e) { /* older browsers */ }
  $('#themeToggle').addEventListener('click', function () {
    var order = ['auto', 'light', 'dark'];
    var next = order[(order.indexOf(currentTheme()) + 1) % order.length];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    state.settings.theme = next;
    try { save(); } catch (e) {}
    applyTheme(next);
  });
}

/* ---------- tabs ---------- */
var TAB_NAMES = ['dashboard', 'habits', 'health', 'finance', 'tasks'];
function tabFromHash() {
  var h = (location.hash || '').replace('#', '');
  return TAB_NAMES.indexOf(h) >= 0 ? h : 'dashboard';
}
function initTabs() {
  $all('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () { goTab(btn.dataset.tab); });
  });
  // KPI cards are <a href="#habits"> etc.; hashchange handles them and the back button.
  window.addEventListener('hashchange', function () { switchTab(tabFromHash()); window.scrollTo(0, 0); });
  switchTab(tabFromHash());
}
function goTab(name) {
  if (tabFromHash() === name) { window.scrollTo(0, 0); return; }
  location.hash = name === 'dashboard' ? '' : name; // fires hashchange -> switchTab
  if (name === 'dashboard') { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} switchTab('dashboard'); window.scrollTo(0, 0); }
}
function switchTab(name) {
  $all('.tab').forEach(function (b) {
    var on = b.dataset.tab === name;
    b.classList.toggle('is-active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $all('.view').forEach(function (v) {
    var on = v.id === 'view-' + name;
    v.classList.toggle('is-active', on);
    if (on) v.removeAttribute('hidden'); else v.setAttribute('hidden', '');
  });
  if (name === 'dashboard') renderDashboard();
}

/* ---------- habits ---------- */
var editingHabitId = null;
function habitStreak(h) {
  var t = todayStr(), streak = 0, d = t;
  if (!h.checks[d]) d = addDaysStr(t, -1); // allow "still alive" if today unchecked
  while (h.checks[d]) { streak++; d = addDaysStr(d, -1); }
  return streak;
}
function renderHabits() {
  var t = todayStr();
  var list = $('#habitList');
  $('#habitEmpty').style.display = state.habits.length ? 'none' : '';
  var doneCount = state.habits.filter(function (h) { return h.checks[t]; }).length;
  $('#habitProgress').textContent = state.habits.length ? doneCount + ' of ' + state.habits.length + ' done' : '';
  var week = last7();
  list.innerHTML = state.habits.map(function (h) {
    var done = !!h.checks[t];
    var streak = habitStreak(h);
    var dots = week.map(function (d) {
      return '<i class="' + (h.checks[d] ? 'on' : '') + (d === t ? ' today' : '') + '"></i>';
    }).join('');
    return '<li class="habit-row' + (done ? ' is-done' : '') + '">' +
      '<label class="check-wrap"><input type="checkbox" data-check="' + esc(h.id) + '" ' + (done ? 'checked' : '') + ' aria-label="Mark ' + esc(h.name) + ' done today"></label>' +
      '<div class="grow"><span class="habit-name' + (done ? ' done-text' : '') + '">' + esc(h.name) + '</span>' +
      '<div class="habit-sub"><span class="week-dots" title="Last 7 days" aria-hidden="true">' + dots + '</span>' +
      '<span class="streak' + (streak >= 3 ? ' hot' : '') + '" title="Consecutive days">' + (streak ? '🔥 ' + streak + '-day streak' : 'No streak yet') + '</span></div></div>' +
      iconBtns('habit', h.id, h.name) + '</li>';
  }).join('');
}
function initHabits() {
  $('#habitForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('#habitName').value.trim();
    if (!name) return;
    if (editingHabitId) {
      var h = state.habits.find(function (x) { return x.id === editingHabitId; });
      if (h) h.name = name;
      editingHabitId = null;
      $('#habitFormTitle').textContent = 'Add a habit';
      $('#habitSubmit').textContent = 'Add habit';
      $('#habitCancel').hidden = true;
    } else {
      state.habits.push({ id: uid(), name: name, created: todayStr(), checks: {} });
    }
    $('#habitName').value = '';
    save(); renderAll();
  });
  $('#habitCancel').addEventListener('click', function () {
    editingHabitId = null; $('#habitName').value = '';
    $('#habitFormTitle').textContent = 'Add a habit';
    $('#habitSubmit').textContent = 'Add habit';
    $('#habitCancel').hidden = true;
  });
  $('#habitList').addEventListener('change', function (e) {
    var id = e.target.getAttribute('data-check');
    if (!id) return;
    var h = state.habits.find(function (x) { return x.id === id; });
    if (!h) return;
    if (e.target.checked) h.checks[todayStr()] = true; else delete h.checks[todayStr()];
    save(); renderAll();
  });
  $('#habitList').addEventListener('click', function (e) {
    var ed = dataFrom(e, 'data-edit-habit');
    var del = dataFrom(e, 'data-del-habit');
    if (ed) {
      var h = state.habits.find(function (x) { return x.id === ed; });
      if (!h) return;
      editingHabitId = ed;
      $('#habitName').value = h.name;
      $('#habitForm').scrollIntoView({ block: 'center', behavior: 'smooth' });
      $('#habitName').focus({ preventScroll: true });
      $('#habitFormTitle').textContent = 'Edit habit';
      $('#habitSubmit').textContent = 'Save';
      $('#habitCancel').hidden = false;
    }
    if (del) {
      if (editingHabitId === del) $('#habitCancel').click();
      deleteWithUndo('Habit deleted.', function () {
        state.habits = state.habits.filter(function (x) { return x.id !== del; });
      });
    }
  });
}

/* ---------- health ---------- */
var healthRange = 'today', editingHealthId = null;
function renderHealth() {
  var items = state.health.filter(function (h) { return inRange(h.date, healthRange); })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  $('#healthEmpty').style.display = items.length ? 'none' : '';
  $('#healthList').innerHTML = items.map(function (h) {
    var bits = [];
    if (h.water != null) bits.push('💧 ' + h.water + ' glasses');
    if (h.sleep != null) bits.push('😴 ' + h.sleep + 'h');
    if (h.workout != null) bits.push(h.workout > 0 ? '🏃 ' + h.workout + ' min' : '🛋️ Rest day');
    if (h.weight != null) bits.push('⚖️ ' + h.weight + ' kg');
    return '<li class="entry"><div class="grow"><strong>' + esc(niceDate(h.date)) + '</strong>' +
      '<div class="chips">' + (bits.length ? bits.map(function (b) { return '<span class="chip">' + esc(b) + '</span>'; }).join('') : '<span class="meta">—</span>') + '</div>' +
      (h.note ? '<div class="meta">' + esc(h.note) + '</div>' : '') + '</div>' +
      iconBtns('health', h.id, 'entry for ' + h.date) + '</li>';
  }).join('');
}
function initHealth() {
  $('#healthDate').value = todayStr();
  $all('#view-health .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      $all('#view-health .seg-btn').forEach(function (x) { x.classList.remove('is-active'); });
      b.classList.add('is-active');
      healthRange = b.dataset.range; renderHealth();
    });
  });
  $('#healthForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var obj = {
      id: editingHealthId || uid(),
      date: $('#healthDate').value || todayStr(),
      water: numOrNull($('#healthWater').value),
      sleep: numOrNull($('#healthSleep').value),
      workout: numOrNull($('#healthWorkout').value),
      weight: numOrNull($('#healthWeight').value),
      note: $('#healthNote').value.trim()
    };
    if (!parseD(obj.date)) { alert('Please enter a valid date.'); return; }
    if (obj.water == null && obj.sleep == null && obj.workout == null && obj.weight == null && !obj.note) {
      showMsg('Fill in at least one field before saving.', true); $('#healthWater').focus(); return;
    }
    if (editingHealthId) {
      var i = state.health.findIndex(function (x) { return x.id === editingHealthId; });
      if (i >= 0) state.health[i] = obj;
      editingHealthId = null;
      $('#healthFormTitle').textContent = 'Log health';
      $('#healthSubmit').textContent = 'Save entry';
      $('#healthCancel').hidden = true;
    } else state.health.push(obj);
    e.target.reset(); $('#healthDate').value = todayStr();
    save(); renderAll();
    showMsg('Health entry saved.');
  });
  $('#healthCancel').addEventListener('click', function () {
    editingHealthId = null; $('#healthForm').reset(); $('#healthDate').value = todayStr();
    $('#healthFormTitle').textContent = 'Log health';
    $('#healthSubmit').textContent = 'Save entry';
    $('#healthCancel').hidden = true;
  });
  $('#healthList').addEventListener('click', function (e) {
    var ed = dataFrom(e, 'data-edit-health');
    var del = dataFrom(e, 'data-del-health');
    if (ed) {
      var h = state.health.find(function (x) { return x.id === ed; });
      if (!h) return;
      editingHealthId = ed;
      $('#healthDate').value = h.date;
      $('#healthWater').value = h.water == null ? '' : h.water;
      $('#healthSleep').value = h.sleep == null ? '' : h.sleep;
      $('#healthWorkout').value = h.workout == null ? '' : h.workout;
      $('#healthWeight').value = h.weight == null ? '' : h.weight;
      $('#healthNote').value = h.note || '';
      $('#healthFormTitle').textContent = 'Edit entry';
      $('#healthSubmit').textContent = 'Save';
      $('#healthCancel').hidden = false;
      $('#healthForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
      $('#healthDate').focus({ preventScroll: true });
    }
    if (del) {
      if (editingHealthId === del) $('#healthCancel').click();
      deleteWithUndo('Health entry deleted.', function () {
        state.health = state.health.filter(function (x) { return x.id !== del; });
      });
    }
  });
}

/* ---------- finance ---------- */
var financeRange = 'month', editingFinanceId = null, financeMonth = monthKey(todayStr());
function financeViewMonth() {
  return /^\d{4}-\d{2}$/.test(financeMonth || '') ? financeMonth : monthKey(todayStr());
}
// Parse "10,000.00" / "₱10,000" / "10000.5" -> 10000. Accepts commas.
function parseAmount(str) {
  if (str == null) return NaN;
  var cleaned = String(str).replace(/[₱,\s]/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === '' || cleaned === '.') return NaN;
  return Number(cleaned);
}
// "10000" -> "10,000"; keeps a trailing ".5" while typing.
function groupInt(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function formatAmountLive(input) {
  var caret = null;
  try { caret = input.selectionStart; } catch (e) { caret = null; }
  // how many digits/dot were before the caret? (commas don't count)
  var digitsBefore = caret == null ? null :
    input.value.slice(0, caret).replace(/[^0-9.]/g, '').length;
  var raw = input.value.replace(/[₱,\s]/g, '').replace(/[^0-9.]/g, '');
  var parts = raw.split('.');
  if (parts.length > 2) raw = parts[0] + '.' + parts.slice(1).join('');
  var dot = raw.indexOf('.');
  var intPart = (dot >= 0 ? raw.slice(0, dot) : raw).replace(/^0+(?=\d)/, '');
  var decPart = dot >= 0 ? raw.slice(dot + 1, dot + 3) : null;
  if (intPart === '' && raw === '') { input.value = ''; return; }
  var formatted = groupInt(intPart === '' ? '0' : intPart);
  if (decPart !== null) formatted += '.' + decPart;
  input.value = formatted;
  // restore caret so typing in the middle doesn't jump to the end
  if (digitsBefore != null) {
    var seen = 0, i = 0;
    while (i < formatted.length && seen < digitsBefore) {
      if (/[0-9.]/.test(formatted[i])) seen++;
      i++;
    }
    try { input.setSelectionRange(i, i); } catch (e) {}
  }
}
// 1234.5 -> "1,234.50" (minDecimals 2) or "1,234.5" (minDecimals 0)
function formatAmount(v, minDecimals) {
  var min = minDecimals == null ? 2 : minDecimals;
  try { return Number(v).toLocaleString('en-PH', { minimumFractionDigits: min, maximumFractionDigits: 2 }); }
  catch (e) { return min ? Number(v).toFixed(2) : String(Math.round(v * 100) / 100); }
}
function formatAmountBlur(input) {
  var v = parseAmount(input.value);
  if (isNaN(v)) return; // leave invalid text so submit can warn
  input.value = formatAmount(v);
}
function financeTotals(list) {
  var inc = 0, exp = 0;
  list.forEach(function (f) {
    if (f.type === 'income') inc += f.amount;
    else if (f.type === 'transfer') exp += (f.fee || 0); // moved money isn't spending; only the fee is
    else exp += f.amount;
  });
  return { income: inc, expense: exp, balance: inc - exp };
}
// Net balance per wallet, derived from every transaction (all time).
var PAY_METHODS = ['Cash', 'GCash', 'Maya', 'Debit Card', 'Credit Card', 'Bank Transfer', 'Other'];
function walletBalances() {
  var bal = {}, active = {};
  function add(w, v) {
    w = w || 'Other';
    if (!(w in bal)) bal[w] = 0;
    bal[w] += v; active[w] = true;
  }
  state.finance.forEach(function (f) {
    if (f.type === 'income') add(f.payMethod, f.amount);
    else if (f.type === 'transfer') {
      add(f.fromWallet, -(f.amount + (f.fee || 0)));
      add(f.toWallet, f.amount);
    }
    else add(f.payMethod, -f.amount);
  });
  // Cash, GCash, Maya always show; other methods appear once used.
  var PINNED = ['Cash', 'GCash', 'Maya'];
  var extra = Object.keys(active).filter(function (w) { return PAY_METHODS.indexOf(w) < 0; }).sort(); // e.g. from imported backups
  return PAY_METHODS.filter(function (w) { return active[w] || PINNED.indexOf(w) >= 0; }).concat(extra)
    .map(function (w) { return { wallet: w, balance: bal[w] || 0 }; });
}
// Running balance as of the end of month ym: earlier months carry into it.
function balanceThrough(ym) {
  var before = state.finance.filter(function (f) { return monthKey(normDateStr(f.date)) < ym; });
  var upTo = state.finance.filter(function (f) { return monthKey(normDateStr(f.date)) <= ym; });
  return { balance: financeTotals(upTo).balance, carried: financeTotals(before).balance };
}
function renderFinance() {
  // Summary cards always show the viewed month (defaults to current month),
  // so September income can never leak into the October total.
  var viewMonth = financeViewMonth();
  var monthItems = state.finance.filter(function (f) { return monthKey(normDateStr(f.date)) === viewMonth; });
  var mt = financeTotals(monthItems);
  $('#finIncome').textContent = money(mt.income);
  $('#finExpense').textContent = money(mt.expense);
  // Balance carries over: everything up to the end of the viewed month,
  // so October's leftover income still counts when spending in November.
  var bt = balanceThrough(viewMonth);
  var balEl = $('#finBalance');
  balEl.textContent = money(bt.balance);
  balEl.classList.toggle('neg', bt.balance < 0);
  var mLabel = monthLabel(viewMonth);
  ['finIncomeMonth', 'finExpenseMonth'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.textContent = '· ' + MONTHS[(+viewMonth.slice(5, 7)) - 1];
  });
  var bm = document.getElementById('finBalanceMonth');
  if (bm) bm.textContent = '· end of ' + mLabel;
  var bs = document.getElementById('finBalanceSub');
  if (bs) bs.textContent = 'Carried over ' + money(bt.carried) + ' · ' + MONTHS[(+viewMonth.slice(5, 7)) - 1] + ' net ' + (mt.balance >= 0 ? '+' : '') + money(mt.balance);
  // Keep the month navigator in sync; only relevant in month mode.
  var picker = $('#finMonthPicker');
  if (picker && picker.value !== viewMonth) picker.value = viewMonth;
  var nav = $('#finMonthNav');
  if (nav) nav.hidden = financeRange !== 'month';
  var navLabel = $('#finMonthLabel');
  if (navLabel) navLabel.textContent = mLabel;
  var items;
  if (financeRange === 'month') {
    items = monthItems.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  } else {
    items = state.finance.filter(function (f) { return inRange(f.date, financeRange); })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  }
  $('#financeEmpty').style.display = items.length ? 'none' : '';
  // Group by day (items are already newest first), like a bank statement.
  var groups = [];
  items.forEach(function (f) {
    var g = groups[groups.length - 1];
    if (!g || g.date !== f.date) { g = { date: f.date, items: [] }; groups.push(g); }
    g.items.push(f);
  });
  $('#financeList').innerHTML = groups.map(function (g) {
    var net = financeTotals(g.items).balance;
    return '<li class="tx-day"><div class="tx-day-head"><span>' + esc(niceDate(g.date)) + '</span>' +
      '<span class="amt">' + (net > 0 ? '+' : '') + esc(money(net)) + '</span></div>' +
      '<ul class="tx-list">' + g.items.map(txRow).join('') + '</ul></li>';
  }).join('');
  renderBudgets();
}
/* ---------- monthly budgets per expense category ---------- */
// Spending per category in a month: [{ label, value }]; categories match ignoring case,
// and transfer fees count as spending (like the monthly Expenses total).
var FEES_CAT = 'Transfer fees';
function spendByCategory(ym) {
  var by = {};
  state.finance.forEach(function (f) {
    if (monthKey(normDateStr(f.date)) !== ym) return;
    var label, amt;
    if (f.type === 'expense') { label = f.category; amt = f.amount; }
    else if (f.type === 'transfer' && (f.fee || 0) > 0) { label = FEES_CAT; amt = f.fee; }
    else return;
    var k = label.toLowerCase();
    if (!by[k]) by[k] = { label: label, value: 0 };
    by[k].value += amt;
  });
  return by; // keyed by lower-case category
}
function renderBudgets() {
  // The month navigator only shows in Month mode; otherwise budgets track this month.
  var ym = financeRange === 'month' ? financeViewMonth() : monthKey(todayStr());
  var spent = spendByCategory(ym);
  $('#budgetMonth').textContent = '· ' + monthLabel(ym);
  var rows = state.budgets.map(function (b) {
    var hit = spent[b.category.toLowerCase()], s = hit ? hit.value : 0;
    return { cat: b.category, limit: b.amount, spent: s, pct: s / b.amount };
  }).sort(function (a, b) { return b.pct - a.pct; });
  $('#budgetEmpty').hidden = rows.length > 0;
  $('#budgetEdit').textContent = rows.length ? 'Edit' : 'Set budgets';
  var totLimit = 0, totSpent = 0;
  rows.forEach(function (r) { totLimit += r.limit; totSpent += r.spent; });
  var head = $('#budgetTotal');
  head.textContent = rows.length ? (totSpent <= totLimit ? money(totLimit - totSpent) + ' left' : money(totSpent - totLimit) + ' over') : '';
  head.classList.toggle('neg', totSpent > totLimit);
  $('#budgetList').innerHTML = rows.map(function (r) {
    var cls = r.pct > 1 ? 'is-over' : r.pct >= 0.8 ? 'is-warn' : '';
    var left = r.limit - r.spent;
    return '<li class="budget ' + cls + '">' +
      '<div class="bud-top"><span class="bud-name">' + esc(catIcon(r.cat)) + ' ' + esc(r.cat) + '</span>' +
      '<span class="bud-left">' + (left >= 0 ? esc(money(left)) + ' left' : esc(money(-left)) + ' over') + '</span></div>' +
      '<div class="progress bud-bar" role="progressbar" aria-label="' + esc(r.cat) + ' budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(r.pct * 100) + '">' +
      '<span style="width:' + Math.min(100, Math.round(r.pct * 100)) + '%"></span></div>' +
      '<p class="bud-sub">' + esc(money(r.spent)) + ' of ' + esc(money(r.limit)) + ' · ' + Math.round(r.pct * 100) + '%</p></li>';
  }).join('');
}
// Expense categories to offer in the budget editor: presets, your custom ones, and any already budgeted.
function budgetCategories() {
  var list = CAT_PRESETS.expense.map(function (c) { return c[0]; });
  function add(name) { if (name && !list.some(function (x) { return x.toLowerCase() === name.toLowerCase(); })) list.splice(list.length - 1, 0, name); }
  state.budgets.forEach(function (b) { add(b.category); });
  state.finance.forEach(function (f) { if (f.type === 'expense') add(f.category); });
  if (state.finance.some(function (f) { return f.type === 'transfer' && f.fee > 0; })) add(FEES_CAT);
  return list;
}
function budgetFor(cat) {
  var k = cat.toLowerCase();
  for (var i = 0; i < state.budgets.length; i++) if (state.budgets[i].category.toLowerCase() === k) return state.budgets[i].amount;
  return 0;
}
function openBudgetDialog() {
  $('#budgetFields').innerHTML = budgetCategories().map(function (c, i) {
    var v = budgetFor(c);
    var val = v ? formatAmount(v, 0) : '';
    return '<li class="bud-field"><label for="bud' + i + '">' + esc(catIcon(c)) + ' ' + esc(c) + '</label>' +
      '<div class="bud-input"><span class="bud-peso" aria-hidden="true">₱</span><input id="bud' + i + '" data-cat="' + esc(c) + '" type="text" inputmode="decimal" autocomplete="off" placeholder="No limit" value="' + esc(val) + '"></div></li>';
  }).join('');
  openDialog($('#budgetDialog'));
  try { $('#budgetClose').focus({ preventScroll: true }); } catch (e) {}
}
function closeBudgetDialog() { closeDialog($('#budgetDialog')); }
function initBudgets() {
  $('#budgetEdit').addEventListener('click', openBudgetDialog);
  $('#budgetClose').addEventListener('click', closeBudgetDialog);
  $('#budgetCancel').addEventListener('click', closeBudgetDialog);
  $('#budgetDialog').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeBudgetDialog(); });
  $('#budgetFields').addEventListener('input', function (e) { if (e.target.matches('input')) formatAmountLive(e.target); });
  $('#budgetForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var out = [], bad = null;
    $all('#budgetFields input').forEach(function (inp) {
      if (!inp.value.trim()) return;
      var v = parseAmount(inp.value);
      if (!(v >= 0)) { bad = bad || inp; return; }
      if (v > 0) out.push({ category: inp.getAttribute('data-cat'), amount: Math.round(v * 100) / 100 });
    });
    if (bad) { showMsg('Enter an amount like 5,000 or leave it blank.', true); bad.focus(); return; }
    state.budgets = out;
    save(); closeBudgetDialog(); renderAll();
    showMsg(out.length ? 'Budgets saved.' : 'Budgets cleared.');
  });
}
// One transaction row: the whole row is a button that opens the edit sheet.
function txRow(f) {
  var desc = f.description || f.note || ''; // f.note: very old saves
  var title, meta, ico, amt;
  if (f.type === 'transfer') {
    title = 'Transfer';
    meta = esc(f.fromWallet || '?') + ' → ' + esc(f.toWallet || '?') +
      ((f.fee || 0) > 0 ? ' · fee ' + esc(money(f.fee)) : '') + (desc ? ' · ' + esc(desc) : '');
    ico = '<span class="fin-ico transfer" aria-hidden="true"><svg class="ico"><use href="#i-swap"/></svg></span>';
    amt = '<span class="amt">' + esc(money(f.amount)) + '</span>';
  } else {
    var inc = f.type === 'income';
    title = esc(f.category);
    meta = [f.payMethod ? esc(f.payMethod) : '', desc ? esc(desc) : ''].filter(Boolean).join(' · ') || '—';
    ico = '<span class="fin-ico ' + (inc ? 'income' : 'expense') + '" aria-hidden="true"><svg class="ico"><use href="#' + (inc ? 'i-in' : 'i-out') + '"/></svg></span>';
    amt = '<span class="amt ' + (inc ? 'pos' : 'neg') + '">' + (inc ? '+' : '−') + esc(money(f.amount)) + '</span>';
  }
  var label = 'Edit ' + (f.type === 'transfer' ? 'transfer' : f.category) + ', ' + money(f.amount) + ', ' + niceDate(f.date);
  return '<li><button type="button" class="tx" data-edit-fin="' + esc(f.id) + '" aria-label="' + esc(label) + '">' + ico +
    '<span class="tx-main"><span class="tx-title">' + title + '</span><span class="tx-meta">' + meta + '</span></span>' +
    amt + '</button></li>';
}
// Form fields follow the transaction type: transfer shows From/To/Fee,
// income gets income categories, expense gets expense categories + pay method.
function toggleFinanceType() {
  var t = $('#finType').value;
  var isIncome = t === 'income', isTransfer = t === 'transfer';
  $('#finTransferWrap').hidden = !isTransfer;
  $('#finCatWrap').style.display = isTransfer ? 'none' : '';
  $('#finPayWrap').style.display = isTransfer ? 'none' : '';
  $('#finPayLabel').textContent = isIncome ? 'Received via' : 'Mode of payment';
  $all('.type-seg .seg-btn').forEach(function (b) {
    var on = b.dataset.fintype === t;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  // A preset from the other type (e.g. "Salary" after switching to Expense) no longer fits.
  var cur = $('#finCategory').value.trim();
  var other = CAT_PRESETS[isIncome ? 'expense' : 'income'];
  var mine = CAT_PRESETS[isIncome ? 'income' : 'expense'];
  if (cur && !catIn(mine, cur) && catIn(other, cur)) $('#finCategory').value = '';
  if (isTransfer) { openCatPanel(false); openPayPanel(false); }
  else {
    openWalletPanel('finFrom', false); openWalletPanel('finTo', false);
    if (!$('#finCatPanel').hidden) renderCatPicker();
  }
  updateCatBtn();
  updatePayBtn();
}

/* ---------- wallet pickers (on-screen tiles instead of native selects) ----------
   Used for Mode of payment, and From / To on transfers. Each hidden <select>
   stays the value store, so saving and editing read/write it as before. */
var WALLET_PICKERS = ['finPay', 'finFrom', 'finTo'];
function updateWalletBtn(id) {
  $('#' + id + 'BtnText').textContent = $('#' + id).value || 'Cash';
}
function updatePayBtn() { WALLET_PICKERS.forEach(updateWalletBtn); }
function renderWalletPicker(id) {
  var cur = $('#' + id).value;
  $('#' + id + 'Grid').innerHTML = PAY_METHODS.map(function (w) {
    var st = WALLET_STYLE[w] || [w.charAt(0), '#64748b'];
    return '<button type="button" class="cat-chip pay-chip" role="option" aria-selected="' + (w === cur) + '" data-wallet="' + esc(w) + '">' +
      '<span class="w-avatar" style="--wc:' + st[1] + '" aria-hidden="true">' + esc(st[0]) + '</span><span class="cat-name">' + esc(w) + '</span></button>';
  }).join('');
}
function openWalletPanel(id, open) {
  var panel = $('#' + id + 'Panel'), btn = $('#' + id + 'Btn');
  if (!open) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
  closeAllPickers();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  renderWalletPicker(id);
  panel.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  try { panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { panel.scrollIntoView(false); }
}
function openPayPanel(open) { if (!open) WALLET_PICKERS.forEach(function (id) { openWalletPanel(id, false); }); else openWalletPanel('finPay', true); }
function closeAllPickers() {
  openCatPanel(false);
  WALLET_PICKERS.forEach(function (id) { openWalletPanel(id, false); });
}
function initPayPicker() {
  WALLET_PICKERS.forEach(function (id) {
    $('#' + id + 'Btn').addEventListener('click', function () { openWalletPanel(id, $('#' + id + 'Panel').hidden); });
    $('#' + id + 'Grid').addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('[data-wallet]') : null;
      if (!chip) return;
      var v = chip.getAttribute('data-wallet');
      // Transfers: picking the wallet already on the other side swaps them.
      var other = id === 'finFrom' ? 'finTo' : id === 'finTo' ? 'finFrom' : null;
      if (other && $('#' + other).value === v) $('#' + other).value = $('#' + id).value;
      $('#' + id).value = v;
      updatePayBtn();
      openWalletPanel(id, false);
      try { $('#' + id + 'Btn').focus({ preventScroll: true }); } catch (err) {}
    });
  });
}

/* ---------- category picker (on-screen chips instead of keyboard suggestions) ---------- */
var CAT_PRESETS = {
  expense: [['Groceries', '🛒'], ['Dining Out', '🍽️'], ['Transportation', '🚌'], ['Utilities', '💡'],
    ['Subscriptions', '🔁'], ['Entertainment', '🎬'], ['Housing', '🏠'], ['Household', '🧺'],
    ['Health & Wellness', '💊'], ['Education', '📚'], ['Taxes & Contributions', '🧾'], ['Savings', '🐷'],
    ['Investments', '📈'], ['Other', '📦']],
  income: [['Salary', '💼'], ['Bonus', '🎁'], ['Freelance', '💻'], ['Business Income', '🏪'],
    ['Allowance', '💵'], ['Gift', '🎀'], ['Interest', '🏦'], ['Other', '📦']]
};
// Soft hyphens (­) so long names break cleanly inside a narrow chip on any browser.
var CAT_SHY = {
  'Transportation': 'Transpor­tation', 'Entertainment': 'Entertain­ment',
  'Subscriptions': 'Subscrip­tions', 'Taxes & Contributions': 'Taxes & Contri­butions'
};
function catIn(list, name) {
  var n = String(name).toLowerCase();
  return list.some(function (c) { return c[0].toLowerCase() === n; });
}
// Presets for the current type + custom categories you've already used (newest first).
function catOptions() {
  var type = $('#finType').value === 'income' ? 'income' : 'expense';
  var opts = CAT_PRESETS[type].slice();
  var seen = {};
  state.finance.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).forEach(function (f) {
    if (f.type !== type || !f.category) return;
    var key = f.category.toLowerCase();
    if (seen[key] || catIn(opts, f.category)) return;
    seen[key] = true;
    if (Object.keys(seen).length <= 6) opts.splice(opts.length - 1, 0, [f.category, '🏷️']); // before "Other"
  });
  // Keep an unsaved custom value (typed just now, or being edited) visible too.
  var cur = $('#finCategory').value.trim();
  if (cur && !catIn(opts, cur)) opts.splice(opts.length - 1, 0, [cur, '🏷️']);
  return opts;
}
function catIcon(name) {
  if (String(name).toLowerCase() === 'transfer fees') return '🔄';
  var all = CAT_PRESETS.expense.concat(CAT_PRESETS.income);
  for (var i = 0; i < all.length; i++) if (all[i][0].toLowerCase() === String(name).toLowerCase()) return all[i][1];
  return '🏷️';
}
function renderCatPicker() {
  var cur = $('#finCategory').value.trim().toLowerCase();
  $('#finCatGrid').innerHTML = catOptions().map(function (c) {
    var sel = c[0].toLowerCase() === cur;
    return '<button type="button" class="cat-chip" role="option" aria-selected="' + sel + '" data-cat="' + esc(c[0]) + '">' +
      '<span class="cat-emo" aria-hidden="true">' + c[1] + '</span><span class="cat-name">' + esc(CAT_SHY[c[0]] || c[0]) + '</span></button>';
  }).join('') +
    '<button type="button" class="cat-chip cat-chip-custom" data-cat-custom="1"><span class="cat-emo" aria-hidden="true">✏️</span><span class="cat-name">Custom…</span></button>';
}
function updateCatBtn() {
  var v = $('#finCategory').value.trim();
  var t = $('#finCatBtnText');
  t.textContent = v ? catIcon(v) + '  ' + v : 'Choose…';
  t.classList.toggle('picker-placeholder', !v);
}
function openCatPanel(open) {
  var panel = $('#finCatPanel'), btn = $('#finCatBtn');
  if (!open) {
    panel.hidden = true; $('#finCatCustom').hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  openPayPanel(false); // one picker at a time
  // Drop the keyboard (e.g. still up from the amount field) so the chips are on screen.
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  renderCatPicker();
  panel.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  try { panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { panel.scrollIntoView(false); }
}
function setCategory(v) {
  $('#finCategory').value = String(v || '').trim().slice(0, 40);
  updateCatBtn();
  openCatPanel(false);
  try { $('#finCatBtn').focus({ preventScroll: true }); } catch (e) {}
}
function initCatPicker() {
  $('#finCatBtn').addEventListener('click', function () { openCatPanel($('#finCatPanel').hidden); });
  $('#finCatGrid').addEventListener('click', function (e) {
    var chip = e.target.closest ? e.target.closest('.cat-chip') : null;
    if (!chip) return;
    if (chip.hasAttribute('data-cat-custom')) {
      var box = $('#finCatCustom'), input = $('#finCategory');
      box.hidden = false;
      if (catIn(CAT_PRESETS.expense.concat(CAT_PRESETS.income), input.value)) input.value = '';
      input.focus();
      return;
    }
    setCategory(chip.getAttribute('data-cat'));
  });
  function useCustom() {
    var v = $('#finCategory').value.trim();
    if (!v) { $('#finCategory').focus(); return; }
    setCategory(v);
  }
  $('#finCatCustomOk').addEventListener('click', useCustom);
  // Enter in the custom box picks the category instead of submitting the whole form.
  $('#finCategory').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); useCustom(); }
  });
  $('#finCategory').addEventListener('input', updateCatBtn);
}
/* Finance modal: the add/edit form lives in a native <dialog>. */
function financeDialog() { return $('#financeDialog'); }
function resetFinanceForm() {
  editingFinanceId = null;
  $('#financeForm').reset();
  $('#finDate').value = todayStr(); $('#finType').value = 'expense';
  $('#finPay').value = 'Cash'; openCatPanel(false); openPayPanel(false); toggleFinanceType();
  $('#financeFormTitle').textContent = 'Add transaction';
  $('#financeSubmit').textContent = 'Add';
  $('#financeDelete').hidden = true;
}
function openDialog(d) {
  if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); }
  else d.setAttribute('open', '');
}
function closeDialog(d) {
  if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  var t = $('#toast'); // the toast may have moved into this dialog
  if (t && t.parentNode !== document.body) document.body.appendChild(t);
}
function openFinanceDialog() {
  openDialog(financeDialog());
  // New entry: jump straight to the amount. Editing: don't pop the phone keyboard over the details.
  if (!editingFinanceId) $('#finAmount').focus();
  else { try { $('#financeClose').focus({ preventScroll: true }); } catch (e) {} }
}
function closeFinanceDialog() {
  closeDialog(financeDialog());
  resetFinanceForm();
}
function initFinance() {
  $('#finDate').value = todayStr();
  initCatPicker();
  initPayPicker();
  toggleFinanceType();
  $('#openFinanceModal').addEventListener('click', function () {
    resetFinanceForm(); openFinanceDialog();
  });
  $('#financeCancel').addEventListener('click', closeFinanceDialog);
  $('#financeDelete').addEventListener('click', function () {
    var id = editingFinanceId;
    if (!id) return;
    closeFinanceDialog();
    deleteWithUndo('Transaction deleted.', function () {
      state.finance = state.finance.filter(function (x) { return x.id !== id; });
    });
  });
  $('#financeClose').addEventListener('click', closeFinanceDialog);
  financeDialog().addEventListener('click', function (e) {
    // e.target is the dialog for both backdrop clicks AND taps on its own padding,
    // so compare coordinates against the dialog box.
    var d = financeDialog();
    if (e.target !== d) return;
    var r = d.getBoundingClientRect();
    var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside && (e.clientX || e.clientY)) closeFinanceDialog();
  });
  $all('.type-seg .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { $('#finType').value = b.dataset.fintype; toggleFinanceType(); });
  });
  // ESC key. The 'close' event fires asynchronously, so skip the reset if the sheet
  // was already reopened (e.g. a quick tap on another transaction).
  financeDialog().addEventListener('close', function () { if (!financeDialog().open) resetFinanceForm(); });
  $('#finType').addEventListener('change', toggleFinanceType);
  var amtInput = $('#finAmount');
  amtInput.addEventListener('input', function () { formatAmountLive(amtInput); });
  amtInput.addEventListener('blur', function () { formatAmountBlur(amtInput); });
  var feeInput = $('#finFee');
  feeInput.addEventListener('input', function () { formatAmountLive(feeInput); });
  feeInput.addEventListener('blur', function () { formatAmountBlur(feeInput); });
  $all('#view-finance .toolbar .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      $all('#view-finance .toolbar .seg-btn').forEach(function (x) { x.classList.remove('is-active'); });
      b.classList.add('is-active');
      financeRange = b.dataset.range;
      if (financeRange === 'month') financeMonth = monthKey(todayStr()); // "This month" jumps back to now
      renderFinance();
    });
  });
  var prevBtn = $('#finPrevMonth'), nextBtn = $('#finNextMonth'), picker = $('#finMonthPicker');
  if (prevBtn) prevBtn.addEventListener('click', function () {
    financeMonth = shiftMonth(financeViewMonth(), -1); renderFinance();
  });
  if (nextBtn) nextBtn.addEventListener('click', function () {
    financeMonth = shiftMonth(financeViewMonth(), 1); renderFinance();
  });
  if (picker) picker.addEventListener('change', function () {
    if (/^\d{4}-\d{2}$/.test(picker.value)) { financeMonth = picker.value; renderFinance(); }
  });
  $('#financeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var kind = $('#finType').value;
    var dateVal = normDateStr($('#finDate').value || todayStr());
    if (!parseD(dateVal)) { alert('Please enter a valid date.'); return; }
    if (kind === 'transfer') {
      var tAmount = parseAmount($('#finAmount').value);
      var feeRaw = $('#finFee').value.trim();
      var tFee = feeRaw === '' ? 0 : parseAmount(feeRaw);
      var fromW = $('#finFrom').value, toW = $('#finTo').value;
      if (!(tAmount > 0)) { alert('Please enter an amount greater than 0 (e.g. 3,000.00).'); $('#finAmount').focus(); return; }
      if (isNaN(tFee) || tFee < 0) { alert('Please enter a valid fee (0 or more).'); $('#finFee').focus(); return; }
      if (fromW === toW) { alert('Pick two different wallets for a transfer.'); return; }
      var tobj = {
        id: editingFinanceId || uid(),
        type: 'transfer',
        amount: Math.round(tAmount * 100) / 100,
        fee: Math.round(tFee * 100) / 100,
        category: 'Transfer',
        fromWallet: fromW, toWallet: toW,
        payMethod: fromW,
        description: $('#finDesc').value.trim(),
        date: dateVal
      };
      if (editingFinanceId) {
        var ti = state.finance.findIndex(function (x) { return x.id === editingFinanceId; });
        if (ti >= 0) state.finance[ti] = tobj;
      } else state.finance.push(tobj);
      closeFinanceDialog();
      save(); renderAll();
      showMsg('Transfer saved.');
      return;
    }
    var amount = parseAmount($('#finAmount').value);
    if (!(amount > 0)) { alert('Please enter an amount greater than 0 (e.g. 10,000.00).'); $('#finAmount').focus(); return; }
    if (!$('#finCategory').value.trim()) { showMsg('Pick a category.', true); openCatPanel(true); return; }
    var isIncome = kind === 'income';
    var obj = {
      id: editingFinanceId || uid(),
      type: isIncome ? 'income' : 'expense',
      amount: Math.round(amount * 100) / 100,
      category: $('#finCategory').value.trim().slice(0, 40),
      date: dateVal,
      description: $('#finDesc').value.trim(),
      payMethod: $('#finPay').value,
      fee: 0, fromWallet: '', toWallet: ''
    };
    if (editingFinanceId) {
      var i = state.finance.findIndex(function (x) { return x.id === editingFinanceId; });
      if (i >= 0) state.finance[i] = obj;
    } else state.finance.push(obj);
    closeFinanceDialog();
    save(); renderAll();
    showMsg((isIncome ? 'Income' : 'Expense') + ' of ' + money(obj.amount) + ' saved.');
  });
  $('#financeList').addEventListener('click', function (e) {
    var ed = dataFrom(e, 'data-edit-fin');
    var del = dataFrom(e, 'data-del-fin');
    if (ed) {
      var f = state.finance.find(function (x) { return x.id === ed; });
      if (!f) return;
      editingFinanceId = ed;
      $('#finType').value = f.type;
      $('#finAmount').value = formatAmount(f.amount);
      $('#finCategory').value = f.category; $('#finDate').value = f.date;
      $('#finDesc').value = f.description || f.note || '';
      $('#finPay').value = f.payMethod || 'Cash';
      $('#finFrom').value = f.fromWallet || f.payMethod || 'Maya';
      $('#finTo').value = f.toWallet || 'GCash';
      $('#finFee').value = formatAmount(Number(f.fee) || 0);
      toggleFinanceType();
      $('#financeFormTitle').textContent = 'Edit transaction';
      $('#financeSubmit').textContent = 'Save';
      $('#financeDelete').hidden = false;
      openFinanceDialog();
    }
    if (del) {
      deleteWithUndo('Transaction deleted.', function () {
        state.finance = state.finance.filter(function (x) { return x.id !== del; });
      });
    }
  });
}

/* ---------- goals & tasks ---------- */
var taskFilter = 'open', editingGoalId = null, editingTaskId = null;
function goalProgress(goalId) {
  var linked = state.tasks.filter(function (t) { return t.goalId === goalId; });
  if (!linked.length) return { done: 0, total: 0, pct: 0 };
  var done = linked.filter(function (t) { return t.done; }).length;
  return { done: done, total: linked.length, pct: Math.round(done / linked.length * 100) };
}
function renderGoals() {
  $('#goalEmpty').style.display = state.goals.length ? 'none' : '';
  $('#goalList').innerHTML = state.goals.map(function (g) {
    var p = goalProgress(g.id);
    return '<li class="entry"><div class="grow"><div class="entry-title"><strong>' + esc(g.title) + '</strong><span class="amt">' + p.pct + '%</span></div>' +
      '<div class="meta">' + (g.deadline ? 'Target ' + esc(niceDate(g.deadline)) + ' · ' : '') + (p.total ? p.done + ' of ' + p.total + ' tasks done' : 'No linked tasks yet') + '</div>' +
      '<div class="progress" role="progressbar" aria-valuenow="' + p.pct + '" aria-valuemin="0" aria-valuemax="100" aria-label="Progress for ' + esc(g.title) + '"><span style="width:' + p.pct + '%"></span></div></div>' +
      iconBtns('goal', g.id, g.title) + '</li>';
  }).join('');
  // keep goal dropdown in sync
  var sel = $('#taskGoal');
  var cur = sel.value;
  sel.innerHTML = '<option value="">— No goal —</option>' + state.goals.map(function (g) {
    return '<option value="' + esc(g.id) + '">' + esc(g.title) + '</option>';
  }).join('');
  if (state.goals.some(function (g) { return g.id === cur; })) sel.value = cur;
}
function renderTasks() {
  renderGoals();
  var items = state.tasks.slice().sort(function (a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    }
    var rank = { high: 0, medium: 1, low: 2 };
    return (rank[a.priority] || 1) - (rank[b.priority] || 1);
  });
  if (taskFilter === 'open') items = items.filter(function (t) { return !t.done; });
  if (taskFilter === 'done') items = items.filter(function (t) { return t.done; });
  $('#taskEmpty').style.display = items.length ? 'none' : '';
  var goalName = function (id) {
    var g = state.goals.find(function (x) { return x.id === id; });
    return g ? g.title : '';
  };
  var today = todayStr();
  $('#taskList').innerHTML = items.map(function (t) {
    var bits = [];
    if (t.due) {
      var overdue = !t.done && t.due < today;
      bits.push(overdue ? '<span class="overdue">Overdue · ' + esc(niceDate(t.due)) + '</span>' : 'Due ' + esc(niceDate(t.due)));
    }
    if (t.goalId && goalName(t.goalId)) bits.push('🎯 ' + esc(goalName(t.goalId)));
    return '<li class="task-row">' +
      '<label class="check-wrap"><input type="checkbox" data-check-task="' + esc(t.id) + '" ' + (t.done ? 'checked' : '') + ' aria-label="Mark task ' + esc(t.title) + ' done"></label>' +
      '<div class="grow"><span class="' + (t.done ? 'done-text' : '') + '">' + esc(t.title) + '</span> ' +
      '<span class="pill ' + esc(t.priority) + '">' + esc(t.priority) + '</span>' +
      (bits.length ? '<div class="meta">' + bits.join(' · ') + '</div>' : '') + '</div>' +
      iconBtns('task', t.id, t.title) + '</li>';
  }).join('');
}
function initTasks() {
  $all('#view-tasks .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      $all('#view-tasks .seg-btn').forEach(function (x) { x.classList.remove('is-active'); });
      b.classList.add('is-active');
      taskFilter = b.dataset.range; renderTasks();
    });
  });
  $('#goalForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var title = $('#goalTitle').value.trim();
    if (!title) return;
    if (editingGoalId) {
      var g = state.goals.find(function (x) { return x.id === editingGoalId; });
      if (g) { g.title = title; g.deadline = $('#goalDeadline').value; }
      editingGoalId = null;
      $('#goalFormTitle').textContent = 'Add a goal';
      $('#goalSubmit').textContent = 'Add goal';
      $('#goalCancel').hidden = true;
    } else {
      state.goals.push({ id: uid(), title: title, deadline: $('#goalDeadline').value, created: todayStr() });
    }
    e.target.reset(); save(); renderAll();
  });
  $('#goalCancel').addEventListener('click', function () {
    editingGoalId = null; $('#goalForm').reset();
    $('#goalFormTitle').textContent = 'Add a goal';
    $('#goalSubmit').textContent = 'Add goal';
    $('#goalCancel').hidden = true;
  });
  $('#goalList').addEventListener('click', function (e) {
    var ed = dataFrom(e, 'data-edit-goal');
    var del = dataFrom(e, 'data-del-goal');
    if (ed) {
      var g = state.goals.find(function (x) { return x.id === ed; });
      if (!g) return;
      editingGoalId = ed;
      $('#goalTitle').value = g.title; $('#goalDeadline').value = g.deadline || '';
      $('#goalFormTitle').textContent = 'Edit goal';
      $('#goalSubmit').textContent = 'Save';
      $('#goalCancel').hidden = false;
      $('#goalForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
      $('#goalTitle').focus({ preventScroll: true });
    }
    if (del) {
      if (editingGoalId === del) $('#goalCancel').click();
      deleteWithUndo('Goal deleted. Its tasks were kept.', function () {
        state.goals = state.goals.filter(function (x) { return x.id !== del; });
        state.tasks.forEach(function (t) { if (t.goalId === del) t.goalId = ''; });
      });
    }
  });
  $('#taskForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var title = $('#taskTitle').value.trim();
    if (!title) return;
    if (editingTaskId) {
      var t = state.tasks.find(function (x) { return x.id === editingTaskId; });
      if (t) { t.title = title; t.due = $('#taskDue').value; t.priority = $('#taskPriority').value; t.goalId = $('#taskGoal').value; }
      editingTaskId = null;
      $('#taskFormTitle').textContent = 'Add a task';
      $('#taskSubmit').textContent = 'Add task';
      $('#taskCancel').hidden = true;
    } else {
      state.tasks.push({ id: uid(), title: title, due: $('#taskDue').value, priority: $('#taskPriority').value, done: false, goalId: $('#taskGoal').value, created: todayStr() });
    }
    e.target.reset();
    save(); renderAll();
  });
  $('#taskCancel').addEventListener('click', function () {
    editingTaskId = null; $('#taskForm').reset();
    $('#taskFormTitle').textContent = 'Add a task';
    $('#taskSubmit').textContent = 'Add task';
    $('#taskCancel').hidden = true;
  });
  $('#taskList').addEventListener('change', function (e) {
    var id = e.target.getAttribute('data-check-task');
    if (!id) return;
    var t = state.tasks.find(function (x) { return x.id === id; });
    if (t) { t.done = e.target.checked; save(); renderAll(); }
  });
  $('#taskList').addEventListener('click', function (e) {
    var ed = dataFrom(e, 'data-edit-task');
    var del = dataFrom(e, 'data-del-task');
    if (ed) {
      var t = state.tasks.find(function (x) { return x.id === ed; });
      if (!t) return;
      editingTaskId = ed;
      $('#taskTitle').value = t.title; $('#taskDue').value = t.due || '';
      $('#taskPriority').value = t.priority; $('#taskGoal').value = t.goalId || '';
      $('#taskFormTitle').textContent = 'Edit task';
      $('#taskSubmit').textContent = 'Save';
      $('#taskCancel').hidden = false;
      $('#taskForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
      $('#taskTitle').focus({ preventScroll: true });
    }
    if (del) {
      if (editingTaskId === del) $('#taskCancel').click();
      deleteWithUndo('Task deleted.', function () {
        state.tasks = state.tasks.filter(function (x) { return x.id !== del; });
      });
    }
  });
}

/* ---------- dashboard ---------- */
function last7() {
  var t = todayStr(), out = [];
  for (var i = 6; i >= 0; i--) out.push(addDaysStr(t, -i));
  return out;
}
function habitDayPct(dateStr) {
  if (!state.habits.length) return 0;
  var done = state.habits.filter(function (h) { return h.checks[dateStr]; }).length;
  return Math.round(done / state.habits.length * 100);
}
// Weekly column chart in plain HTML (crisp text at any width): labels[] + values[] (0-100).
function weekBars(labels, values, todayIdx) {
  return '<div class="week-chart">' + values.map(function (raw, i) {
    var v = Math.max(0, Math.min(100, raw));
    return '<div class="wc-day' + (i === todayIdx ? ' is-today' : '') + '" title="' + esc(labels[i]) + ': ' + v + '%">' +
      '<span class="wc-val">' + v + '%</span>' +
      '<div class="wc-col"><span style="height:' + v + '%"></span></div>' +
      '<span class="wc-lbl">' + esc(labels[i]) + '</span></div>';
  }).join('') + '</div>';
}
// Horizontal bars for category totals: label + amount on top, bar underneath.
function hBars(rows) { // rows: [{label, value}]
  var max = Math.max.apply(null, [1].concat(rows.map(function (r) { return r.value; })));
  return '<ul class="hbars">' + rows.map(function (r) {
    var pct = Math.max(1, Math.round(r.value / max * 100));
    return '<li><div class="hb-head"><span class="hb-label">' + esc(r.label) + '</span><span class="amt">' + esc(money(r.value)) + '</span></div>' +
      '<div class="hb-track"><span style="width:' + pct + '%"></span></div></li>';
  }).join('') + '</ul>';
}
function renderDashboard() {
  var t = todayStr();
  var now = new Date(), hr = now.getHours();
  $('#greeting').textContent = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  $('#todayLabel').textContent = WEEKDAYS[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear();
  // habits
  var done = state.habits.filter(function (h) { return h.checks[t]; }).length;
  $('#dashHabits').textContent = done + '/' + state.habits.length;
  $('#dashHabitsSub').textContent = state.habits.length ? (done === state.habits.length ? 'all done today 🎉' : 'completed today') : 'add habits to get started';
  var bar = $('#dashHabitsBar');
  if (bar) bar.style.width = (state.habits.length ? Math.round(done / state.habits.length * 100) : 0) + '%';
  // health (today)
  var todays = state.health.filter(function (h) { return h.date === t; });
  var water = todays.reduce(function (a, h) { return a + (h.water || 0); }, 0);
  var sleeps = todays.map(function (h) { return h.sleep; }).filter(function (v) { return v != null; });
  $('#dashHealth').textContent = (water ? water + ' 💧' : '–') + (sleeps.length ? ' · ' + sleeps[0] + 'h 😴' : '');
  if (!todays.length) $('#dashHealth').textContent = 'No log yet';
  var workouts = todays.filter(function (h) { return (h.workout || 0) > 0; }).length;
  $('#dashHealthSub').textContent = todays.length ? (workouts ? 'includes a workout 💪' : 'no workout logged') : 'log water / sleep / workout';
  // finance (month)
  var mt = financeTotals(state.finance.filter(function (f) { return monthKey(normDateStr(f.date)) === monthKey(t); }));
  $('#dashFinance').textContent = money(mt.expense);
  $('#dashFinanceSub').textContent = 'income ' + money(mt.income) + ' · balance ' + money(balanceThrough(monthKey(t)).balance);
  // tasks
  var open = state.tasks.filter(function (x) { return !x.done; }).length;
  var overdue = state.tasks.filter(function (x) { return !x.done && x.due && x.due < t; }).length;
  $('#dashTasks').textContent = open + ' open';
  $('#dashTasksSub').textContent = overdue ? overdue + ' overdue' : state.tasks.length ? 'nothing overdue 🎉' : 'add tasks to get started';
  // charts
  var days = last7();
  var labels = days.map(function (d) { return d === t ? 'Today' : WEEKDAYS[parseD(d).getDay()]; });
  var vals = days.map(habitDayPct);
  $('#chartHabitsWeek').innerHTML = state.habits.length ? weekBars(labels, vals, days.indexOf(t)) : '<p class="empty">Add a habit to see your week.</p>';
  var byCat = spendByCategory(monthKey(t));
  var rows = Object.keys(byCat).map(function (k) { return byCat[k]; })
    .sort(function (a, b) { return b.value - a.value; }).slice(0, 6);
  $('#chartSpendCat').innerHTML = rows.length ? hBars(rows) : '<p class="empty">No spending this month yet.</p>';
  renderWallets();
}
function renderWallets() {
  paintWallets($('#walletBalances'), $('#walletEmpty'), $('#walletTotal'));
  paintWallets($('#finWalletBalances'), $('#finWalletEmpty'), $('#finWalletTotal'));
}
var WALLET_STYLE = { // [initials, color]
  'Cash': ['₱', '#16a34a'], 'GCash': ['G', '#2563eb'], 'Maya': ['M', '#0d9488'],
  'Debit Card': ['DC', '#7c3aed'], 'Credit Card': ['CC', '#ea580c'], 'Bank Transfer': ['B', '#4f46e5'], 'Other': ['•', '#64748b']
};
function paintWallets(box, emptyEl, totalEl) {
  if (!box) return;
  var rows = walletBalances();
  var hasActivity = state.finance.length > 0;
  if (emptyEl) emptyEl.style.display = hasActivity ? 'none' : '';
  box.style.display = hasActivity ? '' : 'none';
  var total = rows.reduce(function (a, r) { return a + r.balance; }, 0);
  if (totalEl) {
    totalEl.textContent = hasActivity ? money(total) : '';
    totalEl.classList.toggle('neg', total < 0);
  }
  box.innerHTML = rows.map(function (r) {
    var st = WALLET_STYLE[r.wallet] || [r.wallet.charAt(0).toUpperCase(), '#64748b'];
    var cls = r.balance < 0 ? 'neg' : (r.balance > 0 ? 'pos' : 'muted');
    return '<div class="wallet"><span class="w-avatar" style="--wc:' + st[1] + '" aria-hidden="true">' + esc(st[0]) + '</span>' +
      '<span class="w-text"><span class="w-name">' + esc(r.wallet) + '</span>' +
      '<span class="w-amt ' + cls + '">' + esc(money(r.balance)) + '</span></span></div>';
  }).join('');
}

/* ---------- backup reminder ---------- */
var BACKUP_KEY = 'personal-tracker-last-backup';          // ms timestamp of the last export
var BACKUP_SNOOZE_KEY = 'personal-tracker-backup-snooze'; // ms timestamp: hide the reminder until then
var BACKUP_EVERY_DAYS = 14, BACKUP_SNOOZE_DAYS = 3, DAY_MS = 86400000;
function lsNum(key) {
  try { var n = Number(localStorage.getItem(key)); return n > 0 ? n : 0; } catch (e) { return 0; }
}
function markBackedUp() {
  try { localStorage.setItem(BACKUP_KEY, String(Date.now())); localStorage.removeItem(BACKUP_SNOOZE_KEY); } catch (e) {}
  renderBackupNudge(); updateStorageInfo();
}
function recordCount() {
  return state.habits.length + state.health.length + state.finance.length + state.goals.length + state.tasks.length;
}
function daysAgoText(ts) {
  var days = Math.floor((Date.now() - ts) / DAY_MS);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
}
function renderBackupNudge() {
  var box = $('#backupNudge');
  if (!box) return;
  var last = lsNum(BACKUP_KEY), now = Date.now();
  var due = last ? now - last >= BACKUP_EVERY_DAYS * DAY_MS : recordCount() >= 5;
  box.hidden = !due || lsNum(BACKUP_SNOOZE_KEY) > now;
  if (box.hidden) return;
  $('#backupNudgeTitle').textContent = last ? 'Last backup ' + daysAgoText(last) : 'No backup yet';
}

/* ---------- export / import / reset ---------- */
function buildExport() {
  return {
    app: 'personal-tracker',
    version: SCHEMA_VERSION,
    exportDate: new Date().toISOString(),
    data: {
      habits: state.habits, health: state.health,
      finance: state.finance, goals: state.goals, tasks: state.tasks, budgets: state.budgets
    }
  };
}
function downloadJson(obj, filename) {
  var text = JSON.stringify(obj, null, 2);
  var blob = new Blob([text], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
}
function validateImport(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'File is not a JSON object.' };
  var data = obj.data && typeof obj.data === 'object' ? obj.data : obj; // accept raw state too
  function checkArr(name) {
    if (data[name] === undefined) return [];
    if (!Array.isArray(data[name])) return null;
    return data[name];
  }
  var names = ['habits', 'health', 'finance', 'goals', 'tasks', 'budgets'];
  for (var i = 0; i < names.length; i++) {
    if (checkArr(names[i]) === null) return { ok: false, error: 'Field "' + names[i] + '" must be an array.' };
  }
  var candidate = {
    version: Number(obj.version) || SCHEMA_VERSION,
    habits: data.habits || [], health: data.health || [],
    finance: data.finance || [], goals: data.goals || [], tasks: data.tasks || [],
    budgets: data.budgets || [],
    settings: { theme: currentTheme() }
  };
  try {
    var clean = migrate(candidate); // throws nothing, but sanitizes + drops invalid rows
    return { ok: true, data: clean };
  } catch (e) {
    return { ok: false, error: 'Could not understand this file: ' + (e && e.message ? e.message : 'unknown error') };
  }
}
// Merge: keep existing ids; imported rows with colliding ids get fresh ids.
function mergeStates(base, incoming) {
  var out = JSON.parse(JSON.stringify(base));
  ['habits', 'health', 'finance', 'goals', 'tasks'].forEach(function (key) {
    var ids = {};
    out[key].forEach(function (r) { ids[r.id] = true; });
    incoming[key].forEach(function (r) {
      var row = JSON.parse(JSON.stringify(r));
      if (!row.id || ids[row.id]) row.id = uid();
      ids[row.id] = true;
      out[key].push(row);
    });
  });
  // budgets: keep your current limits, add the imported ones for other categories
  out.budgets = (out.budgets || []).slice();
  (incoming.budgets || []).forEach(function (b) {
    var k = b.category.toLowerCase();
    if (!out.budgets.some(function (x) { return x.category.toLowerCase() === k; })) out.budgets.push({ category: b.category, amount: b.amount });
  });
  return out;
}
var pendingImport = null;
function initDataButtons() {
  function doExport() {
    downloadJson(buildExport(), 'personal-tracker-' + todayStr() + '.json');
    markBackedUp();
    showMsg('Backup downloaded. Keep it somewhere safe.');
  }
  $('#exportBtn').addEventListener('click', doExport);
  $('#backupNudgeBtn').addEventListener('click', doExport);
  $('#backupNudgeLater').addEventListener('click', function () {
    try { localStorage.setItem(BACKUP_SNOOZE_KEY, String(Date.now() + BACKUP_SNOOZE_DAYS * DAY_MS)); } catch (e) {}
    renderBackupNudge();
  });
  $('#exportBtnTop').addEventListener('click', doExport);
  $('#resetBtn').addEventListener('click', function () {
    if (!confirm('Delete ALL local data (habits, health, finance, tasks)? This cannot be undone.\n\nTip: Export a backup first.')) return;
    if (!confirm('Really erase everything? Last chance!')) return;
    state = defaultState();
    state.settings.theme = currentTheme();
    try { localStorage.removeItem(BACKUP_KEY); localStorage.removeItem(BACKUP_SNOOZE_KEY); } catch (e) {}
    save(); renderAll();
    showMsg('All data cleared.');
  });
  $('#importFile').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var obj;
      try { obj = JSON.parse(String(reader.result)); }
      catch (err) {
        showMsg('That file is not valid JSON. Please choose a backup exported from this app.', true);
        return;
      }
      var res = validateImport(obj);
      if (!res.ok) { showMsg('Import failed: ' + res.error, true); return; }
      pendingImport = res.data;
      var d = res.data;
      $('#importSummary').textContent = 'Found ' + d.habits.length + ' habits, ' + d.health.length + ' health entries, ' +
        d.finance.length + ' transactions, ' + d.goals.length + ' goals, ' + d.tasks.length + ' tasks, ' + d.budgets.length + ' budgets (v' + (obj.version || '?') + ', exported ' + (obj.exportDate || 'unknown date') + ').';
      $('#importBox').hidden = false;
      $('#importReplace').focus();
    };
    reader.onerror = function () { showMsg('Could not read that file. Try again.', true); };
    reader.readAsText(file);
  });
  $('#importCancel').addEventListener('click', function () {
    pendingImport = null; $('#importBox').hidden = true;
  });
  $('#importReplace').addEventListener('click', function () {
    if (!pendingImport) return;
    if (!confirm('Replace ALL current data with the imported file?')) return;
    state = pendingImport;
    state.settings.theme = currentTheme();
    pendingImport = null; $('#importBox').hidden = true;
    save(); renderAll();
    showMsg('Import complete: replaced existing data.');
  });
  $('#importMerge').addEventListener('click', function () {
    if (!pendingImport) return;
    state = migrate(mergeStates(state, pendingImport));
    pendingImport = null; $('#importBox').hidden = true;
    save(); renderAll();
    showMsg('Import complete: merged with existing data.');
  });
}

/* ---------- PWA: service worker + Add to Home Screen ---------- */
var deferredInstallPrompt = null;
var INSTALL_DISMISS_KEY = 'personal-tracker-install-dismissed';
function isStandalone() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch (e) {}
  if (window.navigator && window.navigator.standalone === true) return true; // iOS
  return false;
}
function isIos() {
  var ua = (navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return true;
  // iPadOS 13+ reports as MacIntel with touch
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  return false;
}
function installDismissed() {
  try { return localStorage.getItem(INSTALL_DISMISS_KEY) === '1'; } catch (e) { return false; }
}
function hideInstallUI() {
  var b = $('#installBtn'); if (b) b.hidden = true;
  var c = $('#installCard'); if (c) c.hidden = true;
}
function refreshInstallUI() {
  var btn = $('#installBtn'), card = $('#installCard');
  if (!btn || !card) return;
  if (isStandalone()) { hideInstallUI(); return; }
  if (installDismissed() && !deferredInstallPrompt) { hideInstallUI(); return; }
  if (isIos()) {
    // iOS has no beforeinstallprompt — show manual steps once.
    if (installDismissed()) { hideInstallUI(); return; }
    card.hidden = false;
    btn.hidden = true;
    var hint = $('#installIosHint'); if (hint) hint.hidden = false;
    var cta = $('#installBtnCard'); if (cta) cta.hidden = true; // nothing to trigger on iOS
    return;
  }
  // Android / desktop Chromium: show when the browser says installable.
  if (deferredInstallPrompt) {
    btn.hidden = false;
    if (!installDismissed()) card.hidden = false;
  } else {
    btn.hidden = true;
    // Still show the card (with manual fallback text) so users can find it.
    if (!installDismissed()) card.hidden = false;
  }
}
function promptInstall() {
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') hideInstallUI();
        deferredInstallPrompt = null;
        refreshInstallUI();
      }).catch(function () {});
    } catch (e) {}
    return;
  }
  // No prompt available (already handled on iOS): explain manual steps.
  var t = $('#installText');
  if (t) {
    t.textContent = isIos()
      ? 'On iPhone / iPad: tap Share (⎙) → Add to Home Screen.'
      : 'Open the browser menu (⋮) → “Add to Home screen” or “Install app”. Then it opens fullscreen and works offline.';
  }
}
function initPWA() {
  // Offline cache (needs http(s); file:// skips silently).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      try {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      } catch (e) {}
    });
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    refreshInstallUI();
  });
  window.addEventListener('appinstalled', function () {
    deferredInstallPrompt = null;
    hideInstallUI();
  });
  document.addEventListener('click', function (e) {
    var hit = e.target && e.target.closest ? e.target.closest('#installBtn, #installBtnCard, #installDismiss') : null;
    var id = hit ? hit.id : '';
    if (id === 'installBtn' || id === 'installBtnCard') promptInstall();
    if (id === 'installDismiss') {
      try { localStorage.setItem(INSTALL_DISMISS_KEY, '1'); } catch (err) {}
      var c = $('#installCard'); if (c) c.hidden = true;
    }
  });
  refreshInstallUI();
}

/* ---------- boot ---------- */
var renderedDay = todayStr();
function renderAll() {
  renderedDay = todayStr();
  renderDashboard(); renderHabits(); renderHealth(); renderFinance(); renderTasks();
  renderBackupNudge(); updateStorageInfo();
}
// Installed apps stay open for days: when we come back after midnight,
// move "today" forward (checklist, default form dates, current month).
function checkDayRollover() {
  var t = todayStr();
  if (t === renderedDay) return;
  var prev = renderedDay;
  if (!editingHealthId && $('#healthDate').value === prev) $('#healthDate').value = t;
  if (!editingFinanceId && $('#finDate').value === prev) $('#finDate').value = t;
  if (financeMonth === monthKey(prev)) financeMonth = monthKey(t);
  renderAll();
}
document.addEventListener('DOMContentLoaded', function () {
  load();
  initTheme(); initTabs();
  initHabits(); initHealth(); initFinance(); initBudgets(); initTasks(); initDataButtons();
  initPWA();
  renderAll();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkDayRollover();
  });
  window.addEventListener('focus', checkDayRollover);
  setInterval(checkDayRollover, 60 * 1000);
});
