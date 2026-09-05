// =====================================================
// CDP App - Parser: hhr_wide (Family C)
// -----------------------------------------------------
// Wide half-hour matrices: one row per day per register,
// 48 slot columns labelled like "ID12 00AM" ... "ID11 30PM",
// plus ICP, meter number, register configuration (UN24,
// N8|D16), register number, reading date, daily total.
// Variant: a Day/Night band label row ABOVE the slot header
// row \u2014 handled by scanning down for the row that actually
// contains the slot labels.
//
// The daily-total column is used for VALIDATION only, never
// summed with the slots (double-count guard, \u00a76.2): rows
// where |sum(slots) - dailyTotal| > 1% are flagged.
// Empty slot cells emit no record, so gaps surface naturally.
// =====================================================

const HHR_SLOT_RE = /^ID(\d{1,2})\s*(00|30)\s*(AM|PM)$/i;

function hhrWideSniff_(content) {
  return hhrHeader_(content) !== null;
}

function hhrHeader_(content) {
  const lines = String(content || '').split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const cells = splitCsvLine_(lines[i]).map(x => String(x).trim());
    const slotCols = [];
    for (let c = 0; c < cells.length; c++) {
      if (HHR_SLOT_RE.test(cells[c])) slotCols.push(c);
    }
    if (slotCols.length >= 40) {
      return { index: i, cells: cells, slotCols: slotCols };
    }
    if (++seen >= 14) return null; // band-label variant or preceding tabs sit above; scan generously
  }
  return null;
}

/** "ID12 00AM" -> minutes from midnight (ID12 AM = 00:xx, ID1 PM = 13:xx per 12h clock). */
function hhrSlotMinutes_(label) {
  const m = String(label).trim().match(HHR_SLOT_RE);
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'PM') hour += 12;
  return hour * 60 + (m[2] === '30' ? 30 : 0);
}

function hhrWideParse_(content, fileName) {
  const head = hhrHeader_(content);
  if (!head) throw new Error('hhr_wide: slot header row not found in ' + fileName);
  const lower = head.cells.map(normHdr_);
  const col = (kws) => {
    for (let i = 0; i < lower.length; i++) {
      for (const kw of kws) if (lower[i].indexOf(kw) !== -1) return i;
    }
    return null;
  };
  const cIcp    = col(['icp']);
  const cDate   = col(['reading date', 'read date', 'date']);
  const cMeter  = col(['meter']);
  const cConfig = col(['register configuration', 'register config', 'config']);
  const cRegNo  = col(['reg no', 'register no', 'register number']);
  const cTotal  = col(['daily total', 'total']);
  if (cIcp === null || cDate === null) {
    throw new Error('hhr_wide: ICP or reading-date column not found in ' + fileName);
  }

  // Slot columns sorted by their time-of-day, not sheet order, to be safe
  const slots = head.slotCols
    .map(c => ({ col: c, mins: hhrSlotMinutes_(head.cells[c]) }))
    .filter(s => s.mins !== null)
    .sort((a, b) => a.mins - b.mins);

  const lines = String(content).split(/\r?\n/);
  const records = [];
  const errors = [];
  const fileFlags = [];
  let totalMismatches = 0;
  const dateMode = decideDateModeFromSamples_(collectDateSamples_(lines, head.index, [cDate]), fileFlags);

  for (let i = head.index + 1; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const row = splitCsvLine_(lines[i]);
    const icp = String(row[cIcp] || '').trim();
    if (!icp) continue;
    const day = parseAnyDateMode_(row[cDate], dateMode);
    if (!day) {
      errors.push({ line: i + 1, reason: 'Bad reading date: ' + row[cDate] });
      continue;
    }
    const config = cConfig !== null ? String(row[cConfig] || '').trim() : '';
    const regNo = cRegNo !== null ? String(row[cRegNo] || '').trim() : '';
    const register = regNo || config || '(single)';
    let daySum = 0, dayCount = 0;
    for (const s of slots) {
      const v = parseNumber_(row[s.col]);
      if (v === null) continue; // empty slot -> no record -> natural gap
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, s.mins);
      const end = new Date(start.getTime() + 30 * 60000);
      records.push({
        icp: icp, register: register, meterId: cMeter !== null ? String(row[cMeter] || '').trim() : '',
        registerConfig: config,
        periodStart: start, periodEnd: end, kWh: v,
        granularity: 'HH', readQuality: 'ACTUAL', line: i + 1,
      });
      daySum += v; dayCount++;
    }
    // Daily-total cross-check (validation only)
    if (cTotal !== null && dayCount > 0) {
      const total = parseNumber_(row[cTotal]);
      if (total !== null && total > 0 && Math.abs(daySum - total) / total > 0.01) {
        totalMismatches++;
        if (totalMismatches <= 5) {
          errors.push({ line: i + 1, reason: 'Slot sum ' + Math.round(daySum * 100) / 100 + ' != daily total ' + total });
        }
      }
    }
  }
  if (totalMismatches > 5) {
    fileFlags.push((totalMismatches) + ' day row(s) where slot sum != daily total (first 5 listed as row errors)');
  } else if (totalMismatches > 0) {
    fileFlags.push(totalMismatches + ' day row(s) where slot sum != daily total \u2014 see row errors');
  }
  return {
    header: { format: 'HHR_WIDE', version: '', raw: 'Slot columns: ' + slots.length + '; ' + lines[head.index].slice(0, 120) },
    records: records, errors: errors, fileFlags: fileFlags,
  };
}
