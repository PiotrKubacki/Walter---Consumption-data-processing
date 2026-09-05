// =====================================================
// CDP App - Parser: timestamp_series (Family H)
// -----------------------------------------------------
// Metering-portal exports (German-style metering system:
// ZPT-ID/ZR-ID, OBIS codes), observed Sep 2026:
//   - one sheet ("Export"), a multi-line TITLE CELL carrying
//     "<ICP>_<meter>", the OBIS channel (1-1:1.29.0 import /
//     1-1:2.29.0 export "INJ"), ZPT/ZR ids
//   - header: "Timestamp (Pacific/Auckland)","Value (kWh)"[,Sum]
//   - rows: dd.mm.yyyy HH:MM,<kWh>[,<sum>] \u2014 DOT dates,
//     timestamps mark INTERVAL END (first row 00:30)
// ICP/meter/channel are recovered from the title blob (the
// multi-line quoted cell fragments across extracted lines, so
// matching runs over raw content, not parsed rows).
//
// CHANNEL SEMANTICS MATTER: the 2.29.0/INJ channel is
// GENERATION (export to grid), not consumption \u2014 records carry
// the OBIS code as their register so it stays visibly separate,
// and the file flag says so loudly. Feeding an export channel
// into a consumption AVM silently would be a lie.
// =====================================================

function timestampSeriesSniff_(content) {
  return timestampSeriesHeader_(content) !== null;
}

function timestampSeriesHeader_(content) {
  const lines = String(content || '').split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const f = splitCsvLine_(lines[i]).map(normHdr_);
    const has = (kw) => f.some(c => c.indexOf(kw) !== -1);
    if (has('timestamp') && has('value')) return { index: i, fields: f };
    if (++seen >= 14) return null;
  }
  return null;
}

function timestampSeriesParse_(content, fileName) {
  const head = timestampSeriesHeader_(content);
  if (!head) throw new Error('timestamp_series: header row not found in ' + fileName);
  const lines = String(content).split(/\r?\n/);
  const errors = [];
  const fileFlags = [];

  // Identity from the title blob (first ~2500 chars of raw content):
  // "<10-digit><5-alnum>_<meter serial>" and the OBIS channel.
  const headBlob = String(content).slice(0, 2500);
  const idM = headBlob.match(/(\d{10}[A-Z0-9]{5})_(\d+)/);
  const icp = idM ? idM[1] : '';
  const meterId = idM ? idM[2] : '';
  const obisM = headBlob.match(/1-1:([12])\.29\.\d/);
  const channel = obisM ? obisM[1] : null;
  const register = obisM ? obisM[0] : 'VALUE';
  if (!icp) throw new Error('timestamp_series: no ICP found in the title block of ' + fileName +
    ' \u2014 expected "<ICP>_<meter>" (fail loudly rather than guess).');

  if (channel === '2') {
    fileFlags.push('EXPORT/INJECTION CHANNEL (OBIS ' + register + '): this is GENERATION data, not customer ' +
      'consumption. Register kept separate as "' + register + '" \u2014 do not feed into a consumption analysis unless intended.');
  } else if (channel === '1') {
    fileFlags.push('Import channel (OBIS ' + register + '): grid consumption.');
  } else {
    fileFlags.push('OBIS channel not identified \u2014 register recorded as "' + register + '"; verify import vs export.');
  }

  const cTs = head.fields.findIndex(c => c.indexOf('timestamp') !== -1);
  const cVal = head.fields.findIndex(c => c.indexOf('value') !== -1);

  // Collect rows: dot-dates normalised to slashes, then the shared
  // \u00a76.1 machinery decides the date mode (these exports zero-pad,
  // so 'strict' day-first is the expected outcome).
  const raws = [];
  const samples = [];
  for (let i = head.index + 1; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const row = splitCsvLine_(lines[i]);
    const tsRaw = String(row[cTs] || '').trim();
    if (!tsRaw) continue;
    const ts = tsRaw.replace(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/, '$1/$2/$3');
    if (!/\d/.test(ts)) continue; // title-blob fragments, spacers
    raws.push({ line: i + 1, ts: ts, val: row[cVal] });
    if (samples.length < 4000) samples.push(ts);
  }
  const dateMode = decideDateModeFromSamples_(samples, fileFlags);

  const parsed = [];
  for (const r of raws) {
    const end = parseAnyDateMode_(r.ts, dateMode);
    if (!end) { errors.push({ line: r.line, reason: 'Bad timestamp: ' + r.ts }); continue; }
    const kWh = parseNumber_(r.val);
    if (kWh === null) { errors.push({ line: r.line, reason: 'Bad value: ' + r.val }); continue; }
    parsed.push({ line: r.line, end: end, kWh: kWh });
  }

  // Interval length from the smallest positive step between
  // consecutive timestamps (default 30 min). Timestamps are
  // interval ENDS: periodStart = end - step.
  let stepMs = 30 * 60000;
  let best = null;
  for (let i = 1; i < parsed.length; i++) {
    const d = parsed[i].end.getTime() - parsed[i - 1].end.getTime();
    if (d > 0 && (best === null || d < best)) best = d;
  }
  if (best !== null && [15, 30, 60].indexOf(best / 60000) !== -1) stepMs = best;
  if (stepMs !== 30 * 60000) fileFlags.push('Interval length derived as ' + (stepMs / 60000) + ' min from timestamp steps');

  const records = parsed.map(p => ({
    icp: icp, register: register, meterId: meterId,
    periodStart: new Date(p.end.getTime() - stepMs), periodEnd: p.end,
    kWh: p.kWh, granularity: 'HH', readQuality: 'ACTUAL', line: p.line,
  }));

  return {
    header: { format: 'TIMESTAMP_SERIES', version: '', raw: (icp + '_' + meterId + ' ' + register).slice(0, 160) },
    records: records, errors: errors, fileFlags: fileFlags,
  };
}