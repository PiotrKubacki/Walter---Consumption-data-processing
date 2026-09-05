// =====================================================
// CDP App - Parser: register_reads (Family E)
// -----------------------------------------------------
// CUMULATIVE meter register reads, one row per read:
//   ICP, Serial number (MRU), Register, Reading date,
//   Reading result, Status (R=read/E=noread), AMS id
// Consumption = difference between consecutive reads per
// ICP+register+serial, covering (prevDate, thisDate].
// The earliest read has no predecessor and emits nothing.
// Negative differences (rollover / meter change) become
// row errors, never records.
//
// UNITS CAVEAT: register units are taken AS-IS. Gas
// registers are often m3 needing a conversion factor to
// kWh \u2014 a file flag reminds the operator until the units
// question is settled per retailer. (Family E note.)
// =====================================================

function registerReadsSniff_(content) {
  return registerReadsHeader_(content) !== null;
}

function registerReadsHeader_(content) {
  const lines = String(content || '').split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const f = splitCsvLine_(lines[i]).map(normHdr_);
    const has = (kw) => f.some(c => c.indexOf(kw) !== -1);
    if (has('icp') && has('reading date') && has('reading result') && !has('consumption')) {
      return { index: i, fields: f };
    }
    if (++seen >= 14) return null;
  }
  return null;
}

function registerReadsParse_(content, fileName) {
  const head = registerReadsHeader_(content);
  if (!head) throw new Error('register_reads: header row not found in ' + fileName);
  const f = head.fields;
  const col = (kws, required) => {
    for (let i = 0; i < f.length; i++) for (const kw of kws) if (f[i].indexOf(kw) !== -1) return i;
    if (required) throw new Error('register_reads: required column not found (' + kws[0] + ') in ' + fileName);
    return null;
  };
  const cIcp    = col(['icp'], true);
  const cDate   = col(['reading date'], true);
  const cResult = col(['reading result'], true);
  const cReg    = col(['register']);
  const cSerial = col(['serial']);
  const cStat   = col(['status']);

  const lines = String(content).split(/\r?\n/);
  const reads = [];
  const errors = [];
  const dateModeFlags = [];
  const dateMode = decideDateModeFromSamples_(collectDateSamples_(lines, head.index, [cDate]), dateModeFlags);
  const fileFlags = ['Register reads: consumption derived from read differences. Units taken AS-IS \u2014 ' +
    'verify whether this register reports kWh or m\u00b3 (gas conversion factor) before trusting totals.'];
  for (const f of dateModeFlags) fileFlags.push(f);

  for (let i = head.index + 1; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const row = splitCsvLine_(lines[i]);
    const icp = String(row[cIcp] || '').trim();
    if (!icp) continue;
    const date = parseAnyDateMode_(row[cDate], dateMode);
    if (!date) { errors.push({ line: i + 1, reason: 'Bad reading date: ' + row[cDate] }); continue; }
    const result = parseNumber_(row[cResult]);
    if (result === null) { errors.push({ line: i + 1, reason: 'Bad reading result: ' + row[cResult] }); continue; }
    reads.push({
      line: i + 1, icp: icp, date: date, result: result,
      register: cReg !== null ? (String(row[cReg] || '').trim() || '(single)') : '(single)',
      meterId: cSerial !== null ? String(row[cSerial] || '').trim() : '',
      readQuality: cStat !== null ? normaliseReadQuality_(row[cStat]) : 'ACTUAL',
    });
  }

  // Group per ICP|register|meter, sort ascending, diff consecutive reads.
  const groups = {};
  for (const r of reads) {
    const k = r.icp + '|' + r.register + '|' + r.meterId;
    (groups[k] = groups[k] || []).push(r);
  }
  const records = [];
  let negatives = 0;
  for (const k of Object.keys(groups)) {
    const g = groups[k].sort((a, b) => a.date - b.date);
    for (let i = 1; i < g.length; i++) {
      const prev = g[i - 1], cur = g[i];
      const diff = cur.result - prev.result;
      if (cur.date - prev.date <= 0) { errors.push({ line: cur.line, reason: 'Duplicate/out-of-order reading date' }); continue; }
      if (diff < 0) {
        negatives++;
        errors.push({ line: cur.line, reason: 'Negative read difference (' + Math.round(diff * 100) / 100 + ') \u2014 rollover or meter change; period skipped' });
        continue;
      }
      // Quality of the period: estimate if EITHER endpoint is an estimate.
      const quality = (prev.readQuality === 'ACTUAL' && cur.readQuality === 'ACTUAL') ? 'ACTUAL'
        : (prev.readQuality === 'ESTIMATE' || cur.readQuality === 'ESTIMATE') ? 'ESTIMATE'
        : cur.readQuality;
      records.push({
        icp: cur.icp, register: cur.register, meterId: cur.meterId,
        periodStart: prev.date, periodEnd: cur.date, kWh: diff,
        granularity: classifyGranularity_('', prev.date, cur.date),
        readQuality: quality, line: cur.line,
      });
    }
  }
  if (negatives) fileFlags.push(negatives + ' negative read difference(s) skipped \u2014 check for meter rollover/replacement');

  return {
    header: { format: 'REGISTER_READS', version: '', raw: lines[head.index].slice(0, 160) },
    records: records, errors: errors, fileFlags: fileFlags,
  };
}
