// =====================================================
// CDP App - RFP (bulk pricing requests) - v2.0 redesign
// -----------------------------------------------------
// Replaces BulkQuote.gs (design: CDP-RFP-REDESIGN.md,
// signed off 31 Oct 2026). The model:
//   * RFP Queue     - one row per ICP, status OPEN / CLOSED /
//                     REMOVED. "Sent" is NEVER a row status.
//   * RFP Retailers - registry as data: fuels accepted, bulk vs
//                     per-customer, email address + templates.
//   * RFP Schemas   - each retailer's CSV layout as ordered
//                     header -> source-field rows. Adding a
//                     retailer = adding rows, zero code.
//   * RFP Send Log  - immutable batch log. Powers the per-row
//                     coverage chips and the duplicate-send
//                     warning; it is never edited or cleared
//                     (except by the testing reset).
// Rows accumulate sends and stay OPEN until the operator closes
// them (assisted close with manual confirmation - decision 2).
// While the rfp_test_redirect Config key is set, EVERY RFP email
// goes to that address instead of the registry one (decision 3).
// Build is review-only; only Send writes history (same build ->
// review -> send contract as v1.9).
// =====================================================

const RFP_QUEUE_TAB = 'RFP Queue';
const RFP_RETAILERS_TAB = 'RFP Retailers';
const RFP_SCHEMAS_TAB = 'RFP Schemas';
const RFP_LOG_TAB = 'RFP Send Log';
const RFP_FILE_PREFIX = 'Bulk Pricing Requests - ';
// Urgent-pathway files carry their own name pattern (9 Nov):
// "Urgent Pricing Request - TUC->Nova - 2026-11-09".
const RFP_URGENT_FILE_PREFIX = 'Urgent Pricing Request - ';
// Prospect sessions (10 Nov): a customer that is not in Betty has no
// customer id. Its queue rows carry this marker in the customer id
// column; retailer files get a blank Customer ID for those rows.
const RFP_PROSPECT_ID = 'PROSPECT';

const RFP_TAB_DEFS = [
  { name: RFP_QUEUE_TAB, headers: ['id', 'date added', 'status', 'urgent', 'extension',
      'customer id', 'registered name', 'trading name', 'icp', 'icp type',
      'est annual kwh', 'consumption file', 'closed date', 'ext retailer'] },
  { name: RFP_RETAILERS_TAB, headers: ['code', 'display name', 'fuels (ELEC/GAS/BOTH)',
      'mode (BULK/PER-CUSTOMER)', 'email to', 'email cc', 'subject template',
      'body template', 'active (Y/N)', 'notes'] },
  { name: RFP_SCHEMAS_TAB, headers: ['retailer', 'order', 'header', 'source field'] },
  { name: RFP_LOG_TAB, headers: ['batch id', 'timestamp', 'operator', 'retailer',
      'pathway', 'file name', 'file url', 'emailed to', 'row ids', 'icps'] },
];

// Registry seed. Retailer email addresses can be filled any time -
// the rfp_test_redirect Config key protects until the app is trusted.
const RFP_RETAILER_SEED = [
  ['NOVA',      'Nova',      'BOTH', 'BULK', '', '', '', '', 'Y', ''],
  ['LODESTONE', 'Lodestone', 'ELEC', 'BULK', '', '', '', '', 'Y', ''],
  ['MERIDIAN',  'Meridian',  'ELEC', 'BULK', '', '', '', '', 'Y', ''],
  ['CONTACT',   'Contact',   'BOTH', 'PER-CUSTOMER', '', '', '', '', 'N', 'quotes per customer only; needs an LOA attached - placeholder until that is solved'],
];

