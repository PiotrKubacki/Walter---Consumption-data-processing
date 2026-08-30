# Consumption Data Processing (CDP) App — Design Record

Status: DRAFT for review
Date: 13 August 2026
Author: Peter (with Claude)
App short name: CDP (working name — confirm before project creation)

---

## 1. Purpose

Replace the manual and semi-scripted processing of retailer consumption data files with an
operator-driven web app that:

1. Parses consumption files (electricity and gas) received from retailers in multiple formats.
2. Normalises them into a single internal data model.
3. Calculates Average Monthly Consumption (AVM) per ICP per register, with data-quality
   flagging and reliability grading.
4. Fills the results into the Betty "Bulk Analysis" template for import back into Betty
   (the pricing system), targeting **Current** analyses only.
5. Later phases add time/date-based calculations (seasonal, day/night, weekday/weekend,
   half-hour profiles) building on the existing Meridian processor script's cube logic.

Primary operators: Miho and Yuka. Builder/maintainer: Peter.

The existing consolidated script ("Consumption Data Processor (Pricing) – Meridian") is the
functional predecessor. Its EIEP13A/ICPCONS parser, interval/aggregate classification,
lookup logic, and report cube are ported and extended rather than rewritten from scratch.

---

## 2. Scope

**In scope**

- File pickup from a dedicated Drive upload folder (ingestion-agnostic: email filter scripts
  or manual drops both land files in the same folder).
- Format detection and parsing for the known format families (Section 5).
- Normalisation, AVM calculation, data-quality flags, reliability grading.
- Customer ID resolution and Betty hyperlinks.
- Betty template round-trip: Customer ID list out, filled template back.
- Operator verify screens before any output is produced (safety inversion).

**Out of scope (for now)**

- Automating email ingestion inside this app (existing scripts continue to do this).
- Requesting data from retailers (EIEP13C requests remain a manual process).
- Any Betty automation (Betty has no API; all Betty interaction is operator-manual).
- Gas registry queries (no API exists — confirmed August 2026; Gas ICP lookup sheet is
  the source).
- Time/date calculations (deferred to B5; design accommodates them from day one).

---

## 3. The Betty round-trip (output workflow)

Betty has no API. One **Current** analysis exists per ICP. Analysis IDs are only visible
in the template Betty exports. The workflow is therefore a round-trip with the operator
as the transport:

