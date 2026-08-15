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
