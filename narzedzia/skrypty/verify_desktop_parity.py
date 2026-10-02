from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PYTHON_PROJECT = ROOT / "silnik" / "python"
SIDECAR_EXE = ROOT / "wydania" / "komputerowa" / "investment-tax-engine" / "investment-tax-engine.exe"
STORAGE_DIR = ROOT / "dane" / "pliki"
VENV_PYTHON = PYTHON_PROJECT / ".venv" / "Scripts" / "python.exe"
YEARS = (2025, 2026)
COMPARE_KEYS = (
    "annual_summary",
    "transaction_history_rows",
    "audit_hash",
    "scenario_results",
    "filing_ready",
    "fifo_rows",
    "dividends_view",
    "foreign_tax_view",
    "crypto_part_e",
)


def review_queue_projection(result: dict) -> list:
    """Kolejka decyzji bez sciezek przebiegu - to, co decyduje o gotowosci PIT."""
    queue = (result.get("canonical_tax_input_consumption_runtime") or {}).get("reviewQueue") or []
    return [
        tuple(row.get(key) for key in ("decision_key", "kind", "date", "symbol", "isin", "blocks_filing", "decision", "occurrences"))
        for row in queue
        if isinstance(row, dict)
    ]


def blocking_projection(result: dict) -> list:
    """Blokady z kodem, trescia i symbolami (np. PIT/ZG bez panstwa)."""
    issues = (result.get("quality_report") or {}).get("blocking_issues") or []
    return [
        (issue.get("code"), issue.get("scope_id"), issue.get("message"), (issue.get("details") or {}).get("symbols"))
        for issue in issues
        if isinstance(issue, dict)
    ]


PROJECTIONS = {
    "reviewQueue": review_queue_projection,
    "blocking_issues": blocking_projection,
}


def python_env() -> dict[str, str]:
    env = os.environ.copy()
    current = env.get("PYTHONPATH", "")
    src = str(PYTHON_PROJECT / "src")
    env["PYTHONPATH"] = src if not current else f"{src}{os.pathsep}{current}"
    return env


def run_module(year: int, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    request_path = write_sidecar_request(out_dir, year)
    python_exe = VENV_PYTHON if VENV_PYTHON.exists() else Path(sys.executable)
    result = subprocess.run(
        [
            str(python_exe),
            "-m",
            "investment_tax_engine.app.cli",
            "--request",
            str(request_path),
        ],
        cwd=PYTHON_PROJECT,
        env=python_env(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=180,
    )
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"Python baseline run failed for {year}.")
    result_path = out_dir / "result.json"
    if not result_path.exists():
        raise RuntimeError(f"Python baseline did not write result.json for {year}.")
    return json.loads(result_path.read_text(encoding="utf-8"))


def write_sidecar_request(run_dir: Path, year: int) -> Path:
    run_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "contract_version": "investanalyzer.analysis-request.v1",
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
        "overrides": {},
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
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def run_sidecar(year: int, run_dir: Path) -> dict:
    request_path = write_sidecar_request(run_dir, year)
    result = subprocess.run(
        [str(SIDECAR_EXE), "--request", str(request_path)],
        cwd=run_dir,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=180,
    )
    if result.returncode != 0 or not (run_dir / "result.json").exists():
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        if (run_dir / "error.json").exists():
            print((run_dir / "error.json").read_text(encoding="utf-8"), file=sys.stderr)
        raise RuntimeError(f"Sidecar parity run failed for {year}.")
    return json.loads((run_dir / "result.json").read_text(encoding="utf-8"))


def main() -> int:
    if not SIDECAR_EXE.exists():
        print(f"Sidecar not found: {SIDECAR_EXE}. Run npm run desktop:engine:build first.", file=sys.stderr)
        return 1
    temp_root = Path(tempfile.mkdtemp(prefix="invest-analyzer-desktop-parity-"))
    try:
        for year in YEARS:
            baseline = run_module(year, temp_root / f"baseline-{year}")
            sidecar = run_sidecar(year, temp_root / f"sidecar-{year}")
            for key in COMPARE_KEYS:
                if baseline.get(key) != sidecar.get(key):
                    print(f"Desktop parity mismatch for {year}: {key}", file=sys.stderr)
                    return 1
            for name, projection in PROJECTIONS.items():
                if projection(baseline) != projection(sidecar):
                    print(f"Desktop parity mismatch for {year}: {name}", file=sys.stderr)
                    return 1
        print("Desktop parity passed.")
        return 0
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
