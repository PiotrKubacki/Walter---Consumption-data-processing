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
      format = sniffFormatFast_(f);
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
 * B2: Analyse the whole upload folder as one batch. Read-only.
 * Parses every detectable file, groups records per ICP-register
 * ACROSS files (duplicates flagged \u2014 one Current analysis per ICP
 * means a silent last-write-wins must never happen), runs the
 * analysis engine, and returns rows for the batch screen.
 */
function apiAnalyseBatch() {
  const cfg = getConfig_();
  const folder = DriveApp.getFolderById(requireConfig_('upload_folder_id'));
  const files = folder.getFiles();
  const skipped = [];
  const fileSummaries = [];
  const allRecords = [];
  while (files.hasNext()) {
    const f = files.next();
    let sniff;
    try { sniff = sniffFile_(f); } catch (e) { skipped.push({ name: f.getName(), reason: 'unreadable: ' + e.message }); continue; }
    if (sniff.format === 'UNKNOWN') { skipped.push({ name: f.getName(), reason: 'unknown format' }); continue; }
    const parsed = sniff.parser.parse(sniff.content, f.getName());
    fileSummaries.push({
      name: f.getName(), format: sniff.format,
      records: parsed.records.length, errors: parsed.errors.length,
      fileFlags: parsed.fileFlags,
    });
    for (const r of parsed.records) { r.sourceFile = f.getName(); allRecords.push(r); }
  }

  // Group across files
  const groups = {};
  for (const r of allRecords) {
    const key = r.icp + '|' + r.register;
    (groups[key] = groups[key] || []).push(r);
  }

  const rows = [];
  const boundaries = loadTimeBoundaries_();
  const seasons = loadSeasons_();
  for (const key of Object.keys(groups).sort()) {
    const recs = groups[key];
    const [icp, register] = key.split('|');
    const sources = {};
    for (const r of recs) sources[r.sourceFile] = true;
    const sourceList = Object.keys(sources);
    const analysis = analyseGroup_(recs, cfg);
    if (sourceList.length > 1) {
      analysis.flags.push('ICP-register present in ' + sourceList.length + ' files (' + sourceList.join(', ') +
        ') \u2014 records combined; check this is intended (one Current analysis per ICP)');
    }
    const lookup = cdpLookupIcp_(icp);
    // B5: time profile from interval data inside the analysis window
    let timeProfile = null;
    if (analysis.layer === 'HH' && analysis.windowFrom && analysis.windowTo) {
      const hhInWindow = recs.filter(r => r.granularity === 'HH' &&
        r.periodStart >= analysis.windowFrom && r.periodEnd <= analysis.windowTo);
      if (hhInWindow.length) {
        let registerConfig = '';
        for (const r of hhInWindow) if (r.registerConfig) { registerConfig = r.registerConfig; break; }
        const windowSel = selectWindows_(boundaries, lookup.networkName, lookup.networkId, registerConfig);
        timeProfile = computeTimeProfile_(hhInWindow, seasons, windowSel);
        if (timeProfile && timeProfile.usedDefaultWindows && windowSel.windows.length) {
          analysis.flags.push('Day/Night split uses DEFAULT time windows \u2014 add ' +
            (lookup.networkName !== CDP_NOT_FOUND ? lookup.networkName : 'this network') +
            ' to the Time Boundaries tab for network-accurate splits');
        }
      }
    }
    const serialised = serialiseAnalysis_(analysis);
    serialised.timeProfile = timeProfile;
    rows.push({
      icp: icp, register: register,
      sources: sourceList,
      lookup: lookup,
      bettyUrl: bettyUrl_(lookup.customerId),
      analysis: serialised,
    });
  }

  return { files: fileSummaries, skipped: skipped, rows: rows };
}

function serialiseAnalysis_(a) {
  return {
    layer: a.layer || '',
    windowFrom: a.windowFrom ? fmt_(a.windowFrom) : '',
    windowTo: a.windowTo ? fmt_(a.windowTo) : '',
    windowDays: a.windowDays, daysCovered: a.daysCovered,
    estimateShare: a.estimateShare, gapShare: a.gapShare,
    totalKwh: a.totalKwh, avm: a.avm,
    grade: a.grade, gradeEmoji: GRADE_EMOJI[a.grade] || '',
    breaches: a.breaches || [], flags: a.flags || [],
    crossChecks: a.crossChecks || [],
  };
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
  let source = 'raw text';
  const verdicts = [];
  try {
    let content;
    if (mime === MimeType.GOOGLE_SHEETS || /spreadsheetml|ms-excel/.test(mime)) {
      const cacheFolder = getCacheFolder_();
      const key = file.getId() + '_' + file.getLastUpdated().getTime() + '_v2.txt';
      const hit = cacheFolder.getFilesByName(key).hasNext();
      content = cachedSpreadsheetText_(file); // same path the sniff pipeline uses
      source = hit ? 'cache file (pre-existing)' : 'fresh extraction (now cached)';
    } else {
      content = blob.getDataAsString();
      if (content.indexOf('\u0000') !== -1) { content = blob.getDataAsString('UTF-16'); source = 'raw text (UTF-16)'; }
    }
    extracted = content.slice(0, 400);
    for (const p of parserRegistry_()) {
      let v;
      try { v = p.sniff(content) ? 'CLAIMS' : 'no'; } catch (e) { v = 'ERROR: ' + e.message; }
      verdicts.push(p.format + ': ' + v);
    }
  } catch (e) {
    verdicts.push('pipeline error: ' + e.message);
  }
  return {
    name: file.getName(),
    mime: mime,
    firstBytesHex: hex,
    firstCharsUtf8: utf8.replace(/\u0000/g, '\u2400'),
    extractedHead: extracted,
    contentSource: source,
    sniffVerdicts: verdicts,
  };
}