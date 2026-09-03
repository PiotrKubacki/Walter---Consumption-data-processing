// =====================================================
// CDP App - Parser: period_table (Family B)
// -----------------------------------------------------
// Plain tabular billing-period reads:
//   ICP | Meter Code | Meter Type Code | Meter Register |
//   Multiplier | Start Date | End Date | Usage | Days
// One row per register per billing period; multi-register
// ICPs report each register separately (never merged).
// Header matching is tolerant (keyword-based) since these
// exports vary in exact wording. Covers the Octopus (OCTO)
// interval export too: read_start/read_end/read_quality/kwh
// headers, ISO datetimes, 30-min rows (classified HH by span). Read quality defaults to
// ACTUAL unless a status-like column is present.
//
// MULTIPLIER NOTE: the Usage column in these exports is
// normally already multiplied; applying the Multiplier
// column again would double it. The parser therefore does
// NOT apply the multiplier, and flags rows where it is
// present and != 1 so the first real file can be verified
// against a known bill. (Design record \u00a75 Family B.)
// =====================================================

/** Normalise a header cell: lowercase, underscores/hyphens as spaces. */
function normHdr_(s) {
  return String(s === undefined || s === null ? '' : s).trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
}

function periodTableSniff_(content) {
  const head = headerRowPT_(content);
  return head !== null;
}

function headerRowPT_(content) {
  const lines = String(content || '').split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const f = splitCsvLine_(lines[i]).map(normHdr_);
    const has = (kw) => f.some(c => c.indexOf(kw) !== -1);
    if (has('icp') &&
        (has('start date') || has('read start')) &&
        (has('end date') || has('read end')) &&
        (has('usage') || has('units') || has('consumption') || has('kwh'))) {
      return { index: i, fields: f };
    }
    if (++seen >= 12) return null;
  }
  return null;
}

function periodTableParse_(content, fileName) {
  const head = headerRowPT_(content);
  if (!head) throw new Error('period_table: header row not found in ' + fileName);
  const f = head.fields;
  const col = (kws, required) => {
    for (let i = 0; i < f.length; i++) {
      for (const kw of kws) if (f[i].indexOf(kw) !== -1) return i;
    }
    if (required) throw new Error('period_table: required column not found (' + kws[0] + ') in ' + fileName);
    return null;
  };
  const cIcp   = col(['icp'], true);
  const cStart = col(['start date', 'read start'], true);
  const cEnd   = col(['end date', 'read end'], true);
  const cUsage = col(['usage', 'units', 'consumption', 'kwh'], true);
  const cReg   = col(['meter register', 'register']);
  const cMeter = col(['meter code', 'meter number', 'meter serial', 'serial']);
  const cMult  = col(['multiplier']);
  const cDays  = col(['days']);
  const cStat  = col(['read status', 'read type', 'read quality', 'status', 'reading type', 'quality']);

  const lines = String(content).split(/\r?\n/);
  const records = [];
  const errors = [];
  const fileFlags = [];
  let multFlagged = false;
  const dateMode = decideDateModeFromSamples_(collectDateSamples_(lines, head.index, [cStart, cEnd]), fileFlags);

  for (let i = head.index + 1; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const row = splitCsvLine_(lines[i]);
    const icp = String(row[cIcp] || '').trim();
    if (!icp) continue; // trailing/summary rows
    const start = parseAnyDateMode_(row[cStart], dateMode);
    const end   = parseAnyDateMode_(row[cEnd], dateMode);
    if (!start || !end) {
      errors.push({ line: i + 1, reason: 'Bad date(s): ' + row[cStart] + ' / ' + row[cEnd] });
      continue;
    }
    const kWh = parseNumber_(row[cUsage]);
    if (kWh === null) {
      errors.push({ line: i + 1, reason: 'Bad usage: ' + row[cUsage] });
      continue;
    }
    const mult = cMult !== null ? parseNumber_(row[cMult]) : null;
    if (mult !== null && mult !== 1 && !multFlagged) {
      fileFlags.push('Multiplier column present with value(s) != 1 \u2014 usage taken AS-IS (not re-multiplied). ' +
        'Verify one row against a known bill before trusting totals (see parser note).');
      multFlagged = true;
    }
    // Cross-check span vs Days column when present
    if (cDays !== null) {
      const days = parseNumber_(row[cDays]);
      const spanDays = (end - start) / 86400000;
      if (days !== null && Math.abs(spanDays - days) > 1.5) {
        errors.push({ line: i + 1, reason: 'Days column (' + days + ') disagrees with date span (' + Math.round(spanDays) + ')' });
        continue;
      }
    }
    records.push({
      icp: icp,
      register: cReg !== null ? (String(row[cReg] || '').trim() || '(single)') : '(single)',
      meterId: cMeter !== null ? String(row[cMeter] || '').trim() : '',
      periodStart: start, periodEnd: end, kWh: kWh,
      granularity: classifyGranularity_('', start, end),
      readQuality: cStat !== null ? normaliseReadQuality_(row[cStat]) : 'ACTUAL',
      line: i + 1,
    });
  }
  return { header: { format: 'PERIOD_TABLE', version: '', raw: lines[head.index].slice(0, 160) }, records: records, errors: errors, fileFlags: fileFlags };
}

// ---------------- shared numeric/date helpers (Families B/C) ----------------

function parseNumber_(v) {
  const s = String(v === undefined || v === null ? '' : v).replace(/,/g, '').trim();
  if (s === '') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/** ISO (yyyy-mm-dd[ hh:mm[:ss]]) first, then strict dd/mm/yyyy, then flexible day-first. */
function parseAnyDate_(v) {
  return parseAnyDateMode_(v, 'strict');
}

/**
 * Mode-aware variant used by all parsers after a decideDateModeFromSamples_
 * call: ISO is always taken as-is (unambiguous); slash dates are read
 * day-first unless the file-level decision was 'monthfirst'.
 */
function parseAnyDateMode_(v, mode) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0));
  if (mode !== 'monthfirst') {
    const strict = parseStrictDdmmyyyy_(s);
    if (strict) return strict;
  }
  return parseFlexibleDate_(s, mode !== 'monthfirst');
}

/**
 * Collect date-column strings from CSV lines for the file-level
 * date-mode decision. cols = array of column indices; scanning
 * starts after startIdx (the header row).
 */
function collectDateSamples_(lines, startIdx, cols) {
  const samples = [];
  for (let i = startIdx + 1; i < lines.length && samples.length < 4000; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const row = splitCsvLine_(lines[i]);
    for (const c of cols) {
      if (c === null || c === undefined) continue;
      const v = row[c];
      if (v !== undefined && String(v).trim() !== '') samples.push(v);
    }
  }
  return samples;
}