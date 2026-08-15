# CDP App — B1 setup

Files: `appsscript.json`, `Config.gs`, `Main.gs`, `Detect.gs`, `ParserEiepRows.gs`, `Verify.gs`, `Index.html`

## One-time setup (per environment, DEV first)

1. **Drive folders** — create `CDP Upload`, `CDP Processed`, `CDP Output`; note the three folder IDs.
2. **Backing spreadsheet** — create a new spreadsheet (suggested name: `CDP App Data (DEV)` / `(LIVE)`), add a tab named `Config` with two columns (key | value) and these rows:
   - `upload_folder_id`, `processed_folder_id`, `output_folder_id`
   - `ea_icp_sheet_id` = `1IVRUmU-AbRwZXog3jG-uSiXbOcbTA2lWpvKZi0MdQEM`
   - `betty_customers_sheet_id` = `1JzNB-zxEM2DGhY46QmvhkSp00qlv9CrN1_YUp5Z_ycQ`
   - `gas_icp_sheet_id` = (Gas ICP lookup sheet ID — optional in B1; lookups fall back to a flag if absent)
   - `betty_url_pattern` = same pattern as the DC App, with `{customerId}` placeholder
   - thresholds (optional, defaults apply): `min_window_days` 90, `max_estimate_share` 0.5, `near_zero_avm_kwh` 10
   Add empty `Run Log` and `Flags Log` tabs (used from B2).
3. **Apps Script projects** — create `CDP-DEV` and `CDP-LIVE`, record script IDs in PROJECTS.md, wire `.clasp.json` per branch as usual.
4. **Script property** — in each project: `BACKING_SHEET_ID` = that environment's backing spreadsheet ID.
5. **Deploy** DEV as web app (execute as you, domain access), push via clasp, open the URL.
6. **Git** — new repo `cdp-app`, these files at root, commit as B1 skeleton.

## Betty round-trip spike (B1 checkpoint, manual)

1. Take an untouched Betty template xlsx → upload to Drive → open as Google Sheet → File → Download → xlsx.
2. Import that file into Betty (a throwaway/known customer).
3. Record the outcome in the design record §11.1. The B2 writer is built only after this passes.

## Testing B1

Drop the known sample files (Meridian ICPCONS ×2 incl. the Excel-mangled one, Contact ICPSUMM, Contact ICPCONS monthly) into `CDP Upload`, open the app, Parse & verify each. Expected: correct format detection; mangled-date file shows the day-first resolution flag; multi-layer Meridian files show the layer cross-check flag; gas/unknown ICPs show lookup flags rather than errors.

## Known B1 limitations (by design)

- Read-only: no normalisation output, no AVM, no template writing (B2).
- xlsx/Sheets-shaped inputs report as UNKNOWN (Families B/C/D land in B3/B4).
- ICPSUMM column mapping is DES-driven with tolerant name matching — verify against the real Contact sample on first DEV run and tighten the keyword list if any required column is missed.
- Fuel detection is lookup-driven only (EA hit = ELEC, Gas sheet hit = GAS).
- TUC owl logo: paste the base64 `<img>` block from an existing app into `Index.html` header (marked TODO).
