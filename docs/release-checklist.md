# Desktop Release Checklist

- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run test:python`
- [ ] `npm run build`
- [ ] `npm run smoke:storage`
- [ ] `npm run desktop:rust:test`
- [ ] `npm run desktop:engine:build`
- [ ] `npm run desktop:engine:smoke`
- [ ] `npm run desktop:parity`
- [ ] `npm run desktop:build`
- [ ] `npm run desktop:portable`
- [ ] `npm run desktop:portable:smoke`
- [ ] `npm run desktop:release:verify`

Desktop acceptance:

- [ ] App starts as a normal Windows program.
- [ ] App does not require Node.
- [ ] App does not require system Python.
- [ ] App does not start Express in production.
- [ ] App does not open a production HTTP port.
- [ ] Storage works in `%APPDATA%\InvestAnalyzer\storage`.
- [ ] Broker files are copied, not moved.
- [ ] Legacy storage migration writes `%APPDATA%\InvestAnalyzer\migration_manifest.json`.
- [ ] Portable folder contains `InvestAnalyzer.exe`.
- [ ] Portable folder contains `binaries\investment-tax-engine\investment-tax-engine.exe` and PyInstaller dependencies.
- [ ] Path traversal is blocked.
- [ ] Unsafe extensions are blocked.
- [ ] 2025 and 2026 parity match the Express/Python baseline.
- [ ] Any `audit_hash` difference is explained as runtime metadata only, not tax math.

Settlement correctness:

- [ ] An asset bought in year N-1 and sold in year N has a real cost basis, not zero.
      (The canonical input keeps every record up to the selected year, not only that year.)
- [ ] A prior year that ended with income carries no loss forward.
      (A loss is the year's net result, not the sum of losing positions.)
- [ ] Foreign withholding tax reaches `art30a.foreign_withholding_tax_pln` and links to its dividend
      in both directions (`withholding_tax_event_ids` and `matched_dividend_event_id`).
- [ ] Every tax amount on the form is rounded once; the total equals the sum of the rounded lines.
- [ ] The category coverage gate blocks a run where a whole input category leaves no artifact.
      (Verify by temporarily returning an empty `support_records` from the canonical adapter.)
- [ ] Records held for the user's decision are reported (`RECORDS_AWAITING_USER_DECISION`),
      never dropped in silence.
- [ ] No source file hits the per-source row limit; if one does, the run says so.

Data handling:

- [ ] `npm run assert:no-private-data` passes, and no engine output directory is tracked by git.
- [ ] Files in Windows-1250 (NBP rate archives) read without replacement characters in both runtimes.
- [ ] A backup of user decisions can be written, listed and restored; a portable copy round-trips.
- [ ] The year picker offers every tax year present in the data, not only the current one.

Release policy:

- Portable build is the first practical release channel.
- Signed NSIS installer is prepared by `desktop:build`, but certificate signing is outside v1.
- Auto-update remains disabled until signed artifacts and rollback policy exist.
