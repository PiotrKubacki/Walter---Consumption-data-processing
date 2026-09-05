// =====================================================
// CDP App - Verify summary (B1) + lookups
// -----------------------------------------------------
// Turns parsed records into the per ICP-register view the
// operator confirms before anything else may happen:
// date range, days covered, record counts by granularity,
// gaps, overlaps, read-quality mix, parse errors, file
// flags, and identification via the lookup sheets.
// Read-only throughout.
// =====================================================

function buildVerifySummary_(parsed, fileName) {
  const groups = {};
  for (const r of parsed.records) {
    const key = r.icp + '|' + r.register;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  const rows = [];
  for (const key of Object.keys(groups).sort()) {
    const [icp, register] = key.split('|');
    const recs = groups[key];

    const byGran = { HH: [], DAILY: [], PERIOD: [] };
    for (const r of recs) byGran[r.granularity].push(r);

    const qualityMix = {};
    for (const r of recs) qualityMix[r.readQuality] = (qualityMix[r.readQuality] || 0) + 1;

    const first = recs.reduce((a, b) => a.periodStart < b.periodStart ? a : b).periodStart;
    const last  = recs.reduce((a, b) => a.periodEnd   > b.periodEnd   ? a : b).periodEnd;

    const kwh = {
      HH:     round2_(sumKwh_(byGran.HH)),
      DAILY:  round2_(sumKwh_(byGran.DAILY)),
      PERIOD: round2_(sumKwh_(byGran.PERIOD)),
    };

    // Days covered per layer (design record \u00a76.4: coverage, not calendar span)
    const daysCovered = {
      HH:     round2_(byGran.HH.length / 48),
      DAILY:  byGran.DAILY.length,
      PERIOD: round2_(byGran.PERIOD.reduce((s, r) => s + (r.periodEnd - r.periodStart) / 86400000, 0)),
    };

    // Overlap check (\u00a76.2): more than one layer present covering time.
    const layersPresent = ['HH', 'DAILY', 'PERIOD'].filter(g => byGran[g].length > 0);
    const flags = [];
    if (layersPresent.length > 1) {
      flags.push('Multiple layers present (' + layersPresent.join(' + ') +
        ') \u2014 totals must use one layer; cross-check: ' +
        layersPresent.map(g => g + '=' + kwh[g] + ' kWh over ' + daysCovered[g] + ' days').join(', '));
      // Stray-record detail: a minor layer with only a few rows is usually
      // an anomaly (odd spans, reversed dates) \u2014 show the rows so the
      // operator (and the builder) can see exactly what they are.
      const dominant = layersPresent.reduce((a, b) => byGran[a].length >= byGran[b].length ? a : b);
      for (const g of layersPresent) {
        if (g === dominant || byGran[g].length > 5) continue;
        for (const r of byGran[g]) {
          const spanMins = Math.round((r.periodEnd - r.periodStart) / 60000);
          flags.push('Stray ' + g + ' row (line ' + r.line + '): ' + fmt_(r.periodStart) + ' \u2192 ' +
            fmt_(r.periodEnd) + ' (span ' + spanMins + ' min), ' + r.kWh + ' kWh, ' + r.readQuality);
        }
      }
    }

    // Gap detection (\u00a76.5)
    const gaps = detectGaps_(byGran);
    if (gaps.length) flags.push(gaps.length + ' gap(s) detected');

    const lookup = cdpLookupIcp_(icp);

    rows.push({
      icp: icp,
      register: register,
      recordCounts: { HH: byGran.HH.length, DAILY: byGran.DAILY.length, PERIOD: byGran.PERIOD.length },
      dateFrom: fmt_(first),
      dateTo: fmt_(last),
      daysCovered: daysCovered,
      kWh: kwh,
      qualityMix: qualityMix,
      gaps: gaps.slice(0, 20),
      gapsTruncated: Math.max(0, gaps.length - 20),
      flags: flags,
      lookup: lookup,
      bettyUrl: bettyUrl_(lookup.customerId),
    });
  }

  return {
    fileName: fileName,
    header: parsed.header,
    fileFlags: parsed.fileFlags,
    parseErrorCount: parsed.errors.length,
    parseErrorSamples: parsed.errors.slice(0, 10),
    icpRegisters: rows,
  };
}

function sumKwh_(recs) { let s = 0; for (const r of recs) s += r.kWh; return s; }
function round2_(n) { return Math.round(n * 100) / 100; }
function fmt_(d) { return Utilities.formatDate(d, 'Pacific/Auckland', 'yyyy-MM-dd HH:mm'); }

function detectGaps_(byGran) {
  const gaps = [];
  // HH: gap > 70 min between consecutive intervals (legacy rule kept)
  gapScan_(byGran.HH, 70, gaps, 'HH');
  // DAILY: gap > ~1.5 days between consecutive daily rows
  gapScan_(byGran.DAILY, 2160, gaps, 'DAILY');
  // PERIOD: non-contiguous billing periods (> 1 day between end and next start)
  gapScan_(byGran.PERIOD, 1440, gaps, 'PERIOD');
  return gaps;
}

function gapScan_(recs, thresholdMins, out, layer) {
  if (recs.length < 2) return;
  const sorted = recs.slice().sort((a, b) => a.periodStart - b.periodStart);
  for (let i = 1; i < sorted.length; i++) {
    const gapMins = (sorted[i].periodStart - sorted[i - 1].periodEnd) / 60000;
    if (gapMins > thresholdMins) {
      out.push({ layer: layer, from: fmt_(sorted[i - 1].periodEnd), to: fmt_(sorted[i].periodStart) });
    }
  }
}

// ---------------- Lookups (design record \u00a77) ----------------
// EA ICPs (electricity), Gas ICP sheet (gas, optional in B1),
// Betty Customers (names). Header-name driven, config-sheet IDs.

let _cdpLookupCache_ = null;

function cdpLoadLookups_() {
  if (_cdpLookupCache_) return _cdpLookupCache_;
  const cfg = getConfig_();
  const ea = loadSheetByHeaders_(requireConfig_('ea_icp_sheet_id'), 'EA ICPs (Imports)',
    ['ICP identifier', 'Trader participant id', 'Network participant id', 'Network participant name', 'Customer ID']);
  const gas = cfg.gas_icp_sheet_id
    ? loadSheetByHeaders_(cfg.gas_icp_sheet_id, 'Gas ICP lookup', ['ICP identifier', 'Customer ID'])
    : null;
  const customers = loadSheetByHeaders_(requireConfig_('betty_customers_sheet_id'), 'Betty Customers (Imports)',
    ['Customer ID', 'Registered name', 'Trading name']);
  // Index once: per-row linear scans are the main lookup cost on big sheets.
  ea.index = indexRows_(ea, 'ICP identifier');
  if (gas) gas.index = indexRows_(gas, 'ICP identifier');
  customers.index = indexRows_(customers, 'Customer ID');
  _cdpLookupCache_ = { ea: ea, gas: gas, customers: customers };
  return _cdpLookupCache_;
}

function indexRows_(sheetData, keyHeader) {
  const keyCol = sheetData.headerMap[keyHeader];
  const map = {};
  for (const row of sheetData.data) {
    const k = String(row[keyCol]).trim();
    if (k && !(k in map)) map[k] = row;
  }
  return map;
}

function loadSheetByHeaders_(sheetId, label, requiredHeaders) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheets()[0];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1) throw new Error('Empty sheet: ' + label);
  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const headerMap = {};
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] || '').trim();
    if (h) headerMap[h] = i;
  }
  const missing = requiredHeaders.filter(h => !(h in headerMap));
  if (missing.length) throw new Error('Missing headers in ' + label + ': ' + missing.join(', '));
  const data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  return { label: label, headerMap: headerMap, data: data };
}

