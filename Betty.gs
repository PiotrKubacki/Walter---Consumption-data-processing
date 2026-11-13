// =====================================================
// CDP App - Betty round-trip (B2 instalment two)
// -----------------------------------------------------
// Design record \u00a73. Flow:
//  1. Operator runs the batch \u2192 apiBettyCustomerIds gives
//     the Customer ID list to feed Betty manually.
//  2. Betty exports the Bulk Analysis template; operator
//     uploads it here (base64 from the browser).
//  3. apiBettyFill converts it to a temp Sheet, matches
//     Current rows by ICP (Customer ID cross-checked),
//     translates registers to Betty meter types (Register
//     Map tab, validated against the template's own
//     Information-sheet vocabulary), writes ONLY Monthly
//     Consumption values (whole kWh) and Meter names into
//     EMPTY slots, trims surplus Bulk Analysis rows (B1
//     spike finding), exports xlsx to the output folder,
//     logs the run, and returns a summary.
// Nothing else in the template is touched. Rows for ICPs
// without data are reported "not updated".
// =====================================================

// ---------------- Customer ID list ----------------

function apiBettyCustomerIds(fileIds) {
  const batch = (fileIds && fileIds.length) ? analyseFromCache_(fileIds) : apiAnalyseBatch();
  const ids = {};
  const unresolved = [];
  for (const row of batch.rows) {
    if (row.lookup.customerId) ids[row.lookup.customerId] = true;
    else unresolved.push(row.icp);
  }
  return {
    customerIds: Object.keys(ids).sort(),
    unresolvedIcps: unresolved,
    icpCount: batch.rows.length,
  };
}

// ---------------- Register translator (\u00a78.1) ----------------

function loadRegisterMap_() {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  const sheet = ss.getSheetByName('Register Map');
  if (!sheet) throw new Error('Backing sheet has no "Register Map" tab \u2014 run bootstrapBackingSheet().');
  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues() : [];
  const map = [];
  for (const r of rows) {
    const fuel = String(r[0] || 'ANY').trim().toUpperCase();
    const pattern = String(r[1] || '').trim();
    const type = String(r[2] || '').trim();
    if (pattern && type) map.push({ fuel: fuel, pattern: pattern.toUpperCase(), type: type });
  }
  return map;
}

function translateRegister_(register, fuel, regMap) {
  const key = String(register || '').trim().toUpperCase();
  for (const m of regMap) {
    if (m.pattern === key && m.fuel === fuel) return m.type;
  }
  for (const m of regMap) {
    if (m.pattern === key && m.fuel === 'ANY') return m.type;
  }
  return null;
}

// ---------------- Template fill ----------------

/**
 * Betty meter type for a retailer time band (v2.16.1): the template's
 * own vocabulary entry with the same name once case, spaces and
 * hyphens are ignored ("Off-Peak" -> "Off Peak"); a weekend band also
 * tries the "All ..." form ("Weekend Off-Peak" -> "All Weekend Off
 * Peak"). null = Betty has no such meter type.
 */
function bettyMeterForBand_(band, vocab) {
  const key = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const k = key(band);
  if (!k) return null;
  for (const v of vocab) if (key(v) === k) return v;
  for (const v of vocab) if (key(v) === 'all' + k) return v;
  return null;
}

/**
 * v2.18: the Workbench now sends { "<icp>": [{ name, monthly, src,
 * manual, grade }] } - the ICP's meters exactly as shown (and possibly
 * edited) on screen; such an ICP is written from that list alone.
 * Older shape, still honoured:
 * bandData (v2.16.1, optional): { "<icp>|<register>": { schedule,
 * slots: [{ name, monthly }] } } - the time bands shown on the
 * Workbench (after any fold). An ICP-register listed there is written
 * band by band; every other register is written whole, through the
 * Register Map, as before.
 */
// Template columns the rates screen can fill (v2.17), besides Unit
// Cost 1-4. key -> header text in the Bulk Analysis sheet.
const BETTY_RATE_COLUMNS = {
  daily: 'Daily Retailer Charge', dailyLevy: 'Daily Levy Retailer Charge', kwhLevy: 'Kwh Levy Retailer Charge',
  capacity: 'Capacity Retailer Charge', demand: 'Demand Retailer Charge', distance: 'Distance Retailer Charge',
  unmetered: 'Unmetered Retailer Charge', breakFee: 'Break Fee Retailer Charge', contractDays: 'Contract Length',
  brokerage: 'Brokerage Fee', ppd: 'PPD', addPpd: 'Additional PPD', inflation: 'Inflation',
  rebate: 'Annual Rebate', incentive: 'Incentive Credit',
};

