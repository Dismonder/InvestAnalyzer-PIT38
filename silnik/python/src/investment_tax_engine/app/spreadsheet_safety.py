from __future__ import annotations

from pathlib import Path
import zipfile


MAX_SPREADSHEET_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_SPREADSHEET_ENTRY_RATIO = 200
MIN_SPREADSHEET_ENTRY_RATIO_BYTES = 16 * 1024 * 1024


def validate_spreadsheet_zip(
    path: Path, *, max_uncompressed_bytes: int = MAX_SPREADSHEET_UNCOMPRESSED_BYTES
) -> None:
    """Sprawdza archiwum XLSX przed przekazaniem go do pandas."""
    path = Path(path)
    # Decyduje zawartosc, nie rozszerzenie: pandas rozpoznaje XLSX po sygnaturze,
    # wiec ZIP nazwany .xls tez trafia do openpyxl. Stary XLS (OLE) nie jest ZIP-em.
    if not zipfile.is_zipfile(path):
        return
    with zipfile.ZipFile(path) as archive:
        uncompressed_size = 0
        for entry in archive.infolist():
            uncompressed_size += entry.file_size
            if (
                uncompressed_size > max_uncompressed_bytes
                or entry.file_size > MIN_SPREADSHEET_ENTRY_RATIO_BYTES
                and entry.file_size > MAX_SPREADSHEET_ENTRY_RATIO * entry.compress_size
            ):
                raise ValueError(
                    f"SOURCE_INPUT_TOO_LARGE: {path.name}: archiwum XLSX przekracza limit rozmiaru po rozpakowaniu lub współczynnika kompresji."
                )
