/*
 * EZDES UI. Holds state, wires controls, and renders whatever EzdesEngine.buildSchedule returns.
 * No scheduling logic lives here.
 */
(function () {
  'use strict';

  const E = window.EzdesEngine;
  const Store = window.EzdesStore;
  const $ = (selector) => document.querySelector(selector);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const hours = (minutes) => (minutes / 60).toFixed(2);

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  const DEFAULT_SETTINGS = {
    day: 'Monday', shiftHours: 8, startTime: '07:00', setupMinutes: 0, speedChangeMinutes: 2,
    fillShift: true, jobLimit: 7, dueWeight: 'normal', runningWeight: 'auto',
    clearDownPercent: 100, clearUpPercent: 50, lineLength: '', corePitch: '',
    breakMinutes: 0, imageChangeMinutes: 10, runOn: false, printActuals: false,
  };
  const copyRules = (rules) => rules.map((r) => ({ ...r }));
  // Keys typed by the user never become object-prototype names.
  const SAFE_KEY = (k) => typeof k === 'string' && !['__proto__', 'constructor', 'prototype'].includes(k);
  const SCORE_RANKS = [['0.5', 'h'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']];
  /** A full, editable copy of the day-score table: saved values where valid, defaults elsewhere. */
  const copyScores = (saved) => Object.fromEntries(E.DAYS.map((day) => [day, Object.fromEntries(SCORE_RANKS.map(([rank]) => {
    const v = Number(saved?.[day]?.[rank]);
    return [rank, saved?.[day]?.[rank] !== '' && saved?.[day]?.[rank] != null && Number.isFinite(v) ? v : E.DEFAULT_DAY_SCORES[day][rank]];
  }))]));
  /** Settings as restored from storage or a preset: the per-shift fields always start fresh. */
  const freshSettings = (saved) => {
    const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    return { ...s, planDate: nextDateFor(s.day), runningWeight: 'auto', rules: copyRules(s.rules || E.DEFAULT_RULES), dayScores: copyScores(s.dayScores), speedChangeMatrix: s.speedChangeMatrix && typeof s.speedChangeMatrix === 'object' ? JSON.parse(JSON.stringify(s.speedChangeMatrix)) : {} };
  };

  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /** The next date (today included) that falls on the given weekday name. */
  function nextDateFor(dayName) {
    const today = new Date();
    const target = E.DAYS.indexOf(dayName) + 1; // Monday = 1, like Date#getDay
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ((target - today.getDay() + 7) % 7));
    return isoDate(d);
  }

  function weekdayOf(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return E.DAYS[new Date(y, m - 1, d).getDay() - 1] ?? null; // null for weekends
  }

  const store = Store.load();
  const state = {
    // The production date and "on the machine now" are never restored from storage: they would be
    // stale. The date follows the chosen day; the machine defaults to where the previous plan ended.
    settings: freshSettings(store.settings),
    workbook: null,
    fileName: '',
    sheetName: '',
    sheet: null,           // { headerRow, headers, records }
    mapping: { copper: '', wo: '', tn: '', cores: '' },
    lines: [],
    manualOrder: null,     // line uids, or null for automatic order
    result: null,
    history: [],
    future: [],
    dragJob: null,
    noteJob: null,
  };

  const savedSettings = () => { const { planDate, runningWeight, ...rest } = state.settings; return JSON.parse(JSON.stringify(rest)); };
  const persist = debounce(() => { store.settings = savedSettings(); Store.save(store); }, 250);
  const orderKey = () => `${state.fileName}::${state.sheetName}`;
  const headerSignature = () => state.sheet.headers.join('\u0001');

  function setStatus(message, isError = false) {
    const el = $('#source-status');
    el.textContent = message;
    el.classList.toggle('is-error', isError);
  }

  /* ---------- schedule ---------- */

  const MAX_PLAN_ENDS = 30;

  /**
   * What is on the machine when this shift starts. "auto" means where the latest earlier plan in this
   * browser ended, which is right whenever the previous plan was followed.
   */
  function startingWeight() {
    const s = state.settings;
    if (s.runningWeight !== 'auto') return { weight: s.runningWeight, source: s.runningWeight ? 'manual' : 'cold' };
    const earlier = Object.keys(store.planEnds || {}).filter((d) => d < s.planDate).sort().pop();
    return earlier ? { weight: store.planEnds[earlier], source: 'previous', date: earlier } : { weight: '', source: 'none' };
  }

  /** Remembers the weight each production date's plan ends on, for the next day's starting point. */
  function recordPlanEnd(result) {
    const last = result.lines.at(-1);
    if (!last || !state.settings.planDate) return;
    store.planEnds = store.planEnds || {};
    if (store.planEnds[state.settings.planDate] === last.heavy) return;
    store.planEnds[state.settings.planDate] = last.heavy;
    const dates = Object.keys(store.planEnds).sort();
    for (const d of dates.slice(0, Math.max(0, dates.length - MAX_PLAN_ENDS))) delete store.planEnds[d];
    persist();
  }

  function recompute() {
    if (state.sheet && !state.mapping.copper) setStatus('Choose which column holds the Copperweight.', true);
    if (!state.sheet || !state.lines.length || !state.mapping.copper) {
      state.result = null;
    } else {
      state.start = startingWeight();
      state.result = E.buildSchedule(state.lines, { ...state.settings, runningWeight: state.start.weight }, {
        pins: store.pins, bottomImage: store.bottomImage, manualOrder: state.manualOrder, firstSeen: store.firstSeen, done: store.done, today: isoDate(new Date()),
      }, state.mapping);
      recordPlanEnd(state.result);
    }
    render();
  }
  const recomputeSoon = debounce(recompute, 150);

  function rebuildLines() {
    state.lines = state.sheet ? E.buildLines(state.sheet.records, state.mapping) : [];
    markSeen(state.lines);
    recompute();
  }

  const SEEN_KEEP_DAYS = 120;

  /**
   * Remembers the first day each job showed up in a workbook, so jobs that keep getting left out
   * earn waiting points. Jobs gone from the workbooks for months are forgotten.
   */
  function markSeen(lines) {
    if (!lines.length) return;
    if (!store.firstSeen || typeof store.firstSeen !== 'object') store.firstSeen = {}; // older store.js still cached
    const today = isoDate(new Date());
    const current = new Set(lines.map((l) => l.job));
    let changed = false;
    for (const job of current) {
      if (!store.firstSeen[job]) { store.firstSeen[job] = today; changed = true; }
    }
    const cutoff = isoDate(new Date(Date.now() - SEEN_KEEP_DAYS * 86400000));
    for (const [job, day] of Object.entries(store.firstSeen)) {
      if (!current.has(job) && day < cutoff) { delete store.firstSeen[job]; changed = true; }
    }
    // Done ticks follow a core by uid; those for cores gone from the workbooks for months are forgotten.
    store.done = store.done && typeof store.done === 'object' ? store.done : {};
    const uids = new Set(lines.map((l) => l.uid));
    for (const [uid, day] of Object.entries(store.done)) {
      if (!uids.has(uid) && day < cutoff) { delete store.done[uid]; changed = true; }
    }
    if (changed) Store.save(store);
  }

  /* ---------- undo / redo for plan edits (order, pins, notes, bottom image) ---------- */

  const snapshot = () => JSON.stringify({
    pins: store.pins, bottomImage: store.bottomImage, notes: store.notes, done: store.done, manualOrder: state.manualOrder,
  });

  function restore(json) {
    const s = JSON.parse(json);
    Object.assign(store, { pins: s.pins, bottomImage: s.bottomImage, notes: s.notes, done: s.done || {} });
    setManualOrder(s.manualOrder);
  }

  function setManualOrder(order) {
    state.manualOrder = order;
    const key = orderKey();
    delete store.orders[key];
    if (order) store.orders[key] = order;
    persist();
    recompute();
  }

  /** Every plan edit goes through here so it is undoable, saved, and re-rendered. */
  function commit(mutate) {
    state.history.push(snapshot());
    if (state.history.length > 50) state.history.shift();
    state.future = [];
    mutate();
    setManualOrder(state.manualOrder);
  }

  function undo() {
    if (!state.history.length) return;
    state.future.push(snapshot());
    restore(state.history.pop());
  }

  function redo() {
    if (!state.future.length) return;
    state.history.push(snapshot());
    restore(state.future.pop());
  }

  /* ---------- job moves ---------- */

  function moveJob(sourceJob, targetJob, after) {
    if (!state.result || !sourceJob || !targetJob || sourceJob === targetJob) return;
    const lines = state.result.lines;
    const moving = lines.filter((l) => l.job === sourceJob);
    const rest = lines.filter((l) => l.job !== sourceJob);
    let at = rest.findIndex((l) => l.job === targetJob);
    if (at < 0) return;
    if (after) while (at < rest.length && rest[at].job === targetJob) at++;
    rest.splice(at, 0, ...moving);
    commit(() => { state.manualOrder = rest.map((l) => l.uid); });
    focusJob(sourceJob);
  }

  function moveJobBy(job, direction) {
    const order = state.result.jobOrder;
    const to = order.indexOf(job) + direction;
    if (to < 0 || to >= order.length) return;
    moveJob(job, order[to], direction > 0);
  }

  function focusJob(job) {
    const row = [...document.querySelectorAll('#tbody tr[data-job]')].find((tr) => tr.dataset.job === job);
    row?.focus();
  }

  /* ---------- workbook loading ---------- */

  // Converting a sheet to rows is the slowest part of loading; each sheet is converted once per workbook.
  const matrixCache = new Map();
  function readMatrix(name) {
    if (matrixCache.has(name)) return matrixCache.get(name);
    const ws = state.workbook.Sheets[name];
    const offset = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
    const read = { matrix: XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }), offset };
    matrixCache.set(name, read);
    return read;
  }

  function loadWorkbook(buffer, fileName) {
    if (!window.XLSX) {
      setStatus('The Excel reader did not load. Check that web/vendor/xlsx.full.min.js exists.', true);
      return;
    }
    try {
      // Only cell values are used: skip formulas' HTML, styles and macros to keep parsing minimal.
      state.workbook = XLSX.read(buffer, { type: 'array', cellHTML: false, cellStyles: false, bookVBA: false });
    } catch (error) {
      setStatus(`Could not read ${fileName}: ${error.message}`, true);
      return;
    }
    state.fileName = fileName;
    matrixCache.clear();
    const names = state.workbook.SheetNames;
    $('#sheet').innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    $('#sheet-row').hidden = names.length < 2;
    // Open the first sheet that actually has a Copperweight header, not just the first sheet.
    const usable = names.find((n) => { const { matrix } = readMatrix(n); return E.parseSheet(matrix); });
    selectSheet(usable ?? names[0]);
  }

  function selectSheet(name) {
    state.sheetName = name;
    $('#sheet').value = name;
    const { matrix, offset } = readMatrix(name);
    state.sheet = E.parseSheet(matrix, offset);
    state.history = [];
    state.future = [];

    if (!state.sheet) {
      $('#mapping-card').hidden = true;
      setStatus(`No Copperweight column header found in “${name}”.`, true);
      rebuildLines();
      return;
    }

    const remembered = store.mappings[headerSignature()] || {};
    const auto = E.autoMap(state.sheet.headers);
    state.mapping = {};
    for (const key of Object.keys(E.FIELDS)) {
      state.mapping[key] = state.sheet.headers.includes(remembered[key]) ? remembered[key] : auto[key];
    }
    state.manualOrder = store.orders[orderKey()] || null;
    renderMapping();
    setStatus(`${state.fileName} · ${name}: ${plural(state.sheet.records.length, 'line')}, headers on row ${state.sheet.headerRow}.`);
    rebuildLines();
  }

  const MAX_WORKBOOK_BYTES = 50 * 1024 * 1024;

  function loadFile(file) {
    if (!file) return;
    if (file.size > MAX_WORKBOOK_BYTES) {
      setStatus(`${file.name} is larger than 50 MB; that is not a production workbook.`, true);
      return;
    }
    setStatus(`Reading ${file.name}…`);
    file.arrayBuffer().then((buffer) => loadWorkbook(buffer, file.name))
      .catch((error) => setStatus(`Could not read ${file.name}: ${error.message}`, true));
  }

  /* Shared-folder support is only available when served by server.py. */
  async function detectServer() {
    if (!location.protocol.startsWith('http')) return;
    try {
      const response = await fetch('api/files', { cache: 'no-store' });
      if (!response.ok) return;
      const { files } = await response.json();
      $('#server-source').hidden = false;
      const latest = files[0];
      $('#load-latest').disabled = !latest;
      $('#load-latest').dataset.name = latest?.name || '';
      $('#server-latest').textContent = latest
        ? `Newest: ${latest.name} (${new Date(latest.modified * 1000).toLocaleString()})`
        : 'The shared folder has no workbooks yet.';
    } catch {
      /* Not running behind the EZDES server — local file picking still works. */
    }
  }

  async function loadLatest() {
    await detectServer();
    const name = $('#load-latest').dataset.name;
    if (!name) return;
    setStatus(`Downloading ${name}…`);
    try {
      const response = await fetch(`api/files/${encodeURIComponent(name)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
      loadWorkbook(await response.arrayBuffer(), name);
    } catch (error) {
      setStatus(`Could not load ${name}: ${error.message}`, true);
    }
  }

  /* ---------- rendering: setup panel ---------- */

  function renderMapping() {
    $('#mapping-card').hidden = !state.sheet;
    if (!state.sheet) return;
    $('#mapping').innerHTML = Object.entries(E.FIELDS).map(([key, field]) => `
      <label class="field">${esc(field.label)}${field.required ? ' *' : ''}
        <select data-field="${key}">
          <option value="">${field.required ? 'Choose a column' : 'Not used'}</option>
          ${state.sheet.headers.map((h) => `<option value="${esc(h)}" ${state.mapping[key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}
        </select>
      </label>`).join('');
  }

  function renderSettings() {
    const s = state.settings;
    $('#days').innerHTML = E.DAYS.map((day) => `<button type="button" role="radio" data-day="${day}"
      aria-checked="${s.day === day}" class="${s.day === day ? 'is-on' : ''}" title="${day}">${day.slice(0, 3)}</button>`).join('');
    for (const input of document.querySelectorAll('[data-setting]')) {
      const value = s[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = value ?? '';
    }
    $('#planDate').value = s.planDate;
    for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = (radio.value === 'fill') === s.fillShift;
    $('#jobLimit').disabled = s.fillShift;
    renderRules();
    renderDayScores();
  }

  function renderRules() {
    // With a measured line length or core pitch, those columns are computed from the speed instead.
    const resolved = new Map(E.resolveRules(state.settings).map((r) => [r.weight, r]));
    const fmt = (n) => (Number.isFinite(n) ? Number(n.toFixed(1)) : '');
    $('#rules').innerHTML = state.settings.rules.map((r, i) => {
      const live = resolved.get(String(r.weight ?? '').trim().toLowerCase());
      const first = live?.derivedFirst ? `<input value="${fmt(live.firstMinutes)}" readonly title="Line length ÷ speed" aria-label="First core minutes for ${esc(r.weight)} (computed)">`
        : `<input data-rule="${i}" data-key="firstMinutes" type="number" min="0" step="0.1" value="${esc(r.firstMinutes)}" aria-label="First core minutes for ${esc(r.weight)}">`;
      const next = live?.derivedNext ? `<input value="${fmt(live.nextSeconds)}" readonly title="Core pitch ÷ speed" aria-label="Next core seconds for ${esc(r.weight)} (computed)">`
        : `<input data-rule="${i}" data-key="nextSeconds" type="number" min="0" step="0.1" value="${esc(r.nextSeconds)}" aria-label="Next core seconds for ${esc(r.weight)}">`;
      return `
      <tr>
        <td><input data-rule="${i}" data-key="weight" value="${esc(r.weight)}" aria-label="Weight"></td>
        <td><input data-rule="${i}" data-key="speed" type="number" min="0" value="${esc(r.speed)}" aria-label="Target speed for ${esc(r.weight)}"></td>
        <td>${first}</td>
        <td>${next}</td>
        <td><button type="button" class="icon" data-remove-rule="${i}" aria-label="Remove ${esc(r.weight)}">✕</button></td>
      </tr>`;
    }).join('');
    renderRunningWeight();
    renderSpeedMatrix();
  }

  /** "On the machine now" offers the weights that have rules; a weight that disappears falls back to cold start. */
  function renderRunningWeight() {
    const weights = [...new Set(state.settings.rules.map((r) => String(r.weight ?? '').trim().toLowerCase()).filter(Boolean))];
    const value = state.settings.runningWeight;
    if (value !== 'auto' && value !== '' && !weights.includes(value)) state.settings.runningWeight = 'auto';
    $('#runningWeight').innerHTML = `<option value="auto" title="Where the latest earlier plan in this browser ended">Auto (previous plan)</option>
      <option value="">Nothing (cold start)</option>${weights.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join('')}`;
    $('#runningWeight').value = state.settings.runningWeight;
  }

  /** From -> to grid of speed-setting-change minutes by weight; blank cells use the single default. */
  function renderSpeedMatrix() {
    const weights = E.resolveRules(state.settings).map((r) => r.weight);
    const m = state.settings.speedChangeMatrix || {};
    const def = state.settings.speedChangeMinutes;
    $('#speed-matrix').innerHTML = `
      <thead><tr><th>From \u2193 to \u2192</th>${weights.map((w) => `<th>${esc(w)}</th>`).join('')}</tr></thead>
      <tbody>${weights.map((from) => `<tr><th scope="row">${esc(from)}</th>${weights.map((to) => from === to ? '<td class="hint">\u2014</td>' : `
        <td><input type="number" min="0" step="0.5" data-from="${esc(from)}" data-to="${esc(to)}" value="${esc(m[from]?.[to] ?? '')}" placeholder="${esc(def)}" aria-label="Minutes to change the setting from ${esc(from)} to ${esc(to)}"></td>`).join('')}</tr>`).join('')}
      </tbody>`;
  }

  function renderDayScores() {
    const s = state.settings;
    $('#day-scores').innerHTML = `
      <thead><tr><th>Day</th>${SCORE_RANKS.map(([, label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead>
      <tbody>${E.DAYS.map((day) => `<tr class="${day === s.day ? 'is-today' : ''}"><th scope="row">${day.slice(0, 3)}</th>${SCORE_RANKS.map(([rank, label]) => `
        <td><input type="number" step="5" data-score-day="${day}" data-score-rank="${rank}" value="${esc(s.dayScores[day][rank])}" aria-label="${day} score for weight ${esc(label)}"></td>`).join('')}</tr>`).join('')}
      </tbody>`;
  }

  function renderPresets() {
    const names = Object.keys(store.presets).sort((a, b) => a.localeCompare(b));
    $('#presets').innerHTML = names.length ? names.map((n) => `
      <li><span title="${esc(n)}">${esc(n)}</span>
        <button type="button" data-preset-load="${esc(n)}">Load</button>
        <button type="button" class="icon" data-preset-delete="${esc(n)}" aria-label="Delete ${esc(n)}">✕</button></li>`).join('')
      : '<li class="hint">No presets saved.</li>';
  }

  /* ---------- rendering: board ---------- */

  function render() {
    const result = state.result;
    $('#empty').hidden = Boolean(result);
    $('#board').hidden = !result;
    $('#undo').disabled = !state.history.length;
    $('#redo').disabled = !state.future.length;
    $('#reset-order').disabled = !state.manualOrder;
    if (!result) return;
    renderStartNote();
    renderSummary(result);
    renderChecks(result.checks);
    renderTable(result);
  }

  /** Says, above the plan, what the shift assumes is on the machine, because it changes the plan. */
  function renderStartNote() {
    const st = state.start || { source: 'none' };
    const known = st.weight && state.settings.rules.some((r) => String(r.weight).toLowerCase() === st.weight);
    let text;
    if (st.source === 'previous' && known) text = `Starts on weight <b>${esc(st.weight)}</b>, where the plan for ${esc(E.formatDay(E.parseDueDate(st.date)))} ended.`;
    else if (st.source === 'manual' && known) text = `Starts on weight <b>${esc(st.weight)}</b> (set by hand).`;
    else if (st.source === 'cold') text = 'Starts from an empty machine (cold start, set by hand).';
    else text = 'Starts from an empty machine: no earlier plan in this browser.';
    $('#start-note').innerHTML = `${text} <button type="button" class="link" id="start-change">Change</button>`;
  }

  function renderSummary({ stats }) {
    const s = state.settings;
    const over = stats.overMinutes > 0;
    const fill = stats.capacityMinutes ? Math.min(100, (stats.plannedMinutes / stats.capacityMinutes) * 100) : 100;
    const unscheduled = stats.totalJobs - stats.scheduledJobs;
    const blocked = stats.blockedJobs.length;
    const mix = stats.weightMix.map((w) => `<span>${esc(w.copper)}: <b>${w.lines}</b>${w.coresKnown ? ` / ${w.cores} cores` : ''}</span>`).join('');

    $('#print-title').textContent = `EZDES schedule · ${s.day} · ${state.fileName}`;
    $('#summary').innerHTML = `
      <div class="stat ${over ? 'over' : ''}">
        <div class="label">Planned</div>
        <div class="value">${hours(stats.plannedMinutes)} h</div>
        <div class="sub">of ${hours(stats.capacityMinutes)} h${stats.breakMinutes ? ` (after ${Math.round(stats.breakMinutes)} min breaks)` : ''}${over ? ` · ${hours(stats.overMinutes)} h over` : ''}</div>
        ${stats.runOnJob ? `<div class="sub">${esc(stats.runOnJob)} runs ${Math.round(stats.runOnMinutes)} min into the next shift</div>` : ''}
        <div class="meter"><span style="width:${fill}%"></span></div>
      </div>
      <div class="stat">
        <div class="label">Estimated finish</div>
        <div class="value">${E.formatClock(s.startTime, stats.plannedMinutes)}</div>
        <div class="sub">from ${E.formatClock(s.startTime, 0)}</div>
      </div>
      <div class="stat">
        <div class="label">Jobs</div>
        <div class="value">${stats.scheduledJobs} <span class="sub">of ${stats.totalJobs}</span></div>
        <div class="sub">${plural(state.result.lines.length, 'line')}${unscheduled - blocked ? ` · ${unscheduled - blocked} left${s.fillShift ? ' (don’t fit)' : ''}` : ''}</div>
        ${blocked ? `<div class="sub alert" title="${esc(stats.blockedJobs.join(', '))}">${plural(blocked, 'job')} held back (no rule)</div>` : ''}
      </div>
      <div class="stat">
        <div class="label">Changes</div>
        <div class="value">${stats.configChanges} <span class="sub">weight</span> · ${stats.speedChanges} <span class="sub">speed</span></div>
        <div class="sub">${stats.savedMinutes >= 0.5 ? `Ordering saved ${Math.round(stats.savedMinutes)} min vs day order` : state.manualOrder ? 'Manual order' : 'Day order is already best'}</div>
      </div>
      ${renderDueStat(stats.due)}
      <div class="stat wide">
        <div class="label">Weight mix (lines${stats.weightMix.some((w) => w.coresKnown) ? ' / cores' : ''})</div>
        <div class="mix">${mix || '—'}</div>
      </div>`;
  }

  function renderDueStat(due) {
    if (!state.mapping.due || !due.jobsWithDates) return '';
    const left = due.urgentLeftOut;
    const off = state.settings.dueWeight === 'off';
    return `
      <div class="stat ${left.length ? 'warn' : ''}">
        <div class="label">Due by ${due.planDay != null ? esc(E.formatDay(due.planDay)) : 'production date'}${off ? ' (ignored)' : ''}</div>
        <div class="value">${due.overdueScheduled + due.dueTodayScheduled} <span class="sub">scheduled</span></div>
        <div class="sub">${due.overdueScheduled} overdue · ${due.dueTodayScheduled} due that day</div>
        ${left.length ? `<div class="sub alert" title="${esc(left.join(', '))}">${plural(left.length, 'urgent job')} not in this shift</div>` : ''}
      </div>`;
  }

  function dueChip(line) {
    // The engine decides urgency in production days and accounts for long jobs; the chip just shows it.
    if (!line.dueKind) return '';
    const title = line.shiftsNeeded > 1 ? ` title="Needs about ${line.shiftsNeeded} shifts"` : '';
    return `<span class="due-chip ${line.dueKind}"${title}>${esc(line.dueLabel)}</span>`;
  }

  function renderChecks(checks) {
    const el = $('#checks');
    const errors = checks.filter((c) => c.level === 'error').length;
    const warnings = checks.filter((c) => c.level === 'warning').length;
    const notes = checks.length - errors - warnings;
    el.classList.toggle('has-errors', errors > 0);
    if (errors) el.open = true;
    el.querySelector('summary').innerHTML = errors || warnings
      ? `Data checks: ${errors ? `<span class="error-text">${plural(errors, 'error')}</span>` : '0 errors'} · ${plural(warnings, 'warning')}${notes ? ` · ${plural(notes, 'note')}` : ''}`
      : notes ? `<span class="ok-text">Data checks: no issues</span> · ${plural(notes, 'note')}`
      : '<span class="ok-text">Data checks: no issues found</span>';
    el.querySelector('ul').innerHTML = checks.map((c) => `<li class="${c.level}">${esc(c.text)}</li>`).join('');
  }

  function renderTable(result) {
    const headers = state.sheet.headers;
    const hasMixed = result.lines.some((l) => l.mixed);
    const jobIndex = new Map(result.jobOrder.map((job, i) => [job, i]));
    const notePrinted = new Set();
    const printActuals = Boolean(state.settings.printActuals);
    const columnCount = headers.length + 11 + (hasMixed ? 1 : 0) + (printActuals ? 1 : 0);

    $('#thead').innerHTML = `<tr>
      <th class="screen-only"><span class="visually-hidden">Drag</span></th>
      <th class="num">#</th><th>Job</th>
      ${headers.map((h) => `<th>${esc(h)}</th>`).join('')}
      <th class="num" title="Speed the line runs at for this core">Run at</th>
      <th class="num screen-only">Load min</th>
      <th class="num" title="When the first core of this line goes on">Load</th>
      <th class="num" title="When the last core of this line comes out">Out</th>
      ${printActuals ? '<th class="print-only actual">Actual</th>' : ''}
      ${hasMixed ? '<th class="screen-only">Bottom</th>' : ''}
      <th class="screen-only">Why here</th>
      <th class="screen-only">Done</th>
      <th class="screen-only"><span class="visually-hidden">Actions</span></th>
    </tr>`;

    const start = state.settings.startTime;
    $('#tbody').innerHTML = result.lines.map((l) => {
      const job = esc(l.job);
      const note = store.notes[l.job] || '';
      const classes = [jobIndex.get(l.job) % 2 ? 'alt' : '', l.jobEnd ? 'job-end' : '', l.runOn ? 'run-on' : ''].join(' ');
      const actions = l.jobStart ? `
        <button type="button" class="icon ${l.pinned ? 'is-on' : ''}" data-action="pin" aria-pressed="${l.pinned}" title="Pin to the top">${l.pinned ? 'Pinned' : 'Pin'}</button>
        <button type="button" class="icon ${note ? 'has-note' : ''}" data-action="note" title="${note ? esc(note) : 'Add a note'}">Note${note ? ' •' : ''}</button>
        <button type="button" class="icon" data-action="up" aria-label="Move ${job} up">↑</button>
        <button type="button" class="icon" data-action="down" aria-label="Move ${job} down">↓</button>` : '';
      const bottom = hasMixed ? `<td class="screen-only">${l.mixed ? `
        <select data-bottom aria-label="Bottom for ${job} line ${l.position}">
          <option value="" ${l.bottomImage ? '' : 'selected'}>Clear</option>
          <option value="image" ${l.bottomImage ? 'selected' : ''}>Bottom image</option>
        </select>` : ''}</td>` : '';

      let row = `<tr class="${classes}" data-job="${job}" data-uid="${esc(l.uid)}" draggable="true" tabindex="0" aria-label="${job}, line ${l.position}">
        <td class="handle screen-only" aria-hidden="true">⠿</td>
        <td class="num">${l.position}</td>
        <td class="job">${l.jobStart ? `${job}${l.pinned ? '<span class="badge">Pinned</span>' : ''}${l.runOn ? '<span class="badge run-on">Next shift</span>' : ''}${dueChip(l)}` : ''}</td>
        ${headers.map((h) => `<td>${esc(l.values[h])}</td>`).join('')}
        <td class="num">${esc(l.targetSpeed ?? '—')}</td>
        <td class="num screen-only">${l.minutes.toFixed(1)}</td>
        <td class="num">${E.formatClock(start, l.startMinute)}</td>
        <td class="num">${E.formatClock(start, l.outMinute)}</td>
        ${printActuals ? '<td class="print-only actual"></td>' : ''}
        ${bottom}
        <td class="why screen-only">${esc(E.explain(l))}</td>
        <td class="screen-only"><input type="checkbox" data-done aria-label="Mark ${job} line ${l.position} as done"></td>
        <td class="actions screen-only">${actions}</td>
      </tr>`;
      if (note && !notePrinted.has(l.job)) {
        notePrinted.add(l.job);
        row += `<tr class="print-only note-row" data-job="${job}"><td colspan="${columnCount}"><b>Note — ${job}:</b> ${esc(note)}</td></tr>`;
      }
      return row;
    }).join('');
    // Cores already run: listed under the plan so they can be un-ticked.
    if (result.doneLines.length) {
      const span = headers.length + 3;
      $('#tbody').insertAdjacentHTML('beforeend', `<tr class="done-head screen-only"><td colspan="${columnCount}">Done · ${plural(result.doneLines.length, 'core')} left out of the plan</td></tr>`
        + result.doneLines.map((l) => `<tr class="done screen-only" data-job="${esc(l.job)}" data-uid="${esc(l.uid)}">
          <td></td><td class="num">—</td><td class="job">${esc(l.job)}</td>
          ${headers.map((h) => `<td>${esc(l.values[h])}</td>`).join('')}
          <td colspan="${columnCount - span - 2}" class="hint">done on ${esc(store.done[l.uid] || '')}</td>
          <td><input type="checkbox" data-done checked aria-label="Put ${esc(l.job)} back into the plan"></td><td></td>
        </tr>`).join(''));
    }
    applyFilter();
  }

  function applyFilter() {
    const query = $('#search').value.trim().toLowerCase();
    const matching = new Set();
    if (query && state.result) {
      for (const l of state.result.lines) {
        const text = [l.job, ...Object.values(l.values)].join(' ').toLowerCase();
        if (text.includes(query)) matching.add(l.job);
      }
    }
    for (const tr of document.querySelectorAll('#tbody tr[data-job]')) tr.hidden = Boolean(query) && !matching.has(tr.dataset.job);
  }

  /* ---------- export / print ---------- */

  function exportExcel() {
    const rows = E.exportRows(state.result, state.sheet.headers, store.notes, state.settings.startTime);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Schedule');
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `ezdes-schedule-${date}-${state.settings.day.toLowerCase()}.xlsx`);
  }

  /* ---------- events ---------- */

  function updateSetting(key, value) {
    state.settings[key] = value;
    persist();
    recomputeSoon();
  }

  function wire() {
    $('#help-open').addEventListener('click', () => $('#help-dialog').showModal());
    $('#file').addEventListener('change', (e) => loadFile(e.target.files[0]));
    $('#sheet').addEventListener('change', (e) => selectSheet(e.target.value));
    $('#load-latest').addEventListener('click', loadLatest);

    const drop = $('#drop-zone');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); loadFile(e.dataTransfer.files[0]); });

    $('#mapping').addEventListener('change', (e) => {
      const key = e.target.dataset.field;
      if (!key) return;
      state.mapping[key] = e.target.value;
      store.mappings[headerSignature()] = { ...state.mapping };
      persist();
      rebuildLines();
    });

    $('#days').addEventListener('click', (e) => {
      const day = e.target.closest('[data-day]')?.dataset.day;
      if (!day) return;
      state.settings.day = day;
      state.settings.planDate = nextDateFor(day);
      state.settings.runningWeight = 'auto';
      // A new day means a new automatic order; pins are kept.
      setManualOrder(null);
      renderSettings();
    });

    for (const input of document.querySelectorAll('[data-setting]')) {
      input.addEventListener('input', () => {
        const key = input.dataset.setting;
        const value = input.type === 'checkbox' ? input.checked
          : input.type === 'number' ? (input.value === '' ? '' : Number(input.value))
          : input.value;
        updateSetting(key, value);
        // Line length and core pitch change which rule cells are typed and which are computed.
        if (key === 'lineLength' || key === 'corePitch') renderRules();
        if (key === 'speedChangeMinutes') renderSpeedMatrix();
        if (key === 'printActuals') render();
      });
    }
    $('#planDate').addEventListener('change', (e) => {
      if (!e.target.value) { e.target.value = state.settings.planDate; return; }
      state.settings.planDate = e.target.value;
      // Another date means another starting point on the machine.
      state.settings.runningWeight = 'auto';
      renderRunningWeight();
      const weekday = weekdayOf(e.target.value);
      if (weekday && weekday !== state.settings.day) {
        // Picking a date on another weekday switches the day too, which starts a fresh automatic order.
        state.settings.day = weekday;
        persist();
        renderSettings();
        setManualOrder(null);
      } else {
        recompute();
      }
    });
    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener('change', () => {
        state.settings.fillShift = radio.value === 'fill';
        $('#jobLimit').disabled = state.settings.fillShift;
        setManualOrder(null);
      });
    }

    $('#rules').addEventListener('input', (e) => {
      const i = e.target.dataset.rule;
      if (i === undefined) return;
      const key = e.target.dataset.key;
      state.settings.rules[i][key] = key === 'weight' ? e.target.value.trim().toLowerCase() : Number(e.target.value);
      if (key === 'weight') renderRunningWeight();
      persist();
      recomputeSoon();
    });
    $('#rules').addEventListener('click', (e) => {
      const i = e.target.closest('[data-remove-rule]')?.dataset.removeRule;
      if (i === undefined) return;
      state.settings.rules.splice(Number(i), 1);
      renderRules();
      persist();
      recompute();
    });
    $('#add-rule').addEventListener('click', () => {
      state.settings.rules.push({ weight: '', speed: 0, firstMinutes: 0, nextSeconds: 0 });
      renderRules();
      $('#rules tr:last-child input').focus();
    });
    $('#reset-rules').addEventListener('click', () => {
      state.settings.rules = copyRules(E.DEFAULT_RULES);
      renderRules();
      persist();
      recompute();
    });

    $('#speed-matrix').addEventListener('input', (e) => {
      const { from, to } = e.target.dataset;
      if (!from || !SAFE_KEY(from) || !SAFE_KEY(to)) return;
      const m = state.settings.speedChangeMatrix = state.settings.speedChangeMatrix || {};
      m[from] = m[from] || {};
      if (e.target.value === '') delete m[from][to]; else m[from][to] = Number(e.target.value);
      if (!Object.keys(m[from]).length) delete m[from];
      persist();
      recomputeSoon();
    });
    $('#clear-speed-matrix').addEventListener('click', () => {
      state.settings.speedChangeMatrix = {};
      renderSpeedMatrix();
      persist();
      recompute();
    });
    $('#day-scores').addEventListener('input', (e) => {
      const { scoreDay, scoreRank } = e.target.dataset;
      if (!scoreDay) return;
      // An empty box falls back to the default score for that cell.
      state.settings.dayScores[scoreDay][scoreRank] = e.target.value === '' ? '' : Number(e.target.value);
      persist();
      recomputeSoon();
    });
    $('#reset-day-scores').addEventListener('click', () => {
      state.settings.dayScores = copyScores(null);
      renderDayScores();
      persist();
      recompute();
    });
    $('#start-note').addEventListener('click', (e) => {
      if (!e.target.closest('#start-change')) return;
      const select = $('#runningWeight');
      select.scrollIntoView({ block: 'center' });
      select.focus();
    });

    $('#preset-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#preset-name').value.trim();
      if (!name) return;
      store.presets[name] = { settings: savedSettings(), mapping: { ...state.mapping } };
      Store.save(store);
      $('#preset-name').value = '';
      renderPresets();
    });
    $('#presets').addEventListener('click', (e) => {
      const load = e.target.closest('[data-preset-load]')?.dataset.presetLoad;
      const remove = e.target.closest('[data-preset-delete]')?.dataset.presetDelete;
      if (remove !== undefined) {
        delete store.presets[remove];
        Store.save(store);
        renderPresets();
      }
      if (load !== undefined && store.presets[load]) {
        const preset = store.presets[load];
        state.settings = freshSettings(preset.settings);
        if (state.sheet) {
          for (const [key, column] of Object.entries(preset.mapping || {})) {
            if (column && state.sheet.headers.includes(column)) state.mapping[key] = column;
          }
          renderMapping();
        }
        persist();
        renderSettings();
        state.manualOrder = null;
        rebuildLines();
      }
    });

    $('#search').addEventListener('input', applyFilter);
    $('#undo').addEventListener('click', undo);
    $('#redo').addEventListener('click', redo);
    $('#reset-order').addEventListener('click', () => commit(() => { state.manualOrder = null; }));
    $('#print').addEventListener('click', () => window.print());
    $('#export').addEventListener('click', exportExcel);
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.target.matches('input, textarea, select')) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    });

    wireTable();
    wireNoteDialog();
  }

  function wireTable() {
    const body = $('#tbody');

    body.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-action]');
      if (!button) return;
      const job = button.closest('tr').dataset.job;
      const action = button.dataset.action;
      if (action === 'up' || action === 'down') moveJobBy(job, action === 'up' ? -1 : 1);
      if (action === 'note') openNote(job);
      if (action === 'pin') {
        commit(() => {
          store.pins = store.pins.includes(job) ? store.pins.filter((j) => j !== job) : [...store.pins, job];
        });
      }
    });

    body.addEventListener('change', (e) => {
      const uid = e.target.closest('tr')?.dataset.uid;
      if (!uid) return;
      if (e.target.matches('input[data-done]')) {
        commit(() => {
          const done = { ...(store.done || {}) };
          if (e.target.checked) done[uid] = isoDate(new Date()); else delete done[uid];
          store.done = done;
        });
      }
      if (!e.target.matches('select[data-bottom]')) return;
      commit(() => {
        const set = new Set(store.bottomImage);
        if (e.target.value === 'image') set.add(uid); else set.delete(uid);
        store.bottomImage = [...set];
      });
    });

    body.addEventListener('keydown', (e) => {
      const tr = e.target;
      if (!tr.matches?.('tr[data-job]') || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      moveJobBy(tr.dataset.job, e.key === 'ArrowUp' ? -1 : 1);
    });

    const clearDrop = () => body.querySelectorAll('.drop-before, .drop-after').forEach((tr) => tr.classList.remove('drop-before', 'drop-after'));
    body.addEventListener('dragstart', (e) => {
      const tr = e.target.closest?.('tr[data-job]');
      if (!tr) return;
      state.dragJob = tr.dataset.job;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', state.dragJob);
    });
    body.addEventListener('dragover', (e) => {
      const tr = e.target.closest('tr[data-job]');
      if (!tr || !state.dragJob) return;
      e.preventDefault();
      clearDrop();
      if (tr.dataset.job === state.dragJob) return;
      const box = tr.getBoundingClientRect();
      tr.classList.add(e.clientY > box.top + box.height / 2 ? 'drop-after' : 'drop-before');
    });
    body.addEventListener('drop', (e) => {
      const tr = e.target.closest('tr[data-job]');
      if (!tr || !state.dragJob) return;
      e.preventDefault();
      const after = tr.classList.contains('drop-after');
      const source = state.dragJob;
      clearDrop();
      state.dragJob = null;
      moveJob(source, tr.dataset.job, after);
    });
    body.addEventListener('dragend', () => {
      state.dragJob = null;
      clearDrop();
      body.querySelectorAll('.dragging').forEach((tr) => tr.classList.remove('dragging'));
    });
  }

  function openNote(job) {
    state.noteJob = job;
    $('#note-title').textContent = `Note for ${job}`;
    $('#note-text').value = store.notes[job] || '';
    $('#note-dialog').showModal();
  }

  function wireNoteDialog() {
    $('#note-dialog').addEventListener('close', () => {
      const job = state.noteJob;
      state.noteJob = null;
      if ($('#note-dialog').returnValue !== 'save' || !job) return;
      const text = $('#note-text').value.trim();
      if (text === (store.notes[job] || '')) return;
      commit(() => {
        if (text) store.notes[job] = text; else delete store.notes[job];
      });
    });
  }

  /* ---------- boot ---------- */

  wire();
  renderSettings();
  renderPresets();
  render();
  detectServer();
})();
