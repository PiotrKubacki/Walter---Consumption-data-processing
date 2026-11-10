// =====================================================
// Walter - EA bridge (v2.14, 10 Nov 2026)
// -----------------------------------------------------
// Walter's own glue around the EA lookup module. The three
// files EaApi.gs, Flatten.gs and IcpParse.gs are COPIED
// VERBATIM FROM TOBIAS (their line 1 carries the Tobias
// version they came from). Never edit them here: change
// Tobias, then re-copy. Everything Walter-specific lives
// in this file.
//
// There are NO calls between the two apps. Walter asks the
// EA registry itself. What the apps share is cached answers:
//   * Walter WRITES only its own "EA Cache" tab, in Walter's
//     backing sheet, append-only under a script lock (rows
//     are never updated in place; the newest row wins).
//   * Walter READS Tobias's "EA Cache" tab as well, read-only,
//     when Script Property EA_CACHE_SHEET_ID points at the
//     Tobias backing sheet. Tobias updates its rows in place,
//     so Walter never writes there (decided 10 Nov).
//
// Setup (Project Settings -> Script Properties):
//   EA_API_KEY          required for live lookups (EA subscription key)
//   EA_CACHE_SHEET_ID   optional - Tobias backing sheet id
// Without the key Walter still serves cached answers and
// otherwise falls back to the Betty "EA ICPs" import.
// =====================================================

const WT_EA_CACHE_TAB = 'EA Cache';
// Must equal Tobias's TOBIAS_CACHE_SCHEMA for its rows to be reusable.
const WT_EA_CACHE_SCHEMA = 1;
const WT_EA_PROP_TOBIAS_SHEET = 'EA_CACHE_SHEET_ID';

// Name required by EaApi.gs (declared in Tobias's Config.gs, which is
// not copied because Walter has its own Config.gs).
var TB_PROP_API_KEY = 'EA_API_KEY';

// Same keys and defaults as Tobias's Config tab. A row with the same
// key on Walter's Config tab overrides the default.
const WT_EA_DEFAULTS = {
  EA_API_BASE_URL: 'https://emi.azure-api.net/ICPConnectionData/v2/single/?ICP=',
  EA_API_KEY_HEADER: 'Ocp-Apim-Subscription-Key',
  EA_BATCH_SIZE: '10',
  EA_RATE_LIMIT_PER_MIN: '240',
  EA_MAX_RETRIES: '3',
  CACHE_TTL_DAYS: '7',
  TOU_PROFILE_CODES: 'HHR,HSL',
  TOU_MIN_CATEGORY: '3',
};

/** Numeric config helper required by EaApi.gs (same contract as Tobias's). */
function tbCfgNum_(cfg, key, dflt, min) {
  var v = Number(cfg[key]);
  if (isNaN(v)) v = dflt;
  if (typeof min === 'number' && v < min) v = min;
  return v;
}

function eaConfig_() {
  const cfg = {};
  for (const k in WT_EA_DEFAULTS) cfg[k] = WT_EA_DEFAULTS[k];
  let walter = {};
  try { walter = getConfig_(); } catch (e) {}
  for (const k in WT_EA_DEFAULTS) {
    if (walter[k] !== undefined && String(walter[k]).trim() !== '') cfg[k] = String(walter[k]).trim();
  }
  return cfg;
}

function eaKeySet_() {
  return !!PropertiesService.getScriptProperties().getProperty(TB_PROP_API_KEY);
}

let _eaTobiasBook_;
/** Tobias's backing spreadsheet (read-only use), or null when not configured / not reachable. */
function eaTobiasBook_() {
  if (_eaTobiasBook_ !== undefined) return _eaTobiasBook_;
  _eaTobiasBook_ = null;
  const id = String(PropertiesService.getScriptProperties().getProperty(WT_EA_PROP_TOBIAS_SHEET) || '').trim();
  if (id) {
    try { _eaTobiasBook_ = SpreadsheetApp.openById(id); } catch (e) { _eaTobiasBook_ = null; }
  }
  return _eaTobiasBook_;
}

/** Status code -> label. Tobias's Status Codes tab when reachable, else the one confirmed code. */
function eaStatusMap_() {
  const map = { '2': 'Active' };
  try {
    const book = eaTobiasBook_();
    const sh = book ? book.getSheetByName('Status Codes') : null;
    if (sh && sh.getLastRow() > 1) {
      const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues();
      for (const r of vals) {
        const code = String(r[0]).trim();
        if (code) map[code] = String(r[1]).trim();
      }
    }
  } catch (e) {}
  return map;
}

