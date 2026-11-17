/*
 * EZDES scheduling engine.
 *
 * Pure functions only: no DOM, no storage, no globals beyond the exported namespace.
 * Everything the UI shows is derived from buildSchedule(lines, settings, plan).
 *
 * Loaded as a classic script (not an ES module) so index.html keeps working when it is
 * opened straight from disk, where browsers refuse to load modules.
 */
(function (root) {
  'use strict';

  // Saturday is an occasional extra; due dates still count Mon–Fri as production days.
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const DEFAULT_RULES = [
    { weight: 'h', speed: 80, firstMinutes: 5, nextSeconds: 12.5 },
    { weight: '1', speed: 45, firstMinutes: 15, nextSeconds: 15 },
    { weight: '2', speed: 24, firstMinutes: 20, nextSeconds: 50 },
    { weight: '3', speed: 15, firstMinutes: 25, nextSeconds: 90 },
    { weight: '4', speed: 10, firstMinutes: 30, nextSeconds: 150 },
  ];

  // How much each day favours each weight rank ('h' is rank 0.5). Monday leans light, Friday heavy.
  // These are the defaults; settings.dayScores (edited in the app) replaces them.
  const DAY_SCORES = {
    Monday: { 0.5: 100, 1: 80, 2: 60, 3: 40, 4: 20 },
    Tuesday: { 0.5: 80, 1: 100, 2: 70, 3: 45, 4: 20 },
    Wednesday: { 0.5: 45, 1: 80, 2: 100, 3: 100, 4: 60 },
    Thursday: { 0.5: 15, 1: 45, 2: 75, 3: 100, 4: 90 },
    Friday: { 0.5: 10, 1: 30, 2: 60, 3: 85, 4: 100 },
    Saturday: { 0.5: 10, 1: 30, 2: 60, 3: 85, 4: 100 },
  };

  // Only columns the engine actually uses are mapped. Every other column is still shown and exported.
  const FIELDS = {
    copper: { label: 'Copperweight', required: true, aliases: ['copperweight', 'copperwt', 'copper'] },
    wo: { label: 'Work order (WO)', aliases: ['wo', 'workorder', 'workordernumber'] },
    tn: { label: 'Ticket / job number (TN)', aliases: ['tn', 'ticketnumber', 'jobnumber'] },
    cores: { label: 'Number of cores', aliases: ['cores', 'corecount', 'numberofcores'] },
    due: { label: 'Due date', aliases: ['duedate', 'due', 'requiredby', 'requireddate', 'shipdate', 'date'] },
    // Not used for timing (the rules decide the speed); only checked against the rules.
    speed: { label: 'Speed (own speed for a job, if it differs)', aliases: ['speed', 'targetspeed', 'linespeed'] },
  };

  // Urgency points by production days (Mon–Fri) until a job's earliest due date, after taking off the
  // extra shifts a long job needs (slack), so "due next work day, needs 2 shifts" scores as due today.
  // Day scores differ by at most 90 between weights, so +100 means an overdue job always beats the
  // day's weight preference when the shift is picked.
  const URGENCY_STEPS = [
    { maxDays: -1, points: 100, label: (d) => `overdue ${-d}d` },
    { maxDays: 0, points: 80, label: () => 'due today' },
    { maxDays: 1, points: 50, label: () => 'due tomorrow' },
    { maxDays: 3, points: 25, label: (d) => `due in ${d}d` },
    { maxDays: 7, points: 10, label: (d) => `due in ${d}d` },
  ];
  const DUE_WEIGHTS = { off: 0, normal: 1, strong: 2 };

  // The day score (plus due dates and waiting time) decides WHICH jobs make the shift. The ORDER
  // inside the shift is the fastest one, except that jobs due today or overdue shouldn't wait: each
  // hour such a job waits costs its urgency points in minutes (an overdue job, +100, waiting an hour
  // costs 100 min), so it only runs later when the time saved is clearly worth it.
  const DUE_DELAY_MINUTES_PER_POINT_HOUR = 1;
  // Waiting: every production day since a job first showed up in a workbook adds points, so light
  // work squeezed out late in the week still gets in. Capped at the overdue level.
  const AGING_POINTS_PER_DAY = 10;
  const AGING_POINTS_CAP = 100;
  // Up to this many weight blocks every order is tried (7! = 5040); above it, a local search is used.
  const EXHAUSTIVE_BLOCK_LIMIT = 7;
  // While filling the shift, a job that misses by at most this many minutes under the reused order
  // gets a full re-search, at most this many times per rebuild.
  const NEAR_MISS_MINUTES = 10;
  const NEAR_MISS_FULL_SEARCHES = 4;

  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function parseNumber(value) {
    const text = String(value ?? '').replace(/,/g, '').trim();
    return text === '' ? NaN : Number(text);
  }

  /* ---------- weights ---------- */

  function weightParts(value) {
    return String(value ?? '').toLowerCase().split('/').map((s) => s.trim()).filter(Boolean);
  }

  function weightRank(weight) {
    if (weight === 'h') return 0.5;
    const n = Number(weight);
    return Number.isFinite(n) ? n : 0;
  }

  function heaviest(parts) {
    return [...parts].sort((a, b) => weightRank(b) - weightRank(a))[0] ?? '';
  }

  /** A day's row from the edited table, falling back to the defaults for anything missing or invalid. */
  function dayRow(day, scores) {
    const base = DAY_SCORES[day] ?? DAY_SCORES.Monday;
    const edited = scores?.[day] ?? {};
    const row = {};
    for (const rank of Object.keys(base)) {
      const v = Number(edited[rank]);
      row[rank] = edited[rank] !== '' && edited[rank] != null && Number.isFinite(v) ? v : base[rank];
    }
    return row;
  }

  function dayScore(day, rank, scores) {
    const table = dayRow(day, scores);
    if (rank in table) return table[rank];
    // Weights outside the table (e.g. "5") borrow the nearest defined rank instead of silently scoring 0.
    const ranks = Object.keys(table).map(Number);
    const nearest = ranks.reduce((best, r) => (Math.abs(r - rank) < Math.abs(best - rank) ? r : best), ranks[0]);
    return table[nearest];
  }

  /* ---------- dates (whole days since 1970-01-01, UTC, so no timezone drift) ---------- */

  const MS_PER_DAY = 86400000;

  function dayNumber(year, month, day) {
    if (year < 100) year += 2000;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d.getTime() / MS_PER_DAY;
  }

  /**
   * Accepts ISO (2026-11-16), slashed dates (11/16/2026, 16/11/26 — month first unless the first
   * part can't be a month, matching how Excel renders dates in US-format workbooks), Excel serial
   * numbers (46342) and written dates ("16 Nov 2026"). Returns a day number or null.
   */
  function parseDueDate(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return dayNumber(+m[1], +m[2], +m[3]);
    m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
    if (m) {
      const [a, b, y] = [+m[1], +m[2], +m[3]];
      return a > 12 ? dayNumber(y, b, a) : dayNumber(y, a, b);
    }
    if (/^\d{4,5}(\.\d+)?$/.test(text)) {
      const serial = Math.floor(Number(text));
      return serial > 20000 && serial < 80000 ? serial - 25569 : null; // Excel epoch → Unix epoch
    }
    const parsed = Date.parse(`${text} UTC`);
    return Number.isFinite(parsed) && /[a-z]/i.test(text) ? Math.floor(parsed / MS_PER_DAY) : null;
  }

  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const isWorkDay = (day) => { const w = (((day + 4) % 7) + 7) % 7; return w >= 1 && w <= 5; }; // day 0 was a Thursday

  /**
   * Production days (Mon–Fri) from `from` until `to`. Due on Saturday when planning Friday is 0
   * (it has to be done today); due Monday when planning Friday is 1. Anything before `from` is
   * negative (overdue), however many weekend days lie between.
   */
  function workDaysBetween(from, to) {
    if (to === from) return 0;
    const span = Math.abs(to - from);
    if (span > 370) return Math.round((to - from) * 5 / 7);
    let n = 0;
    if (to > from) {
      for (let d = from + 1; d <= to; d++) if (isWorkDay(d)) n++;
      return n;
    }
    for (let d = to; d < from; d++) if (isWorkDay(d)) n++;
    return -Math.max(1, n);
  }

  function formatDay(day) {
    return new Date(day * MS_PER_DAY).toLocaleDateString([], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  }

  function urgencyFor(daysLeft, dueWeight) {
    const factor = DUE_WEIGHTS[dueWeight] ?? DUE_WEIGHTS.normal;
    if (daysLeft == null || !factor) return { points: 0, label: '' };
    const step = URGENCY_STEPS.find((s) => daysLeft <= s.maxDays);
    return step ? { points: step.points * factor, label: step.label(daysLeft) } : { points: 0, label: '' };
  }

  /* ---------- sheet parsing ---------- */

  /** Finds the header row (first row with a Copperweight-like cell) and turns the rows below it into records. */
  function parseSheet(matrix, rowOffset = 0) {
    const headerIndex = matrix.findIndex((row) => row.some((cell) => FIELDS.copper.aliases.includes(norm(cell))));
    if (headerIndex < 0) return null;

    const seen = new Map();
    const headers = matrix[headerIndex].map((cell, i) => {
      const name = String(cell ?? '').trim() || `Column ${i + 1}`;
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      return count > 1 ? `${name} (${count})` : name;
    });

    const records = [];
    matrix.slice(headerIndex + 1).forEach((row, offset) => {
      if (!row.some((v) => String(v ?? '').trim() !== '')) return;
      const values = {};
      headers.forEach((h, i) => { values[h] = row[i] ?? ''; });
      records.push({ sheetRow: rowOffset + headerIndex + offset + 2, values });
    });

    return { headerRow: rowOffset + headerIndex + 1, headers, records };
  }

  function autoMap(headers) {
    const mapping = {};
    for (const [key, field] of Object.entries(FIELDS)) {
      // Aliases are in order of preference, so "Due date" wins over a generic "Date" column.
      const alias = field.aliases.find((a) => headers.some((h) => norm(h) === a));
      mapping[key] = alias ? headers.find((h) => norm(h) === alias) : '';
    }
    return mapping;
  }

  /** WO "174-05-08" belongs to job "WO 174-05". Lines without WO fall back to TN, then to their own row. */
  function jobKeyFor(wo, tn, sheetRow) {
    const parts = wo.split('-').filter(Boolean);
    const group = parts.length > 1 ? `${parts[0]}-${parts[1]}` : wo;
    if (group) return { group, job: `WO ${group}` };
    if (tn) return { group: '', job: `TN ${tn}` };
    return { group: '', job: `Row ${sheetRow}` };
  }

  /**
   * Normalises sheet records into schedule lines. Each line gets a `uid` built from its own data
   * (not its row index) so pins, bottom-image choices and manual order survive a refreshed workbook.
   */
  function buildLines(records, mapping) {
    const occurrences = new Map();
    return records.map(({ sheetRow, values }, index) => {
      const get = (key) => (mapping[key] ? String(values[mapping[key]] ?? '').trim() : '');
      const parts = weightParts(get('copper'));
      const wo = get('wo');
      const tn = get('tn');
      const coresValue = parseNumber(get('cores'));
      const coresKnown = Number.isFinite(coresValue) && coresValue >= 1;
      const dueText = get('due');
      const dueDay = parseDueDate(dueText);
      const copper = parts.join('/') || '?';
      const heavy = heaviest(parts);
      const { group, job } = jobKeyFor(wo, tn, sheetRow);

      const base = `${wo}|${tn}|${copper}`;
      const n = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, n);

      return {
        index, sheetRow, values, uid: `${base}#${n}`,
        copper, heavy, rank: weightRank(heavy), mixed: new Set(parts).size > 1,
        cores: coresKnown ? coresValue : 1, coresKnown,
        wo, woGroup: group, tn, job, dueText, dueDay,
        sheetSpeed: parseNumber(get('speed')),
      };
    });
  }

  /* ---------- scheduling ---------- */

  /**
   * The rules in force. With a measured line length (in the speed's distance unit) travel is
   * length ÷ speed instead of the typed first-core minutes; with a core pitch (distance from one
   * core's leading edge to the next) the interval is pitch ÷ speed. Either can be left blank.
   */
  function resolveRules(settings) {
    const lineLength = Math.max(0, Number(settings?.lineLength) || 0);
    const corePitch = Math.max(0, Number(settings?.corePitch) || 0);
    const out = [];
    const seen = new Set();
    for (const r of settings?.rules ?? []) {
      const weight = String(r.weight ?? '').trim().toLowerCase();
      if (!weight || seen.has(weight)) continue;
      seen.add(weight);
      const speed = Number(r.speed) || 0;
      out.push({
        weight,
        speed,
        firstMinutes: lineLength && speed ? lineLength / speed : Math.max(0, Number(r.firstMinutes) || 0),
        nextSeconds: corePitch && speed ? corePitch / speed * 60 : Math.max(0, Number(r.nextSeconds) || 0),
        derivedFirst: Boolean(lineLength && speed),
        derivedNext: Boolean(corePitch && speed),
      });
    }
    return out;
  }

  function ruleMap(settings) {
    return new Map(resolveRules(settings).map((r) => [r.weight, r]));
  }

  /** Due-date view of a job: calendar days for display, production days (with slack) for urgency. */
  function dueInfo(jobDueDay, planDay, jobMinutes, capacityMinutes, dueWeight) {
    if (jobDueDay == null || planDay == null) {
      return { daysLeft: null, workDaysLeft: null, shiftsNeeded: 1, urgency: 0, urgencyLabel: '', dueLabel: '', dueKind: '' };
    }
    const daysLeft = jobDueDay - planDay;
    const workDaysLeft = workDaysBetween(planDay, jobDueDay);
    // Slack: a job that needs three shifts and is due in two production days has to start today.
    const shiftsNeeded = capacityMinutes > 0 ? Math.max(1, Math.ceil(jobMinutes / capacityMinutes)) : 1;
    const effective = workDaysLeft < 0 ? workDaysLeft : workDaysLeft - (shiftsNeeded - 1);
    const points = urgencyFor(effective, dueWeight).points;

    let dueLabel;
    if (daysLeft < 0) dueLabel = `Overdue ${-daysLeft}d`;
    else if (workDaysLeft === 0) dueLabel = 'Due today';
    else if (daysLeft === 1) dueLabel = 'Due tomorrow';
    else if (workDaysLeft <= 5) dueLabel = `Due ${WEEKDAY_SHORT[(((jobDueDay + 4) % 7) + 7) % 7]}`;
    else dueLabel = `Due in ${workDaysLeft} work days`;
    const tight = effective < workDaysLeft && workDaysLeft >= 0;
    const dueKind = effective < 0 && daysLeft < 0 ? 'overdue' : effective <= 0 ? 'today' : effective <= 3 ? 'soon' : '';
    const urgencyLabel = points ? `${dueLabel[0].toLowerCase()}${dueLabel.slice(1)}${tight ? `, needs ${shiftsNeeded} shifts` : ''}` : '';
    return { daysLeft, workDaysLeft, shiftsNeeded, urgency: points, urgencyLabel, dueLabel, dueKind: dueKind || (tight ? 'soon' : '') };
  }

  /**
   * Speed, travel and interval for one line. A job sometimes runs a little off its weight's usual
   * speed (to etch properly); then it is its own speed block, and travel and interval scale with the
   * conveyor: half the speed, twice the time.
   */
  function lineTiming(line, rule) {
    if (!rule) return { speed: null, travel: 0, interval: 0, offSpeed: false };
    const sheet = line.sheetSpeed;
    const speed = Number.isFinite(sheet) && sheet > 0 ? sheet : rule.speed;
    const factor = rule.speed > 0 && speed > 0 ? rule.speed / speed : 1;
    return { speed, travel: rule.firstMinutes * factor, interval: rule.nextSeconds / 60 * factor, offSpeed: speed !== rule.speed };
  }

  function createContext(lines, settings, plan) {
    const rules = ruleMap(settings);
    const pins = new Set(plan.pins ?? []);
    const bottomImage = new Set(plan.bottomImage ?? []);
    // Breaks come off the shift: the line stops for them.
    const breakMinutes = Math.max(0, Number(settings.breakMinutes) || 0);
    const capacityMinutes = Math.max(0, (Number(settings.shiftHours) || 0) * 60 - breakMinutes);
    const lineMinutes = (line) => line.cores * lineTiming(line, rules.get(line.heavy)).interval;

    // A job is as urgent as its earliest-due line; every line of the job carries that urgency.
    const jobDue = new Map();
    const jobMinutes = new Map();
    for (const line of lines) {
      if (line.dueDay != null) jobDue.set(line.job, Math.min(jobDue.get(line.job) ?? Infinity, line.dueDay));
      jobMinutes.set(line.job, (jobMinutes.get(line.job) ?? 0) + lineMinutes(line));
    }
    const planDay = parseDueDate(settings.planDate);
    const firstSeen = plan.firstSeen ?? {};
    // Waiting only counts days that have actually passed: planning next Monday on Thursday must not
    // credit Friday as waited. Without a "today" (e.g. in tests) the production date is used.
    const today = parseDueDate(plan.today);
    const waitedUntil = today != null && planDay != null ? Math.min(today, planDay) : planDay;
    const agingFor = (job) => {
      const seen = parseDueDate(firstSeen[job]);
      if (seen == null || waitedUntil == null || seen >= waitedUntil) return { waitingDays: 0, aging: 0 };
      const waitingDays = Math.max(0, workDaysBetween(seen, waitedUntil));
      return { waitingDays, aging: Math.min(AGING_POINTS_CAP, waitingDays * AGING_POINTS_PER_DAY) };
    };

    const items = lines.map((line) => {
      const rule = rules.get(line.heavy) ?? null;
      const day = dayScore(settings.day, line.rank, settings.dayScores);
      const jobDueDay = jobDue.get(line.job) ?? null;
      const due = dueInfo(jobDueDay, planDay, jobMinutes.get(line.job), capacityMinutes, settings.dueWeight);
      const { waitingDays, aging } = agingFor(line.job);
      const timing = lineTiming(line, rule);
      return {
        ...line,
        ...due,
        waitingDays,
        aging,
        rule,
        targetSpeed: timing.speed,
        travel: timing.travel,
        interval: timing.interval,
        offSpeed: timing.offSpeed,
        dayScore: day,
        jobDueDay,
        priority: day + due.urgency + aging,
        baseMinutes: line.cores * timing.interval,
        block: `${line.heavy}|${timing.speed ?? ''}`,
        pinned: pins.has(line.job),
        bottomImage: line.mixed && bottomImage.has(line.uid),
      };
    });

    // What is on the machine at handover: the previous shift is still feeding that weight, so the plan
    // can carry straight on at that speed. Null means a cold, empty line.
    const running = String(settings.runningWeight ?? '').trim().toLowerCase();
    const runningRule = running ? rules.get(running) : null;
    const start = runningRule
      ? { heavy: running, rule: runningRule, targetSpeed: runningRule.speed, travel: runningRule.firstMinutes,
          interval: runningRule.nextSeconds / 60, job: null, mixed: false, bottomImage: false, isMachineState: true }
      : null;

    const percent = (v, fallback) => Math.min(100, Math.max(0, v === '' || v == null || !Number.isFinite(Number(v)) ? fallback : Number(v))) / 100;
    return {
      settings,
      items,
      start,
      setupMinutes: Math.max(0, Number(settings.setupMinutes) || 0),
      // Setting the diverters for a run of bottom-image cores (lighter side not clear). Paid once per run.
      imageChangeMinutes: Math.max(0, Number(settings.imageChangeMinutes ?? 10) || 0),
      breakMinutes,
      // Changing the speed setting itself, once the line is clear enough.
      speedChangeMinutes: Math.max(0, Number(settings.speedChangeMinutes) || 0),
      // Optional per-pair override: { fromWeight: { toWeight: minutes } }; blank cells use the default.
      speedChangeMatrix: settings.speedChangeMatrix && typeof settings.speedChangeMatrix === 'object' ? settings.speedChangeMatrix : null,
      // How far the last core must be through the line before the speed changes, as a share of its
      // travel. Slowing down: fully out (a light core stuck at a slow speed is ruined). Speeding up:
      // out of the etcher, which by default is the second quarter of the line.
      clearDown: percent(settings.clearDownPercent, 100),
      clearUp: percent(settings.clearUpPercent, 50),
      capacityMinutes,
    };
  }

  function groupBy(items, keyOf) {
    const groups = new Map();
    for (const item of items) {
      const key = keyOf(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return groups;
  }

  /** Whole jobs ranked for selection: pinned first, then core-weighted average priority. */
  function rankJobs(ctx) {
    return [...groupBy(ctx.items, (i) => i.job).entries()].map(([key, lines]) => {
      let weighted = 0;
      let cores = 0;
      for (const l of lines) { weighted += l.priority * l.cores; cores += l.cores; }
      return {
        key, lines,
        pinned: lines[0].pinned,
        // A line without a rule can't be timed, so its job is held back rather than planned as 0 minutes.
        blocked: lines.some((l) => !l.rule),
        score: cores ? weighted / cores : 0,
        maxPriority: Math.max(...lines.map((l) => l.priority)),
        minutes: lines.reduce((s, l) => s + l.baseMinutes, 0),
        firstIndex: lines[0].index,
      };
    }).sort((a, b) => (Number(b.pinned) - Number(a.pinned))
      || (b.score - a.score)
      || (b.maxPriority - a.maxPriority)
      || (a.minutes - b.minutes)
      || (a.firstIndex - b.firstIndex));
  }

  /* ---------- timing ----------
   *
   * The clock is the loader's. The conveyor sets the gap between cores, so a line of n cores keeps the
   * loader busy for n × interval. Travel through the line only matters twice: at a speed change, where
   * the next weight can't be fed until the last core is far enough through (fully out when slowing
   * down, out of the etcher when speeding up), and at the very end, when the last core has to come out.
   */

  /** Minutes to change the speed setting from one weight to another: the pair's own number, else the default. */
  function settingChangeMinutes(ctx, fromWeight, toWeight) {
    const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
    const row = own(ctx.speedChangeMatrix, fromWeight) ? ctx.speedChangeMatrix[fromWeight] : null;
    const cell = own(row, toWeight) ? row[toWeight] : undefined;
    const v = Number(cell);
    return cell !== '' && cell != null && Number.isFinite(v) ? Math.max(0, v) : ctx.speedChangeMinutes;
  }

  /** Minutes the loader has to wait after the previous line's last core before the first core of this one. */
  function changeover(ctx, prev, item) {
    const from = prev?.targetSpeed;
    const to = item.targetSpeed;
    if (from == null || to == null || from === to) return { wait: 0, clearWait: 0, direction: '' };
    const direction = to < from ? 'down' : 'up';
    const fraction = direction === 'down' ? ctx.clearDown : ctx.clearUp;
    const clearWait = (prev.travel ?? 0) * fraction;
    // The previous line's own interval is already counted, so only the extra beyond it is a wait.
    const setting = settingChangeMinutes(ctx, prev.heavy, item.heavy);
    const wait = Math.max(0, clearWait + setting - (prev.interval ?? 0));
    return { wait, clearWait, setting, direction };
  }

  /** Everything that happens before and during a line, given the line before it (or the machine state, or nothing). */
  function transition(ctx, prev, item) {
    const jobStart = !prev || prev.job !== item.job;
    // A bottom-image core (lighter side not clear) needs the diverters set. That's paid when a run of
    // image cores starts; image cores straight after another image core share the setting.
    const imageChangeover = item.bottomImage && !prev?.bottomImage;
    const setup = jobStart ? ctx.setupMinutes : 0;
    const image = imageChangeover ? ctx.imageChangeMinutes : 0;
    const change = changeover(ctx, prev, item);
    const loading = item.cores * item.interval;
    return {
      jobStart, imageChangeover, setup, image,
      speedChange: change.wait, clearWait: change.clearWait, settingMinutes: change.setting, direction: change.direction,
      loading,
      // Minutes from the previous line's loader end to this line's loader end.
      total: setup + image + change.wait + loading,
    };
  }

  /** Shift end for a sequence: when the last core is out. Allocation-free, used inside the search. */
  function sequenceMinutes(ctx, ordered, prev) {
    let loaderEnd = 0;
    let out = 0;
    for (const item of ordered) {
      const t = transition(ctx, prev, item);
      loaderEnd += t.total;
      out = Math.max(out, loaderEnd - item.interval + item.travel);
      prev = item;
    }
    return Math.max(loaderEnd, out);
  }

  function timeLines(ctx, ordered) {
    const lastIndexOfJob = new Map();
    ordered.forEach((item, i) => lastIndexOfJob.set(item.job, i));
    let loaderEnd = 0;
    return ordered.map((item, i) => {
      const prev = i ? ordered[i - 1] : ctx.start;
      const t = transition(ctx, prev, item);
      const start = loaderEnd + t.setup + t.image + t.speedChange;
      loaderEnd = start + t.loading;
      return {
        ...item,
        position: i + 1,
        jobStart: t.jobStart,
        jobEnd: lastIndexOfJob.get(item.job) === i,
        // The job was already running before a weight change: it carries on without a new setup.
        continuesJob: !t.jobStart && prev.heavy !== item.heavy,
        fromMachine: i === 0 && Boolean(ctx.start) && ctx.start.targetSpeed === item.targetSpeed,
        imageChangeover: t.imageChangeover,
        setupMinutes: t.setup,
        imageChangeMinutes: t.image,
        speedChangeMinutes: t.speedChange,
        clearWaitMinutes: t.clearWait,
        settingMinutes: t.settingMinutes,
        changeDirection: t.direction,
        minutes: t.total,
        startMinute: start,                                   // first core loaded
        endMinute: loaderEnd,                                 // loader free for the next line
        outMinute: loaderEnd - item.interval + item.travel,   // last core out of the line
      };
    });
  }

  /* ---------- arrangement ---------- */

  const speedKey = (x) => (x.targetSpeed == null ? Infinity : x.targetSpeed);
  const byLine = (a, b) => a.copper.localeCompare(b.copper) || (a.baseMinutes - b.baseMinutes) || (a.index - b.index);

  /**
   * One block per weight/target speed. Inside a block every job's lines stay together (a job only
   * pays its setup once per block), most urgent jobs first, then identical configurations together.
   */
  function buildBlocks(items) {
    return [...groupBy(items, (i) => i.block).entries()].map(([key, lines]) => {
      const jobs = [...groupBy(lines, (l) => l.job).entries()].map(([job, jobLines]) => {
        const sorted = jobLines.sort(byLine);
        return {
          job,
          lines: sorted,
          // Bottom-image cores are kept together so the diverters are set once per run.
          clearLines: sorted.filter((l) => !l.bottomImage),
          imageLines: sorted.filter((l) => l.bottomImage),
          urgency: Math.max(...sorted.map((l) => l.urgency)),
          copper: sorted[0].copper,
          minutes: sorted.reduce((s, l) => s + l.baseMinutes, 0),
          firstIndex: Math.min(...sorted.map((l) => l.index)),
        };
      }).sort((a, b) => (b.urgency - a.urgency) || a.copper.localeCompare(b.copper)
        || (a.minutes - b.minutes) || (a.firstIndex - b.firstIndex));
      return {
        key,
        jobs,
        jobKeys: new Set(jobs.map((j) => j.job)),
        targetSpeed: lines[0].targetSpeed,
        priority: Math.max(...lines.map((l) => l.priority)),
        urgency: Math.max(...lines.map((l) => l.urgency)),
        shortest: Math.min(...lines.map((l) => l.baseMinutes)),
        firstIndex: Math.min(...lines.map((l) => l.index)),
      };
    });
  }

  /** The order the day scores (plus urgency) ask for: highest priority block first. */
  function preferenceOrder(blocks) {
    return [...blocks].sort((a, b) => (b.priority - a.priority)
      || (speedKey(a) - speedKey(b) || 0)
      || (a.shortest - b.shortest)
      || (a.firstIndex - b.firstIndex));
  }

  /**
   * Lays blocks out in the given order. A job that spans two neighbouring blocks is put last in the
   * first and first in the second, so it runs straight through the weight change without a new setup.
   * Bottom-image cores are bunched: after clear cores they go last in the block; when the machine is
   * already running image cores they go first, so a run can carry on across the weight change.
   */
  function layout(order, prev) {
    const out = [];
    const last = () => (out.length ? out[out.length - 1] : prev);
    const place = (j) => {
      const imageNow = Boolean(last()?.bottomImage);
      out.push(...(imageNow ? [...j.imageLines, ...j.clearLines] : [...j.clearLines, ...j.imageLines]));
    };
    let leadJob = prev?.job ?? null;
    order.forEach((block, i) => {
      const next = order[i + 1];
      let jobs = block.jobs;
      const lead = jobs.find((j) => j.job === leadJob);
      if (lead) jobs = jobs.filter((j) => j !== lead);
      let tail = null;
      if (next) {
        tail = jobs.filter((j) => next.jobKeys.has(j.job)).sort((a, b) => a.job.localeCompare(b.job))[0] ?? null;
        if (tail) jobs = jobs.filter((j) => j !== tail);
      }
      if (lead) place(lead);
      const withImage = jobs.filter((j) => j.imageLines.length);
      const clearOnly = jobs.filter((j) => !j.imageLines.length);
      for (const j of last()?.bottomImage ? [...withImage, ...clearOnly] : [...clearOnly, ...withImage]) place(j);
      if (tail) place(tail);
      leadJob = out.length ? out[out.length - 1].job : leadJob;
    });
    return out;
  }

  /**
   * Shift minutes for a sequence, plus the cost of making jobs that are due today or overdue wait:
   * their urgency points × hours until they start. Other jobs only need to be in the shift; when
   * in it they run doesn't matter.
   */
  function sequenceCost(ctx, ordered, prev) {
    let loaderEnd = 0;
    let out = 0;
    let delay = 0;
    const started = new Set();
    for (const item of ordered) {
      if (item.urgency && item.workDaysLeft != null && item.workDaysLeft <= 0 && !started.has(item.job)) {
        started.add(item.job);
        delay += item.urgency * (loaderEnd / 60) * DUE_DELAY_MINUTES_PER_POINT_HOUR;
      }
      loaderEnd += transition(ctx, prev, item).total;
      out = Math.max(out, loaderEnd - item.interval + item.travel);
      prev = item;
    }
    const minutes = Math.max(loaderEnd, out);
    return { minutes, cost: minutes + delay };
  }

  function forEachPermutation(items, visit) {
    const a = [...items];
    const c = new Array(a.length).fill(0);
    visit([...a]);
    let i = 0;
    while (i < a.length) {
      if (c[i] < i) {
        const k = i % 2 ? c[i] : 0;
        [a[k], a[i]] = [a[i], a[k]];
        visit([...a]);
        c[i] += 1;
        i = 0;
      } else {
        c[i] = 0;
        i += 1;
      }
    }
  }

  /**
   * Picks the block order with the lowest cost = shift minutes (travel, setups, speed changes,
   * waiting for the line to clear) + the cost of keeping jobs due today or overdue waiting.
   * Starts from the day-preference order, which is also what "saved minutes" is measured against.
   */
  function searchOrder(ctx, items, prev, mode) {
    if (!items.length) return { ordered: [], minutes: 0, baselineMinutes: 0, keys: [] };
    const blocks = buildBlocks(items);
    const preferred = preferenceOrder(blocks);
    const baseline = layout(preferred, prev);
    const base = sequenceCost(ctx, baseline, prev);
    const result = (b) => ({ ordered: b.ordered, minutes: b.minutes, baselineMinutes: base.minutes, keys: b.order.map((x) => x.key) });
    let best = { order: preferred, ordered: baseline, minutes: base.minutes, cost: base.cost };
    if (mode === 'quick' || preferred.length < 2) return result(best);

    // Reuse an order found earlier (hint = block keys): blocks it already knows keep their places,
    // each new block is tried at every position. Used while filling the shift, so the full search
    // runs once rather than once per candidate job.
    if (Array.isArray(mode)) {
      const byKey = new Map(blocks.map((b) => [b.key, b]));
      let order = mode.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
      for (const block of preferred.filter((b) => !mode.includes(b.key))) {
        let pick = null;
        for (let at = 0; at <= order.length; at++) {
          const tryOrder = [...order.slice(0, at), block, ...order.slice(at)];
          const ordered = layout(tryOrder, prev);
          const c = sequenceCost(ctx, ordered, prev);
          if (!pick || c.cost < pick.cost - 1e-9) pick = { order: tryOrder, ordered, minutes: c.minutes, cost: c.cost };
        }
        order = pick.order;
      }
      const ordered = layout(order, prev);
      const c = sequenceCost(ctx, ordered, prev);
      return result({ order, ordered, minutes: c.minutes, cost: c.cost });
    }

    const consider = (order) => {
      const ordered = layout(order, prev);
      const { minutes, cost } = sequenceCost(ctx, ordered, prev);
      if (cost < best.cost - 1e-9) {
        best = { order, ordered, minutes, cost };
        return true;
      }
      return false;
    };

    if (preferred.length <= EXHAUSTIVE_BLOCK_LIMIT) {
      forEachPermutation(preferred, consider);
    } else {
      // Too many blocks to try every order: move one block at a time while that keeps helping.
      for (let round = 0, improved = true; improved && round < 50; round++) {
        improved = false;
        const current = best.order;
        for (let from = 0; from < current.length && !improved; from++) {
          for (let to = 0; to < current.length && !improved; to++) {
            if (from === to) continue;
            const order = [...current];
            order.splice(to, 0, order.splice(from, 1)[0]);
            improved = consider(order);
          }
        }
      }
    }
    return result(best);
  }

  /**
   * Pinned jobs first (searched among themselves), then everything else continuing from them.
   * mode: 'full' (search every order), 'quick' (day-preference order), or a hint from an earlier
   * arrange() to reuse its block order.
   */
  function arrange(ctx, items, mode = 'full') {
    const pinMode = mode && typeof mode === 'object' ? mode.pinned : mode;
    const restMode = mode && typeof mode === 'object' ? mode.rest : mode;
    const pinned = searchOrder(ctx, items.filter((i) => i.pinned), ctx.start, pinMode);
    const rest = searchOrder(ctx, items.filter((i) => !i.pinned), pinned.ordered.at(-1) ?? ctx.start, restMode);
    const ordered = [...pinned.ordered, ...rest.ordered];
    return {
      ordered,
      minutes: sequenceMinutes(ctx, ordered, ctx.start),
      hint: { pinned: pinned.keys, rest: rest.keys },
      savedMinutes: (pinned.baselineMinutes - pinned.minutes) + (rest.baselineMinutes - rest.minutes),
    };
  }

  function applyPins(items) {
    return [...items.filter((i) => i.pinned), ...items.filter((i) => !i.pinned)];
  }

  function applyManualOrder(items, manualOrder) {
    const position = new Map(manualOrder.map((uid, i) => [uid, i]));
    const known = items.filter((i) => position.has(i.uid)).sort((a, b) => position.get(a.uid) - position.get(b.uid));
    return [...known, ...items.filter((i) => !position.has(i.uid))];
  }

  /* ---------- selection ---------- */

  function selectJobs(ctx, ranked) {
    const { settings } = ctx;
    const eligible = ranked.filter((j) => !j.blocked);
    if (!settings.fillShift) {
      const limit = Math.floor(Number(settings.jobLimit));
      return limit > 0 ? eligible.slice(0, limit) : eligible;
    }
    const arrangeJobs = (jobs, mode) => arrange(ctx, jobs.flatMap((j) => j.lines), mode);

    // Pass 1, greedy: whole jobs in priority order (day score, due dates, waiting time), skipping any
    // that would overflow the shift. It measures with the quick day-preference order. Pinned jobs are
    // always kept. The first job is always taken so an oversized job still shows up (flagged as over).
    const chosen = [];
    for (const job of eligible) {
      if (job.pinned || !chosen.length || arrangeJobs([...chosen, job], 'quick').minutes <= ctx.capacityMinutes) chosen.push(job);
    }
    // One full search of the order. Everything after this reuses it as a hint, so filling the shift
    // costs a few layouts per job instead of a full search per job.
    let current = arrangeJobs(chosen, 'full');
    // Pass 2, repair: the searched order is usually faster, but it may spend time to start a job due
    // today sooner. If that pushes it over, drop the lowest-ranked jobs (never pins) until it fits.
    while (chosen.length > 1 && current.minutes > ctx.capacityMinutes) {
      const drop = chosen.map((j, i) => i).reverse().find((i) => !chosen[i].pinned);
      if (drop === undefined || drop === 0) break;
      chosen.splice(drop, 1);
      current = arrangeJobs(chosen, current.hint);
    }
    // Pass 3, backfill: offer the minutes the searched order freed to the jobs left out. If what was
    // added makes a full re-search find a faster order, the leftovers get one more chance against it.
    // A job that only just misses under the reused order gets a full search too (reshuffling the
    // blocks can make room), but only a few times per rebuild so large workbooks stay quick.
    const chosenSet = new Set(chosen);
    let fullSearchesLeft = NEAR_MISS_FULL_SEARCHES;
    const take = (job, trial) => { chosen.push(job); chosenSet.add(job); current = trial; };
    const backfill = () => {
      let added = false;
      const nearMisses = [];
      for (const job of eligible) {
        if (chosenSet.has(job)) continue;
        const trial = arrangeJobs([...chosen, job], current.hint);
        if (trial.minutes <= ctx.capacityMinutes) { take(job, trial); added = true; }
        else if (trial.minutes <= ctx.capacityMinutes + NEAR_MISS_MINUTES) nearMisses.push({ job, over: trial.minutes - ctx.capacityMinutes });
      }
      // The closest misses first: they are the ones a reshuffle is most likely to make room for. A job
      // with the same speed blocks as one that already failed, and no shorter, would fail too: skip it.
      nearMisses.sort((a, b) => a.over - b.over);
      const failed = new Map(); // block signature -> shortest job minutes that still didn't fit
      for (const { job } of nearMisses) {
        if (fullSearchesLeft <= 0) break;
        const signature = [...new Set(job.lines.map((l) => l.block))].sort().join(',');
        if (failed.has(signature) && job.minutes >= failed.get(signature)) continue;
        fullSearchesLeft -= 1;
        const trial = arrangeJobs([...chosen, job], 'full');
        if (trial.minutes <= ctx.capacityMinutes) { take(job, trial); added = true; failed.clear(); }
        else failed.set(signature, Math.min(job.minutes, failed.get(signature) ?? Infinity));
      }
      return added;
    };
    if (backfill()) {
      const researched = arrangeJobs(chosen, 'full');
      if (researched.minutes < current.minutes - 1e-9) { current = researched; backfill(); }
    }
    chosen.fitted = current; // the order that is known to fit, for buildSchedule's final check
    return chosen;
  }

  /* ---------- checks and stats ---------- */

  function dataChecks(items, mapping) {
    const issues = [];
    const seenWo = new Set();
    if (items.length && !mapping.cores) {
      // Normal for sheets where each row is one core (LYR names the layers, not a quantity).
      issues.push({ level: 'info', text: 'No Number of cores column is mapped, so each row is timed as one core.' });
    }
    for (const l of items) {
      const where = `Row ${l.sheetRow}`;
      if (l.copper === '?') issues.push({ level: 'error', text: `${where}: copperweight is empty. ${l.job} is left out until it is filled in.` });
      else if (!l.rule) issues.push({ level: 'error', text: `${where}: no core-weight rule for "${l.copper}" (needs a rule for "${l.heavy}"). ${l.job} is left out until the rule exists.` });
      if (mapping.cores && !l.coresKnown) issues.push({ level: 'warning', text: `${where}: number of cores is missing or invalid; assuming 1.` });
      if (l.offSpeed) {
        issues.push({ level: 'info', text: `${where}: runs at ${l.targetSpeed} instead of the usual ${l.rule.speed} for "${l.heavy}", so it is its own speed block (the line has to clear before and after it).` });
      }
      if (mapping.due && l.dueText && l.dueDay == null) issues.push({ level: 'warning', text: `${where}: due date "${l.dueText}" is not a recognised date; ignored.` });
      if (l.wo) {
        if (seenWo.has(l.wo)) issues.push({ level: 'warning', text: `${where}: duplicate WO "${l.wo}".` });
        seenWo.add(l.wo);
      }
    }
    return issues;
  }

  function weightMix(lines) {
    const mix = new Map();
    for (const l of lines) {
      const entry = mix.get(l.copper) ?? { copper: l.copper, rank: l.rank, lines: 0, cores: 0, coresKnown: false };
      entry.lines += 1;
      if (l.coresKnown) { entry.cores += l.cores; entry.coresKnown = true; }
      mix.set(l.copper, entry);
    }
    return [...mix.values()].sort((a, b) => a.rank - b.rank || a.copper.localeCompare(b.copper));
  }

  function countChanges(lines, valueOf) {
    let changes = 0;
    for (let i = 1; i < lines.length; i++) if (valueOf(lines[i]) !== valueOf(lines[i - 1])) changes++;
    return changes;
  }

  /**
   * Builds the full schedule.
   * @param lines    output of buildLines()
   * @param settings { rules, day, shiftHours, setupMinutes, speedChangeMinutes, clearDownPercent, clearUpPercent, lineLength, corePitch, breakMinutes, imageChangeMinutes, runOn,
   *                   runningWeight, fillShift, jobLimit, planDate, dueWeight }
   * @param plan     { pins: jobKey[], bottomImage: uid[], manualOrder: uid[] | null,
   *                   firstSeen: { [jobKey]: 'YYYY-MM-DD' } (first day the job appeared in a workbook),
   *                   today: 'YYYY-MM-DD' (waiting is counted up to the earlier of today and the production date) }
   */
  /**
   * With a following shift, the last job may run past the end: pick the best-ranked job left out,
   * preferring one at the speed the shift ends on ("send me more of this speed").
   */
  function runOnJob(ctx, ranked, selected, ordered) {
    if (!ctx.settings.fillShift || !ctx.settings.runOn || !ordered.length) return null;
    if (sequenceMinutes(ctx, ordered, ctx.start) > ctx.capacityMinutes) return null;
    const chosen = new Set(selected);
    const left = ranked.filter((j) => !j.blocked && !chosen.has(j));
    if (!left.length) return null;
    const lastBlock = ordered.at(-1).block;
    return left.find((j) => j.lines.some((l) => l.block === lastBlock)) ?? left[0];
  }

  function buildSchedule(allLines, settings, plan = {}, mapping = {}) {
    // Cores ticked as done stay out of the plan (the workbook lists whole orders even when part has run).
    const doneSet = new Set(Object.keys(plan.done ?? {}));
    const lines = allLines.filter((l) => !doneSet.has(l.uid));
    const doneLines = allLines.filter((l) => doneSet.has(l.uid));

    const ctx = createContext(lines, settings, plan);
    const ranked = rankJobs(ctx);
    const selected = selectJobs(ctx, ranked);
    let arranged = arrange(ctx, selected.flatMap((j) => j.lines), 'full');
    // The final search may trade a few minutes to start an urgent job sooner; never let that push a
    // filled shift over when the order used while filling it fitted.
    if (selected.fitted && arranged.minutes > ctx.capacityMinutes && selected.fitted.minutes <= ctx.capacityMinutes) {
      arranged = { ...selected.fitted, savedMinutes: arranged.savedMinutes };
    }
    const manual = Boolean(plan.manualOrder?.length);
    let ordered = manual ? applyPins(applyManualOrder(arranged.ordered, plan.manualOrder)) : arranged.ordered;
    const extra = runOnJob(ctx, ranked, selected, ordered);
    if (extra) {
      const lastBlock = ordered.at(-1).block;
      const lines = [...extra.lines].sort((a, b) => Number(b.block === lastBlock) - Number(a.block === lastBlock) || byLine(a, b));
      ordered = [...ordered, ...lines.map((l) => ({ ...l, runOn: true }))];
    }
    const timed = timeLines(ctx, ordered);
    const jobOrder = [...new Set(timed.map((l) => l.job))];
    const planned = timed.length ? Math.max(...timed.map((l) => Math.max(l.endMinute, l.outMinute))) : 0;
    const base = extra ? timed.filter((l) => !l.runOn) : timed;
    const basePlanned = base.length ? Math.max(...base.map((l) => Math.max(l.endMinute, l.outMinute))) : 0;

    // Jobs due by the production date (production days, so Saturday counts as Friday), split by
    // whether they made it into the shift.
    const scheduledSet = new Set(jobOrder);
    const urgent = ranked.filter((j) => j.lines[0].workDaysLeft != null && j.lines[0].workDaysLeft <= 0);
    const due = {
      planDay: parseDueDate(settings.planDate),
      overdueScheduled: urgent.filter((j) => scheduledSet.has(j.key) && j.lines[0].daysLeft < 0).length,
      dueTodayScheduled: urgent.filter((j) => scheduledSet.has(j.key) && j.lines[0].daysLeft >= 0).length,
      urgentLeftOut: urgent.filter((j) => !scheduledSet.has(j.key)).map((j) => j.key),
      jobsWithDates: ranked.filter((j) => j.lines[0].jobDueDay != null).length,
    };

    return {
      lines: timed,
      doneLines,
      jobOrder,
      checks: dataChecks(ctx.items, mapping),
      stats: {
        plannedMinutes: planned,
        capacityMinutes: ctx.capacityMinutes,
        breakMinutes: ctx.breakMinutes,
        overMinutes: Math.max(0, basePlanned - ctx.capacityMinutes),
        runOnJob: extra ? extra.key : null,
        runOnMinutes: extra ? Math.max(0, planned - ctx.capacityMinutes) : 0,
        doneLines: doneLines.length,
        scheduledJobs: jobOrder.length,
        totalJobs: ranked.length,
        blockedJobs: ranked.filter((j) => j.blocked).map((j) => j.key),
        configChanges: countChanges(timed, (l) => l.copper),
        speedChanges: countChanges(timed, (l) => l.targetSpeed) + (timed[0]?.speedChangeMinutes ? 1 : 0),
        // Minutes the searched order saves against the plain day order (0 once the order is manual).
        savedMinutes: manual ? 0 : Math.max(0, arranged.savedMinutes),
        weightMix: weightMix(timed),
        due,
      },
    };
  }

  /* ---------- presentation helpers (still pure) ---------- */

  function formatClock(startTime, minutes) {
    const [h, m] = String(startTime || '00:00').split(':').map(Number);
    const total = Math.round((h || 0) * 60 + (m || 0) + minutes);
    const d = new Date(2000, 0, 1, 0, total);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function explain(line) {
    const parts = [`day score ${line.dayScore}`];
    if (line.urgency) parts.push(`${line.urgencyLabel} +${line.urgency}`);
    if (line.aging) parts.push(`waiting ${line.waitingDays} work day${line.waitingDays === 1 ? '' : 's'} +${line.aging}`);
    if (line.pinned) parts.push('pinned');
    if (line.fromMachine) parts.push('weight already on the machine');
    if (line.continuesJob) parts.push('job runs on through the weight change');
    if (line.imageChangeover) parts.push(line.imageChangeMinutes ? `+${Math.round(line.imageChangeMinutes)} min setting diverters (bottom image)` : 'bottom image starts');
    if (line.offSpeed) parts.push(`own speed ${line.targetSpeed}`);
    if (line.changeDirection) {
      const what = line.changeDirection === 'up' ? 'speeding up: last core out of the etcher' : 'slowing down: last core fully out';
      parts.push(`${Math.round(line.speedChangeMinutes)} min wait (${what}${line.settingMinutes ? `, ${Math.round(line.settingMinutes)} min to change the setting` : ''})`);
    }
    if (line.runOn) parts.push('runs on into the next shift');
    return parts.join(' · ');
  }

  function exportRows(result, headers, notes, startTime) {
    return result.lines.map((l) => {
      const row = { 'Order': l.position, 'Job': l.job };
      for (const h of headers) row[h] = l.values[h];
      Object.assign(row, {
        'Target speed': l.targetSpeed ?? '',
        'Loading minutes': Number(l.minutes.toFixed(2)),
        'Load first core': formatClock(startTime, l.startMinute),
        'Load last core': formatClock(startTime, Math.max(l.startMinute, l.endMinute - l.interval)),
        'Last core out': formatClock(startTime, l.outMinute),
        'Wait before (min)': Number(l.speedChangeMinutes.toFixed(2)),
        'Into next shift': l.runOn ? 'Yes' : '',
        'Bottom image': l.bottomImage ? 'Yes' : '',
        'Diverter setup (min)': l.imageChangeMinutes || '',
        'Days to due (job)': l.daysLeft ?? '',
        'Production days to due': l.workDaysLeft ?? '',
        'Waiting (work days)': l.waitingDays || '',
        'Job note': notes[l.job] ?? '',
        'Placement': explain(l),
        'Priority': l.priority,
      });
      return row;
    });
  }

  root.EzdesEngine = {
    DAYS, DEFAULT_RULES, DEFAULT_DAY_SCORES: DAY_SCORES, FIELDS, DUE_WEIGHTS, AGING_POINTS_PER_DAY, AGING_POINTS_CAP,
    resolveRules,
    parseNumber, weightParts, weightRank, dayScore, parseDueDate, formatDay, urgencyFor, workDaysBetween,
    parseSheet, autoMap, buildLines, buildSchedule,
    formatClock, explain, exportRows,
  };
})(typeof window !== 'undefined' ? window : globalThis);
