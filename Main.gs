// =====================================================
// CDP App - Main (web app entry + server API for B1)
// -----------------------------------------------------
// B1 scope: list upload folder, detect format, parse,
// build verify summary. Read-only: nothing is written,
// nothing is moved. Safety inversion: the operator sees
// everything the parser found before any later phase is
// allowed to produce outputs.
// =====================================================

// Bumped with every delivery; shown in the header so "which code
// am I looking at" (/dev head vs /exec pinned version) is always
// answerable at a glance.
const CDP_BUILD = '2026-08-30.4';

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  t.page = (e && e.parameter && e.parameter.page) || 'verify';
  t.build = CDP_BUILD;
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
 * B2: Analyse the whole upload folder as one batch (kept for the
 * Betty flow's no-selection default). Internally: prepare every
 * detectable file, then analyse from cache.
 */
function apiAnalyseBatch() {
  const folder = DriveApp.getFolderById(requireConfig_('upload_folder_id'));
  const files = folder.getFiles();
  const ids = [];
  while (files.hasNext()) ids.push(files.next().getId());
  for (const id of ids) { try { apiPrepareFile(id); } catch (e) {} }
  return analyseFromCache_(ids);
}

/**
 * Chunked step 1 (client-driven, pausable): sniff + parse ONE file
 * and cache its normalised records. Returns a summary only.
 */
function apiPrepareFile(fileId) {
  const file = DriveApp.getFileById(fileId);
  const cached = loadRecordsCache_(file);
  if (cached) {
    return { ok: true, name: file.getName(), fromCache: true, records: cached.records.length, errors: cached.errorCount, fileFlags: cached.fileFlags };
  }
  const sniff = sniffFile_(file);
  if (sniff.format === 'UNKNOWN') {
    return { ok: false, name: file.getName(), reason: 'unknown format \u2014 not processed' };
  }
  const parsed = sniff.parser.parse(sniff.content, file.getName());
  saveRecordsCache_(file, parsed);
  return { ok: true, name: file.getName(), format: sniff.format, fromCache: false, records: parsed.records.length, errors: parsed.errors.length, fileFlags: parsed.fileFlags };
}

/**
 * Chunked step 2: analyse previously prepared files.
 */
function apiAnalyseCached(fileIds) {
  return analyseFromCache_(fileIds || []);
}

function analyseFromCache_(fileIds) {
  const cfg = getConfig_();
  try { sweepInspectCopies_(); } catch (e) {} // fresh run = fresh inspection slate
  const skipped = [];
  const fileSummaries = [];
  const allRecords = [];
  for (const id of fileIds) {
    let file;
    try { file = DriveApp.getFileById(id); } catch (e) { skipped.push({ name: id, reason: 'not found' }); continue; }
    let cached = loadRecordsCache_(file);
    if (!cached) {
      // Not prepared (e.g. unknown format or skipped): try once, then skip
      try {
        const prep = apiPrepareFile(id);
        if (!prep.ok) { skipped.push({ name: file.getName(), reason: prep.reason }); continue; }
        cached = loadRecordsCache_(file);
      } catch (e) { skipped.push({ name: file.getName(), reason: 'unreadable: ' + e.message }); continue; }
    }
    if (!cached) { skipped.push({ name: file.getName(), reason: 'no cached records' }); continue; }
    fileSummaries.push({ id: id, name: cached.fileName, records: cached.records.length, errors: cached.errorCount, fileFlags: cached.fileFlags });
    for (const r of cached.records) { r.sourceFile = cached.fileName; allRecords.push(r); }
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

// ---------------- File management ----------------

/** Move the given files to Trash (recoverable for 30 days). */
function apiTrashFiles(fileIds) {
  const moved = [];
  for (const id of fileIds || []) {
    try { const f = DriveApp.getFileById(id); f.setTrashed(true); moved.push(f.getName()); } catch (e) {}
  }
  return { trashed: moved };
}

/**
 * Create (or reuse) an inspectable Google Sheets COPY of a file
 * (original untouched) and return its URL. Copies live in
 * .cdp-cache and are swept at the start of each analysis run.
 */
function apiOpenFileCopy(fileId) {
  const file = DriveApp.getFileById(fileId);
  const folder = getCacheFolder_();
  const name = 'INSPECT - ' + file.getName();
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) {
    const e = existing.next();
    if (!e.isTrashed()) {
      return { copyId: e.getId(), url: 'https://docs.google.com/spreadsheets/d/' + e.getId() + '/edit', name: name, reused: true };
    }
  }
  const copy = Drive.Files.create(
    { name: name, mimeType: MimeType.GOOGLE_SHEETS, parents: [folder.getId()] },
    file.getBlob()
  );
  return { copyId: copy.id, url: 'https://docs.google.com/spreadsheets/d/' + copy.id + '/edit', name: name, reused: false };
}

/** Trash every INSPECT copy in the cache folder. */
function sweepInspectCopies_() {
  const folder = getCacheFolder_();
  const files = folder.searchFiles("title contains 'INSPECT - '");
  let n = 0;
  while (files.hasNext()) { files.next().setTrashed(true); n++; }
  return n;
}

function apiDeleteInspectCopy(copyId) {
  DriveApp.getFileById(copyId).setTrashed(true);
  return { ok: true };
}

function serialiseAnalysis_(a) {
  return {
    layer: a.layer || '',
    windowFrom: a.windowFrom ? fmt_(a.windowFrom) : '',
    windowTo: a.windowTo ? fmt_(a.windowTo) : '',
    windowDays: a.windowDays, daysCovered: a.daysCovered,
    estimateShare: a.estimateShare, gapShare: a.gapShare,
    totalKwh: a.totalKwh, avm: a.avm,
    annualKwh: a.avm === null ? null : Math.round(a.avm * 12),
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