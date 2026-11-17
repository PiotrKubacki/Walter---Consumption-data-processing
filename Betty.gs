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
// Betty file: LOAD from a template, then RE-CREATE (v2.20)
// -----------------------------------------------------
// Decided 14 Nov: Walter does not amend the file Betty
// exported. Choosing a template is a LOAD step - its
// Current rows are read so the operator starts from what
// Betty holds. On save Walter writes a NEW file in the
// Bulk Import Template layout with ONE Current row per
// ICP, built entirely from what is on screen:
//   - analysis ID carried when one was loaded -> Betty
//     updates that analysis;
//   - analysis ID blank otherwise -> Betty creates it
//     (and rejects the whole file if the ICP already has
//     a Current analysis).
// Only the rows Walter built are in the file; Betty
// leaves every analysis that is absent from an import
// alone. Walter writes Current rows only - Rita writes
// the other statuses.
// =====================================================

const BETTY_HEADERS = [
  "Customer Analysis ID", "Customer ID", "Registered Name", "ICP Identifier",
  "Retailer", "Status (Analysis)", "Analysis Type", "Comments",
  "Meter 1", "Monthly Consumption 1", "Unit Cost 1", "Meter 2",
  "Monthly Consumption 2", "Unit Cost 2", "Meter 3", "Monthly Consumption 3",
  "Unit Cost 3", "Meter 4", "Monthly Consumption 4", "Unit Cost 4",
  "Daily Retailer Charge", "Daily Levy Retailer Charge", "Kwh Levy Retailer Charge", "Capacity Retailer Charge",
  "Demand Retailer Charge", "Distance Retailer Charge", "Unmetered Retailer Charge", "Break Fee Retailer Charge",
  "Contract Length", "Brokerage Fee", "PPD", "Additional PPD",
  "Inflation", "Annual Rebate", "Incentive Credit",
];
const BETTY_STATUSES = ['Current', 'Proposed', 'Archived', 'Auditing'];
const BETTY_ANALYSIS_TYPES = ['ELECTRICITY', 'GAS'];
// Seeds for the "Betty Lists" tab (from Betty's template, 13 Nov 2026).
// The tab is refreshed from every template that is loaded.
const BETTY_SEED_RETAILERS = [
  "2DEGREES", "ADONIS ENERGY", "BCPL", "COMMERCIAL UTILITIES", "CONTACT",
  "ECOTRICITY", "ECOTRICITY (TOU)", "ELECTRIC KIWI", "ELECTRIC KIWI (TOU)", "EMP",
  "ENERGY ONLINE", "FLICK", "FRANK ENERGY", "GENESIS", "GENESIS (SB)",
  "GENESIS (TOU)", "INDEPENDENT ENERGY", "INTEGRATED ENERGY", "JUST ENERGY", "KAUMATUA ENERGY",
  "KING COUNTRY ENERGY", "LODESTONE", "MANAGE MY BILLS", "MANAWA ENERGY", "MARU ENERGY",
  "MEGATEL", "MERCURY", "MERCURY (TOU)", "MERIDIAN", "NOVA",
  "OCTOPUS ENERGY", "ON GAS", "ORCON", "PAYLESS ENERGY", "PIONEER ENERGY",
  "PLAINS POWER", "POWERBROKERS", "POWERSHOP", "PRIME ENERGY", "PULSE ENERGY",
  "RELIANCE UTILITIES", "ROCKGAS", "SIMPLY ENERGY", "SIMPLY ENERGY (TOU)", "SUPERPOWER",
  "SWITCH UTILITIES", "TINY MIGHTY POWER", "TOAST ELECTRIC", "TRUSTPOWER",
];
const BETTY_SEED_METERS = [
  "All Inclusive", "All Weekend Off Peak", "Anytime", "Anytime Summer", "Anytime Winter", "Controlled",
  "Controlled Summer", "Controlled Winter", "Cost", "Day", "Day Summer", "Day Winter",
  "Gas", "Night", "Night Boost", "Night Summer", "Night Winter", "Off Peak",
  "Peak", "Peak Summer", "Peak Winter", "Priority Controlled", "Shoulder", "Solar Exported",
];
const BETTY_LISTS_TAB = 'Betty Lists';
// v2.24 (Peter, 16 Nov): contract length 730 days; brokerage has NO default -
// the cell stays blank unless typed or loaded from Betty.
const BETTY_DEFAULT_CONTRACT_DAYS = 730;
const BETTY_DEFAULT_BROKERAGE = null;

