// =====================================================
// CDP App - Setup / bootstrap
// -----------------------------------------------------
// Run bootstrapBackingSheet() once from the editor after
// setting the BACKING_SHEET_ID script property. Additive
// and idempotent: creates missing tabs and missing Config
// keys only; never overwrites values you have filled in.
// Safe to re-run at any time (and future phases will add
// their keys/tabs the same way).
// =====================================================

const CDP_CONFIG_KEYS = [
  // [key, seed value, note shown in col C]
  ['upload_folder_id',         '', 'REQUIRED - Drive folder: raw incoming files, exactly as received'],
  ['processed_folder_id',      '', 'Drive folder: files moved after successful processing (used from B2)'],
  ['output_folder_id',         '', 'Drive folder: filled Betty templates / outputs (used from B2)'],
  ['ea_icp_sheet_id',          '1IVRUmU-AbRwZXog3jG-uSiXbOcbTA2lWpvKZi0MdQEM', 'REQUIRED - EA ICPs (Imports)'],
  ['betty_customers_sheet_id', '1JzNB-zxEM2DGhY46QmvhkSp00qlv9CrN1_YUp5Z_ycQ', 'REQUIRED - Betty Customers (Imports)'],
  ['gas_icp_sheet_id',         '', 'Optional - Gas ICP lookup sheet; blank => gas ICPs flag as not found'],
  ['betty_url_pattern',        '', 'Optional - Betty customer URL with {customerId} placeholder (copy base from DC App)'],
  ['min_window_days',          '90',  'Reliability threshold: minimum analysis window days'],
  ['max_estimate_share',       '0.5', 'Reliability threshold: max estimate share of days (0-1)'],
  ['max_gap_share',            '0.1', 'Reliability threshold: max gap share of analysis window (0-1)'],
  ['near_zero_avm_kwh',        '10',  'Informational flag: AVM below this kWh/month => near-zero flag'],
  ['format_report_email',      'peter@theutilitycompany.net', 'Unknown-format files reported from the Workbench are emailed here'],
  ['betty_output_folder_id',   '', 'Optional - Drive folder for filled Betty templates; blank => a "Betty files" subfolder of the output folder'],
  ['betty_file_viewers',       '', 'Email addresses (comma separated) that every filled Betty template is shared with - add operators on personal accounts'],
  ['rates_default_contract_days', '730', 'Enter rates: contract length (days) used when nothing was loaded from Betty or typed'],
  ['rates_default_brokerage',     '', 'Enter rates: brokerage fee (per cent, as Betty holds it) used when nothing was loaded or typed - blank = no default, the cell goes to Betty empty'],
  ['bulk_quote_email',         'peter@theutilitycompany.net', 'Bulk pricing export files are emailed here (interim, until sent to retailers directly)'],
];

const CDP_TABS = [
  { name: 'Config',          headers: ['key', 'value', 'note'] },
  { name: 'Register Map',    headers: ['fuel (ELEC/GAS/ANY)', 'source pattern', 'betty meter type', 'note'] },
  { name: 'Time Boundaries', headers: ['network', 'register config', 'window', 'start (HH:mm)', 'end (HH:mm)', 'source / date checked'] },
  { name: 'Seasons',         headers: ['month (1-12)', 'season'] },
  { name: 'Run Log',         headers: ['timestamp', 'operator', 'files', 'icp_count', 'reliability_summary', 'output_link'] },
  { name: 'Flags Log',       headers: ['timestamp', 'run_ref', 'icp', 'register', 'flag_type', 'detail'] },
  { name: 'Notes Log',       headers: ['timestamp', 'operator', 'customer_id', 'customer', 'files', 'notes_text'] },
  // v2.0: the Bulk Quote Queue tab is superseded by the RFP tabs
  // (RFP Queue / Retailers / Schemas / Send Log), created and seeded
  // by rfpEnsureSetup_() in Rfp.gs — which also migrates any old
  // Bulk Quote Queue rows once and renames that tab to an archive.
  { name: 'Retailer Codes',  headers: ['trader id', 'display name'] },
];

