from __future__ import annotations

import shutil
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PYTHON_PROJECT = ROOT / "silnik" / "python"
ENTRYPOINT = PYTHON_PROJECT / "src" / "investment_tax_engine" / "app" / "cli.py"
DIST_DIR = ROOT / "wydania" / "komputerowa"
SIDECAR_DIR = DIST_DIR / "investment-tax-engine"
TAURI_SIDECAR_RESOURCE_DIR = ROOT / "aplikacje" / "komputerowa" / "tauri" / "binaries" / "investment-tax-engine"
BUILD_DIR = ROOT / "dane" / "tymczasowe" / "pyinstaller-build"
SPEC_DIR = ROOT / "dane" / "tymczasowe" / "pyinstaller-spec"
def _venv_python() -> Path:
    """Interpreter ze srodowiska projektu, w ukladzie wlasciwym dla platformy.

    Pozostale skrypty (run-python-tests.mjs, perf-engine.mjs, smoke-storage.mjs)
    rozgaleziaja sie po platformie; ten robil to samo tylko dla Windows,
    przez co poza Windows srodowisko projektu bylo po cichu pomijane.
    """
    if sys.platform == "win32":
        return PYTHON_PROJECT / ".venv" / "Scripts" / "python.exe"
    return PYTHON_PROJECT / ".venv" / "bin" / "python"


VENV_PYTHON = _venv_python()


def run(command: list[str]) -> None:
    print(" ".join(command))
    env = os.environ.copy()
    src = str(PYTHON_PROJECT / "src")
    current = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = src if not current else f"{src}{os.pathsep}{current}"
    subprocess.run(command, cwd=PYTHON_PROJECT, env=env, check=True)


def main() -> int:
    if VENV_PYTHON.exists() and Path(sys.executable).resolve() != VENV_PYTHON.resolve():
        return subprocess.run([str(VENV_PYTHON), str(Path(__file__).resolve())], cwd=ROOT).returncode

    if not ENTRYPOINT.exists():
        print(f"Missing sidecar entrypoint: {ENTRYPOINT}", file=sys.stderr)
        return 1

    try:
        subprocess.run([sys.executable, "-m", "PyInstaller", "--version"], check=True, stdout=subprocess.PIPE)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("PyInstaller is not installed. Install it in the Python environment before desktop packaging.", file=sys.stderr)
        return 1

    if SIDECAR_DIR.exists():
        shutil.rmtree(SIDECAR_DIR)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    SPEC_DIR.mkdir(parents=True, exist_ok=True)

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--log-level",
        "WARN",
        "--clean",
        "--noconfirm",
        "--onedir",
        "--noconsole",
        "--name",
        "investment-tax-engine",
        "--distpath",
        str(DIST_DIR),
        "--workpath",
        str(BUILD_DIR),
        "--specpath",
        str(SPEC_DIR),
        "--paths",
        str(PYTHON_PROJECT / "src"),
        # pypdf jest importowany dopiero w chwili odczytu taryfy, wiec analiza
        # statyczna PyInstallera go nie widzi. Bez tego wpisu wersja desktopowa
        # milczaco pomijalaby kontrole spojnosci stawek.
        "--hidden-import",
        "pypdf",
        "--exclude-module",
        "pandas.tests",
        "--exclude-module",
        "numpy.tests",
        "--exclude-module",
        "pytest",
        "--exclude-module",
        "matplotlib",
        "--exclude-module",
        "IPython",
        "--exclude-module",
        "jinja2",
        str(ENTRYPOINT),
    ]
    run(command)

    exe = SIDECAR_DIR / "investment-tax-engine.exe"
    if not exe.exists():
        print(f"PyInstaller finished, but sidecar EXE was not found: {exe}", file=sys.stderr)
        return 1
    if TAURI_SIDECAR_RESOURCE_DIR.exists():
        shutil.rmtree(TAURI_SIDECAR_RESOURCE_DIR)
    TAURI_SIDECAR_RESOURCE_DIR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SIDECAR_DIR, TAURI_SIDECAR_RESOURCE_DIR)
    print(f"Built PyInstaller onedir sidecar: {SIDECAR_DIR}")
    print(f"Copied Tauri sidecar resource folder: {TAURI_SIDECAR_RESOURCE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