// Schema seed: the NOVA and LODESTONE sample files (Oct 2026), as
// data. Source-field vocabulary (anything else fails loudly):
//   customer_id | registered_name | trading_name | icp | fuel_type |
//   annual_kwh | current_retailer | physical_address | poc | blank |
//   constant:<text>
// current_retailer / physical_address / poc resolve at build time
// from the EA ICPs import sheet; electricity ICPs missing from the
// import (prospects) are filled from the EA registry itself via the
// EA module (10 Nov). Gas ICPs have no EA row -> blank.
const RFP_SCHEMA_SEED = [
  ['NOVA', 1, 'Customer ID', 'customer_id'],
  ['NOVA', 2, 'ICP', 'icp'],
  ['NOVA', 3, 'Estimated Annual Consumption', 'annual_kwh'],
  ['NOVA', 4, 'Current Retailer', 'current_retailer'],
  ['NOVA', 5, "Customer's Registered Name", 'registered_name'],
  ['NOVA', 6, "Customer's Trading Name", 'trading_name'],
  ['NOVA', 7, 'Fuel Type', 'fuel_type'],
  ['NOVA', 8, 'Pricing Type', 'constant:NHH'],
  ['NOVA', 9, 'Physical Address', 'physical_address'],
  ['NOVA', 10, 'Contract Start Date', 'blank'],
  ['LODESTONE', 1, 'Customer ID', 'customer_id'],
  ['LODESTONE', 2, "Customer's Registered Name", 'registered_name'],
  ['LODESTONE', 3, "Customer's Trading Name", 'trading_name'],
  ['LODESTONE', 4, 'ICP Type', 'fuel_type'],
  ['LODESTONE', 5, 'ICP', 'icp'],
  ['LODESTONE', 6, 'Estimated Annual Consumption', 'annual_kwh'],
  ['LODESTONE', 7, 'POC', 'poc'],
  // Meridian sample file, Oct 2026: LODESTONE layout minus POC.
  ['MERIDIAN', 1, 'Customer ID', 'customer_id'],
  ['MERIDIAN', 2, "Customer's Registered Name", 'registered_name'],
  ['MERIDIAN', 3, "Customer's Trading Name", 'trading_name'],
  ['MERIDIAN', 4, 'ICP Type', 'fuel_type'],
  ['MERIDIAN', 5, 'ICP', 'icp'],
  ['MERIDIAN', 6, 'Estimated Annual Consumption', 'annual_kwh'],
];

const RFP_CONFIG_KEYS = [
  ['rfp_test_redirect', 'peter@theutilitycompany.net',
   'While set, ALL RFP emails go here instead of the retailer registry addresses. Blank it to go live.'],
];

// ---------------- setup + migration ----------------

let _rfpSetupDone_ = false;

/**
 * Idempotent self-heal, run at the top of every RFP entry point:
 * creates missing tabs, seeds the registry/schemas when empty,
 * adds the redirect Config key, and migrates the old Bulk Quote
 * Queue rows ONCE (QUEUED->OPEN, EXPORTED->CLOSED with the batch
 * date as closed date, extension cols collapsed to one flag).
 * The old tab is renamed to an archive name so migration cannot
 * run twice. bootstrapBackingSheet() also calls this.
 */
