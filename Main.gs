// =====================================================
// CDP App - Main (web app entry + server API for B1)
// -----------------------------------------------------
// B1 scope: list upload folder, detect format, parse,
// build verify summary. Read-only: nothing is written,
// nothing is moved. Safety inversion: the operator sees
// everything the parser found before any later phase is
// allowed to produce outputs.
// =====================================================

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  t.page = (e && e.parameter && e.parameter.page) || 'verify';
  return t.evaluate()
    .setTitle('CDP \u00b7 Consumption Data Processing')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------- Server API (google.script.run) ----------------

/**
 * List files sitting in the upload folder with a format sniff for each.
 * Read-only. Returns [{id, name, sizeBytes, updated, format}]
 */
function apiListUploadFiles() {
  const folder = DriveApp.getFolderById(requireConfig_('upload_folder_id'));
  const files = folder.getFiles();
  const out = [];
  while (files.hasNext()) {
    const f = files.next();
    let format = 'UNKNOWN';
    try {
      format = sniffFile_(f).format;
    } catch (err) {
      format = 'UNREADABLE';
    }
    out.push({
      id: f.getId(),
      name: f.getName(),
      sizeBytes: f.getSize(),
      updated: Utilities.formatDate(f.getLastUpdated(), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm'),
      format: format,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Parse one file and return the verify summary. Read-only.
 */
function apiParseAndVerify(fileId) {
  const file = DriveApp.getFileById(fileId);
  const sniff = sniffFile_(file);
  if (sniff.format === 'UNKNOWN') {
    return {
      ok: false,
      fileName: file.getName(),
      error: 'Unknown format. No parser claimed this file \u2014 nothing was processed. ' +
             'If this is a new format we should support, it needs a new adapter (design record \u00a75).',
    };
  }
  const parsed = sniff.parser.parse(sniff.content, file.getName());
  const verify = buildVerifySummary_(parsed, file.getName());
  return { ok: true, fileName: file.getName(), format: sniff.format, verify: verify };
}

/**
 * Debug: report a file's mime type and the first bytes/chars so an
 * undetected format can be diagnosed. Read-only.
 */
function apiDebugFirstBytes(fileId) {
  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob();
  const bytes = blob.getBytes().slice(0, 64);
  const hex = bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join(' ');
  let utf8 = '';
  try { utf8 = blob.getDataAsString().slice(0, 200); } catch (e) { utf8 = '(unreadable: ' + e.message + ')'; }
  const mime = file.getMimeType();
  let extracted = '';
  if (mime === MimeType.GOOGLE_SHEETS || /spreadsheetml|ms-excel/.test(mime)) {
    try { extracted = extractSpreadsheetText_(file).slice(0, 400); }
    catch (e) { extracted = '(extraction failed: ' + e.message + ')'; }
  }
  return {
    name: file.getName(),
    mime: mime,
    firstBytesHex: hex,
    firstCharsUtf8: utf8.replace(/\u0000/g, '\u2400'),
    extractedHead: extracted,
  };
}