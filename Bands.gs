// =====================================================
// Walter - Time-band register + slot matrix (v2.16, 13 Nov 2026)
// -----------------------------------------------------
// Replaces Yuka's "HHR v2.0" sheet (spec: project doc
// claude/HHR-V2-SHEET-SPEC.md).
//
// A RETAILER decides which tariff band applies at which
// time of day, per network (Powershop publishes its own
// schedule; few other retailers do). The Band Register
// tab holds one row per retailer x network:
//   weekday bands / weekend bands as "HH:mm Band; ..."
//   - each entry is a START time, the band runs to the
//     next start, the last one to midnight;
//   - a blank weekend means "same as weekdays".
// The register is hand-typed from the retailer's page, so
// it is DATA, edited on the Register tab in the app - not
// code. Rows carry a status (UNVERIFIED), a note and a
// "last checked" date.
//
// The server does two things only:
//   1. the register (list / save / delete / mark checked);
//   2. for half-hourly data, a SLOT MATRIX per ICP-register
//      (kWh by day type x month x half-hour).
// The band split, the weighted average rate and the fold
// into Betty's four slots are computed in the browser from
// that matrix, so a register edit or a different network
// never needs a re-analysis.
// =====================================================

const BAND_REGISTER_TAB = 'Band Register';
const BAND_REGISTER_HEADERS = ['retailer', 'network', 'weekday bands', 'weekend bands',
  'status', 'note', 'last checked', 'updated at', 'updated by'];
const BAND_STATUS_UNVERIFIED = 'UNVERIFIED';
const BAND_MAX_SEGMENTS = 12;
const BAND_SEED_NOTE = "Seeded from the HHR v2.0 sheet (hand-typed from Powershop's page)";
const BAND_SEED_NOTE_UNVERIFIED = "Not on Powershop's page; source unknown (from the HHR v2.0 sheet) - confirm with Yuka";

