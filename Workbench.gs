// =====================================================
// CDP App - Workbench (per-customer session view)
// -----------------------------------------------------
// Operator-driven flow replacing the folder-queue habit:
// files for ONE customer arrive by drag-drop/file-picker
// (browser upload) or by pasted Drive link/ID (server-side
// copy). Session files live in a '.cdp-work' subfolder of
// the upload folder and are trashed when the session is
// finished or cleared. Analysis reuses the existing engine
// (apiPrepareFile / analyseFromCache_) unchanged.
//
// Proposal notes: Header + Current sections composed in a
// form, rendered between Betty's **----------**----------**
// markers, copied to the clipboard client-side and ALWAYS
// appended to the Notes Log tab (clipboard-malfunction
// recovery + de facto proposal audit trail).
// =====================================================

let _workFolder_ = null;
function getWorkFolder_() {
  if (_workFolder_) return _workFolder_;
  const parent = DriveApp.getFolderById(requireConfig_('upload_folder_id'));
  const it = parent.getFoldersByName('.cdp-work');
  _workFolder_ = it.hasNext() ? it.next() : parent.createFolder('.cdp-work');
  return _workFolder_;
}

/**
 * Browser upload (drag-drop or file picker). Saves the file
 * exactly as received into the work folder, then sniffs it.
 */
function apiWbUpload(base64Data, fileName, mimeType) {
  const blob = Utilities.newBlob(
    Utilities.base64Decode(base64Data),
    mimeType || 'application/octet-stream',
    fileName || 'upload.bin'
  );
  const file = getWorkFolder_().createFile(blob);
  return wbFileInfo_(file);
}

/**
 * Pasted Drive link or bare file ID. The source file is COPIED
 * into the work folder; the original is never touched.
 */
function apiWbAddDriveFile(idOrUrl) {
  const m = String(idOrUrl || '').match(/[-\w]{25,}/);
  if (!m) throw new Error('No Drive file ID found in: ' + idOrUrl);
  const src = DriveApp.getFileById(m[0]);
  // v2.33: a big EIEP book linked from Drive is split per ICP here, the
  // way the browser splits an uploaded one (one tab of 555k rows would
  // never fit a CDF workbook). The original is never touched.
  if (src.getSize() > WB_SPLIT_MB_ * 1024 * 1024 && /\.(csv|txt)$/i.test(src.getName())) {
    const res = eiepSplitText_(src.getBlob().getDataAsString(), src.getName());
    if (!res.error) {
      const folder = getWorkFolder_();
      const files = res.files.map(p => wbFileInfo_(folder.createFile(p.name, p.text, MimeType.CSV)));
      return { files: files, note: src.getName() + ' (' + Math.round(src.getSize() / 1048576) + ' MB) was split into ' + files.length + ' files, one per ICP.' };
    }
  }
  const copy = src.makeCopy(src.getName(), getWorkFolder_());
  return wbFileInfo_(copy);
}

const WB_SPLIT_MB_ = 10; // same threshold as the browser's WB_SPLIT_MB

/**
 * v2.33: split an EIEP ICPCONS / ICPSUMM file into one file per ICP.
 * IDENTICAL to eiepSplitText in Index.html (pure ES5; a test checks the
 * two give the same output) - change both or neither. Every part carries
 * the file's head rows (HDR, the v1.4 DET label row, the ICPSUMM DES
 * row) with the HDR record count rewritten, then that ICP's DET rows in
 * file order. Returns { files: [{ name, text, icp, rows }], icps, error }.
 */
