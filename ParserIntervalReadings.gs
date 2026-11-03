// =====================================================
// CDP App - Parser: interval_readings (Family I)
// -----------------------------------------------------
// Retailer-portal interval export, observed Nov 2026
// ("electricity-interval-meter-readings_*.csv"):
//   header: Supply Point Identifier, Interval Start,
//           Interval End, Value, Reading Direction
//   rows:   <ICP>,2025-11-01 00:00:00+13:00,
//           2025-11-01 00:30:00+13:00,
//           4.481000000000000000 KWH,IMPORT
// Timestamps carry EXPLICIT UTC offsets (+13:00 NZDT /
// +12:00 NZST), so DST is handled by the data itself and
// the shared §6.1 date machinery is NOT needed — these are
// parsed as strict ISO; anything else is a loud row error.
// The unit rides inside the Value cell and must be KWH.
//
// DIRECTION SEMANTICS MATTER (same lesson as Family H):
// EXPORT rows are GENERATION (export to grid), not customer
// consumption. They keep "EXPORT" as their register so they
// stay visibly separate, and the file flag says so loudly.
// =====================================================

function intervalReadingsSniff_(content) {
  return intervalReadingsHeader_(content) !== null;
}

function intervalReadingsHeader_(content) {
  const lines = String(content || '').split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const f = splitCsvLine_(lines[i]).map(normHdr_);
    const has = (kw) => f.some(c => c.indexOf(kw) !== -1);
    if (has('supply point identifier') && has('interval start') && has('reading direction')) {
      return { index: i, fields: f };
    }
    if (++seen >= 10) return null;
  }
  return null;
}

/** Strict ISO "yyyy-mm-dd hh:mm:ss(+hh:mm)" -> Date, or null. */
function intervalReadingsTs_(s) {
  const m = String(s || '').trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:([+-])(\d{2}):?(\d{2}))?$/);
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!m[7]) return new Date(utc); // no offset: taken as UTC, flagged by caller
  const offMin = (+m[8]) * 60 + (+m[9]);
  return new Date(utc - (m[7] === '+' ? 1 : -1) * offMin * 60000);
}

function intervalReadingsParse_(content, fileName) {
  const head = intervalReadingsHeader_(content);
  if (!head) throw new Error('interval_readings: header row not found in ' + fileName);
  const lines = String(content).split(/\r?\n/);
  const errors = [];
  const fileFlags = [];

  const col = (kw) => head.fields.findIndex(c => c.indexOf(kw) !== -1);
  const cIcp = col('supply point identifier');
  const cStart = col('interval start');
  const cEnd = col('interval end');
  const cVal = col('value');
  const cDir = col('reading direction');
  if (cIcp < 0 || cStart < 0 || cEnd < 0 || cVal < 0) {
    throw new Error('interval_readings: expected columns missing in ' + fileName);
  }

  const records = [];
  let exportRows = 0;
  let noOffset = 0;
  for (let i = head.index + 1; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const row = splitCsvLine_(lines[i]);
    const icp = String(row[cIcp] || '').trim();
    if (!icp) continue;
    const start = intervalReadingsTs_(row[cStart]);
    const end = intervalReadingsTs_(row[cEnd]);
    if (!start || !end || end.getTime() <= start.getTime()) {
      errors.push({ line: i + 1, reason: 'Bad interval: ' + row[cStart] + ' -> ' + row[cEnd] });
      continue;
    }
    if (!/[+-]\d{2}:?\d{2}$/.test(String(row[cStart]).trim())) noOffset++;

    // Unit rides in the value cell: "4.481000000000000000 KWH"
    const valParts = String(row[cVal] || '').trim().split(/\s+/);
    const kWh = parseNumber_(valParts[0]);
    const unit = (valParts[1] || '').toUpperCase();
    if (kWh === null) { errors.push({ line: i + 1, reason: 'Bad value: ' + row[cVal] }); continue; }
    if (unit && unit !== 'KWH') {
      errors.push({ line: i + 1, reason: 'Unexpected unit "' + unit + '" (only KWH is supported)' });
      continue;
    }

    const dir = String(row[cDir] || 'IMPORT').trim().toUpperCase() || 'IMPORT';
    if (dir === 'EXPORT') exportRows++;
    const mins = (end.getTime() - start.getTime()) / 60000;
    records.push({
      icp: icp, register: dir, meterId: '',
      periodStart: start, periodEnd: end, kWh: kWh,
      granularity: mins <= 60 ? 'HH' : mins >= 1380 ? 'DAILY' : 'PERIOD',
      readQuality: 'ACTUAL', line: i + 1,
    });
  }

  if (exportRows) {
    fileFlags.push('EXPORT direction rows (' + exportRows + '): GENERATION data, not customer consumption. ' +
      'Register kept separate as "EXPORT" — do not feed into a consumption analysis unless intended.');
  }
  if (noOffset) {
    fileFlags.push(noOffset + ' timestamp(s) carried no UTC offset — taken as UTC; verify if that looks wrong.');
  }

  return {
    header: { format: 'INTERVAL_READINGS', version: '', raw: head.fields.join(',').slice(0, 160) },
    records: records, errors: errors, fileFlags: fileFlags,
  };
}
