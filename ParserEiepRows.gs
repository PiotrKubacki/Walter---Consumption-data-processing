// =====================================================
// CDP App - Parser: eiep_rows (Family A)
// -----------------------------------------------------
// Covers HDR,ICPCONS and HDR,ICPSUMM row-record files
// (Meridian, Contact, and any retailer following the
// EIEP13 formats). Ported from the legacy Meridian
// processor and extended per design record \u00a75/\u00a76:
//   - ICPSUMM support (DES-driven column mapping)
//   - per-row granularity (HH | DAILY | LARGER/PERIOD)
//   - date normalisation + m/d vs d/m disambiguation
//   - read quality carried through (RD/ES etc.)
// Emits normalised period consumption records.
// =====================================================

const EIEP = {
  // ICPCONS DET fixed columns (per EIEP13A spec / legacy parser)
  icpconsCols: {
    recordType: 0, icp: 2, timezone: 4, meterId: 5, flag: 6,
    tariff: 7, intervalsPerDay: 8, intervalStart: 9, intervalEnd: 10,
    readQuality: 11, kWh: 12,
  },
  expectedIcpconsDetFields: 14,
};

function eiepSniff_(content) {
  const firstLine = String(content || '').split(/\r?\n/, 1)[0] || '';
  const f = firstLine.split(',');
  return f[0] === 'HDR' && (f[1] === 'ICPCONS' || f[1] === 'ICPSUMM');
}

/**
 * Parse an EIEP rows file into normalised records.
 * Returns { header, records[], errors[], fileFlags[] }
 * record: { icp, register, meterId, periodStart, periodEnd,
 *           kWh, granularity, readQuality, line }
 */
function eiepParse_(content, fileName) {
  const lines = String(content).split(/\r?\n/);
  const firstFields = (lines[0] || '').split(',');
  const format = firstFields[1];

  // ---- Pass 1: collect raw DET rows + DES row (ICPSUMM) ----
  let header = null;
  let desFields = null;
  const rawDets = [];
  const errors = [];
  const fileFlags = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.trim() === '') continue;
    const fields = raw.split(',');
    const type = fields[0];
    if (type === 'HDR') {
      header = {
        format: fields[1], version: fields[2], sender: fields[3],
        recipient: fields[4], audience: fields[5], fileDate: fields[6],
        rowCount: fields[8], periodFrom: fields[9], periodTo: fields[10],
      };
      if (header.version && header.version !== '1.1') {
        fileFlags.push('HDR version "' + header.version + '" is not the expected 1.1 \u2014 ' +
          'spec update lands 30 Oct 2026; verify column layout (design record \u00a711.2).');
      }
    } else if (type === 'DES') {
      desFields = fields;
    } else if (type === 'DET') {
      rawDets.push({ line: i + 1, fields: fields });
    }
  }
  if (!header) throw new Error('No HDR row found in ' + fileName);

  // ---- Date interpretation decision (design record \u00a76.1) ----
  // Try strict spec format first; if any date fails strict, run the
  // dual-interpretation heuristic over the whole file.
  const dateCols = format === 'ICPCONS'
    ? [EIEP.icpconsCols.intervalStart, EIEP.icpconsCols.intervalEnd]
    : icpsummDateCols_(desFields, rawDets);

  const dateMode = decideDateMode_(rawDets, dateCols, fileFlags);

  // ---- Pass 2: build records ----
  const records = [];
  for (const det of rawDets) {
    const f = det.fields;
    if (format === 'ICPCONS') {
      if (f.length < EIEP.expectedIcpconsDetFields - 1) {
        errors.push({ line: det.line, reason: 'Field count = ' + f.length });
        continue;
      }
      const c = EIEP.icpconsCols;
      const start = parseEiepDate_(f[c.intervalStart], dateMode);
      const end   = parseEiepDate_(f[c.intervalEnd],   dateMode);
      if (!start || !end) {
        errors.push({ line: det.line, reason: 'Bad date(s): ' + f[c.intervalStart] + ' / ' + f[c.intervalEnd] });
        continue;
      }
      const kWh = parseFloat(f[c.kWh]);
      if (isNaN(kWh)) {
        errors.push({ line: det.line, reason: 'Bad kWh: ' + f[c.kWh] });
        continue;
      }
      records.push({
        icp: f[c.icp], register: f[c.tariff], meterId: f[c.meterId],
        periodStart: start, periodEnd: end, kWh: kWh,
        granularity: classifyGranularity_(f[c.intervalEnd], start, end),
        readQuality: normaliseReadQuality_(f[c.readQuality]),
        line: det.line,
      });
    } else {
      // ICPSUMM: column positions come from the DES row (tolerant name match).
      const map = icpsummColumnMap_(desFields);
      if (!map.ok) {
        throw new Error('ICPSUMM: could not identify required columns from DES row in ' + fileName +
          '. Missing: ' + map.missing.join(', ') +
          '. The DES-driven mapping needs checking against this retailer\u2019s file (B1 known-limitation).');
      }
      const start = parseEiepDate_(f[map.periodStart], dateMode);
      const end   = parseEiepDate_(f[map.periodEnd],   dateMode);
      if (!start || !end) {
        errors.push({ line: det.line, reason: 'Bad date(s): ' + f[map.periodStart] + ' / ' + f[map.periodEnd] });
        continue;
      }
      const kWh = parseFloat(f[map.kWh]);
      if (isNaN(kWh)) {
        errors.push({ line: det.line, reason: 'Bad units/kWh: ' + f[map.kWh] });
        continue;
      }
      records.push({
        icp: f[map.icp],
        register: map.register !== null ? f[map.register] : '(single)',
        meterId: map.meterId !== null ? f[map.meterId] : '',
        periodStart: start, periodEnd: end, kWh: kWh,
        granularity: 'PERIOD',
        readQuality: normaliseReadQuality_(map.readStatus !== null ? f[map.readStatus] : ''),
        line: det.line,
      });
    }
  }

  return { header: header, records: records, errors: errors, fileFlags: fileFlags };
}

