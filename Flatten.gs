// Tobias v0.1.2 · build 2026-11-10.4 — Flatten.gs
// Flatten.gs — Tobias: pure flattening of an EA ICP connection data v2 record into one row, plus flags and
// the true-TOU verdict. No GAS services; runs under Node for tests. Verdicts are recomputed live on every
// read — the cache only ever stores the raw record.

// Column contract for the EA Cache tab (the Quote App reads this by IMPORTRANGE). Append only — never reorder.
var TB_CACHE_HEADERS = [
  'ICP', 'Fetched At', 'HTTP', 'Result', 'Schema',
  'Status Code', 'Status', 'Address', 'Suburb', 'Town', 'Region', 'Postcode',
  'Network ID', 'Network', 'POC', 'Recon Type', 'Connected Date', 'Generation kW', 'Fuel Type',
  'Price Category', 'Loss Category', 'Chargeable Capacity', 'Installation Details',
  'Trader ID', 'Trader', 'Switch In Progress', 'Profile', 'ANZSIC', 'Unmetered kWh',
  'MEP ID', 'MEP', 'Metering Cat', 'Installation Types', 'Meter Types', 'AMI',
  'Register Codes', 'Periods', 'Cert Expiry', 'Message', 'JSON'
];

var TB_RESULT = { FOUND: 'found', NOT_FOUND: 'not_found', INVALID: 'invalid', ERROR: 'error' };

/**
 * Flatten one EA record.
 * @param {Object} rec  The single object (already unwrapped from the one-element array).
 * @param {Object} ctx  { statusMap:{code:label}, touProfiles:string[], touMinCategory:number, now:Date }
 * @return {{row:Object, flags:string[], tou:{verdict:string, detail:string}}}
 */
