# Consumption Data Processing (CDP) App — Design Record

Status: v1.0 — published to /exec (Peter + Yuka), Betty live-fire test pending
Date: 30 August 2026 (supersedes the 13 August draft)
Author: Peter (with Claude)
Apps Script project: CONSUMP_DATA_DEV (single project, single git branch)
Backing spreadsheet: "CDP App Data" — 1olmhVUeNXARRk8oflXBn6521FJCtZaDa7R3Xxr3UYT8

---

## 1. Purpose

Replace the manual and semi-scripted processing of retailer consumption data files with an
operator web app that parses consumption files (electricity and gas) in every format we
receive, normalises them into one internal model, calculates AVM per ICP-register with
data-quality flagging and reliability grading, computes time/date profiles from interval
data, and fills results into the Betty "Bulk Analysis" template (Current analyses only)
for import back into Betty.

Operators: Peter and Yuka (dev URL, script editors); Miho via /exec when rolled out.
The manual Days | Total Usage | AVM side-calculations are retired.

## 2. Scope

**Built (v1.0):** folder pickup; detection and parsing for six format families; normalised
model; AVM engine with analysis windows and reliability grading; time/date profiles
(seasonal, Day/Night windows, weekday/weekend, 48-slot); batch UI with selection,
chunked pause/stop analysis, sorting, inspection copies; Betty round-trip (Customer ID
list, template fill, trim, export); Run/Flags logging; archive-to-Processed.

**Out of scope:** email ingestion (existing filter scripts feed the folder); EIEP13C
requests (manual); any Betty automation (no API); gas registry queries (no API,
confirmed Aug 2026 — Gas ICP lookup sheet is the source).

## 3. The Betty round-trip (as built)

Betty has no API; one Current analysis per ICP; analysis IDs visible only in Betty's
template export. Flow: batch analysis → app shows deduplicated **Customer ID list** →
operator feeds Betty → Betty exports template → operator uploads it (styled chooser) →
app fills → operator downloads and imports.

Writer rules (implemented in Betty.gs):
- Current rows only, matched by ICP; Customer ID cross-check (mismatch = blocked row).
- Registers translated via the **Register Map** tab (fuel-aware: ELEC/GAS rows beat ANY;
  unmapped register = flagged, not written).
- Translated names validated against the **template's own Information-sheet vocabulary**
  (Cortex-controlled, read at runtime, never hardcoded). Unmappable types accumulate on
  a vocabulary gap list for batched Cortex requests.
- Writes ONLY Monthly Consumption N (whole kWh); Meter N names only into empty slots
  (existing slot names are matched, never overwritten). >4 registers = flag.
- Rows without data are left untouched and reported "not updated".
- **Bulk Analysis surplus rows trimmed before export** — B1 spike finding: Google's
  exporter emits ~1000 phantom row elements which Betty's importer reads as malformed
  records ("line 8 has no customer ID"); trimming that one tab fixes it; Betty ignores
  the missing <dimension> element and the Information tab's phantom rows. No CSV path
  (Betty rejects CSV). Export via UrlFetch + OAuth token (script.external_request scope).
- Run Log (timestamp, operator, files, ICP count, grade summary, output link) and
  Flags Log (per-flag rows) written per fill run.
- Betty hyperlinks per customer: https://betty.cortex.co.nz/Admin/Customers/Edit/{customerId}
  (config value betty_url_pattern).

**PENDING: live-fire test** — one real filled template imported into Betty on a safe
customer. Gates B5 instalment two.

## 4. Architecture (as built)

- Single Apps Script project; git master is the sole source of truth (clasp pull never
  used); clasp push → test → commit; deploy updates via Manage deployments → New version.
- Web app: executeAs USER_DEPLOYING, DOMAIN access. Dev URL runs as the visitor — Yuka
  (editor) needs her own access to the backing sheet, folders, and lookup sheets.
- Only hardcoded pointer: Script Property BACKING_SHEET_ID. Everything else is Config
  tab (folders, lookup sheet IDs, betty_url_pattern, thresholds).