// ---------------- Granularity ----------------
// End-time string test is DST-safe (legacy approach kept):
// :00/:30-ending timestamps are half-hour intervals. Everything
// else is an aggregate: ~1 day => DAILY, larger => PERIOD.
function classifyGranularity_(endStr, start, end) {
  if (/:(00|30):00$/.test(endStr || '') ) {
    const spanMins = (end - start) / 60000;
    if (spanMins <= 35) return 'HH';
  }
  const spanMins = (end - start) / 60000;
  return (spanMins >= 1320 && spanMins <= 1560) ? 'DAILY' : 'PERIOD';
}

function normaliseReadQuality_(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return 'UNKNOWN';
  if (s === 'RD' || s === 'A' || s === 'ACTUAL') return 'ACTUAL';
  if (s === 'ES' || s === 'E' || s === 'ESTIMATE') return 'ESTIMATE';
  return s; // preserved verbatim; verify screen shows the mix
}

// ---------------- ICPSUMM column mapping ----------------
// The DES record names each DET field. Retailer wording varies,
// so match tolerantly on keywords. If the essentials can't be
// identified, the parser fails loudly rather than guessing.
let _icpsummMapCache_ = null;

function icpsummColumnMap_(desFields) {
  if (_icpsummMapCache_ && _icpsummMapCache_._src === (desFields || []).join('|')) return _icpsummMapCache_;
  const map = {
    ok: false, missing: [], _src: (desFields || []).join('|'),
    icp: null, periodStart: null, periodEnd: null, kWh: null,
    register: null, meterId: null, readStatus: null,
  };
  if (!desFields) { map.missing = ['(no DES row)']; _icpsummMapCache_ = map; return map; }
  const find = (patterns) => {
    for (let i = 1; i < desFields.length; i++) {
      const d = String(desFields[i] || '').toLowerCase();
      for (const p of patterns) if (d.indexOf(p) !== -1) return i;
    }
    return null;
  };
  map.icp         = find(['icp']);
  map.periodStart = find(['period start', 'start date', 'read from', 'from date']);
  map.periodEnd   = find(['period end', 'end date', 'read to', 'to date']);
  map.kWh         = find(['kwh', 'units', 'consumption', 'quantity']);
  map.register    = find(['register', 'tariff', 'meter type', 'price']);
  map.meterId     = find(['meter number', 'meter serial', 'meter id']);
  map.readStatus  = find(['read status', 'read type', 'status']);
  const required = { icp: map.icp, periodStart: map.periodStart, periodEnd: map.periodEnd, kWh: map.kWh };
  for (const k of Object.keys(required)) if (required[k] === null) map.missing.push(k);
  map.ok = map.missing.length === 0;
  _icpsummMapCache_ = map;
  return map;
}

function icpsummDateCols_(desFields, rawDets) {
  const map = icpsummColumnMap_(desFields);
  if (map.periodStart !== null && map.periodEnd !== null) return [map.periodStart, map.periodEnd];
  return [];
}

