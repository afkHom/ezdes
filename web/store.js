/*
 * Browser persistence for EZDES. One versioned key instead of a key per workbook, and every
 * access wrapped so private windows or blocked storage degrade to "nothing saved" instead of crashing.
 */
(function (root) {
  'use strict';

  const KEY = 'ezdes:v3';
  const MAX_SAVED_ORDERS = 20;

  const blank = () => ({
    settings: null,      // last-used day, shift and rule settings
    presets: {},         // name -> { settings, mapping }
    mappings: {},        // header signature -> column mapping
    notes: {},           // job key -> note text (follows the job into tomorrow's workbook)
    pins: [],            // job keys
    bottomImage: [],     // line uids
    orders: {},          // "file::sheet" -> manual line order (uids)
    firstSeen: {},       // job key -> 'YYYY-MM-DD' it first appeared in a loaded workbook (for waiting points)
    planEnds: {},        // production date 'YYYY-MM-DD' -> weight that day's plan ends on (next shift's start)
    migratedLegacy: false,
  });

  function read(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function parse(text, fallback) {
    try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
  }

  /** Pulls presets, notes and pins out of the pre-rewrite storage keys once. */
  function migrateLegacy(data) {
    let keys = [];
    try { keys = Object.keys(localStorage); } catch { return; }

    const legacyPresets = parse(read('ezdes-presets'), {});
    for (const [name, p] of Object.entries(legacyPresets)) {
      if (data.presets[name]) continue;
      data.presets[name] = {
        settings: {
          day: p.day,
          shiftHours: Number(p.shift) || 8,
          startTime: p.start || '07:00',
          setupMinutes: Number(p.setup) || 0,
          speedChangeMinutes: Number(p.speedChangeover ?? 10),
          rules: (p.rules || []).map((r) => ({
            weight: r.weight, speed: r.speed, firstMinutes: r.firstMinutes ?? 0, nextSeconds: r.intervalSeconds ?? 0,
          })),
        },
        mapping: { copper: p.mapping?.copper || '', wo: p.mapping?.wo || '', tn: p.mapping?.tn || '', cores: p.mapping?.cores || '', due: p.mapping?.due || '' },
      };
    }

    for (const key of keys.filter((k) => k.startsWith('ezdes-plan:'))) {
      const plan = parse(read(key), {});
      for (const [job, note] of Object.entries(plan.jobNotes || {})) if (!data.notes[job]) data.notes[job] = note;
      for (const job of Object.keys(plan.pinnedJobs || {})) if (!data.pins.includes(job)) data.pins.push(job);
    }
    data.migratedLegacy = true;
  }

  function load() {
    const data = { ...blank(), ...parse(read(KEY), {}) };
    if (!data.firstSeen || typeof data.firstSeen !== 'object') data.firstSeen = {};
    if (!data.planEnds || typeof data.planEnds !== 'object') data.planEnds = {};
    if (!data.migratedLegacy) {
      migrateLegacy(data);
      save(data);
    }
    return data;
  }

  function save(data) {
    const orderKeys = Object.keys(data.orders);
    if (orderKeys.length > MAX_SAVED_ORDERS) {
      for (const key of orderKeys.slice(0, orderKeys.length - MAX_SAVED_ORDERS)) delete data.orders[key];
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  root.EzdesStore = { load, save };
})(window);