- Drive: CDP Upload (raw, exactly as received), CDP Processed (archived after runs),
  CDP Output (filled templates), and **.cdp-cache** inside Upload holding three cache
  kinds: extracted spreadsheet text (`<id>_<updated>_v2.txt`), normalised records JSON
  (`<id>_<updated>_recs1.json`), and INSPECT copies.
- **Chunked analysis:** the client prepares selected files one server call at a time
  (parse → records cache), giving Pause/Resume/Stop and a progress bar, then one
  analyse call runs grouping/analysis/lookups from cache. Format verdicts are never
  cached (sniffers run live over cached text — parser improvements take effect on push).
- Inspection copies: created on demand (reused if one exists), swept (trashed) at the
  start of every analysis run. Deletions everywhere are Trash, never permanent.
- Operating rule: files enter the upload folder exactly as received. Upstream mangling
  (Excel resaves, xlsx-named-csv, US-locale dates) is outside TUC control and is
  handled defensively by the parsers instead.

## 5. Format families (six parsers, registry in Detect.gs)

Each parser: sniff(content) + parse(content) → normalised records. Detection sniffs
content (never filename); spreadsheet-shaped files are serialised via Sheets conversion
(ALL tabs, '### SHEET:' markers — consumption can live on any tab). Unknown format
fails loudly; 🔍 debug shows bytes, extracted head, and per-parser verdicts.

1. **eiep_rows** — HDR,ICPCONS / HDR,ICPSUMM row records. v1.1 fixed columns; v1.4
   label-row layout (observed live from Trustpower Aug 2026 — DET-prefixed column-name
   row BEFORE the HDR, NZDT_adjustment field present); Meridian versionless ICPSUMM
   HDR variant; DES-driven ICPSUMM columns; quoted/BOM/UTF-16 tolerant; date
   disambiguation (§6.1).
2. **hhr_wide** — one row per day per register, 48 slot columns (ID12 00AM…), register
   config (UN24, N8|D16), optional band-label row; daily-total column validates only.
3. **interval_long** — one row per interval. Genesis shape (Interval Number 1..48,
   ReadingType A/E; slot length derived from max interval/day: 48→30min, 24→60,
   96→15) and Papillon/TOU shape (Date+Time+Consumption kWh; slot length from
   smallest time step; extra energy columns ignored).
4. **register_reads** — cumulative register reads (Genesis daily gas): consumption =
   consecutive-read differences per ICP+register+serial; earliest read emits nothing;
   negative diffs (rollover/meter change) are row errors; period quality ESTIMATE if
   either endpoint read is. **UNITS CAVEAT: values taken as-is; gas registers may be
   m³ — see open item.**
5. **report_reads** — labelled "Consumption Report" documents (Genesis/Cranford):
   scanning state machine tracks ICP:/Meter Number: labels and the reads-table header
   at arbitrary columns; each row's consumption covers back to the previous read;
   Actual/Interim/Forced → ACTUAL/ESTIMATE; negative corrections kept (window nets
   them); multi-section reports supported.
6. **period_table** — plain billing-period tables (ICP/meter/register/multiplier/
   start/end/usage), keyword-matched headers with underscore/hyphen normalisation
   (handles start_date, usage_units, the 'Usage Uunits' typo), side-by-side contract
   blocks ignored, quoted comma numbers handled, Days-vs-span cross-check.
   **Multiplier NOT applied** (usage assumed pre-multiplied; flagged when ≠1 — verify
   against a bill before trusting, then lock in).

Adding a parser: one new file + one registry line; emit the record contract and
everything downstream works. Sniff exclusivity is tested against samples of all
existing families. Tolerance lives inside a family; between families we never guess.

## 6. Normalised model and rules

Record: `{icp, register, meterId, registerConfig, periodStart, periodEnd, kWh,
granularity (HH|DAILY|PERIOD), readQuality (ACTUAL|ESTIMATE|…), sourceFile, line}`.

- **6.1 Dates:** all coerced to real Dates. Strict spec = zero-padded dd/mm/yyyy with
  optional time/seconds. Ambiguous short forms (Excel-mangled) resolved by dual-
  interpretation sequence consistency with a large-step tie-break (the wrong reading
  jumps ~a month per day boundary); resolution always flagged; undecidable = AMBIGUOUS
  flag, operator decides. Month-first resolutions occur genuinely (US-locale resaves).