1. App parses consumption files and resolves Customer IDs (via Betty Customers import
   sheet: https://docs.google.com/spreadsheets/d/1JzNB-zxEM2DGhY46QmvhkSp00qlv9CrN1_YUp5Z_ycQ).
2. App shows the operator the **Customer ID list** for the batch (copyable).
3. Operator feeds the list into Betty manually; Betty exports the **Bulk Analysis
   template** (xlsx) containing all analyses for those customers, including analysis IDs.
4. Operator uploads the template into the app.
5. App matches template rows to calculated results and produces a **filled copy**
   (xlsx) for download.
6. Operator imports the filled template into Betty.

### Template facts (from Template_085950.xlsx)

- Sheet **Bulk Analysis**: one row per analysis. Key columns: Customer Analysis ID,
  Customer ID, Registered Name, ICP Identifier, Retailer, Status (Analysis),
  Analysis Type (ELECTRICITY | GAS), Comments, then four meter slots
  (`Meter N`, `Monthly Consumption N`, `Unit Cost N` for N = 1..4), then charge and
  contract columns.
- Sheet **Information**: controlled vocabularies — retailer names, statuses
  (Current | Proposed | Archived | Auditing), analysis types, and the **meter type
  list** (Anytime, Controlled, Day, Night, seasonal variants, Gas, etc.).

### Writer rules

- Operate **only** on rows with Status = Current.
- Match rows to results by **ICP Identifier**, with Customer ID as a cross-check
  (mismatch → flag, do not write).
- Write **only** `Monthly Consumption N` values (whole kWh, integer), and `Meter N`
  names **only where the slot is empty** and a value is being written into it.
- Meter names must come strictly from Betty's meter type vocabulary via the
  **register translator** (Section 8). Never invent a name; unmapped register → flag
  row, skip write.
- Where the Current row already has meter slot names, fill consumption against those
  names; if our registers don't correspond to them, flag for the operator.
- All other columns untouched. Rows for ICPs with no consumption data in the batch are
  left exactly as received and listed as "not updated" on the summary screen (the Betty
  export cannot be pre-filtered to only the ICPs we processed — this is expected).
- More than four registers for one ICP → flag; operator decides.
- Same ICP appearing in multiple consumption files in one batch → flag before writing
  (one Current analysis per ICP means last-write-wins must never be silent).

### Round-trip mechanics

Apps Script cannot edit xlsx in place. Pipeline: uploaded xlsx → Drive convert to Google
Sheet → fill values → export as xlsx for download. **B1 spike result (16 Aug 2026):**
the raw Sheets export is rejected by Betty ("line 8 has no customer ID") because
Google's exporter emits the full default grid (~1000 empty row elements) on every tab
and omits the `<dimension>` element. Betty walks row elements and treats the first
empty one as a malformed record. A file with surplus rows deleted on the **Bulk
Analysis tab only** imports cleanly; Betty ignores the missing dimension element and
the Information tab's phantom rows entirely. The B2 writer therefore trims Bulk
Analysis (`deleteRows(lastDataRow+1, maxRows-lastDataRow)`) before export — no
XML-level surgery required. Betty does not accept CSV.

### Betty hyperlinks

Reuse the DC App pattern: per-customer hyperlink into Betty constructed from Customer ID,
shown on verify and summary screens.

---

## 4. Architecture

Same pattern as the Refund, DD Run, and DC apps, simplified to a single environment:

- **One Apps Script project (CONSUMP_DATA_DEV)**; git `master` is the sole source of
  truth (`clasp pull` never used); `clasp push` deploys. A separate DEV project is
  deferred unless the risk profile changes (the app never writes to Xero or the
  bank; outputs are operator-reviewed before Betty import).
- Web app UI for operators; TUC branding; cat emojis on buttons only, one per role.
- **Brand-new dedicated backing spreadsheet** (config + state + logs). Nothing reused
  from the legacy processor sheet.
- Drive folders: `CDP Upload` (raw incoming files), `CDP Processed` (files moved after
  successful processing), `CDP Output` (filled Betty templates and any reports).
- Xero is not involved; no `XERO_WRITE_ENABLED` gate needed. The equivalent safety
  property here is the verify-before-output flow itself.

**Operating rule (process record):** files go into the upload folder **exactly as
received** — never opened and re-saved in Excel first. Excel round-tripping is the
source of the date-mangling defect (Section 6.1). The rule shrinks the problem; the
parser still defends against files mangled before they reach TUC.

Pipeline: folder → detect → parse → normalise → verify screen → calculate → Customer ID
list → (operator ↔ Betty) → template upload → match → fill → download.

---

## 5. Format taxonomy and parser registry

Each parser module implements `sniff(content) → boolean` and
`parse(content) → { records[], warnings[], errors[] }`. Detection tries each sniffer in
order; **unknown format fails loudly** — the file is flagged on screen and nothing is
processed. No guessing. (A manual-mapping fallback screen is a B4 candidate if the
format tail grows.)

### Family A — `eiep_rows` (EIEP13-style row records)

- Sniff: first row starts `HDR,ICPCONS` or `HDR,ICPSUMM` (any version).
- Covers: Meridian ICPCONS 1.1 (HH intervals + daily/larger aggregates), Contact
  ICPSUMM (DES description row, register reads per billing period, RD/ES statuses),
  Contact ICPCONS carrying monthly period rows (including gas ICPs).
- Ported from the existing script; extended for ICPSUMM, DES rows, period-row payloads,
  read statuses, and the date disambiguation heuristic (Section 6.1).
- Note: "ICPCONS" does not guarantee interval data — payload granularity is detected
  per row, not assumed from the header.
- The EIEP13A/13B specs are being updated effective 30 October 2026. The HDR version
  field is captured and checked; an unrecognised version is a warning, not a hard stop.

### Family B — `period_table`

- Sniff: header row containing (case-insensitive, order-tolerant) ICP, Meter Code,
  Meter Type Code, Meter Register, Multiplier, Start Date, End Date, Usage, Days.
- Billing-period reads, ISO-ish datetimes, multi-register ICPs (registers reported
  separately and summed per register, never merged).
- Multiplier applied to usage during normalisation.

### Family C — `hhr_wide`

- Sniff: header row containing `ID12 00AM` … slot columns (48 half-hour columns),
  plus ICP / provider meter number / daily register configuration / reading date.
- One row per day. Variants: register config `UN24`, `N8|D16`; optional Day/Night band
  label row above the slot headers.
- The daily-total column is used for validation only, never summed together with the
  slots (double-count guard, Section 6.2).

### Family D — named report adapters

- Free-form formatted "Consumption Report" documents (first known layout: the
  Cranford style — header block with Account/Address/ICP/Meter, then a read history
  with Reading Type (Actual Read | Interim Estimate | Forced Estimate), cumulative
  register readings, per-period consumption, possible negative correction rows).
- One adapter per recurring layout, added as they prove recurring. Sniff on layout
  markers ("Consumption Report" title cell + "Reading Date"/"Reading Type" headers).
- Likely the main gas channel.

File type handling: CSVs read as text; xlsx uploads converted via Drive to Sheets for
reading. Detection sniffs content, never filename/extension (BNZ lesson applied).

---

## 6. Normalised data model and quality rules

Every parser emits **period consumption records**:

```
{
  icp, fuel (ELEC|GAS), meterOrRegister, registerConfig,
  periodStart, periodEnd, quantityKWh, granularity (HH|DAILY|PERIOD),
  readQuality (ACTUAL|ESTIMATE|CORRECTION|UNKNOWN),
  sourceFile, rowRef, flags[]
}
```

HH intervals are simply 30-minute periods. The AVM engine never depends on interval
data existing; intervals additionally feed the B5 time/date calculations when present.

### 6.1 Date normalisation and disambiguation (Excel-mangled files)

Observed defects in files that have been opened and re-saved in Excel:

- Dates reformatted as `7/1/25 0:00` (m/d/yy, seconds stripped) — ambiguous against
  the spec's dd/mm/yyyy.
- Date/times stored as **text** rather than real date values (sometimes mixed with
  real dates in the same column). Text dates break time-based calculations silently
  if passed through untouched.

**Normalisation step (runs before any calculation):** every date cell is coerced to a
proper Date value. Cells arriving as text are parsed via the disambiguation heuristic
below; cells arriving as Date objects (from xlsx→Sheets conversion) are taken as-is
but sanity-checked against neighbouring rows. A file containing text-stored dates gets
an informational flag on the verify screen (it identifies Excel-round-tripped files —
useful for chasing the source); mixed text/date columns get a warning flag. Downstream
code only ever sees real Date values.

Heuristic: parse the file under both interpretations; for interval data, the correct
interpretation is the one where successive intervals advance monotonically by 30
minutes and day boundaries roll correctly; for period data, periods must be contiguous
and non-overlapping with plausible day counts. If exactly one interpretation is
consistent, use it **and attach a warning flag** (visible on verify screen). If both or
neither are consistent, hard-flag the file; operator decides.

### 6.2 Overlap and double-count guard

Meridian files contain HH rows *and* daily/larger aggregate rows covering the same time
(e.g. `22:59:54 → next-day 22:59:53` spans, `23:59 → 23:59` D/N daily rows). Family C
carries a daily-total column beside the 48 slots. Rule: classify layers (interval vs
daily vs larger — end-time/span classification ported from the existing script), pick
**one layer per ICP-register for totals** (prefer the finest complete layer), and use
the other layer(s) to cross-validate (mismatch beyond tolerance → flag). Naive summing
across layers is a defect.

### 6.3 Estimates, corrections, negatives

Included by default — with an anchor rule. The **analysis window** per ICP-register is
anchored on actual reads: earliest actual to latest actual. Between two actual reads,
estimates and corrections (including negative rows, e.g. -621 correction observed in
the Cranford sample) net out correctly because the endpoint register readings are
ground truth.

Reliability grade per ICP-register, shown on verify screen and written to the run log.
**Grading principle: reliability measures *coverage and read quality*, never
*magnitude*.** A site that genuinely uses 3 kWh/month with a full year of actual reads
is **Good**. Three distinct situations that must never be confused:

- *Valid but empty* — the file parsed correctly but contains **no records** for an
  ICP-register. This is not a grade; it is a separate **No Data** state (nothing to
  grade, nothing written to Betty, listed explicitly on the summary screen).
- *Genuinely low usage* — records exist, coverage is fine, quantities are small or
  zero. Graded normally on coverage/quality; additionally gets an informational
  **near-zero flag** (possible vacant site / disconnected meter — worth a human
  glance, not a downgrade).
- *Missing or thin data* — records exist but coverage is poor. This — and only this —
  drives the grade down.

Grades:

- **Good** — window anchored on actuals both ends, window ≥ threshold days, estimate
  share ≤ threshold, gaps ≤ threshold.
- **Check** — one threshold breached (short window, high estimate share, gap extent,
  or partial-month truncation material to AVM).
- **Unreliable** — no two actual reads exist (window endpoints are estimates), or
  multiple thresholds breached.
- **No Data** — no records for this ICP-register (state, not a grade).

Thresholds are config values (initial: window ≥ 90 days; estimate share ≤ 50% of days;
near-zero flag when AVM < 10 kWh/month — informational only). For interval sources
with no read-quality concept, quality defaults to ACTUAL unless the source marks
otherwise (e.g. ES rows in ICPSUMM).

### 6.4 AVM

Per ICP-register within the analysis window:

```
AVM = totalKWh / totalDays × (365.25 / 12)      // 30.4375-day standard month
```

rounded to whole kWh for Betty. Days from actual period coverage, not calendar span,
so gaps reduce coverage rather than diluting the average; gap extent feeds the
reliability grade. This replaces the manual `Days | Total Usage | Average Monthly
Consumption` side-calculations currently pasted into sheets by hand.

### 6.5 Gap detection

Interval sources: missing-interval detection (gap > 70 min, ported). Period sources:
non-contiguous periods detected as gaps. Gaps listed on verify screen.

---

## 7. Lookups

Three lookup sources, all read-only to this app:

1. **EA ICPs (Imports)** — electricity ICP → trader, network, Customer ID.
2. **Gas ICP lookup sheet** — gas ICP → customer linkage (gas registry has no API;
   this sheet is maintained manually).
3. **Betty Customers (Imports)** — Customer ID → registered/trading name.

Routing: fuel/ICP determined from the file family and ICP pattern first; electricity
ICPs looked up in (1), gas in (2); both then resolve names via (3). Lookup misses are
flags, not errors — gas ICPs absent from the EA sheet are expected. Sheet IDs are
config values in the backing spreadsheet, not hardcoded.

---

## 8. Register translation tables

Two distinct, operator-editable tables in the config sheet. They answer different
questions and must not be conflated: 8.1 maps *what a register is called* (for Betty);
8.2 maps *when a register meters* (for time/date calculations).

### 8.1 Register → Betty meter type (naming translator)

```
sourcePattern (register/tariff code as seen in files) → BettyMeterType
e.g.  UN, UN24, 7304 → Anytime
      CN → Controlled
      D  → Day
      N  → Night
      U (gas) → Gas
```

Rules: Betty meter names are hardcoded in Betty — the translator's output domain is
exactly the Information-sheet vocabulary, validated at write time. The vocabulary
(24 types as of Aug 2026: All Inclusive … Solar Exported, incl. Gas) is **read at
runtime from the Information sheet of the uploaded template**, never hardcoded in the
app — it can only be changed by Cortex (Betty's developer, on request with a full
list), and reading it live means the app self-updates when that happens. Unmapped
codes are flagged on the verify screen with a prompt to extend the table; nothing is
written for that register until mapped. A register that cannot be sensibly mapped to
*any* existing meter type is a different case: it goes on a **vocabulary gap list**
(persisted in the Flags Log) so a complete change request can be sent to Cortex in
one hit. Seasonal meter types (Anytime Summer, etc.) become
reachable in B5 when seasonal calculations exist.

### 8.2 Register config → time boundaries (network-dependent)

Day/Night (and Peak) boundaries are **not uniform across networks**. Examples:

```
network   registerConfig   window
Electra   D14              07:00–21:00
Electra   N10              21:00–07:00
Westpower DIN8             07:00–23:00
Westpower NIN8             23:00–07:00
```

Table shape: `network + registerConfig code → start/end time(s)` (multiple windows per
day allowed, e.g. peak bands). Network comes from the ICP lookup (Section 7), so the
same code on different networks resolves independently.

Built-in consistency check: the numeric part of most config codes encodes the hour
count (D14 = 14 day hours, N10 = 10 night hours, `N8|D16` = 8 + 16). The app verifies
each table entry's window duration against its code's hour count and flags mismatches —
cheap protection against typos in an operator-maintained table.

Used by B5 time/date calculations only; the AVM path (B2) never needs it. Unknown
`network + config` combinations at B5 time are flagged with a prompt to extend the
table, mirroring the 8.1 pattern. Boundary times are network-published and can change;
the table carries a source/date-checked column per row.

---

## 9. Backing spreadsheet (new, dedicated)

Tabs (indicative):

- **Config** — folder IDs, lookup sheet IDs, thresholds, Betty URL pattern,
  naming translator table (8.1), time-boundary table (8.2), format-version notes.
- **Run Log** — one row per processing run: timestamp, operator, files, ICP count,
  reliability summary, output file link.
- **Flags Log** — persisted flags per run for audit.
- No consumption data is stored long-term in the backing sheet; the normalised data
  lives in the run's working state and the outputs. (Keeps the sheet small and the
  app self-contained.)

