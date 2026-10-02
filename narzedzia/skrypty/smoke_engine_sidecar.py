from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SIDECAR_EXE = ROOT / "wydania" / "komputerowa" / "investment-tax-engine" / "investment-tax-engine.exe"
STORAGE_DIR = ROOT / "dane" / "pliki"


def write_request(run_dir: Path, contract_version: str = "investanalyzer.analysis-request.v1", year: int = 2025) -> Path:
    request = {
        "contract_version": contract_version,
        "run_id": run_dir.name,
        "year": year,
        "run_mode": "SAFE",
        "tax_plan": "aggressive_user",
        "package_scope": "",
        "filing_mode": "ORIGINAL",
        "source_selection_mode": "canonical_stream",
        "selected_candidate_source_id": None,
        "storage_dir": str(STORAGE_DIR),
        "out_dir": str(run_dir),
        "nbp_dir": str(STORAGE_DIR),
        "overrides": {
            "transaction_overrides_path": None,
            "defense_evidence_overrides_path": None,
            "broker_file_action_overrides_path": None,
        },
        "flags": {
            # Bramka czyta dane/pliki tylko do odczytu - bez kopii wynikow w dane/out.
            "bez_kopii_out": True,
            "include_diagnostics": True,
            "strict_mode": True,
            "include_fx_conversion_costs": True,
            "include_bank_funding_fees": True,
            "include_interest_costs": True,
            "include_account_fees": True,
        },
        "funding_fees": [],
    }
    path = run_dir / "request.json"
    path.write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def run_sidecar(request_path: Path, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(SIDECAR_EXE), "--request", str(request_path)],
        cwd=request_path.parent,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )


def main() -> int:
    if not SIDECAR_EXE.exists():
        print(f"Sidecar not found: {SIDECAR_EXE}. Run npm run desktop:engine:build first.", file=sys.stderr)
        return 1

    temp_root = Path(tempfile.mkdtemp(prefix="invest-analyzer-sidecar-smoke-"))
    try:
        bad_run = temp_root / "contract-mismatch"
        bad_run.mkdir()
        bad_request = write_request(bad_run, contract_version="0.0")
        bad_result = run_sidecar(bad_request, timeout=60)
        if bad_result.returncode == 0 or not (bad_run / "error.json").exists():
            print("Sidecar did not produce controlled error.json for contract mismatch.", file=sys.stderr)
            print(bad_result.stdout)
            print(bad_result.stderr, file=sys.stderr)
            return 1
        bad_error = json.loads((bad_run / "error.json").read_text(encoding="utf-8"))
        if bad_error.get("error_code") != "ENGINE_CONTRACT_MISMATCH":
            print(f"Unexpected mismatch error: {bad_error}", file=sys.stderr)
            return 1

        good_run = temp_root / "valid-run"
        good_run.mkdir()
        good_request = write_request(good_run)
        good_result = run_sidecar(good_request)
        if good_result.returncode != 0 or not (good_run / "result.json").exists():
            print("Sidecar did not produce result.json for a valid request.", file=sys.stderr)
            print(good_result.stdout)
            print(good_result.stderr, file=sys.stderr)
            if (good_run / "error.json").exists():
                print((good_run / "error.json").read_text(encoding="utf-8"), file=sys.stderr)
            return 1
        payload = json.loads((good_run / "result.json").read_text(encoding="utf-8"))
        required = [
            "annual_summary", "transaction_history_rows", "audit_hash", "scenario_results",
            "filing_ready", "quality_report", "fifo_rows", "canonical_tax_input_consumption_runtime",
        ]
        missing = [key for key in required if key not in payload]
        summary = payload.get("annual_summary") or {}
        missing += [f"annual_summary.{key}" for key in ("pit38_form_fields", "pit_zg_rows") if key not in summary]
        if missing:
            print(f"Sidecar result is missing keys: {missing}", file=sys.stderr)
            return 1
        print("Sidecar smoke passed.")
        return 0
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
