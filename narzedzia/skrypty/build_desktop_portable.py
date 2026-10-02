from __future__ import annotations

import shutil
import sys
import zipfile
import json
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RELEASE_DIR = ROOT / "aplikacje" / "komputerowa" / "tauri" / "target" / "release"
APP_EXE = RELEASE_DIR / "invest-analyzer-desktop.exe"
SIDECAR_DIR = ROOT / "aplikacje" / "komputerowa" / "tauri" / "binaries" / "investment-tax-engine"
TAURI_CONFIG = ROOT / "aplikacje" / "komputerowa" / "tauri" / "tauri.conf.json"
PORTABLE_ROOT = ROOT / "wydania" / "komputerowa" / "przenosna"
RELEASES_DIR = PORTABLE_ROOT / "wersje"
LATEST_DIR = PORTABLE_ROOT / "najnowsza"
LATEST_BUILD = PORTABLE_ROOT / "NAJNOWSZA_WERSJA.txt"
APP_EXE_NAME = "InvestAnalyzer.exe"


def read_desktop_version() -> str:
    try:
        payload = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
        version = str(payload.get("version") or "").strip()
        return version or "0.0.0"
    except (OSError, json.JSONDecodeError):
        return "0.0.0"


def build_readme(app_version: str, release_version: str, timestamp: str) -> str:
    return f"""# InvestAnalyzer Portable

This is a local test build of InvestAnalyzer Desktop.

- App version: v{app_version}
- Release version: {release_version}
- Date: {timestamp}
- Run `InvestAnalyzer.exe`.
- Tax data stays local.
- The Python tax engine is bundled in `binaries/investment-tax-engine`.
- Do not run files from `binaries/` manually. They are internal engine files.
- No Node.js, npm or system Python is required for this portable build.
- For production distribution use the signed installer once code signing is configured.
"""


def copytree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def main() -> int:
    if not APP_EXE.exists():
        print(f"Desktop exe not found: {APP_EXE}. Run npm run desktop:build first.", file=sys.stderr)
        return 1
    if not SIDECAR_DIR.exists() or not (SIDECAR_DIR / "investment-tax-engine.exe").exists():
        print(f"Sidecar folder not found: {SIDECAR_DIR}. Run npm run desktop:engine:build first.", file=sys.stderr)
        return 1

    app_version = read_desktop_version()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M")
    release_version = f"v{app_version}-{timestamp}"
    release_name = f"InvestAnalyzer-Komputerowa-{release_version}"
    PORTABLE_APP_DIR = RELEASES_DIR / release_name
    PORTABLE_ZIP = RELEASES_DIR / f"{release_name}.zip"

    RELEASES_DIR.mkdir(parents=True, exist_ok=True)
    if PORTABLE_APP_DIR.exists():
        shutil.rmtree(PORTABLE_APP_DIR)
    PORTABLE_APP_DIR.mkdir(parents=True, exist_ok=True)

    shutil.copy2(APP_EXE, PORTABLE_APP_DIR / APP_EXE_NAME)
    copytree(SIDECAR_DIR, PORTABLE_APP_DIR / "binaries" / "investment-tax-engine")
    (PORTABLE_APP_DIR / "README_FIRST_RUN.md").write_text(
        build_readme(app_version, release_version, timestamp),
        encoding="utf-8",
    )

    if PORTABLE_ZIP.exists():
        PORTABLE_ZIP.unlink()
    with zipfile.ZipFile(PORTABLE_ZIP, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in PORTABLE_APP_DIR.rglob("*"):
            archive.write(path, path.relative_to(RELEASES_DIR))

    if LATEST_DIR.exists():
        shutil.rmtree(LATEST_DIR)
    shutil.copytree(PORTABLE_APP_DIR, LATEST_DIR)

    LATEST_BUILD.write_text(
        "\n".join(
            [
                f"name={release_name}",
                f"appVersion={app_version}",
                f"releaseVersion={release_version}",
                f"timestamp={timestamp}",
                f"folder={PORTABLE_APP_DIR}",
                f"zip={PORTABLE_ZIP}",
                f"exe={PORTABLE_APP_DIR / APP_EXE_NAME}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"Portable folder: {PORTABLE_APP_DIR}")
    print(f"Portable zip: {PORTABLE_ZIP}")
    print(f"Latest pointer: {LATEST_BUILD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
