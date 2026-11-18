// =====================================================
// CDP App - Analysis engine (B2)
// -----------------------------------------------------
// Works only on normalised records (design record \u00a76).
// Per ICP-register group:
//   1. Layer selection: totals use ONE layer \u2014 the one with
//      the greatest coverage (ties broken finer-first).
//      Other material layers cross-validate, never sum.
//   2. Analysis window anchored on ACTUAL reads (\u00a76.3):
//      earliest actual -> latest actual. Estimates and
//      corrections inside the window net out correctly.
//   3. AVM = kWh / days * 30.4375 over coverage, not
//      calendar span (\u00a76.4) \u2014 gaps reduce coverage.
//   4. Reliability grade measures coverage and read quality
//      ONLY, never magnitude. Near-zero is informational.
// =====================================================

const LAYER_ORDER = ['HH', 'DAILY', 'PERIOD']; // finer first (tie-break)
const GRADE = { GOOD: 'GOOD', CHECK: 'CHECK', UNRELIABLE: 'UNRELIABLE', NO_DATA: 'NO_DATA' };
const GRADE_EMOJI = { GOOD: '\uD83D\uDD0B', CHECK: '\u26A0\uFE0F', UNRELIABLE: '\uD83E\uDEAB', NO_DATA: '\uD83D\uDD6F\uFE0F' };

/**
 * Analyse one ICP-register group of normalised records.
 * cfg needs: min_window_days, max_estimate_share, max_gap_share, near_zero_avm_kwh
 * Returns the full analysis result for verify display and the Betty writer.
 */
