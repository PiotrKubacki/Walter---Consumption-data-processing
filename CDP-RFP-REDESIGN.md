# CDP — RFP / Bulk Quote Redesign (design for sign-off, no code yet)

Date: 31 October 2026 · Status: agreed workflow, build pending Peter's sign-off
Replaces: the single-status Bulk Quote queue (v1.9.x) and the sheets' clear-on-export model.

## 1. The model in one paragraph

A queue row is an ICP waiting for pricing. **"Sent" is never a row status** — it is a
recorded fact per (row × retailer), kept in an immutable send log. Rows live until the
operator closes them; the app pre-selects what looks finished but a human always
confirms. Retailers, their file layouts and their email wording are **data, not code**,
so adding retailer #4 is editing config — eventually through an admin screen in the app.

## 2. Entities (backing-sheet tabs)

**RFP Queue** (evolves the current Bulk Quote Queue)
`id · date added · status (OPEN / CLOSED / REMOVED) · urgent (Y/–) · extension (Y/–) ·
customer id · registered name · trading name · icp · icp type · est annual kwh ·
consumption file · closed date`
No per-retailer columns — coverage is derived from the send log. Annual stays
operator-editable while OPEN.

**RFP Retailers** (registry; tab now, admin screen in a later version)
`code · display name · fuels accepted (ELEC / GAS / BOTH) · mode (BULK / PER-CUSTOMER) ·
email to · email cc · subject template · body template · active (Y/N) · notes`
Templates use placeholders: `{retailer} {count} {date} {pathway}`.
Seed: NOVA (BOTH, BULK), LODESTONE (ELEC, BULK), MERIDIAN (ELEC, BULK — schema pending
sample), CONTACT (BOTH, PER-CUSTOMER — placeholder, see §5.4).

**RFP Schemas** (file layout as data — the extensibility decision)
`retailer · column order · header text · source field`
Source-field vocabulary the app knows how to derive:
`customer_id · registered_name · trading_name · icp · icp_type · annual_kwh ·
current_retailer · physical_address · poc · constant:<text> · blank`
(covers the NOVA and LODESTONE samples completely; `current_retailer / physical_address
/ poc` resolve live from the EA ICPs sheet at build time). A retailer needing logic the
vocabulary can't express gets a code escape hatch, parser-registry style — expected to
be rare.

**RFP Send Log** (immutable)
`batch id · timestamp · operator · retailer · pathway (STANDARD / URGENT / EXTENSION /
PER-CUSTOMER) · file link · emailed to · row ids`
Powers coverage chips, duplicate warnings, and "what did we send whom". Never edited,
never cleared.

## 3. Screen layout

One **💰 RFP** tab (replaces Bulk Quote), three collapsible sections + history:

1. **Standard bulk** (open by default) — the OPEN, non-urgent queue.
2. **Urgent** — OPEN rows flagged urgent.
3. **Extensions** — OPEN rows flagged extension, **grouped by incumbent** (current
   retailer from the EA lookup): each incumbent gets its own file and email. This is
   the structural difference from quote broadcasts (same rows → many retailers vs each
   row → its one incumbent), and it covers incumbents the legacy sheet handled by hand.
4. **Send history** — batches, newest first, with file links.

Every section's row table shows **coverage chips** per active retailer:
`NOVA ✓ 28/10 · LODE ✓ 28/10 · MERX —`.

## 4. The send flow (identical in every section)

1. Tick rows (all pre-ticked that are eligible; tick-all / untick-all).
2. Pick retailer (standard/urgent) — extensions pick themselves by incumbent.
3. **Build** → CSV per the retailer's schema, gas rows auto-dropped for ELEC-only
   retailers (counted, shown) → editable email draft (To/Subject/Body from the
   registry templates).
4. **Duplicate warning**: any ticked ICP already in the send log for that retailer is
   flagged loudly — operator may proceed (re-quote) or untick. Never silently blocked,
   never silently re-sent.
5. **Send** → email with CSV attached → send-log batch written → coverage chips update.
   Nothing is recorded at build time; only sending creates history.

**Email routing**: registry holds the real retailer addresses from day one, but a
single Config key `rfp_test_redirect` (seeded with Peter's address) overrides ALL
recipients while set. Blank it when the app has earned trust — no editing retailer
rows back and forth.

## 5. Row lifecycle

1. Rows arrive from the Workbench (Finish customer / Send to Bulk Quote, flags carried)
   or manual entry. Status OPEN.
2. Rows accumulate send-log entries. No automatic status change — a row sent to three
   retailers is still OPEN.
3. **Closing is assisted, never automatic**: a "Close rows" control pre-ticks rows the
   app considers covered (sent to every active BULK retailer accepting their fuel);
   operator unticks/ticks freely — including closing a row sent nowhere (decided not
   to quote) — then clicks Close. CLOSED rows leave the working sections, stay in
   history, reopenable. REMOVED stays for mistakes.
4. No calendar logic anywhere. There is no "Friday"; there are only OPEN rows and
   operator decisions.

### 5.4 Per-customer RFP (placeholder)

Some retailers (Contact) quote per customer only and need an LOA attached — which is
hard to extract from Betty today. V1 ships a visible but disabled pathway: a
"Per-customer RFP" button in the Workbench and the CONTACT registry row marked
PER-CUSTOMER, each explaining what's missing. Wiring it up (LOA attachment, per-customer
email) is its own later phase, possibly leaning on the LOA Updater's output.

## 6. Migration

- Existing queue rows: QUEUED → OPEN; EXPORTED → CLOSED (closed date = batch date);
  REMOVED unchanged. Old extension-meridian/nova columns collapse into the single
  extension flag; current statuses have no send-log history, which is accepted.
- Existing exports in CDP Output are unaffected.
- Workbench queueing API changes only in column mapping.

## 7. Build phases (proposed)

- **R1**: tabs + seeds (Retailers, Schemas, Send Log), queue migration, Standard bulk
  section rebuilt on the new model (coverage chips, duplicate warning, build→draft→send,
  assisted close). NOVA + LODESTONE schemas as data.
- **R2**: Urgent and Extensions sections (extension = per-incumbent grouping + its own
  templates), send history view.
- **R3**: Meridian schema (needs the sample file — still owed), retailer admin screen
  (add/edit retailers + schemas in-app), per-customer RFP de-placeholdered.

## 8. Open items

1. Meridian sample file — blocks its schema row, nothing else.
2. Extension email wording per incumbent (template text from Peter/Yuka).
3. Real retailer email addresses for the registry (can land any time; redirect protects).