const CDP_NOT_FOUND = 'Not found';

function cdpLookupIcp_(icpId) {
  const L = cdpLoadLookups_();
  const result = {
    icp: icpId, fuel: 'ELEC',
    traderId: CDP_NOT_FOUND, networkId: CDP_NOT_FOUND, networkName: CDP_NOT_FOUND,
    customerId: '', registeredName: CDP_NOT_FOUND, tradingName: CDP_NOT_FOUND,
    flags: [],
  };

  // Electricity registry first
  const eaRow = L.ea.index[String(icpId).trim()];
  if (eaRow) {
    result.traderId    = String(eaRow[L.ea.headerMap['Trader participant id']]  || CDP_NOT_FOUND).trim();
    result.networkId   = String(eaRow[L.ea.headerMap['Network participant id']] || CDP_NOT_FOUND).trim();
    result.networkName = String(eaRow[L.ea.headerMap['Network participant name']] || CDP_NOT_FOUND).trim();
    result.customerId  = String(eaRow[L.ea.headerMap['Customer ID']] || '').trim();
  } else if (L.gas) {
    // Not in EA registry: try the gas sheet
    const gRow = L.gas.index[String(icpId).trim()];
    if (gRow) {
      result.fuel = 'GAS';
      result.customerId = String(gRow[L.gas.headerMap['Customer ID']] || '').trim();
    } else {
      result.flags.push('ICP not found in EA ICPs or Gas ICP lookup');
      return result;
    }
  } else {
    result.flags.push('ICP not found in EA ICPs (Imports); no Gas ICP sheet configured');
    return result;
  }

  if (!result.customerId) {
    result.flags.push('No Customer ID on lookup row');
    return result;
  }
  const cRow = L.customers.index[result.customerId];
  if (!cRow) {
    result.flags.push('Customer ID not found in Betty Customers (Imports)');
    return result;
  }
  result.registeredName = String(cRow[L.customers.headerMap['Registered name']] || CDP_NOT_FOUND).trim();
  result.tradingName    = String(cRow[L.customers.headerMap['Trading name']]    || CDP_NOT_FOUND).trim();
  return result;
}

function bettyUrl_(customerId) {
  if (!customerId) return '';
  const cfg = getConfig_();
  if (!cfg.betty_url_pattern) return '';
  return cfg.betty_url_pattern.replace('{customerId}', encodeURIComponent(customerId));
}