function bettyListsSheet_() {
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);
  let sheet = ss.getSheetByName(BETTY_LISTS_TAB);
  if (!sheet) sheet = ss.insertSheet(BETTY_LISTS_TAB);
  if (!sheet.getRange(1, 1).getValue()) bettyListsWrite_(sheet, BETTY_SEED_RETAILERS, BETTY_SEED_METERS);
  return sheet;
}

function bettyListsWrite_(sheet, retailers, meters) {
  const n = Math.max(retailers.length, meters.length);
  const vals = [['retailers', 'meter types']];
  for (let i = 0; i < n; i++) vals.push([retailers[i] || '', meters[i] || '']);
  const last = Math.max(sheet.getLastRow(), vals.length);
  while (vals.length < last) vals.push(['', '']);
  sheet.getRange(1, 1, vals.length, 2).setValues(vals);
}

/** { retailers: [], meters: [] } as Betty spells them. */
function bettyLists_() {
  const sheet = bettyListsSheet_();
  const n = sheet.getLastRow() - 1;
  const out = { retailers: [], meters: [] };
  if (n < 1) return out;
  for (const r of sheet.getRange(2, 1, n, 2).getValues()) {
    const a = String(r[0] || '').trim(), b = String(r[1] || '').trim();
    if (a) out.retailers.push(a);
    if (b) out.meters.push(b);
  }
  return out;
}

function bettyDefaults_() {
  const cfg = getConfig_();
  const num = (v, d) => { const n = Number(v); return String(v === undefined || v === null ? '' : v).trim() !== '' && isFinite(n) && n >= 0 ? n : d; };
  return { contractDays: num(cfg.rates_default_contract_days, BETTY_DEFAULT_CONTRACT_DAYS),
    brokerage: num(cfg.rates_default_brokerage, BETTY_DEFAULT_BROKERAGE) };
}

/** Client: Betty's lists and the Enter rates defaults. */
function apiBettyLists() {
  const l = bettyLists_();
  return { retailers: l.retailers, meters: l.meters, defaults: bettyDefaults_() };
}

/**
 * Read a Bulk Import Template exported from Betty. Returns its
 * Current rows by ICP ({ analysisId, customerId, registeredName,
 * retailer, analysisType, comments, meters: [{ name, monthly, unit }],
 * fields: { daily, ... } }) and refreshes the Betty Lists tab from its
 * Information sheet. Nothing is written to the uploaded file.
 */