function rfpEnsureSetup_() {
  if (_rfpSetupDone_) return;
  const ss = SpreadsheetApp.openById(getConfig_()._backingId);

  for (const def of RFP_TAB_DEFS) {
    let sheet = ss.getSheetByName(def.name);
    if (!sheet) sheet = ss.insertSheet(def.name);
    if (!sheet.getRange(1, 1).getValue()) {
      sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }

  // Additive queue column (9 Nov): "ext retailer" — the retailer an
  // extension goes to. OPERATOR INPUT (the expiring quote's retailer,
  // which may never have held the ICP), never the EA incumbent.
  const qHdr = ss.getSheetByName(RFP_QUEUE_TAB);
  if (!qHdr.getRange(1, 14).getValue()) {
    qHdr.getRange(1, 14).setValue('ext retailer').setFontWeight('bold');
  }

  // Seeding is ADDITIVE BY RETAILER CODE, not just on an empty tab:
  // a seed retailer that arrives after the first bootstrap (Meridian,
  // Oct 2026) is appended; rows an operator already has are never
  // touched or re-written.
  const rtSheet = ss.getSheetByName(RFP_RETAILERS_TAB);
  const rtPresent = {};
  if (rtSheet.getLastRow() > 1) {
    const codes = rtSheet.getRange(2, 1, rtSheet.getLastRow() - 1, 1).getValues();
    for (const c of codes) rtPresent[String(c[0]).trim().toUpperCase()] = true;
  }
  const rtMissing = RFP_RETAILER_SEED.filter(r => !rtPresent[String(r[0]).toUpperCase()]);
  if (rtMissing.length) {
    rtSheet.getRange(rtSheet.getLastRow() + 1, 1, rtMissing.length, 10).setValues(rtMissing);
  }

  const scSheet = ss.getSheetByName(RFP_SCHEMAS_TAB);
  const scPresent = {};
  if (scSheet.getLastRow() > 1) {
    const codes = scSheet.getRange(2, 1, scSheet.getLastRow() - 1, 1).getValues();
    for (const c of codes) scPresent[String(c[0]).trim().toUpperCase()] = true;
  }
  const scMissing = RFP_SCHEMA_SEED.filter(r => !scPresent[String(r[0]).toUpperCase()]);
  if (scMissing.length) {
    scSheet.getRange(scSheet.getLastRow() + 1, 1, scMissing.length, 4).setValues(scMissing);
  }

  // Meridian went live when its sample arrived (Oct 2026): a registry
  // row still carrying the old placeholder note is flipped active.
  // A row an operator has edited (different note) is left alone.
  if (rtSheet.getLastRow() > 1) {
    const vals = rtSheet.getRange(2, 1, rtSheet.getLastRow() - 1, 10).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim().toUpperCase() !== 'MERIDIAN') continue;
      if (!/^y/i.test(String(vals[i][8])) &&
          String(vals[i][9]).indexOf('schema pending') === 0) {
        rtSheet.getRange(i + 2, 9).setValue('Y');
        rtSheet.getRange(i + 2, 10).setValue('');
      }
      break;
    }
  }

  // Config keys (additive, same contract as bootstrap)
  const cfgSheet = ss.getSheetByName('Config');
  if (cfgSheet) {
    const existing = {};
    if (cfgSheet.getLastRow() > 1) {
      const keys = cfgSheet.getRange(2, 1, cfgSheet.getLastRow() - 1, 1).getValues();
      for (const k of keys) existing[String(k[0]).trim()] = true;
    }
    const toAdd = RFP_CONFIG_KEYS.filter(k => !existing[k[0]]);
    if (toAdd.length) cfgSheet.getRange(cfgSheet.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
  }

  // One-time migration from the v1.9 Bulk Quote Queue
  const qSheet = ss.getSheetByName(RFP_QUEUE_TAB);
  const old = ss.getSheetByName('Bulk Quote Queue');
  if (old && qSheet.getLastRow() <= 1 && old.getLastRow() > 1) {
    const vals = old.getRange(2, 1, old.getLastRow() - 1, 15).getValues();
    const out = [];
    for (const r of vals) {
      const oldStatus = String(r[2]).trim().toUpperCase();
      const status = oldStatus === 'QUEUED' ? 'OPEN'
        : oldStatus === 'EXPORTED' ? 'CLOSED' : oldStatus;
      out.push([
        r[0], r[1], status, String(r[3]).trim() ? 'URGENT' : '',
        (String(r[10]).trim() || String(r[11]).trim()) ? 'Y' : '',
        r[4], r[5], r[6], r[7], r[8], r[9], r[13],
        status === 'CLOSED' ? (r[14] || '') : '',
      ]);
    }
    if (out.length) qSheet.getRange(2, 1, out.length, 13).setValues(out);
    try { old.setName('Bulk Quote Queue (pre-RFP)'); } catch (e) {}
    Logger.log('RFP migration: ' + out.length + ' row(s) migrated from Bulk Quote Queue.');
  }

  _rfpSetupDone_ = true;
}

function rfpSheet_(name) {
  rfpEnsureSetup_();
  return SpreadsheetApp.openById(getConfig_()._backingId).getSheetByName(name);
}

// ---------------- registry / schemas / log loaders ----------------

function loadRfpRetailers_() {
  const sheet = rfpSheet_(RFP_RETAILERS_TAB);
  const out = [];
  if (sheet.getLastRow() < 2) return out;
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  for (const r of vals) {
    const code = String(r[0] || '').trim().toUpperCase();
    if (!code) continue;
    out.push({
      code: code,
      name: String(r[1] || '').trim() || code,
      fuels: String(r[2] || 'BOTH').trim().toUpperCase(),
      mode: String(r[3] || 'BULK').trim().toUpperCase(),
      to: String(r[4] || '').trim(),
      cc: String(r[5] || '').trim(),
      subjectTemplate: String(r[6] || '').trim(),
      bodyTemplate: String(r[7] || '').trim(),
      active: /^y/i.test(String(r[8] || '').trim()),
      notes: String(r[9] || '').trim(),
    });
  }
  return out;
}

function loadRfpSchemas_() {
  const sheet = rfpSheet_(RFP_SCHEMAS_TAB);
  const map = {};
  if (sheet.getLastRow() < 2) return map;
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  for (const r of vals) {
    const code = String(r[0] || '').trim().toUpperCase();
    if (!code) continue;
    (map[code] = map[code] || []).push({
      order: +r[1] || 0,
      header: String(r[2] || ''),
      source: String(r[3] || '').trim(),
    });
  }
  for (const code in map) map[code].sort((a, b) => a.order - b.order);
  return map;
}

