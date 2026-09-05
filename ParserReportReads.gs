// =====================================================
// CDP App - Parser: report_reads (Family D)
// -----------------------------------------------------
// Formatted human "Consumption Report" documents
// (observed: Genesis/Cranford style). Layout: labelled
// cells scattered on a sparse grid \u2014
//   Account Name: / Address: / ICP: <value>
//   CONSUMPTION REPORT / Meter Number: <m: r> /
//   Meter Type: / Total Consumption:
// then a reads table whose header cells sit at arbitrary
// columns: Reading Date | Reading Type | Reading |
// Consumption (kWh); data rows align under those columns,
// DESCENDING by date. Each row's Consumption covers the
// period since the PREVIOUS (earlier) read, so the
// earliest row emits nothing (no period start) \u2014 noted
// in a file flag.
// Reading Type: Actual Read -> ACTUAL; Interim/Forced
// Estimate -> ESTIMATE. Negative consumption rows (meter
// corrections) are kept \u2014 the analysis window nets them
// out (design record \u00a76.3).
// A report may contain multiple ICP / meter sections; the
// parser tracks the current ICP/meter as it scans.
// =====================================================

function reportReadsSniff_(content) {
  const lines = String(content || '').split(/\r?\n/);
  let sawIcpLabel = false, sawHeader = false;
  const limit = Math.min(lines.length, 80);
  for (let i = 0; i < limit; i++) {
    const cells = splitCsvLine_(lines[i]).map(normHdr_);
    if (cells.some(c => c === 'icp:' || c === 'icp')) {
      // 'icp:' label form only (plain 'icp' header cells belong to tabular families)
      if (cells.some(c => c === 'icp:')) sawIcpLabel = true;
    }
    const has = (kw) => cells.some(c => c.indexOf(kw) !== -1);
    if (has('reading date') && has('reading type') && has('consumption')) sawHeader = true;
    if (sawIcpLabel && sawHeader) return true;
  }
  return false;
}

function reportReadsParse_(content, fileName) {
  const lines = String(content).split(/\r?\n/);
  const errors = [];
  const fileFlags = [];
  const readsByGroup = {};

  // Pre-pass: collect reading-date strings (header can move between
  // sections, so track the date column as we go) for the date-mode call.
  const dateSamples = [];
  {
    let dCol = -1;
    for (let i = 0; i < lines.length && dateSamples.length < 4000; i++) {
      if (!lines[i] || lines[i].trim() === '') continue;
      const cells = splitCsvLine_(lines[i]);
      const norm = cells.map(normHdr_);
      const h = norm.findIndex(function (c) { return c.indexOf('reading date') !== -1; });
      if (h >= 0) { dCol = h; continue; }
      if (dCol >= 0 && cells[dCol] !== undefined && String(cells[dCol]).trim() !== '') dateSamples.push(cells[dCol]);
    }
  }
  const dateMode = decideDateModeFromSamples_(dateSamples, fileFlags);

  let currentIcp = '';
  let currentMeter = '';
  let cols = null; // { date, type, reading, cons }

  const valueAfterLabel_ = (cells, idx) => {
    for (let j = idx + 1; j < cells.length; j++) {
      const v = String(cells[j] || '').trim();
      if (v) return v;
    }
    return '';
  };

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const rawCells = splitCsvLine_(lines[i]);
    const norm = rawCells.map(normHdr_);

    // Labels
    for (let c = 0; c < norm.length; c++) {
      if (norm[c] === 'icp:') {
        const v = valueAfterLabel_(rawCells, c);
        if (v) { currentIcp = v; cols = null; }
      } else if (norm[c] === 'meter number:') {
        const v = valueAfterLabel_(rawCells, c);
        if (v) currentMeter = v;
      }
    }

    // Reads-table header: capture column indices
    if (norm.some(c => c.indexOf('reading date') !== -1) &&
        norm.some(c => c.indexOf('reading type') !== -1) &&
        norm.some(c => c.indexOf('consumption') !== -1)) {
      cols = {
        date: norm.findIndex(c => c.indexOf('reading date') !== -1),
        type: norm.findIndex(c => c.indexOf('reading type') !== -1),
        reading: norm.findIndex(c => c === 'reading' || c.indexOf('reading') === 0 && c.indexOf('reading date') === -1 && c.indexOf('reading type') === -1),
        cons: norm.findIndex(c => c.indexOf('consumption') !== -1),
      };
      continue;
    }

    // Data rows under an active header
    if (cols) {
      const date = parseAnyDateMode_(rawCells[cols.date], dateMode);
      if (!date) continue; // non-data row (spacer, next section label, etc.)
      if (!currentIcp) { errors.push({ line: i + 1, reason: 'Read row before any ICP label' }); continue; }
      const cons = parseNumber_(rawCells[cols.cons]);
      const typeRaw = String(rawCells[cols.type] || '').trim();
      const reading = cols.reading >= 0 ? parseNumber_(rawCells[cols.reading]) : null;
      if (cons === null) { errors.push({ line: i + 1, reason: 'Bad consumption: ' + rawCells[cols.cons] }); continue; }
      const key = currentIcp + '|' + currentMeter;
      (readsByGroup[key] = readsByGroup[key] || []).push({
        line: i + 1, date: date, cons: cons, reading: reading,
        quality: /actual/i.test(typeRaw) ? 'ACTUAL' : /estimate/i.test(typeRaw) ? 'ESTIMATE' : normaliseReadQuality_(typeRaw),
      });
    }
  }

  // Emit period records: consumption at read k covers (date_{k-1}, date_k]
  const records = [];
  for (const key of Object.keys(readsByGroup)) {
    const [icp, meter] = key.split('|');
    const g = readsByGroup[key].sort((a, b) => a.date - b.date);
    if (g.length) {
      fileFlags.push(icp + (meter ? ' (' + meter + ')' : '') + ': earliest read ' +
        Utilities.formatDate(g[0].date, 'Pacific/Auckland', 'yyyy-MM-dd') +
        ' has no period start \u2014 its consumption is not emitted');
    }
    for (let k = 1; k < g.length; k++) {
      const prev = g[k - 1], cur = g[k];
      if (cur.date - prev.date <= 0) { errors.push({ line: cur.line, reason: 'Duplicate/out-of-order reading date' }); continue; }
      records.push({
        icp: icp, register: meter || '(single)', meterId: meter,
        periodStart: prev.date, periodEnd: cur.date, kWh: cur.cons,
        granularity: classifyGranularity_('', prev.date, cur.date),
        readQuality: cur.quality, line: cur.line,
      });
    }
  }

  return {
    header: { format: 'REPORT_READS', version: '', raw: 'Consumption report; sections: ' + Object.keys(readsByGroup).join('; ').slice(0, 140) },
    records: records, errors: errors, fileFlags: fileFlags,
  };
}