---

## 10. Build phases

- **B1 — Skeleton + parse/verify (read-only).** DEV/LIVE projects, backing sheet,
  upload-folder listing, format detection, `eiep_rows` parser ported, verify screen
  showing per ICP-register: date range, days covered, record counts, gaps, overlaps,
  read-quality mix, warnings. No outputs. **Includes the Betty xlsx round-trip spike.**
  Checkpoint: known Meridian and Contact samples parse and verify correctly; untouched
  template survives Sheets conversion and re-imports into Betty.
- **B2 — Normalise + AVM + Betty writer.** Normalised model, analysis windows,
  reliability grades, Customer ID list screen, template upload, matching, filled
  template download, Betty hyperlinks. *The quick-win milestone: manual AVM
  side-calculations retired.* Checkpoint: a real batch round-trips into Betty.
- **B3 — Remaining structured parsers.** `period_table` and `hhr_wide`, including
  multi-register handling and the daily-total validation rule.
- **B4 — Report adapters.** Cranford-style adapter (gas channel); manual-mapping
  fallback screen if the layout tail grows.
- **B5 — Time/date calculations.** Port the cube and summary logic (seasonal, DOW,
  weekday/weekend, 48-slot profiles) onto the normalised model; seasonal Betty meter
  types become fillable. Season/DOW config carried in the config tab (operator-edited),
  as in the existing report Config tab. Requires the 8.2 time-boundary table populated
  for the networks in play; hour-count consistency check implemented alongside it.