/** icp -> { RETAILERCODE: 'yyyy-MM-dd' of latest send } from the log. */
function rfpCoverage_() {
  const sheet = rfpSheet_(RFP_LOG_TAB);
  const cov = {};
  if (sheet.getLastRow() < 2) return cov;
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  for (const r of vals) {
    const ret = String(r[3] || '').trim().toUpperCase();
    const when = r[1] ? Utilities.formatDate(new Date(r[1]), 'Pacific/Auckland', 'yyyy-MM-dd') : '';
    const icps = String(r[9] || '').split(',');
    for (let icp of icps) {
      icp = icp.trim();
      if (!icp || !ret) continue;
      const m = cov[icp] || (cov[icp] = {});
      if (!m[ret] || when > m[ret]) m[ret] = when;
    }
  }
  return cov;
}

// ---------------- the RFP tab API ----------------

/**
 * Lightweight registry list for the Workbench extension-retailer
 * dropdown (9 Nov): BULK retailers that have a file schema. Inactive
 * ones included — extensions may go to an inactive retailer.
 */
function apiRfpRetailerOptions() {
  rfpEnsureSetup_();
  const schemas = loadRfpSchemas_();
  return loadRfpRetailers_()
    .filter(rt => rt.mode === 'BULK' && schemas[rt.code] && schemas[rt.code].length)
    .map(rt => ({ code: rt.code, name: rt.name, active: rt.active }));
}

function apiRfpList() {
  rfpEnsureSetup_();
  const sheet = rfpSheet_(RFP_QUEUE_TAB);
  const retailers = loadRfpRetailers_();
  const schemas = loadRfpSchemas_();
  for (const rt of retailers) rt.hasSchema = !!(schemas[rt.code] && schemas[rt.code].length);

  const rows = [];
  if (sheet.getLastRow() > 1) {
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 14).getValues();
    for (const r of vals) {
      const status = String(r[2]).trim().toUpperCase();
      if (status === 'REMOVED') continue;
      rows.push({
        id: String(r[0]),
        added: r[1] ? Utilities.formatDate(new Date(r[1]), 'Pacific/Auckland', 'yyyy-MM-dd') : '',
        status: status,
        urgent: !!String(r[3]).trim(),
        extension: !!String(r[4]).trim(),
        customerId: String(r[5]),
        customer: String(r[6]),
        tradingName: String(r[7]),
        icp: String(r[8]).trim(),
        icpType: String(r[9]),
        annualKwh: r[10],
        fileUrl: String(r[11]),
        closedDate: r[12] ? Utilities.formatDate(new Date(r[12]), 'Pacific/Auckland', 'yyyy-MM-dd') : '',
        // 9 Nov: operator-set extension retailer (expiring quote's
        // retailer). The old EA-incumbent lookup was the WRONG concept
        // for extensions and is gone.
        extRetailer: String(r[13] || '').trim().toUpperCase(),
      });
    }
  }

  // Keep the payload sane: all OPEN rows, but only the 25 most
  // recently closed (the sheet keeps the full history).
  const open = rows.filter(r => r.status === 'OPEN');
  const closed = rows.filter(r => r.status === 'CLOSED').slice(-25).reverse();

  // Send history, newest first, capped at 30 batches.
  const logSheet = rfpSheet_(RFP_LOG_TAB);
  const batches = [];
  if (logSheet.getLastRow() > 1) {
    const lv = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 10).getValues();
    for (const r of lv) {
      batches.push({
        batchId: String(r[0]),
        when: r[1] ? Utilities.formatDate(new Date(r[1]), 'Pacific/Auckland', 'yyyy-MM-dd HH:mm') : '',
        operator: String(r[2]),
        retailer: String(r[3]),
        pathway: String(r[4]),
        fileName: String(r[5]),
        fileUrl: String(r[6]),
        to: String(r[7]),
        count: String(r[9] || '').split(',').filter(String).length,
      });
    }
    batches.reverse();
    batches.length = Math.min(batches.length, 30);
  }

  return {
    rows: open.concat(closed),
    retailers: retailers,
    coverage: rfpCoverage_(),
    batches: batches,
    redirect: getConfig_()['rfp_test_redirect'] || '',
  };
}

