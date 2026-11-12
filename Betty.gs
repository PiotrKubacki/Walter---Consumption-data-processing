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
 * bandData (v2.16.1, optional): { "<icp>|<register>": { schedule,
 * slots: [{ name, monthly }] } } - the time bands shown on the
 * Workbench (after any fold). An ICP-register listed there is written
 * band by band; every other register is written whole, through the
 * Register Map, as before.
 */
function apiBettyFill(base64Data, uploadName, fileIds, bandData) {
  const bandMap = bandData || {};
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

  const summary = { updated: [], notUpdated: [], flagged: [], vocabularyGaps: [] };
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
      if (m >= 0 && c >= 0) slots.push({ meterCol: m, consCol: c });
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
      const rowFlags = [];
      const writtenCols = {};
      let usedBands = false;
      for (const g of groups) {
        const a = g.analysis;
        if (a.avm === null || a.grade === 'NO_DATA') {
          rowFlags.push(g.register + ': no AVM (' + a.grade + ')');
          continue;
        }
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
          if (writeName) bulk.getRange(sheetRow, target.meterCol + 1).setValue(bettyType);
          bulk.getRange(sheetRow, target.consCol + 1).setValue(value);
          row[target.meterCol] = bettyType; // keep local copy current for multi-register ICPs
          row[target.consCol] = value;
          writtenCols[target.meterCol] = true;
          rowUpdates.push(label + ' \u2192 ' + bettyType + ' = ' + value + ' (' + a.gradeEmoji + ' ' + a.grade + ')');
        };

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
      if (rowUpdates.length) summary.updated.push({ icp: icp, customer: groups[0].lookup.registeredName, detail: rowUpdates, flags: rowFlags });
      else summary.notUpdated.push({ icp: icp, reason: rowFlags.join('; ') || 'nothing writable' });
    }

    // Trim Bulk Analysis surplus rows (B1 spike: required by Betty's importer)
    const maxRows = bulk.getMaxRows();
    if (maxRows > lastDataRow) bulk.deleteRows(lastDataRow + 1, maxRows - lastDataRow);

    SpreadsheetApp.flush();

    // Export xlsx to the output folder
    const outBlob = exportXlsx_(temp.id).setName('Betty filled ' + runRef + '.xlsx');
    const outFile = DriveApp.getFolderById(requireConfig_('output_folder_id')).createFile(outBlob);

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