function apiBettyLoad(base64Data, uploadName) {
  const runRef = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyyMMdd-HHmmss');
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', uploadName || 'betty-template.xlsx');
  const temp = Drive.Files.create({ name: 'Walter Betty load ' + runRef, mimeType: MimeType.GOOGLE_SHEETS }, blob);
  try {
    const ss = SpreadsheetApp.openById(temp.id);
    const bulk = ss.getSheetByName('Bulk Analysis');
    if (!bulk) throw new Error('This file has no "Bulk Analysis" sheet — it must be the Bulk Import Template from Betty, not an export snapshot.');
    const lastRow = bulk.getLastRow(), lastCol = bulk.getLastColumn();
    const headers = bulk.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
    const col = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
    const cIcp = col('ICP Identifier'), cStatus = col('Status (Analysis)');
    if (cIcp < 0 || cStatus < 0) throw new Error('Template columns not recognised (ICP Identifier / Status (Analysis)).');
    const get = (row, name) => { const c = col(name); return c < 0 ? '' : row[c]; };
    const numOr = (v) => { const n = Number(v); return String(v === null || v === undefined ? '' : v).trim() !== '' && isFinite(n) ? n : 0; };
    const out = { rows: {}, dupCurrent: [], otherRows: 0, fileName: String(uploadName || '') };
    const vals = lastRow > 1 ? bulk.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
    for (const row of vals) {
      const icp = String(row[cIcp] || '').trim().toUpperCase();
      if (!icp) continue;
      if (String(row[cStatus] || '').trim().toLowerCase() !== 'current') { out.otherRows++; continue; }
      if (out.rows[icp]) { out.dupCurrent.push(icp); continue; }
      const meters = [];
      for (let n = 1; n <= 4; n++) {
        const name = String(get(row, 'Meter ' + n) || '').trim();
        if (name) meters.push({ name: name, monthly: numOr(get(row, 'Monthly Consumption ' + n)), unit: numOr(get(row, 'Unit Cost ' + n)) });
      }
      const fields = {};
      for (const key in BETTY_RATE_COLUMNS) fields[key] = numOr(get(row, BETTY_RATE_COLUMNS[key]));
      out.rows[icp] = { analysisId: String(get(row, 'Customer Analysis ID') || '').trim(), customerId: String(get(row, 'Customer ID') || '').trim(),
        registeredName: String(get(row, 'Registered Name') || '').trim(), retailer: String(get(row, 'Retailer') || '').trim(),
        analysisType: String(get(row, 'Analysis Type') || '').trim().toUpperCase(), comments: String(get(row, 'Comments') || ''),
        meters: meters, fields: fields };
    }
    // Keep Walter's copy of Betty's lists current.
    try {
      const info = ss.getSheetByName('Information');
      if (info && info.getLastRow() > 1) {
        const iv = info.getRange(1, 1, info.getLastRow(), info.getLastColumn()).getValues();
        const pick = (re) => { const c = iv[0].findIndex(h => re.test(String(h || ''))); return c < 0 ? [] : iv.slice(1).map(r => String(r[c] || '').trim()).filter(Boolean); };
        const rets = pick(/retailer/i), mets = pick(/meter/i);
        const cur = bettyLists_();
        if (rets.length && mets.length && (rets.join('|') !== cur.retailers.join('|') || mets.join('|') !== cur.meters.join('|'))) {
          bettyListsWrite_(bettyListsSheet_(), rets, mets);
        }
      }
    } catch (e) {}
    const lists = bettyLists_();
    out.retailers = lists.retailers; out.meters = lists.meters; out.defaults = bettyDefaults_();
    return out;
  } finally {
    try { DriveApp.getFileById(temp.id).setTrashed(true); } catch (e) {}
  }
}

/**
 * Write a NEW Betty import file: one Current row per entry of
 * payload.rows ({ analysisId, customerId, registeredName, icp,
 * retailer, analysisType, comments, meters: [{ name, monthly, unit }],
 * fields: { daily, ... } }). Every cost is already $ excl GST.
 * Betty rejects a whole file over one bad row, so this function does
 * too: every row is checked first and nothing is written if any fails.
 */