function eiepSplitText_(text, baseName) {
  var out = { files: [], icps: 0, error: '' };
  var lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);
  var head = [], hdrAt = -1, icpCol = 2, format = '';
  var first = -1;
  var fieldsOf = function (line) { return line.split(','); };
  var isLabelRow = function (fs) {
    var j = fs.slice(1).join(',').toLowerCase();
    return j.indexOf('icp') !== -1 && (j.indexOf('period_start') !== -1 || j.indexOf('consumption') !== -1);
  };
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (!ln || !ln.replace(/\s/g, '')) continue;
    var fs = fieldsOf(ln);
    var t = String(fs[0] || '').trim().toUpperCase();
    if (t === 'HDR') {
      format = String(fs[1] || '').trim().toUpperCase();
      if (format !== 'ICPCONS' && format !== 'ICPSUMM') { out.error = 'Not an EIEP consumption file (HDR says ' + (fs[1] || '?') + ').'; return out; }
      hdrAt = head.length; head.push(ln); continue;
    }
    if (t === 'DES') {
      for (var d = 1; d < fs.length; d++) if (String(fs[d]).toLowerCase().indexOf('icp') !== -1) { icpCol = d; break; }
      head.push(ln); continue;
    }
    if (t === 'DET' && isLabelRow(fs)) {
      for (var l = 1; l < fs.length; l++) if (String(fs[l]).trim().toLowerCase() === 'icp') { icpCol = l; break; }
      head.push(ln); continue;
    }
    if (t === 'DET') { first = i; break; }
    head.push(ln); // anything else before the data is kept as head
  }
  if (hdrAt === -1) { out.error = 'No HDR row - not an EIEP file, so Walter cannot split it by ICP.'; return out; }
  if (first === -1) { out.error = 'No DET rows in the file.'; return out; }
  var byIcp = {}, order = [];
  for (var r = first; r < lines.length; r++) {
    var row = lines[r];
    if (!row || !row.replace(/\s/g, '')) continue;
    var fr = fieldsOf(row);
    if (String(fr[0] || '').trim().toUpperCase() !== 'DET') continue; // stray rows are dropped - never guessed into an ICP
    var icp = String(fr[icpCol] || '').trim() || '(blank ICP)';
    if (!byIcp[icp]) { byIcp[icp] = []; order.push(icp); }
    byIcp[icp].push(row);
  }
  out.icps = order.length;
  if (order.length < 2) { out.error = 'The file has ' + (order.length ? 'one ICP' : 'no ICP') + ', so it cannot be split by ICP.'; return out; }
  var base = String(baseName || 'file').replace(/\.[^.]+$/, '');
  for (var o = 0; o < order.length; o++) {
    var rows = byIcp[order[o]];
    var h = head.slice();
    var hf = fieldsOf(h[hdrAt]);
    if (hf.length > 8) { hf[8] = String(rows.length); h[hdrAt] = hf.join(','); }
    out.files.push({ name: base + ' - ' + order[o] + '.csv', text: h.concat(rows).join('\r\n') + '\r\n', icp: order[o], rows: rows.length });
  }
  return out;
}

function wbFileInfo_(file) {
  let format = 'UNKNOWN';
  try { format = sniffFormatFast_(file); } catch (e) { format = 'UNREADABLE'; }
  return {
    id: file.getId(),
    name: file.getName(),
    sizeBytes: file.getSize(),
    format: format,
    previewUrl: 'https://drive.google.com/file/d/' + file.getId() + '/preview',
  };
}

/**
 * Analyse the session's files: same engine as the batch view.
 * Returns the analyseFromCache_ result; the client groups by
 * customer and warns when more than one customer is present.
 */
function apiWbAnalyse(fileIds) {
  for (const id of fileIds || []) { try { apiPrepareFile(id); } catch (e) {} }
  const res = analyseFromCache_(fileIds || []);
  try { res.retailerMap = loadRetailerCodes_(); } catch (e) { res.retailerMap = {}; }
  return res;
}

/** trader id -> display name, from the operator-editable Retailer Codes tab. */
function loadRetailerCodes_() {
  const sheet = SpreadsheetApp.openById(getConfig_()._backingId).getSheetByName('Retailer Codes');
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (const r of vals) {
    const code = String(r[0] || '').trim().toUpperCase();
    if (code) map[code] = String(r[1] || '').trim();
  }
  return map;
}

/** Queue the session's ICPs for bulk pricing NOW, without finishing. */
function apiWbQueueOnly(meta) {
  const q = wbQueueBulkQuote_(meta, '');
  return { queued: q.queued, duplicates: q.duplicates, skippedIcps: q.skipped, reClosed: q.reClosed };
}

/**
 * Finish/clear the session: trash the working copies and any
 * INSPECT copies made from them. Originals elsewhere in Drive
 * are untouched (we only ever copied them in).
 */
function apiWbFinish(fileIds) {
  const trashed = [];
  for (const id of fileIds || []) {
    try {
      const f = DriveApp.getFileById(id);
      const name = f.getName();
      f.setTrashed(true);
      trashed.push(name);
      const inspects = getCacheFolder_().getFilesByName('INSPECT - ' + name);
      while (inspects.hasNext()) inspects.next().setTrashed(true);
      // Orphaned cache entries (extracted text / records) for this file
      const stale = getCacheFolder_().searchFiles("title contains '" + id + "_'");
      while (stale.hasNext()) stale.next().setTrashed(true);
    } catch (e) {}
  }
  return { trashed: trashed };
}