---

## 11. Risks and open items

1. **Betty template fidelity** — RESOLVED by B1 spike: trim Bulk Analysis surplus rows
   before export; Betty tolerant of all other conversion artefacts (§3).
2. **EIEP13A/13B spec update effective 30 Oct 2026** — v1.4 is ALREADY LIVE in the
   wild (Trustpower, observed Aug 2026): files lead with a DET-prefixed labelled
   column-header row *before* the HDR, and carry the new NZDT_adjustment field.
   Parser handles v1.1 (fixed columns) and v1.4 (label-driven columns); other
   versions flag for review. Meridian additionally ships a versionless ICPSUMM HDR
   variant (`HDR,ICPSUMM,MERX,...`) — handled, informational flag.
3. **NZDT boundary rows** — v1.4's explicit NZDT_adjustment field resolves the
   industry ambiguity going forward; for v1.1 files, DST transition days produce
   odd-span (60/90-min) intervals, which classify into the interval layer
   (sub-3-hour span rule) rather than as aggregates.
4. **Upstream Excel mangling is a fact of life** — files can arrive mangled from
   sources outside TUC's control (observed: xlsx bodies mis-named .csv, US-locale
   m/d date rewrites). The §4 operating rule holds internally; the parser defends
   externally (content sniffing regardless of extension, xlsx-to-text extraction,
   dual-interpretation date resolution with flags).