/** One queue cell from one schema source field. Fails loudly on typos. */
function rfpRenderCell_(source, row, ea) {
  if (source.indexOf('constant:') === 0) return source.slice(9);
  const d = ea[row.icp] || {};
  switch (source) {
    case 'customer_id': return String(row.customerId) === RFP_PROSPECT_ID ? '' : row.customerId;
    case 'registered_name': return row.customer;
    case 'trading_name': return row.tradingName;
    case 'icp': return row.icp;
    case 'fuel_type': return row.isGas ? 'GAS' : 'ELECTRICITY';
    case 'annual_kwh': return row.annualKwh;
    case 'current_retailer': return d.trader || '';
    case 'physical_address': return d.address || '';
    case 'poc': return d.poc || '';
    case 'blank': return '';
    default:
      throw new Error('RFP Schemas: unknown source field "' + source +
        '". Allowed: customer_id, registered_name, trading_name, icp, fuel_type, ' +
        'annual_kwh, current_retailer, physical_address, poc, blank, constant:<text>.');
  }
}

function rfpPathwayWord_(pathway) {
  return pathway === 'URGENT' ? 'URGENT bulk'
    : pathway === 'EXTENSION' ? 'contract extension'
    : 'bulk';
}

function rfpFillTemplate_(tmpl, dflt, ctx) {
  const s = String(tmpl || '').trim() || dflt;
  return s.replace(/\{(\w+)\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k]) : m;
  });
}

/**
 * BUILD ONLY: CSV per the retailer's schema + an editable email
 * draft. Nothing is emailed, nothing is logged - only apiRfpSend
 * writes history. Duplicate-send ICPs (already in the log for this
 * retailer) are returned for a loud warning, never silently blocked
 * or silently resent (decision 4).
 */
function apiRfpBuild(retailerCode, pathway, rowIds) {
  rfpEnsureSetup_();
  const code = String(retailerCode || '').trim().toUpperCase();
  pathway = String(pathway || 'STANDARD').trim().toUpperCase();
  const retailers = loadRfpRetailers_();
  const rt = retailers.filter(r => r.code === code)[0];
  if (!rt) throw new Error('No "' + code + '" row on the RFP Retailers tab.');
  if (rt.mode !== 'BULK') throw new Error(rt.name + ' takes per-customer requests only, not bulk files.');
  if (!rt.active && pathway !== 'EXTENSION') {
    throw new Error(rt.name + ' is marked inactive on the RFP Retailers tab.');
  }
  const schema = loadRfpSchemas_()[code];
  if (!schema || !schema.length) {
    throw new Error('No file schema for ' + rt.name + ' - add its rows to the RFP Schemas tab first.');
  }

  const want = {};
  for (const id of rowIds || []) want[String(id)] = true;
  const sheet = rfpSheet_(RFP_QUEUE_TAB);
  if (sheet.getLastRow() < 2) return { ok: false, note: 'Queue is empty.' };
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 13).getValues();

  const rows = [];
  let skippedFuel = 0;
  for (const r of vals) {
    if (!want[String(r[0])]) continue;
    if (String(r[2]).trim().toUpperCase() !== 'OPEN') continue;
    const isGas = String(r[9]).trim().toLowerCase() === 'gas';
    if ((isGas && rt.fuels === 'ELEC') || (!isGas && rt.fuels === 'GAS')) { skippedFuel++; continue; }
    rows.push({
      id: String(r[0]), customerId: r[5], customer: String(r[6]),
      tradingName: String(r[7]), icp: String(r[8]).trim(), isGas: isGas, annualKwh: r[10],
    });
  }
  if (!rows.length) {
    return { ok: false, note: 'Nothing to build - no ticked OPEN rows' +
      (skippedFuel ? ' (' + skippedFuel + ' excluded: ' + rt.name + ' takes ' +
        (rt.fuels === 'ELEC' ? 'electricity' : 'gas') + ' only)' : '') + '.' };
  }

  // EA lookup only when the schema needs it
  const needsEa = schema.some(c =>
    ['current_retailer', 'physical_address', 'poc'].indexOf(c.source) !== -1);
  let ea = {};
  let eaInfo = null;
  if (needsEa) {
    const got = rfpEaDetails_(rows.filter(r => !r.isGas).map(r => r.icp));
    ea = got.map;
    eaInfo = got.info;
  }
  let gasBlanks = 0;
  const header = schema.map(c => c.header);
  const data = rows.map(row => {
    if (needsEa && row.isGas && !(ea[row.icp] || {}).trader) gasBlanks++;
    return schema.map(c => rfpRenderCell_(c.source, row, ea));
  });

  const stamp = Utilities.formatDate(new Date(), 'Pacific/Auckland', 'yyyy-MM-dd');
  const name = pathway === 'URGENT'
    ? RFP_URGENT_FILE_PREFIX + 'TUC->' + rt.name + ' - ' + stamp
    : RFP_FILE_PREFIX + code + ' - ' + stamp +
      (pathway === 'EXTENSION' ? ' - EXTENSION' : '');
  const csv = [header].concat(data)
    .map(row => row.map(csvCell_).join(','))
    .join('\r\n');
  const outFile = DriveApp.getFolderById(requireConfig_('output_folder_id'))
    .createFile(name + '.csv', csv, MimeType.CSV);
  // Same link sharing as the CDF archives (9 Nov) so any operator can
  // open the review link, not just whoever built the file. The email
  // attaches the file itself, so a sharing failure is not fatal.
  shareForLinks_(outFile);

  // Duplicate-send warning data (per ICP x this retailer, from the log)
  const cov = rfpCoverage_();
  const dups = [];
  for (const row of rows) {
    const d = (cov[row.icp] || {})[code];
    if (d) dups.push({ icp: row.icp, last: d });
  }

  const redirect = getConfig_()['rfp_test_redirect'] || '';
  const ctx = {
    retailer: rt.name, code: code, count: rows.length, date: stamp,
    pathway: rfpPathwayWord_(pathway), operator: Session.getActiveUser().getEmail(),
    file: outFile.getName(),
  };
  return {
    ok: true, fileId: outFile.getId(), name: outFile.getName(), url: outFile.getUrl(),
    retailer: code, retailerName: rt.name, pathway: pathway,
    count: rows.length, skippedFuel: skippedFuel, fuels: rt.fuels, gasBlanks: gasBlanks,
    eaInfo: eaInfo,
    rowIds: rows.map(r => r.id), icps: rows.map(r => r.icp), dups: dups,
    draft: {
      to: redirect || rt.to,
      cc: redirect ? '' : rt.cc,
      registryTo: rt.to,
      redirected: !!redirect,
      // Urgent emails (9 Nov): subject = the file name pattern, body
      // presses for prompt processing. A retailer's own template on
      // the registry tab still wins over either default.
      subject: rfpFillTemplate_(rt.subjectTemplate,
        pathway === 'URGENT' ? name : '{file} ({count} ICPs)', ctx),
      body: rfpFillTemplate_(rt.bodyTemplate,
        pathway === 'URGENT'
          ? 'Hello,\n\nPlease find attached our URGENT pricing request ({count} ICPs).\nWe would appreciate it if the request could be processed promptly.\n\nKind regards,\n{operator}'
          : 'Hi,\n\nPlease find attached our {pathway} pricing request ({retailer}, {count} ICPs).\n\nKind regards,\n{operator}', ctx),
    },
  };
}