// retailer, network, weekday bands, weekend bands ('' = same), status.
// Seeded 13 Nov 2026 from HHR v2.0 (Data tab, Table 05) exactly as
// that sheet applies it. Orion "OLD PRICING" and the Embedded Network
// Company "Weekend Pricing" variant are deliberately not seeded.
const BAND_SEED = [
  ['Powershop', "ELECTRA LIMITED", "00:00 Night; 07:00 Peak; 11:00 Off-Peak; 17:00 Peak; 21:00 Off-Peak; 23:00 Night", "", ''],
  ['Powershop', "NORTHPOWER LIMITED", "00:00 Night; 07:30 Peak; 10:00 Off-Peak; 18:00 Peak; 20:30 Off-Peak; 22:30 Night", "00:00 Night; 07:00 Weekend Day; 22:00 Night", ''],
  ['Powershop', "VECTOR LIMITED", "00:00 Off-Peak; 07:00 Peak; 11:00 Off-Peak; 17:00 Peak; 21:00 Off-Peak", "00:00 All Weekend Off-Peak", ''],
  ['Powershop', "TOP ENERGY LIMITED", "00:00 Night; 07:00 Peak; 09:30 Off-Peak; 17:30 Peak; 20:00 Off-Peak; 22:00 Night", "00:00 Night; 07:00 Weekend Off-Peak; 22:00 Night", ''],
  ['Powershop', "COUNTIES ENERGY LIMITED", "00:00 Off-Peak; 07:00 Peak; 11:00 Off-Peak; 17:00 Peak; 21:00 Off-Peak", "00:00 All Weekend Off-Peak", ''],
  ['Powershop', "POWERCO LIMITED", "00:00 Off-Peak; 07:00 Peak; 11:00 Off-Peak; 17:00 Peak; 21:00 Off-Peak", "00:00 All Weekend Off-Peak", ''],
  ['Powershop', "THE EMBEDDED NETWORK COMPANY LIMITED", "00:00 Night; 07:00 Peak; 11:00 Off-Peak; 17:00 Peak; 21:00 Off-Peak; 23:00 Night", "", 'UNVERIFIED'],
  ['Powershop', "WEL NETWORKS LIMITED", "00:00 Night; 07:00 Peak; 09:30 Off-Peak; 17:30 Peak; 22:00 Night", "00:00 Night; 07:00 Weekend Off-Peak; 22:00 Night", ''],
  ['Powershop', "WAIPĀ NETWORKS LIMITED", "00:00 Night; 07:00 Peak; 09:30 Off-Peak; 17:30 Peak; 20:00 Off-Peak; 23:00 Night", "", ''],
  ['Powershop', "THE LINES COMPANY LIMITED", "00:00 Off-Peak; 07:00 Peak; 09:30 Shoulder; 17:30 Peak; 20:00 Shoulder; 23:00 Off-Peak", "", ''],
  ['Powershop', "MAINPOWER NEW ZEALAND LIMITED", "00:00 Off-Peak; 07:00 Peak; 11:00 Off-Peak; 17:00 Peak; 21:00 Off-Peak", "00:00 Off-Peak", ''],
  ['Powershop', "AURORA ENERGY LIMITED", "00:00 Off-Peak; 07:00 Peak; 12:00 Off-Peak; 17:00 Peak; 22:00 Off-Peak", "", ''],
  ['Powershop', "UNISON NETWORKS LIMITED", "00:00 Off-Peak; 07:00 Peak; 11:00 Shoulder; 17:00 Peak; 21:00 Shoulder; 23:00 Off-Peak", "00:00 Off-Peak; 07:00 Week-end Shoulder; 23:00 Off-Peak", ''],
  ['Powershop', "ALPINE ENERGY LIMITED", "00:00 Off-Peak; 07:00 Peak; 23:00 Off-Peak", "", ''],
  ['Powershop', "ORION NEW ZEALAND LIMITED", "00:00 Off-Peak; 03:30 Super Off-Peak; 05:00 Shoulder; 07:00 Peak; 11:30 Shoulder; 17:30 Peak; 22:30 Off-Peak", "00:00 Weekend; 03:30 Super Off-Peak; 05:30 Weekend", ''],
  ['Powershop', "ELECTRICITY ASHBURTON LIMITED", "00:00 Off-Peak; 07:00 Peak; 21:00 Off-Peak", "00:00 Off-Peak", ''],
  ['Powershop', "NETWORK TASMAN LIMITED", "00:00 Off-Peak; 07:00 Peak; 23:00 Off-Peak", "00:00 All Weekend Off-Peak", ''],
  ['Powershop', "HORIZON ENERGY DISTRIBUTION LIMITED TRADING AS HORIZON NETWORKS", "00:00 Night; 07:00 Peak; 11:00 Off-Peak; 17:00 Peak; 21:00 Off-Peak; 23:00 Night", "", ''],
  ['Powershop', "ELECTRICITY INVERCARGILL LIMITED", "00:00 Night; 07:00 Peak; 11:00 Off-Peak; 17:00 Peak; 21:00 Off-Peak; 23:00 Night", "", ''],
  ['Powershop', "FIRSTLIGHT NETWORK LIMITED", "00:00 Off-Peak; 07:00 Peak; 11:00 Off-Peak; 17:00 Peak; 21:00 Off-Peak", "00:00 Off-Peak", ''],
  ['Powershop', "NELSON ELECTRICITY LIMITED", "00:00 Off-Peak; 07:00 Peak; 23:30 Off-Peak", "00:00 All Weekend Off-Peak", ''],
  ['Powershop', "MARLBOROUGH LINES LIMITED", "00:00 Off-Peak; 07:00 Peak; 11:30 Off-Peak; 17:30 Peak; 21:30 Off-Peak", "00:00 All Weekend Off-Peak", ''],
  ['Powershop', "WESTPOWER LIMITED", "00:00 Night; 07:00 Day; 23:00 Night", "", ''],
];

/**
 * Parse "00:00 Night; 07:00 Peak; ..." into segments and a 48-slot
 * band array. Returns { ok, error, segs: [{start, band}], slots }.
 * Rules: first start is 00:00; starts strictly increase; every start
 * is on a half-hour; a band name is required.
 */