function tbFlattenRecord(rec, ctx) {
  ctx = ctx || {};
  var statusMap = ctx.statusMap || {};
  var touProfiles = (ctx.touProfiles && ctx.touProfiles.length) ? ctx.touProfiles : ['HHR', 'HSL'];
  var touMinCat = (typeof ctx.touMinCategory === 'number' && !isNaN(ctx.touMinCategory)) ? ctx.touMinCategory : 3;
  var now = ctx.now instanceof Date ? ctx.now : new Date();

  var flags = [];
  var a = rec.Address || {};
  var n = rec.Network || {};
  var p = rec.Pricing || {};
  var t = rec.Trader || {};
  var m = rec.Metering || {};

  // --- Status -------------------------------------------------------------
  var statusCode = (rec.ICPStatus === null || rec.ICPStatus === undefined) ? '' : String(rec.ICPStatus);
  var statusLabel = statusMap[statusCode];
  if (!statusLabel) {
    statusLabel = statusCode === '' ? '' : 'Code ' + statusCode;
    if (statusCode !== '') flags.push('Unmapped status code ' + statusCode + ' — add it to the Status Codes tab');
  } else if (String(statusLabel).toLowerCase() !== 'active') {
    flags.push('Status: ' + statusLabel);
  }

  // --- Address ------------------------------------------------------------
  var postcode = tbPadPostcode_(a.PhysicalAddressPostCode);
  var streetLine = tbJoinNonEmpty_([
    (a.PhysicalAddressUnit ? String(a.PhysicalAddressUnit) + '/' : '') + tbStr_(a.PhysicalAddressNumber),
    tbStr_(a.PhysicalAddressStreet)
  ], ' ');
  var address = tbJoinNonEmpty_([
    tbStr_(a.PropertyNameOrDescription),
    streetLine,
    tbStr_(a.PhysicalAddressSuburb),
    tbStr_(a.PhysicalAddressTown),
    tbJoinNonEmpty_([tbStr_(a.PhysicalAddressRegion), postcode], ' ')
  ], ', ');

  // --- Network / generation ----------------------------------------------
  var genKw = tbNum_(n.GenerationCapacity);
  var fuel = tbStr_(n.FuelType);
  if (genKw > 0 || fuel) flags.push('Embedded generation' + (genKw > 0 ? ' ' + genKw + ' kW' : '') + (fuel ? ' (' + fuel + ')' : ''));

  // --- Trader -------------------------------------------------------------
  if (t.TraderSwitchInProgress === true) flags.push('Trader switch in progress');
  var unmetered = tbStr_(t.DailyUnmeteredkWh);
  if (unmetered && tbNum_(unmetered) > 0) flags.push('Unmetered load ' + unmetered + ' kWh/day');
  var profile = tbStr_(t.ProfileCode);

  // --- Metering (installations → components → channels) ------------------
  var installs = Array.isArray(m.InstallationInformation) ? m.InstallationInformation : [];
  var maxCat = null, instTypes = [], meterTypes = [], regCodes = [], periods = [], certMin = '';
  var ami = null, importChannel = false, compCount = 0;
  for (var i = 0; i < installs.length; i++) {
    var inst = installs[i] || {};
    var cat = tbNum_(inst.MeteringInstallationCategory);
    if (!isNaN(cat) && (maxCat === null || cat > maxCat)) maxCat = cat;
    tbPushUniq_(instTypes, tbStr_(inst.MeteringInstallationType));
    var exp = tbStr_(inst.CertificationExpiryDate);
    if (exp && (!certMin || exp < certMin)) certMin = exp;
    var comps = Array.isArray(inst.ComponentInformation) ? inst.ComponentInformation : [];
    for (var j = 0; j < comps.length; j++) {
      var comp = comps[j] || {};
      compCount++;
      tbPushUniq_(meterTypes, tbStr_(comp.MeterType));
      if (comp.AMIFlag === true) ami = true; else if (comp.AMIFlag === false && ami === null) ami = false;
      var chans = Array.isArray(comp.ChannelInformation) ? comp.ChannelInformation : [];
      for (var k = 0; k < chans.length; k++) {
        var ch = chans[k] || {};
        var rc = tbStr_(ch.RegisterContentCode);
        if (rc) regCodes.push(rc);
        tbPushUniq_(periods, tbStr_(ch.PeriodOfAvailability));
        if (tbStr_(ch.EnergyFlowDirection).toUpperCase() === 'I') importChannel = true;
      }
    }
  }
  if (installs.length > 1) flags.push(installs.length + ' metering installations');
  if (installs.length === 0) flags.push('No metering installation on record');
  if (importChannel) flags.push('Generation / import channel present');
  if (certMin && certMin < tbIsoDate_(now)) flags.push('Metering certification expired ' + certMin);

  // --- TOU verdict (D5) ---------------------------------------------------
  var profileCodes = profile ? profile.toUpperCase().split(/[\s,]+/) : [];
  var isTou = false;
  for (var q = 0; q < profileCodes.length; q++) {
    if (touProfiles.indexOf(profileCodes[q]) >= 0) isTou = true;
  }
  // TOU = half-hour reconciled; NHH = non-half-hour (profiled) — the industry terms (D5, wording D16).
  var touVerdict = profile ? (isTou ? 'TOU' : 'NHH') : 'Unknown';
  var touDetail = tbJoinNonEmpty_([
    profile || 'no profile',
    maxCat === null ? '' : 'Cat ' + maxCat,
    ami === true ? 'AMI' : ''
  ], ' · ');
  if (!isTou && maxCat !== null && maxCat >= touMinCat) flags.push('CT metering (Cat ' + maxCat + ') but profiled ' + profile + ' — check');

  // --- API messages on a found record ------------------------------------
  var message = '';
  if (Array.isArray(rec.Messages) && rec.Messages.length) {
    message = rec.Messages.map(function (x) { return (x && x.Message) ? String(x.Message) : ''; }).filter(Boolean).join(' | ');
    if (message) flags.push('API message: ' + message);
  }

  var row = {
    icp: tbStr_(rec.ICPIdentifier),
    statusCode: statusCode,
    status: statusLabel,
    address: address,
    suburb: tbStr_(a.PhysicalAddressSuburb),
    town: tbStr_(a.PhysicalAddressTown),
    region: tbStr_(a.PhysicalAddressRegion),
    postcode: postcode,
    networkId: tbStr_(n.NetworkParticipantID),
    network: tbStr_(n.NetworkParticipantName),
    poc: tbStr_(n.POC),
    reconType: tbStr_(n.ReconciliationType),
    connectedDate: tbStr_(n.InitialElectricallyConnectedDate),
    generationKw: isNaN(genKw) ? '' : genKw,
    fuelType: fuel,
    priceCategory: tbStr_(p.DistributorPriceCategoryCode),
    lossCategory: tbStr_(p.DistributorLossCategoryCode),
    chargeableCapacity: isNaN(tbNum_(p.ChargeableCapacity)) ? '' : tbNum_(p.ChargeableCapacity),
    installationDetails: tbStr_(p.DistributorInstallationDetails),
    traderId: tbStr_(t.TraderParticipantID),
    trader: tbStr_(t.TraderParticipantName),
    switchInProgress: t.TraderSwitchInProgress === true ? 'Y' : (t.TraderSwitchInProgress === false ? 'N' : ''),
    profile: profile,
    anzsic: tbStr_(t.ANZSICcode),
    unmeteredKwh: unmetered,
    mepId: tbStr_(m.MeteringEquipmentProviderParticipantID),
    mep: tbStr_(m.MeteringEquipmentProviderParticipantName),
    meteringCat: maxCat === null ? '' : maxCat,
    installationTypes: instTypes.join(', '),
    meterTypes: meterTypes.join(', '),
    ami: ami === true ? 'Y' : (ami === false ? 'N' : ''),
    registerCodes: regCodes.join(', '),
    periods: periods.join(', '),
    certExpiry: certMin,
    message: message
  };

  return { row: row, flags: flags, tou: { verdict: touVerdict, detail: touDetail } };
}

