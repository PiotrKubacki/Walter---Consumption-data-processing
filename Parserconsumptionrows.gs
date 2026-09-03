// =====================================================
// CDP App - Parser: consumption_rows (headerless CSV)
// -----------------------------------------------------
// Headerless positional rows, observed Aug 2026:
//   0 ICP | 1 meter serial | 2 "Consumption" | 3 register
//   code (UN...) | 4 period-of-availability | 5 period
//   start | 6 period end | 7 read status (RD/ES) |
//   8 tariff name ("Anytime") | 9 kWh
// Monthly billing periods ending 23:59; multiple meter
// serials per ICP occur (meter changes) and merge into
// the same ICP-register series.
// Sniff is shape-based (no header): NZ ICP pattern in
// field 0 AND literal "Consumption" in field 2 on the
// first data line.
// Dates are d/mm/yyyy H:mm, parsed day-first (NZ export;
// no Excel-mangle heuristics needed for this channel \u2014
// if a mangled variant ever appears, extend like \u00a76.1).
// Field 8's friendly tariff name is carried as a note
// only; register mapping stays with field 3 + the
// Register Map, one translation path for everything.
// =====================================================

const CONSROWS_ICP_RE = /^\d{10}[A-Z0-9]{5}$/;

function consumptionRowsSniff_(content) {
  const lines = String(content || '').split(/\r?\n/);
  let seen = 0;
  for (const raw of lines) {
    if (!raw || raw.trim() === '') continue;
    const f = splitCsvLine_(raw);
    return f.length >= 10 &&
      CONSROWS_ICP_RE.test(String(f[0]).trim()) &&
      String(f[2]).trim().toLowerCase() === 'consumption';
    // first non-blank line decides; headerless files have no preamble
  }
  return false;
}

function consumptionRowsParse_(content, fileName) {
  const lines = String(content).split(/\r?\n/);
  const records = [];
  const errors = [];
  const fileFlags = [];
  const tariffNames = {};
  const dateMode = decideDateModeFromSamples_(collectDateSamples_(lines, -1, [5, 6]), fileFlags);

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const f = splitCsvLine_(lines[i]);
    if (f.length < 10) { errors.push({ line: i + 1, reason: 'Field count = ' + f.length }); continue; }
    const icp = String(f[0]).trim();
    if (!CONSROWS_ICP_RE.test(icp)) { errors.push({ line: i + 1, reason: 'Bad ICP: ' + f[0] }); continue; }
    if (String(f[2]).trim().toLowerCase() !== 'consumption') {
      errors.push({ line: i + 1, reason: 'Unexpected row type: ' + f[2] });
      continue;
    }
    const start = parseAnyDateMode_(f[5], dateMode);
    const end = parseAnyDateMode_(f[6], dateMode);
    if (!start || !end) { errors.push({ line: i + 1, reason: 'Bad date(s): ' + f[5] + ' / ' + f[6] }); continue; }
    const kWh = parseNumber_(f[9]);
    if (kWh === null) { errors.push({ line: i + 1, reason: 'Bad kWh: ' + f[9] }); continue; }
    const register = String(f[3]).trim() || '(single)';
    const tariffName = String(f[8]).trim();
    if (tariffName) tariffNames[register + ' \u2192 ' + tariffName] = true;
    records.push({
      icp: icp, register: register, meterId: String(f[1]).trim(),
      periodStart: start, periodEnd: end, kWh: kWh,
      granularity: classifyGranularity_(f[6], start, end),
      readQuality: normaliseReadQuality_(f[7]),
      line: i + 1,
    });
  }

  const namePairs = Object.keys(tariffNames);
  if (namePairs.length) {
    fileFlags.push('File carries tariff names alongside register codes: ' + namePairs.join(', ') +
      ' \u2014 useful cross-check for the Register Map (mapping still comes from the Register Map tab).');
  }

  return {
    header: { format: 'CONSUMPTION_ROWS', version: '', raw: (lines[0] || '').slice(0, 160) },
    records: records, errors: errors, fileFlags: fileFlags,
  };
}