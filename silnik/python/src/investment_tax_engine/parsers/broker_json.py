from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..interfaces.parsers import Parser


class BrokerJsonParser(Parser):
    source_name = "BROKER_JSON"

    def parse(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        dane = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(dane, list):
            return dane
        if isinstance(dane, dict):
            rows: list[dict[str, Any]] = []
            for value in dane.values():
                if isinstance(value, list):
                    rows.extend(value)
                elif isinstance(value, dict) and any(isinstance(inner, list) for inner in value.values()):
                    for inner_value in value.values():
                        if isinstance(inner_value, list):
                            rows.extend(inner_value)
            return rows or [dane]
        return []