function bandParse_(str) {
  const out = { ok: false, error: '', segs: [], slots: [] };
  const parts = String(str || '').split(/[;\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) { out.error = 'no bands given'; return out; }
  if (parts.length > BAND_MAX_SEGMENTS) { out.error = 'more than ' + BAND_MAX_SEGMENTS + ' entries'; return out; }
  let prev = -1;
  for (const p of parts) {
    const m = p.match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
    if (!m) { out.error = 'cannot read "' + p + '" (expected HH:mm Band)'; return out; }
    const mins = (+m[1]) * 60 + (+m[2]);
    const band = m[3].replace(/\s+/g, ' ').trim().slice(0, 40);
    if ((+m[1]) > 23 || ((+m[2]) !== 0 && (+m[2]) !== 30)) { out.error = '"' + m[1] + ':' + m[2] + '" is not on a half-hour'; return out; }
    if (mins <= prev) { out.error = 'start times must increase (' + m[1] + ':' + m[2] + ')'; return out; }
    if (!band) { out.error = 'band name missing'; return out; }
    out.segs.push({ start: mins, band: band });
    prev = mins;
  }
  if (out.segs[0].start !== 0) { out.error = 'the first band must start at 00:00'; return out; }
  let si = 0;
  for (let slot = 0; slot < 48; slot++) {
    while (si + 1 < out.segs.length && out.segs[si + 1].start <= slot * 30) si++;
    out.slots.push(out.segs[si].band);
  }
  out.ok = true;
  return out;
}

function bandFormat_(segs) {
  return segs.map(function (s) {
    return ('0' + Math.floor(s.start / 60)).slice(-2) + ':' + ('0' + (s.start % 60)).slice(-2) + ' ' + s.band;
  }).join('; ');
}

/** Tab, created and seeded on first use (additive; never re-seeds a tab that has rows). */
function bandRegisterSheet_() {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  let sheet = ss.getSheetByName(BAND_REGISTER_TAB);
  if (!sheet) sheet = ss.insertSheet(BAND_REGISTER_TAB);
  if (!sheet.getRange(1, 1).getValue()) {
    sheet.getRange(1, 1, 1, BAND_REGISTER_HEADERS.length).setValues([BAND_REGISTER_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    const now = new Date();
    const rows = BAND_SEED.map(function (r) {
      return [r[0], r[1], r[2], r[3], r[4],
        r[4] === BAND_STATUS_UNVERIFIED ? BAND_SEED_NOTE_UNVERIFIED : BAND_SEED_NOTE, '', now, 'seed'];
    });
    sheet.getRange(2, 1, rows.length, BAND_REGISTER_HEADERS.length).setValues(rows);
  }
  return sheet;
}

function bandDateStr_(v, withTime) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Pacific/Auckland', withTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
  return String(v || '').trim();
}

/** Register rows as plain objects, in sheet order, each with its parse result. */
function bandRegisterLoad_() {
  const sheet = bandRegisterSheet_();
  const n = sheet.getLastRow() - 1;
  const out = [];
  if (n < 1) return out;
  const vals = sheet.getRange(2, 1, n, BAND_REGISTER_HEADERS.length).getValues();
  for (let i = 0; i < n; i++) {
    const r = vals[i];
    const retailer = String(r[0] || '').trim();
    const network = String(r[1] || '').trim();
    if (!retailer && !network) continue;
    const wd = bandParse_(r[2]);
    const weRaw = String(r[3] || '').trim();
    const we = weRaw ? bandParse_(weRaw) : wd;
    out.push({
      row: i + 2,
      retailer: retailer, network: network,
      weekday: String(r[2] || '').trim(), weekend: weRaw,
      status: String(r[4] || '').trim().toUpperCase(),
      note: String(r[5] || '').trim(),
      lastChecked: bandDateStr_(r[6], false),
      updatedAt: bandDateStr_(r[7], true),
      updatedBy: String(r[8] || '').trim(),
      ok: wd.ok && we.ok,
      error: !wd.ok ? 'weekday: ' + wd.error : (!we.ok ? 'weekend: ' + we.error : ''),
      wdSlots: wd.ok ? wd.slots : [],
      weSlots: we.ok ? we.slots : [],
    });
  }
  return out;
}

/** Client: the whole register (it is small). */
function apiBandRegister() {
  return { rows: bandRegisterLoad_(), seasons: bandSeasonsLoad_(), maxSegments: BAND_MAX_SEGMENTS };
}

// Seasons per retailer (v2.19): which months are Winter. Tab "Band
// Seasons": retailer | winter months (1-12, comma separated) | updated
// at | updated by. A retailer with no row uses April-September.
const BAND_SEASONS_TAB = 'Band Seasons';
const BAND_SEASONS_HEADERS = ['retailer', 'winter months', 'updated at', 'updated by'];

function bandSeasonsSheet_() {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  let sheet = ss.getSheetByName(BAND_SEASONS_TAB);
  if (!sheet) sheet = ss.insertSheet(BAND_SEASONS_TAB);
  if (!sheet.getRange(1, 1).getValue()) {
    sheet.getRange(1, 1, 1, BAND_SEASONS_HEADERS.length).setValues([BAND_SEASONS_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** { retailer: "4,5,6,7,8,9" } - the last row for a retailer wins. */
function bandSeasonsLoad_() {
  const sheet = bandSeasonsSheet_();
  const out = {};
  const n = sheet.getLastRow() - 1;
  if (n < 1) return out;
  const vals = sheet.getRange(2, 1, n, 2).getValues();
  for (const r of vals) {
    const name = String(r[0] || '').trim();
    if (name) out[name] = String(r[1] || '').trim();
  }
  return out;
}

/** Save a retailer's winter months (numbers 1-12). Both seasons must keep at least one month. */
function apiBandSeasonSave(retailer, months) {
  const name = String(retailer || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw new Error('Retailer is required.');
  const seen = {};
  for (const m of months || []) { const n = Number(m); if (n >= 1 && n <= 12 && n === Math.floor(n)) seen[n] = true; }
  const list = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  if (!list.length || list.length === 12) throw new Error('Winter needs at least one month and at most eleven.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = bandSeasonsSheet_();
    let operator = '';
    try { operator = Session.getActiveUser().getEmail(); } catch (err) {}
    const n = sheet.getLastRow() - 1;
    let target = 0;
    if (n >= 1) {
      const vals = sheet.getRange(2, 1, n, 1).getValues();
      for (let i = 0; i < n; i++) if (String(vals[i][0] || '').trim().toUpperCase() === name.toUpperCase()) target = i + 2;
    }
    const rowVals = [name, list.join(','), new Date(), operator];
    if (target) sheet.getRange(target, 1, 1, 4).setValues([rowVals]);
    else sheet.appendRow(rowVals);
    SpreadsheetApp.flush();
    return { ok: true, rows: bandRegisterLoad_(), seasons: bandSeasonsLoad_() };
  } finally {
    lock.releaseLock();
  }
}

function bandKey_(retailer, network) {
  return String(retailer || '').trim().toUpperCase() + '|' + String(network || '').trim().toUpperCase();
}

/**
 * Save one register row (add or edit). entry: { retailer, network,
 * weekday, weekend, unverified, note, checkedToday }.
 * origKey: { retailer, network } of the row being edited (null = new).
 * Both schedules are validated; a retailer x network pair is unique.
 */
function apiBandRegisterSave(entry, origKey) {
  const e = entry || {};
  const retailer = String(e.retailer || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const network = String(e.network || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!retailer) throw new Error('Retailer is required.');
  if (!network) throw new Error('Network is required.');
  const wd = bandParse_(e.weekday);
  if (!wd.ok) throw new Error('Weekday bands: ' + wd.error + '.');
  let weekend = '';
  if (String(e.weekend || '').trim()) {
    const we = bandParse_(e.weekend);
    if (!we.ok) throw new Error('Weekend bands: ' + we.error + '.');
    weekend = bandFormat_(we.segs);
    if (weekend === bandFormat_(wd.segs)) weekend = '';
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = bandRegisterSheet_();
    const rows = bandRegisterLoad_();
    const newKey = bandKey_(retailer, network);
    const oKey = origKey ? bandKey_(origKey.retailer, origKey.network) : '';
    let target = null;
    for (const r of rows) {
      const k = bandKey_(r.retailer, r.network);
      if (oKey && k === oKey) target = r;
    }
    if (oKey && !target) throw new Error('The row being edited is no longer in the register - reload and try again.');
    for (const r of rows) {
      if (bandKey_(r.retailer, r.network) === newKey && r !== target) {
        throw new Error(retailer + ' already has a schedule for ' + network + ' - edit that row instead.');
      }
    }
    let operator = '';
    try { operator = Session.getActiveUser().getEmail(); } catch (err) {}
    const now = new Date();
    const lastChecked = e.checkedToday ? now : (target ? sheet.getRange(target.row, 7).getValue() : '');
    const rowVals = [retailer, network, bandFormat_(wd.segs), weekend,
      e.unverified ? BAND_STATUS_UNVERIFIED : '', String(e.note || '').trim().slice(0, 300),
      lastChecked, now, operator];
    if (target) sheet.getRange(target.row, 1, 1, rowVals.length).setValues([rowVals]);
    else sheet.appendRow(rowVals);
    SpreadsheetApp.flush();
    return { ok: true, rows: bandRegisterLoad_(), seasons: bandSeasonsLoad_() };
  } finally {
    lock.releaseLock();
  }
}

/** Record that a row was re-checked against the retailer's page today. */
function apiBandRegisterChecked(retailer, network) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = bandRegisterSheet_();
    const key = bandKey_(retailer, network);
    let hit = null;
    for (const r of bandRegisterLoad_()) if (bandKey_(r.retailer, r.network) === key) hit = r;
    if (!hit) throw new Error('That row is no longer in the register.');
    let operator = '';
    try { operator = Session.getActiveUser().getEmail(); } catch (err) {}
    const now = new Date();
    sheet.getRange(hit.row, 7, 1, 3).setValues([[now, now, operator]]);
    SpreadsheetApp.flush();
    return { ok: true, rows: bandRegisterLoad_(), seasons: bandSeasonsLoad_() };
  } finally {
    lock.releaseLock();
  }
}

/** Remove one register row. */
function apiBandRegisterDelete(retailer, network) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = bandRegisterSheet_();
    const key = bandKey_(retailer, network);
    let hit = null;
    for (const r of bandRegisterLoad_()) if (bandKey_(r.retailer, r.network) === key) hit = r;
    if (!hit) throw new Error('That row is no longer in the register.');
    sheet.deleteRows(hit.row, 1);
    SpreadsheetApp.flush();
    return { ok: true, rows: bandRegisterLoad_(), seasons: bandSeasonsLoad_() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Slot matrix for one ICP-register's half-hourly records (already
 * filtered to the analysis window): kWh by day type (weekday /
 * weekend), calendar month and half-hour slot of the interval START.
 *   m[dayType * 576 + month * 48 + slot], dayType 0 = Mon-Fri, 1 = Sat/Sun
 * Public holidays are ordinary days (as in the HHR v2.0 sheet).
 * days = covered days (sum of interval lengths), the same basis as
 * the AVM, so the bands add up to the AVM and annual figures.
 */
function bandSlotMatrix_(hhRecs) {
  if (!hhRecs || !hhRecs.length) return null;
  const m = new Array(1152).fill(0);
  let days = 0, total = 0;
  for (const r of hhRecs) {
    const s = r.periodStart;
    const dow = s.getDay();
    const dt = (dow === 0 || dow === 6) ? 1 : 0;
    const slot = Math.min(47, Math.floor((s.getHours() * 60 + s.getMinutes()) / 30));
    m[dt * 576 + s.getMonth() * 48 + slot] += r.kWh;
    days += (r.periodEnd - r.periodStart) / 86400000;
    total += r.kWh;
  }
  for (let i = 0; i < m.length; i++) m[i] = Math.round(m[i] * 1000) / 1000;
  return { m: m, days: Math.round(days * 10000) / 10000, totalKwh: Math.round(total * 1000) / 1000 };
}