function bettyKey_(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/**
 * rates (v2.17, optional): { "<icp>": { unit: { "<Betty meter name>":
 * number }, fields: { daily, dailyLevy, ..., incentive } } } from the
 * Enter rates screen. Every cost arrives ALREADY in $ excl GST (the
 * browser converts whatever style the operator typed in); this
 * function only writes numbers. Only keys that are present are
 * written; everything else on the row is left alone.
 */
function apiBettyFill(base64Data, uploadName, fileIds, bandData, rates) {
  const bandMap = bandData || {};
  const rateMap = rates || {};
  const cfg = getConfig_();
  const runRef = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyyMMdd-HHmmss');

  // Recompute the batch (records + analysis + lookups)
  const batch = (fileIds && fileIds.length) ? analyseFromCache_(fileIds) : apiAnalyseBatch();
  const byIcp = {};
  for (const row of batch.rows) {
    (byIcp[row.icp] = byIcp[row.icp] || []).push(row);
  }
  const regMap = loadRegisterMap_();

  // Convert uploaded template to a temp Google Sheet
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    uploadName || 'betty-template.xlsx');
  const temp = Drive.Files.create({ name: 'CDP Betty fill ' + runRef, mimeType: MimeType.GOOGLE_SHEETS }, blob);
  const ss = SpreadsheetApp.openById(temp.id);

  const summary = { updated: [], notUpdated: [], flagged: [], vocabularyGaps: [], ratesRows: 0 };
  const flagsLog = [];
  try {
    const bulk = ss.getSheetByName('Bulk Analysis');
    if (!bulk) throw new Error('Uploaded file has no "Bulk Analysis" sheet \u2014 is this a Betty template?');

    // Vocabulary from the template's Information sheet (\u00a78.1)
    const vocab = readBettyVocabulary_(ss);

    // Header map (tolerant)
    const lastCol = bulk.getLastColumn();
    const headers = bulk.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
    const hFind = (kw) => headers.findIndex(h => h.toLowerCase().indexOf(kw) !== -1);
    const cIcp = hFind('icp');
    const cCust = hFind('customer id');
    const cStatus = hFind('status');
    if (cIcp < 0 || cStatus < 0) throw new Error('Bulk Analysis headers not recognised (need ICP and Status columns).');
    const slots = [];
    for (let n = 1; n <= 4; n++) {
      const m = headers.findIndex(h => new RegExp('^meter\\s*' + n + '$', 'i').test(h));
      const c = headers.findIndex(h => new RegExp('^monthly\\s*consumption\\s*' + n + '$', 'i').test(h));
      const u = headers.findIndex(h => new RegExp('^unit\\s*cost\\s*' + n + '$', 'i').test(h));
      if (m >= 0 && c >= 0) slots.push({ meterCol: m, consCol: c, unitCol: u });
    }
    if (!slots.length) throw new Error('No Meter N / Monthly Consumption N column pairs found.');

    const lastRow = bulk.getLastRow();
    const data = lastRow > 1 ? bulk.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
    let lastDataRow = 1;

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const icp = String(row[cIcp] || '').trim();
      if (icp) lastDataRow = i + 2;
      if (!icp) continue;
      const status = String(row[cStatus] || '').trim().toLowerCase();
      if (status !== 'current') continue;

      const groups = byIcp[icp];
      if (!groups || !groups.length) {
        summary.notUpdated.push({ icp: icp, reason: 'no consumption data in this batch' });
        continue;
      }
      // Customer ID cross-check
      const tmplCust = cCust >= 0 ? String(row[cCust] || '').trim() : '';
      const ourCust = groups[0].lookup.customerId;
      if (tmplCust && ourCust && tmplCust !== ourCust) {
        summary.flagged.push({ icp: icp, reason: 'Customer ID mismatch (template ' + tmplCust + ' vs lookup ' + ourCust + ') \u2014 not written' });
        flagsLog.push([icp, '', 'CUSTOMER_MISMATCH', 'template ' + tmplCust + ' vs lookup ' + ourCust]);
        continue;
      }

      const rowUpdates = [];
      const rowLines = []; // structured copy of rowUpdates for the report table (v2.17)
      const rowFlags = [];
      const writtenCols = {};
      let usedBands = false;
      let cur = { gradeEmoji: '', grade: '' }; // grade shown beside what writeSlot writes
      // Slot: existing slot with this name, else first empty slot.
      const writeSlot = (label, bettyType, value) => {
        let target = null;
        for (const s of slots) {
          if (String(row[s.meterCol] || '').trim().toLowerCase() === bettyType.toLowerCase()) { target = s; break; }
        }
        let writeName = false;
        if (!target) {
          for (const s of slots) {
            if (!String(row[s.meterCol] || '').trim()) { target = s; writeName = true; break; }
          }
        }
        if (!target) {
          rowFlags.push(label + ': no free meter slot (all 4 used) \u2014 not written');
          flagsLog.push([icp, label, 'NO_FREE_SLOT', '']);
          return;
        }
        const sheetRow = i + 2;
        // Two registers of one ICP landing on the SAME Betty meter in
        // this run are added together (v2.16.2) - the second used to
        // replace the first.
        const added = !!writtenCols[target.meterCol];
        if (added) value = (Number(row[target.consCol]) || 0) + value;
        if (writeName) bulk.getRange(sheetRow, target.meterCol + 1).setValue(bettyType);
        bulk.getRange(sheetRow, target.consCol + 1).setValue(value);
        row[target.meterCol] = bettyType; // keep local copy current for multi-register ICPs
        row[target.consCol] = value;
        writtenCols[target.meterCol] = true;
        rowUpdates.push(label + ' \u2192 ' + bettyType + ' = ' + value + (added ? ' (added to the same meter)' : '') +
          ' (' + (cur.gradeEmoji + ' ' + cur.grade).trim() + ')');
        rowLines.push({ src: label, meter: bettyType, kwh: value, grade: (cur.gradeEmoji + ' ' + cur.grade).trim(),
          note: added ? 'added to the same meter' : '' });
      };


      // v2.18: the Workbench sent this ICP's meters exactly as shown there
      // (types and figures possibly edited by the operator): write those
      // and nothing else for this ICP.
      const explicit = Array.isArray(bandMap[icp]) ? bandMap[icp] : null;
      if (explicit) {
        usedBands = true;
        for (const m of explicit) {
          const monthly = Number(m.monthly);
          const label = String(m.src || m.name || '');
          const name = String(m.name || '').trim();
          if (!name || !isFinite(monthly) || monthly < 0) { rowFlags.push(label + ': no meter type or figure \u2014 not written'); continue; }
          const known = vocab.length ? vocab.filter(v => bettyKey_(v) === bettyKey_(name))[0] : name;
          if (!known) {
            rowFlags.push(label + ': "' + name + '" is not a Betty meter type \u2014 not written');
            flagsLog.push([icp, label, 'VOCABULARY_GAP', name]);
            if (summary.vocabularyGaps.indexOf(name) === -1) summary.vocabularyGaps.push(name);
            continue;
          }
          cur = { gradeEmoji: '', grade: m.manual ? 'manual' : String(m.grade || '').trim() };
          writeSlot(label, known, Math.round(monthly));
          if (m.manual) flagsLog.push([icp, label, 'MANUAL_FIGURE', known + ' = ' + Math.round(monthly)]);
        }
      }
      for (const g of (explicit ? [] : groups)) {
        const a = g.analysis;
        cur = { gradeEmoji: a.gradeEmoji, grade: a.grade };
        if (a.avm === null || a.grade === 'NO_DATA') {
          rowFlags.push(g.register + ': no AVM (' + a.grade + ')');
          continue;
        }
        // Time bands shown on the Workbench: one Betty meter per band.
        const bandEntry = bandMap[icp + '|' + g.register];
        if (bandEntry && bandEntry.slots && bandEntry.slots.length) {
          usedBands = true;
          for (const sl of bandEntry.slots) {
            const monthly = Number(sl.monthly);
            const label = g.register + ' / ' + sl.name;
            if (!isFinite(monthly) || monthly < 0) { rowFlags.push(label + ': no figure \u2014 not written'); continue; }
            const bandType = bettyMeterForBand_(sl.name, vocab);
            if (!bandType) {
              rowFlags.push(label + ': Betty has no meter type for this band \u2014 not written');
              flagsLog.push([icp, label, 'NO_METER_TYPE_FOR_BAND', String(bandEntry.schedule || '')]);
              continue;
            }
            writeSlot(label, bandType, Math.round(monthly));
          }
          if (a.grade !== 'GOOD') flagsLog.push([icp, g.register, 'GRADE_' + a.grade, 'AVM ' + a.avm]);
          continue;
        }

        const bettyType = translateRegister_(g.register, g.lookup.fuel, regMap);
        if (!bettyType) {
          rowFlags.push(g.register + ': no Register Map entry \u2014 not written');
          flagsLog.push([icp, g.register, 'UNMAPPED_REGISTER', 'fuel ' + g.lookup.fuel]);
          continue;
        }
        if (vocab.length && vocab.indexOf(bettyType) === -1) {
          rowFlags.push(g.register + ': mapped type "' + bettyType + '" not in Betty vocabulary \u2014 not written');
          flagsLog.push([icp, g.register, 'VOCABULARY_GAP', bettyType]);
          if (summary.vocabularyGaps.indexOf(bettyType) === -1) summary.vocabularyGaps.push(bettyType);
          continue;
        }
        writeSlot(g.register, bettyType, a.avm);
        if (a.grade !== 'GOOD') flagsLog.push([icp, g.register, 'GRADE_' + a.grade, 'AVM ' + a.avm]);
      }
      // A meter already on the row that this run did not write (say an
      // old "Anytime" total) now sits beside the bands: say so, it would
      // double count in Betty.
      if (usedBands && rowUpdates.length) {
        for (const s of slots) {
          const nm = String(row[s.meterCol] || '').trim();
          const val = Number(row[s.consCol]);
          if (nm && !writtenCols[s.meterCol] && isFinite(val) && val !== 0) {
            rowFlags.push('existing meter "' + nm + '" (' + val + ') was left as it is \u2014 check it does not double count with the bands');
          }
        }
      }
      // Rates typed on the Enter rates screen ($ excl GST).
      const rt = rateMap[icp];
      if (rt) {
        const sheetRowR = i + 2;
        let unitN = 0, fieldN = 0;
        const unit = rt.unit || {};
        const usedKeys = {};
        for (const s of slots) {
          const nm = String(row[s.meterCol] || '').trim();
          if (!nm || s.unitCol < 0) continue;
          for (const meterName in unit) {
            if (bettyKey_(meterName) !== bettyKey_(nm)) continue;
            const val = Number(unit[meterName]);
            usedKeys[meterName] = true;
            if (unit[meterName] === null || unit[meterName] === '' || !isFinite(val) || val < 0) continue;
            bulk.getRange(sheetRowR, s.unitCol + 1).setValue(val);
            row[s.unitCol] = val;
            unitN++;
          }
        }
        for (const meterName in unit) {
          if (!usedKeys[meterName] && unit[meterName] !== null && unit[meterName] !== '') {
            rowFlags.push('rate typed for "' + meterName + '" but the row has no such meter \u2014 not written');
          }
        }
        const fields = rt.fields || {};
        for (const key in BETTY_RATE_COLUMNS) {
          if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
          const val = Number(fields[key]);
          if (fields[key] === null || fields[key] === '' || !isFinite(val)) continue;
          const col = headers.findIndex(h => h.toLowerCase() === BETTY_RATE_COLUMNS[key].toLowerCase());
          if (col < 0) { rowFlags.push(BETTY_RATE_COLUMNS[key] + ': column not in the template \u2014 not written'); continue; }
          bulk.getRange(sheetRowR, col + 1).setValue(val);
          fieldN++;
        }
        if (unitN || fieldN) {
          rowUpdates.push('rates: ' + unitN + ' unit cost(s), ' + fieldN + ' other field(s)');
          rowLines.push({ src: 'rates', meter: '', kwh: '', grade: '', note: unitN + ' unit cost(s), ' + fieldN + ' other field(s) written' });
          summary.ratesRows++;
        }
      }
      if (rowUpdates.length) summary.updated.push({ icp: icp, customer: groups[0].lookup.registeredName, detail: rowUpdates, lines: rowLines, flags: rowFlags });
      else summary.notUpdated.push({ icp: icp, reason: rowFlags.join('; ') || 'nothing writable' });
    }

    // Trim Bulk Analysis surplus rows (B1 spike: required by Betty's importer)
    const maxRows = bulk.getMaxRows();
    if (maxRows > lastDataRow) bulk.deleteRows(lastDataRow + 1, maxRows - lastDataRow);

    SpreadsheetApp.flush();

    // Export xlsx to the Betty files folder (v2.17: NOT the CDF output
    // folder - a filled template can hold the customer's rates, and
    // CDFs go out to retailers).
    const custIds = {}; let custName = '';
    for (const u of summary.updated) {
      const g0 = (byIcp[u.icp] || [])[0];
      if (g0 && g0.lookup.customerId) { custIds[g0.lookup.customerId] = true; custName = custName || g0.lookup.registeredName || ''; }
    }
    const idList = Object.keys(custIds);
    const betLabel = idList.length === 1 ? idList[0] + ' ' + custName : idList.length ? 'several customers' : 'no rows updated';
    const outName = 'BET - ' + betLabel.replace(/[\\\/\[\]\*\?:]/g, ' ').slice(0, 80) + ' - ' +
      Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HHmm');
    const outBlob = exportXlsx_(temp.id).setName(outName + '.xlsx');
    const outFile = bettyFolder_().createFile(outBlob);
    const share = bettyShare_(outFile);
    let indexError = '';
    try {
      betIndexAdd_({ customerId: idList.length === 1 ? idList[0] : idList.join(', '), customer: idList.length === 1 ? custName : '',
        icps: summary.updated.map(u => u.icp), hasRates: summary.ratesRows > 0, file: outFile });
    } catch (e) { indexError = String(e.message || e); }

    // Logs
    writeRunLog_(runRef, batch, summary, outFile.getUrl());
    writeFlagsLog_(runRef, flagsLog);

    return {
      ok: true,
      runRef: runRef,
      outputUrl: outFile.getUrl(),
      outputName: outFile.getName(),
      updated: summary.updated,
      notUpdated: summary.notUpdated,
      flagged: summary.flagged,
      vocabularyGaps: summary.vocabularyGaps,
      fileId: outFile.getId(),
      ratesRows: summary.ratesRows,
      sharedWith: share.sharedWith, shareError: share.shareError, indexError: indexError,
    };
  } finally {
    DriveApp.getFileById(temp.id).setTrashed(true);
  }
}