function analyseGroup_(recs, cfg) {
  if (!recs || !recs.length) {
    return { grade: GRADE.NO_DATA, flags: ['No records'], avm: null };
  }

  // ---- 0. Duplicates and channels (v2.30) ----
  // Meridian ICPCONS files carry two half-hourly rows per period on a
  // two-channel meter (same register code, different kWh). Summing their
  // kWh is right; counting their days twice halved the AVM. Identical
  // rows (same period AND same kWh) are duplicates and are dropped.
  const merged = mergeChannels_(recs);
  recs = merged.recs;
  const flags = merged.flags;

  // ---- 1. Layer selection ----
  const byLayer = { HH: [], DAILY: [], PERIOD: [] };
  for (const r of recs) byLayer[r.granularity].push(r);
  const coverage = {};
  for (const g of LAYER_ORDER) coverage[g] = sumDays_(byLayer[g]);
  let layer = LAYER_ORDER[0];
  for (const g of LAYER_ORDER) {
    if (coverage[g] > coverage[layer]) layer = g;
  }
  const crossChecks = [];

  // Overlap check on the CHOSEN layer first: overlapping rows in the
  // data the totals are built from distort kWh and coverage together.
  // (Channels within one file were merged above, so what is left here
  // is a real problem: restated summaries, or two files that disagree.)
  const chosenUnion = unionDays_(byLayer[layer]);
  let overlapInTotals = false;
  if (chosenUnion > 0 && coverage[layer] / chosenUnion > 1.2) {
    overlapInTotals = true;
    flags.push('OVERLAPPING ROWS IN TOTALS: the ' + layer + ' data used for the AVM contains overlapping ' +
      'periods (' + round2a_(coverage[layer]) + ' row-days across only ' + round2a_(chosenUnion) +
      ' distinct days) — the AVM is NOT reliable. Inspect the file; this usually means summary/total ' +
      'rows mixed into the detail' + (merged.crossFile ? ', or two files that give different figures for the same periods' : '') + '.');
  }

  for (const g of LAYER_ORDER) {
    if (g === layer || coverage[g] <= 0) continue;
    // Material alternative layer: cross-validate against the chosen layer.
    // v2.30: material = a week or more AND at least 5% of the chosen layer -
    // a couple of odd partial-day rows at the ends of a file are not a source.
    if (coverage[g] >= 7 && coverage[g] >= 0.05 * coverage[layer]) {
      const gUnion = unionDays_(byLayer[g]);
      const overlapFactor = gUnion > 0 ? coverage[g] / gUnion : 1;
      const chosenRate = sumKwhA_(byLayer[layer]) / Math.max(coverage[layer], 0.001);
      const otherRate  = sumKwhA_(byLayer[g]) / coverage[g];
      const diffPct = chosenRate > 0 ? Math.abs(otherRate - chosenRate) / chosenRate * 100 : 0;
      crossChecks.push({ layer: g, days: round2a_(coverage[g]), kWh: round2a_(sumKwhA_(byLayer[g])), diffPct: Math.round(diffPct) });
      if (overlapFactor > 1.2) {
        // Overlapping rows = summary/total rows restating the same span.
        // Structurally not comparable, and not used for totals anyway:
        // an informational note, not an action demand.
        flags.push(g + ' rows in ' + sourceFilesA_(byLayer[g]) + ' are overlapping summaries (' +
          round2a_(coverage[g]) + ' row-days across ' + round2a_(gUnion) + ' distinct days — ' +
          'summary/total rows restating the same span). Ignored; the AVM uses the ' + layer + ' data.');
      } else if (diffPct > 10) {
        // Wording: "kWh/day", never "daily rate" (a daily rate is a
        // per-day CHARGE on a bill; this is average daily consumption).
        flags.push('CHECK SOURCES: two kinds of data for this register disagree — ' +
          g + ' data (' + sourceFilesA_(byLayer[g]) + ') averages ' + round2a_(otherRate) + ' kWh/day, ' +
          layer + ' data (' + sourceFilesA_(byLayer[layer]) + ') averages ' + round2a_(chosenRate) + ' kWh/day (' +
          Math.round(diffPct) + '% apart). The AVM uses the ' + layer + ' data only — ' +
          'work out which source is wrong before using this figure.');
      }
    } else {
      flags.push('Minor ' + g + ' layer ignored for totals (' + round2a_(coverage[g]) + ' days)');
    }
  }
  const chosen = byLayer[layer];

  // ---- 2. Analysis window anchored on actuals ----
  const actuals = chosen.filter(r => r.readQuality === 'ACTUAL');
  let windowStart, windowEnd, anchored;
  if (actuals.length >= 2 || (actuals.length === 1 && chosen.length === 1)) {
    windowStart = minStart_(actuals);
    windowEnd = maxEnd_(actuals);
    anchored = true;
  } else {
    // No usable actual anchors: analyse the full range, grade caps at UNRELIABLE
    windowStart = minStart_(chosen);
    windowEnd = maxEnd_(chosen);
    anchored = false;
    flags.push(actuals.length === 0
      ? 'No actual reads \u2014 window unanchored (all estimates)'
      : 'Only one actual read \u2014 window cannot be anchored on actuals');
  }

  const inWindow = chosen.filter(r => r.periodStart >= windowStart && r.periodEnd <= windowEnd);
  const daysCovered = sumDays_(inWindow);
  const windowDays = (windowEnd - windowStart) / 86400000;
  const estDays = sumDays_(inWindow.filter(r => r.readQuality === 'ESTIMATE'));
  const estShare = daysCovered > 0 ? estDays / daysCovered : 0;
  const gapDays = Math.max(0, windowDays - daysCovered);
  const gapShare = windowDays > 0 ? gapDays / windowDays : 0;
  const totalKwh = sumKwhA_(inWindow);

  // ---- 3. AVM ----
  const avm = daysCovered > 0 ? totalKwh / daysCovered * (365.25 / 12) : null;

  // ---- 4. Grade (coverage & quality only, never magnitude) ----
  const breaches = [];
  if (windowDays < cfg.min_window_days) breaches.push('window ' + Math.round(windowDays) + 'd < ' + cfg.min_window_days + 'd');
  if (estShare > cfg.max_estimate_share) breaches.push('estimate share ' + Math.round(estShare * 100) + '%');
  if (gapShare > cfg.max_gap_share) breaches.push('gaps ' + Math.round(gapShare * 100) + '% of window');
  if (overlapInTotals) breaches.push('overlapping rows in the totals'); // v2.30: an unreliable AVM can never grade GOOD
  let grade;
  if (!anchored) grade = GRADE.UNRELIABLE;
  else if (breaches.length === 0) grade = GRADE.GOOD;
  else if (breaches.length === 1) grade = GRADE.CHECK;
  else grade = GRADE.UNRELIABLE;

  if (avm !== null && avm < cfg.near_zero_avm_kwh) {
    flags.push('Near-zero usage (' + Math.round(avm) + ' kWh/month) \u2014 possible vacant site; informational only');
  }

  return {
    layer: layer,
    coverage: coverage,
    crossChecks: crossChecks,
    windowFrom: windowStart, windowTo: windowEnd,
    windowDays: round2a_(windowDays),
    daysCovered: round2a_(daysCovered),
    estimateShare: round2a_(estShare),
    gapShare: round2a_(gapShare),
    totalKwh: round2a_(totalKwh),
    avm: avm === null ? null : Math.round(avm),
    grade: grade,
    breaches: breaches,
    flags: flags,
    channels: merged.maxChannels,
    duplicatesRemoved: merged.duplicates,
  };
}

/**
 * v2.30: rows of one register that share a period.
 * Per source file: when a file gives several rows for the same period,
 * they are CHANNELS of one meter (kWh summed, read quality the worst)
 * unless their kWh are identical in practically every such period - then
 * the file simply states the rows twice and the extras are dropped.
 * (Two real channels agree now and then - both 0.00 overnight - so a
 * single period with equal values proves nothing; the whole register
 * decides.) Across files: identical rows for a period are duplicates
 * (dropped); different ones are a conflict left for the overlap check.
 */
