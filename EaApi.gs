// Tobias v0.1.2 · build 2026-11-10.4 — EaApi.gs
// EaApi.gs — Tobias: calls to the EA ICP connection data API v2 (get by id), parallel per batch with retries.
// Response shapes verified live 2026-11-05: 200 + [record]; 404 + {Messages:[{Code:103,...}]}; 400 + {Messages:[{Code:400,...}]}.

var TB_EA_NOT_FOUND_CODE = 103;

/**
 * Fetch a batch of ICPs in parallel.
 * @param {string[]} icps  Validated, upper-cased, unique.
 * @param {Object} cfg     Output of tbGetConfig().
 * @return {Object[]} one result per ICP, same order:
 *   { icp, http, kind: found|not_found|invalid|error, record|null, message, attempts, fetchedAt }
 */
function tbEaFetchMany_(icps, cfg) {
  var key = PropertiesService.getScriptProperties().getProperty(TB_PROP_API_KEY);
  if (!key) throw new Error('Script Property ' + TB_PROP_API_KEY + ' is not set. Add the EA subscription key in Project Settings → Script Properties.');
  var base = String(cfg.EA_API_BASE_URL || '').trim();
  if (!base) throw new Error('Config row EA_API_BASE_URL is empty.');
  var headerName = String(cfg.EA_API_KEY_HEADER || 'Ocp-Apim-Subscription-Key').trim();
  var maxRetries = tbCfgNum_(cfg, 'EA_MAX_RETRIES', 3, 0);

  var results = icps.map(function (icp) {
    return { icp: icp, http: 0, kind: TB_RESULT.ERROR, record: null, message: '', attempts: 0, fetchedAt: '' };
  });

  var pending = results.slice();
  for (var attempt = 1; attempt <= maxRetries + 1 && pending.length; attempt++) {
    // Exponential backoff: 2 s, 4 s, 8 s … — the registry recovers from an overload burst in seconds, not
    // milliseconds, so retries must land outside it (D14).
    if (attempt > 1) Utilities.sleep(1000 * Math.pow(2, attempt - 1));
    var requests = pending.map(function (r) {
      var headers = {};
      headers[headerName] = key;
      return { url: base + encodeURIComponent(r.icp), method: 'get', headers: headers, muteHttpExceptions: true };
    });
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      // Whole-batch transport failure (quota, network). Mark all pending and retry if allowed.
      pending.forEach(function (r) { r.attempts = attempt; r.message = 'Transport error: ' + e.message; });
      continue;
    }
    var stillPending = [];
    for (var i = 0; i < pending.length; i++) {
      var r = pending[i];
      r.attempts = attempt;
      var verdict = tbEaInterpret_(responses[i]);
      r.http = verdict.http;
      r.kind = verdict.kind;
      r.record = verdict.record;
      r.message = verdict.message;
      r.fetchedAt = new Date().toISOString();
      if (verdict.auth) {
        throw new Error('EA API rejected the key (HTTP ' + verdict.http + '). Check Script Property ' + TB_PROP_API_KEY + '.');
      }
      if (verdict.retry) stillPending.push(r);
    }
    pending = stillPending;
  }
  return results;
}

/**
 * Interpret one HTTPResponse.
 * @return {{http:number, kind:string, record:Object|null, message:string, retry:boolean, auth:boolean}}
 */
function tbEaInterpret_(resp) {
  var http = resp.getResponseCode();
  var text = resp.getContentText() || '';
  var out = { http: http, kind: TB_RESULT.ERROR, record: null, message: '', retry: false, auth: false };

  if (http === 401 || http === 403) { out.auth = true; out.message = 'Key rejected'; return out; }
  if (http === 429 || http >= 500) { out.retry = true; out.message = 'HTTP ' + http; return out; }

  var body = tbEaParseBody_(text);
  if (body === null) { out.retry = true; out.message = 'Unparseable response (HTTP ' + http + ')'; return out; }

  // The API wraps a found record in a one-element array; errors come back as a bare object.
  var rec = Array.isArray(body) ? body[0] : body;
  if (!rec || typeof rec !== 'object') { out.retry = true; out.message = 'Empty response (HTTP ' + http + ')'; return out; }

  // Gateway-style "API is currently unavailable" arrives as {Code:500, Message:...} with HTTP 200.
  if (rec.Code && !rec.ICPIdentifier) {
    var code = Number(rec.Code);
    out.message = String(rec.Message || ('Code ' + code));
    out.retry = code >= 500;
    out.kind = code >= 500 ? TB_RESULT.ERROR : TB_RESULT.INVALID;
    return out;
  }

  var msgs = Array.isArray(rec.Messages) ? rec.Messages : [];
  var msgText = msgs.map(function (m) { return m && m.Message ? String(m.Message) : ''; }).filter(Boolean).join(' | ');
  var hasData = !!(rec.Address || rec.Network || rec.Trader || rec.Metering || rec.Pricing);

  if (http === 200 && hasData) {
    out.kind = TB_RESULT.FOUND;
    out.record = rec;
    out.message = msgText;
    return out;
  }
  if (http === 404 || msgs.some(function (m) { return m && Number(m.Code) === TB_EA_NOT_FOUND_CODE; })) {
    out.kind = TB_RESULT.NOT_FOUND;
    out.message = msgText || 'ICP not found in the registry.';
    return out;
  }
  if (http === 400) {
    out.kind = TB_RESULT.INVALID;
    out.message = msgText || 'Invalid ICP.';
    return out;
  }
  // Anything else: name it, don't guess.
  out.kind = TB_RESULT.ERROR;
  out.message = msgText || ('Unexpected response (HTTP ' + http + ')');
  return out;
}

function tbEaParseBody_(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}
