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
  const copy = src.makeCopy(src.getName(), getWorkFolder_());
  return wbFileInfo_(copy);
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
  return { queued: q.queued, duplicates: q.duplicates, skippedIcps: q.skipped };
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
  const section = String(p.section || 'FULL').toUpperCase();
  const headerLines = [
    'PROPOSAL NOTES:',
    '- all amounts are GST exclusive',
    '- customer id: ' + v('customerId'),
    '- customer: ' + v('customer'),
    '- date: ' + v('date'),
    '- expiry date(s): ' + v('expiryDates'),
    '- analysis type: ' + v('analysisType'),
    '- master ticket: ' + v('masterTicket'),
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
    '- retailer: ' + v('curRetailer'),
    '- contract expiry: ' + v('curContractExpiry'),
    '- break fees: ' + v('curBreakFees'),
    '- discount: ' + v('curDiscount'),
    '- source of current rates: ' + v('curRatesSource'),
    '- inflation: ' + v('curInflation'),
    '- TUC Fee: ' + v('curTucFee'),
    '- TUC DD: ' + v('curTucDd'),
    '',
    '- data ticket(s): ' + v('curDataTickets'),
  ];
  const body = section === 'HEADER' ? headerLines
    : section === 'CURRENT' ? currentLines
    : headerLines.concat(['']).concat(currentLines);
  const text = ['**----------**----------**'].concat(body).concat(['**----------**----------**']).join('\n');

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

function apiWbMergeStart(label) {
  const stamp = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd');
  const name = 'CONS - ' + String(label || 'Unknown customer').replace(/[\\\/\[\]\*\?:]/g, ' ').slice(0, 80) + ' - ' + stamp;
  const merged = SpreadsheetApp.create(name);
  // Move it straight into CDP Output so nothing ever strands in My Drive root.
  DriveApp.getFileById(merged.getId()).moveTo(DriveApp.getFolderById(requireConfig_('output_folder_id')));
  return { mergedId: merged.getId(), name: name };
}

function apiWbMergeAdd(mergedId, fileId) {
  const merged = SpreadsheetApp.openById(mergedId);
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
  let tabs = 0;
  let tempId = null;
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
      const sheets = src.getSheets();
      for (const s of sheets) {
        if (s.getLastRow() === 0) continue;
        const copied = s.copyTo(merged);
        copied.setName(tabName(sheets.length > 1
          ? file.getName() + ' - ' + s.getName() : file.getName()));
        tabs++;
      }
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
      if (rows.length) {
        for (const r of rows) while (r.length < maxLen) r.push('');
        const sheet = merged.insertSheet(tabName(file.getName()));
        sheet.getRange(1, 1, rows.length, maxLen).setValues(rows);
        tabs++;
      }
    }
    SpreadsheetApp.flush();
    return { ok: true, name: file.getName(), tabs: tabs };
  } finally {
    if (tempId) { try { DriveApp.getFileById(tempId).setTrashed(true); } catch (e) {} }
  }
}

function apiWbMergeExport(mergedId) {
  const merged = SpreadsheetApp.openById(mergedId);
  const first = merged.getSheets()[0];
  if (merged.getSheets().length > 1 && first.getLastRow() === 0) merged.deleteSheet(first);
  SpreadsheetApp.flush();
  const name = merged.getName();
  const blob = exportXlsx_(mergedId).setName(name + '.xlsx');
  const outFile = DriveApp.getFolderById(requireConfig_('output_folder_id')).createFile(blob);
  try { DriveApp.getFileById(mergedId).setTrashed(true); } catch (e) {}
  return { name: outFile.getName(), url: outFile.getUrl() };
}

function apiWbFinalise(fileIds, meta, mergedUrl, skipQueue) {
  const out = { queued: 0, duplicates: [], skippedIcps: [], trashed: [] };
  if (meta && !skipQueue) {
    try {
      const q = wbQueueBulkQuote_(meta, mergedUrl || '');
      out.queued = q.queued;
      out.duplicates = q.duplicates;
      out.skippedIcps = q.skipped;
    } catch (e) {
      out.queueError = 'Queueing failed: ' + e.message;
    }
  }
  const fin = apiWbFinish(fileIds);
  out.trashed = fin.trashed;
  return out;
}

/**
 * Append one RFP Queue row per ICP that has an annual figure
 * (legacy appendToBulkPricing rule: ICP + type + annual or it does
 * not price). Rows arrive OPEN. Each ICP carries its OWN pathway
 * (STANDARD | URGENT | EXTENSION — mutually exclusive, decided
 * 31 Oct; the Workbench queue-preview table sets it per ICP).
 * Duplicate OPEN ICPs are reported, never replaced — the operator
 * resolves them on the RFP tab.
 */
function wbQueueBulkQuote_(meta, fileUrl) {
  rfpEnsureSetup_();
  const sheet = SpreadsheetApp.openById(getConfig_()._backingId).getSheetByName(RFP_QUEUE_TAB);

  const existingOpen = {};
  if (sheet.getLastRow() > 1) {
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues();
    for (const r of vals) {
      if (String(r[2]).trim().toUpperCase() === 'OPEN') existingOpen[String(r[8]).trim()] = true;
    }
  }

  const rows = [];
  const duplicates = [];
  const skipped = [];
  const now = new Date();
  for (const icp of (meta.icps || [])) {
    if (!icp.icp) continue;
    if (!(icp.annualKwh > 0)) { skipped.push(icp.icp); continue; }
    if (existingOpen[icp.icp]) duplicates.push(icp.icp);
    const icpType = icp.fuel === 'ELEC' ? 'Electricity' : icp.fuel === 'GAS' ? 'Gas' : '-';
    const pw = String(icp.pathway || 'STANDARD').toUpperCase();
    rows.push([
      Utilities.getUuid().slice(0, 8),
      now, 'OPEN', pw === 'URGENT' ? 'URGENT' : '', pw === 'EXTENSION' ? 'Y' : '',
      meta.customerId || '', meta.customer || '', meta.tradingName || '',
      icp.icp, icpType, Math.round(icp.annualKwh), fileUrl, '',
    ]);
  }
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  return { queued: rows.length, duplicates: duplicates, skipped: skipped };
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