// Trader participant id -> the name operators use. Operator-editable;
// PSNZ is Meridian-owned Powershop (confirmed). Extend/correct freely.
const CDP_RETAILER_CODE_SEED = [
  ['MERX', 'Meridian'], ['MRDN', 'Meridian'], ['PSNZ', 'Powershop'],
  ['CTCT', 'Contact'], ['GENE', 'Genesis'], ['TODD', 'Nova'],
  ['MEEN', 'Mercury'], ['TRUS', 'Trustpower'], ['OCTO', 'Octopus'],
];

// Time-boundary seeds (design record \u00a78.2, examples from Yuka).
// DEFAULT rows apply when no network-specific entry matches.
const CDP_TIME_BOUNDARY_SEED = [
  ['DEFAULT',   '',     'Day',   '07:00', '21:00', 'generic default - confirm per network'],
  ['DEFAULT',   '',     'Night', '21:00', '07:00', 'generic default - confirm per network'],
  ['Electra',   'D14',  'Day',   '07:00', '21:00', 'Yuka, Aug 2026'],
  ['Electra',   'N10',  'Night', '21:00', '07:00', 'Yuka, Aug 2026'],
  ['Westpower', 'DIN8', 'Day',   '07:00', '23:00', 'Yuka, Aug 2026'],
  ['Westpower', 'NIN8', 'Night', '23:00', '07:00', 'Yuka, Aug 2026'],
];

// Season seed: common NZ pricing convention \u2014 CONFIRM with the team
// before relying on seasonal outputs (operator-editable).
const CDP_SEASON_SEED = [
  [1, 'Summer'], [2, 'Summer'], [3, 'Summer'], [4, 'Summer'],
  [5, 'Winter'], [6, 'Winter'], [7, 'Winter'], [8, 'Winter'],
  [9, 'Winter'], [10, 'Winter'], [11, 'Summer'], [12, 'Summer'],
];

// Seeded only when the Register Map tab is newly created/empty.
// Operators extend this; the app never writes a Betty name that is
// not in the uploaded template's vocabulary (design record \u00a78.1).
const CDP_REGISTER_MAP_SEED = [
  ['ELEC', 'UN',              'Anytime',    'uncontrolled'],
  ['ELEC', 'UN24',            'Anytime',    ''],
  ['ELEC', 'CN',              'Controlled', ''],
  ['ELEC', 'D',               'Day',        ''],
  ['ELEC', 'N',               'Night',      ''],
  ['ELEC', 'KWH-IMP-PRI-TOT', 'Anytime',    'Genesis interval element'],
  ['GAS',  'U',               'Gas',        ''],
  ['GAS',  '1',               'Gas',        'single gas register'],
];

