// Tobias v0.1.2 · build 2026-11-10.4 — IcpParse.gs
// IcpParse.gs — Tobias: pure ICP extraction from free text. No GAS services; runs under Node for tests.

// 15 chars: 10 digits + 2 letters + 3 hex characters (EA definition). Upper-cased before matching.
var TB_ICP_RE = /^[0-9]{10}[A-Z]{2}[0-9A-F]{3}$/;
// Something that is ICP-shaped but did not validate — worth showing the operator.
var TB_NEAR_MISS_RE = /^[0-9A-Z]{12,18}$/;
// Separators between tokens. Covers commas, semicolons, pipes, colons, equals, quotes, brackets, whitespace.
var TB_TOKEN_SPLIT_RE = /[\s,;|:="'()\[\]{}<>]+/;

var TB_SKIP_SAMPLE_MAX = 40;

/**
 * Extract ICPs from any text (paste, CSV, email body).
 * @param {string} text
 * @return {{icps:string[], duplicates:{icp:string,count:number}[], nearMisses:string[],
 *           skipped:string[], skippedCount:number, tokenCount:number}}
 */
function tbParseIcpText(text) {
  var out = { icps: [], duplicates: [], nearMisses: [], skipped: [], skippedCount: 0, tokenCount: 0 };
  if (text === null || text === undefined) return out;
  var s = String(text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // UTF-8 BOM as a character

  var seen = {};
  var dupCounts = {};
  var nearSeen = {};
  var tokens = s.split(TB_TOKEN_SPLIT_RE);

  for (var i = 0; i < tokens.length; i++) {
    var raw = tokens[i];
    if (!raw) continue;
    var t = tbCleanToken_(raw);
    if (!t) continue;
    out.tokenCount++;
    var up = t.toUpperCase();
    if (TB_ICP_RE.test(up)) {
      if (seen[up]) {
        dupCounts[up] = (dupCounts[up] || 1) + 1;
      } else {
        seen[up] = true;
        out.icps.push(up);
      }
    } else if (TB_NEAR_MISS_RE.test(up) && /[0-9]/.test(up) && /[A-Z]/.test(up)) {
      if (!nearSeen[up]) { nearSeen[up] = true; out.nearMisses.push(t); }
    } else {
      out.skippedCount++;
      if (out.skipped.length < TB_SKIP_SAMPLE_MAX) out.skipped.push(t);
    }
  }

  for (var k in dupCounts) {
    if (Object.prototype.hasOwnProperty.call(dupCounts, k)) out.duplicates.push({ icp: k, count: dupCounts[k] });
  }
  return out;
}

/** Trim punctuation that commonly clings to a token in prose or CSV (full stops, dashes, slashes, hashes). */
function tbCleanToken_(raw) {
  return String(raw).replace(/^[.\-\/#*_]+|[.\-\/#*_]+$/g, '').trim();
}

/** Split a list into batches of n (used by the client too — keep it dependency-free). */
function tbChunk(list, n) {
  var out = [];
  var size = Math.max(1, Math.floor(n) || 1);
  for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
