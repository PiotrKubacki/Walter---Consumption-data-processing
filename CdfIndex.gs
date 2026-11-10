// =====================================================
// Walter - CDF Index + Archive search (v2.14, 10 Nov 2026)
// -----------------------------------------------------
// Every finished session leaves one CDF (Consumption Data
// File) in the output folder. The CDF Index tab records
// one row per CDF, written at Finish, so a file can be
// found again by customer id, name or ICP from the
// Archive tab. Retrieval goes through this index, not
// through a folder tree, and the files no longer need to
// be loaded to Betty to be findable.
//
// The index covers files finished from v2.14.0 onwards
// only; older CDFs are not backfilled (decided 11 Nov).
// No retention rule: usage is monitored (see apiCdfTotals)
// and decided on later.
//
// Rows are appended (appendRow is atomic). The only edit
// the app ever makes to a row is marking it deleted
// (v2.15, 11 Nov): any operator can delete a CDF from the
// Archive tab. The file goes to the Drive bin; the index
// row STAYS and records when, who and why. File size is recorded so storage use
// is measured rather than guessed.
// =====================================================

const CDF_INDEX_TAB = 'CDF Index';
const CDF_INDEX_HEADERS = ['date', 'customer id', 'registered name', 'trading name',
  'prospect (Y/N)', 'icp count', 'icps', 'operator', 'file name', 'file id', 'url', 'size bytes',
  'deleted at', 'deleted by', 'delete reason'];

