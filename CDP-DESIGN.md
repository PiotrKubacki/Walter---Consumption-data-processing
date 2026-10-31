# Consumption Data Processing (CDP) App — Design Record

Status: v1.3 — production; **full chain verified** (ingest → parse → analyse → Betty import live-fire PASSED, Sep 2026)
Date: 5 September 2026 (supersedes v1, 30 Aug; keep this file as CDP-DESIGN.md — one canonical path)
Author: Peter (with Claude)
Apps Script project: CONSUMP_DATA_DEV · build stamp convention: `CDP_BUILD` in Main.gs, shown in the header (currently 2026-09-05.1)
Backing spreadsheet: "CDP App Data" — 1olmhVUeNXARRk8oflXBn6521FJCtZaDa7R3Xxr3UYT8
Companion app: **CDP Mail Ingest** (separate project, runs as accounts@theutilitycompany.net)

---

## 1. Purpose

Replace manual processing of retailer consumption data with an operator web app that
parses consumption files (electricity and gas) in every format received, normalises
them to one internal model, calculates AVM per ICP-register with reliability grading,
computes time/date profiles from interval data, and fills the Betty "Bulk Analysis"
template (Current rows only) for import back into Betty. A companion ingest app pulls
attachments from the accounts@ mailbox into the upload folder automatically.

Operators: Peter, Yuka (also /dev); Miho via /exec. Legacy Days/Total/AVM
side-calculations retired.

## 2. Scope

**Built and verified:** mailbox ingestion (manual + continuous); detection/parsing for
EIGHT format families; AVM engine with windows and grading; time profiles (seasonal,
Day/Night, weekday/weekend, 48-slot); full batch UI (selection, chunked pause/stop
analysis, sorting, inspection copies with lifecycle); Betty round-trip **live-fire
tested**; Run/Flags/Ingest logging; archive-to-Processed.

**Out of scope:** EIEP13C requests (manual); Betty API automation (none exists);
gas registry queries (no API); PDF parsing (PDFs are ingested and sit as UNKNOWN).

## 3. The pipeline (as verified)

Email → **Ingest** (accounts@; allowlist, junk filter, zip unpack, name+size dedupe,
CDP/processed label, Ingest Log) → CDP Upload → **Detect** (eight sniffing families,
fail-loudly UNKNOWN) → **Parse** (normalised records, per-file cache) → **Analyse**
(chunked, pausable; grouping per ICP-register across files with duplicate flags;
lookups; AVM + grading; time profiles) → **Betty fill** (Current rows, ICP match +
Customer ID cross-check, Register Map translation validated against the template's
own vocabulary, whole-kWh Monthly Consumption into matching/empty slots only, surplus
Bulk Analysis rows trimmed, xlsx export, logs) → operator imports into Betty.

Betty writer detail unchanged from v1 §3 (Current-only, empty-slot naming, vocabulary
gaps accumulate for Cortex, trim finding, no CSV path, betty_url_pattern links).
**Live-fire test passed Sep 2026 — B2 closed.**

## 4. Architecture

- Single Apps Script project; **git repo is sole truth**; deliveries arrive as
  version-stamped zips → repo → `clasp push` (mirrors; removes strays) → Manage
  deployments → New version. `clasp status` is the gate that catches naming drift.
- Build stamp: `CDP_BUILD` rendered in the header (template-guarded so a mismatched
  pair degrades to "build ?" instead of crashing). Bumped every delivery; answers
  "which code am I looking at" in one glance and invalidates derived caches.
- One hardcoded pointer (Script Property BACKING_SHEET_ID); all else in the Config
  tab. Backing tabs created additively/idempotently by bootstrapBackingSheet().
- Drive: CDP Upload / Processed / Output; `.cdp-cache` inside Upload holds THREE
  cache kinds, each versioned by the code that derives it:
  - extracted text `<id>_<updated>_v3.txt` (v3 = newline-collapsed cells)
  - normalised records `<id>_<updated>_<CDP_BUILD>_recs1.json` (build-keyed: parser
    fixes take effect on push; three staleness incidents made this rule absolute)
  - INSPECT copies (reused within a cycle, swept at each analysis start)
  Format verdicts are NEVER cached — sniffers run live over cached text.