function readBettyVocabulary_(ss) {
  const info = ss.getSheetByName('Information');
  if (!info) return [];
  const lastCol = info.getLastColumn();
  const lastRow = info.getLastRow();
  if (lastRow < 2) return [];
  const headers = info.getRange(1, 1, 1, lastCol).getValues()[0];
  for (let c = 0; c < headers.length; c++) {
    if (/meter/i.test(String(headers[c] || ''))) {
      return info.getRange(2, c + 1, lastRow - 1, 1).getValues()
        .map(r => String(r[0] || '').trim()).filter(v => v);
    }
  }
  // Fallback: the column containing 'Anytime'
  const all = info.getRange(1, 1, lastRow, lastCol).getValues();
  for (let c = 0; c < lastCol; c++) {
    for (let r = 0; r < lastRow; r++) {
      if (String(all[r][c]).trim() === 'Anytime') {
        return all.slice(1).map(row => String(row[c] || '').trim()).filter(v => v);
      }
    }
  }
  return [];
}

function exportXlsx_(spreadsheetId) {
  const url = 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/export?format=xlsx';
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: false,
  });
  return resp.getBlob();
}

function writeRunLog_(runRef, batch, summary, outputUrl) {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  const sheet = ss.getSheetByName('Run Log');
  if (!sheet) return;
  const grades = {};
  for (const row of batch.rows) grades[row.analysis.grade] = (grades[row.analysis.grade] || 0) + 1;
  sheet.appendRow([
    new Date(), Session.getActiveUser().getEmail(),
    batch.files.map(f => f.name).join('; '),
    batch.rows.length,
    Object.keys(grades).map(g => g + ':' + grades[g]).join(' '),
    outputUrl,
  ]);
}

