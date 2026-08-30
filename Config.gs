// =====================================================
// CDP App - Config
// -----------------------------------------------------
// The only hardcoded ID is the backing spreadsheet, held
// in Script Properties (key: BACKING_SHEET_ID) so DEV and
// LIVE point at their own backing sheets with identical
// code. Everything else (folder IDs, lookup sheet IDs,
// thresholds) lives in the backing sheet's Config tab as
// key/value rows, editable without a deployment.
// =====================================================

const CONFIG_TAB = 'Config';

// Config keys expected in the backing sheet Config tab (col A: key, col B: value)
// upload_folder_id       Drive folder: raw incoming files (exactly as received)
// processed_folder_id    Drive folder: files moved after successful processing
// output_folder_id       Drive folder: filled Betty templates / outputs
// ea_icp_sheet_id        EA ICPs (Imports) spreadsheet
// gas_icp_sheet_id       Gas ICP lookup spreadsheet
// betty_customers_sheet_id  Betty Customers (Imports) spreadsheet
// betty_url_pattern      e.g. https://betty.example/customer/{customerId}
// min_window_days        reliability threshold (default 90)
// max_estimate_share     reliability threshold 0-1 (default 0.5)
// near_zero_avm_kwh      informational flag threshold (default 10)

let _configCache_ = null;

function getConfig_() {
  if (_configCache_) return _configCache_;
  const backingId = PropertiesService.getScriptProperties().getProperty('BACKING_SHEET_ID');
  if (!backingId) {
    throw new Error('Script property BACKING_SHEET_ID is not set. Set it to the CDP backing spreadsheet ID.');
  }
  const ss = SpreadsheetApp.openById(backingId);
  const sheet = ss.getSheetByName(CONFIG_TAB);
  if (!sheet) throw new Error('Backing spreadsheet has no "' + CONFIG_TAB + '" tab.');
  const values = sheet.getDataRange().getValues();
  const cfg = { _backingId: backingId };
  for (const row of values) {
    const key = String(row[0] || '').trim();
    if (!key || key === 'key') continue;
    cfg[key] = String(row[1] !== undefined ? row[1] : '').trim();
  }
  // Defaults
  cfg.min_window_days    = Number(cfg.min_window_days)    || 90;
  cfg.max_estimate_share = Number(cfg.max_estimate_share) || 0.5;
  cfg.max_gap_share      = Number(cfg.max_gap_share)      || 0.1;
  cfg.near_zero_avm_kwh  = Number(cfg.near_zero_avm_kwh)  || 10;
  _configCache_ = cfg;
  return cfg;
}

function requireConfig_(key) {
  const cfg = getConfig_();
  if (!cfg[key]) throw new Error('Config value missing in backing sheet Config tab: ' + key);
  return cfg[key];
}