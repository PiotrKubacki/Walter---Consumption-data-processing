// =====================================================
// CDP App - Parser: interval_long (Family C-long)
// -----------------------------------------------------
// Long-format interval data: ONE ROW PER INTERVAL.
// Two observed header shapes, one parser:
//  A) Genesis: ICP, Meter, Element, Reading Date,
//     Interval Number, Consumption Value, ReadingType
//     (interval length derived from max interval/day:
//      48 -> 30 min, 24 -> 60 min, 96 -> 15 min)
//  B) Papillon/TOU: ICP, Date, Time, Consumption kWh,
//     [Apparent kVAh, Reactive kVArh ignored]
//     (interval length = smallest positive time step)
// ReadingType A -> ACTUAL, E -> ESTIMATE when present.
// =====================================================

function intervalLongSniff_(content) {
  return intervalLongHeader_(content) !== null;
}

function intervalLongHeader_(content) {
  const lines = String(content || '').split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const f = splitCsvLine_(lines[i]).map(normHdr_);
    const has = (kw) => f.some(c => c.indexOf(kw) !== -1);
    const hasExact = (kw) => f.some(c => c === kw);
    if (has('icp') && has('consumption') &&
        (has('interval number') || (hasExact('time') && (hasExact('date') || has('reading date'))))) {
      return { index: i, fields: f };
    }
    if (++seen >= 14) return null;
  }
  return null;
}

function intervalLongParse_(content, fileName) {
  const head = intervalLongHeader_(content);
  if (!head) throw new Error('interval_long: header row not found in ' + fileName);
  const f = head.fields;
  const col = (matcher, required, label) => {
    for (let i = 0; i < f.length; i++) if (matcher(f[i])) return i;
    if (required) throw new Error('interval_long: required column not found (' + label + ') in ' + fileName);
    return null;
  };
  const cIcp   = col(c => c === 'icp' || c.indexOf('icp') === 0, true, 'icp');
  const cDate  = col(c => c === 'date' || c.indexOf('reading date') !== -1, true, 'date');
  const cCons  = col(c => c.indexOf('consumption') !== -1, true, 'consumption');
  const cIntNo = col(c => c.indexOf('interval number') !== -1);
  const cTime  = col(c => c === 'time');
  const cType  = col(c => c.indexOf('readingtype') !== -1 || c.indexOf('reading type') !== -1 || c === 'status');
  const cMeter = col(c => c.indexOf('meter') !== -1 || c.indexOf('serial') !== -1);
  const cElem  = col(c => c.indexOf('element') !== -1 || c.indexOf('register') !== -1);
  if (cIntNo === null && cTime === null) throw new Error('interval_long: neither interval-number nor time column found in ' + fileName);

  const lines = String(content).split(/\r?\n/);
  const raws = [];
  const errors = [];
  const fileFlags = [];
  const dateMode = decideDateModeFromSamples_(collectDateSamples_(lines, head.index, [cDate]), fileFlags);

  for (let i = head.index + 1; i < lines.length; i++) {
    if (!lines[i] || lines[i].trim() === '') continue;
    const row = splitCsvLine_(lines[i]);
    const icp = String(row[cIcp] || '').trim();
    if (!icp) continue;
    const day = parseAnyDateMode_(row[cDate], dateMode);
    if (!day) { errors.push({ line: i + 1, reason: 'Bad date: ' + row[cDate] }); continue; }
    const kWh = parseNumber_(row[cCons]);
    if (kWh === null) { errors.push({ line: i + 1, reason: 'Bad consumption: ' + row[cCons] }); continue; }
    let startMins = null, intervalNo = null;
    if (cIntNo !== null) {
      intervalNo = parseNumber_(row[cIntNo]);
      if (intervalNo === null || intervalNo < 1) { errors.push({ line: i + 1, reason: 'Bad interval number: ' + row[cIntNo] }); continue; }
    } else {
      const tm = String(row[cTime] || '').trim().match(/^(\d{1,2}):(\d{2})/);
      if (!tm) { errors.push({ line: i + 1, reason: 'Bad time: ' + row[cTime] }); continue; }
      startMins = (+tm[1]) * 60 + (+tm[2]);
    }
    raws.push({
      line: i + 1, icp: icp, day: day, kWh: kWh, intervalNo: intervalNo, startMins: startMins,
      register: cElem !== null ? (String(row[cElem] || '').trim() || '(single)') : '(single)',
      meterId: cMeter !== null ? String(row[cMeter] || '').trim() : '',
      readQuality: cType !== null ? normaliseReadQuality_(row[cType]) : 'ACTUAL',
    });
  }

  // Interval length
  let slotMins;
  if (cIntNo !== null) {
    let maxN = 0;
    for (const r of raws) if (r.intervalNo > maxN) maxN = r.intervalNo;
    if (maxN >= 90) slotMins = 15;
    else if (maxN >= 40) slotMins = 30;
    else if (maxN >= 20) slotMins = 60;
    else { slotMins = 30; fileFlags.push('Could not derive interval length (max interval number ' + maxN + ') \u2014 assumed 30 min'); }
    if (slotMins !== 30) fileFlags.push('Interval length derived as ' + slotMins + ' min (max interval number ' + maxN + ')');
  } else {
    // Smallest positive step between times on the same ICP-day
    slotMins = 30;
    const seen = {};
    let best = null;
    for (const r of raws) {
      const k = r.icp + '|' + r.day.getTime();
      if (k in seen) {
        const step = Math.abs(r.startMins - seen[k]);
        if (step > 0 && (best === null || step < best)) best = step;
      }
      seen[k] = r.startMins;
    }
    if (best !== null && [15, 30, 60].indexOf(best) !== -1) slotMins = best;
    if (slotMins !== 30) fileFlags.push('Interval length derived as ' + slotMins + ' min from time steps');
  }

  const records = raws.map(r => {
    const startM = r.intervalNo !== null ? (r.intervalNo - 1) * slotMins : r.startMins;
    const start = new Date(r.day.getFullYear(), r.day.getMonth(), r.day.getDate(), 0, startM);
    return {
      icp: r.icp, register: r.register, meterId: r.meterId,
      periodStart: start, periodEnd: new Date(start.getTime() + slotMins * 60000),
      kWh: r.kWh, granularity: 'HH', readQuality: r.readQuality, line: r.line,
    };
  });

  return {
    header: { format: 'INTERVAL_LONG', version: '', raw: lines[head.index].slice(0, 160) },
    records: records, errors: errors, fileFlags: fileFlags,
  };
}