/**
 * Build the EA Cache sheet row (array aligned with TB_CACHE_HEADERS) for a lookup result.
 * @param {Object} res  { icp, http, kind, record|null, message, fetchedAt(ISO string) }
 * @param {Object|null} flat  Output of tbFlattenRecord, or null when there is no record.
 */
function tbCacheRowFromResult(res, flat, schema) {
  var r = (flat && flat.row) ? flat.row : {};
  var json = res.record ? JSON.stringify(res.record) : '';
  return [
    res.icp, res.fetchedAt, res.http, res.kind, schema,
    r.statusCode || '', r.status || '', r.address || '', r.suburb || '', r.town || '', r.region || '', r.postcode || '',
    r.networkId || '', r.network || '', r.poc || '', r.reconType || '', r.connectedDate || '', r.generationKw === undefined ? '' : r.generationKw, r.fuelType || '',
    r.priceCategory || '', r.lossCategory || '', r.chargeableCapacity === undefined ? '' : r.chargeableCapacity, r.installationDetails || '',
    r.traderId || '', r.trader || '', r.switchInProgress || '', r.profile || '', r.anzsic || '', r.unmeteredKwh || '',
    r.mepId || '', r.mep || '', r.meteringCat === undefined ? '' : r.meteringCat, r.installationTypes || '', r.meterTypes || '', r.ami || '',
    r.registerCodes || '', r.periods || '', r.certExpiry || '', res.message || '', json
  ];
}

// --- helpers ---------------------------------------------------------------

function tbStr_(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function tbNum_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  var x = Number(v);
  return isNaN(x) ? NaN : x;
}

function tbPadPostcode_(v) {
  var s = tbStr_(v);
  if (!s || s === '0') return '';
  if (/^[0-9]{1,3}$/.test(s)) { while (s.length < 4) s = '0' + s; }
  return s;
}

function tbJoinNonEmpty_(parts, sep) {
  var out = [];
  for (var i = 0; i < parts.length; i++) { if (parts[i]) out.push(parts[i]); }
  return out.join(sep);
}

function tbPushUniq_(arr, v) {
  if (v && arr.indexOf(v) < 0) arr.push(v);
}

function tbIsoDate_(d) {
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}