/**
 * Render the proposal notes block (Betty marker-fenced) from the
 * form payload, append it to the Notes Log tab, and return the
 * exact text for the clipboard. Server renders so the log and the
 * clipboard can never disagree.
 */
function apiWbNotes(payload) {
  const p = payload || {};
  const v = (k) => String(p[k] === undefined || p[k] === null ? '' : p[k]).trim();
  // Ticket references go out WITHOUT the "#" (decided 2 Nov):
  // "[#TUC251468]" pasted from the inbox becomes "[TUC251468]".
  const vt = (k) => v(k).replace(/#/g, '');
  // Blank-field defaults (2 Nov, narrowed 3 Nov): CURRENT only —
  // TUC Fee / TUC DD -> "-", other CURRENT blanks -> "nil".
  // HEADER blanks stay blank.
  const vd = (k) => v(k) || 'nil';
  const vtd = (k) => vt(k) || 'nil';
  const vdash = (k) => v(k) || '-';
  const section = String(p.section || 'FULL').toUpperCase();
  const headerLines = [
    'PROPOSAL NOTES:',
    '- all amounts are GST exclusive',
    '- customer id: ' + v('customerId'),
    '- customer: ' + v('customer'),
    '- date: ' + v('date'),
    '- expiry date(s): ' + v('expiryDates'),
    '- analysis type: ' + v('analysisType'),
    '- master ticket: ' + vt('masterTicket'),
    '- retailer(s): ' + v('retailers'),
    '',
    '- billing rate: ' + v('billingRate'),
    '- switching (contract start) date: ' + v('switchingDate'),
    '',
    '- contract duration: ' + v('contractDuration'),
    '- deal type: ' + v('dealType'),
    '- other notes: ' + v('otherNotes'),
  ];
  const currentLines = [
    'CURRENT:',
    '- retailer: ' + vd('curRetailer'),
    '- contract expiry: ' + vd('curContractExpiry'),
    '- break fees: ' + vd('curBreakFees'),
    '- discount: ' + vd('curDiscount'),
    '- source of current rates: ' + vd('curRatesSource'),
    '- inflation: ' + vd('curInflation'),
    '- TUC Fee: ' + vdash('curTucFee'),
    '- TUC DD: ' + vdash('curTucDd'),
    '',
    '- data ticket(s): ' + vtd('curDataTickets'),
  ];
  const body = section === 'HEADER' ? headerLines
    : section === 'CURRENT' ? currentLines
    : headerLines.concat(['']).concat(currentLines);
  // CURRENT alone goes out WITHOUT the Betty marker fence (decided
  // 2 Nov); HEADER and FULL keep the markers Betty parses.
  const text = section === 'CURRENT'
    ? body.join('\n')
    : ['**----------**----------**'].concat(body).concat(['**----------**----------**']).join('\n');

  // Notes Log: always appended, even if the clipboard side fails.
  try {
    const ss = SpreadsheetApp.openById(getConfig_()._backingId);
    const sheet = ss.getSheetByName('Notes Log');
    if (sheet) {
      sheet.appendRow([
        new Date(),
        Session.getActiveUser().getEmail(),
        v('customerId'),
        v('customer'),
        v('files'),
        text,
      ]);
    }
  } catch (e) {}

  return { text: text };
}

// =====================================================
// Finish-off extensions (Oct 2026): consumption archive
// merge + Bulk Quote queue (design: INCOMING-ACCOUNTS-
// PROCESS.md decisions — Customer ID driver, queue rows
// with statuses, duplicate ICPs warn, never replace).
// =====================================================

/**
 * Finish-off runs as CLIENT-DRIVEN STEPS (one server call per file),
 * like the chunked batch analysis — a multi-file merge in a single
 * call hit the 6-minute execution limit and died half-done (observed
 * 2026-10-28, empty orphan workbook left in My Drive root). Steps:
 *   apiWbMergeStart(label)        -> create workbook IN CDP Output
 *   apiWbMergeAdd(mergedId, fileId) x N  -> copy one file's tabs in
 *   apiWbMergeExport(mergedId)    -> xlsx into CDP Output, trash the
 *                                    intermediate workbook
 *   apiWbFinalise(fileIds, meta, url) -> queue Bulk Quote rows, trash
 *                                    working copies
 * A crash mid-way now leaves a partial workbook IN THE OUTPUT FOLDER
 * (visible, resumable), never an orphan in My Drive root.
 * apiWbFinishV2 (plain clear, no meta) remains for the not-analysed
 * path: nothing merged, nothing queued.
 */
function apiWbFinishV2(fileIds, meta) {
  const fin = apiWbFinish(fileIds);
  return { merged: null, queued: 0, duplicates: [], skippedIcps: [], trashed: fin.trashed };
}

/**
 * v2.25: a CDF is built in PARTS when a lot is big. Google caps a
 * workbook at 10 million cells and the xlsx export at 50 MB, so a new
 * part is started when the next file would push the current one past
 * the Config limits (cdf_max_cells, cdf_max_source_mb). Each part
 * carries a hidden ledger tab of the files already in it, which makes
 * a retried or resumed add idempotent.
 */
const CDF_LEDGER_TAB = '_cdp_files';

function wbCdfLimits_() {
  const cfg = getConfig_();
  const cells = Number(cfg.cdf_max_cells);
  const mb = Number(cfg.cdf_max_source_mb);
  return { cells: cells > 0 ? cells : 5000000, bytes: (mb > 0 ? mb : 30) * 1024 * 1024 };
}

function wbCdfLedger_(merged) {
  let s = merged.getSheetByName(CDF_LEDGER_TAB);
  if (!s) {
    s = merged.insertSheet(CDF_LEDGER_TAB);
    s.getRange(1, 1, 1, 4).setValues([['file id', 'name', 'bytes', 'cells']]);
    try { s.hideSheet(); } catch (e) {}
  }
  const out = { sheet: s, ids: {}, files: 0, bytes: 0, cells: 0 };
  const n = s.getLastRow() - 1;
  if (n > 0) {
    for (const r of s.getRange(2, 1, n, 4).getValues()) {
      const id = String(r[0] || '').trim();
      if (!id) continue;
      out.ids[id] = true; out.files++;
      out.bytes += Number(r[2]) || 0; out.cells += Number(r[3]) || 0;
    }
  }
  return out;
}

function apiWbMergeStart(label, part) {
  // CDF = Consumption Data File (renamed from CONS, 9 Nov)
  const name = wbCdfName_(label) + (Number(part) > 1 ? ' - part ' + Number(part) : '');
  const merged = SpreadsheetApp.create(name);
  // Move it straight into CDP Output so nothing ever strands in My Drive root.
  DriveApp.getFileById(merged.getId()).moveTo(DriveApp.getFolderById(requireConfig_('output_folder_id')));
  wbCdfLedger_(merged);
  return { mergedId: merged.getId(), name: name, part: Number(part) || 1 };
}

/**
 * Tab label for one source file in the CDF (10 Nov): the ICP number(s)
 * the file holds, as found by the analysis. Up to five ICPs are listed
 * in full; beyond that the first four plus a count. A file with no
 * ICP found keeps its file name.
 */
function wbCdfTabBase_(icps, fileName) {
  const list = [];
  const seen = {};
  for (const x of icps || []) {
    const u = String(x || '').trim();
    if (u && !seen[u]) { seen[u] = true; list.push(u); }
  }
  if (!list.length) return fileName;
  if (list.length <= 5) return list.join(', ');
  return list.slice(0, 4).join(', ') + ' +' + (list.length - 4) + ' more';
}

/**
 * Add one session file to a CDF part. Returns
 *   { ok, skipped }            the file was already in this part (a retried call)
 *   { ok, full, cells, bytes } NOT added - the part is full, start the next one
 *   { ok, tabs, cells, bytes } added; cells/bytes = the part's running totals
 */
function apiWbMergeAdd(mergedId, fileId, icps) {
  const merged = SpreadsheetApp.openById(mergedId);
  const ledger = wbCdfLedger_(merged);
  if (ledger.ids[fileId]) return { ok: true, skipped: true, cells: ledger.cells, bytes: ledger.bytes };
  const limits = wbCdfLimits_();
  const used = {};
  for (const s of merged.getSheets()) used[s.getName().toLowerCase()] = true;
  const tabName = (base) => {
    let t = String(base).replace(/[\\\/\[\]\*\?:]/g, ' ').slice(0, 90) || 'sheet';
    let n = t, i = 2;
    while (used[n.toLowerCase()]) { n = t.slice(0, 85) + ' (' + (i++) + ')'; }
    used[n.toLowerCase()] = true;
    return n;
  };
  const file = DriveApp.getFileById(fileId);
  const mime = file.getMimeType();
  const bytes = file.getSize();
  // Tabs are named by ICP (10 Nov), not by source file name.
  const base = wbCdfTabBase_(icps, file.getName());
  let tabs = 0;
  let tempId = null;
  // A part that already holds a file takes no more once the next one
  // would cross a limit; an empty part takes anything (a single file
  // over the limit fails loudly at Google's own ceiling).
  const wouldFill = (cells) => ledger.files > 0 &&
    (ledger.cells + cells > limits.cells || ledger.bytes + bytes > limits.bytes);
  const full = () => ({ ok: true, full: true, cells: ledger.cells, bytes: ledger.bytes });
  const record = (cells) => {
    ledger.sheet.appendRow([fileId, file.getName(), bytes, cells]);
    return { ok: true, name: file.getName(), tabs: tabs, cells: ledger.cells + cells, bytes: ledger.bytes + bytes };
  };
  try {
    if (mime === MimeType.GOOGLE_SHEETS || /spreadsheetml|ms-excel/.test(mime)) {
      let ssId = fileId;
      if (mime !== MimeType.GOOGLE_SHEETS) {
        const copy = Drive.Files.copy(
          { name: 'CDP merge temp - ' + file.getName(), mimeType: MimeType.GOOGLE_SHEETS }, fileId);
        ssId = copy.id;
        tempId = copy.id;
      }
      const src = SpreadsheetApp.openById(ssId);
      const sheets = src.getSheets().filter(s => s.getLastRow() > 0);
      // Google counts a sheet's whole grid (max rows x max columns), not just the used cells.
      let cells = 0;
      for (const s of sheets) cells += s.getMaxRows() * s.getMaxColumns();
      if (wouldFill(cells)) return full();
      for (const s of sheets) {
        const copied = s.copyTo(merged);
        copied.setName(tabName(sheets.length > 1
          ? base + ' - ' + s.getName() : base));
        tabs++;
      }
      SpreadsheetApp.flush();
      return record(cells);
    } else {
      // Text/CSV: write the raw rows into a tab, exactly as received.
      let content = file.getBlob().getDataAsString();
      if (content.indexOf('\u0000') !== -1) content = file.getBlob().getDataAsString('UTF-16');
      const lines = content.split(/\r?\n/);
      const rows = [];
      let maxLen = 1;
      for (const line of lines) {
        const f = splitCsvLine_(line);
        if (f.length > maxLen) maxLen = f.length;
        rows.push(f);
      }
      while (rows.length && rows[rows.length - 1].join('') === '') rows.pop();
      // A new tab starts at 1000 x 26 and grows to fit - that is the grid Google counts.
      const cells = rows.length ? Math.max(1000, rows.length) * Math.max(26, maxLen) : 0;
      if (wouldFill(cells)) return full();
      if (rows.length) {
        for (const r of rows) while (r.length < maxLen) r.push('');
        const sheet = merged.insertSheet(tabName(base));
        sheet.getRange(1, 1, rows.length, maxLen).setValues(rows);
        tabs++;
      }
      SpreadsheetApp.flush();
      return record(cells);
    }
  } finally {
    if (tempId) { try { DriveApp.getFileById(tempId).setTrashed(true); } catch (e) {} }
  }
}

/**
 * Best-effort link sharing (9 Nov): ANYONE_WITH_LINK first; when the
 * Workspace admin blocks public links (the call throws), fall back to
 * DOMAIN_WITH_LINK so everyone signed into a TUC account can open and
 * download. Only total failure is reported.
 */
function shareForLinks_(file) {
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return { shared: true, shareError: '' };
  } catch (e1) {
    try {
      file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
      return { shared: true, shareError: '' };
    } catch (e2) {
      return { shared: false, shareError: String(e2.message || e2) };
    }
  }
}