5. **App name** — CDP used throughout this record; confirm before creating projects.
6. **Work Tools Directory** — add CDP entry (Billing & Collections vs a Pricing
   group placement to be decided) once B2 is live.

## 12. Decisions log

| # | Decision |
|---|----------|
| 1 | Output is the Betty Bulk Analysis template (xlsx), Current analyses only; no CSV. |
| 2 | Write only Monthly Consumption values (whole kWh); Meter names only into empty slots, strictly from Betty vocabulary via translator. |
| 3 | Rows for ICPs without data are left untouched and reported as "not updated". |
| 4 | Estimates/negatives included; analysis window anchored on actual reads; reliability grades coverage/quality only (Good/Check/Unreliable + No Data state); magnitude never affects grade (near-zero is an informational flag). |
| 5 | Gas lookups via the Gas ICP lookup sheet; gas registry confirmed to have no API (Aug 2026). |
| 6 | Brand-new dedicated backing spreadsheet; nothing reused from legacy sheets. |
| 7 | Files enter the upload folder exactly as received; never Excel-round-tripped. |
| 8 | Ingestion (email filters/scripts) stays outside the app; the folder is the interface. |
| 9 | Unknown formats fail loudly; no guessing. |
| 10 | All dates coerced to real Date values before any calculation; text-stored dates flagged (Excel round-trip indicator). |
| 11 | Register naming (→ Betty meter types) and register time boundaries (network-dependent) are two separate config tables (8.1 / 8.2); boundaries validated against the hour count encoded in config codes. |
| 12 | Betty template edited via xlsx → Sheets → xlsx; B1 spike validates Betty accepts the round-tripped file. |
| 13 | Betty meter type vocabulary is read at runtime from the uploaded template's Information sheet (Cortex-controlled, never hardcoded); unmappable registers accumulate on a vocabulary gap list for batched Cortex requests. |
| 14 | Single Apps Script project, single branch (DEV/LIVE split dropped as unnecessary complication for this app). |
| 15 | B1 spike passed: Sheets-exported template accepted by Betty after trimming surplus rows on Bulk Analysis only; B2 writer trims that tab before export. |
| 16 | Granularity is span-based: ≤3 h = interval layer (incl. DST odd spans), ~24 h = DAILY, else PERIOD. |
| 17 | Parser supports EIEP v1.1 (fixed columns), v1.4 (labelled column row, observed live from Trustpower Aug 2026), and Meridian's versionless ICPSUMM HDR variant. |
| 18 | AVM divides by measured data coverage (incl. real DST elapsed time), not an assumed 365.25-day year. Accuracy over comparability with historical manual figures (legacy convention understates AVM on sub-year files). |
