# InvestAnalyzer Desktop Runtime

Desktop runtime uses Tauri v2 as a local Windows shell.

Current rules:

- Web/dev uses the existing Express endpoints through `RuntimeApi`.
- Desktop/Tauri uses `invoke` commands through `RuntimeApi`.
- Production desktop must not silently fall back to Express.
- Production data is stored under `%APPDATA%\InvestAnalyzer` and `%LOCALAPPDATA%\InvestAnalyzer`.
- Tax math, FIFO, NBP, scenarios, `annual_summary`, `transaction_history_rows`, `audit_hash` and `auto_safe_switch` are not changed by the desktop runtime.

Important paths:

- `%APPDATA%\InvestAnalyzer\storage`
- `%APPDATA%\InvestAnalyzer\artifacts`
- `%LOCALAPPDATA%\InvestAnalyzer\runs`
- `%LOCALAPPDATA%\InvestAnalyzer\logs`
- `%LOCALAPPDATA%\InvestAnalyzer\cache`
- `%LOCALAPPDATA%\InvestAnalyzer\temp`

The runtime cleans bounded temporary state in `runs`, `logs` and `temp`. It never automatically deletes broker storage files or generated artifacts. The actual limits:

- `logs`: entries older than 30 days are removed; `temp`: older than 7 days.
- `runs` (engine run directories): at most 20 newest runs and at most 2 GB in total are kept; older or excess runs are removed regardless of age (there is no 24 h grace period). The newest entry and the directories of jobs that are still queued or running are never removed. Anything older than 30 days (other than active runs) is removed as well.
- In-memory job registry: the result of a finished tax engine job (`result.json` is about 100 MB on real data) is handed out once by `get_tax_engine_job_result` and released; a second read fails with `ENGINE_RESULT_ALREADY_TAKEN`. Finished job entries are dropped after 60 minutes, and only the 10 most recent finished jobs are kept; running jobs are never dropped.

Ollama: `stop_ollama` stops only the process the app started itself (PID from the managed-process marker, verified against the recorded `ollama.exe` path, together with its `ollama.exe` worker children). An Ollama server started by the user is left running.

Frontend errors: every `invoke` goes through `wywolaj` in `runtimeApi.tauri.ts`, which turns the rejected `DesktopError` object (`errorCode`, `message`, `recoverable`) into an `Error` carrying `errorCode` and `recoverable`.

Market quotes: the built desktop has no Node server. `apiFetch` (`apiTransport.ts`) answers `/api/quote/<ticker>` and `/api/quotes?tickers=A,B` (max 100 tickers, 8 parallel fetches, same `{success, quotes}` shape as the web server) directly from Binance/Yahoo through the Tauri HTTP plugin. Any other `/api/*` route without a desktop equivalent returns `501` with `errorCode: NIEDOSTEPNE_W_DESKTOPIE`.
Diagnostics modes:

- `safe`: no raw broker contents, no full local paths and no filenames.
- `anonymized` (pseudonymized): filenames, relative paths and file content hashes are replaced with HMAC-SHA256 digests keyed with a random per-export salt that is never stored; file sizes and extensions remain for debugging. Error messages have paths, quoted values and statement file names masked.
- `full`: local-only export with paths and filenames for deep troubleshooting.

Portable release:

- `npm run desktop:portable` creates versioned builds (folder + zip) in `wydania/komputerowa/przenosna/wersje` and refreshes `wydania/komputerowa/przenosna/najnowsza`.
- The portable folder contains the desktop executable, bundled Tauri resources and the full PyInstaller `onedir` sidecar folder.
- `npm run desktop:portable:smoke` checks the portable layout and executes the sidecar without requiring system Python.
- Portable is the first verification format. A signed installer is a later release step.

Legacy storage migration:

- Desktop can detect the repository storage folder (`dane\pliki`, the current one; older `dane\storage` and `storage` layouts, also one directory up, and the `INVEST_ANALYZER_LEGACY_STORAGE` override) and copy it into `%APPDATA%\InvestAnalyzer\storage`.
- Hidden files (names starting with a dot, e.g. `.gitkeep`) and files with an extension outside the import allow-list are skipped and recorded in the manifest with status `skipped_unsupported`; they do not abort the migration.- Migration copies files only after user action; it never moves or deletes the original storage.
- Identical files are skipped by SHA256. Conflicting files are copied with a timestamp suffix.
- The migration writes `%APPDATA%\InvestAnalyzer\migration_manifest.json`.