function writeFlagsLog_(runRef, flagsLog) {
  if (!flagsLog.length) return;
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  const sheet = ss.getSheetByName('Flags Log');
  if (!sheet) return;
  const now = new Date();
  sheet.getRange(sheet.getLastRow() + 1, 1, flagsLog.length, 6)
    .setValues(flagsLog.map(f => [now, runRef, f[0], f[1], f[2], f[3]]));
}

// ---------------- Archive processed files ----------------

function apiArchiveProcessedFiles() {
  const upload = DriveApp.getFolderById(requireConfig_('upload_folder_id'));
  const processed = DriveApp.getFolderById(requireConfig_('processed_folder_id'));
  const files = upload.getFiles();
  const moved = [];
  while (files.hasNext()) {
    const f = files.next();
    let format = 'UNKNOWN';
    try { format = sniffFile_(f).format; } catch (e) { continue; }
    if (format === 'UNKNOWN') continue; // unrecognised files stay for attention
    f.moveTo(processed);
    moved.push(f.getName());
  }
  return { moved: moved };
}

// =====================================================
// Betty files: own folder, own sharing, own index (v2.17)
// -----------------------------------------------------
// A filled Betty template can hold a customer's current
// rates. It is therefore kept apart from the CDFs (which
// can go to retailers with an RFP): its own folder, shared
// with named people only (never "anyone with the link"),
// and its own index for the Archive tab. Nothing in the
// RFP queue ever links to a Betty file.
// =====================================================