- Chunked client-driven analysis (Pause/Resume/Stop, per-file progress).
- **Extraction rule:** all sheets serialised with `### SHEET:` markers; display
  values; **cell-internal newlines collapsed to spaces** so one sheet row is always
  one text line (wrapped header cells otherwise defeat every line-scanning sniffer).
- Ingest companion is self-contained; shares the Config tab (data, not code) via its
  own CDP_BACKING_SHEET_ID property; ingest_* keys + Ingest Log tab.

## 5. Format families (EIGHT parsers)

Registry + contract as before: sniff(content)+parse per family; one file + one
registry line to extend; sniff exclusivity tested against all families both ways;
tolerance inside a family, never between families.

1. **eiep_rows** — ICPCONS/ICPSUMM v1.1, v1.4 (label-row, live Aug 2026), Meridian
   versionless HDR, DES-driven columns; BOM/quotes/UTF-16 tolerant.
2. **hhr_wide** — 48 slot columns per day-row; band-label variant; register config.
3. **interval_long** — one row per interval: Genesis (Interval Number; slot length
   from max/day: 48→30m, 24→60m, 96→15m) and Papillon (Date+Time; slot from smallest
   step).
4. **register_reads** — cumulative reads → consecutive differences per
   ICP+register+serial; earliest read emits nothing; negative diffs (rollover) are
   row errors; period ESTIMATE if either endpoint is. **Units: kWh — confirmed
   Sep 2026 (gas registers report kWh, same as electricity; caveat retired).**
5. **report_reads** — labelled Consumption Report documents (Genesis/Cranford);
   label-tracking state machine; multi-section; corrections kept for netting.
6. **consumption_rows** — headerless positional CSV (ICP, serial, "Consumption",
   register, PoA, start, end, RD/ES, tariff name, kWh); shape-sniffed (ICP regex +
   literal marker); tariff names surfaced as Register Map cross-check only.
7. **period_table** — keyword-headed period rows; underscore/hyphen normalisation
   ("Usage Uunits", start_date); side-by-side contract blocks ignored; quoted comma
   numbers; **Octopus vocabulary** (read_start/read_end/read_quality/kwh, ISO
   30-min rows → HH). Multiplier NOT applied (flagged ≠1; bill verification pending).
8. **timestamp_series** — metering-portal exports (ZPT/ZR ids, OBIS codes,
   dot-dates): identity from the multi-line title blob (regex over raw content);
   timestamps are interval ENDS; step derived; **OBIS channel semantics enforced —
   1-1:1.29.0 import = consumption, 1-1:2.29.0/INJ export = GENERATION, kept as its
   own register with a loud flag so it can never silently enter a consumption AVM.**

## 6. Date handling (§6.1 — the full stack)

All parsers share one machinery (decideDateModeFromSamples_ + parseAnyDateMode_ +
collectDateSamples_): ISO never ambiguous; strict zero-padded dd/mm/yyyy = spec;
short/unpadded forms resolved by dual-interpretation sequence consistency with the
large-step tie-break. Outcomes: day-first (calm note), month-first (loud
EXCEL-MANGLED flag — definitionally a US-locale resave), or AMBIGUOUS.

**Mixed-orientation files** (eiep_rows; built for the MLEBF case — 57,418 rows,
34,421 initial errors → 3): when AMBIGUOUS, a per-row anchored resolver runs:
rows with exactly one valid reading self-resolve and become anchors; both-valid rows
take the reading fitting between nearest anchors (±2 days) in file order; register-
block boundaries fall back to anchor proximity (16-day reach, 3× decisive margin);
and if EVERY resolved row agrees on one orientation, a uniform-orientation pass
rescues remaining anchor-test failures. Genuinely invalid dates (2/30) stay errors.
One forensic flag reports the full accounting.