/**
 * v2.27: a small text report built in the browser (the flags report)
 * saved beside the CDFs in CDP Output, link-shared like them.
 */
function apiWbSaveText(name, text, mime) {
  const safe = String(name || 'report').replace(/[\\\/\[\]\*\?:]/g, ' ').slice(0, 120);
  const file = DriveApp.getFolderById(requireConfig_('output_folder_id')).createFile(safe, String(text || ''), mime || MimeType.CSV);
  const sh = shareForLinks_(file);
  return { name: file.getName(), url: file.getUrl(), fileId: file.getId(), shared: sh.shared, shareError: sh.shareError };
}

/** CDF file name: "CDF - <label> - <yyyy-MM-dd>". */
function wbCdfName_(label) {
  const stamp = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd');
  return 'CDF - ' + String(label || 'Unknown customer').replace(/[\\\/\[\]\*\?:]/g, ' ').slice(0, 80) + ' - ' + stamp;
}

/** A cell value that can never turn into a formula when written. */
function wbSafeCell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return isFinite(v) ? v : '';
  const s = String(v);
  return /^[=+\-@]/.test(s) && isNaN(Number(s)) ? "'" + s : s;
}

/**
 * Write the "Analysis" tab as the FIRST tab of the CDF
 * (10 Nov): the session summary, the ICP list with the annual figure
 * that was queued, and the per ICP-register calculations with their
 * flags. The client sends the same data it shows on screen.
 * analysis: { summary: [[label, value]], icpHeader: [], icpRows: [[]],
 *             regHeader: [], regRows: [[]], sections: [{title, rows}] }
 */