- **6.2 Granularity/layers:** span-based — ≤3h = interval layer (captures DST 60/90-min
  odd rows), ~24h = DAILY, else PERIOD. Totals use ONE layer (greatest coverage, finer
  first on ties); material alternative layers cross-validate by daily rate (>10%
  divergence flagged); minor stray layers listed row-by-row.
- **6.3 Windows & grading:** analysis window anchored earliest-actual → latest-actual;
  estimates/corrections inside net out. Grades measure coverage and read quality ONLY,
  never magnitude: 🔋 GOOD / ⚠️ CHECK (one threshold breach) / 🪫 UNRELIABLE (no
  anchor or multiple breaches) / 🕯️ NO_DATA (state, not grade). Thresholds in Config:
  min_window_days 90, max_estimate_share 0.5, max_gap_share 0.1. Near-zero
  (< near_zero_avm_kwh, default 10) is informational only.
- **6.4 AVM:** kWh ÷ days actually covered × 30.4375, whole kWh. Coverage includes
  real DST elapsed time. Deliberately NOT the legacy ÷365.25 convention — accuracy
  over comparability (legacy understates on sub-year files). Annual = AVM × 12.
- **6.5 Gaps:** per-layer gap detection (HH >70min; DAILY >1.5d; PERIOD >1d).

## 7. Lookups (map-indexed, loaded once per run)

1. EA ICPs (Imports) 1IVRUmU-AbRwZXog3jG-uSiXbOcbTA2lWpvKZi0MdQEM — electricity ICP →
   trader/network/Customer ID.
2. Gas ICP lookup 1wHmtaziwt9cxfu_f7fpSHf1DU4trSByByS_18dDsQv4 — header is
   **`ICP identifier`** (not `ICP`); some rows lack Customer IDs (flagged, not errors).
3. Betty Customers (Imports) 1JzNB-zxEM2DGhY46QmvhkSp00qlv9CrN1_YUp5Z_ycQ — names.
Fuel = which registry hit (EA→ELEC, Gas sheet→GAS). Misses are flags.

## 8. Config tables (backing sheet, operator-edited, bootstrap-seeded)

- **8.1 Register Map** — fuel + source pattern → Betty meter type. Precedence:
  fuel-specific beats ANY. Seeded: UN/UN24→Anytime, CN→Controlled, D→Day, N→Night,
  KWH-IMP-PRI-TOT→Anytime, GAS U/1→Gas. Output domain = the uploaded template's
  vocabulary, validated at write time.
- **8.2 Time Boundaries** — network + register config → named windows (start/end,
  overnight wrap supported). Network-specific rows beat DEFAULT; register config
  narrows when present. Seeded: DEFAULT Day 07:00–21:00 / Night 21:00–07:00; Electra
  D14/N10; Westpower DIN8/NIN8 (Yuka). `checkTimeBoundaryHourCounts()` validates each
  window's duration against the hour count encoded in its code (D14=14h…).
- **Seasons** — month → season. Seeded Nov–Apr Summer / May–Oct Winter — **UNCONFIRMED
  convention, team to verify before seasonal outputs are relied on.**

Time profiles (interval data in-window only): seasonal monthly averages, window splits
(share % + monthly kWh), weekday/weekend kWh/day, 48-slot averages, per-month totals
with completeness. DEFAULT-window use is flagged with the network to add.

## 9. Backing sheet tabs

Config · Register Map · Time Boundaries · Seasons · Run Log · Flags Log — all created
and seeded additively by `bootstrapBackingSheet()` (idempotent; never overwrites).

## 10. Build status

| Phase | Status |
|---|---|
| B1 skeleton, eiep_rows, verify, Betty spike | DONE |
| B2 engine, grading, AVM | DONE |
| B2 Betty writer + logs + archive | BUILT — live-fire test pending |
| B3 hhr_wide, period_table | DONE |
| B4 report adapter (+ interval_long, register_reads beyond plan) | DONE |
| B5 time/date engine, 8.2, Seasons | DONE |
| B5-ii seasonal/Day-Night Betty slot writing | NOT BUILT — gated on live-fire |

## 11. UI conventions (as built)

