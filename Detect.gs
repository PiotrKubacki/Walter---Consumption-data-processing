// =====================================================
// CDP App - Format detection registry
// -----------------------------------------------------
// Each parser module registers { format, sniff, parse }.
// Detection sniffs CONTENT, never filename/extension.
// Unknown format => fail loudly (design record \u00a75).
// B1 registers eiep_rows only; period_table and hhr_wide
// arrive in B3, report adapters in B4.
// =====================================================

function parserRegistry_() {
  return [
    { format: 'eiep_rows', sniff: eiepSniff_, parse: { parse: eiepParse_ } },
    // B3: { format: 'period_table', ... }
    // B3: { format: 'hhr_wide', ... }
    // B4: { format: 'report_cranford', ... }
  ];
}

/**
 * Read a file's text content and run it past every sniffer.
 * xlsx/Sheets uploads are handled in B3 (converted read);
 * B1 targets the CSV/text EIEP channel.
 */
function sniffFile_(file) {
  const mime = file.getMimeType();
  let content = null;
  if (mime === MimeType.GOOGLE_SHEETS || /spreadsheetml|ms-excel/.test(mime)) {
    // Spreadsheet-shaped inputs belong to Family B/C/D parsers (B3/B4).
    return { format: 'UNKNOWN', content: null, parser: null };
  }
  content = file.getBlob().getDataAsString();
  for (const p of parserRegistry_()) {
    if (p.sniff(content)) return { format: p.format, content: content, parser: p.parse };
  }
  return { format: 'UNKNOWN', content: content, parser: null };
}
