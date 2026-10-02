from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import re
from zipfile import ZipFile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PORTABLE_ROOT = ROOT / "wydania" / "komputerowa" / "przenosna"
PRIVATE_PATTERNS_FILE = ROOT / "narzedzia" / "prywatne_wzorce.json"


def load_private_patterns() -> list[str]:
    """Wzorce nazw zdradzajacych wlasciciela, wspolne z bramka danych osobowych."""
    payload = json.loads(PRIVATE_PATTERNS_FILE.read_text(encoding="utf-8"))
    patterns = [str(entry).strip().lower() for entry in payload.get("wzorce", []) if str(entry).strip()]
    if not patterns:
        raise SystemExit(f"Pusta lista wzorcow w {PRIVATE_PATTERNS_FILE}.")
    return patterns
RELEASES_DIR = PORTABLE_ROOT / "wersje"
LATEST_BUILD = PORTABLE_ROOT / "NAJNOWSZA_WERSJA.txt"
APP_EXE_NAME = "InvestAnalyzer.exe"
STORAGE_DIR = ROOT / "dane" / "pliki"
RELEASE_NAME_RE = re.compile(r"^InvestAnalyzer-Komputerowa-v\d+\.\d+\.\d+-\d{8}-\d{4}$")


def read_latest_metadata() -> dict[str, str]:
    if not LATEST_BUILD.exists():
        return {}
    metadata: dict[str, str] = {}
    for line in LATEST_BUILD.read_text(encoding="utf-8").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        metadata[key.strip()] = value.strip()
    return metadata


def resolve_portable_app_dir() -> tuple[Path, Path, str]:
    metadata = read_latest_metadata()
    folder = Path(metadata["folder"]) if metadata.get("folder") else None
    zip_path = Path(metadata["zip"]) if metadata.get("zip") else None
    name = metadata.get("name") or ""

    if folder and zip_path and name:
        return folder, zip_path, name

    candidates = sorted(
        [
            path
            for path in RELEASES_DIR.glob("InvestAnalyzer-Komputerowa-v*-????????-????")
            if path.is_dir()
        ],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        return RELEASES_DIR / "missing", RELEASES_DIR / "missing.zip", ""
    folder = candidates[0]
    return folder, folder.with_suffix(".zip"), folder.name


def write_request(run_dir: Path) -> Path:
    payload = {
        "contract_version": "investanalyzer.analysis-request.v1",
        "run_id": run_dir.name,
        "year": 2025,
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
    request_path = run_dir / "request.json"
    request_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return request_path


def main() -> int:
    portable_app_dir, portable_zip, release_name = resolve_portable_app_dir()
    app_exe = portable_app_dir / APP_EXE_NAME
    sidecar_exe = portable_app_dir / "binaries" / "investment-tax-engine" / "investment-tax-engine.exe"
    readme = portable_app_dir / "README_FIRST_RUN.md"

    missing = [path for path in [portable_app_dir, app_exe, sidecar_exe, portable_zip, readme] if not path.exists()]
    if missing:
        print("Portable smoke failed, missing paths:", file=sys.stderr)
        for path in missing:
            print(f"  {path}", file=sys.stderr)
        return 1
    if not RELEASE_NAME_RE.match(release_name):
        print(f"Portable release name has unexpected format: {release_name}", file=sys.stderr)
        return 1
    if portable_zip.stem != release_name:
        print(f"Portable ZIP name does not match folder: {portable_zip.name} vs {release_name}", file=sys.stderr)
        return 1
    with ZipFile(portable_zip, "r") as archive:
        names = set(archive.namelist())
        expected = {
            f"{release_name}/{APP_EXE_NAME}",
            f"{release_name}/README_FIRST_RUN.md",
            f"{release_name}/binaries/investment-tax-engine/investment-tax-engine.exe",
        }
        missing_zip_entries = sorted(expected - names)
        if missing_zip_entries:
            print("Portable ZIP missing expected entries:", file=sys.stderr)
            for entry in missing_zip_entries:
                print(f"  {entry}", file=sys.stderr)
            return 1
        # Jedno zrodlo wzorcow razem z bramka danych osobowych. Dwie kopie tej
        # listy zdazyly sie rozjechac: paczka przenosna przechodzila kontrole,
        # ktorej repozytorium by nie przeszlo.
        private_patterns = load_private_patterns()
        leaked_entries = [
            name for name in names
            if any(pattern in name.lower() for pattern in private_patterns)
            and "/binaries/investment-tax-engine/" not in name.lower()
        ]
        if leaked_entries:
            print("Portable ZIP contains private/default data entries:", file=sys.stderr)
            for entry in sorted(leaked_entries)[:20]:
                print(f"  {entry}", file=sys.stderr)
            return 1

    temp_root = Path(tempfile.mkdtemp(prefix="invest-analyzer-portable-smoke-"))
    try:
        run_dir = temp_root / "run"
        run_dir.mkdir()
        request_path = write_request(run_dir)
        result = subprocess.run(
            [str(sidecar_exe), "--request", str(request_path)],
            cwd=portable_app_dir,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
        )
        if result.returncode != 0 or not (run_dir / "result.json").exists():
            print("Portable sidecar did not produce result.json.", file=sys.stderr)
            print(result.stdout)
            print(result.stderr, file=sys.stderr)
            if (run_dir / "error.json").exists():
                print((run_dir / "error.json").read_text(encoding="utf-8"), file=sys.stderr)
            return 1
        payload = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
        for key in ["annual_summary", "transaction_history_rows", "audit_hash"]:
            if key not in payload:
                print(f"Portable result missing {key}.", file=sys.stderr)
                return 1
        print("Portable smoke passed.")
        return 0
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
