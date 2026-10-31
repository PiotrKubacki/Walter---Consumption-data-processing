# CDP App — Operator Guide (v1.4)

App link (use this form for multi-account sign-in):
`https://script.google.com/a/theutilitycompany.net/macros/s/<DEPLOYMENT_ID>/exec`

The build stamp sits top-right of the header (e.g. `build v1.4-2026-10-26`).
**Quote it whenever you report a problem** — it says exactly which version you were on.

---

## 🛠 Workbench — day-to-day proposals (one customer per session)

1. **Open the app.** The Workbench tab is the default view.
2. **Add the customer's consumption files** — any mix of:
   - drag them onto the dashed drop zone,
   - **📁 Choose files**,
   - paste a Google Drive link (or file ID) and click **🐱 Add from Drive**
     (the app works on a copy; the original file is never touched).
3. Each file appears with a **format badge**:
   - green = recognised, will be processed;
   - red **UNKNOWN** = a layout the app has not met yet. Do **not** fix the file
     yourself (no renaming, no opening-and-saving in Excel). Send the file to
     Peter — new formats are added to the app, usually same day.
4. **Click a file** in the list to preview it in the left pane.
5. **🐱 Analyse session.** The right pane shows one row per ICP-register:
   - **Grade:** 🔋 good data · ⚠️ check (one quality issue) · 🪫 unreliable ·
     🕯️ no data. The grade reflects data coverage/quality only — never the size
     of the numbers.
   - **AVM kWh/mo** and **Annual kWh** — the figures for Betty.
   - **⚡ profile** expander (interval data only): seasonal and Day/Night splits.
   - **Flags** — read them. They say what the app assumed or corrected
     (e.g. "EXCEL-MANGLED DATES … corrected" means the file arrived damaged and
     was repaired; "EXPORT/INJECTION CHANNEL" means solar export — generation,
     NOT consumption, never use it as usage).
   - A red warning that files resolve to **two different customers** means a
     wrong file is in the session — remove it and re-analyse.
6. **Fill in the proposal notes.** Customer id, customer, date and retailer(s)
   are pre-filled from the analysis — check them. Fill the rest (expiry, break
   fees, discount, TUC Fee, tickets…) from the retailer's email.
7. **📋 Generate & copy notes.** The full marker-fenced block
   (`**----------**----------**`) is copied to your clipboard — paste it into
   the Betty proposal. Every generated block is also saved to the **Notes Log**
   tab of "CDP App Data", so if the clipboard misbehaves the text can always be
   recovered from there.
8. **✅ Finish customer.** Clears the session (working copies go to Drive Trash)
   and resets the form, ready for the next customer.

---

## ⚡ Batch — bulk runs (e.g. Friday pricing)

1. Put the files in the **CDP Upload** Drive folder, then open the Batch tab →
   **🐱 Refresh list**.
2. Tick the files (header checkbox = all) → **🐱 Analyse selected**.
   Long runs can be ⏸ paused or ⏹ stopped.
3. In the results table, the **sheet icon** at the end of a row opens an
   inspection **copy** of the source file in Sheets (original untouched);
   ❌ deletes the copy.
4. **Betty round-trip** (below the results):
   1. **🐱 Show Customer ID list** → feed the IDs to Betty and export the
      Bulk Analysis template.
   2. **📁 Choose template** → select Betty's export → **🐱 Fill template**.
   3. Review the summary (updated rows, blocked rows, vocabulary gaps), then
      download the filled file from the link and import it into Betty.
   4. **🐱 Archive processed files** moves recognised files to CDP Processed.
      Unrecognised files stay put so they get attention.

---

## What the flags mean

| Flag (starts with…) | Meaning | What you do |
|---|---|---|
| **CHECK SOURCES: two kinds of data … disagree** | Two sources for one register give different kWh/day; the flag names both files and both figures. The AVM uses only the named layer. | Same file both times + full HH coverage → trust the HH figure and carry on. Different files → open each (inspect), decide which matches reality (bill, site knowledge), remove the wrong one, re-analyse. |
| **… rows are overlapping summaries … Ignored** | The file carries subtotal/total rows restating the same span (e.g. monthlies plus an annual total). They are not used for anything. | Nothing — informational. |
| **OVERLAPPING ROWS IN TOTALS** | The data the AVM itself is built from contains overlapping periods — **the AVM is not reliable.** | Do not use the figure. Inspect the file; send it to Peter. |
| **EXCEL-MANGLED DATES … corrected** / **resolved … by sequence consistency** / **MIXED/AMBIGUOUS DATES RESOLVED PER ROW** | The file's dates were damaged upstream (opened in Excel) and the app repaired them. | Spot-check one date against the source email/bill. Find out who opened the file in Excel so the next one arrives clean. |
| **AMBIGUOUS DATES … operator decision required** | The dates cannot be repaired automatically. | Do not use the figures; send the file to Peter. |
| **EXPORT/INJECTION CHANNEL … GENERATION** | Solar/export data — electricity flowing **out**, not consumption. | Never use as usage. Kept separate on purpose. |
| **ICP-register present in N files — records combined** | The same ICP-register came from several files and was merged. Fine when intended (split files); doubles the numbers when it's a duplicate. | Check the file list; remove duplicates and re-analyse. |
| **Day/Night split uses DEFAULT time windows** | This network isn't in the Time Boundaries tab yet, so a generic 7am–9pm split was used. | Day/Night shares are approximate. Add the network's real windows to Time Boundaries (ask Peter/Yuka). |
| **Multiplier ≠ 1 … not applied** | The file carries a meter multiplier the app deliberately does not apply. | Verify the usage against a bill once per retailer; tell Peter the outcome. |
| **Near-zero AVM** | The maths worked; the site just uses almost nothing (vacant?). | Informational — mention in the proposal notes if relevant. |
| **N gap(s) detected** | Missing stretches inside the data window; coverage (and the grade) already account for them. | Only worth chasing if the grade dropped below 🔋. |

## When something looks wrong

- **File shows UNKNOWN** → new retailer format. Send the file to Peter as
  received. (Batch tab: the 🔍 button gives a diagnostic card with a
  **📋 Copy to clipboard** button — paste that to Peter and it is usually
  enough to build the fix.)
- **Numbers look off** → check the Flags column first; the explanation is
  usually there (duplicate file combined, estimates, date repair, gaps).
- **Date-repair flags** ("resolved as month-first…") → the app corrected a file
  that was mangled upstream. If in doubt, verify one date against the source
  email/bill. Also: somebody opened that file in Excel before it reached the
  app — worth finding out who, so the next file arrives clean.
- **App looks stale after a fix** → hard-refresh (Ctrl+Shift+R), then check the
  build stamp changed.
