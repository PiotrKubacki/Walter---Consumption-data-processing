// =====================================================
// CDP App - Format detection registry
// -----------------------------------------------------
// Each parser module registers { format, sniff, parse }.
// Detection sniffs CONTENT, never filename/extension.
// Unknown format => fail loudly (design record \u00a75).
// B1 registers eiep_rows only; period_table and hhr_wide
// arrive in B3, report adapters in B4.
// =====================================================

function parserRegistry_() {
  return [
    { format: 'eiep_rows',      sniff: eiepSniff_,          parse: { parse: eiepParse_ } },
    { format: 'hhr_wide',       sniff: hhrWideSniff_,       parse: { parse: hhrWideParse_ } },
    { format: 'interval_long',  sniff: intervalLongSniff_,  parse: { parse: intervalLongParse_ } },
    { format: 'register_reads', sniff: registerReadsSniff_, parse: { parse: registerReadsParse_ } },
    { format: 'report_reads',     sniff: reportReadsSniff_,     parse: { parse: reportReadsParse_ } },
    { format: 'consumption_rows', sniff: consumptionRowsSniff_, parse: { parse: consumptionRowsParse_ } },
    { format: 'timestamp_series', sniff: timestampSeriesSniff_, parse: { parse: timestampSeriesParse_ } },
    { format: 'period_table',     sniff: periodTableSniff_,     parse: { parse: periodTableParse_ } },
  ];
}

/**
 * Read a file's text content and run it past every sniffer.
 * Spreadsheet-shaped files (xlsx/Sheets, including xlsx files
 * mis-named .csv) are serialised to CSV text via a temporary
 * Sheets conversion so row-record formats inside them still
 * detect and parse. Conversion output is cached (keyed on file
 * id + last-updated) so repeat runs skip the expensive step.
 */
function sniffFile_(file) {
  const mime = file.getMimeType();
  let content = null;
  if (mime === MimeType.GOOGLE_SHEETS || /spreadsheetml|ms-excel/.test(mime)) {
    content = cachedSpreadsheetText_(file);
  } else {
    content = file.getBlob().getDataAsString();
    // UTF-16 files mis-read as UTF-8 are full of NUL characters; re-read.
    if (content.indexOf('\u0000') !== -1) {
      content = file.getBlob().getDataAsString('UTF-16');
    }
  }
  for (const p of parserRegistry_()) {
    if (p.sniff(content)) return { format: p.format, content: content, parser: p.parse };
  }
  return { format: 'UNKNOWN', content: content, parser: null };
}

/**
 * Format lookup for the file listing. Sniffs live on every call:
 * verdicts are never cached, so parser improvements take effect
 * immediately. The expensive step (spreadsheet conversion) is
 * covered by the .cdp-cache text cache, making a live sniff cheap.
 */
function sniffFormatFast_(file) {
  return sniffFile_(file).format;
}

/**
 * Extracted-text cache for converted spreadsheets, stored as text
 * files in a '.cdp-cache' subfolder of the upload folder. Keyed on
 * source id + last-updated, so an updated file re-converts and its
 * stale cache entry is trashed.
 */
function cachedSpreadsheetText_(file) {
  const cacheFolder = getCacheFolder_();
  const key = file.getId() + '_' + file.getLastUpdated().getTime() + '_v3.txt';
  const existing = cacheFolder.getFilesByName(key);
  if (existing.hasNext()) {
    return existing.next().getBlob().getDataAsString();
  }
  const text = extractSpreadsheetText_(file);
  // Trash stale entries for the same source file
  const stale = cacheFolder.searchFiles("title contains '" + file.getId() + "_'");
  while (stale.hasNext()) { const s = stale.next(); if (s.getName() !== key) s.setTrashed(true); }
  try { cacheFolder.createFile(key, text, MimeType.PLAIN_TEXT); } catch (e) {}
  return text;
}

