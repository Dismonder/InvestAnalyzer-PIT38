# Python Sidecar Contract

Schematy kontraktu:

- zadanie (`request.json`): `investanalyzer.analysis-request.v1`
- odpowiedz (`result.json`, `error.json`): `investanalyzer.analysis-result.v1`

Zadanie i odpowiedz maja rozne nazwy schematow, wiec pomylenie ich jest
wykrywane jako `ENGINE_CONTRACT_MISMATCH`, a nie przechodzi po cichu.

Rust writes:

```text
%LOCALAPPDATA%\InvestAnalyzer\runs\<run_id>\request.json
```

Opcjonalne dane PIT-8C: frontend wysyla `pit8cEntries` (lista par
`revenuePln`/`costsPln` w PLN z groszami, tylko dla `year`). Rust zapisuje
liste w `overrides/pit8c_entries.json` i przekazuje sciezke jako
`request.overrides.pit8c_path`. Puste pole jest dozwolone w schemacie
`investanalyzer.analysis-request.v1`. Silnik czyta je tak samo jak flage CLI
`--pit8c-json-path` w wersji webowej. Ręczne `transactionOverrides[].values`
mogą mieć znacznik `wystawia_pit8c: "true"` dla sprzedaży z rachunku
wystawiającego PIT-8C; brak znacznika oznacza pozostałe transakcje.
Przy takim wejściu silnik zwraca pozycje formularza w
`result.tax_filing_package.draft.form_fields` oraz kwoty porównawcze
`result.art30b.pit8c_calculated_revenue_pln`,
`pit8c_calculated_cost_pln`, `pit8c_revenue_difference_pln` i
`pit8c_cost_difference_pln`. Bez PIT-8C i oznaczonych rachunków schemat
odpowiedzi pozostaje jak dotąd.

Then it starts:

```text
investment-tax-engine.exe --request <request.json>
```

Success writes:

```text
result.json
```

Failure writes:

```text
error.json
```

Rust rejects `result.json` and `error.json` when `contract_version` is missing or different from `investanalyzer.analysis-result.v1`. The engine rejects `request.json` whose `contract_version` differs from `investanalyzer.analysis-request.v1`.

Every controlled error contains:

- `contract_version`
- `status`
- `run_id`
- `error_code`
- `message`
- `details`
- `recoverable`

Initial controlled errors:

- `ENGINE_INVALID_JSON`
- `ENGINE_CONTRACT_MISMATCH`
- `ENGINE_NOT_FOUND`
- `ENGINE_TIMEOUT`
- `ENGINE_CRASHED`
- `PATH_TRAVERSAL_BLOCKED`
- `UNSUPPORTED_FILE_TYPE`

Packaging rule:

PyInstaller uses `onedir`. Bundle the whole generated folder, not only `investment-tax-engine.exe`.

Expected portable layout:

```text
InvestAnalyzer-Komputerowa-v0.1.0-YYYYMMDD-HHMM/
  InvestAnalyzer.exe
  binaries/
    investment-tax-engine/
      investment-tax-engine.exe
      _internal/
      ...
```

In dev mode Rust may resolve the sidecar from the repository build output. In production and portable builds it must resolve the executable from bundled app resources or the portable `binaries` folder, not from repository-relative paths.

Run manifest rule:

`run_manifest.json` is written before and after each run. Finalization preserves the input file list from the pre-run manifest and adds runtime result metadata such as `engine_version`, `audit_hash` and final status.

`engine_version` is emitted by the engine at the top level of `result.json`
(source of truth: `investment_tax_engine.__version__`). Before that field
existed the Rust side read a key the engine never wrote, so
`run_manifest.json.engineVersion` was always `null`.

Odpowiedź zachowuje `transaction_dossiers` oraz
`canonical_storage_history_rows` na poziomie głównym. Gdy te same listy są
identyczne z `canonical_tax_input.transaction_dossiers` i
`canonical_tax_input.canonical_history_rows`, kopie zagnieżdżone są pomijane w
`result.json`. Plik `canonical_tax_input.json` i pełne artefakty audytu nadal
zawierają komplet danych.