/**
 * Send the reviewed email with the built CSV attached, then append
 * ONE immutable Send Log batch row. Queue rows are NOT touched -
 * coverage chips derive from the log; closing stays manual.
 * Errors are surfaced, never swallowed.
 */
function apiRfpSend(p) {
  rfpEnsureSetup_();
  p = p || {};
  const to = String(p.to || '').trim();
  if (!to) throw new Error('Recipient address is empty.');
  const file = DriveApp.getFileById(p.fileId);
  const mail = { to: to, subject: String(p.subject || ''), body: String(p.body || ''),
    attachments: [file.getBlob()] };
  if (String(p.cc || '').trim()) mail.cc = String(p.cc).trim();
  MailApp.sendEmail(mail);

  const batchId = Utilities.getUuid().slice(0, 8);
  rfpSheet_(RFP_LOG_TAB).appendRow([
    batchId, new Date(), Session.getActiveUser().getEmail(),
    String(p.retailer || '').toUpperCase(), String(p.pathway || '').toUpperCase(),
    file.getName(), file.getUrl(), to,
    (p.rowIds || []).join(','), (p.icps || []).join(','),
  ]);
  return { ok: true, to: to, batchId: batchId, count: (p.icps || []).length };
}

/**
 * Cancel a built-but-unsent request (9 Nov): trash the CSV so nothing
 * lingers in the output folder. Build never logs, so there is nothing
 * to unwind in the Send Log - a cancelled run leaves no History trace
 * and no row is marked as sent. In an ALL run the client stops the
 * remaining retailers; batches already sent stay logged as normal.
 * Only files this app generated (RFP name prefixes) can be trashed.
 */
function apiRfpDiscardBuild(fileId) {
  const file = DriveApp.getFileById(fileId);
  const n = file.getName();
  if (n.indexOf(RFP_FILE_PREFIX) !== 0 && n.indexOf(RFP_URGENT_FILE_PREFIX) !== 0) {
    throw new Error('Not an RFP request file: ' + n);
  }
  file.setTrashed(true);
  return { ok: true, name: n };
}

