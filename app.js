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
    settings: { theme: 'auto' }
  };
}
var state = defaultState();
var dataMsgTimer = null;

function save() {
  try {
    state.version = SCHEMA_VERSION;
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    updateStorageInfo();
  } catch (e) {
    showMsg('Could not save (storage full or blocked). ' + (e && e.message ? e.message : ''), true);
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
function showMsg(text, isErr) {
  var el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', !!isErr);
  el.hidden = false;
  clearTimeout(dataMsgTimer);
  dataMsgTimer = setTimeout(function () { el.hidden = true; }, isErr ? 6000 : 3500);
}
function updateStorageInfo() {
  try {
    var bytes = (localStorage.getItem(STORE_KEY) || '').length;
    $('#storageInfo').textContent = (bytes / 1024).toFixed(1) + ' KB stored locally';
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
  btn.innerHTML = (dark ? '🌙' : '☀️') + ' <span class="btn-text">' + name + '</span>';
  btn.setAttribute('aria-label', 'Theme: ' + name + ' (tap to change)');
  // Status bar / browser chrome follows the chosen theme, not just the system one.
  $all('meta[name="theme-color"]').forEach(function (m) {
    m.setAttribute('content', dark ? '#16191e' : '#ffffff');
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
  $('#habitProgress').textContent = state.habits.length ? '· ' + doneCount + '/' + state.habits.length + ' done' : '';
  list.innerHTML = state.habits.map(function (h) {
    var done = !!h.checks[t];
    var streak = habitStreak(h);
    return '<li class="habit-row' + (done ? ' is-done' : '') + '">' +
      '<label class="check-wrap"><input type="checkbox" data-check="' + esc(h.id) + '" ' + (done ? 'checked' : '') + ' aria-label="Mark ' + esc(h.name) + ' done today"></label>' +
      '<div class="grow"><strong class="' + (done ? 'done-text' : '') + '">' + esc(h.name) + '</strong>' +
      '<div class="streak' + (streak >= 3 ? ' hot' : '') + '" title="Consecutive days">' + (streak ? '🔥 ' + streak + '-day streak' : 'No streak yet') + '</div></div>' +
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
      if (!confirm('Delete this habit and its history?')) return;
      state.habits = state.habits.filter(function (x) { return x.id !== del; });
      save(); renderAll();
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
      if (!confirm('Delete this health entry?')) return;
      state.health = state.health.filter(function (x) { return x.id !== del; });
      save(); renderAll();
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
function formatAmountBlur(input) {
  var v = parseAmount(input.value);
  if (isNaN(v)) return; // leave invalid text so submit can warn
  try { input.value = v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  catch (e) { input.value = v.toFixed(2); }
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
function renderFinance() {
  // Summary cards always show the viewed month (defaults to current month),
  // so September income can never leak into the October total.
  var viewMonth = financeViewMonth();
  var monthItems = state.finance.filter(function (f) { return monthKey(normDateStr(f.date)) === viewMonth; });
  var mt = financeTotals(monthItems);
  $('#finIncome').textContent = money(mt.income);
  $('#finExpense').textContent = money(mt.expense);
  $('#finBalance').textContent = money(mt.balance);
  var mLabel = monthLabel(viewMonth);
  ['finIncomeMonth', 'finExpenseMonth', 'finBalanceMonth'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.textContent = '(' + mLabel + ')';
  });
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
  $('#financeList').innerHTML = items.map(function (f) {
    if (f.type === 'transfer') {
      var tmeta = esc(niceDate(f.date)) + ' · ' + esc(f.fromWallet || '?') + ' → ' + esc(f.toWallet || '?') +
        ((f.fee || 0) > 0 ? ' · fee ' + esc(money(f.fee)) : '') +
        (f.description ? ' · ' + esc(f.description) : '');
      return '<li class="entry"><span class="fin-ico transfer" aria-hidden="true">⇄</span>' +
        '<div class="grow"><div class="entry-title"><strong>Transfer</strong><span class="amt">' + esc(money(f.amount)) + '</span></div>' +
        '<div class="meta">' + tmeta + '</div></div>' +
        iconBtns('fin', f.id, 'transfer of ' + money(f.amount)) + '</li>';
    }
    var desc = f.description || f.note || ''; // f.note: very old saves
    var inc = f.type === 'income';
    var meta = esc(niceDate(f.date)) + (f.payMethod ? ' · ' + esc(f.payMethod) : '') + (desc ? ' · ' + esc(desc) : '');
    return '<li class="entry"><span class="fin-ico ' + (inc ? 'income' : 'expense') + '" aria-hidden="true">' + (inc ? '↓' : '↑') + '</span>' +
      '<div class="grow"><div class="entry-title"><strong>' + esc(f.category) + '</strong>' +
      '<span class="amt ' + (inc ? 'pos' : 'neg') + '">' + (inc ? '+' : '−') + esc(money(f.amount)) + '</span></div>' +
      '<div class="meta">' + meta + '</div></div>' +
      iconBtns('fin', f.id, f.category + ' ' + money(f.amount)) + '</li>';
  }).join('');
}
// Form fields follow the transaction type: transfer shows From/To/Fee,
// income gets income categories, expense gets expense categories + pay method.
function toggleFinanceType() {
  var t = $('#finType').value;
  var isIncome = t === 'income', isTransfer = t === 'transfer';
  $('#finTransferWrap').hidden = !isTransfer;
  $('#finCatWrap').style.display = isTransfer ? 'none' : '';
  $('#finPayWrap').style.display = isTransfer ? 'none' : '';
  // a hidden required field blocks submit ("not focusable" error), so un-require it in transfer mode
  $('#finCategory').required = !isTransfer;
  $('#finPayLabel').textContent = isIncome ? 'Received via' : 'Mode of payment';
  $all('.type-seg .seg-btn').forEach(function (b) {
    var on = b.dataset.fintype === t;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  if (!isTransfer) {
    $('#finCategory').setAttribute('list', isIncome ? 'finCatIncome' : 'finCatList');
  }
}
/* Finance modal: the add/edit form lives in a native <dialog>. */
function financeDialog() { return $('#financeDialog'); }
function resetFinanceForm() {
  editingFinanceId = null;
  $('#financeForm').reset();
  $('#finDate').value = todayStr(); $('#finType').value = 'expense';
  $('#finPay').value = 'Cash'; toggleFinanceType();
  $('#financeFormTitle').textContent = 'Add transaction';
  $('#financeSubmit').textContent = 'Add';
}
function openFinanceDialog() {
  var d = financeDialog();
  if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); }
  else d.setAttribute('open', '');
  $('#finAmount').focus();
}
function closeFinanceDialog() {
  var d = financeDialog();
  if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  resetFinanceForm();
}
function initFinance() {
  $('#finDate').value = todayStr();
  toggleFinanceType();
  $('#openFinanceModal').addEventListener('click', function () {
    resetFinanceForm(); openFinanceDialog();
  });
  $('#financeCancel').addEventListener('click', closeFinanceDialog);
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
  financeDialog().addEventListener('close', resetFinanceForm); // ESC key
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
    var isIncome = kind === 'income';
    var obj = {
      id: editingFinanceId || uid(),
      type: isIncome ? 'income' : 'expense',
      amount: Math.round(amount * 100) / 100,
      category: $('#finCategory').value.trim() || 'Other',
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
      try { $('#finAmount').value = Number(f.amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
      catch (e) { $('#finAmount').value = Number(f.amount).toFixed(2); }
      $('#finCategory').value = f.category; $('#finDate').value = f.date;
      $('#finDesc').value = f.description || f.note || '';
      $('#finPay').value = f.payMethod || 'Cash';
      $('#finFrom').value = f.fromWallet || f.payMethod || 'Maya';
      $('#finTo').value = f.toWallet || 'GCash';
      try { $('#finFee').value = (Number(f.fee) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
      catch (e) { $('#finFee').value = (Number(f.fee) || 0).toFixed(2); }
      toggleFinanceType();
      $('#financeFormTitle').textContent = 'Edit transaction';
      $('#financeSubmit').textContent = 'Save';
      openFinanceDialog();
    }
    if (del) {
      if (!confirm('Delete this transaction?')) return;
      state.finance = state.finance.filter(function (x) { return x.id !== del; });
      save(); renderAll();
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
      if (!confirm('Delete this goal? Linked tasks will become unlinked (not deleted).')) return;
      state.goals = state.goals.filter(function (x) { return x.id !== del; });
      state.tasks.forEach(function (t) { if (t.goalId === del) t.goalId = ''; });
      save(); renderAll();
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
      if (!confirm('Delete this task?')) return;
      state.tasks = state.tasks.filter(function (x) { return x.id !== del; });
      save(); renderAll();
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
// Minimal SVG vertical bar chart: labels[] + values[] (0-100).
function svgBars(labels, values, colorClass) {
  var W = 320, H = 130, padB = 22, max = 100;
  var n = values.length, bw = Math.min(34, (W - 10) / n - 8);
  var gap = (W - 10 - bw * n) / (n + 1 || 1);
  var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="presentation">';
  for (var i = 0; i < n; i++) {
    var v = Math.max(0, Math.min(100, values[i]));
    var h = (H - padB - 8) * (v / max);
    var x = 5 + gap + i * (bw + gap);
    var y = H - padB - h;
    s += '<rect class="bar-bg" x="' + x.toFixed(1) + '" y="8" width="' + bw + '" height="' + (H - padB - 8) + '" rx="4"/>';
    s += '<rect class="bar ' + (colorClass && colorClass[i] ? colorClass[i] : '') + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw + '" height="' + Math.max(2, h).toFixed(1) + '" rx="4"><title>' + esc(labels[i]) + ': ' + v + '%</title></rect>';
    s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(labels[i]) + '</text>';
  }
  return s + '</svg>';
}
// Horizontal bars for category totals.
function svgHBars(rows) { // rows: [{label, value}]
  var W = 320, rowH = 26, H = rows.length * rowH + 8;
  var max = Math.max.apply(null, [1].concat(rows.map(function (r) { return r.value; })));
  var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="presentation">';
  rows.forEach(function (r, i) {
    // label column | bar | amount column (amount kept outside the bar so long ₱ values never overlap)
    var labelW = 92, amtW = 78, barW = W - labelW - amtW - 8;
    var y = 4 + i * rowH, w = barW * (r.value / max);
    var lbl = r.label.length > 13 ? r.label.slice(0, 12) + '…' : r.label;
    s += '<text x="0" y="' + (y + 13) + '">' + esc(lbl) + '</text>';
    s += '<rect class="bar-bg" x="' + labelW + '" y="' + y + '" width="' + barW + '" height="16" rx="4"/>';
    s += '<rect class="bar" x="' + labelW + '" y="' + y + '" width="' + Math.max(2, w).toFixed(1) + '" height="16" rx="4"><title>' + esc(r.label) + ': ' + money(r.value) + '</title></rect>';
    s += '<text x="' + (W - 2) + '" y="' + (y + 13) + '" text-anchor="end">' + esc(money(r.value)) + '</text>';
  });
  return s + '</svg>';
}
function renderDashboard() {
  var t = todayStr();
  var now = new Date(), hr = now.getHours();
  $('#greeting').textContent = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  $('#todayLabel').textContent = WEEKDAYS[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear();
  // habits
  var done = state.habits.filter(function (h) { return h.checks[t]; }).length;
  $('#dashHabits').textContent = done + '/' + state.habits.length;
  $('#dashHabitsSub').textContent = state.habits.length ? 'completed today' : 'add habits to get started';
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
  $('#dashFinanceSub').textContent = 'income ' + money(mt.income) + ' · balance ' + money(mt.balance);
  // tasks
  var open = state.tasks.filter(function (x) { return !x.done; }).length;
  var overdue = state.tasks.filter(function (x) { return !x.done && x.due && x.due < t; }).length;
  $('#dashTasks').textContent = open + ' open';
  $('#dashTasksSub').textContent = overdue ? overdue + ' overdue' : state.tasks.length ? 'nothing overdue 🎉' : 'add tasks to get started';
  // charts
  var days = last7();
  var labels = days.map(function (d) { return d === t ? 'Today' : WEEKDAYS[parseD(d).getDay()]; });
  var vals = days.map(habitDayPct);
  var cls = days.map(function (d) { return d === t ? 'today' : ''; });
  $('#chartHabitsWeek').innerHTML = state.habits.length ? svgBars(labels, vals, cls) : '<p class="empty">Add a habit to see your week.</p>';
  var byCat = {};
  state.finance.filter(function (f) { return monthKey(normDateStr(f.date)) === monthKey(t); })
    .forEach(function (f) {
      if (f.type === 'expense') byCat[f.category] = (byCat[f.category] || 0) + f.amount;
      else if (f.type === 'transfer' && (f.fee || 0) > 0) byCat['Transfer fees'] = (byCat['Transfer fees'] || 0) + f.fee;
    });
  var rows = Object.keys(byCat).map(function (k) { return { label: k, value: byCat[k] }; })
    .sort(function (a, b) { return b.value - a.value; }).slice(0, 6);
  $('#chartSpendCat').innerHTML = rows.length ? svgHBars(rows) : '<p class="empty">No spending this month yet.</p>';
  renderWallets();
}
function renderWallets() {
  paintWallets($('#walletBalances'), $('#walletEmpty'));
  paintWallets($('#finWalletBalances'), $('#finWalletEmpty'));
}
function paintWallets(box, emptyEl) {
  if (!box) return;
  var rows = walletBalances();
  if (emptyEl) emptyEl.style.display = rows.length ? 'none' : '';
  box.innerHTML = rows.map(function (r) {
    var cls = r.balance < 0 ? 'neg' : 'pos';
    return '<div class="wallet"><div class="w-name">' + esc(r.wallet) + '</div><div class="big ' + cls + '">' + esc(money(r.balance)) + '</div></div>';
  }).join('');
}

/* ---------- export / import / reset ---------- */
function buildExport() {
  return {
    app: 'personal-tracker',
    version: SCHEMA_VERSION,
    exportDate: new Date().toISOString(),
    data: {
      habits: state.habits, health: state.health,
      finance: state.finance, goals: state.goals, tasks: state.tasks
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
  var names = ['habits', 'health', 'finance', 'goals', 'tasks'];
  for (var i = 0; i < names.length; i++) {
    if (checkArr(names[i]) === null) return { ok: false, error: 'Field "' + names[i] + '" must be an array.' };
  }
  var candidate = {
    version: Number(obj.version) || SCHEMA_VERSION,
    habits: data.habits || [], health: data.health || [],
    finance: data.finance || [], goals: data.goals || [], tasks: data.tasks || [],
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
  return out;
}
var pendingImport = null;
function initDataButtons() {
  function doExport() {
    downloadJson(buildExport(), 'personal-tracker-' + todayStr() + '.json');
    showMsg('Backup downloaded. Keep it somewhere safe.');
  }
  $('#exportBtn').addEventListener('click', doExport);
  $('#exportBtnTop').addEventListener('click', doExport);
  $('#resetBtn').addEventListener('click', function () {
    if (!confirm('Delete ALL local data (habits, health, finance, tasks)? This cannot be undone.\n\nTip: Export a backup first.')) return;
    if (!confirm('Really erase everything? Last chance!')) return;
    state = defaultState();
    state.settings.theme = currentTheme();
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
        d.finance.length + ' transactions, ' + d.goals.length + ' goals, ' + d.tasks.length + ' tasks (v' + (obj.version || '?') + ', exported ' + (obj.exportDate || 'unknown date') + ').';
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
    var id = e.target && e.target.id;
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
  updateStorageInfo();
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
  initHabits(); initHealth(); initFinance(); initTasks(); initDataButtons();
  initPWA();
  renderAll();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkDayRollover();
  });
  window.addEventListener('focus', checkDayRollover);
  setInterval(checkDayRollover, 60 * 1000);
});
