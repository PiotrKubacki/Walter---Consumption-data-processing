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
  ['near_zero_avm_kwh',        '10',  'Informational flag: AVM below this kWh/month => near-zero flag'],
];

const CDP_TABS = [
  { name: 'Config',    headers: ['key', 'value', 'note'] },
  { name: 'Run Log',   headers: ['timestamp', 'operator', 'files', 'icp_count', 'reliability_summary', 'output_link'] },
  { name: 'Flags Log', headers: ['timestamp', 'run_ref', 'icp', 'register', 'flag_type', 'detail'] },
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

  Logger.log('Bootstrap complete. Fill the REQUIRED Config values, then reload the web app.');
}