function bootstrapBackingSheet() {
  const backingId = PropertiesService.getScriptProperties().getProperty('BACKING_SHEET_ID');
  if (!backingId) throw new Error('Set the BACKING_SHEET_ID script property first.');
  const ss = SpreadsheetApp.openById(backingId);

  // Tabs (additive)
  for (const tab of CDP_TABS) {
    let sheet = ss.getSheetByName(tab.name);
    if (!sheet) {
      sheet = ss.insertSheet(tab.name);
      Logger.log('Created tab: ' + tab.name);
    }
    // Ensure header row (only writes if row 1 is empty)
    const firstCell = sheet.getRange(1, 1).getValue();
    if (!firstCell) {
      sheet.getRange(1, 1, 1, tab.headers.length).setValues([tab.headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }

  // Remove the default "Sheet1" if it is empty and not one of ours
  const s1 = ss.getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0 && s1.getLastColumn() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(s1);
  }

  // Config keys (additive - never overwrites existing values)
  const cfgSheet = ss.getSheetByName('Config');
  const existing = {};
  const lastRow = cfgSheet.getLastRow();
  if (lastRow > 1) {
    const rows = cfgSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < rows.length; i++) existing[String(rows[i][0]).trim()] = true;
  }
  const toAdd = CDP_CONFIG_KEYS.filter(k => !existing[k[0]]);
  if (toAdd.length) {
    cfgSheet.getRange(cfgSheet.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
    Logger.log('Added Config keys: ' + toAdd.map(k => k[0]).join(', '));
  } else {
    Logger.log('Config keys already present; nothing added.');
  }

  // Register Map seed (only when the tab has no data rows)
  const rmSheet = ss.getSheetByName('Register Map');
  if (rmSheet && rmSheet.getLastRow() <= 1) {
    rmSheet.getRange(2, 1, CDP_REGISTER_MAP_SEED.length, 4).setValues(CDP_REGISTER_MAP_SEED);
    Logger.log('Seeded Register Map with ' + CDP_REGISTER_MAP_SEED.length + ' starter mappings.');
  }

  // Time Boundaries seed
  const tbSheet = ss.getSheetByName('Time Boundaries');
  if (tbSheet && tbSheet.getLastRow() <= 1) {
    tbSheet.getRange(2, 1, CDP_TIME_BOUNDARY_SEED.length, 6).setValues(CDP_TIME_BOUNDARY_SEED);
    Logger.log('Seeded Time Boundaries with ' + CDP_TIME_BOUNDARY_SEED.length + ' rows.');
  }

  // Retailer Codes seed
  const rcSheet = ss.getSheetByName('Retailer Codes');
  if (rcSheet && rcSheet.getLastRow() <= 1) {
    rcSheet.getRange(2, 1, CDP_RETAILER_CODE_SEED.length, 2).setValues(CDP_RETAILER_CODE_SEED);
    Logger.log('Seeded Retailer Codes with ' + CDP_RETAILER_CODE_SEED.length + ' mappings.');
  }

  // Seasons seed
  const seSheet = ss.getSheetByName('Seasons');
  if (seSheet && seSheet.getLastRow() <= 1) {
    seSheet.getRange(2, 1, CDP_SEASON_SEED.length, 2).setValues(CDP_SEASON_SEED);
    Logger.log('Seeded Seasons (NZ default \u2014 CONFIRM with the team).');
  }

  // RFP tabs + seeds + one-time Bulk Quote Queue migration (Rfp.gs).
  // Also self-heals on first use of the RFP tab, so running this is
  // optional — but harmless and idempotent.
  rfpEnsureSetup_();

  Logger.log('Bootstrap complete. Fill the REQUIRED Config values, then reload the web app.');
}

/**
 * \u00a78.2 consistency check: most config codes encode their hour count
 * (D14 = 14 h, N10 = 10 h, DIN8 night = 8 h). Run from the editor to
 * validate Time Boundaries entries; mismatches are logged.
 */
function checkTimeBoundaryHourCounts() {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('BACKING_SHEET_ID'));
  const sheet = ss.getSheetByName('Time Boundaries');
  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues() : [];
  let issues = 0;
  for (const r of rows) {
    const config = String(r[1] || '').trim();
    const m = config.match(/(\d+)/);
    if (!m) continue;
    const declared = +m[1];
    const mins = windowMinutes_(String(r[3]), String(r[4]));
    if (mins === null) { Logger.log('Bad times: ' + r.join(' | ')); issues++; continue; }
    if (Math.abs(mins / 60 - declared) > 0.01) {
      Logger.log('HOUR MISMATCH: ' + r[0] + ' ' + config + ' ' + r[2] + ' spans ' + (mins / 60) + 'h but code says ' + declared + 'h');
      issues++;
    }
  }
  Logger.log(issues ? issues + ' issue(s) found.' : 'All Time Boundaries entries consistent with their codes.');
}