function apiBettyWrite(payload) {
  const rows = (payload && payload.rows) || [];
  if (!rows.length) throw new Error('No rows to write.');
  if (rows.length > 2000) throw new Error('Too many rows for one file (' + rows.length + ').');
  const lists = bettyLists_();
  const canon = (list, v) => { const k = bettyKey_(v); for (const x of list) if (bettyKey_(x) === k) return x; return ''; };
  const errors = [], seen = {}, values = [], flagsLog = [];
  let ratesRows = 0, updates = 0, creates = 0;
  const custIds = {}; let custName = '';
  const num = (v) => { const n = Number(v); return v === null || v === undefined || String(v).trim() === '' || !isFinite(n) ? 0 : n; };
  for (const r of rows) {
    const icp = String(r.icp || '').trim().toUpperCase();
    const tag = icp || '(row without an ICP)';
    if (!icp) { errors.push('a row has no ICP'); continue; }
    if (seen[icp]) { errors.push(tag + ': listed twice (only one Current analysis per ICP)'); continue; }
    seen[icp] = true;
    const custId = String(r.customerId || '').trim();
    if (!custId) errors.push(tag + ': no customer ID');
    const retailer = canon(lists.retailers, r.retailer);
    if (!retailer) errors.push(tag + ': retailer "' + String(r.retailer || '') + '" is not in Betty’s list');
    const aType = String(r.analysisType || '').trim().toUpperCase();
    if (BETTY_ANALYSIS_TYPES.indexOf(aType) === -1) errors.push(tag + ': analysis type "' + aType + '" is not ELECTRICITY or GAS');
    const meters = r.meters || [];
    if (!meters.length) errors.push(tag + ': no meters');
    if (meters.length > 4) errors.push(tag + ': ' + meters.length + ' meters (Betty has four slots)');
    const line = [String(r.analysisId || '').trim(), /^\d+$/.test(custId) ? Number(custId) : custId, String(r.registeredName || ''), icp,
      retailer, 'Current', aType, String(r.comments || '')];
    let anyRate = false;
    for (let n = 0; n < 4; n++) {
      const m = meters[n];
      if (!m) { line.push('', 0, 0); continue; }
      const name = canon(lists.meters, m.name);
      if (!name) errors.push(tag + ': "' + String(m.name || '') + '" is not a Betty meter type');
      // v2.27: how each figure came about goes to the Flags Log with the file.
      if (m.combined) flagsLog.push([icp, name || String(m.name || ''), 'COMBINED', String(m.src || '')]);
      else if (m.est) flagsLog.push([icp, name || String(m.name || ''), 'ESTIMATED_FROM_BILL', String(m.src || '')]);
      else if (m.manual) flagsLog.push([icp, name || String(m.name || ''), 'MANUAL_FIGURE', String(m.src || '') + ' = ' + Math.round(Number(m.monthly) || 0)]);
      const monthly = Number(m.monthly), unit = num(m.unit);
      if (!isFinite(monthly) || monthly < 0) errors.push(tag + ': ' + String(m.name || '') + ' has no monthly figure');
      if (unit < 0) errors.push(tag + ': ' + String(m.name || '') + ' has a negative unit cost');
      if (unit > 0) anyRate = true;
      line.push(name, Math.round(monthly), unit);
    }
    const fields = r.fields || {};
    for (let c = 20; c < BETTY_HEADERS.length; c++) {
      let key = '';
      for (const k in BETTY_RATE_COLUMNS) if (BETTY_RATE_COLUMNS[k].toLowerCase() === BETTY_HEADERS[c].toLowerCase()) key = k;
      const raw = fields[key];
      const blank = raw === undefined || raw === null || String(raw).trim() === '';
      // A brokerage fee nobody typed stays an empty cell; every other charge is 0.
      const v = blank ? (key === 'brokerage' ? '' : 0) : num(raw);
      if (v && key !== 'contractDays' && key !== 'brokerage') anyRate = true;
      line.push(v);
    }
    values.push(line);
    if (anyRate) ratesRows++;
    if (line[0]) updates++; else { creates++; flagsLog.push([icp, '', 'NEW_ANALYSIS', 'no analysis ID - Betty creates the Current analysis']); }
    if (custId) { custIds[custId] = true; custName = custName || String(r.registeredName || ''); }
  }
  if (errors.length) {
    throw new Error('Nothing was written — ' + errors.length + ' problem(s): ' + errors.slice(0, 6).join('; ') + (errors.length > 6 ? '; …' : ''));
  }
  const idList = Object.keys(custIds);
  const label = idList.length === 1 ? idList[0] + ' ' + custName : 'several customers';
  const outName = 'BET - ' + label.replace(/[\\\/\[\]\*\?:]/g, ' ').slice(0, 80) + ' - ' +
    Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd HHmm');
  const tmp = SpreadsheetApp.create('Walter Betty file ' + outName);
  try {
    const sheet = tmp.getSheets()[0];
    sheet.setName('Bulk Analysis');
    const W = BETTY_HEADERS.length;
    if (sheet.getMaxColumns() < W) sheet.insertColumnsAfter(sheet.getMaxColumns(), W - sheet.getMaxColumns());
    sheet.getRange(1, 1, values.length + 1, W).setValues([BETTY_HEADERS].concat(values));
    sheet.getRange(2, 4, values.length, 1).setNumberFormat('@'); // ICPs stay text
    if (sheet.getMaxRows() > values.length + 1) sheet.deleteRows(values.length + 2, sheet.getMaxRows() - values.length - 1);
    const info = tmp.insertSheet('Information');
    const iv = [['Retailers', '', 'Status (Analysis)', '', 'Analysis Type', '', 'Meter Types']];
    const n = Math.max(lists.retailers.length, lists.meters.length, BETTY_STATUSES.length);
    for (let i = 0; i < n; i++) iv.push([lists.retailers[i] || '', '', BETTY_STATUSES[i] || '', '', BETTY_ANALYSIS_TYPES[i] || '', '', lists.meters[i] || '']);
    info.getRange(1, 1, iv.length, 7).setValues(iv);
    SpreadsheetApp.flush();
    const outFile = bettyFolder_().createFile(exportXlsx_(tmp.getId()).setName(outName + '.xlsx'));
    const share = bettyShare_(outFile);
    try { writeFlagsLog_(outFile.getName(), flagsLog); } catch (e) {}
    let indexError = '';
    try {
      betIndexAdd_({ customerId: idList.join(', '), customer: idList.length === 1 ? custName : '',
        icps: values.map(v => v[3]), hasRates: ratesRows > 0, file: outFile });
    } catch (e) { indexError = String(e.message || e); }
    return { ok: true, outputUrl: outFile.getUrl(), outputName: outFile.getName(), fileId: outFile.getId(),
      rowsWritten: values.length, updates: updates, creates: creates, ratesRows: ratesRows,
      sharedWith: share.sharedWith, shareError: share.shareError, indexError: indexError };
  } finally {
    try { DriveApp.getFileById(tmp.getId()).setTrashed(true); } catch (e) {}
  }
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
  'file name', 'file id', 'url', 'size bytes', 'rates (Y/N)', 'deleted at', 'deleted by', 'delete reason'];
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
  // v2.25: shared QUIETLY - Drive's "X shared a spreadsheet with you"
  // email on every Betty file was noise for the operators (Yuka, 17
  // Nov). The advanced Drive service can suppress it; DriveApp cannot,
  // so it is only the fallback.
  for (const a of Object.keys(emails)) {
    try {
      Drive.Permissions.create({ role: 'reader', type: 'user', emailAddress: a }, file.getId(), { sendNotificationEmail: false });
      ok.push(a);
    } catch (e1) {
      try { file.addViewer(a); ok.push(a); } catch (e2) { bad.push(a); }
    }
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
  // v2.21: delete columns, added to a tab made by an earlier build.
  if (!sheet.getRange(1, 12).getValue()) {
    sheet.getRange(1, 12, 1, 3).setValues([BET_INDEX_HEADERS.slice(11, 14)]).setFontWeight('bold');
  }
  return sheet;
}

