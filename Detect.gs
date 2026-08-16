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
    { format: 'eiep_rows', sniff: eiepSniff_, parse: { parse: eiepParse_ } },
    // B3: { format: 'period_table', ... }
    // B3: { format: 'hhr_wide', ... }
    // B4: { format: 'report_cranford', ... }
  ];
}

/**
 * Read a file's text content and run it past every sniffer.
 * Spreadsheet-shaped files (xlsx/Sheets, including xlsx files
 * mis-named .csv) are serialised to CSV text via a temporary
 * Sheets conversion so row-record formats inside them still
 * detect and parse. The temp conversion is trashed immediately.
 */
function sniffFile_(file) {
  const mime = file.getMimeType();
  let content = null;
  if (mime === MimeType.GOOGLE_SHEETS || /spreadsheetml|ms-excel/.test(mime)) {
    content = extractSpreadsheetText_(file);
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
 * Serialise the first sheet of a spreadsheet file to CSV text.
 * Non-native files are converted via a temporary Google Sheet
 * (Drive advanced service), which is trashed straight after.
 * Display values are used so the text parsers see what an
 * operator would see; ambiguous date renderings are handled by
 * the parser's disambiguation heuristic.
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
    const sheet = SpreadsheetApp.openById(ssId).getSheets()[0];
    const values = sheet.getDataRange().getDisplayValues();
    return values.map(row => row.map(csvCell_).join(',')).join('\n');
  } finally {
    if (tempId) DriveApp.getFileById(tempId).setTrashed(true);
  }
}

function csvCell_(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}