function wbWriteAnalysisSheet_(merged, analysis) {
  const a = analysis || {};
  const rows = [];
  const bold = [];
  let operator = '';
  try { operator = Session.getActiveUser().getEmail(); } catch (e) {}
  const push = (r, isBold) => { if (isBold) bold.push(rows.length + 1); rows.push(r); };
  push(['Analysis'], true);
  for (const kv of a.summary || []) push([kv[0], kv[1]]);
  push(['Built', Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm')]);
  push(['Operator', operator]);
  push(['Walter build', (typeof CDP_BUILD === 'undefined') ? '' : CDP_BUILD]);
  push([]);
  push(['ICPs'], true);
  push(a.icpHeader || [], true);
  for (const r of (a.icpRows || []).slice(0, 5000)) push(r);
  push([]);
  push(['ICP-registers (calculations)'], true);
  push(a.regHeader || [], true);
  for (const r of (a.regRows || []).slice(0, 20000)) push(r);
  // v2.16: free-form extra sections (retailer time bands, weighted
  // average rates). Each: { title, rows: [[...]], boldRows: [index] }.
  for (const sec of (a.sections || []).slice(0, 400)) {
    push([]);
    push([sec.title || ''], true);
    const secRows = (sec.rows || []).slice(0, 400);
    const boldSet = {};
    for (const bi of sec.boldRows || []) boldSet[bi] = true;
    for (let si = 0; si < secRows.length; si++) push(secRows[si], !!boldSet[si]);
  }

  let width = 2;
  for (const r of rows) if (r.length > width) width = r.length;
  const grid = rows.map(r => {
    const out = [];
    for (let c = 0; c < width; c++) out.push(wbSafeCell_(r[c]));
    return out;
  });
  let name = 'Analysis';
  let n = 2;
  while (merged.getSheetByName(name)) name = 'Analysis (' + (n++) + ')';
  const sheet = merged.insertSheet(name, 0);
  sheet.getRange(1, 1, grid.length, width).setValues(grid);
  for (const rowNo of bold) sheet.getRange(rowNo, 1, 1, width).setFontWeight('bold');
  sheet.setColumnWidth(1, 190);
}

/**
 * opts (10 Nov, optional): { label, analysis }.
 *   label    - final "<customer id> <name>" for the file name. The
 *              workbook was named when the background merge STARTED;
 *              the customer id/name can be edited after that, so the
 *              name is settled here, at export.
 *   analysis - data for the "Analysis" first tab.
 */
function apiWbMergeExport(mergedId, opts) {
  opts = opts || {};
  const merged = SpreadsheetApp.openById(mergedId);
  const first = merged.getSheets()[0];
  if (merged.getSheets().length > 1 && first.getLastRow() === 0) merged.deleteSheet(first);
  // v2.25: the file ledger is working data, not part of the archive.
  const ledger = merged.getSheetByName(CDF_LEDGER_TAB);
  if (ledger && merged.getSheets().length > 1) merged.deleteSheet(ledger);
  let analysisError = '';
  if (opts.analysis) {
    // The archive is still worth having if this tab cannot be built,
    // but the operator is told (never a silent miss).
    try { wbWriteAnalysisSheet_(merged, opts.analysis); }
    catch (e) { analysisError = String(e.message || e); }
  }
  SpreadsheetApp.flush();
  // v2.25: "- part k of N" when the lot needed more than one workbook.
  const partTxt = Number(opts.parts) > 1 ? ' - part ' + Number(opts.part) + ' of ' + Number(opts.parts) : '';
  const name = (opts.label ? wbCdfName_(opts.label) : merged.getName().replace(/ - part \d+$/, '')) + partTxt;
  const blob = exportXlsx_(mergedId).setName(name + '.xlsx');
  const outFile = DriveApp.getFolderById(requireConfig_('output_folder_id')).createFile(blob);
  try { DriveApp.getFileById(mergedId).setTrashed(true); } catch (e) {}
  // Link sharing (9 Nov): operators clicking the archive links were
  // hitting "request access" — anyone-with-link, with a domain
  // fallback when the admin blocks public links. Failure is surfaced,
  // not swallowed — the links still work for the owner.
  const sh = shareForLinks_(outFile);
  return { name: outFile.getName(), url: outFile.getUrl(), fileId: outFile.getId(),
    sizeBytes: outFile.getSize(), shared: sh.shared, shareError: sh.shareError,
    analysisError: analysisError, part: Number(opts.part) || 1, parts: Number(opts.parts) || 1 };
}

/**
 * merged (10 Nov, optional): { fileId, name, url } of the exported
 * CDF. When given, one row is appended to the CDF Index tab so the
 * file can be found again from the Archive tab without Betty.
 */
function apiWbFinalise(fileIds, meta, mergedUrl, skipQueue, merged, parts) {
  const out = { queued: 0, duplicates: [], skippedIcps: [], trashed: [] };
  // v2.25: every part of a multi-part CDF gets its own index row.
  const list = (parts && parts.length) ? parts : (merged && merged.fileId ? [merged] : []);
  if (meta && list.length) {
    try { for (const p of list) if (p && p.fileId) cdfIndexAdd_(meta, p); out.indexed = true; }
    catch (e) { out.indexError = 'CDF Index not updated: ' + e.message; }
  }
  if (meta && !skipQueue) {
    try {
      const q = wbQueueBulkQuote_(meta, mergedUrl || '');
      out.queued = q.queued;
      out.duplicates = q.duplicates;
      out.skippedIcps = q.skipped;
      out.reClosed = q.reClosed;
    } catch (e) {
      out.queueError = 'Queueing failed: ' + e.message;
    }
  }
  const fin = apiWbFinish(fileIds);
  out.trashed = fin.trashed;
  return out;
}

/**
 * True when an ICP has an annual figure to queue. A genuine 0 kWh
 * COUNTS (10 Nov: zero-consumption ICPs are rare but real and must
 * reach the queue); only blank / unknown / negative does not.
 */
function wbHasAnnual_(v) {
  if (v === null || v === undefined || v === '') return false;
  const n = Number(v);
  return isFinite(n) && n >= 0;
}

/**
 * Append one RFP Queue row per ICP that has an annual figure
 * (legacy appendToBulkPricing rule: ICP + type + annual or it does
 * not price; a real zero is an annual figure). Rows arrive OPEN. Each ICP carries its OWN pathway
 * (STANDARD | URGENT | EXTENSION — mutually exclusive, decided
 * 31 Oct; the Workbench queue-preview table sets it per ICP).
 * Duplicate OPEN ICPs are reported, never replaced — the operator
 * resolves them on the RFP tab.
 */
function wbQueueBulkQuote_(meta, fileUrl) {
  rfpEnsureSetup_();
  const sheet = SpreadsheetApp.openById(getConfig_()._backingId).getSheetByName(RFP_QUEUE_TAB);

  // Duplicate detail (9 Nov): say WHERE the existing OPEN row lives
  // (pathway tab, customer, date) instead of just naming the ICP.
  // Behaviour stays add-anyway — the operator resolves on the RFP tab.
  const fmtD = (d) => d ? Utilities.formatDate(new Date(d), 'Pacific/Auckland', 'yyyy-MM-dd') : '';
  // EVERY open row per ICP is collected (9 Nov fix) — an ICP sitting
  // in Urgent AND Standard gets both named, not just the last found.
  const existingOpen = {};
  const lastClosed = {};
  if (sheet.getLastRow() > 1) {
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 13).getValues();
    for (const r of vals) {
      const st = String(r[2]).trim().toUpperCase();
      const icpKey = String(r[8]).trim();
      if (!icpKey) continue;
      if (st === 'OPEN') {
        (existingOpen[icpKey] = existingOpen[icpKey] || []).push({
          pathway: String(r[4]).trim() ? 'Extensions' : String(r[3]).trim() ? 'Urgent' : 'Standard',
          customerId: String(r[5]), customer: String(r[6]), added: fmtD(r[1]),
        });
      } else if (st === 'CLOSED') {
        lastClosed[icpKey] = fmtD(r[12] || r[1]);
      }
    }
  }

  const rows = [];
  const duplicates = [];
  const skipped = [];
  const reClosed = [];
  const now = new Date();
  const normName = (s) => String(s || '').trim().toLowerCase();
  // Prospect sessions (10 Nov): the customer is not in Betty, so the
  // row carries the PROSPECT marker in the customer id column and the
  // operator-typed names.
  const custId = meta.prospect ? RFP_PROSPECT_ID : (meta.customerId || '');
  for (const icp of (meta.icps || [])) {
    if (!icp.icp) continue;
    if (!wbHasAnnual_(icp.annualKwh)) { skipped.push(icp.icp); continue; }
    const ex = existingOpen[icp.icp];
    if (ex) {
      // A prospect has no customer id, so "different customer" is
      // judged on the name as well (10 Nov).
      const diff = meta.prospect
        ? ex.some(loc => loc.customerId !== RFP_PROSPECT_ID || normName(loc.customer) !== normName(meta.customer))
        : String(meta.customerId || '') !== '' &&
          ex.some(loc => String(meta.customerId) !== loc.customerId);
      duplicates.push({ icp: icp.icp, locations: ex, diffCustomer: diff });
    } else if (lastClosed[icp.icp]) {
      reClosed.push({ icp: icp.icp, closed: lastClosed[icp.icp] });
    }
    const icpType = icp.fuel === 'ELEC' ? 'Electricity' : icp.fuel === 'GAS' ? 'Gas' : '-';
    const pw = String(icp.pathway || 'STANDARD').toUpperCase();
    rows.push([
      Utilities.getUuid().slice(0, 8),
      now, 'OPEN', pw === 'URGENT' ? 'URGENT' : '', pw === 'EXTENSION' ? 'Y' : '',
      custId, meta.customer || '', meta.tradingName || '',
      icp.icp, icpType, Math.round(Number(icp.annualKwh)), fileUrl, '',
      // ext retailer (9 Nov): operator-chosen, extensions only; blank
      // is allowed — set later on the RFP tab.
      pw === 'EXTENSION' ? String(icp.extRetailer || '').trim().toUpperCase() : '',
    ]);
  }
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  return { queued: rows.length, duplicates: duplicates, skipped: skipped, reClosed: reClosed };
}

/** Discard a background-merge workbook (stale: files added / re-analysed). */
function apiWbDiscardMerge(mergedId) {
  try { DriveApp.getFileById(mergedId).setTrashed(true); } catch (e) {}
  return { ok: true };
}

/** Remove ONE file from the session (trash + cache cleanup). */
function apiWbRemoveFile(fileId) {
  return apiWbFinish([fileId]);
}

/**
 * Email an unparseable file to the format inbox (config key
 * format_report_email) with the 🔍 diagnostics attached — the
 * operator's one-click "send it to Peter" for new formats.
 */
function apiWbReportFile(fileId) {
  const file = DriveApp.getFileById(fileId);
  const to = getConfig_()['format_report_email'] || 'peter@theutilitycompany.net';
  let diag = '';
  try {
    const d = apiDebugFirstBytes(fileId);
    diag = 'mime: ' + d.mime + '\n' +
      'first bytes (hex): ' + d.firstBytesHex + '\n' +
      'first chars (utf-8): ' + d.firstCharsUtf8 + '\n' +
      (d.extractedHead ? 'content (head, via ' + (d.contentSource || '') + '): ' + d.extractedHead + '\n' : '') +
      (d.sniffVerdicts ? 'sniff verdicts: ' + d.sniffVerdicts.join(' · ') : '');
  } catch (e) { diag = '(diagnostics failed: ' + e.message + ')'; }
  MailApp.sendEmail({
    to: to,
    subject: 'CDP unknown format: ' + file.getName(),
    body: 'A consumption file the CDP App cannot parse yet, reported from the Workbench by ' +
      Session.getActiveUser().getEmail() + '.\n\nFile attached as received.\n\n🔍 Diagnostics\n' + diag,
    attachments: [file.getBlob()],
  });
  return { ok: true, to: to };
}