Theme #4281A4 (RGB 66/129/164) with derived family: bg #F2F6F9, line #D9E6ED, ink
#12242E, muted #7497AA. Energy emoji family: ⚡ app/profiles, 🔋⚠️🪫🕯️ grades, 🔌 Betty,
🐱 buttons (house convention), ❌ destructive. Buttons uniform (38px, min 170px) except
minimal icon buttons (34px square: Sheets-SVG inspect, red ✕). Tables: text left,
numbers right with thousands separators, badges centred, all vertically middle.
Collapsible sections; collapsed flag overflows; sortable columns. Chunked analyse with
Pause/Stop; ticked-selection analyse/delete (Trash); styled file chooser.

## 12. Open items

1. **Betty live-fire test** — the gate. Safe customer, real import.
2. **Gas units conversion** — register_reads values may be m³; needs per-retailer/ICP
   conversion factors (from gas bills) as config, applied at normalisation; unconverted
   registers stay flagged. Awaiting units confirmation from Genesis data.
3. **Seasons confirmation** — team sign-off on month→season mapping.
4. **period_table multiplier** — verify one multiplier≠1 row against a bill; lock rule.
5. **B5-ii** — seasonal/Day-Night slot writing after (1).
6. **EIEP spec 30 Oct 2026** — v1.4 already handled; re-check at switchover.
7. **Rollout** — Miho /exec link (domain-qualified form), WTD entry, operator note.
8. **Pricing comparison system** — CDP's AVMs/profiles are its demand-side input;
   scope as the successor project once (1)–(2) close.

## 13. Decisions log

| # | Decision |
|---|----------|
| 1 | Output is the Betty Bulk Analysis template (xlsx), Current analyses only; no CSV. |
| 2 | Write only Monthly Consumption (whole kWh); Meter names only into empty slots, strictly from the template's vocabulary via the Register Map. |
| 3 | Rows without data left untouched, reported "not updated". |
| 4 | Estimates/negatives included; windows anchored on actual reads; grades measure coverage/quality only (🔋⚠️🪫 + 🕯️ state); magnitude never downgrades. |
| 5 | Gas lookups via Gas ICP sheet; gas registry has no API (Aug 2026). |
| 6 | Dedicated backing spreadsheet; nothing reused from legacy sheets. |
| 7 | Files enter the upload folder exactly as received. |
| 8 | Ingestion stays outside the app; the folder is the interface. |
| 9 | Unknown formats fail loudly; no guessing between families. |
| 10 | All dates coerced to real Dates pre-calculation; mangled dates resolved by sequence consistency and flagged. |
| 11 | Register naming (8.1) and time boundaries (8.2) are separate tables; boundaries validated against code-encoded hour counts. |
| 12 | Template edited via xlsx→Sheets→xlsx; spike-validated. |
| 13 | Betty vocabulary read at runtime from the uploaded template; unmappables accumulate for batched Cortex requests. |
| 14 | Single Apps Script project, single branch. |
| 15 | Spike result: trim Bulk Analysis surplus rows only; Betty tolerates all other conversion artefacts. |
| 16 | Granularity is span-based: ≤3h interval (incl. DST odd spans), ~24h DAILY, else PERIOD. |
| 17 | eiep_rows supports v1.1, v1.4 (live since Aug 2026), and Meridian's versionless ICPSUMM HDR. |
| 18 | AVM divides by measured coverage, not 365.25 — accuracy over historical comparability. |
| 19 | Six parser families (interval_long and register_reads added beyond the planned four); registry + record contract is the only extension surface. |
| 20 | register_reads: consumption by consecutive-read differences; negatives are errors; units as-is pending conversion config. |
| 21 | period_table multiplier NOT applied (assumed pre-multiplied); flagged when ≠1 pending bill verification. |
| 22 | Spreadsheet extraction reads ALL tabs; format verdicts never cached (sniff live over cached text). |
| 23 | Chunked client-driven analysis (pause/stop) with per-file records cache; Betty flow operates on the analysed selection. |
| 24 | Inspection copies: reused within a cycle, swept at each analysis start; all deletions are Trash. |
| 25 | Theme moved to #4281A4 family (CDP-specific); energy emoji conventions retained. |
