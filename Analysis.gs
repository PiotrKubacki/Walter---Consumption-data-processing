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

  // ---- 1. Layer selection ----
  const byLayer = { HH: [], DAILY: [], PERIOD: [] };
  for (const r of recs) byLayer[r.granularity].push(r);
  const coverage = {};
  for (const g of LAYER_ORDER) coverage[g] = sumDays_(byLayer[g]);
  let layer = LAYER_ORDER[0];
  for (const g of LAYER_ORDER) {
    if (coverage[g] > coverage[layer]) layer = g;
  }
  const flags = [];
  const crossChecks = [];
  for (const g of LAYER_ORDER) {
    if (g === layer || coverage[g] <= 0) continue;
    // Material alternative layer (> 1 day): cross-validate against chosen layer
    if (coverage[g] > 1) {
      const chosenRate = sumKwhA_(byLayer[layer]) / Math.max(coverage[layer], 0.001);
      const otherRate  = sumKwhA_(byLayer[g]) / coverage[g];
      const diffPct = chosenRate > 0 ? Math.abs(otherRate - chosenRate) / chosenRate * 100 : 0;
      crossChecks.push({ layer: g, days: round2a_(coverage[g]), kWh: round2a_(sumKwhA_(byLayer[g])), diffPct: Math.round(diffPct) });
      if (diffPct > 10) {
        flags.push('Cross-layer mismatch: ' + g + ' daily rate differs from ' + layer + ' by ' + Math.round(diffPct) + '%');
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
  };
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