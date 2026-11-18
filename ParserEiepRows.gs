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
  const lines = String(content || '').split(/\r?\n/);
  let seen = 0;
  for (const raw of lines) {
    if (!raw || raw.trim() === '') continue;
    const f = splitCsvLine_(raw);
    if (f[0] === 'HDR' && (f[1] === 'ICPCONS' || f[1] === 'ICPSUMM')) return true;
    // v1.4 files may lead with a labelled column-header row before the HDR;
    // keep scanning a few lines before giving up.
    if (++seen >= 10) return false;
  }
  return false;
}

/**
 * Split a CSV line into fields, stripping a UTF-8 BOM, surrounding
 * quotes, and unescaping doubled quotes. Handles commas inside quoted
 * fields (rare in EIEP but seen in Excel-resaved files).
 */
function splitCsvLine_(raw) {
  let s = String(raw);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // BOM
  if (s.indexOf('"') === -1) return s.split(',');
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse an EIEP rows file into normalised records.
 * Returns { header, records[], errors[], fileFlags[] }
 * record: { icp, register, meterId, periodStart, periodEnd,
 *           kWh, granularity, readQuality, line }
 */
function eiepParse_(content, fileName) {
  const lines = String(content).split(/\r?\n/);
  let format = null;
  for (const raw of lines) {
    if (!raw || raw.trim() === '') continue;
    const f = splitCsvLine_(raw);
    if (f[0] === 'HDR') { format = f[1]; break; }
  }
  if (!format) throw new Error('No HDR row found in ' + fileName);

  // ---- Pass 1: collect raw DET rows + DES row (ICPSUMM) ----
  let header = null;
  let desFields = null;
  let detLabels = null; // v1.4: labelled column-header row prefixed DET
  const rawDets = [];
  const errors = [];
  const fileFlags = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.trim() === '') continue;
    const fields = splitCsvLine_(raw);
    const type = fields[0];
    if (type === 'HDR') {
      const versionShaped = /^\d+(\.\d+)?$/.test(String(fields[2] || '').trim());
      header = {
        format: fields[1],
        version: versionShaped ? fields[2] : '',
        sender: versionShaped ? fields[3] : fields[2],
        raw: raw.length > 160 ? raw.slice(0, 160) + '\u2026' : raw,
        periodFrom: versionShaped ? fields[9] : '',
        periodTo: versionShaped ? fields[10] : '',
      };
      if (!versionShaped) {
        fileFlags.push('HDR variant without a version field (sender ' + header.sender +
          ') \u2014 data columns are resolved independently of the HDR, but note the layout.');
      } else if (header.version !== '1.1' && header.version !== '1.4') {
        fileFlags.push('HDR version "' + header.version + '" is not a known layout (1.1/1.4) \u2014 ' +
          'spec update lands 30 Oct 2026; verify column layout (design record \u00a711.2).');
      }
    } else if (type === 'DES') {
      desFields = fields;
    } else if (type === 'DET') {
      // v1.4 label row: field values are column names, not data.
      if (!detLabels && isDetLabelRow_(fields)) {
        detLabels = fields;
        continue;
      }
      rawDets.push({ line: i + 1, fields: fields });
    }
  }
  if (!header) throw new Error('No HDR row found in ' + fileName);

  // Column indices: label-driven when a v1.4 label row exists,
  // spec-fixed v1.1 indices otherwise.
  const cols = detLabels ? icpconsColsFromLabels_(detLabels, fileFlags) : EIEP.icpconsCols;

  // ---- Date interpretation decision (design record \u00a76.1) ----
  // Try strict spec format first; if any date fails strict, run the
  // dual-interpretation heuristic over the whole file.
  const dateCols = format === 'ICPCONS'
    ? [cols.intervalStart, cols.intervalEnd]
    : icpsummDateCols_(desFields, rawDets);

  const dateMode = decideDateMode_(rawDets, dateCols, fileFlags);

  // MIXED-ORIENTATION FILES (\u00a76.1 extension): when neither global
  // reading survives (partially Excel-mangled files contain rows in
  // BOTH orientations), resolve dates PER ROW: rows with exactly one
  // valid reading resolve themselves and become anchors; both-valid
  // rows take the reading that fits between their nearest anchors in
  // file order. Rows fitting neither become row errors.
  let rowDates = null;
  if (dateMode === 'dayfirst' && fileFlags.some(f => f.indexOf('AMBIGUOUS DATES') === 0)) {
    rowDates = resolveRowDatesAnchored_(rawDets, dateCols, fileFlags);
  }

  // ---- Pass 2: build records ----
  // v2.31: energy flow direction. X = extraction (the customer's
  // consumption); I = injection (solar/generation fed back to the grid,
  // register content code EG in Meridian files). Injection rows keep
  // their own register named "EXPORT" - the same name the interval
  // readings parser uses - so no consumption analysis or RFP total
  // ever adds generation to usage. The original code is reported in
  // the file flags.
  const records = [];
  const exportCodes = {};
  let exportRows = 0;
  const flowOf = (v) => String(v || '').trim().toUpperCase();
  for (let di = 0; di < rawDets.length; di++) {
    const det = rawDets[di];
    const f = det.fields;
    const rd = rowDates ? rowDates[di] : null;
    if (rd && rd.error) {
      errors.push({ line: det.line, reason: rd.error });
      continue;
    }
    if (format === 'ICPCONS') {
      const c = cols;
      if (f.length <= c.kWh) {
        errors.push({ line: det.line, reason: 'Field count = ' + f.length });
        continue;
      }
      const start = rd ? rd.start : parseEiepDate_(f[c.intervalStart], dateMode);
      const end   = rd ? rd.end   : parseEiepDate_(f[c.intervalEnd],   dateMode);
      if (!start || !end) {
        errors.push({ line: det.line, reason: 'Bad date(s): ' + f[c.intervalStart] + ' / ' + f[c.intervalEnd] });
        continue;
      }
      const kWh = parseFloat(f[c.kWh]);
      if (isNaN(kWh)) {
        errors.push({ line: det.line, reason: 'Bad kWh: ' + f[c.kWh] });
        continue;
      }
      const flow = c.flag === null || c.flag === undefined ? '' : flowOf(f[c.flag]);
      let register = f[c.tariff];
      if (flow === 'I') {
        exportRows++;
        exportCodes[String(register || '').trim() || '(blank)'] = true;
        register = 'EXPORT';
      }
      records.push({
        icp: f[c.icp], register: register, meterId: f[c.meterId],
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
      const start = rd ? rd.start : parseEiepDate_(f[map.periodStart], dateMode);
      const end   = rd ? rd.end   : parseEiepDate_(f[map.periodEnd],   dateMode);
      if (!start || !end) {
        errors.push({ line: det.line, reason: 'Bad date(s): ' + f[map.periodStart] + ' / ' + f[map.periodEnd] });
        continue;
      }
      const kWh = parseFloat(f[map.kWh]);
      if (isNaN(kWh)) {
        errors.push({ line: det.line, reason: 'Bad units/kWh: ' + f[map.kWh] });
        continue;
      }
      let sReg = map.register !== null ? f[map.register] : '(single)';
      if (map.flow !== null && flowOf(f[map.flow]) === 'I') {
        exportRows++;
        exportCodes[String(sReg || '').trim() || '(blank)'] = true;
        sReg = 'EXPORT';
      }
      records.push({
        icp: f[map.icp],
        register: sReg,
        meterId: map.meterId !== null ? f[map.meterId] : '',
        periodStart: start, periodEnd: end, kWh: kWh,
        granularity: 'PERIOD',
        readQuality: normaliseReadQuality_(map.readStatus !== null ? f[map.readStatus] : ''),
        line: det.line,
      });
    }
  }

  if (exportRows) {
    fileFlags.push('EXPORT direction rows (' + exportRows + ', flow I, register ' + Object.keys(exportCodes).join('/') +
      '): GENERATION data fed back to the grid, not customer consumption. ' +
      'Kept as register "EXPORT" - excluded from consumption totals and the RFP queue.');
  }

  return { header: header, records: records, errors: errors, fileFlags: fileFlags };
}

// ---------------- Granularity ----------------
// Interval layer: 30-min rows (:00/:30 endings, seconds optional)
// plus any sub-3-hour span \u2014 DST transition days produce odd
// 60/90-min intervals that are still interval data, not aggregates.
// Aggregates: ~1 day => DAILY, larger => PERIOD.
function classifyGranularity_(endStr, start, end) {
  const spanMins = (end - start) / 60000;
  if (spanMins <= 180) return 'HH';
  return (spanMins >= 1320 && spanMins <= 1560) ? 'DAILY' : 'PERIOD';
}

// ---------------- v1.4 labelled column-header row ----------------
// v1.4 files lead with a DET-prefixed row of column NAMES, e.g.:
// DET,consumer_auth_code,ICP,response_code,NZDT_adjustment,
//     meter_register,energy_flow_direction,register_content_code,
//     period_of_availability,period_start,period_end,read_status,
//     consumption_kWh
function isDetLabelRow_(fields) {
  const joined = fields.slice(1).join(',').toLowerCase();
  return joined.indexOf('icp') !== -1 &&
         (joined.indexOf('period_start') !== -1 || joined.indexOf('consumption') !== -1);
}

function icpconsColsFromLabels_(labels, fileFlags) {
  const idx = {};
  for (let i = 1; i < labels.length; i++) idx[String(labels[i] || '').trim().toLowerCase()] = i;
  const pick = (names, fallback) => {
    for (const n of names) if (n in idx) return idx[n];
    return fallback;
  };
  const cols = {
    icp:           pick(['icp'], EIEP.icpconsCols.icp),
    meterId:       pick(['meter_register', 'meter_serial_number', 'meter_number'], EIEP.icpconsCols.meterId),
    tariff:        pick(['register_content_code', 'register_code', 'tariff'], EIEP.icpconsCols.tariff),
    flag:          pick(['energy_flow_direction', 'flow_direction', 'flow'], EIEP.icpconsCols.flag),
    intervalStart: pick(['period_start', 'interval_start'], EIEP.icpconsCols.intervalStart),
    intervalEnd:   pick(['period_end', 'interval_end'], EIEP.icpconsCols.intervalEnd),
    readQuality:   pick(['read_status', 'read_type'], EIEP.icpconsCols.readQuality),
    kWh:           pick(['consumption_kwh', 'consumption', 'kwh', 'units'], EIEP.icpconsCols.kWh),
  };
  fileFlags.push('v1.4 labelled columns used: ICP@' + cols.icp + ', start@' + cols.intervalStart +
    ', end@' + cols.intervalEnd + ', kWh@' + cols.kWh + ', status@' + cols.readQuality + ', flow@' + cols.flag + '.');
  return cols;
}

function normaliseReadQuality_(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return 'UNKNOWN';
  if (s === 'RD' || s === 'R' || s === 'A' || s === 'ACTUAL') return 'ACTUAL';
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
    register: null, meterId: null, readStatus: null, flow: null,
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
  map.flow        = find(['flow direction', 'energy flow', 'flow']);
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
  const samples = [];
  for (const det of rawDets) {
    for (const col of dateCols) {
      const v = det.fields[col];
      if (v === undefined || v === '') continue;
      if (samples.length < 4000) samples.push(v);
    }
  }
  return decideDateModeFromSamples_(samples, fileFlags);
}

/**
 * Shared \u00a76.1 date-mode decision, usable by EVERY parser: collect the
 * file's date strings, call this once, then parse with the returned
 * mode. 'strict' = all spec-shaped (zero-padded dd/mm/yyyy, day-first,
 * no ambiguity). Otherwise dual-interpretation sequence consistency
 * with the large-step tie-break decides day-first vs month-first;
 * non-strict outcomes always attach a file flag. ISO dates are
 * unambiguous and never counted against strictness.
 */
function decideDateModeFromSamples_(samples, fileFlags) {
  let sawAny = false, allStrict = true, textish = false;
  const relevant = [];
  for (const v of samples) {
    if (v === undefined || v === null || v === '') continue;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) continue; // ISO: unambiguous
    sawAny = true;
    if (!/^\d{2}\/\d{2}\/\d{4}(\s+\d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
      allStrict = false;
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) textish = true;
    }
    if (relevant.length < 4000) relevant.push(s);
  }
  if (!sawAny || allStrict) return 'strict';
  if (!textish) {
    fileFlags.push('Unrecognised date format in file \u2014 dates could not be classified; rows will error individually.');
    return 'strict';
  }

  const day = datesConsistent_(relevant, true);
  const month = datesConsistent_(relevant, false);
  const okDay = day.valid, okMonth = month.valid;
  let winner = null;
  if (okDay && !okMonth) winner = 'dayfirst';
  else if (okMonth && !okDay) winner = 'monthfirst';
  else if (okDay && okMonth) {
    if (day.largeStepRatio * 5 < month.largeStepRatio) winner = 'dayfirst';
    else if (month.largeStepRatio * 5 < day.largeStepRatio) winner = 'monthfirst';
  }
  if (winner === 'dayfirst') {
    fileFlags.push('Short/unpadded date format resolved as day-first (d/m) by sequence consistency.');
    return 'dayfirst';
  }
  if (winner === 'monthfirst') {
    fileFlags.push('EXCEL-MANGLED DATES: resolved as month-first (m/d) by sequence consistency \u2014 ' +
      'file was US-locale resaved somewhere upstream; dates have been corrected. Verify one date against the source.');
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

/**
 * Per-row anchored date resolution for MIXED-ORIENTATION files
 * (\u00a76.1 extension). Some Excel-mangled files carry BOTH date
 * orientations: rows whose day is 13+ are self-evident in whichever
 * orientation they use; days 1-12 are ambiguous. Self-evident rows
 * (plus strict/ISO rows) become anchors in file order; ambiguous
 * rows take the orientation whose dates fit between their nearest
 * anchors (\u00b12-day tolerance). Rows fitting neither orientation
 * become row errors rather than guesses.
 * Returns array parallel to rawDets: null (row not ambiguous \u2014
 * caller parses normally... actually resolved for every row with
 * date content) or {start, end} or {error}.
 */
function resolveRowDatesAnchored_(rawDets, dateCols, fileFlags) {
  // This resolver supersedes the file-level AMBIGUOUS verdict.
  for (let i = fileFlags.length - 1; i >= 0; i--) {
    if (fileFlags[i].indexOf('AMBIGUOUS DATES') === 0) fileFlags.splice(i, 1);
  }
  const startCol = dateCols[0], endCol = dateCols.length > 1 ? dateCols[1] : dateCols[0];
  const TOL = 2 * 86400000;

  // Classify one string: {kind:'definite', d} | {kind:'pair', d1, d2} | {kind:'bad'}
  function classify(str) {
    const s0 = String(str === undefined || str === null ? '' : str).trim();
    if (!s0) return { kind: 'bad' };
    const iso = s0.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return { kind: 'definite', d: parseAnyDateMode_(s0, 'strict') };
    const strict = parseStrictDdmmyyyy_(s0);
    if (strict) return { kind: 'definite', d: strict };
    const d1 = parseFlexibleDate_(s0, true);
    const d2 = parseFlexibleDate_(s0, false);
    if (d1 && d2) {
      if (d1.getTime() === d2.getTime()) return { kind: 'definite', d: d1 };
      return { kind: 'pair', d1: d1, d2: d2 };
    }
    if (d1) return { kind: 'definite', d: d1, orient: 'dayfirst' };
    if (d2) return { kind: 'definite', d: d2, orient: 'monthfirst' };
    return { kind: 'bad' };
  }

  // Pass 1: classify all rows; collect anchors from fully-definite rows
  const cls = [];
  const anchors = []; // {idx, t}
  let nDefinite = 0, nDayOnly = 0, nMonthOnly = 0;
  for (let i = 0; i < rawDets.length; i++) {
    const f = rawDets[i].fields;
    const cs = classify(f[startCol]);
    const ce = classify(f[endCol]);
    cls.push([cs, ce]);
    if (cs.kind === 'definite' && ce.kind === 'definite' && cs.d && ce.d) {
      anchors.push({ idx: i, t: cs.d.getTime() });
      nDefinite++;
      if (cs.orient === 'dayfirst' || ce.orient === 'dayfirst') nDayOnly++;
      if (cs.orient === 'monthfirst' || ce.orient === 'monthfirst') nMonthOnly++;
    }
  }

  // Pass 2: resolve every row
  const out = new Array(rawDets.length).fill(null);
  let aPtr = 0, nAnchoredDay = 0, nAnchoredMonth = 0, nErr = 0;
  for (let i = 0; i < rawDets.length; i++) {
    const [cs, ce] = cls[i];
    while (aPtr < anchors.length - 1 && anchors[aPtr + 1].idx < i) aPtr++;
    // nearest anchors around i
    let prev = null, next = null;
    for (let a = aPtr; a >= 0; a--) if (anchors[a] && anchors[a].idx < i) { prev = anchors[a]; break; }
    for (let a = aPtr; a < anchors.length; a++) if (anchors[a].idx > i) { next = anchors[a]; break; }
    const lo = prev ? prev.t - TOL : -Infinity;
    const hi = next ? next.t + TOL : Infinity;

    if (cs.kind === 'bad' || ce.kind === 'bad') { out[i] = null; continue; } // caller errors on parse as before

    if (cs.kind === 'definite' && ce.kind === 'definite') { out[i] = { start: cs.d, end: ce.d }; continue; }

    // At least one pair: evaluate both orientations as a coherent row
    function rowUnder(dayFirst) {
      const sd = cs.kind === 'pair' ? (dayFirst ? cs.d1 : cs.d2) : cs.d;
      const ed = ce.kind === 'pair' ? (dayFirst ? ce.d1 : ce.d2) : ce.d;
      if (!sd || !ed) return null;
      if (ed.getTime() < sd.getTime()) return null;
      if (sd.getTime() < lo || sd.getTime() > hi) return null;
      return { start: sd, end: ed };
    }
    const rDay = rowUnder(true);
    const rMonth = rowUnder(false);
    // Block-boundary handling: register blocks restart the date
    // sequence, so the between-anchors window can be empty/backward
    // there. Fall back to anchor PROXIMITY: accept the reading that
    // sits within 16 days of a neighbouring anchor and 3x closer
    // than the alternative reading.
    function score(r) {
      if (!r) return Infinity;
      let best = Infinity;
      if (prev) best = Math.min(best, Math.abs(r.start.getTime() - prev.t));
      if (next) best = Math.min(best, Math.abs(r.start.getTime() - next.t));
      return best;
    }
    function proximityPick() {
      const FTOL = 16 * 86400000;
      const sdDay = cs.kind === 'pair' ? cs.d1 : cs.d;
      const edDay = ce.kind === 'pair' ? ce.d1 : ce.d;
      const sdMon = cs.kind === 'pair' ? cs.d2 : cs.d;
      const edMon = ce.kind === 'pair' ? ce.d2 : ce.d;
      const cDay = (sdDay && edDay && edDay.getTime() >= sdDay.getTime()) ? { start: sdDay, end: edDay } : null;
      const cMon = (sdMon && edMon && edMon.getTime() >= sdMon.getTime()) ? { start: sdMon, end: edMon } : null;
      const sD = score(cDay), sM = score(cMon);
      if (cDay && sD <= FTOL && sD * 3 < sM) { nAnchoredDay++; return cDay; }
      if (cMon && sM <= FTOL && sM * 3 < sD) { nAnchoredMonth++; return cMon; }
      return null;
    }
    if (rDay && !rMonth) { out[i] = rDay; nAnchoredDay++; }
    else if (rMonth && !rDay) { out[i] = rMonth; nAnchoredMonth++; }
    else if (rDay && rMonth) {
      if (prev && Math.abs(rDay.start.getTime() - prev.t) * 3 < Math.abs(rMonth.start.getTime() - prev.t)) { out[i] = rDay; nAnchoredDay++; }
      else if (prev && Math.abs(rMonth.start.getTime() - prev.t) * 3 < Math.abs(rDay.start.getTime() - prev.t)) { out[i] = rMonth; nAnchoredMonth++; }
      else { out[i] = { error: 'AMBIGUOUS ROW DATE: both readings fit the anchor window (' + rawDets[i].fields[startCol] + ')' }; nErr++; }
    }
    else {
      const picked = proximityPick();
      if (picked) out[i] = picked;
      else { out[i] = { error: 'AMBIGUOUS ROW DATE: neither reading fits near neighbouring rows (' + rawDets[i].fields[startCol] + ')' }; nErr++; }
    }
  }

  // Uniform-orientation second chance: if EVERY self-evident and
  // anchored row agrees on one orientation, the file's orientation is
  // established beyond the local anchor tests \u2014 rows that errored
  // only because their anchors were sparse take that orientation.
  // Genuinely unparseable dates remain errors (fail loudly).
  let nUniform = 0;
  const uniformMonth = (nDayOnly + nAnchoredDay) === 0 && (nMonthOnly + nAnchoredMonth) > 0;
  const uniformDay = (nMonthOnly + nAnchoredMonth) === 0 && (nDayOnly + nAnchoredDay) > 0;
  if (uniformMonth || uniformDay) {
    for (let i = 0; i < out.length; i++) {
      if (!out[i] || !out[i].error) continue;
      const [cs, ce] = cls[i];
      if (cs.kind === 'bad' || ce.kind === 'bad') continue;
      const sd = cs.kind === 'pair' ? (uniformDay ? cs.d1 : cs.d2) : cs.d;
      const ed = ce.kind === 'pair' ? (uniformDay ? ce.d1 : ce.d2) : ce.d;
      if (sd && ed && ed.getTime() >= sd.getTime()) {
        out[i] = { start: sd, end: ed };
        nErr--; nUniform++;
      }
    }
  }

  const orientNote = (nDayOnly && nMonthOnly) ? 'BOTH orientations present among self-evident rows' :
    nMonthOnly ? 'self-evident rows are month-first (m/d)' :
    nDayOnly ? 'self-evident rows are day-first (d/m)' : 'self-evident rows are spec/ISO formatted';
  fileFlags.push('MIXED/AMBIGUOUS DATES RESOLVED PER ROW: ' + nDefinite + ' self-evident row(s) anchored the rest (' +
    nAnchoredDay + ' day-first, ' + nAnchoredMonth + ' month-first' +
    (nUniform ? ', ' + nUniform + ' by uniform file orientation' : '') +
    (nErr ? ', ' + nErr + ' unresolvable \u2014 errored' : '') +
    '); ' + orientNote + '. File is partially Excel-mangled \u2014 chase the source.');
  return out;
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
  const m = (s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
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
