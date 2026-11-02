/* Finance Tracker — vanilla JS, offline-first, localStorage only.
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
    finance: [],  // {id,type:'income'|'expense'|'transfer',amount,category,description,payMethod,fee,fromWallet,toWallet,date}
    budgets: [],  // {category, amount} monthly spending limit per expense category
    openings: [], // {wallet, amount} starting balance per wallet (what it held before the logged transactions)
    recurring: [],// {id,type,amount,category,payMethod,fromWallet,toWallet,fee,description,day,lastAdded:'YYYY-MM'}
    // Habits/health/goals/tasks from the earlier all-in-one tracker: no UI any more, but kept
    // untouched (and in backups) so nobody's old data is thrown away. null when there is none.
    legacy: null, // {habits:[], health:[], goals:[], tasks:[]}
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
  d.finance = arr(s.finance).map(function (f) {
    // note (old field name) folds into description so old backups keep their text
    var t = (f.type === 'income' || f.type === 'transfer') ? f.type : 'expense';
    return { id: String(f.id || uid()), type: t, amount: Math.abs(Number(f.amount) || 0), category: String(f.category || (t === 'transfer' ? 'Transfer' : 'Other')).slice(0, 40), description: String(f.description || f.note || '').slice(0, 140), payMethod: String(f.payMethod || '').slice(0, 30), fee: Math.abs(Number(f.fee) || 0), fromWallet: String(f.fromWallet || f.payMethod || '').slice(0, 30), toWallet: String(f.toWallet || '').slice(0, 30), date: normDateStr(f.date), recurId: String(f.recurId || '') };
  }).filter(function (f) { return f.amount > 0 && !!parseD(f.date); });
  var seenOpen = {};
  d.openings = arr(s.openings).map(function (o) {
    return { wallet: String((o && o.wallet) || '').trim().slice(0, 30), amount: Math.round((Number(o && o.amount) || 0) * 100) / 100 };
  }).filter(function (o) {
    if (!o.wallet || !o.amount || seenOpen[o.wallet]) return false;
    seenOpen[o.wallet] = true; return true;
  });
  d.recurring = arr(s.recurring).map(function (r) {
    r = r || {};
    var t = (r.type === 'income' || r.type === 'transfer') ? r.type : 'expense';
    return { id: String(r.id || uid()), type: t, amount: Math.round(Math.abs(Number(r.amount) || 0) * 100) / 100,
      category: String(r.category || (t === 'transfer' ? 'Transfer' : 'Other')).slice(0, 40), payMethod: String(r.payMethod || '').slice(0, 30),
      fromWallet: String(r.fromWallet || '').slice(0, 30), toWallet: String(r.toWallet || '').slice(0, 30), fee: Math.abs(Number(r.fee) || 0),
      description: String(r.description || '').slice(0, 140), day: Math.min(31, Math.max(1, Math.round(Number(r.day) || 1))),
      lastAdded: /^\d{4}-\d{2}$/.test(r.lastAdded || '') ? r.lastAdded : monthKey(todayStr()) };
  }).filter(function (r) { return r.amount > 0; });
  d.legacy = pickLegacy(s);
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
var LEGACY_KEYS = ['habits', 'health', 'goals', 'tasks'];
// Old sections' data, from `legacy` (current format) or top-level arrays (old storage/backups).
// Passed through as-is: nothing reads it, so it is never reshaped or deduplicated.
function pickLegacy(s) {
  var src = s && s.legacy && typeof s.legacy === 'object' ? s.legacy : s;
  var out = {}, n = 0;
  LEGACY_KEYS.forEach(function (k) {
    out[k] = src && Array.isArray(src[k]) ? src[k] : [];
    n += out[k].length;
  });
  return n ? out : null;
}
function legacyCount(l) {
  return l ? LEGACY_KEYS.reduce(function (a, k) { return a + l[k].length; }, 0) : 0;
}

/* ---------- UI helpers ---------- */
function showMsg(text, isErr, withUndo, extraClass) {
  var el = $('#toast');
  if (!el) return;
  if (!withUndo) undoSnap = null; // the Undo button is gone, so drop its snapshot
  // A modal <dialog> sits in the top layer above everything; show the toast inside it
  // so messages like "Pick a category." aren't hidden behind the sheet.
  var host = topDialog() || document.body;
  if (el.parentNode !== host) host.appendChild(el);
  el.innerHTML = '<span class="toast-text"></span>' + (withUndo ? '<button type="button" class="toast-undo" id="toastUndo">Undo</button>' : '');
  el.firstChild.textContent = text;
  el.classList.toggle('is-error', !!isErr);
  el.classList.toggle('has-action', !!withUndo);
  el.classList.toggle('is-warn', extraClass === 'is-warn');
  el.hidden = false;
  if (withUndo) $('#toastUndo').addEventListener('click', undoDelete);
  clearTimeout(dataMsgTimer);
  dataMsgTimer = setTimeout(function () {
    el.hidden = true;
    if (withUndo) undoSnap = null;
  }, withUndo || isErr || extraClass ? 6000 : 3500);
}
/* ---------- delete with undo (instead of "Are you sure?" popups) ---------- */
var undoSnap = null;
var SNAP_KEYS = ['finance', 'budgets', 'openings', 'recurring'];
function snapFinance() { var o = {}; SNAP_KEYS.forEach(function (k) { o[k] = state[k]; }); return JSON.stringify(o); }
function restoreFinance(snap) {
  var m = migrate(JSON.parse(snap));
  SNAP_KEYS.forEach(function (k) { state[k] = m[k]; });
}
function deleteWithUndo(msg, mutate) {
  var snap = snapFinance();
  mutate();
  if (!save()) { // keep screen and storage in sync; save() already showed the error
    restoreFinance(snap); renderAll(); return;
  }
  renderAll();
  undoSnap = snap; // armed after save(), which clears it
  showMsg(msg, false, true);
}
function undoDelete() {
  if (!undoSnap) return;
  var snap = undoSnap;
  try { restoreFinance(snap); } catch (e) { return; }
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
  state.openings.forEach(function (o) { add(o.wallet, o.amount); });
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
// Starting balances count as money you already had, so they are part of what carries over.
function openingTotal() { return state.openings.reduce(function (a, o) { return a + o.amount; }, 0); }
function balanceThrough(ym) {
  var before = state.finance.filter(function (f) { return monthKey(normDateStr(f.date)) < ym; });
  var upTo = state.finance.filter(function (f) { return monthKey(normDateStr(f.date)) <= ym; });
  var open = openingTotal();
  return { balance: open + financeTotals(upTo).balance, carried: open + financeTotals(before).balance };
}
// What the logged transactions alone say a wallet holds (no starting balance).
function txBalance(wallet) {
  var b = 0;
  state.finance.forEach(function (f) {
    if (f.type === 'transfer') {
      if ((f.fromWallet || 'Other') === wallet) b -= f.amount + (f.fee || 0);
      if ((f.toWallet || 'Other') === wallet) b += f.amount;
    } else if ((f.payMethod || 'Other') === wallet) b += f.type === 'income' ? f.amount : -f.amount;
  });
  return Math.round(b * 100) / 100;
}
function parseSigned(str) { // "-1,234.50" -> -1234.5
  var t = String(str || '').trim(), neg = /^[-−]/.test(t);
  var v = parseAmount(t.replace(/^[-−]\s*/, ''));
  return isNaN(v) ? NaN : (neg ? -v : v);
}
function openWalletDialog() {
  var wallets = PAY_METHODS.slice();
  walletBalances().forEach(function (r) { if (wallets.indexOf(r.wallet) < 0) wallets.push(r.wallet); });
  var have = walletBalances().reduce(function (m, r) { m[r.wallet] = r.balance; return m; }, {});
  $('#walletFields').innerHTML = wallets.map(function (w, i) {
    var st = WALLET_STYLE[w] || [w.charAt(0).toUpperCase(), '#64748b'];
    var v = have[w] || 0;
    return '<li class="bud-field"><label for="wal' + i + '"><span class="w-avatar" style="--wc:' + st[1] + '" aria-hidden="true">' + esc(st[0]) + '</span>' + esc(w) + '</label>' +
      '<div class="bud-input"><span class="bud-peso" aria-hidden="true">₱</span><input id="wal' + i + '" data-wallet="' + esc(w) + '" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="' + (v ? (v < 0 ? '-' : '') + esc(formatAmount(Math.abs(v))) : '') + '"></div></li>';
  }).join('');
  openDialog($('#walletDialog'));
  try { $('#walletClose').focus({ preventScroll: true }); } catch (e) {}
}
function closeWalletDialog() { closeDialog($('#walletDialog')); }
function initWalletBalances() {
  $('#walletEdit').addEventListener('click', openWalletDialog);
  $('#walletClose').addEventListener('click', closeWalletDialog);
  $('#walletCancel').addEventListener('click', closeWalletDialog);
  $('#walletDialog').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeWalletDialog(); });
  $('#walletFields').addEventListener('input', function (e) {
    var inp = e.target;
    if (!inp.matches('input')) return;
    var neg = /^\s*[-−]/.test(inp.value);
    formatAmountLive(inp);
    if (neg) inp.value = '-' + inp.value; // card debt / overdraft can be negative
  });
  $('#walletForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var out = [], bad = null;
    $all('#walletFields input').forEach(function (inp) {
      var t = inp.value.trim();
      var want = t === '' || t === '-' ? 0 : parseSigned(t);
      if (isNaN(want)) { bad = bad || inp; return; }
      var w = inp.getAttribute('data-wallet');
      var diff = Math.round((want - txBalance(w)) * 100) / 100;
      if (diff) out.push({ wallet: w, amount: diff });
    });
    if (bad) { showMsg('Enter an amount like 3,000 or -1,500.', true); bad.focus(); return; }
    state.openings = out;
    save(); closeWalletDialog(); renderAll();
    showMsg('Wallet balances updated.');
  });
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
  var bym = budgetMonth(), monthSpend = spendByCategory(inMonth(bym));
  renderBudgets(bym, monthSpend);
  // the chart covers the same period as the list below it
  renderSpendChart(financeRange === 'month' ? monthSpend : spendByCategory(function (f) { return inRange(f.date, financeRange); }),
    financeRange === 'month' ? monthLabel(bym) : RANGE_LABEL[financeRange]);
}
/* ---------- monthly budgets per expense category ---------- */
// Spending per category in a month: [{ label, value }]; categories match ignoring case,
// and transfer fees count as spending (like the monthly Expenses total).
var FEES_CAT = 'Transfer fees';
function spendByCategory(keep) { // keep(f) -> bool
  var by = {};
  state.finance.forEach(function (f) {
    if (!keep(f)) return;
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
function inMonth(ym) { return function (f) { return monthKey(normDateStr(f.date)) === ym; }; }
// Budgets are monthly. The month navigator only shows in Month mode; otherwise they track this month.
function budgetMonth() { return financeRange === 'month' ? financeViewMonth() : monthKey(todayStr()); }
function renderBudgets(ym, spent) {
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
  // The sheet is closed most of the time, so flag trouble on the button that opens it.
  var over = rows.filter(function (r) { return r.pct > 1; }).length;
  var near = rows.filter(function (r) { return r.pct >= 0.8 && r.pct <= 1; }).length;
  var flag = $('#insightsFlag');
  flag.hidden = !over && !near;
  flag.textContent = over ? over + ' over' : near ? near + ' near limit' : '';
  flag.classList.toggle('is-warn', !over && near > 0);
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
// "Dining Out: ₱110.00 left this month" for the expense's month, or null if no budget.
function budgetNote(f) {
  if (f.type !== 'expense') return null;
  var limit = budgetFor(f.category);
  if (!limit) return null;
  var ym = monthKey(f.date);
  var hit = spendByCategory(inMonth(ym))[f.category.toLowerCase()];
  var left = Math.round((limit - (hit ? hit.value : 0)) * 100) / 100;
  var when = ym === monthKey(todayStr()) ? 'this month' : 'in ' + monthLabel(ym);
  return { over: left < 0, near: left >= 0 && left <= limit * 0.2,
    text: f.category + ': ' + (left >= 0 ? money(left) + ' left ' + when : money(-left) + ' over budget ' + when) };
}
function savedMsg(f, base) {
  var n = budgetNote(f);
  if (!n) { showMsg(base); return; }
  showMsg(base + ' ' + n.text + '.', n.over, false, n.near ? 'is-warn' : '');
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
function closeInsights() { closeDialog($('#insightsDialog')); }
function initBudgets() {
  $('#openInsights').addEventListener('click', function () {
    openDialog($('#insightsDialog'));
    try { $('#insightsClose').focus({ preventScroll: true }); } catch (e) {}
  });
  $('#insightsClose').addEventListener('click', closeInsights);
  $('#insightsDialog').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeInsights(); });
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
// Dialogs can stack (Budgets sheet → budget editor). The editor comes later in the page,
// so the last open dialog is the one on top.
function topDialog() {
  var open = document.querySelectorAll('dialog[open]');
  return open.length ? open[open.length - 1] : null;
}
function rehomeToast() {
  var t = $('#toast'); // the toast may have moved into a dialog that just closed
  var host = topDialog() || document.body;
  if (t && t.parentNode !== host) host.appendChild(t);
}
function closeDialog(d) {
  if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  rehomeToast();
}
// Esc closes a dialog without going through closeDialog; 'close' doesn't bubble, so capture it.
document.addEventListener('close', function (e) { if (e.target.tagName === 'DIALOG') rehomeToast(); }, true);
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
      upsertTx(tobj);
      closeFinanceDialog();
      save(); renderAll();
      showMsg('Transfer saved' + (tobj.recurId ? ', repeats monthly.' : '.'));
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
    upsertTx(obj);
    closeFinanceDialog();
    save(); renderAll();
    savedMsg(obj, (isIncome ? 'Income' : 'Expense') + ' of ' + money(obj.amount) + ' saved' + (obj.recurId ? ', repeats monthly.' : '.'));
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
      $('#finRepeat').checked = !!recurById(f.recurId);
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

/* ---------- recurring (monthly) transactions ---------- */
function recurById(id) { return id ? state.recurring.find(function (r) { return r.id === id; }) || null : null; }
// Save a transaction and keep its monthly template in sync with the "Repeat every month" switch.
function upsertTx(obj) {
  var prev = editingFinanceId ? state.finance.find(function (x) { return x.id === editingFinanceId; }) : null;
  var tpl = recurById(prev && prev.recurId);
  if ($('#finRepeat').checked) {
    if (!tpl) { tpl = { id: uid(), lastAdded: monthKey(obj.date) }; state.recurring.push(tpl); }
    ['type', 'amount', 'category', 'payMethod', 'fromWallet', 'toWallet', 'fee', 'description'].forEach(function (k) { tpl[k] = obj[k]; });
    tpl.day = parseD(obj.date).getDate();
    if (monthKey(obj.date) > tpl.lastAdded) tpl.lastAdded = monthKey(obj.date);
    obj.recurId = tpl.id;
  } else {
    if (tpl) state.recurring = state.recurring.filter(function (r) { return r !== tpl; });
    obj.recurId = '';
  }
  if (prev) state.finance[state.finance.indexOf(prev)] = obj; else state.finance.push(obj);
}
function daysIn(ym) { return new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate(); }
function dueDate(r, ym) { return ym + '-' + String(Math.min(r.day, daysIn(ym))).padStart(2, '0'); }
// The next month this template still has to be added for (after lastAdded).
function nextDue(r) { var ym = shiftMonth(r.lastAdded, 1); return { ym: ym, date: dueDate(r, ym) }; }
function recurTitle(r) { return r.type === 'transfer' ? 'Transfer ' + (r.fromWallet || '?') + ' → ' + (r.toWallet || '?') : (r.description || r.category); }
function ordinal(n) { var v = n % 100; return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); }
function renderRecurring() {
  var t = todayStr();
  var due = state.recurring.map(function (r) { return { r: r, n: nextDue(r) }; })
    .filter(function (x) { return x.n.date <= t; })
    .sort(function (a, b) { return a.n.date < b.n.date ? -1 : 1; });
  var box = $('#recurDue');
  box.hidden = !due.length;
  $('#recurDueList').innerHTML = due.map(function (x) {
    var r = x.r, inc = r.type === 'income';
    var amt = r.type === 'transfer' ? money(r.amount) : (inc ? '+' : '−') + money(r.amount);
    return '<li class="due-row"><div class="due-text"><span class="due-title">' + esc(recurTitle(r)) + '</span>' +
      '<span class="due-meta">' + esc(r.type === 'transfer' ? 'Transfer' : r.category) + ' · due ' + esc(niceDate(x.n.date)) + '</span></div>' +
      '<span class="amt ' + (r.type === 'transfer' ? '' : inc ? 'pos' : 'neg') + '">' + esc(amt) + '</span>' +
      '<div class="due-actions"><button type="button" class="btn btn-sm" data-recur-add="' + esc(r.id) + '">Add</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-recur-skip="' + esc(r.id) + '">Skip</button></div></li>';
  }).join('');
  $('#recurTitle').textContent = due.length === 1 ? '1 repeating payment is due' : due.length + ' repeating payments are due';
  // all templates, in the Recurring card
  var list = state.recurring.slice().sort(function (a, b) { return a.day - b.day; });
  $('#recurCard').hidden = !list.length;
  $('#recurList').innerHTML = list.map(function (r) {
    var inc = r.type === 'income';
    return '<li class="rec-row"><div class="due-text"><span class="due-title">' + esc(recurTitle(r)) + '</span>' +
      '<span class="due-meta">Every ' + esc(ordinal(r.day)) + ' · next ' + esc(niceDate(nextDue(r).date)) + '</span></div>' +
      '<span class="amt ' + (r.type === 'transfer' ? '' : inc ? 'pos' : 'neg') + '">' + esc(money(r.amount)) + '</span>' +
      '<button type="button" class="btn btn-ghost btn-icon" data-recur-stop="' + esc(r.id) + '" aria-label="Stop repeating ' + esc(recurTitle(r)) + '"><svg class="ico" aria-hidden="true"><use href="#i-close"/></svg></button></li>';
  }).join('');
}
function initRecurring() {
  $('#recurDueList').addEventListener('click', function (e) {
    var addId = dataFrom(e, 'data-recur-add'), skipId = dataFrom(e, 'data-recur-skip');
    var r = recurById(addId || skipId);
    if (!r) return;
    var n = nextDue(r);
    r.lastAdded = n.ym;
    if (skipId) { save(); renderAll(); showMsg('Skipped ' + recurTitle(r) + ' for ' + monthLabel(n.ym) + '.'); return; }
    var f = { id: uid(), type: r.type, amount: r.amount, category: r.category, description: r.description, payMethod: r.payMethod,
      fee: r.type === 'transfer' ? r.fee : 0, fromWallet: r.type === 'transfer' ? r.fromWallet : '', toWallet: r.type === 'transfer' ? r.toWallet : '',
      date: n.date, recurId: r.id };
    state.finance.push(f);
    save(); renderAll();
    savedMsg(f, 'Added ' + recurTitle(r) + ' (' + money(r.amount) + ').');
  });
  $('#recurList').addEventListener('click', function (e) {
    var id = dataFrom(e, 'data-recur-stop');
    var r = recurById(id);
    if (!r) return;
    deleteWithUndo('Stopped repeating ' + recurTitle(r) + '.', function () {
      state.recurring = state.recurring.filter(function (x) { return x.id !== id; });
    });
  });
}

/* ---------- spending by category + wallets ---------- */
function hBars(rows) { // rows: [{label, value}]
  var max = Math.max.apply(null, [1].concat(rows.map(function (r) { return r.value; })));
  return '<ul class="hbars">' + rows.map(function (r) {
    var pct = Math.max(1, Math.round(r.value / max * 100));
    return '<li><div class="hb-head"><span class="hb-label">' + esc(r.label) + '</span><span class="amt">' + esc(money(r.value)) + '</span></div>' +
      '<div class="hb-track"><span style="width:' + pct + '%"></span></div></li>';
  }).join('') + '</ul>';
}
var RANGE_LABEL = { today: 'Today', week: 'This week', all: 'All time' };
function renderSpendChart(byCat, label) {
  var rows = Object.keys(byCat).map(function (k) { return byCat[k]; })
    .sort(function (x, y) { return y.value - x.value; }).slice(0, 8);
  $('#spendMonth').textContent = '· ' + label;
  $('#chartSpendCat').innerHTML = rows.length ? hBars(rows) : '<p class="empty">No spending ' + (label === 'All time' ? 'yet' : 'for ' + esc(label)) + '.</p>';
}
function renderWallets() {
  paintWallets($('#finWalletBalances'), $('#finWalletEmpty'), $('#finWalletTotal'));
}
var WALLET_STYLE = { // [initials, color]
  'Cash': ['₱', '#16a34a'], 'GCash': ['G', '#2563eb'], 'Maya': ['M', '#0d9488'],
  'Debit Card': ['DC', '#7c3aed'], 'Credit Card': ['CC', '#ea580c'], 'Bank Transfer': ['B', '#4f46e5'], 'Other': ['•', '#64748b']
};
function paintWallets(box, emptyEl, totalEl) {
  if (!box) return;
  var rows = walletBalances();
  var hasActivity = state.finance.length > 0 || state.openings.length > 0;
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
function recordCount() { return state.finance.length + state.budgets.length + legacyCount(state.legacy); }
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
    data: (function () {
      var d = { finance: state.finance, budgets: state.budgets, openings: state.openings, recurring: state.recurring };
      if (state.legacy) d.legacy = state.legacy;
      return d;
    })()
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
  var names = ['habits', 'health', 'finance', 'goals', 'tasks', 'budgets', 'openings', 'recurring'];
  for (var i = 0; i < names.length; i++) {
    if (checkArr(names[i]) === null) return { ok: false, error: 'Field "' + names[i] + '" must be an array.' };
  }
  if (data.legacy !== undefined && (typeof data.legacy !== 'object' || Array.isArray(data.legacy))) return { ok: false, error: 'Field "legacy" must be an object.' };
  var candidate = {
    version: Number(obj.version) || SCHEMA_VERSION,
    finance: data.finance || [], budgets: data.budgets || [],
    openings: data.openings || [], recurring: data.recurring || [],
    legacy: data.legacy || null,
    habits: data.habits, health: data.health, goals: data.goals, tasks: data.tasks, // backups from the old all-in-one app
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
  var ids = {};
  out.finance.forEach(function (r) { ids[r.id] = true; });
  incoming.finance.forEach(function (r) {
    var row = JSON.parse(JSON.stringify(r));
    if (!row.id || ids[row.id]) row.id = uid();
    ids[row.id] = true;
    out.finance.push(row);
  });
  // starting balances: keep yours, take the file's for wallets you haven't set
  (incoming.openings || []).forEach(function (o) {
    if (!out.openings.some(function (x) { return x.wallet === o.wallet; })) out.openings.push({ wallet: o.wallet, amount: o.amount });
  });
  // repeating payments: add the ones you don't have (same id = same template)
  (incoming.recurring || []).forEach(function (r) {
    if (!out.recurring.some(function (x) { return x.id === r.id; })) out.recurring.push(JSON.parse(JSON.stringify(r)));
  });
  // old habits/health/goals/tasks: keep yours; only take the file's if you have none
  // (merging them would pile up hidden duplicates nobody can see or delete)
  if (!out.legacy && incoming.legacy) out.legacy = JSON.parse(JSON.stringify(incoming.legacy));
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
    var old = legacyCount(state.legacy);
    if (!confirm('Delete ALL local data: transactions, budgets, wallet balances, repeating payments' + (old ? ' and ' + old + ' old habit/health/goal/task records from the earlier version' : '') +
      '? This cannot be undone.\n\nTip: Download a backup first.')) return;
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
      var old = legacyCount(d.legacy);
      $('#importSummary').textContent = 'Found ' + d.finance.length + ' transactions and ' + d.budgets.length + ' budgets' +
        (old ? ', plus ' + old + ' old habit/health/goal/task records' : '') +
        ' (v' + (obj.version || '?') + ', exported ' + (obj.exportDate || 'unknown date') + ').';
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
    var keepOld = state.legacy && !pendingImport.legacy;
    if (!confirm('Replace all transactions and budgets with the imported file?' +
      (state.legacy && pendingImport.legacy ? '\n\nYour old habit/health/goal/task data will also be replaced by the copy in the file.' : ''))) return;
    var oldLegacy = state.legacy;
    state = pendingImport;
    if (keepOld) state.legacy = oldLegacy; // the file has none: don't silently drop yours
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
  renderFinance(); renderWallets(); renderRecurring();
  renderBackupNudge(); updateStorageInfo();
}
// Installed apps stay open for days: when we come back after midnight,
// move "today" forward (default form date, current month).
function checkDayRollover() {
  var t = todayStr();
  if (t === renderedDay) return;
  var prev = renderedDay;
  if (!editingFinanceId && $('#finDate').value === prev) $('#finDate').value = t;
  if (financeMonth === monthKey(prev)) financeMonth = monthKey(t);
  renderAll();
}
document.addEventListener('DOMContentLoaded', function () {
  load();
  initTheme();
  initFinance(); initBudgets(); initWalletBalances(); initRecurring(); initDataButtons();
  initPWA();
  renderAll();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkDayRollover();
  });
  window.addEventListener('focus', checkDayRollover);
  setInterval(checkDayRollover, 60 * 1000);
});