function eaContext_(cfg) {
  return {
    statusMap: eaStatusMap_(),
    touProfiles: String(cfg.TOU_PROFILE_CODES || 'HHR,HSL').toUpperCase().split(/[\s,]+/).filter(Boolean),
    touMinCategory: tbCfgNum_(cfg, 'TOU_MIN_CATEGORY', 3, 1),
    now: new Date(),
  };
}

/** Walter's own cache tab (created on first use, same column contract as Tobias's). */
function eaWalterCacheSheet_() {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  let sh = ss.getSheetByName(WT_EA_CACHE_TAB);
  if (!sh) {
    sh = ss.insertSheet(WT_EA_CACHE_TAB);
    sh.getRange(1, 1, 1, TB_CACHE_HEADERS.length).setValues([TB_CACHE_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Scan one cache tab for the wanted ICPs. The newest usable row per
 * ICP wins, across tabs too (hits is shared between scans). Old error
 * rows are never served.
 */
function eaCacheScan_(sheet, wanted, cutoff, hits, source) {
  if (!sheet) return;
  const last = sheet.getLastRow();
  if (last < 2) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const jsonCol = headers.indexOf('JSON') + 1;
  if (jsonCol < 1) return;
  const n = last - 1;
  const idx = sheet.getRange(2, 1, n, 5).getValues(); // ICP, Fetched At, HTTP, Result, Schema
  // One bulk read of the JSON column while the tab is small; per-row
  // reads once it is large (the column can run to several MB).
  const jsonAll = n <= 1500 ? sheet.getRange(2, jsonCol, n, 1).getValues() : null;
  for (let i = 0; i < n; i++) {
    const icp = String(idx[i][0]).trim().toUpperCase();
    if (!wanted[icp]) continue;
    const fetchedAt = idx[i][1] instanceof Date ? idx[i][1].toISOString() : String(idx[i][1]);
    const ts = Date.parse(fetchedAt);
    if (isNaN(ts) || ts < cutoff) continue;
    if (Number(idx[i][4]) !== WT_EA_CACHE_SCHEMA) continue;
    const kind = String(idx[i][3]);
    if (kind === TB_RESULT.ERROR) continue;
    if (hits[icp] && hits[icp].ts >= ts) continue;
    let record = null;
    if (kind === TB_RESULT.FOUND) {
      const raw = String((jsonAll ? jsonAll[i][0] : sheet.getRange(i + 2, jsonCol).getValue()) || '');
      if (!raw) continue;
      try { record = JSON.parse(raw); } catch (e) { continue; }
    }
    hits[icp] = { icp: icp, http: Number(idx[i][2]) || 0, kind: kind, record: record,
      message: '', fetchedAt: fetchedAt, ts: ts, source: source };
  }
}

/** Append live results to Walter's cache tab. Append-only; errors are not cached. */
function eaCacheAppend_(results, ctx) {
  const rows = [];
  for (const res of results) {
    if (res.kind === TB_RESULT.ERROR) continue;
    const flat = res.record ? tbFlattenRecord(res.record, ctx) : null;
    const row = tbCacheRowFromResult(res, flat, WT_EA_CACHE_SCHEMA);
    // A Sheets cell holds 50,000 characters; an oversize record is
    // stored without its JSON and simply re-fetched next time.
    if (String(row[row.length - 1]).length > 49000) row[row.length - 1] = '';
    rows.push(row);
  }
  if (!rows.length) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = eaWalterCacheSheet_();
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Look ICPs up: cache first, live EA registry for the rest (paced to
 * the EA rate limit, inside a time budget so a big list cannot hit
 * the 6-minute execution limit).
 * @param {string[]} icps
 * @param {{force:boolean, budgetMs:number}} opts
 * @return {{results:Object, keySet:boolean, fromCache:number, liveCalls:number,
 *           notFetched:string[], error:string, cacheError:string}}
 *   results: icp -> { icp, kind, record|null, message, fetchedAt, source }
 */
function eaLookup_(icps, opts) {
  opts = opts || {};
  const started = Date.now();
  const budgetMs = opts.budgetMs || 200000;
  const cfg = eaConfig_();
  const out = { results: {}, keySet: eaKeySet_(), fromCache: 0, liveCalls: 0,
    notFetched: [], error: '', cacheError: '' };

  const clean = [];
  const seen = {};
  for (const x of icps || []) {
    const u = String(x || '').trim().toUpperCase();
    if (!u || seen[u]) continue;
    seen[u] = true;
    if (TB_ICP_RE.test(u)) clean.push(u);
    else out.results[u] = { icp: u, kind: TB_RESULT.INVALID, record: null,
      message: 'Not an electricity ICP shape', fetchedAt: '', source: 'local' };
  }
  if (!clean.length) return out;

  const wanted = {};
  for (const i of clean) wanted[i] = true;
  const hits = {};
  if (!opts.force) {
    const cutoff = Date.now() - tbCfgNum_(cfg, 'CACHE_TTL_DAYS', 7, 0) * 86400000;
    try { eaCacheScan_(eaWalterCacheSheet_(), wanted, cutoff, hits, 'cache'); } catch (e) {}
    try {
      const book = eaTobiasBook_();
      if (book) eaCacheScan_(book.getSheetByName(WT_EA_CACHE_TAB), wanted, cutoff, hits, 'tobias cache');
    } catch (e) {}
  }
  for (const icp in hits) { out.results[icp] = hits[icp]; out.fromCache++; }

  const toFetch = clean.filter(i => !hits[i]);
  if (!toFetch.length) return out;
  if (!out.keySet) { out.notFetched = toFetch; return out; }

  const ctx = eaContext_(cfg);
  const size = tbCfgNum_(cfg, 'EA_BATCH_SIZE', 10, 1);
  const perMin = tbCfgNum_(cfg, 'EA_RATE_LIMIT_PER_MIN', 240, 10);
  const minBatchMs = Math.ceil(60000 / perMin * size);
  const batches = tbChunk(toFetch, size);
  for (let b = 0; b < batches.length; b++) {
    if (Date.now() - started > budgetMs) {
      for (let k = b; k < batches.length; k++) out.notFetched = out.notFetched.concat(batches[k]);
      break;
    }
    const t0 = Date.now();
    let live;
    try {
      live = tbEaFetchMany_(batches[b], cfg);
    } catch (e) {
      out.error = String(e.message || e);
      for (let k = b; k < batches.length; k++) out.notFetched = out.notFetched.concat(batches[k]);
      break;
    }
    out.liveCalls += live.length;
    for (const r of live) { r.source = 'live'; out.results[r.icp] = r; }
    try { eaCacheAppend_(live, ctx); } catch (e) { out.cacheError = String(e.message || e); }
    if (b < batches.length - 1) {
      const spent = Date.now() - t0;
      if (spent < minBatchMs) Utilities.sleep(minBatchMs - spent);
    }
  }
  return out;
}

/**
 * One lookup result as the fields Walter uses. The address is built
 * the way the retailer sample files have it (unit, number, street,
 * suburb, town) so it matches what the Betty import produced.
 */
function eaDetail_(res, ctx) {
  const d = { icp: res.icp, kind: res.kind, source: res.source || '', fetchedAt: res.fetchedAt || '',
    trader: '', traderId: '', address: '', poc: '', network: '', status: '',
    tou: '', touDetail: '', flags: [], message: res.message || '' };
  if (res.kind === TB_RESULT.FOUND && res.record) {
    const flat = tbFlattenRecord(res.record, ctx);
    const a = res.record.Address || {};
    d.trader = flat.row.trader;
    d.traderId = flat.row.traderId;
    d.poc = flat.row.poc;
    d.network = flat.row.network;
    d.status = flat.row.status;
    d.tou = flat.tou.verdict;
    d.touDetail = flat.tou.detail;
    d.flags = flat.flags.slice();
    d.address = [a.PhysicalAddressUnit, a.PhysicalAddressNumber, a.PhysicalAddressStreet,
      a.PhysicalAddressSuburb, a.PhysicalAddressTown].map(tbStr_).filter(Boolean).join(', ');
  } else if (res.kind === TB_RESULT.NOT_FOUND) {
    d.flags = ['Not in EA registry: gas or typo'];
  } else if (res.kind === TB_RESULT.INVALID) {
    d.flags = ['Rejected by EA: ' + (res.message || 'invalid ICP')];
  } else {
    d.flags = ['EA lookup error' + (res.message ? ': ' + res.message : '')];
  }
  return d;
}

/**
 * Client endpoint: EA details for a chunk of ICPs (the Workbench
 * calls this in chunks of 20). No secrets leave the server.
 */
function apiEaLookup(icps) {
  const list = (icps || []).slice(0, 40);
  const r = eaLookup_(list, { budgetMs: 120000 });
  const ctx = eaContext_(eaConfig_());
  const rows = {};
  for (const icp in r.results) rows[icp] = eaDetail_(r.results[icp], ctx);
  return { keySet: r.keySet, rows: rows, fromCache: r.fromCache, liveCalls: r.liveCalls,
    notFetched: r.notFetched, error: r.error };
}