Other rules unchanged: span-based granularity (≤3h HH / ~24h DAILY / else PERIOD;
DST by span); windows anchored on actuals; grades measure coverage/quality only;
AVM = kWh ÷ covered days × 30.4375; annual = AVM × 12; per-layer gap detection;
one-layer totals with cross-layer validation.

## 7–9. Lookups, config tables, backing tabs

As v1 (§7–9): EA ICPs / Gas ICP (`ICP identifier` header) / Betty Customers;
Register Map (fuel-aware precedence; template vocabulary is the output domain);
Time Boundaries (network-specific beats DEFAULT; hour-count check); Seasons
(**still UNCONFIRMED seed — Nov–Apr Summer / May–Oct Winter; team sign-off owed**);
tabs: Config · Register Map · Time Boundaries · Seasons · Run Log · Flags Log ·
Ingest Log (ingest-created).

## 10. Build status

| Phase | Status |
|---|---|
| B1–B4 parsing skeleton through report adapters | DONE |
| B2 engine + Betty writer | DONE — **live-fire PASSED Sep 2026** |
| B5 time/date engine | DONE |
| Families 6–8 (beyond plan) | DONE |
| Mail ingest companion | DEPLOYED (accounts@); continuous mode pending trust |
| B5-ii seasonal/Day-Night Betty slot writing | **NEXT BUILD** (unblocked) |

## 11. UI conventions

As v1 §11 (blue #4281A4 family, energy emoji vocabulary, 🐱 buttons, uniform
geometry + icon-button exception, table typography, collapsibles, sortable headers,
chunked progress) plus: build stamp top-right; 📋 copy on the 🔍 card; inline
Sheets-icon inspect column; styled file chooser; horizontally-scrolling table
wrappers with capped flag/file columns.

## 12. Open items

1. **B5-ii** — seasonal/Day-Night slot writing from time profiles (next build).
2. **Seasons confirmation** — team sign-off on the month→season seed.
3. **period_table multiplier** — one bill verification, then lock the rule.
4. **Ingest bedding-in** — watch the Ingest Log on live traffic; tune filters; flip
   continuous on when trusted; add ingest to WTD.
5. **PDF consumption reports** — arriving via ingest as UNKNOWN; family nine if they
   become common.
6. **EIEP 30 Oct 2026 switchover** — v1.4 already handled; re-check at the date.
7. **Pricing comparison system** — successor project; CDP AVMs/profiles (and now
   export-channel data for buyback modelling) are its demand-side inputs.

## 13. Decisions log (delta from v1; 1–25 unchanged)

| # | Decision |
|---|----------|
| 26 | consumption_rows family: headerless shape-sniffing (ICP regex + literal marker); embedded tariff names are cross-checks only — the Register Map remains the single translation path. |
| 27 | period_table widened for Octopus vocabulary rather than a new family — start/end/kWh rows are one family regardless of wording. |
| 28 | §6.1 extended: shared date-mode machinery in ALL parsers; per-row anchored resolution + uniform-orientation rescue for mixed files; month-first = loud flag, day-first = calm note. |
| 29 | Every derived-data cache is versioned by the code that derives it (records cache keyed on CDP_BUILD; text cache schema-versioned). Three staleness incidents; rule is absolute. |
| 30 | Build stamp in every app header, bumped per delivery, template-guarded. |
| 31 | Extraction collapses cell-internal newlines: one sheet row = one text line, for all sniffers, forever. |
| 32 | timestamp_series family: OBIS channel semantics enforced; export/injection channels are generation, carried as separate registers with loud flags, never silently in consumption. |
| 33 | Gas register units are kWh (confirmed Sep 2026); register_reads caveat retired. |
| 34 | Ingest is a self-contained companion app running as accounts@; shares the Config TAB (data, not code); mailbox never altered beyond the processed label; attachments saved byte-identical. |
| 35 | Deliveries: audited version-stamped zip → repo → clasp push (mirrors away strays); clasp status gates naming; Windows extraction keeps case-variant old names — enforce casing by rename. |
| 36 | Betty round-trip live-fire passed (Sep 2026): writer rules, trim, vocabulary validation, and import all verified on a real customer. |
