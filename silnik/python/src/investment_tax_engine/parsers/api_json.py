from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..interfaces.parsers import Parser


class ApiJsonParser(Parser):
    source_name = "API_JSON_FULL"

    def parse(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []

        dane = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(dane, dict):
            if isinstance(dane.get("trades"), dict) and isinstance(dane["trades"].get("trade"), list):
                return dane["trades"]["trade"]
            if isinstance(dane.get("trade"), list):
                return dane["trade"]
            return [dane]
        if isinstance(dane, list):
            return dane
        return []