function cdfIndexSheet_() {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  let sheet = ss.getSheetByName(CDF_INDEX_TAB);
  if (!sheet) sheet = ss.insertSheet(CDF_INDEX_TAB);
  if (!sheet.getRange(1, 1).getValue()) {
    sheet.getRange(1, 1, 1, CDF_INDEX_HEADERS.length).setValues([CDF_INDEX_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  // Additive columns (v2.15): deleted at / deleted by / delete reason.
  if (!sheet.getRange(1, 13).getValue()) {
    sheet.getRange(1, 13, 1, 3).setValues([CDF_INDEX_HEADERS.slice(12, 15)]).setFontWeight('bold');
  }
  return sheet;
}

/**
 * Delete a CDF from the Archive (11 Nov). Decided by Peter:
 *   - the Drive file goes to the BIN (recoverable there), never a
 *     permanent delete;
 *   - any operator may do it;
 *   - the index row is kept and marked: deleted at, deleted by, and
 *     the reason the operator typed (required).
 * Only a file that is in the index, is named "CDF - ...", and is not
 * already marked deleted can be removed here. If the file is already
 * gone from Drive the row is still marked, so the record is truthful.
 */
function apiCdfDelete(fileId, reason) {
  fileId = String(fileId || '').trim();
  reason = String(reason || '').trim().slice(0, 500);
  if (!fileId) throw new Error('No file given.');
  if (!reason) throw new Error('A reason is required to delete a file.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = cdfIndexSheet_();
    const n = sheet.getLastRow() - 1;
    if (n < 1) throw new Error('That file is not in the CDF Index.');
    const vals = sheet.getRange(2, 1, n, CDF_INDEX_HEADERS.length).getValues();
    const hits = [];
    let already = false;
    for (let i = 0; i < n; i++) {
      if (String(vals[i][9]).trim() !== fileId) continue;
      if (String(vals[i][12] || '').trim() !== '') { already = true; continue; }
      hits.push(i);
    }
    if (!hits.length) {
      throw new Error(already ? 'That file is already marked as deleted.' : 'That file is not in the CDF Index.');
    }
    let name = String(vals[hits[0]][8] || '');
    let fileNote = '';
    let file = null;
    try { file = DriveApp.getFileById(fileId); } catch (e) { fileNote = ' [file was already missing from Drive]'; }
    if (file) {
      name = file.getName();
      if (name.indexOf('CDF - ') !== 0) throw new Error('Not a CDF file: ' + name);
      if (file.isTrashed()) fileNote = ' [file was already in the bin]';
      else file.setTrashed(true);
    }
    let operator = '';
    try { operator = Session.getActiveUser().getEmail(); } catch (e) {}
    const now = new Date();
    for (const i of hits) {
      sheet.getRange(i + 2, 13, 1, 3).setValues([[now, operator, reason + fileNote]]);
    }
    SpreadsheetApp.flush();
    try { CacheService.getScriptCache().remove(CDF_TOTALS_CACHE_KEY); } catch (e) {}
    return { ok: true, name: name, note: fileNote };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Append one index row for a finished session's CDF.
 * meta:   the Finish meta ({customerId, customer, tradingName,
 *         prospect, allIcps, icps})
 * merged: { fileId, name, url }
 */
function cdfIndexAdd_(meta, merged) {
  const icps = [];
  const seen = {};
  const src = (meta.allIcps && meta.allIcps.length) ? meta.allIcps
    : (meta.icps || []).map(function (x) { return x.icp; });
  for (const x of src) {
    const u = String(x || '').trim();
    if (u && !seen[u]) { seen[u] = true; icps.push(u); }
  }
  let size = '';
  try { size = DriveApp.getFileById(merged.fileId).getSize(); } catch (e) {}
  let operator = '';
  try { operator = Session.getActiveUser().getEmail(); } catch (e) {}
  try { CacheService.getScriptCache().remove(CDF_TOTALS_CACHE_KEY); } catch (e) {}
  cdfIndexSheet_().appendRow([
    new Date(),
    meta.prospect ? RFP_PROSPECT_ID : String(meta.customerId || ''),
    String(meta.customer || ''),
    String(meta.tradingName || ''),
    meta.prospect ? 'Y' : '',
    icps.length,
    // A cell holds 50,000 characters (about 2,900 ICPs).
    icps.join(', ').slice(0, 45000),
    operator,
    String(merged.name || ''),
    String(merged.fileId || ''),
    String(merged.url || ''),
    size,
  ]);
}

/**
 * Total storage used by CDF files, for the small print next to the
 * build number (11 Nov). Counted from the output folder itself (every
 * file named "CDF - ..."), not from the index, so files finished
 * before the index existed are included. Cached for 10 minutes; a
 * Finish clears the cache. A very large folder is cut off after 20
 * seconds and reported as "at least".
 */
const CDF_TOTALS_CACHE_KEY = 'cdf_totals_v1';

function apiCdfTotals(force) {
  const cache = CacheService.getScriptCache();
  if (!force) {
    const hit = cache.get(CDF_TOTALS_CACHE_KEY);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }
  const started = Date.now();
  const out = { count: 0, bytes: 0, partial: false };
  const files = DriveApp.getFolderById(requireConfig_('output_folder_id')).getFiles();
  while (files.hasNext()) {
    if (Date.now() - started > 20000) { out.partial = true; break; }
    const f = files.next();
    if (f.getName().indexOf('CDF - ') !== 0) continue;
    if (f.isTrashed()) continue; // Drive iterators include binned files
    out.count++;
    out.bytes += f.getSize();
  }
  try { cache.put(CDF_TOTALS_CACHE_KEY, JSON.stringify(out), 600); } catch (e) {}
  return out;
}

/**
 * Archive search. q matches (case-insensitive, substring) against
 * customer id, registered name, trading name, file name and every
 * ICP in the file. A blank q returns the most recent files.
 * Newest first, capped at 50.
 */
function apiCdfSearch(q) {
  const sheet = cdfIndexSheet_();
  const out = { rows: [], total: 0, totalBytes: 0, matched: 0, deletedCount: 0, q: String(q || '').trim() };
  if (sheet.getLastRow() < 2) return out;
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, CDF_INDEX_HEADERS.length).getValues();
  const needle = out.q.toLowerCase();
  for (let i = vals.length - 1; i >= 0; i--) {
    const r = vals[i];
    if (!String(r[9] || '').trim() && !String(r[8] || '').trim()) continue;
    // Deleted files stay in the index as a record but no longer count
    // towards the live totals.
    const isDeleted = String(r[12] || '').trim() !== '';
    if (isDeleted) out.deletedCount++;
    else { out.total++; out.totalBytes += Number(r[11]) || 0; }
    const icps = String(r[6] || '');
    if (needle) {
      const hay = [r[1], r[2], r[3], r[8], icps].join(' | ').toLowerCase();
      if (hay.indexOf(needle) === -1) continue;
    }
    out.matched++;
    if (out.rows.length >= 50) continue;
    const icpList = icps.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    let hitIcps = [];
    if (needle) hitIcps = icpList.filter(function (x) { return x.toLowerCase().indexOf(needle) !== -1; }).slice(0, 5);
    out.rows.push({
      date: r[0] instanceof Date ? Utilities.formatDate(r[0], 'Pacific/Auckland', 'yyyy-MM-dd HH:mm') : String(r[0] || ''),
      customerId: String(r[1] || ''),
      customer: String(r[2] || ''),
      tradingName: String(r[3] || ''),
      prospect: /^y/i.test(String(r[4] || '')),
      icpCount: Number(r[5]) || icpList.length,
      icpSample: icpList.slice(0, 3),
      hitIcps: hitIcps,
      operator: String(r[7] || ''),
      fileName: String(r[8] || ''),
      fileId: String(r[9] || ''),
      url: String(r[10] || ''),
      sizeBytes: Number(r[11]) || 0,
      deleted: isDeleted,
      deletedAt: !isDeleted ? '' : (r[12] instanceof Date
        ? Utilities.formatDate(r[12], 'Pacific/Auckland', 'yyyy-MM-dd HH:mm') : String(r[12])),
      deletedBy: isDeleted ? String(r[13] || '') : '',
      deleteReason: isDeleted ? String(r[14] || '') : '',
    });
  }
  return out;
}