// ---------------- Date handling (design record \u00a76.1) ----------------
// Formats seen in the wild:
//   dd/mm/yyyy HH:mm:ss   (spec)
//   d/m/yy H:mm           (Excel-mangled; ambiguous with m/d/yy)
//   dd/mm/yyyy            (period rows, date only)
//
// decideDateMode_ scans the whole file:
//   'strict'    every date parses as spec dd/mm/yyyy => day-first, no ambiguity
//   'dayfirst'  / 'monthfirst'  chosen by the consistency heuristic
// A non-strict outcome always attaches a file flag.

function decideDateMode_(rawDets, dateCols, fileFlags) {
  if (!dateCols.length) return 'strict';
  let sawAny = false, allStrict = true, textish = false;
  const samples = [];
  for (const det of rawDets) {
    for (const col of dateCols) {
      const v = det.fields[col];
      if (v === undefined || v === '') continue;
      sawAny = true;
      if (!/^\d{2}\/\d{2}\/\d{4}(\s+\d{2}:\d{2}:\d{2})?$/.test(v)) {
        allStrict = false;
        if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v)) textish = true;
      }
      if (samples.length < 4000) samples.push(v);
    }
  }
  if (!sawAny || allStrict) return 'strict';
  if (!textish) {
    fileFlags.push('Unrecognised date format in file \u2014 dates could not be classified; rows will error individually.');
    return 'strict';
  }

  // Ambiguous short dates present: test both interpretations for consistency.
  const day = datesConsistent_(samples, true);
  const month = datesConsistent_(samples, false);
  const okDay = day.valid, okMonth = month.valid;
  // Tie-break: the correct reading advances smoothly; the wrong one jumps
  // ~a month at every day boundary. Prefer the reading with materially
  // fewer large steps (>2 days) when both are otherwise consistent.
  let winner = null;
  if (okDay && !okMonth) winner = 'dayfirst';
  else if (okMonth && !okDay) winner = 'monthfirst';
  else if (okDay && okMonth) {
    if (day.largeStepRatio * 5 < month.largeStepRatio) winner = 'dayfirst';
    else if (month.largeStepRatio * 5 < day.largeStepRatio) winner = 'monthfirst';
  }
  if (winner === 'dayfirst') {
    fileFlags.push('Excel-mangled dates detected; resolved as day-first (d/m/yy) by sequence consistency. ' +
      'File was opened in Excel somewhere upstream \u2014 chase the source (design record \u00a74 operating rule).');
    return 'dayfirst';
  }
  if (winner === 'monthfirst') {
    fileFlags.push('Excel-mangled dates detected; resolved as month-first (m/d/yy) by sequence consistency. ' +
      'File was opened in Excel somewhere upstream \u2014 chase the source.');
    return 'monthfirst';
  }
  fileFlags.push('AMBIGUOUS DATES: day-first and month-first readings cannot be separated by sequence ' +
    'consistency \u2014 operator decision required. Rows parsed day-first for display only.');
  return 'dayfirst';
}

function datesConsistent_(samples, dayFirst) {
  // Every sample must parse validly under this reading (e.g. month 13 is an
  // instant rejection). Ordering must hold at least 95% of the time (allows
  // resets at ICP-group boundaries). Large steps (>2 days) are counted for
  // the tie-break in decideDateMode_.
  let prev = null, orderedHits = 0, largeSteps = 0, orderedTotal = 0;
  for (const s of samples) {
    const d = parseFlexibleDate_(s, dayFirst);
    if (!d) return { valid: false, largeStepRatio: 1 };
    if (prev) {
      orderedTotal++;
      if (d >= prev) orderedHits++;
      if (Math.abs(d - prev) > 2 * 86400000) largeSteps++;
    }
    prev = d;
  }
  if (orderedTotal === 0) return { valid: true, largeStepRatio: 0 };
  return {
    valid: (orderedHits / orderedTotal) >= 0.95,
    largeStepRatio: largeSteps / orderedTotal,
  };
}

function parseEiepDate_(s, mode) {
  if (mode === 'strict') {
    const strict = parseStrictDdmmyyyy_(s);
    if (strict) return strict;
    // Period rows may be date-only in spec form
    return parseFlexibleDate_(s, true);
  }
  return parseFlexibleDate_(s, mode === 'dayfirst');
}

function parseStrictDdmmyyyy_(s) {
  const m = (s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
}

function parseFlexibleDate_(s, dayFirst) {
  const m = (s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  let a = +m[1], b = +m[2], y = +m[3];
  if (y < 100) y += 2000;
  const day = dayFirst ? a : b;
  const mon = dayFirst ? b : a;
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  const d = new Date(y, mon - 1, day, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // Reject rollover (e.g. 31/02 becoming 3 March)
  if (d.getMonth() !== mon - 1 || d.getDate() !== day) return null;
  return d;
}