function mergeChannels_(recs) {
  const keyOf = (r) => r.granularity + '|' + Number(r.periodStart) + '|' + Number(r.periodEnd);
  const kwhKey = (r) => String(Math.round(r.kWh * 1000000));
  const quality = (list) => {
    if (list.some(r => r.readQuality === 'ESTIMATE')) return 'ESTIMATE';
    if (list.every(r => r.readQuality === 'ACTUAL')) return 'ACTUAL';
    return list.map(r => r.readQuality).filter(q => q !== 'ACTUAL')[0] || 'UNKNOWN';
  };
  // 1. per file, per period
  const byFile = {};
  const fileOrder = [];
  for (const r of recs) {
    const f = String(r.sourceFile || '');
    if (!byFile[f]) { byFile[f] = { keys: {}, order: [] }; fileOrder.push(f); }
    const k = keyOf(r);
    if (!byFile[f].keys[k]) { byFile[f].keys[k] = []; byFile[f].order.push(k); }
    byFile[f].keys[k].push(r);
  }
  let duplicates = 0, channels = 1, oddDoubles = 0;
  const perFile = {}; // file -> { key -> one record }
  for (const f of fileOrder) {
    const g = byFile[f];
    let multi = 0, allEqual = 0;
    const countOf = {};
    for (const k of g.order) {
      const list = g.keys[k];
      if (list.length < 2) continue;
      multi++;
      countOf[list.length] = (countOf[list.length] || 0) + 1;
      const first = kwhKey(list[0]);
      if (list.every(r => kwhKey(r) === first)) allEqual++;
    }
    // A restated file repeats EVERYTHING; a handful of doubled periods (a
    // DST fall-back hour) is summed like any other channel.
    const restated = multi >= 10 && allEqual / multi >= 0.98;
    // channels when most periods come in multiples; a few doubled periods
    // (a daylight-saving fall-back hour: two real half-hours with one clock
    // label) are left exactly as they are - two rows, two half-hours of time
    let isChannels = false;
    if (!restated && multi) {
      if (multi >= 0.1 * g.order.length) {
        isChannels = true;
        let best = 0;
        for (const n of Object.keys(countOf)) if (countOf[n] > best) { best = countOf[n]; channels = Math.max(channels, Number(n)); }
      } else oddDoubles += multi;
    }
    perFile[f] = {};
    for (const k of g.order) {
      const list = g.keys[k];
      if (list.length === 1) { perFile[f][k] = list[0]; continue; }
      if (restated) { duplicates += list.length - 1; perFile[f][k] = list[0]; continue; }
      if (!isChannels) { perFile[f][k] = list; continue; } // kept as separate rows
      const one = {};
      for (const key of Object.keys(list[0])) one[key] = list[0][key];
      one.kWh = list.reduce((a, r) => a + r.kWh, 0);
      one.readQuality = quality(list);
      one.channels = list.length;
      perFile[f][k] = one;
    }
  }
  // 2. across files
  const out = [];
  let crossFile = false;
  const each = (v, fn) => { if (Array.isArray(v)) { for (const r of v) fn(r); } else fn(v); };
  if (fileOrder.length === 1) {
    const f = fileOrder[0];
    for (const k of byFile[f].order) each(perFile[f][k], (r) => out.push(r));
  } else {
    const seenKey = {};
    for (const f of fileOrder) {
      for (const k of byFile[f].order) {
        each(perFile[f][k], (r) => {
          if (!seenKey[k]) { seenKey[k] = [r]; out.push(r); return; }
          if (seenKey[k].some(x => kwhKey(x) === kwhKey(r))) { duplicates++; return; } // same figure from another file
          seenKey[k].push(r); out.push(r); crossFile = true;
        });
      }
    }
  }
  const flags = [];
  if (duplicates) flags.push(duplicates + ' duplicate row(s) removed (the same period and kWh stated twice)');
  if (channels > 1) flags.push(channels + ' channels on this register (rows with the same period and different kWh in the same file) — kWh summed, days counted once; informational only');
  else if (oddDoubles) flags.push(oddDoubles + ' period(s) appear twice (a daylight-saving hour, usually) — both counted; informational only');
  return { recs: out, flags: flags, duplicates: duplicates, maxChannels: channels, crossFile: crossFile };
}

function sumDays_(recs) {
  let s = 0;
  for (const r of recs) s += (r.periodEnd - r.periodStart) / 86400000;
  return s;
}
function sumKwhA_(recs) { let s = 0; for (const r of recs) s += r.kWh; return s; }
function minStart_(recs) { return recs.reduce((a, b) => a.periodStart < b.periodStart ? a : b).periodStart; }
function maxEnd_(recs) { return recs.reduce((a, b) => a.periodEnd > b.periodEnd ? a : b).periodEnd; }
function round2a_(n) { return Math.round(n * 100) / 100; }

/** Unique source-file names of a record set (for cross-check flags). */
function sourceFilesA_(records) {
  const seen = {};
  for (const r of records) if (r.sourceFile) seen[r.sourceFile] = true;
  const names = Object.keys(seen);
  return names.length ? names.join(', ') : 'same file';
}

/** Distinct days covered by a record set (overlaps merged). */
function unionDays_(recs) {
  if (!recs.length) return 0;
  const iv = recs.map(r => [r.periodStart.getTime(), r.periodEnd.getTime()]).sort((a, b) => a[0] - b[0]);
  let total = 0, curS = iv[0][0], curE = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    const s = iv[i][0], e = iv[i][1];
    if (s <= curE) { if (e > curE) curE = e; }
    else { total += curE - curS; curS = s; curE = e; }
  }
  total += curE - curS;
  return total / 86400000;
}