/** Assisted close: operator-ticked rows OPEN -> CLOSED (decision 2). */
function apiRfpClose(rowIds) {
  return rfpSetStatus_(rowIds, 'OPEN', 'CLOSED', new Date());
}

/** CLOSED -> OPEN (closed by mistake, or re-quoting later). */
function apiRfpReopen(rowIds) {
  return rfpSetStatus_(rowIds, 'CLOSED', 'OPEN', '');
}

/** OPEN -> REMOVED (mistakes; row stays on the sheet, hidden in the app). */
function apiRfpRemove(rowIds) {
  return rfpSetStatus_(rowIds, 'OPEN', 'REMOVED', '');
}

function rfpSetStatus_(rowIds, fromStatus, toStatus, closedDate) {
  const want = {};
  for (const id of rowIds || []) want[String(id)] = true;
  const sheet = rfpSheet_(RFP_QUEUE_TAB);
  let changed = 0;
  if (sheet.getLastRow() > 1) {
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (!want[String(vals[i][0])]) continue;
      if (String(vals[i][2]).trim().toUpperCase() !== fromStatus) continue;
      sheet.getRange(i + 2, 3).setValue(toStatus);
      sheet.getRange(i + 2, 13).setValue(closedDate);
      changed++;
    }
  }
  return { ok: true, changed: changed };
}

/**
 * Move OPEN rows between pathways (9 Nov): STANDARD | URGENT |
 * EXTENSION — mutually exclusive, same rule as at queueing.
 */
function apiRfpSetPathway(rowIds, pathway) {
  pathway = String(pathway || '').trim().toUpperCase();
  if (['STANDARD', 'URGENT', 'EXTENSION'].indexOf(pathway) === -1) {
    throw new Error('Unknown pathway "' + pathway + '".');
  }
  const want = {};
  for (const id of rowIds || []) want[String(id)] = true;
  const sheet = rfpSheet_(RFP_QUEUE_TAB);
  let changed = 0;
  if (sheet.getLastRow() > 1) {
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (!want[String(vals[i][0])]) continue;
      if (String(vals[i][2]).trim().toUpperCase() !== 'OPEN') continue;
      sheet.getRange(i + 2, 4).setValue(pathway === 'URGENT' ? 'URGENT' : '');
      sheet.getRange(i + 2, 5).setValue(pathway === 'EXTENSION' ? 'Y' : '');
      // Leaving the extension pathway clears the ext retailer (stale
      // otherwise); arriving keeps it blank for the operator to set.
      if (pathway !== 'EXTENSION') sheet.getRange(i + 2, 14).setValue('');
      changed++;
    }
  }
  return { ok: true, changed: changed };
}

/**
 * Set the extension retailer on OPEN extension rows (9 Nov). The
 * code must exist on the RFP Retailers tab; standard/urgent rows
 * are never touched.
 */
function apiRfpSetExtRetailer(rowIds, code) {
  code = String(code || '').trim().toUpperCase();
  if (code && !loadRfpRetailers_().some(rt => rt.code === code)) {
    throw new Error('No "' + code + '" row on the RFP Retailers tab.');
  }
  const want = {};
  for (const id of rowIds || []) want[String(id)] = true;
  const sheet = rfpSheet_(RFP_QUEUE_TAB);
  let changed = 0;
  if (sheet.getLastRow() > 1) {
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (!want[String(vals[i][0])]) continue;
      if (String(vals[i][2]).trim().toUpperCase() !== 'OPEN') continue;
      if (!String(vals[i][4]).trim()) continue; // extension rows only
      sheet.getRange(i + 2, 14).setValue(code);
      changed++;
    }
  }
  return { ok: true, changed: changed };
}

/**
 * Operator override of an OPEN row's annual kWh. Zero is a valid
 * figure (10 Nov: zero-consumption ICPs are real); blank, text and
 * negatives are not.
 */
function apiRfpSetAnnual(id, value) {
  const n = Math.round(parseFloat(value));
  if (String(value === null || value === undefined ? '' : value).trim() === '' || !(n >= 0)) {
    throw new Error('Annual kWh must be a number, zero or greater.');
  }
  const sheet = rfpSheet_(RFP_QUEUE_TAB);
  if (sheet.getLastRow() > 1) {
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) !== String(id)) continue;
      if (String(vals[i][2]).trim().toUpperCase() !== 'OPEN') {
        throw new Error('Only OPEN rows can be edited (this one is ' + vals[i][2] + ').');
      }
      sheet.getRange(i + 2, 11).setValue(n);
      return { ok: true, value: n };
    }
  }
  return { ok: false };
}