const BET_INDEX_TAB = 'Betty Index';
const BET_INDEX_HEADERS = ['date', 'customer id', 'registered name', 'icp count', 'icps', 'operator',
  'file name', 'file id', 'url', 'size bytes', 'rates (Y/N)'];
const BET_FOLDER_NAME = 'Betty files';

/** Config key betty_output_folder_id if set, else a "Betty files" subfolder of the output folder (created on first use). */
function bettyFolder_() {
  const cfg = getConfig_();
  if (cfg.betty_output_folder_id) return DriveApp.getFolderById(cfg.betty_output_folder_id);
  const parent = DriveApp.getFolderById(requireConfig_('output_folder_id'));
  const it = parent.getFoldersByName(BET_FOLDER_NAME);
  return it.hasNext() ? it.next() : parent.createFolder(BET_FOLDER_NAME);
}

/**
 * Share a Betty file with the people who do the job: the operator who
 * made it and every address in Config key betty_file_viewers (comma
 * or space separated - personal accounts go here). Never a public
 * link. Returns who it was shared with and any failures.
 */
function bettyShare_(file) {
  const emails = {};
  try { const me = Session.getActiveUser().getEmail(); if (me) emails[me.toLowerCase()] = true; } catch (e) {}
  const list = String(getConfig_().betty_file_viewers || '').split(/[\s,;]+/);
  for (const x of list) { const a = x.trim().toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) emails[a] = true; }
  const ok = [], bad = [];
  for (const a of Object.keys(emails)) {
    try { file.addViewer(a); ok.push(a); } catch (e) { bad.push(a); }
  }
  return { sharedWith: ok, shareError: bad.length ? 'could not share with ' + bad.join(', ') : '' };
}

