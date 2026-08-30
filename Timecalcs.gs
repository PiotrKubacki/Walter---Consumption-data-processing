// =====================================================
// CDP App - Time/date calculations (B5)
// -----------------------------------------------------
// Design record \u00a78.2 / B5. Runs ONLY on interval-layer
// (HH) records inside the analysis window. Produces:
//  - seasonal monthly averages (Seasons tab: month->season)
//  - named-window splits (Time Boundaries tab: Day/Night
//    etc., network-specific rows beating DEFAULT rows)
//  - weekday/weekend daily rates
//  - 48-slot average profile
// All operator-editable config; unknown network+config
// combinations fall back to DEFAULT windows with a flag.
// =====================================================

function windowMinutes_(startHm, endHm) {
  const p = (s) => {
    const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  };
  const a = p(startHm), b = p(endHm);
  if (a === null || b === null) return null;
  return b > a ? b - a : (1440 - a) + b; // overnight windows wrap
}

function loadTimeBoundaries_() {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  const sheet = ss.getSheetByName('Time Boundaries');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  const out = [];
  for (const r of rows) {
    const start = String(r[3] || '').trim(), end = String(r[4] || '').trim();
    if (windowMinutes_(start, end) === null) continue;
    out.push({
      network: String(r[0] || '').trim(),
      config: String(r[1] || '').trim().toUpperCase(),
      window: String(r[2] || '').trim(),
      start: start, end: end,
    });
  }
  return out;
}

function loadSeasons_() {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  const sheet = ss.getSheetByName('Seasons');
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (const r of rows) {
    const m = parseInt(r[0], 10);
    if (m >= 1 && m <= 12) map[m] = String(r[1] || '').trim();
  }
  return map;
}

/**
 * Pick the window set for an ICP: network-specific rows for its
 * network (matched loosely on network name/id) if any exist,
 * else DEFAULT rows. registerConfig narrows further when the
 * table carries config codes for that network.
 */
function selectWindows_(boundaries, networkName, networkId, registerConfig) {
  const nn = String(networkName || '').toLowerCase();
  const ni = String(networkId || '').toLowerCase();
  const rc = String(registerConfig || '').toUpperCase();
  let candidates = boundaries.filter(b => {
    const bn = b.network.toLowerCase();
    return bn && bn !== 'default' && (nn.indexOf(bn) !== -1 || bn.indexOf(nn) !== -1 || bn === ni);
  });
  let usedDefault = false;
  if (candidates.length && rc) {
    const cfgMatched = candidates.filter(b => b.config && rc.indexOf(b.config) !== -1);
    if (cfgMatched.length) candidates = cfgMatched;
  }
  if (!candidates.length) {
    candidates = boundaries.filter(b => b.network.toUpperCase() === 'DEFAULT');
    usedDefault = true;
  }
  return { windows: candidates, usedDefault: usedDefault };
}

function minutesOfDay_(d) { return d.getHours() * 60 + d.getMinutes(); }

function inWindow_(mins, w) {
  const p = (s) => { const m = s.match(/^(\d{1,2}):(\d{2})$/); return (+m[1]) * 60 + (+m[2]); };
  const a = p(w.start), b = p(w.end);
  if (b > a) return mins >= a && mins < b;
  return mins >= a || mins < b; // overnight wrap
}

/**
 * Compute the time profile from interval records (already filtered
 * to the analysis window by the caller).
 * Returns null when there is no interval data.
 */
function computeTimeProfile_(hhRecs, seasons, windowSel) {
  if (!hhRecs || !hhRecs.length) return null;
  const AVG_MONTH = 365.25 / 12;

  const byMonthKwh = {}, byMonthDays = {};
  const bySeasonKwh = {}, bySeasonDays = {};
  const slotKwh = new Array(48).fill(0), slotCount = new Array(48).fill(0);
  let wdKwh = 0, wdDays = 0, weKwh = 0, weDays = 0;
  const winKwh = {};
  for (const w of windowSel.windows) winKwh[w.window] = 0;
  let totalKwh = 0, totalDays = 0;

  for (const r of hhRecs) {
    const days = (r.periodEnd - r.periodStart) / 86400000;
    const mKey = r.periodStart.getFullYear() + '-' + ('0' + (r.periodStart.getMonth() + 1)).slice(-2);
    byMonthKwh[mKey] = (byMonthKwh[mKey] || 0) + r.kWh;
    byMonthDays[mKey] = (byMonthDays[mKey] || 0) + days;
    const season = seasons[r.periodStart.getMonth() + 1] || 'Unassigned';
    bySeasonKwh[season] = (bySeasonKwh[season] || 0) + r.kWh;
    bySeasonDays[season] = (bySeasonDays[season] || 0) + days;
    const dow = r.periodStart.getDay(); // 0 Sun .. 6 Sat
    if (dow === 0 || dow === 6) { weKwh += r.kWh; weDays += days; }
    else { wdKwh += r.kWh; wdDays += days; }
    const mins = minutesOfDay_(r.periodStart);
    const slot = Math.min(47, Math.floor(mins / 30));
    slotKwh[slot] += r.kWh; slotCount[slot]++;
    for (const w of windowSel.windows) {
      if (inWindow_(mins, w)) { winKwh[w.window] += r.kWh; break; }
    }
    totalKwh += r.kWh; totalDays += days;
  }

  const seasonal = {};
  for (const s of Object.keys(bySeasonKwh)) {
    seasonal[s] = {
      kWh: Math.round(bySeasonKwh[s]),
      days: Math.round(bySeasonDays[s] * 10) / 10,
      monthlyAvg: bySeasonDays[s] > 0 ? Math.round(bySeasonKwh[s] / bySeasonDays[s] * AVG_MONTH) : null,
    };
  }
  const windows = {};
  for (const w of Object.keys(winKwh)) {
    windows[w] = {
      kWh: Math.round(winKwh[w]),
      sharePct: totalKwh > 0 ? Math.round(winKwh[w] / totalKwh * 100) : 0,
      monthlyAvg: totalDays > 0 ? Math.round(winKwh[w] / totalDays * AVG_MONTH) : null,
    };
  }
  return {
    seasonal: seasonal,
    windows: windows,
    usedDefaultWindows: windowSel.usedDefault,
    weekday: { kWhPerDay: wdDays > 0 ? Math.round(wdKwh / wdDays * 10) / 10 : null },
    weekend: { kWhPerDay: weDays > 0 ? Math.round(weKwh / weDays * 10) / 10 : null },
    slotAvg: slotKwh.map((k, i) => slotCount[i] ? Math.round(k / slotCount[i] * 1000) / 1000 : null),
    months: Object.keys(byMonthKwh).sort().map(m => ({
      month: m, kWh: Math.round(byMonthKwh[m]),
      complete: byMonthDays[m] >= 27,
    })),
  };
}