/**
 * TESTING RESET: wipe the queue AND the send log, and trash every
 * generated request file in CDP Output. Trash, never permanent
 * delete. This is the one thing allowed to clear the send log.
 */
function apiRfpClearAll() {
  let rowsCleared = 0;
  for (const name of [RFP_QUEUE_TAB, RFP_LOG_TAB]) {
    const sheet = rfpSheet_(name);
    if (sheet && sheet.getLastRow() > 1) {
      rowsCleared += sheet.getLastRow() - 1;
      sheet.deleteRows(2, sheet.getLastRow() - 1);
    }
  }
  let filesTrashed = 0;
  const files = DriveApp.getFolderById(requireConfig_('output_folder_id')).getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const fn = f.getName();
    if (fn.indexOf(RFP_FILE_PREFIX) === 0 || fn.indexOf(RFP_URGENT_FILE_PREFIX) === 0) {
      f.setTrashed(true); filesTrashed++;
    }
  }
  return { rowsCleared: rowsCleared, filesTrashed: filesTrashed };
}

/**
 * EA details for a build (10 Nov): the Betty "EA ICPs" import first
 * (unchanged behaviour for existing customers), then the EA registry
 * itself for any electricity ICP the import does not have, which is
 * every ICP of a prospect. Registry answers come through the EA
 * module (cache first, live lookup for the rest).
 * Returns { map: icp -> {trader, address, poc}, info } where info
 * says what the registry step did, for the draft panel.
 */
function rfpEaDetails_(icps) {
  let map = {};
  let importError = '';
  try { map = loadEaDetails_(); } catch (e) { importError = String(e.message || e); }
  const info = { keySet: eaKeySet_(), asked: 0, resolved: 0, notFound: [], pending: 0, error: '',
    importError: importError };
  const missing = (icps || []).filter(i => !(map[i] && map[i].trader));
  info.asked = missing.length;
  if (missing.length) {
    let r = null;
    try { r = eaLookup_(missing, { budgetMs: 180000 }); } catch (e) { info.error = String(e.message || e); }
    if (r) {
      const ctx = eaContext_(eaConfig_());
      for (const icp in r.results) {
        const d = eaDetail_(r.results[icp], ctx);
        if (d.kind === TB_RESULT.FOUND) {
          map[icp] = { trader: d.trader, address: d.address, poc: d.poc };
          info.resolved++;
        } else if (d.kind === TB_RESULT.NOT_FOUND) {
          info.notFound.push(icp);
        }
      }
      info.pending = r.notFetched.length;
      if (r.error) info.error = r.error;
    }
  }
  // The import failing is only fatal when nothing else could answer.
  if (importError && !info.resolved && !Object.keys(map).length) throw new Error(importError);
  return { map: map, info: info };
}

/**
 * ICP -> { trader, address, poc } from the EA ICPs import sheet.
 * Address assembled like the retailer samples: unit, number, street,
 * suburb, town - non-empty parts joined with ", ".
 * (Moved here from BulkQuote.gs, unchanged.)
 */
function loadEaDetails_() {
  const sheet = SpreadsheetApp.openById(requireConfig_('ea_icp_sheet_id')).getSheets()[0];
  const vals = sheet.getDataRange().getValues();
  if (!vals.length) return {};
  const idx = {};
  for (let c = 0; c < vals[0].length; c++) idx[String(vals[0][c]).trim()] = c;
  if (!('ICP identifier' in idx)) throw new Error('EA ICPs sheet: column "ICP identifier" not found.');
  const col = (n) => (n in idx) ? idx[n] : -1;
  const cIcp = col('ICP identifier'), cTrader = col('Trader participant name'),
    cUnit = col('Unit'), cNum = col('Street number'), cStreet = col('Street name'),
    cSub = col('Suburb'), cTown = col('Town/Suburb'), cPoc = col('POC');
  const map = {};
  for (let i = 1; i < vals.length; i++) {
    const icp = String(vals[i][cIcp] || '').trim();
    if (!icp) continue;
    const part = (c) => c >= 0 ? String(vals[i][c] || '').trim() : '';
    const address = [part(cUnit), part(cNum), part(cStreet), part(cSub), part(cTown)]
      .filter(Boolean).join(', ');
    map[icp] = { trader: part(cTrader), address: address, poc: part(cPoc) };
  }
  return map;
}
