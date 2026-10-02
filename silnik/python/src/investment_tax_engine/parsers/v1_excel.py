from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd
from ..app.spreadsheet_safety import validate_spreadsheet_zip

from ..interfaces.parsers import Parser


class V1ExcelParser(Parser):
    source_name = "TRADES_V1"

    def parse(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        validate_spreadsheet_zip(path)
        df = pd.read_excel(path)
        return df.to_dict(orient="records")