let _cacheFolder_ = null;
function getCacheFolder_() {
  if (_cacheFolder_) return _cacheFolder_;
  const parent = DriveApp.getFolderById(requireConfig_('upload_folder_id'));
  const it = parent.getFoldersByName('.cdp-cache');
  _cacheFolder_ = it.hasNext() ? it.next() : parent.createFolder('.cdp-cache');
  return _cacheFolder_;
}

// ---------------- Normalised-records cache ----------------
// Parsed records per file, keyed on id + last-updated, stored as
// JSON in .cdp-cache. Re-analysis skips re-parsing entirely.

function recordsCacheKey_(file) {
  // Keyed on CDP_BUILD too: parser improvements land with the push,
  // no stale parses survive a delivery. Re-parsing after each push
  // costs seconds; serving records from outdated parser code cost us
  // an afternoon (\u00a72 principles: version derived data by its code).
  return file.getId() + '_' + file.getLastUpdated().getTime() + '_' + CDP_BUILD + '_recs1.json';
}

function saveRecordsCache_(file, parsed) {
  const payload = {
    fileName: file.getName(),
    fileFlags: parsed.fileFlags,
    errorCount: parsed.errors.length,
    records: parsed.records.map(r => ({
      i: r.icp, g: r.register, m: r.meterId || '', c: r.registerConfig || '',
      s: r.periodStart.getTime(), e: r.periodEnd.getTime(),
      k: r.kWh, n: r.granularity, q: r.readQuality, l: r.line,
    })),
  };
  const folder = getCacheFolder_();
  const key = recordsCacheKey_(file);
  const stale = folder.searchFiles("title contains '" + file.getId() + "_' and title contains '_recs1'");
  while (stale.hasNext()) { const s = stale.next(); if (s.getName() !== key) s.setTrashed(true); }
  try { folder.createFile(key, JSON.stringify(payload), MimeType.PLAIN_TEXT); } catch (e) {}
}

function loadRecordsCache_(file) {
  const it = getCacheFolder_().getFilesByName(recordsCacheKey_(file));
  if (!it.hasNext()) return null;
  const payload = JSON.parse(it.next().getBlob().getDataAsString());
  return {
    fileName: payload.fileName,
    fileFlags: payload.fileFlags || [],
    errorCount: payload.errorCount || 0,
    records: payload.records.map(r => ({
      icp: r.i, register: r.g, meterId: r.m, registerConfig: r.c,
      periodStart: new Date(r.s), periodEnd: new Date(r.e),
      kWh: r.k, granularity: r.n, readQuality: r.q, line: r.l,
    })),
  };
}

/**
 * Serialise ALL sheets of a spreadsheet file to CSV text, in tab
 * order, each preceded by a '### SHEET: <name>' marker line.
 * Consumption data can live on any tab (observed: retailer gas
 * files with a contract-summary tab first). Non-native files are
 * converted via a temporary Google Sheet (Drive advanced service),
 * trashed straight after. Display values are used so the text
 * parsers see what an operator would see.
 */
function extractSpreadsheetText_(file) {
  let ssId = file.getId();
  let tempId = null;
  if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) {
    const copy = Drive.Files.copy(
      { name: 'CDP temp conversion - ' + file.getName(), mimeType: MimeType.GOOGLE_SHEETS },
      file.getId()
    );
    tempId = copy.id;
    ssId = copy.id;
  }
  try {
    const parts = [];
    for (const sheet of SpreadsheetApp.openById(ssId).getSheets()) {
      const range = sheet.getDataRange();
      if (range.getNumRows() === 0) continue;
      parts.push('### SHEET: ' + sheet.getName());
      const values = range.getDisplayValues();
      parts.push(values.map(row => row.map(csvCell_).join(',')).join('\n'));
    }
    return parts.join('\n');
  } finally {
    if (tempId) DriveApp.getFileById(tempId).setTrashed(true);
  }
}

function csvCell_(v) {
  // Cell-internal newlines are collapsed to spaces so ONE SHEET ROW
  // is always ONE TEXT LINE — wrapped header cells and multi-line
  // title blobs otherwise fragment across lines and defeat every
  // line-scanning sniffer (found via the Family H portal exports).
  const s = String(v === undefined || v === null ? '' : v).replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}