function betIndexSheet_() {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  let sheet = ss.getSheetByName(BET_INDEX_TAB);
  if (!sheet) sheet = ss.insertSheet(BET_INDEX_TAB);
  if (!sheet.getRange(1, 1).getValue()) {
    sheet.getRange(1, 1, 1, BET_INDEX_HEADERS.length).setValues([BET_INDEX_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function betIndexAdd_(info) {
  let operator = '';
  try { operator = Session.getActiveUser().getEmail(); } catch (e) {}
  let size = '';
  try { size = info.file.getSize(); } catch (e) {}
  betIndexSheet_().appendRow([new Date(), String(info.customerId || ''), String(info.customer || ''),
    info.icps.length, info.icps.join(', ').slice(0, 45000), operator,
    info.file.getName(), info.file.getId(), info.file.getUrl(), size, info.hasRates ? 'Y' : '']);
}

/** Archive search over the Betty Index: customer id, name, file name or ICP. Newest first, capped at 50. */
function apiBetSearch(q) {
  const sheet = betIndexSheet_();
  const out = { rows: [], total: 0, matched: 0, q: String(q || '').trim() };
  if (sheet.getLastRow() < 2) return out;
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, BET_INDEX_HEADERS.length).getValues();
  const needle = out.q.toLowerCase();
  for (let i = vals.length - 1; i >= 0; i--) {
    const r = vals[i];
    if (!String(r[7] || '').trim() && !String(r[6] || '').trim()) continue;
    out.total++;
    const icps = String(r[4] || '');
    if (needle && [r[1], r[2], r[6], icps].join(' | ').toLowerCase().indexOf(needle) === -1) continue;
    out.matched++;
    if (out.rows.length >= 50) continue;
    out.rows.push({
      date: r[0] instanceof Date ? Utilities.formatDate(r[0], 'Pacific/Auckland', 'yyyy-MM-dd HH:mm') : String(r[0] || ''),
      customerId: String(r[1] || ''), customer: String(r[2] || ''),
      icpCount: Number(r[3]) || 0, operator: String(r[5] || ''),
      fileName: String(r[6] || ''), fileId: String(r[7] || ''), url: String(r[8] || ''),
      sizeBytes: Number(r[9]) || 0, hasRates: /^y/i.test(String(r[10] || '')),
    });
  }
  return out;
}