/**
 * Delete a Betty file from the Archive (v2.21) - same rules as a CDF
 * (apiCdfDelete): the Drive file goes to the BIN, never a permanent
 * delete; any operator may do it; the index row is kept and marked
 * with when, who and the reason typed (required).
 */
function apiBetDelete(fileId, reason) {
  fileId = String(fileId || '').trim();
  reason = String(reason || '').trim().slice(0, 500);
  if (!fileId) throw new Error('No file given.');
  if (!reason) throw new Error('A reason is required to delete a file.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = betIndexSheet_();
    const n = sheet.getLastRow() - 1;
    if (n < 1) throw new Error('That file is not in the Betty Index.');
    const vals = sheet.getRange(2, 1, n, BET_INDEX_HEADERS.length).getValues();
    const hits = [];
    let already = false;
    for (let i = 0; i < n; i++) {
      if (String(vals[i][7]).trim() !== fileId) continue;
      if (String(vals[i][11] || '').trim() !== '') { already = true; continue; }
      hits.push(i);
    }
    if (!hits.length) throw new Error(already ? 'That file is already marked as deleted.' : 'That file is not in the Betty Index.');
    let name = String(vals[hits[0]][6] || '');
    let fileNote = '';
    let file = null;
    try { file = DriveApp.getFileById(fileId); } catch (e) { fileNote = ' [file was already missing from Drive]'; }
    if (file) {
      name = file.getName();
      if (name.indexOf('BET - ') !== 0) throw new Error('Not a Betty file: ' + name);
      if (file.isTrashed()) fileNote = ' [file was already in the bin]';
      else file.setTrashed(true);
    }
    let operator = '';
    try { operator = Session.getActiveUser().getEmail(); } catch (e) {}
    const now = new Date();
    for (const i of hits) sheet.getRange(i + 2, 12, 1, 3).setValues([[now, operator, reason + fileNote]]);
    SpreadsheetApp.flush();
    return { ok: true, name: name, note: fileNote };
  } finally {
    lock.releaseLock();
  }
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
      deletedAt: r[11] instanceof Date ? Utilities.formatDate(r[11], 'Pacific/Auckland', 'yyyy-MM-dd HH:mm') : String(r[11] || ''),
      deletedBy: String(r[12] || ''), deleteReason: String(r[13] || ''),
    });
  }
  return out;
}
